const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { checkSum, ALPHABET } = require('./license');

// 部署卡库：对外卖「Termux 装 Claude Code」用的卡密，和 App 那套
// （data/license-keys.json）完全独立。每张卡只记「卖给谁 / 什么时候到期 /
// 绑在哪台设备上」—— **不存任何 API Key**，客户用自己的 Key，从安装命令
// 带进来，全程不经过服务器。部署时不要删 data/。
const FILE = path.join(__dirname, '..', 'data', 'cc-keys.json');

// 卡密格式复用 license.js 的字母表与校验位算法，只换前缀：
// AXCC-XXXX-XXXX-CC，主体 8 位 + 校验 2 位
const PREFIX = 'AXCC';

// 每张卡都能单独覆盖，发卡时留空则用这几个缺省值
const DEFAULT_BASE_URL = 'https://api.deepseek.com/anthropic';
const DEFAULT_MODEL = 'deepseek-flash';
const DEFAULT_SMALL_MODEL = 'deepseek-v4-flash-vision-exp';

// 客户端脚本模板目录
const ASSET_DIR = path.join(__dirname, '..', 'assets');

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

// 北京时间（卡密按自然日算到期，跟服务器时区无关）
function today() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Shanghai' });
}

function isValidDate(s) {
  return /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(new Date(s + 'T00:00:00Z').getTime());
}

// did（设备指纹）定长 32 位十六进制，比较时用等长比较，避免时序侧信道
function safeEqual(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  if (x.length !== y.length) return false;
  return crypto.timingSafeEqual(x, y);
}

function list() {
  return read().keys.slice().sort((a, b) => b.createdAt - a.createdAt);
}

/**
 * 发卡。只记备注、到期日和（装机后自动填上的）绑定设备。
 * baseUrl/model/smallModel 是「这台机器装完用哪家端点」，不是秘密，
 * 由卖家在面板上定，随机器锁密文一起下发。
 */
function create(opts) {
  const o = opts || {};
  const exp = String(o.expire || '').trim();
  if (exp && !isValidDate(exp)) throw new Error('到期日格式应为 YYYY-MM-DD');

  const db = read();
  let key = makeKey();
  while (db.keys.some((k) => k.key === key)) key = makeKey(); // 撞了就重摇

  const item = {
    key,
    note: String(o.note || '').trim(),
    baseUrl: String(o.baseUrl || '').trim() || DEFAULT_BASE_URL,
    model: String(o.model || '').trim() || DEFAULT_MODEL,
    smallModel: String(o.smallModel || '').trim() || DEFAULT_SMALL_MODEL,
    expire: exp, // 空 = 永久
    enabled: true,
    deviceId: '',
    deviceLabel: '',
    boundAt: 0,
    installCount: 0,
    lastCheckAt: 0,
    checkCount: 0,
    createdAt: Date.now()
  };
  db.keys.push(item);
  write(db);
  return item;
}

function update(rawKey, patch) {
  const db = read();
  const k = normalize(rawKey);
  const rec = db.keys.find((x) => x.key === k);
  if (!rec) throw new Error('未找到该卡密');

  const p = patch || {};
  if (p.note !== undefined) rec.note = String(p.note || '').trim();
  if (p.baseUrl !== undefined) rec.baseUrl = String(p.baseUrl || '').trim() || DEFAULT_BASE_URL;
  if (p.model !== undefined) rec.model = String(p.model || '').trim() || DEFAULT_MODEL;
  if (p.smallModel !== undefined) rec.smallModel = String(p.smallModel || '').trim() || DEFAULT_SMALL_MODEL;
  if (p.expire !== undefined) {
    const exp = String(p.expire || '').trim();
    if (exp && !isValidDate(exp)) throw new Error('到期日格式应为 YYYY-MM-DD');
    rec.expire = exp;
  }
  if (p.enabled !== undefined) rec.enabled = !!p.enabled;
  write(db);
  return rec;
}

function remove(rawKey) {
  const db = read();
  const k = normalize(rawKey);
  const before = db.keys.length;
  db.keys = db.keys.filter((x) => x.key !== k);
  if (db.keys.length === before) throw new Error('未找到该卡密');
  write(db);
  return { ok: true };
}

// 售后换机用：清掉绑定，下次请求会重新绑到新设备
function unbind(rawKey) {
  const db = read();
  const k = normalize(rawKey);
  const rec = db.keys.find((x) => x.key === k);
  if (!rec) throw new Error('未找到该卡密');
  rec.deviceId = '';
  rec.deviceLabel = '';
  rec.boundAt = 0;
  write(db);
  return rec;
}

/**
 * 纯校验，不写盘。did 为空表示「还没绑定过」的探测请求。
 * 返回 {ok:true, rec} 或 {ok:false, msg}。
 */
