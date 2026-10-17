const https = require('https');
const { URL } = require('url');
const monitor = require('./monitor');

// 雨云开放 API。只调用 GET 类只读接口 —— 任何「开机 / 重装 / 释放 / 充值」接口都不在这里出现，
// 面板拿到 key 也不该有改动云资源的能力。
const DAY = 86400000;
const MAX_BODY = 2 * 1024 * 1024;

const cache = { at: 0, data: null, error: null };
const track = {}; // 资源 key -> 已推送过的告警等级，等级不变就不重复打扰

function get(baseUrl, path, apiKey) {
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(baseUrl + path); } catch (e) { return reject(new Error('雨云接口地址无效')); }
    const req = https.request({
      hostname: u.hostname,
      port: u.port || 443,
      path: u.pathname + u.search,
      method: 'GET',
      headers: { 'X-Api-Key': apiKey, Accept: 'application/json' },
      timeout: 15000
    }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => {
        body += c;
        if (body.length > MAX_BODY) req.destroy(new Error('响应过大'));
      });
      res.on('end', () => {
        let d;
        try { d = JSON.parse(body); } catch (e) { return reject(new Error('雨云返回了无法解析的内容')); }
        if (!d || d.code !== 200) return reject(new Error((d && d.message) || '雨云接口返回异常'));
        resolve(d.data);
      });
    });
    req.on('timeout', () => req.destroy(new Error('请求超时')));
    req.on('error', (e) => reject(new Error('无法连接雨云接口：' + e.message)));
    req.end();
  });
}

function daysLeft(expSec) {
  if (!expSec) return null;
  return Math.ceil((expSec * 1000 - Date.now()) / DAY);
}

function gb(bytes) {
  return bytes ? Math.round((bytes / 1073741824) * 100) / 100 : 0;
}

function normalizeServer(s) {
  const plan = s.Plan || {};
  const disk = s.UsageData && s.UsageData.Disks && s.UsageData.Disks['/'];
  return {
    id: s.ID,
    name: s.Zone || ('云服务器 #' + s.ID),
    ip: s.MainIPv4 || '',
    status: s.Status || '',
    os: s.OsName || '',
    plan: plan.chinese || '',
    spec: [plan.cpu ? plan.cpu + ' 核' : '', plan.memory ? plan.memory + ' MB' : ''].filter(Boolean).join(' / '),
    diskGB: disk ? Math.round(disk.Total / 1073741824) : null,
    autoRenew: !!s.AutoRenew,
    expireAt: (s.ExpDate || 0) * 1000,
    daysLeft: daysLeft(s.ExpDate),
    renewPrice: typeof plan.price === 'number' ? plan.price : null,
    netMbps: s.NetIn || s.NetOut || null,
    trafficLimitGB: s.TrafficBytesDayLimit || 0,
    trafficUsedGB: gb(s.TrafficBytes)
  };
}

async function readServers(rc) {
  const d = await get(rc.baseUrl, '/product/rcs/?options=' + encodeURIComponent('{}'), rc.apiKey);
  const list = (d && d.Records) || [];
  return list.map(normalizeServer);
}

// 域名续费价是单独接口，且只返回一个数字；失败就留空，不影响整页展示
async function domainPrice(rc, id) {
  try { return await get(rc.baseUrl, '/product/domain/' + id + '/renew-price', rc.apiKey); }
  catch (e) { return null; }
}

async function readDomains(rc) {
  const d = await get(rc.baseUrl, '/product/domain/?options=' + encodeURIComponent('{}'), rc.apiKey);
  const list = (d && d.Records) || [];
  const out = [];
  for (const x of list) {
    out.push({
      id: x.id,
      name: x.domain,
      status: x.status || '',
      locked: !!x.is_locked,
      expireAt: (x.exp_date || 0) * 1000,
      daysLeft: daysLeft(x.exp_date),
      renewPrice: await domainPrice(rc, x.id)
    });
  }
  return out;
}

async function read(rc) {
  const [servers, domains] = await Promise.all([readServers(rc), readDomains(rc)]);
  return { servers, domains, fetchedAt: Date.now() };
}

// refreshMs 内的重复调用直接吃缓存；force 用于前端手动刷新
async function snapshot(rc, force) {
  if (!rc || !rc.enabled || !rc.apiKey) return { enabled: false, servers: [], domains: [], fetchedAt: 0 };
  if (!force && cache.data && Date.now() - cache.at < rc.refreshMs) return cache.data;
  try {
    const data = await read(rc);
    cache.data = data;
    cache.at = Date.now();
    cache.error = null;
    checkExpiry(rc, data);
    return data;
  } catch (e) {
    cache.error = e.message;
    if (cache.data) return Object.assign({}, cache.data, { stale: true, error: e.message });
    throw e;
  }
}

/* ---------- 到期告警 ---------- */

function checkExpiry(rc, data) {
  const warn = rc.expireWarnDays || 7;
  const all = data.servers.map((s) => ({ key: 'rcs:' + s.id, label: '云服务器「' + s.name + '」', d: s }))
    .concat(data.domains.map((x) => ({ key: 'domain:' + x.id, label: '域名「' + x.name + '」', d: x })));

  for (const it of all) {
    const n = it.d.daysLeft;
    let level = null;
    let title = '';
    let msg = '';
    if (n == null) { delete track[it.key]; continue; }
    if (n < 0) {
      level = 'critical';
      title = '已到期：' + it.label;
      msg = it.label + '已于 ' + new Date(it.d.expireAt).toLocaleDateString('zh-CN') + ' 到期，请尽快处理';
    } else if (n <= 3) {
      level = 'critical';
      title = '即将到期：' + it.label;
      msg = it.label + '仅剩 ' + n + ' 天到期（' + new Date(it.d.expireAt).toLocaleDateString('zh-CN') + '），请尽快续费';
    } else if (n <= warn) {
      level = 'warning';
      title = '临近到期：' + it.label;
      msg = it.label + '剩余 ' + n + ' 天到期（' + new Date(it.d.expireAt).toLocaleDateString('zh-CN') + '）';
    }

    if (!level) { delete track[it.key]; continue; }
    if (track[it.key] === level) continue; // 等级没变就不重复推；临近→即将→已到期各推一次
    track[it.key] = level;
    monitor.pushNotification(level, title, msg);
  }
}

/* ---------- 轮询（由 server.js 启动） ---------- */

let timer = null;

function start(cfg) {
  const rc = cfg && cfg.rainyun;
  if (!rc || !rc.enabled || !rc.apiKey) return;
  const tick = () => { snapshot(rc, false).catch((e) => console.error('[rainyun]', e.message)); };
  tick();
  timer = setInterval(tick, Math.max(60000, rc.refreshMs || 1800000));
  if (timer.unref) timer.unref();
}

function stop() {
  if (timer) { clearInterval(timer); timer = null; }
}

module.exports = { start, stop, snapshot };
