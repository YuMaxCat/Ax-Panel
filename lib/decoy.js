const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const monitor = require('./monitor');
const iploc = require('./iploc');
const { clientIp } = require('./net');

// 登录诱饵：在面板域名下埋一组「像后台入口」的路径，撞上来的一律完整取证。
//
// 为什么值得做：扫描器在真正尝试登录之前要先「找门」—— 去撞 /admin、/wp-login.php
// 这些并不存在的路径。这一步现在完全不可见（只会拿到一个 302 到 /login，不留痕迹），
// 而它恰恰是最有情报价值的部分。真访客只会走 /login，所以撞上来的一定是在找后门的人。
//
// 定位要说清楚：这是**绊线**，不是隐蔽的蜜罐。真登录页是公开可达的，对方把
// GET /login 和 GET /admin 做一次 diff 就能认出诱饵，也能顺势列出全部诱饵路径。
// 所以别指望它骗过定向攻击者，它拦的是自动化扫描器 —— 而那是绝大多数情况。
//
// 三条硬约束（改动时别破坏）：
//   1. 诱饵**结构上不可能放行**：不调 auth.verifyKey、不发会话、不写 cookie。
//      即使将来改出 bug 返回了 ok，应用壳守卫也会把没有会话登记的请求打回 /login。
//   2. **绝不调 verifyKey**。一是避免计时旁路，二是 scrypt(N=16384) 在 1 核机器上
//      一次要几十毫秒，有人拿诱饵刷就能把 CPU 打满 —— 诱饵不能变成 DoS 入口。
//   3. 假页面直接复用真登录页，只改「提交打到哪」，别去手写一个像的。

const DIR = path.join(__dirname, '..', 'data');
const FILE = path.join(DIR, 'decoy-log.json');
const LOGIN_HTML = path.join(__dirname, '..', 'public', 'login.html');
const PUBLIC_DIR = path.join(__dirname, '..', 'public');

const COLLAPSE_MS = 60000;      // 同 IP 同诱饵同动作一分钟内折叠成一条，次数记在 n 上
const COLLAPSE_MAX = 2000;      // 折叠表的容量上限，超了清一轮过期的
const NOTIFY_MS = 30 * 60000;   // 同一个 IP 半小时内只提醒一次
const NOTIFY_MAX_HOUR = 6;      // 全局每小时推送上限：扫描器一波能踩出几百条
const NOTIFY_MAP_MAX = 500;

// 攻击者可能用别的字段名交卷，多认几个才不至于漏掉凭据
const KEY_FIELDS = ['key', 'password', 'passwd', 'pass', 'pwd', 'secret', 'token', 'access_key'];
const USER_FIELDS = ['username', 'user', 'login', 'email', 'account', 'uname'];

// 这些前缀绝不能占：/api 是接口本身，/ws 是升级握手（根本不过 Express 中间件），
// /.well-known 是 acme.sh 续签走的路 —— 占了它证书会静默续不上，最后过期
const RESERVED = ['/api', '/ws', '/.well-known'];

let cfg = null;
let list = []; // 新的在前
let dirty = false;
let timer = null;

const collapse = new Map();  // 'ip|诱饵|动作' -> 记录
const notified = new Map();  // ip -> 上次提醒时间
const notifyTimes = [];

/* ---------- 持久化 ---------- */

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
  } catch (e) { /* 落盘失败不该影响响应 */ }
}

function scheduleSave() {
  dirty = true;
  if (timer) return;
  timer = setTimeout(() => { timer = null; if (dirty) flush(); }, 3000);
  if (timer.unref) timer.unref();
}

/* ---------- 路径归一化 ---------- */

// 归一化：解码 → 小写 → 折叠重复斜杠 → 解掉 . 和 .. 段。
//
// 每一步都是在堵一个真会被利用的绕过，不是洁癖：
//   decodeURIComponent —— 接住 /%61dmin
//   转小写            —— 接住 /ADMIN（也保证 /API 不会绕过下面的保留前缀检查）
//   折叠 // 与 /./    —— 否则 //admin、/./admin 会掉到兜底逻辑回 302 /login，一秒被识破
//   解 .. 段          —— /admin/../x 真正要的是 /x，不该算命中 /admin
function normalize(p) {
  let s = String(p == null ? '' : p);
  try { s = decodeURIComponent(s); } catch (e) { /* 编码坏了就按原文比 */ }
  s = s.toLowerCase().replace(/\\/g, '/');

  const out = [];
  const parts = s.split('/');
  for (const seg of parts) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') { out.pop(); continue; }  // 越出根就自然被 pop 空，不做特殊处理
    out.push(seg);
  }
  return '/' + out.join('/');
}