function verify(rawKey, did) {
  const key = normalize(rawKey);
  const compact = key.replace(/-/g, '');
  if (compact.length !== 14 || !compact.startsWith(PREFIX)) {
    return { ok: false, msg: '卡密格式不正确' };
  }
  const body = compact.slice(4, 12);
  const given = compact.slice(12);
  if (body.split('').some((c) => ALPHABET.indexOf(c) < 0)) {
    return { ok: false, msg: '卡密含无效字符' };
  }
  const expect = checkSum(body);
  if (!expect || expect !== given) return { ok: false, msg: '卡密无效' };

  const rec = read().keys.find((x) => x.key === key);
  if (!rec) return { ok: false, msg: '卡密未登记，请找管理员开通' };
  if (!rec.enabled) return { ok: false, msg: '卡密已被停用' };
  if (rec.expire && today() > rec.expire) {
    return { ok: false, msg: '卡密已于 ' + rec.expire + ' 过期' };
  }

  if (rec.deviceId && did && !safeEqual(rec.deviceId, did)) {
    return { ok: false, msg: '该卡密已绑定其它设备，换机请联系管理员解绑' };
  }
  return { ok: true, rec };
}

/**
 * 校验并在尚未绑定时绑定设备。**只有装机（/build）走这里** ——
 * 客户自带 Key，装完之后服务器没什么可「断供」的，所以没有启动期校验。
 * label 只用于面板显示（机型），不参与判定。
 */
function authorize(rawKey, did, label) {
  const r = verify(rawKey, did);
  if (!r.ok) return r;
  if (!did) return { ok: false, msg: '缺少设备标识' };

  const db = read();
  const rec = db.keys.find((x) => x.key === r.rec.key);
  if (!rec.deviceId) {
    rec.deviceId = String(did);
    rec.deviceLabel = String(label || '').slice(0, 60);
    rec.boundAt = Date.now();
    write(db);
  }
  return { ok: true, rec };
}

// 校验成功后记一笔；安装脚本调用时顺带累加安装次数
function touch(rawKey, isInstall) {
  const db = read();
  const rec = db.keys.find((x) => x.key === normalize(rawKey));
  if (!rec) return;
  rec.lastCheckAt = Date.now();
  rec.checkCount = (rec.checkCount || 0) + 1;
  if (isInstall) rec.installCount = (rec.installCount || 0) + 1;
  write(db);
}

// ---------- 加密 ----------

/**
 * blob 布局：base64( iv[12] | authTag[16] | ciphertext )
 * 密钥 = scrypt(did, salt)，did 由客户机现场算出来 —— 脚本被转发到
 * 第二台手机就解不开，这是「绑定机器」的实际执行点。
 */
function encrypt(did, salt, obj) {
  const key = crypto.scryptSync(String(did), String(salt), 32);
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key, iv);
  const body = Buffer.concat([c.update(JSON.stringify(obj), 'utf8'), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), body]).toString('base64');
}

function readAsset(name) {
  return fs.readFileSync(path.join(ASSET_DIR, name), 'utf8');
}

// 模板里用 @@NAME@@ 占位；用 split/join 而不是 replace，避免 $& 之类被当成替换模式
function fill(tpl, vars) {
  let out = tpl;
  for (const k of Object.keys(vars)) out = out.split('@@' + k + '@@').join(String(vars[k]));
  return out;
}

// ---------- 平台表 ----------
// 两个平台跑的是同一套「逐步下发」协议，差别只在模板文件、步骤目录、锁步骤名、
// 解锁脚本和越界哨兵的写法。未知值一律退回 termux —— 客户端多传一个参数不该让
// 装机挂掉，也不该因为参数写错就暴露「还有别的平台」。
const PLATFORMS = {
  termux: {
    runner: 'cc-runner.tpl.sh',
    stepDir: 'cc-steps',
    stepExt: '.sh',
    lockStep: '02-lock.sh',
    unlock: 'cc-unlock.js',
    done: 'CC_STEP_DONE=1',
    total: 'CC_STEP_TOTAL=%d'
  },
  win: {
    runner: 'cc-runner.tpl.ps1',
    stepDir: 'cc-steps-win',
    stepExt: '.ps1',
    lockStep: '02-lock.ps1',
    unlock: 'cc-unlock-win.js',
    done: '$CC_STEP_DONE = 1',
    total: '$CC_STEP_TOTAL = %d'
  }
};

function platformOf(raw) {
  const p = String(raw == null ? '' : raw).trim().toLowerCase();
  return Object.prototype.hasOwnProperty.call(PLATFORMS, p) ? p : 'termux';
}

// 越界时回给客户端的那一行：客户端看到它就收工，不用预先知道总步数
function doneMarker(platform) {
  return PLATFORMS[platformOf(platform)].done;
}

