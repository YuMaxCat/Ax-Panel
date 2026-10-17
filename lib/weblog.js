// ============================================
// 访问统计：增量解析 nginx access.log，聚合出站点 / 省份 / 时段 / 路径 / 流量
//
// 日志格式（/etc/nginx/nginx.conf 的 main）末尾三个字段是为这里加的：
//   "$host" "$http_cf_connecting_ip" $request_length
// $remote_addr 只到 CF 边缘节点，访客真 IP 取 CF-Connecting-IP
// （它是 CF 覆盖写死的，伪造不了；X-Forwarded-For 前段是客户端自己带的，不可信）。
// 老行没有这三个字段也要能解析 —— 归到「未知站点」。
//
// 数据：data/weblog/days.json（按天聚合，保留 retentionDays 天）
// 2026-09-24 新增
// ============================================

const fs = require('fs');
const path = require('path');
const iploc = require('./iploc');
const monitor = require('./monitor');

const DATA_DIR = path.join(__dirname, '..', 'data', 'weblog');
const DAYS_FILE = path.join(DATA_DIR, 'days.json');
const IP_FILE = path.join(DATA_DIR, 'ipcache.json');

const READ_MAX = 4 * 1024 * 1024;   // 单次最多读 4MB，剩下的下一 tick 继续
const PARTIAL_MAX = 2 * 1024 * 1024; // 积压上限，超了丢弃最老的（宁可少统计也不能吃爆内存）
const LOOKUP_BUDGET = 400;          // 每 tick 最多查多少个新 IP（本机服务，1~3ms 一次）
const IP_CACHE_MAX = 5000;
const TOP_PATHS = 60;               // 每天最多留 60 条路径，超了砍掉访问量最小的
const LIVE_MAX = 500;
const FLUSH_MS = 1000;              // 实时访客攒 1 秒推一批，避免刷爆 WebSocket

/* ---------- 省份归一 ---------- */

const PROV_FULL = [
  '北京市', '天津市', '河北省', '山西省', '内蒙古自治区', '辽宁省', '吉林省', '黑龙江省',
  '上海市', '江苏省', '浙江省', '安徽省', '福建省', '江西省', '山东省', '河南省',
  '湖北省', '湖南省', '广东省', '广西壮族自治区', '海南省', '重庆市', '四川省', '贵州省',
  '云南省', '西藏自治区', '陕西省', '甘肃省', '青海省', '宁夏回族自治区',
  '新疆维吾尔自治区', '台湾省', '香港特别行政区', '澳门特别行政区'
];

// ip2region 给的是「内蒙古」「浙江」这类简称或全称，统一成地图数据里的全称
const PROV_MAP = (() => {
  const m = new Map();
  for (const full of PROV_FULL) {
    const short = full
      .replace(/(省|市)$/, '')
      .replace(/(维吾尔|壮族|回族)?自治区$/, '')
      .replace(/特别行政区$/, '');
    m.set(full, full);
    m.set(short, full);
    m.set(short + '省', full);
    m.set(short + '市', full);
  }
  return m;
})();

// 命中返回省份全称，否则返回 ''（国外 IP 的省份字段是国名，不参与地图打点）
function normProvince(p) {
  return PROV_MAP.get(String(p || '').trim()) || '';
}

/* ---------- 日志行解析 ---------- */

const MONTHS = { Jan: 1, Feb: 2, Mar: 3, Apr: 4, May: 5, Jun: 6, Jul: 7, Aug: 8, Sep: 9, Oct: 10, Nov: 11, Dec: 12 };

// 末尾三个字段是可选的：改格式之前的老行没有
const LINE_RE = new RegExp(
  '^(\\S+) \\S+ \\S+ \\[([^\\]]+)\\] "([^"]*)" (\\d{3}) (\\d+) ' +
  '"([^"]*)" "([^"]*)" "([^"]*)"(?: "([^"]*)" "([^"]*)" (\\d+))?'
);

const BOT_RE = /bot|spider|crawler|slurp|curl|wget|python-requests|Go-http|okhttp|java\/|libwww|scrapy|headless|monitor|nmap|scan/i;
const BROWSER_RE = /Mozilla\/5\.0.*(Chrome|Firefox|Safari|Edg|OPR|MSIE|Trident)/i;

function uaClass(ua) {
  if (!ua || ua === '-') return 'other';
  if (BOT_RE.test(ua)) return 'bot';
  return BROWSER_RE.test(ua) ? 'browser' : 'other';
}

