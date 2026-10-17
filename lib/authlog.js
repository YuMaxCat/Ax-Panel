const fs = require('fs');
const path = require('path');
const iploc = require('./iploc');

// 登录审计流水：成功 / 失败 / 被限速各记一条，给安全中心画趋势、挑可疑 IP。
// 量级很小（一天最多几百条），整份读改写就够；上限 2000 条，超出丢最旧的。
const DIR = path.join(__dirname, '..', 'data');
const FILE = path.join(DIR, 'auth-log.json');
const MAX = 2000;
const COLLAPSE_MS = 60000; // 同 IP 同结果一分钟内只留一行，重复次数记在 n 上

let list = []; // 新的在前
let dirty = false;
let timer = null;

function load() {
  try {
    const d = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    list = Array.isArray(d) ? d.filter((x) => x && typeof x.ts === 'number') : [];
  } catch (e) {
    list = [];
  }
}

function flush() {
  dirty = false;
  try {
    if (!fs.existsSync(DIR)) fs.mkdirSync(DIR, { recursive: true });
    const tmp = FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(list) + '\n');
    fs.renameSync(tmp, FILE); // 原子替换，中途挂掉也不会留下半截文件
  } catch (e) { /* 落盘失败不该影响登录本身 */ }
}

// 写盘节流：被爆破时一秒能来好几条，攒 3 秒写一次
function scheduleSave() {
  dirty = true;
  if (timer) return;
  timer = setTimeout(() => { timer = null; if (dirty) flush(); }, 3000);
  if (timer.unref) timer.unref();
}

function start() {
  load();
  process.on('exit', () => { if (dirty) flush(); });
}

// result: 'ok' 登录成功 / 'fail' 密钥错误 / 'blocked' 触发限速
function record(e) {
  const ip = String((e && e.ip) || 'unknown');
  const result = String((e && e.result) || 'fail');
  const now = Date.now();

  const head = list[0];
  // 连续同 IP 同结果就累加次数，不再堆行 —— 否则 2000 条上限会被一次爆破灌满，
  // 真正有用的记录反而被挤出去
  if (head && head.ip === ip && head.result === result && now - head.ts < COLLAPSE_MS) {
    head.n = (head.n || 1) + 1;
    head.ts = now;
    scheduleSave();
    return;
  }

  const entry = { ts: now, ip, loc: '', ua: String((e && e.ua) || '').slice(0, 200), result, n: 1 };
  list.unshift(entry);
  if (list.length > MAX) list.length = MAX;
  scheduleSave();

  // 归属地异步补上，登录响应不等它（iploc 内部有缓存，与登录告警共用同一次查询）
  iploc.locate(ip).then((loc) => { if (loc) { entry.loc = loc; scheduleSave(); } });
}

/* ---------- 聚合 ---------- */

function dayKey(ts) {
  const d = new Date(ts);
  const p = (n) => (n < 10 ? '0' : '') + n;
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
}

function startOfDay(ts) {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

function bucket(result) {
  if (result === 'ok') return 'ok';
  return result === 'blocked' ? 'blocked' : 'fail';
}

// 最近 N 天：逐日趋势 + 失败的小时分布 + 可疑 IP 排行
function stats(days) {
  const span = Math.max(1, Math.min(90, parseInt(days, 10) || 14));
  const first = startOfDay(Date.now() - (span - 1) * 86400000);

  const byDay = {};
  const hours = new Array(24).fill(0);
  const susp = {};
  const totals = { ok: 0, fail: 0, blocked: 0 };

  for (const e of list) {
    if (e.ts < first) continue;
    const n = e.n || 1;
    const k = bucket(e.result);
    const key = dayKey(e.ts);
    const b = byDay[key] || (byDay[key] = { date: key, ok: 0, fail: 0, blocked: 0 });
    b[k] += n;
    totals[k] += n;

    if (k === 'ok') continue;
    hours[new Date(e.ts).getHours()] += n;
    const s = susp[e.ip] || (susp[e.ip] = { ip: e.ip, loc: e.loc || '', fail: 0, blocked: 0, last: 0, ua: '' });
    s[k] += n;
    // 归属地和 UA 取最近一次的，看起来更贴近当下
    if (e.ts >= s.last) { s.last = e.ts; if (e.loc) s.loc = e.loc; s.ua = e.ua || s.ua; }
  }

  // 补全没有记录的日期，趋势图才不会断成锯齿
  const trend = [];
  for (let i = 0; i < span; i++) {
    const key = dayKey(first + i * 86400000);
    trend.push(byDay[key] || { date: key, ok: 0, fail: 0, blocked: 0 });
  }

  const suspects = Object.keys(susp)
    .map((k) => susp[k])
    .sort((a, b) => (b.fail + b.blocked) - (a.fail + a.blocked))
    .slice(0, 20);

  return { days: span, totals, trend, hours, suspects };
}

// 单个 IP 的登录历史。诱饵抓到的 IP 要能跟「它有没有试过登录、试了多少次」串起来看，
// 这条线索比诱饵命中本身更能定性一个人。
function byIp(ip) {
  const want = String(ip || '');
  const out = { ip: want, ok: 0, fail: 0, blocked: 0, last: 0, loc: '', uas: [], events: [] };
  if (!want) return out;

  const uas = {};
  for (const e of list) {
    if (e.ip !== want) continue;
    const n = e.n || 1;
    out[bucket(e.result)] += n;
    if (e.ts > out.last) { out.last = e.ts; if (e.loc) out.loc = e.loc; }
    if (e.ua) uas[e.ua] = (uas[e.ua] || 0) + n;
    // list 本来就是新的在前，取前 50 条就够画像用了
    if (out.events.length < 50) out.events.push({ ts: e.ts, result: bucket(e.result), ua: e.ua || '', n });
  }

  out.uas = Object.keys(uas)
    .map((k) => ({ ua: k, n: uas[k] }))
    .sort((a, b) => b.n - a.n)
    .slice(0, 5);
  return out;
}

module.exports = { start, record, stats, byIp };
