const fs = require('fs');
const path = require('path');
const https = require('https');
const monitor = require('./monitor');
const nginx = require('./nginx');

const DATA_DIR = path.join(__dirname, '..', 'data');
const IGNORE_FILE = path.join(DATA_DIR, 'uptime-ignore.json');

let cfg = null;
let timer = null;
let running = false;
let ignoreList = []; // 不参与探活的域名（适合故意停用、又没设维护态的站点）
const state = {}; // 域名 → { announced: 'up'|'down'|undefined, fails, ups, downSince }

/* ---------- 探活忽略名单 ---------- */

function load() {
  try {
    const d = JSON.parse(fs.readFileSync(IGNORE_FILE, 'utf8'));
    ignoreList = Array.isArray(d) ? d.filter((x) => typeof x === 'string') : [];
  } catch (e) {
    ignoreList = [];
  }
}

function save() {
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(IGNORE_FILE, JSON.stringify(ignoreList, null, 2));
  } catch (e) { /* ignore */ }
}

function isIgnored(domain) {
  return ignoreList.indexOf(domain) >= 0;
}

function setIgnore(domain, ignored) {
  const i = ignoreList.indexOf(domain);
  if (ignored && i < 0) ignoreList.push(domain);
  else if (!ignored && i >= 0) ignoreList.splice(i, 1);
  save();
  return ignoreList.slice();
}

/* ---------- 探测 ---------- */

// 从服务器直接请求公网域名，这才是「用户能不能打开」的真实路径
// 证书到期由 lib/cert.js 单独负责，这里不校验证书，两条线不重复告警
function probe(domain, timeoutMs) {
  return new Promise((resolve) => {
    const req = https.request({
      host: domain,
      port: 443,
      path: '/',
      method: 'GET',
      timeout: timeoutMs,
      servername: domain,
      rejectUnauthorized: false,
      headers: { 'User-Agent': 'admin-uptime/1.0', Accept: '*/*' }
    }, (res) => {
      res.resume(); // 丢弃响应体，只关心状态码
      res.on('end', () => {
        const code = res.statusCode;
        resolve(code >= 200 && code < 400 ? { ok: true } : { ok: false, reason: 'HTTP ' + code });
      });
    });
    req.on('timeout', () => { req.destroy(); resolve({ ok: false, reason: '超时' }); });
    req.on('error', (e) => resolve({ ok: false, reason: e.message }));
    req.end();
  });
}

// 失败时补一次源站诊断：绕过 Cloudflare 直连本机，用来区分「源站挂了」和「CF/链路问题」
function probeOrigin(domain, timeoutMs) {
  return new Promise((resolve) => {
    const req = https.request({
      host: '127.0.0.1',
      port: 443,
      path: '/',
      method: 'GET',
      timeout: timeoutMs,
      servername: domain,
      rejectUnauthorized: false,
      headers: { Host: domain, 'User-Agent': 'admin-uptime/1.0', Accept: '*/*' }
    }, (res) => {
      res.resume();
      res.on('end', () => resolve(res.statusCode));
    });
    req.on('timeout', () => { req.destroy(); resolve(null); });
    req.on('error', () => resolve(null));
    req.end();
  });
}

function diagnose(origin) {
  if (origin === null) return '源站（服务器本机）也无法访问，问题在本机服务';
  if (origin >= 200 && origin < 400) return '源站正常（HTTP ' + origin + '），问题更可能出在 Cloudflare 或网络链路';
  return '源站返回 HTTP ' + origin + '，服务本身异常';
}

/* ---------- 巡检 ---------- */

async function probeSite(s) {
  const u = cfg.uptime || {};
  const timeoutMs = u.timeoutMs || 10000;
  const failTh = u.failThreshold || 2;
  const upTh = u.upThreshold || 2;
  const domain = s.domain;
  const st = state[domain] || (state[domain] = { announced: undefined, fails: 0, ups: 0, downSince: 0 });

  const r = await probe(domain, timeoutMs);

  if (r.ok) {
    st.fails = 0;
    if (st.announced === 'down') {
      st.ups++;
      if (st.ups >= upTh) {
        const mins = Math.max(1, Math.round((Date.now() - st.downSince) / 60000));
        st.announced = 'up';
        st.ups = 0;
        monitor.pushNotification('info', '站点已恢复：' + domain,
          '站点 ' + domain + ' 已恢复正常访问（中断约 ' + mins + ' 分钟）', { external: true });
      }
    } else {
      st.announced = 'up';
      st.ups = 0;
    }
    return;
  }

  st.ups = 0;
  st.fails++;
  if (st.announced !== 'down' && st.fails >= failTh) {
    st.announced = 'down';
    st.fails = 0;
    st.downSince = Date.now();
    const origin = await probeOrigin(domain, timeoutMs);
    monitor.pushNotification('critical', '站点无法访问：' + domain,
      '站点 ' + domain + ' 探测失败（' + r.reason + '）。诊断：' + diagnose(origin), { external: true });
  }
}

async function check() {
  if (!cfg || running) return;
  running = true;
  try {
    let sites;
    try { sites = nginx.listSites(cfg); } catch (e) { return; }
    for (const s of sites) {
      // 维护态和被列入忽略名单的，都是主动关的，不该当故障告警
      if (s.blocked || isIgnored(s.domain)) continue;
      await probeSite(s);
    }
  } finally {
    running = false;
  }
}

// 按需探一次：给 Ax 助手用。不碰巡检状态机，也就不会影响告警的去重与阈值
async function probeNow(domain) {
  const timeoutMs = (cfg && cfg.uptime && cfg.uptime.timeoutMs) || 10000;
  const r = await probe(domain, timeoutMs);
  if (r.ok) return { domain, ok: true };
  const origin = await probeOrigin(domain, timeoutMs);
  return { domain, ok: false, reason: r.reason, origin: diagnose(origin) };
}

function start(config) {
  cfg = config || null;
  load();
  if (!cfg || !cfg.uptime || !cfg.uptime.enabled) return;
  const intervalMs = cfg.uptime.intervalMs || 300000;
  // 启动后先等 20s，避开面板自身的启动高峰
  setTimeout(() => { check(); }, 20000);
  timer = setInterval(() => { check(); }, intervalMs);
}

module.exports = { start, check, probeNow, isIgnored, setIgnore };