// 只取路径，丢掉查询串（?v=23 这类会污染排行）
function pathOf(req) {
  const sp = req.indexOf(' ');
  if (sp < 0) return '';
  const rest = req.slice(sp + 1);
  const sp2 = rest.indexOf(' ');
  if (sp2 < 0) return '';
  let p = rest.slice(0, sp2);
  const q = p.indexOf('?');
  if (q >= 0) p = p.slice(0, q);
  try { p = decodeURIComponent(p); } catch (e) { /* 原样 */ }
  return p.slice(0, 200);
}

function parseLine(line) {
  const m = LINE_RE.exec(line);
  if (!m) return null;
  const t = /^(\d{2})\/(\w{3})\/(\d{4}):(\d{2})/.exec(m[2]);
  if (!t) return null;
  const month = MONTHS[t[2]];
  if (!month) return null;

  const cfip = m[10] && m[10] !== '-' ? m[10] : '';
  const xff = m[8] && m[8] !== '-' ? m[8].split(',').pop().trim() : '';
  return {
    date: t[3] + '-' + String(month).padStart(2, '0') + '-' + t[1],
    hour: Number(t[4]),
    ip: cfip || xff || m[1],          // 优先 CF-Connecting-IP，退 X-Forwarded-For 末段，最后取对端地址
    // 老行没 host 字段、nginx 也可能记成 '-'，这两种都归到「未知站点」
    host: m[9] && m[9] !== '-' ? m[9] : '未知站点',
    status: Number(m[4]),
    out: Number(m[5]),
    in: Number(m[11]) || 0,
    ua: uaClass(m[7]),
    path: pathOf(m[3])
  };
}

/* ---------- 数据结构 ---------- */

let cfg = null;
let days = {};          // 'YYYY-MM-DD' → 日聚合
let ipCache = new Map(); // ip → {p, c}（归属地原始字段；null 结果不入缓存，下次还会再试）
let live = [];          // 最近访客，新的在前
let pending = [];       // 待广播
let offset = 0;
let inode = 0;
let partial = '';
let timer = null;
let flushTimer = null;
let ipTimer = null;
let running = false;

function newDay() {
  return { req: 0, out: 0, in: 0, hosts: {}, prov: {}, hours: new Array(24).fill(0), paths: {}, ua: {}, status: {} };
}

function dayOf(date) {
  if (!days[date]) days[date] = newDay();
  return days[date];
}

// 路径表封顶：超了就只留访问量最大的 TOP_PATHS 条
function capPaths(d) {
  const keys = Object.keys(d.paths);
  if (keys.length <= TOP_PATHS * 2) return;
  keys.sort((a, b) => d.paths[b] - d.paths[a]);
  const keep = {};
  for (let i = 0; i < TOP_PATHS; i++) keep[keys[i]] = d.paths[keys[i]];
  d.paths = keep;
}

function addToDay(d, rec, prov) {
  d.req++;
  d.out += rec.out;
  d.in += rec.in;
  const h = d.hosts[rec.host] || (d.hosts[rec.host] = { req: 0, out: 0, in: 0 });
  h.req++;
  h.out += rec.out;
  h.in += rec.in;
  d.hours[rec.hour] = (d.hours[rec.hour] || 0) + 1;
  d.ua[rec.ua] = (d.ua[rec.ua] || 0) + 1;
  const sc = 's' + String(rec.status)[0];
  d.status[sc] = (d.status[sc] || 0) + 1;
  if (rec.path) d.paths[rec.path] = (d.paths[rec.path] || 0) + 1;
  d.prov[prov || '未知'] = (d.prov[prov || '未知'] || 0) + 1;
  capPaths(d);
}

/* ---------- 归属地 ---------- */

function privateLabel(ip) {
  return iploc.isPrivate(ip) ? '内网' : '';
}

// 返回 {prov, loc}：prov 是聚合用的桶（省份全称 / 国名 / 内网 / 未知）
// 内存里的 null 表示「查过、查不到」——也进缓存，否则同一个查不到的 IP
// 每次都算一次预算，日志里刷屏的话这一 tick 就卡死了
async function locateFor(ip) {
  const priv = privateLabel(ip);
  if (priv) return { prov: priv, loc: '' };

  if (!ipCache.has(ip)) {
    const raw = await iploc.locateRaw(ip);
    if (ipCache.size >= IP_CACHE_MAX) ipCache.delete(ipCache.keys().next().value);
    ipCache.set(ip, raw || null);
  }
  const raw = ipCache.get(ip);
  if (!raw) return { prov: '未知', loc: '' };
  const province = String(raw.province || '').trim();
  const city = String(raw.city || '').trim();
  const full = normProvince(province);
  // 中国省份归到全称（地图要用），国外保留国名
  return { prov: full || province || '未知', loc: [province, city].filter(Boolean).join(' ') };
}

