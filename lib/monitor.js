const fs = require('fs');
const path = require('path');
const os = require('os');
const cert = require('./cert');
const pm2 = require('./pm2');
const alert = require('./alert');

const DATA_DIR = path.join(__dirname, '..', 'data');
const NOTIFY_FILE = path.join(DATA_DIR, 'notifications.json');
const DEDUP_MS = 5 * 60 * 1000;
const CERT_CHECK_MS = 6 * 60 * 60 * 1000;

const clients = new Set();
let snapshot = {};
let history = [];
let lastCpu = null;
let lastNet = null;
let timer = null;
let pm2Timer = null;
let certTimer = null;
let cfg = null;
let notifications = [];
const lastNotify = {};
const track = {};
const certTrack = {}; // 域名 → 上次告警等级，只在等级变化时推送

/* ---------- 通知存储 ---------- */

function loadNotifications() {
  try {
    const d = JSON.parse(fs.readFileSync(NOTIFY_FILE, 'utf8'));
    notifications = Array.isArray(d) ? d : [];
  } catch (e) {
    notifications = [];
  }
}

function saveNotifications() {
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(NOTIFY_FILE, JSON.stringify(notifications.slice(0, 200)));
  } catch (e) { /* ignore */ }
}

// opts.external：是否外发到告警通道。默认只有 critical 才外发，站点恢复等显式开启
function pushNotification(level, title, message, opts) {
  const key = level + '|' + title;
  const now = Date.now();
  if (lastNotify[key] && now - lastNotify[key] < DEDUP_MS) return null;
  lastNotify[key] = now;
  const n = {
    id: now.toString(36) + Math.random().toString(36).slice(2, 6),
    level,
    title,
    message,
    ts: now,
    read: false
  };
  notifications.unshift(n);
  if (notifications.length > 200) notifications.length = 200;
  saveNotifications();
  broadcast({ type: 'notification', data: n });

  const external = opts && opts.external !== undefined ? !!opts.external : (level === 'critical');
  if (external) alert.send(title, message, level); // send 内部已吞掉全部异常

  return n;
}

/* ---------- 采集 ---------- */

function readCpuStat() {
  try {
    const line = fs.readFileSync('/proc/stat', 'utf8').split('\n')[0];
    const p = line.trim().split(/\s+/).slice(1).map(Number);
    const idle = p[3] + (p[4] || 0);
    const total = p.reduce((a, b) => a + b, 0);
    return { idle, total };
  } catch (e) {
    return null;
  }
}

function readMem() {
  try {
    const info = fs.readFileSync('/proc/meminfo', 'utf8');
    const get = (k) => {
      const m = info.match(new RegExp('^' + k + ':\\s+(\\d+)', 'm'));
      return m ? Number(m[1]) * 1024 : 0;
    };
    const total = get('MemTotal');
    const available = get('MemAvailable');
    const used = total - available;
    const swapTotal = get('SwapTotal');
    const swapFree = get('SwapFree');
    return {
      total,
      free: get('MemFree'),
      available,
      used,
      usagePercent: total ? (used / total) * 100 : 0,
      swapTotal,
      swapUsed: swapTotal - swapFree,
      swapPercent: swapTotal ? ((swapTotal - swapFree) / swapTotal) * 100 : 0
    };
  } catch (e) {
    return { total: 0, free: 0, available: 0, used: 0, usagePercent: 0, swapTotal: 0, swapUsed: 0, swapPercent: 0 };
  }
}

function readDisk() {
  try {
    const s = fs.statfsSync('/');
    const total = s.bsize * s.blocks;
    const free = s.bsize * s.bavail;
    const used = total - s.bsize * s.bfree;
    return { total, free, used, usagePercent: total ? (used / total) * 100 : 0, mount: '/' };
  } catch (e) {
    return { total: 0, free: 0, used: 0, usagePercent: 0, mount: '/' };
  }
}

function readNet() {
  try {
    const lines = fs.readFileSync('/proc/net/dev', 'utf8').split('\n').slice(2);
    let rx = 0;
    let tx = 0;
    for (const l of lines) {
      const idx = l.indexOf(':');
      if (idx < 0) continue;
      if (l.slice(0, idx).trim() === 'lo') continue;
      const cols = l.slice(idx + 1).trim().split(/\s+/).map(Number);
      rx += cols[0] || 0;
      tx += cols[8] || 0;
    }
    return { rx, tx };
  } catch (e) {
    return { rx: 0, tx: 0 };
  }
}

function countProcs() {
  try {
    return fs.readdirSync('/proc').filter((d) => /^\d+$/.test(d)).length;
  } catch (e) {
    return 0;
  }
}

function collect() {
  const now = Date.now();

  const c = readCpuStat();
  let usage = snapshot.cpu ? snapshot.cpu.usage : 0;
  if (c && lastCpu) {
    const dt = c.total - lastCpu.total;
    const di = c.idle - lastCpu.idle;
    if (dt > 0) usage = Math.max(0, Math.min(100, (1 - di / dt) * 100));
  }
  if (c) lastCpu = c;

  const net = readNet();
  let rxRate = 0;
  let txRate = 0;
  if (lastNet) {
    const dtSec = (now - lastNet.ts) / 1000;
    if (dtSec > 0) {
      rxRate = Math.max(0, (net.rx - lastNet.rx) / dtSec);
      txRate = Math.max(0, (net.tx - lastNet.tx) / dtSec);
    }
  }
  lastNet = { ts: now, rx: net.rx, tx: net.tx };

  const cpus = os.cpus();
  snapshot = {
    ts: now,
    cpu: { usage, cores: cpus.length || 1, model: ((cpus[0] && cpus[0].model) || '').trim() },
    mem: readMem(),
    disk: readDisk(),
    load: os.loadavg(),
    uptime: os.uptime(),
    net: { rxRate, txRate, rxTotal: net.rx, txTotal: net.tx },
    procCount: countProcs()
  };

  history.push({ ts: now, cpu: usage, mem: snapshot.mem.usagePercent });
  if (history.length > 120) history.shift();

  evaluate(snapshot);
  broadcast({ type: 'snapshot', data: snapshot });
}

