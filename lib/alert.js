const fs = require('fs');
const path = require('path');
const https = require('https');

const DATA_DIR = path.join(__dirname, '..', 'data');
const USAGE_FILE = path.join(DATA_DIR, 'alert-usage.json');

let cfg = null;

function start(config) { cfg = config || null; }

function channelCfg(key) {
  return (cfg && cfg.alert && cfg.alert[key]) || null;
}

/* ---------- 每日配额（只约束有额度的通道，目前是 Server酱） ---------- */

// 免费版每天只有几条额度，用完了连真故障都推不出去，所以要护栏
function today() {
  return new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10); // 北京时间
}

function loadUsage() {
  try {
    const d = JSON.parse(fs.readFileSync(USAGE_FILE, 'utf8'));
    if (d && d.date === today()) return d.count || 0;
  } catch (e) { /* ignore */ }
  return 0;
}

function bumpUsage(count) {
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(USAGE_FILE, JSON.stringify({ date: today(), count }));
  } catch (e) { /* ignore */ }
}

/* ---------- 通用 POST ---------- */

function post(url, body, headers) {
  return new Promise((resolve) => {
    let u;
    try { u = new URL(url); } catch (e) { return resolve({ status: 0, text: '', error: '推送地址无效' }); }

    const buf = Buffer.from(body == null ? '' : body, 'utf8');
    const req = https.request({
      hostname: u.hostname,
      port: u.port || 443,
      path: u.pathname + u.search,
      method: 'POST',
      timeout: 10000,
      headers: Object.assign({ 'Content-Length': buf.length }, headers)
    }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { text += c; });
      res.on('end', () => resolve({ status: res.statusCode, text }));
    });
    req.on('timeout', () => { req.destroy(); resolve({ status: 0, text: '', error: '请求超时' }); });
    req.on('error', (e) => resolve({ status: 0, text: '', error: e.message }));
    req.write(buf);
    req.end();
  });
}

/* ---------- 通道一：Server酱（微信） ---------- */

// SC3 的 SendKey 形如 sctp<uid>t...，走 uid 专属子域；旧版 Turbo 走 sctapi.ftqq.com
function endpointOf(sc) {
  if (sc.endpoint) return sc.endpoint;
  const m = /^sctp(\d+)t/i.exec(sc.sendKey || '');
  if (m) return 'https://' + m[1] + '.push.ft07.com/send/' + sc.sendKey + '.send';
  return 'https://sctapi.ftqq.com/' + sc.sendKey + '.send';
}

async function sendServerChan(title, desp) {
  const sc = channelCfg('serverchan');
  if (!sc || !sc.sendKey) return { ok: false, message: '未配置 SendKey' };

  const limit = sc.dailyLimit || 5;
  const used = loadUsage();
  if (used >= limit) return { ok: false, message: '今日外发已达上限 ' + limit + ' 条' };

  const body = new URLSearchParams({ title: title, desp: desp }).toString();
  const r = await post(endpointOf(sc), body, { 'Content-Type': 'application/x-www-form-urlencoded' });

  let d = {};
  try { d = JSON.parse(r.text); } catch (e) { /* ignore */ }
  if (d.code === 0) { bumpUsage(used + 1); return { ok: true, message: '已推送' }; }
  return { ok: false, message: d.message || d.info || r.error || ('HTTP ' + r.status) };
}

/* ---------- 通道二：ntfy ---------- */

// ntfy 的 HTTP 头只能是 ASCII，中文标题必须按 RFC 2047 编码，否则 Node 直接抛 ERR_INVALID_CHAR
function headerValue(v) {
  const s = String(v == null ? '' : v);
  if (/^[\x20-\x7e]*$/.test(s)) return s;
  return '=?UTF-8?B?' + Buffer.from(s, 'utf8').toString('base64') + '?=';
}

// 告警等级 → ntfy 优先级(1~5) + 标签图标
const NTFY_LEVEL = {
  critical: { priority: 5, tags: 'rotating_light' },
  warning: { priority: 4, tags: 'warning' },
  info: { priority: 3, tags: 'information_source' }
};

async function sendNtfy(title, desp, level) {
  const n = channelCfg('ntfy');
  if (!n || !n.topic) return { ok: false, message: '未配置频道 topic' };

  const base = String(n.endpoint || 'https://ntfy.sh').replace(/\/+$/, '');
  const lv = NTFY_LEVEL[level] || NTFY_LEVEL.info;
  const headers = {
    'Content-Type': 'text/plain; charset=utf-8',
    'Title': headerValue(title),
    'Priority': String(lv.priority),
    'Tags': lv.tags,
    'Markdown': 'yes'
  };
  if (n.token) headers['Authorization'] = 'Bearer ' + n.token;

  const r = await post(base + '/' + encodeURIComponent(n.topic), desp || '', headers);
  if (r.status === 200) return { ok: true, message: '已推送' };

  // ntfy 报错时返回 JSON 体，取出来更好定位
  let d = {};
  try { d = JSON.parse(r.text); } catch (e) { /* ignore */ }
  return { ok: false, message: d.error || d.message || r.error || ('HTTP ' + r.status) };
}

/* ---------- 分发 ---------- */

// 想加通道只需在这里登记一条：key 对应 config.alert[key]，run 返回 { ok, message }
const CHANNELS = [
  { key: 'serverchan', name: 'Server酱', run: sendServerChan },
  { key: 'ntfy', name: 'ntfy', run: sendNtfy }
];

// 永不抛异常：告警发不出去绝不能反过来影响主流程
async function send(title, desp, level) {
  const results = [];
  for (const ch of CHANNELS) {
    const c = channelCfg(ch.key);
    if (!c || !c.enabled) continue;
    let r;
    try {
      r = await ch.run(title, desp, level);
    } catch (e) {
      r = { ok: false, message: e.message };
    }
    if (!r.ok) console.warn('[alert] ' + ch.name + ' 推送失败：' + r.message + ' — ' + title);
    results.push({ channel: ch.key, ok: r.ok, message: r.message });
  }
  if (!results.length) return { ok: false, message: '没有启用的告警通道' };
  return { ok: results.some((r) => r.ok), results };
}

module.exports = { start, send };
