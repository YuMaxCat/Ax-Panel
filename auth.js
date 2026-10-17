const crypto = require('crypto');
const COOKIE = 'admin_token';

function sign(payload, secret) {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = crypto.createHmac('sha256', secret).update(body).digest('base64url');
  return body + '.' + sig;
}

function verify(token, secret) {
  if (!token || typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 2) return null;
  const [body, sig] = parts;
  const expected = crypto.createHmac('sha256', secret).update(body).digest('base64url');
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    return JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  } catch (e) {
    return null;
  }
}

function safeEqual(a, b) {
  const A = Buffer.from(String(a));
  const B = Buffer.from(String(b));
  if (A.length !== B.length) return false;
  return crypto.timingSafeEqual(A, B);
}

// 登录密钥只存单向指纹：config.json 即使泄露也拿不到明文，且不存在“解密算法放哪”的问题
const SCRYPT = { N: 16384, r: 8, p: 1 };
const KEYLEN = 64;

function hashKey(plain) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(String(plain), salt, KEYLEN, SCRYPT);
  return { algo: 'scrypt', salt: salt.toString('hex'), hash: hash.toString('hex') };
}

// stored 兼容两种形态：旧的明文 string（历史配置），新的 scrypt 指纹对象
function verifyKey(plain, stored) {
  if (plain == null || plain === '') return false;
  if (typeof stored === 'string') return safeEqual(plain, stored);
  if (!stored || stored.algo !== 'scrypt' || !stored.salt || !stored.hash) return false;
  let derived;
  try {
    derived = crypto.scryptSync(String(plain), Buffer.from(stored.salt, 'hex'), KEYLEN, SCRYPT);
  } catch (e) {
    return false;
  }
  const a = Buffer.from(derived.toString('hex'));
  const b = Buffer.from(String(stored.hash));
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

// 从 cookie 或 Authorization: Bearer 提取 token
// WebSocket upgrade 请求不经过 cookie-parser，故额外手动解析 Cookie 头兜底
function extract(req) {
  if (req.cookies && req.cookies[COOKIE]) return req.cookies[COOKIE];
  const h = req.headers.authorization;
  if (h && h.startsWith('Bearer ')) return h.slice(7);
  const raw = req.headers.cookie;
  if (raw) {
    const m = raw.match(new RegExp('(?:^|;\\s*)' + COOKIE + '=([^;]*)'));
    if (m) {
      try { return decodeURIComponent(m[1]); } catch (e) { return m[1]; }
    }
  }
  return null;
}

// token 签名有效还不够：payload.sid 必须能在会话登记里查到，踢下线才真正生效
function makeRequireAuth(config, sessions) {
  return function requireAuth(req, res, next) {
    const payload = verify(extract(req), config.sessionSecret);
    if (!payload || !sessions.valid(payload.sid)) {
      return res.status(401).json({ error: 'unauthorized' });
    }
    req.user = payload;
    sessions.touch(payload.sid);
    next();
  };
}

module.exports = { sign, verify, safeEqual, hashKey, verifyKey, extract, COOKIE, makeRequireAuth };