/* ---------- 读日志 ---------- */

// 处理一行；预算不够（需要查新 IP 但已用完）返回 false，让调用方停在这一行
async function consume(line, state) {
  const rec = parseLine(line);
  if (!rec) return true;                    // 坏行直接跳过，不算消耗
  let prov = '';
  let loc = '';
  if (!ipCache.has(rec.ip) && !privateLabel(rec.ip)) {
    if (state.budget <= 0) return false;    // 留给下一 tick
    state.budget--;
  }
  const r = await locateFor(rec.ip);
  prov = r.prov;
  loc = r.loc;

  addToDay(dayOf(rec.date), rec, prov, loc);
  state.changed = true;
  live.unshift({ ts: Date.now(), ip: rec.ip, prov, loc, host: rec.host, path: rec.path, status: rec.status, ua: rec.ua });
  if (live.length > LIVE_MAX) live.length = LIVE_MAX;
  pending.push({ ip: rec.ip, prov, loc, host: rec.host, path: rec.path, status: rec.status, ts: Date.now() });
  return true;
}

async function drain() {
  if (!cfg || !cfg.weblog || !cfg.weblog.enabled) return;
  const file = cfg.weblog.file;
  let st;
  try { st = fs.statSync(file); } catch (e) { return; }

  // 轮转（logrotate 换文件）或截断（/api/logs/flush）都要从头读
  if (st.ino !== inode || st.size < offset) {
    inode = st.ino;
    offset = 0;
    partial = '';
  }
  if (st.size <= offset) return;

  const len = Math.min(st.size - offset, READ_MAX);
  const buf = Buffer.alloc(len);
  const fd = fs.openSync(file, 'r');
  try { fs.readSync(fd, buf, 0, len, offset); } finally { fs.closeSync(fd); }

  const text = (partial + buf.toString('utf8'));
  offset += len;                            // 读到的字节一律算读过，没处理完的留在 partial 里
  const lines = text.split('\n');
  const tail = lines.pop();                 // 末尾可能是半行，留到下一 tick

  const state = { budget: LOOKUP_BUDGET, changed: false };
  let i = 0;
  for (; i < lines.length; i++) {
    if (!(await consume(lines[i], state))) break;
  }
  const rest = i < lines.length ? lines.slice(i).join('\n') + '\n' + tail : tail;
  partial = rest.length > PARTIAL_MAX ? rest.slice(rest.length - PARTIAL_MAX) : rest;

  if (state.changed) saveDays();
}

async function tick() {
  if (running) return;                      // 上一轮还没跑完就跳过，别叠加
  running = true;
  try { await drain(); } catch (e) { /* 统计不能把面板搞挂 */ } finally { running = false; }
}

/* ---------- 落盘 ---------- */

function pruneDays() {
  const keep = (cfg && cfg.weblog && cfg.weblog.retentionDays) || 92;
  const keys = Object.keys(days).sort();
  while (keys.length > keep) delete days[keys.shift()];
  // 只留 ipcache 里还有的？没必要，ip 缓存独立封顶
}

function writeJson(file, data) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data));
  fs.renameSync(tmp, file);                 // 原子替换，中途挂掉不会留半截文件
}

let lastSave = 0;

// 92 天的数据几百 KB，没必要每个 tick 都写一遍，60 秒最多落一次盘
function saveDays() {
  const now = Date.now();
  if (now - lastSave < 60000) return;
  lastSave = now;
  try {
    pruneDays();
    writeJson(DAYS_FILE, { days });
  } catch (e) { /* 统计落盘失败不影响面板 */ }
}

function saveIps() {
  try {
    const o = {};
    for (const [k, v] of ipCache) o[k] = v ? [v.province, v.city] : [];
    writeJson(IP_FILE, o);
  } catch (e) { /* ignore */ }
}

function load() {
  try {
    const d = JSON.parse(fs.readFileSync(DAYS_FILE, 'utf8'));
    days = (d && d.days) || {};
  } catch (e) { days = {}; }
  try {
    const o = JSON.parse(fs.readFileSync(IP_FILE, 'utf8'));
    for (const k of Object.keys(o)) {
      const v = o[k];
      if (Array.isArray(v)) ipCache.set(k, v.length ? { province: v[0] || '', city: v[1] || '' } : null);
    }
  } catch (e) { /* 没缓存也能跑 */ }
}

/* ---------- 实时访客广播 ---------- */

function flushPending() {
  if (!pending.length) return;
  const batch = pending;
  pending = [];
  monitor.broadcast({ type: 'visit', data: batch });
}

/* ---------- 对外查询 ---------- */