// 配置里的路径只允许这些字符。既是校验，也是安全边界：
// 假页面的表单 action 会用到它，放开就等于把 XSS 递给攻击者
// （例如 /admin/</script><script>… 能提前闭合页面里的 <script> 块）
const SAFE_PATH = /^\/[A-Za-z0-9._~/-]*$/;

/* ---------- 与 public/ 的冲突 ---------- */

let pubFiles = null;

function walk(dir, prefix, out) {
  for (const n of fs.readdirSync(dir)) {
    const f = path.join(dir, n);
    let st;
    try { st = fs.statSync(f); } catch (e) { continue; }
    if (st.isDirectory()) walk(f, prefix + n + '/', out);
    else out.push(prefix + n);
    if (out.length > 3000) return;
  }
}

function pubList() {
  if (!pubFiles) {
    pubFiles = [];
    try { walk(PUBLIC_DIR, '', pubFiles); } catch (e) { /* 读不到就不挡这层，启动自检还会再查 */ }
  }
  return pubFiles;
}

// public/ 的静态资源不能占。注意要判**目录前缀**而不只是同名文件：
// express.static 配了 extensions:['html']，诱饵路径写成 /js 会把 /js/app.js 全部吞掉
function pubConflict(s) {
  const want = s.replace(/^\//, '');
  if (!want) return true;
  for (const f of pubList()) {
    if (f === want || f === want + '.html') return true;  // /login 也会命中 login.html
    if (f.indexOf(want + '/') === 0) return true;
  }
  return false;
}

// 一条诱饵路径能不能用：通过回空串，否则回一句给用户看的理由。
// 放在这里而不是设置页，是因为启动自检和保存校验必须讲同一套规则 —— 两处各写一份迟早走偏。
// ⚠ 一切判断都基于**归一化之后**的值，否则 /API 会绕过去、而 /Admin 这种条目又永远命中不了
function check(p) {
  const raw = String(p == null ? '' : p).trim();
  if (!raw) return '路径不能为空';
  if (raw.length > 120) return '单条路径不能超过 120 个字符';
  if (raw[0] !== '/') return '路径需以 / 开头';
  if (!SAFE_PATH.test(raw)) return '路径只能包含字母、数字、- _ . ~ /';

  const s = normalize(raw);
  if (s === '/') return '不能占用根路径';
  for (const b of RESERVED) {
    if (s === b || s.indexOf(b + '/') === 0) return '不能占用 ' + b;
  }
  if (pubConflict(s)) return '与面板自己的路径冲突（会被整个吞掉）';
  return '';
}

// 归一化后的形态才是真正存进去、拿去比对的形态
function canon(p) {
  return normalize(String(p == null ? '' : p).trim());
}

let cacheSrc = null;
let cacheList = [];

function entries() {
  const src = cfg && cfg.decoy && Array.isArray(cfg.decoy.paths) ? cfg.decoy.paths : [];
  if (src !== cacheSrc) {
    cacheSrc = src;
    const out = [];
    for (const p of src) {
      if (!check(p)) out.push(canon(p));
    }
    cacheList = out;
  }
  return cacheList;
}

// 命中则返回配置里那个（已校验、已归一化的）条目，否则 null。
// 返回条目而不是请求路径，是为了让调用方拿到一个保证安全的字符串 ——
// 它会被拼进假页面的内联 JS，用原始 req.path 拼就是未鉴权反射 XSS
function match(p) {
  const want = normalize(p);
  if (!want) return null;
  for (const e of entries()) {
    if (want === e || want.indexOf(e + '/') === 0) return e;
  }
  return null;
}

/* ---------- 假登录页 ---------- */

let pageMtime = 0;
let pageRaw = '';
let pageWarned = false;

function rawLogin() {
  const st = fs.statSync(LOGIN_HTML);
  if (pageRaw && pageMtime === st.mtimeMs) return pageRaw;
  pageRaw = fs.readFileSync(LOGIN_HTML, 'utf8');
  pageMtime = st.mtimeMs;
  return pageRaw;
}

// 真登录页是现成的最好伪装：面板名、Logo、样式、页脚那颗探活小圆点全对，破绽最小。
// 改三处：
//   1. 插 <base href="/"> —— 诱饵路径可能是 /admin/ 这种带尾斜杠的，页面里的相对资源
//      （logo.png、css/style.css）会解析到 /admin/css/... 而 404
//   2. 表单补 action/method —— 大量撞库机器人不跑 JS、直接解析表单提交。不补的话
//      它们会按 <base> 提交成 GET /，密钥进查询串落到 nginx 日志，而诱饵这边什么都记不到
//   3. 把提交目标从真实 /api/login 换成本次命中的诱饵路径
//
// 替换一律用函数形式：String.replace 的替换串里 $&、$' 是**模式**，拿它拼路径
// 会被构造成响应翻倍（`/admin/$'$'$'` 这种）。虽然路径已经过白名单校验，但别留这个雷
function buildPage(decoyPath) {
  let html = rawLogin();
  const a = '<head>';
  const b = 'fetch(\'/api/login\'';
  const c = '<form class="login-card" id="form" autocomplete="off">';

  // login.html 被改过就替换不上了。真出这事不能装作没事：退化后提交会打到真实
  // /api/login（仍然拒绝、仍然进 authlog，但我们就拿不到凭据了），所以要吼一声
  if (html.indexOf(a) < 0 || html.indexOf(b) < 0 || html.indexOf(c) < 0) {
    if (!pageWarned) {
      pageWarned = true;
      console.error('[decoy] public/login.html 的结构变了，诱饵页替换失败 —— 请同步 lib/decoy.js 的 buildPage');
    }
    return html;
  }

  const act = 'action="' + decoyPath + '" method="post"';
  html = html.replace(a, () => a + '\n<base href="/">');
  html = html.replace(c, () => c.replace(' autocomplete="off">', ' ' + act + ' autocomplete="off">'));
  html = html.replace(b, () => 'fetch(' + JSON.stringify(decoyPath));
  return html;
}

/* ---------- 记录 ---------- */

function pickField(body, names) {
  for (const n of names) {
    const v = body[n];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  return '';
}

// 提交上来的口令**不存明文**：这是面板自己的域名，盘上留一份收集来的口令，
// 等于把自己变成一个凭据收集站 —— 文件管理器（fileRoots 含 /）、备份、云盘都能读到，
// 域名也可能因此被举报。只留长度 + 加盐指纹：既保住了「同一个口令被反复试」
// 「多本字典撞同一个词」这些关联分析，又不可还原
function fingerprint(key) {
  const salt = (cfg && cfg.decoy && cfg.decoy.salt) || '';
  return crypto.createHash('sha256').update(salt + key).digest('hex').slice(0, 16);
}

function pruneCollapse(now) {
  for (const [k, v] of collapse) {
    if (now - v.ts > COLLAPSE_MS) collapse.delete(k);
  }
}

function record(ev) {
  const now = Date.now();
  // 折叠键用**命中的诱饵**而不是原始路径：/admin、/admin/、/admin/x 是同一件事，
  // 分别计数的话，交替着打就能一请求一行，几秒把上限灌满、把更早的证据挤出去
  const ck = ev.ip + '|' + ev.decoy + '|' + ev.act;
  const hit = collapse.get(ck);

  if (hit && now - hit.ts < COLLAPSE_MS) {
    hit.n = (hit.n || 1) + 1;
    hit.ts = now;
    hit.path = ev.path;
    if (ev.keyLen) { hit.keyLen = ev.keyLen; hit.keyId = ev.keyId; }
    if (ev.user) hit.user = ev.user;
    scheduleSave();
    return hit;
  }

  const entry = {
    ts: now,
    ip: ev.ip,
    loc: '',
    ua: String(ev.ua || '').slice(0, 200),
    method: ev.method,
    path: String(ev.path || '').slice(0, 300),   // 原始形态（含查询串）保留：/./admin 这类写法本身就是证据
    decoy: ev.decoy,
    act: ev.act,
    self: !!ev.self,
    keyLen: ev.keyLen || 0,     // 攻击者猜的口令：只留长度与指纹，不留原文
    keyId: ev.keyId || '',
    user: String(ev.user || '').slice(0, 100),
    ref: String(ev.ref || '').slice(0, 200),
    lang: String(ev.lang || '').slice(0, 60),
    xff: String(ev.xff || '').slice(0, 120),   // 客户端自称的 XFF，伪造痕迹本身就是指纹
    n: 1
  };
  list.unshift(entry);
  if (list.length > cap()) list.length = cap();

  collapse.set(ck, entry);
  if (collapse.size > COLLAPSE_MAX) pruneCollapse(now);
  scheduleSave();

  iploc.locate(ev.ip).then((loc) => { if (loc) { entry.loc = loc; scheduleSave(); } });
  return entry;
}

function cap() {
  return (cfg && cfg.decoy && cfg.decoy.max) || 1000;
}

/* ---------- 通知 ---------- */

// 标题必须是**常量**。monitor 按「级别 + 标题」去重，把 IP 拼进标题等于取消去重：
// 1000 个 IP 就是 1000 条通知，而通知中心只留 200 条、每条都同步全量写盘 ——
// 一波扫描器足以把证书到期、进程离线这些真告警全挤出去。
// IP 放正文，靠 monitor 自己的 5 分钟去重 + 下面的两层节流兜住
function maybeNotify(entry) {
  if (!cfg || !cfg.decoy || !cfg.decoy.notify) return;
  if (entry.self) return; // 主人自己踩到不算事

  const now = Date.now();
  if (now - (notified.get(entry.ip) || 0) < NOTIFY_MS) return;

  while (notifyTimes.length && now - notifyTimes[0] > 3600000) notifyTimes.shift();
  if (notifyTimes.length >= NOTIFY_MAX_HOUR) return;

  if (notified.size > NOTIFY_MAP_MAX) {
    for (const [ip, ts] of notified) { if (now - ts > NOTIFY_MS) notified.delete(ip); }
  }
  notified.set(entry.ip, now);
  notifyTimes.push(now);

  monitor.pushNotification(
    'warning',
    '诱饵被踩',
    '有请求撞上了诱饵路径 ' + entry.decoy +
      (entry.act === 'submit' ? '，并提交了口令' : '') +
      '\n来源 ' + entry.ip + (entry.loc ? '（' + entry.loc + '）' : ''),
    { external: !!(cfg.decoy && cfg.decoy.external) }
  );
}

/* ---------- 中间件 ---------- */

// 只负责把这次命中记下来，不管应答 —— 主人自己那条走的是「记录 + 302」，
// 不走假页面，两者共用这一段
function capture(req, decoyPath, isSelf) {
  const method = req.method;
  const submitting = method === 'POST' || method === 'PUT' || method === 'PATCH';
  const body = req.body && typeof req.body === 'object' ? req.body : {};
  const key = submitting ? pickField(body, KEY_FIELDS) : '';

  return record({
    ip: clientIp(req),
    ua: req.get('user-agent'),
    method,
    path: req.originalUrl || req.path,   // 带查询串：扫描器爱在 query 里塞注入串，也是证据
    decoy: decoyPath,
    act: submitting ? 'submit' : 'view',
    self: !!isSelf,
    keyLen: key ? key.length : 0,
    keyId: key ? fingerprint(key.slice(0, 512)) : '',
    user: submitting ? pickField(body, USER_FIELDS) : '',
    ref: req.get('referer'),
    lang: req.get('accept-language'),
    xff: req.get('x-forwarded-for')
  });
}

function handle(req, res, decoyPath) {
  maybeNotify(capture(req, decoyPath, false));

  // no-store 防 CF / 浏览器把假登录页缓存住；noindex 免得搜索引擎把真访客引来。
  // 用 HTTP 头而不是 <meta name="robots">：后者在页面源码里可见，是个破绽
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Robots-Tag', 'noindex, nofollow');

  const method = req.method;
  if (method === 'POST' || method === 'PUT' || method === 'PATCH') {
    // 恒回失败，且绝不 Set-Cookie。文案与真登录页的错误提示一致，行为对得上
    return res.status(401).json({ error: '密钥错误' });
  }
  if (method !== 'GET' && method !== 'HEAD') {
    return res.status(405).json({ error: '方法不被允许' });
  }
  res.status(200).type('html').send(buildPage(decoyPath));
}

// sessionOf 由 server.js 注入 —— 那份判断（签名有效 + 会话登记还在）只在那边有一份，
// 不在这里重写一遍，免得两处慢慢走偏
function middleware(config, sessionOf) {
  cfg = config || cfg;
  return function decoy(req, res, next) {
    const hit = match(req.path);
    if (!hit) return next();

    // 带有效会话的是主人自己：记一条（打 self 标记、不推送）然后回面板，不给假页面。
    // 静默跳过会留一个查不到痕迹的会话校验探针 —— 偷到 cookie 的人只要 GET 一次
    // 诱饵路径，看是 302 还是假页面就知道会话还有效，而 authlog 和诱饵日志里都看不见
    if (sessionOf && sessionOf(req)) {
      capture(req, hit, true);
      return res.redirect('/');
    }
    handle(req, res, hit);
  };
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

function stats(days) {
  const span = Math.max(1, Math.min(90, parseInt(days, 10) || 14));
  const first = startOfDay(Date.now() - (span - 1) * 86400000);

  const byDay = {};
  const perPath = {};
  const perIp = {};
  const totals = { hits: 0, ips: 0, submits: 0, self: 0, last: 0 };

  for (const e of list) {
    if (e.ts < first) continue;
    const n = e.n || 1;
    const key = dayKey(e.ts);

    const d = byDay[key] || (byDay[key] = { date: key, hits: 0, submits: 0 });
    d.hits += n;
    if (e.act === 'submit') d.submits += n;
    totals.hits += n;
    if (e.act === 'submit') totals.submits += n;
    if (e.self) totals.self += n;
    if (e.ts > totals.last) totals.last = e.ts;

    const p = perPath[e.path] || (perPath[e.path] = { path: e.path, decoy: e.decoy, hits: 0, act: e.act, last: 0 });
    p.hits += n;
    if (e.ts >= p.last) { p.last = e.ts; p.act = e.act; }

    const s = perIp[e.ip] || (perIp[e.ip] = { ip: e.ip, loc: e.loc || '', hits: 0, submits: 0, last: 0, ua: '' });
    s.hits += n;
    if (e.act === 'submit') s.submits += n;
    if (e.ts >= s.last) { s.last = e.ts; if (e.loc) s.loc = e.loc; s.ua = e.ua || s.ua; }
  }

  // 补全没有记录的日期，趋势图才不会断成锯齿
  const trend = [];
  for (let i = 0; i < span; i++) {
    const key = dayKey(first + i * 86400000);
    trend.push(byDay[key] || { date: key, hits: 0, submits: 0 });
  }

  totals.ips = Object.keys(perIp).length;

  return {
    days: span,
    totals,
    trend,
    paths: Object.keys(perPath).map((k) => perPath[k]).sort((a, b) => b.hits - a.hits).slice(0, 12),
    ips: Object.keys(perIp).map((k) => perIp[k]).sort((a, b) => b.hits - a.hits).slice(0, 20),
    list: list.slice(0, 200)
  };
}

// 某个 IP 的诱饵命中明细，给画像用
function byIp(ip) {
  const want = String(ip || '');
  const out = { ip: want, hits: 0, submits: 0, events: [] };
  if (!want) return out;
  for (const e of list) {
    if (e.ip !== want) continue;
    const n = e.n || 1;
    out.hits += n;
    if (e.act === 'submit') out.submits += n;
    if (out.events.length < 50) out.events.push(e);
  }
  return out;
}

/* ---------- 启动 ---------- */

// 启动自检：config.json 随时可能被手改，改坏了会静默失效或被静默忽略，两种都难受，
// 所以每次启动都把不能用的条目吼出来
function audit() {
  const src = cfg && cfg.decoy && Array.isArray(cfg.decoy.paths) ? cfg.decoy.paths : [];
  for (const raw of src) {
    const p = String(raw == null ? '' : raw).trim();
    if (!p) continue;
    const why = check(p);
    if (why) console.warn('[decoy] 诱饵路径 ' + p + ' 不可用（' + why + '），已忽略');
  }
}

function start(config) {
  cfg = config || null;
  cacheSrc = null;
  pubFiles = null;
  load();
  if (!cfg || !cfg.decoy || !cfg.decoy.enabled) return;
  audit();
  process.on('exit', () => { if (dirty) flush(); });
}

module.exports = { start, middleware, stats, byIp, match, check, canon };
