const express = require('express');
const license = require('../lib/license');
const { clientIp } = require('../lib/net');

// 公开验证端点的限速：同一 IP 每分钟 30 次。
// 密钥主体 8 位 base32（约 1.1e12 种），爆破本来就不现实，这里只是别让人白刷日志。
const VERIFY_PER_MIN = 30;
const verifyHits = {};

function allowVerify(ip) {
  const now = Date.now();
  const a = verifyHits[ip] || { count: 0, resetAt: now + 60000 };
  if (now > a.resetAt) { a.count = 0; a.resetAt = now + 60000; }
  if (a.count >= VERIFY_PER_MIN) return false;
  a.count++;
  verifyHits[ip] = a;

  const keys = Object.keys(verifyHits);
  if (keys.length > 500) {
    for (const k of keys) { if (now > verifyHits[k].resetAt) delete verifyHits[k]; }
  }
  return true;
}

function makeRouter(config, requireAuth) {
  const router = express.Router();

  // ---------- 公开：App 端校验 ----------
  // 不带 requireAuth —— 手机 App 没有面板会话，密钥本身就是凭据。
  router.get('/verify', (req, res) => {
    if (!allowVerify(clientIp(req))) {
      return res.status(429).json({ ok: false, msg: '请求过于频繁，稍后再试' });
    }
    res.json(license.verify(String(req.query.key || '')));
  });

  // ---------- 以下管理操作都要登录 ----------
  router.get('/', requireAuth, (req, res) => {
    res.json({ keys: license.list() });
  });

  router.post('/create', requireAuth, (req, res) => {
    try {
      res.json({ ok: true, item: license.create(req.body.note, req.body.expire) });
    } catch (e) {
      res.status(400).json({ error: e.message });
    }
  });

  router.post('/update', requireAuth, (req, res) => {
    try {
      const body = req.body || {};
      const patch = {};
      if (body.note !== undefined) patch.note = body.note;
      if (body.expire !== undefined) patch.expire = body.expire;
      if (body.enabled !== undefined) patch.enabled = body.enabled;
      res.json({ ok: true, item: license.update(String(body.key || ''), patch) });
    } catch (e) {
      res.status(400).json({ error: e.message });
    }
  });

  router.post('/remove', requireAuth, (req, res) => {
    try {
      res.json(license.remove(String((req.body || {}).key || '')));
    } catch (e) {
      res.status(400).json({ error: e.message });
    }
  });

  return router;
}

module.exports = { makeRouter };