/* ---------- 阈值规则 ---------- */

const RULES = [
  { key: 'cpu', label: 'CPU 使用率', get: (s) => s.cpu.usage, warn: 90, warnMs: 30000, crit: 95, critMs: 60000 },
  { key: 'mem', label: '内存使用率', get: (s) => s.mem.usagePercent, warn: 90, warnMs: 30000 },
  { key: 'disk', label: '磁盘使用率', get: (s) => s.disk.usagePercent, warn: 85, warnMs: 60000, crit: 95, critMs: 60000 }
];

function evaluate(snap) {
  const now = Date.now();
  for (const r of RULES) {
    const v = r.get(snap);
    if (v == null || !isFinite(v)) continue;
    const t = track[r.key] || (track[r.key] = { since: 0, level: null });

    if (v >= r.warn) {
      if (!t.since) t.since = now;
      const dur = now - t.since;
      let level = null;
      if (r.crit != null && v >= r.crit && dur >= (r.critMs || r.warnMs)) level = 'critical';
      else if (dur >= r.warnMs) level = 'warning';

      if (level && t.level !== level) {
        t.level = level;
        pushNotification(level, r.label + '偏高', `${r.label}已达 ${v.toFixed(1)}%，请留意服务器状态`);
      }
    } else {
      t.since = 0;
      t.level = null;
    }
  }
}

/* ---------- pm2 服务健康 ---------- */

async function checkPm2() {
  let list;
  try { list = await pm2.list(); } catch (e) { return; }
  for (const p of list) {
    if (!p.status || p.status === 'online') continue;
    if (p.ignored) continue; // 已加入忽略名单
    pushNotification('critical', '服务离线', `pm2 进程「${p.name}」当前状态：${p.status}`);
  }
}

/* ---------- 证书到期 ---------- */

function checkCerts() {
  if (!cfg) return;
  let list;
  try { list = cert.listCerts(cfg); } catch (e) { return; }

  for (const c of list) {
    let level = null;
    let msg = '';
    if (c.error) {
      level = 'critical';
      msg = `站点「${c.domain}」的证书无法读取：${c.error}（${c.certPath}），请检查 nginx 配置`;
    } else if (c.daysLeft <= cert.CRIT_DAYS) {
      level = 'critical';
      msg = `站点「${c.domain}」的证书仅剩 ${c.daysLeft} 天到期，请尽快续签`;
    } else if (c.daysLeft <= cert.WARN_DAYS) {
      level = 'warning';
      msg = `站点「${c.domain}」的证书剩余 ${c.daysLeft} 天到期，请留意自动续签是否正常`;
    }

    if (!level) { delete certTrack[c.domain]; continue; }
    if (certTrack[c.domain] === level) continue; // 等级未变化，不重复推送
    certTrack[c.domain] = level;
    // title 带域名：pushNotification 按 level|title 去重，否则同一轮第二个域名会被吞掉
    pushNotification(level, (level === 'critical' ? '证书即将过期：' : '证书临近过期：') + c.domain, msg);
  }
}

/* ---------- 广播 ---------- */

function broadcast(msg) {
  const s = JSON.stringify(msg);
  for (const ws of clients) {
    try { if (ws.readyState === 1) ws.send(s); } catch (e) { /* ignore */ }
  }
}

function attach(ws) {
  clients.add(ws);
  try {
    ws.send(JSON.stringify({ type: 'snapshot', data: snapshot }));
    ws.send(JSON.stringify({ type: 'history', data: history }));
    ws.send(JSON.stringify({ type: 'notifications', data: notifications.slice(0, 50) }));
  } catch (e) { /* ignore */ }
  ws.on('close', () => clients.delete(ws));
  ws.on('error', () => clients.delete(ws));
}

/* ---------- 对外 ---------- */

function start(config) {
  cfg = config || null;
  loadNotifications();
  pm2.start(cfg);
  alert.start(cfg);
  const boot = readCpuStat();
  if (boot) lastCpu = boot;
  const nets = readNet();
  lastNet = { ts: Date.now(), rx: nets.rx, tx: nets.tx };
  setTimeout(collect, 600);
  timer = setInterval(collect, 5000);
  pm2Timer = setInterval(checkPm2, 60000);
  // 证书按天变化，低频检查即可
  setTimeout(checkCerts, 30000);
  certTimer = setInterval(checkCerts, CERT_CHECK_MS);
}

function getSnapshot() { return snapshot; }
function getHistory() { return history; }
function getNotifications(limit) { return notifications.slice(0, limit || 100); }

function markRead(id) {
  const n = notifications.find((x) => x.id === id);
  if (n) { n.read = true; saveNotifications(); }
}

function markAllRead() {
  notifications.forEach((n) => { n.read = true; });
  saveNotifications();
}

function clearNotifications() {
  notifications = [];
  saveNotifications();
  broadcast({ type: 'notifications', data: [] });
}

module.exports = {
  start,
  attach,
  broadcast,       // 供 lib/weblog.js 推实时访客事件（别用 pushNotification，那个会落盘 + 5 分钟去重）
  pushNotification,
  getSnapshot,
  getHistory,
  getNotifications,
  markRead,
  markAllRead,
  clearNotifications
};
