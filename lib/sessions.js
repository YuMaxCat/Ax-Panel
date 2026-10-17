const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const iploc = require('./iploc');

// 在线会话登记：token 里只放 sid，真实信息（IP / 归属地 / UA / 最后活跃）在这里，
// 于是「踢下线」只要删掉登记项，token 立刻失效 —— 不用轮换 sessionSecret 把所有人一起踢掉。
//
// ⚠ fail-closed：文件存在但读不懂时，一律当「没有有效会话」。最坏结果是所有人重新登录
// 一次（登录本身不依赖这个文件），而不是让来路不明的 token 继续通行。
const DIR = path.join(__dirname, '..', 'data');
const FILE = path.join(DIR, 'sessions.json');
const MAX = 200;
const TOUCH_SAVE_MS = 30000; // 每次 API 请求都会 touch，落盘节流到 30 秒一次

let cfg = null;
let db = { list: [] };
let broken = false; // 文件读不懂 → 全部失效
let dirty = false;
let timer = null;
let lastTouchSave = 0;

function start(config) {
  cfg = config || null;
  load();
  prune();
  scheduleSave();
}

function load() {
  try {
    const d = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    db = d && Array.isArray(d.list) ? d : { list: [] };
    broken = false;
  } catch (e) {
    db = { list: [] };
    // 文件不存在 = 全新安装或还没人登录过，空列表就好；读到了却解析不了才是不信任
    broken = e.code !== 'ENOENT';
    if (broken) console.error('[sessions] 会话文件解析失败，已按无有效会话处理：' + e.message);
  }
}

function flush() {
  dirty = false;
  try {
    if (!fs.existsSync(DIR)) fs.mkdirSync(DIR, { recursive: true });
    const tmp = FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(db) + '\n');
    fs.renameSync(tmp, FILE); // 原子替换
    broken = false; // 写成功了就说明这份数据是可信的，故障自愈
  } catch (e) {
    console.error('[sessions] 会话落盘失败：' + e.message);
  }
}

function scheduleSave() {
  dirty = true;
  if (timer) return;
  timer = setTimeout(() => { timer = null; if (dirty) flush(); }, 3000);
  if (timer.unref) timer.unref();
}

function lifeMs() {
  return ((cfg && cfg.sessionDays) || 30) * 86400000;
}

// 清掉已经超过会话时长的登记项（和 cookie 的 maxAge 同步过期）
function prune() {
  const min = Date.now() - lifeMs();
  const before = db.list.length;
  db.list = db.list.filter((s) => s && s.sid && (s.iat || 0) >= min);
  if (db.list.length !== before) scheduleSave();
  return before - db.list.length;
}

function find(sid) {
  if (broken || !sid) return null;
  for (const s of db.list) { if (s.sid === sid) return s; }
  return null;
}

// 对外只给不可逆的短 id：拿到会话列表也偷不走别人的 token
function pubId(sid) {
  if (!sid) return '';
  return crypto.createHash('sha256').update(String(sid)).digest('hex').slice(0, 16);
}

function create(meta) {
  prune();
  const now = Date.now();
  const sid = crypto.randomBytes(16).toString('hex');
  const rec = {
    sid,
    iat: now,
    lastSeen: now,
    ip: String((meta && meta.ip) || ''),
    loc: '',
    ua: String((meta && meta.ua) || '').slice(0, 200)
  };
  db.list.push(rec);
  // 同一个人反复登录不该把名单撑爆，超了丢最久没动静的
  if (db.list.length > MAX) {
    db.list.sort((a, b) => (a.lastSeen || 0) - (b.lastSeen || 0));
    db.list.splice(0, db.list.length - MAX);
  }
  broken = false;
  scheduleSave();

  iploc.locate(rec.ip).then((loc) => { if (loc) { rec.loc = loc; scheduleSave(); } });
  return sid;
}

function valid(sid) {
  return !!find(sid);
}

function touch(sid, ip) {
  const s = find(sid);
  if (!s) return;
  s.lastSeen = Date.now();
  if (ip && ip !== 'unknown') s.ip = ip;
  if (Date.now() - lastTouchSave > TOUCH_SAVE_MS) {
    lastTouchSave = Date.now();
    scheduleSave();
  }
}

function list() {
  prune();
  return db.list
    .slice()
    .sort((a, b) => (b.lastSeen || 0) - (a.lastSeen || 0))
    .map((s) => ({
      id: pubId(s.sid),
      iat: s.iat,
      lastSeen: s.lastSeen,
      ip: s.ip,
      loc: s.loc,
      ua: s.ua
    }));
}

function revoke(id) {
  if (broken || !id) return 0;
  const before = db.list.length;
  db.list = db.list.filter((s) => pubId(s.sid) !== id);
  const n = before - db.list.length;
  if (n) scheduleSave();
  return n;
}

// 保留当前会话，其余全部下线
function revokeOthers(sid) {
  if (broken) return 0;
  const before = db.list.length;
  db.list = db.list.filter((s) => s.sid === sid);
  const n = before - db.list.length;
  if (n) scheduleSave();
  return n;
}

module.exports = { start, create, valid, touch, list, revoke, revokeOthers, pubId };