/**
 * 每步下发的**开头一行**：告诉客户端一共几步，它才画得出进度条。
 *
 * 跟 doneMarker 是两回事 —— 那套「走到越界才收工」的协议不动，这只是额外捎个信。
 * 所以两边怎么配都不炸：老客户端收到这一行只会把它当普通赋值执行（变量没人读），
 * 新客户端配老服务器则拿不到数，退回 [3] 这种朴素写法。
 */
function stepTotalMarker(platform, n) {
  return PLATFORMS[platformOf(platform)].total.replace('%d', String(n));
}

/**
 * 引导段：客户粘的那条命令拉下来的那一段。算 did、问 Key、逐步向服务器要安装步骤。
 * 它**不含任何安装逻辑** —— 客户机上因此没有「一份可以拿去改的安装脚本」。
 */
function runnerScript(rec, host, platform) {
  return fill(readAsset(PLATFORMS[platformOf(platform)].runner), { KEY: rec.key, HOST: host });
}

// 安装步骤按文件名排序下发，01-xxx 是第 1 步
function stepDir(platform) {
  return path.join(ASSET_DIR, PLATFORMS[platformOf(platform)].stepDir);
}

function stepFiles(platform) {
  const ext = PLATFORMS[platformOf(platform)].stepExt;
  return fs.readdirSync(stepDir(platform)).filter((f) => f.endsWith(ext)).sort();
}

// 两个平台共用的两份素材：写配置的脚本，和全局守则正文。
// 正文曾经内联在 Termux 的第 6 步里，抽出来才能和 Windows 共用一份。
const APPLY_JS = 'cc-apply-config.js';
const CLAUDE_MD = 'cc-claude-md.md';

function b64(s) {
  return Buffer.from(s, 'utf8').toString('base64');
}

/**
 * 某一步的占位符。三类：
 *   · 机器锁：密文按设备现场生成，换台机器解不开 —— 所以「把下发的步骤整个抓下来
 *     转发给别人」仍然堵着。
 *   · 写配置：两个平台共用同一份 cc-apply-config.js，base64 下发（步骤里解码到临时
 *     目录再跑）。base64 是为了躲开各种「正文里出现某个字符就把字符串截断」的坑。
 *   · 全局守则：正文同样是多行 Markdown，一并 base64。
 *
 * 判步骤用的是「去掉扩展名的文件名」（05-config.sh / 05-config.ps1 都认），
 * 这样两边的步骤只要编号和用途对齐，服务器这边就是一段代码。
 */
function stepVars(name, rec, did, salt, platform) {
  const os = platformOf(platform);
  const p = PLATFORMS[os];
  const base = name.replace(/\.[^.]+$/, '');

  if (name === p.lockStep) {
    const blob = encrypt(did, salt, {
      did: did,
      baseUrl: rec.baseUrl,
      model: rec.model,
      smallModel: rec.smallModel
    });

    if (os === 'win') {
      // 先把 salt 填进解锁脚本再编码 —— 反过来的话，脚本正文还留着 @@SALT@@，
      // 会依赖 fill() 的键顺序，太脆
      const unlockJs = fill(readAsset(p.unlock), { SALT: salt });
      return { LOCK_B64: b64(blob), UNLOCK_B64: b64(unlockJs) };
    }

    // 去掉结尾换行：步骤文件里 @@UNLOCK_JS@@ 自带一个 \n，不去掉会多出一个空行
    const unlockJs = fill(readAsset(p.unlock).replace(/\n+$/, ''), { SALT: salt });
    return { LOCK_BLOB: blob, UNLOCK_JS: unlockJs };
  }

  if (base === '05-config') return { APPLY_JS_B64: b64(readAsset(APPLY_JS)) };
  if (base === '06-claude-md') {
    return { APPLY_JS_B64: b64(readAsset(APPLY_JS)), CLAUDE_MD_B64: b64(readAsset(CLAUDE_MD)) };
  }
  return {};
}

function stepCount(platform) {
  return stepFiles(platform).length;
}

/**
 * 第 i 步（从 1 开始）的脚本片段。越界返回 null —— 调用方据此告诉客户端「装完了」。
 * 片段是被客户端的 runner source 到同一个会话里执行的，不是独立脚本，
 * 所以各步之间的变量（$API_KEY、$CLAUDE_DIR、$NPM_REGISTRY…）自然串得起来。
 */
function stepScript(i, rec, did, salt, platform) {
  const os = platformOf(platform);
  const files = stepFiles(os);
  if (!Number.isInteger(i) || i < 1 || i > files.length) return null;
  const name = files[i - 1];
  return fill(fs.readFileSync(path.join(stepDir(os), name), 'utf8'), stepVars(name, rec, did, salt, os));
}

module.exports = {
  list, create, update, remove, unbind, verify, authorize, touch,
  encrypt, runnerScript, stepScript, stepCount, doneMarker, stepTotalMarker, platformOf, PLATFORMS,
  normalize, isValidDate,
  DEFAULT_BASE_URL, DEFAULT_MODEL, DEFAULT_SMALL_MODEL, PREFIX
};
