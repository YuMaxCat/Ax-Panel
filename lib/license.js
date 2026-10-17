const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// 卡密库：全部记录装一个 json，量级只有几十条，读改写足够。
// 部署时不要删 data/，这份文件和 state.json 一样是活数据。
const FILE = path.join(__dirname, '..', 'data', 'license-keys.json');

// 密钥格式与校验位算法必须和 App 端 core/License.java 完全一致：
// AXPN-XXXX-XXXX-CC，主体 8 位 + 校验 2 位，改一边就得改另一边
const PREFIX = 'AXPN';
const ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
const MOD = 1024;

function read() {
  try {
    const db = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    return db && Array.isArray(db.keys) ? db : { keys: [] };
  } catch (e) {
    return { keys: [] };
  }
}

function write(db) {
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  const tmp = FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(db, null, 2) + '\n');
  fs.renameSync(tmp, FILE); // 原子替换，中途挂掉也不会留下半截文件
}

// 对 8 位主体做滚动哈希，编码成 2 个 base32 字符
function checkSum(body8) {
  let v = 7;
  for (let i = 0; i < body8.length; i++) {
    const idx = ALPHABET.indexOf(body8[i]);
    if (idx < 0) return '';
    v = (v * 31 + idx) % MOD;
  }
  return ALPHABET[v >> 5] + ALPHABET[v % 32]; // v / 32 在 0..1023 里等于右移 5 位
}

function normalize(raw) {
  let s = String(raw == null ? '' : raw).toUpperCase().replace(/[^0-9A-Z]/g, '');
  if (s.startsWith(PREFIX)) s = s.slice(PREFIX.length);
  if (s.length !== 10) return String(raw == null ? '' : raw).trim().toUpperCase();
  return PREFIX + '-' + s.slice(0, 4) + '-' + s.slice(4, 8) + '-' + s.slice(8);
}

// ALPHABET 长度 32 整除 256，用字节取模不会偏
function body8() {
  const bytes = crypto.randomBytes(8);
  let s = '';
  for (let i = 0; i < 8; i++) s += ALPHABET[bytes[i] % ALPHABET.length];
  return s;
}

function makeKey() {
  const b = body8();
  return PREFIX + '-' + b.slice(0, 4) + '-' + b.slice(4) + '-' + checkSum(b);
}

// 北京时间的今天（卡密按自然日算到期，跟服务器时区无关）
function today() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Shanghai' });
}

function isValidDate(s) {
  return /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(new Date(s + 'T00:00:00Z').getTime());
}

function list() {
  return read().keys.slice().sort((a, b) => b.createdAt - a.createdAt);
}

function create(note, expire) {
  const exp = String(expire || '').trim();
  if (exp && !isValidDate(exp)) throw new Error('到期日格式应为 YYYY-MM-DD');

  const db = read();
  let key = makeKey();
  while (db.keys.some((k) => k.key === key)) key = makeKey(); // 撞了就重摇

  const item = {
    key,
    note: String(note || '').trim(),
    expire: exp, // 空 = 永久
    enabled: true,
    createdAt: Date.now(),
    lastUsedAt: 0,
    useCount: 0
  };
  db.keys.push(item);
  write(db);
  return item;
}

function update(key, patch) {
  const db = read();
  const k = normalize(key);
  const rec = db.keys.find((x) => x.key === k);
  if (!rec) throw new Error('未找到该密钥');

  if (patch.note !== undefined) rec.note = String(patch.note || '').trim();
  if (patch.expire !== undefined) {
    const exp = String(patch.expire || '').trim();
    if (exp && !isValidDate(exp)) throw new Error('到期日格式应为 YYYY-MM-DD');
    rec.expire = exp;
  }
  if (patch.enabled !== undefined) rec.enabled = !!patch.enabled;
  write(db);
  return rec;
}

function remove(key) {
  const db = read();
  const k = normalize(key);
  const before = db.keys.length;
  db.keys = db.keys.filter((x) => x.key !== k);
  if (db.keys.length === before) throw new Error('未找到该密钥');
  write(db);
  return { ok: true };
}

/**
 * App 端验证。返回 {ok:true, expire} 或 {ok:false, msg}，
 * 这两种形状是 App 解析的契约，改字段名要同步改 core/License.java。
 */
function verify(rawKey) {
  const key = normalize(rawKey);
  const compact = key.replace(/-/g, '');
  if (compact.length !== 14 || !compact.startsWith(PREFIX)) {
    return { ok: false, msg: '密钥格式不正确' };
  }
  const body = compact.slice(4, 12);
  const given = compact.slice(12);
  if (/[^0-9A-Z]/.test(body) || body.split('').some((c) => ALPHABET.indexOf(c) < 0)) {
    return { ok: false, msg: '密钥含无效字符' };
  }
  const expect = checkSum(body);
  if (!expect || expect !== given) return { ok: false, msg: '密钥无效或已被停用' };

  const db = read();
  const rec = db.keys.find((x) => x.key === key);
  if (!rec) return { ok: false, msg: '密钥未登记，请找管理员开通' };
  if (!rec.enabled) return { ok: false, msg: '密钥已被停用' };
  if (rec.expire && today() > rec.expire) {
    return { ok: false, msg: '密钥已于 ' + rec.expire + ' 过期' };
  }

  rec.lastUsedAt = Date.now();
  rec.useCount = (rec.useCount || 0) + 1;
  write(db);
  return { ok: true, msg: '验证通过', expire: rec.expire || '永久有效' };
}

// checkSum / ALPHABET 一并导出：装机卡（lib/cc.js）用同一套字母表和校验位算法，
// 只是换个前缀，没必要抄一份。对 App 那套的行为零影响。
module.exports = { list, create, update, remove, verify, normalize, isValidDate, checkSum, ALPHABET };