function lastDates(n) {
  return Object.keys(days).sort().slice(-n);
}

function mergeRange(dates) {
  const out = newDay();
  const pathAll = {};
  for (const date of dates) {
    const d = days[date];
    if (!d) continue;
    out.req += d.req || 0;
    out.out += d.out || 0;
    out.in += d.in || 0;
    for (const k of Object.keys(d.hosts || {})) {
      const h = out.hosts[k] || (out.hosts[k] = { req: 0, out: 0, in: 0 });
      h.req += d.hosts[k].req; h.out += d.hosts[k].out; h.in += d.hosts[k].in;
    }
    for (const k of Object.keys(d.prov || {})) out.prov[k] = (out.prov[k] || 0) + d.prov[k];
    for (const k of Object.keys(d.ua || {})) out.ua[k] = (out.ua[k] || 0) + d.ua[k];
    for (const k of Object.keys(d.status || {})) out.status[k] = (out.status[k] || 0) + d.status[k];
    for (let i = 0; i < 24; i++) out.hours[i] += (d.hours && d.hours[i]) || 0;
    for (const k of Object.keys(d.paths || {})) pathAll[k] = (pathAll[k] || 0) + d.paths[k];
  }
  out.paths = pathAll;
  capPaths(out);
  return out;
}

function topN(obj, n) {
  return Object.keys(obj)
    .map((k) => ({ name: k, n: obj[k] }))
    .sort((a, b) => b.n - a.n)
    .slice(0, n);
}

function getStats(range) {
  const today = Object.keys(days).sort().pop() || '';
  let dates;
  if (range === 'today') dates = today ? [today] : [];
  else if (range === '30d') dates = lastDates(30);
  else dates = lastDates(7);
  const d = mergeRange(dates);

  const hostNames = Object.keys(d.hosts).sort((a, b) => d.hosts[b].req - d.hosts[a].req);
  return {
    range: range || '7d',
    date: today,
    totals: { req: d.req, out: d.out, in: d.in, days: dates.length },
    hosts: hostNames.map((k) => ({ host: k || '未知站点', req: d.hosts[k].req, out: d.hosts[k].out, in: d.hosts[k].in })),
    prov: topN(d.prov, 40),
    paths: topN(d.paths, 20),
    ua: d.ua,
    status: d.status,
    hours: d.hours,
    // 7 天 × 24 小时热力图：按日期升序给每天的 24 小时
    heat: dates.map((date) => ({ date, hours: (days[date] && days[date].hours) || new Array(24).fill(0) }))
  };
}

// 按月给每天的按站点用量，给「流量用量」页用
function getUsage(month) {
  const mm = /^\d{4}-\d{2}$/.test(String(month || '')) ? month : new Date().toISOString().slice(0, 7);
  const dates = Object.keys(days).filter((d) => d.startsWith(mm)).sort();
  const hosts = new Set();
  const rows = dates.map((date) => {
    const d = days[date];
    const h = {};
    for (const k of Object.keys(d.hosts || {})) {
      hosts.add(k);
      h[k] = d.hosts[k];
    }
    return { date, req: d.req || 0, out: d.out || 0, in: d.in || 0, hosts: h };
  });
  const total = rows.reduce((a, r) => ({ req: a.req + r.req, out: a.out + r.out, in: a.in + r.in }), { req: 0, out: 0, in: 0 });
  return { month: mm, hosts: Array.from(hosts).sort(), rows, total };
}

function getLive(limit) {
  return live.slice(0, Math.min(LIVE_MAX, Math.max(1, limit || 50)));
}

/* ---------- 启动 ---------- */

function start(config) {
  cfg = config || null;
  if (!cfg || !cfg.weblog || !cfg.weblog.enabled) return;
  stop(); // 重复 start 不能挂出两个定时器（设置页改完参数会重启一次）
  load();
  setTimeout(tick, 3000);                   // 错开启动高峰
  timer = setInterval(tick, Math.max(5000, cfg.weblog.intervalMs || 30000));
  if (timer.unref) timer.unref();
  flushTimer = setInterval(flushPending, FLUSH_MS);
  if (flushTimer.unref) flushTimer.unref();
  // IP 缓存定时落盘（每 5 分钟），别跟着 tick 每次都写
  ipTimer = setInterval(saveIps, 300000);
  if (ipTimer.unref) ipTimer.unref();
}

function stop() {
  if (timer) { clearInterval(timer); timer = null; }
  if (flushTimer) { clearInterval(flushTimer); flushTimer = null; }
  if (ipTimer) { clearInterval(ipTimer); ipTimer = null; }
}

module.exports = { start, stop, getStats, getUsage, getLive };
