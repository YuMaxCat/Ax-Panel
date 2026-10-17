const express = require('express');
const decoy = require('../lib/decoy');
const authlog = require('../lib/authlog');
const intel = require('../lib/intel');

// 诱饵命中与溯源。全部要登录 —— 这份数据里有攻击者提交的凭据原文和自己面板的
// 登录失败史，是整个面板里最不该外泄的一类内容。

function makeRouter(config, requireAuth) {
  const router = express.Router();

  router.get('/', requireAuth, (req, res) => {
    res.json({
      enabled: !!(config.decoy && config.decoy.enabled),
      paths: (config.decoy && config.decoy.paths) || [],
      stats: decoy.stats(req.query.days)
    });
  });

  // 单个 IP 的完整画像。
  // auth 部分（登录失败史）是本地数据，一定要给；rDNS / RDAP 要出网查第三方，
  // 所以只在用户明确点「反查」时才跑 —— 不把每个撞上来的 IP 都主动送出去
  router.post('/lookup', requireAuth, async (req, res) => {
    const ip = String(req.body.ip || '').trim();
    if (!intel.valid(ip)) return res.status(400).json({ error: 'IP 格式不正确' });

    // intel 为 false 时只回本地数据。前端打开画像先用这一档（快、不出网），
    // 反查要用户自己点 —— 查询会让对方看到是这台服务器在查谁
    const out = {
      ip,
      intel: req.body.intel !== false,
      decoy: decoy.byIp(ip),
      auth: authlog.byIp(ip),
      rdns: '',
      rdap: null
    };
    if (!out.intel) return res.json(out);

    try {
      const r = await intel.lookup(ip, !!req.body.refresh);
      out.rdns = r.rdns;
      out.rdap = r.rdap;
      out.cached = r.cached;
    } catch (e) {
      // 反查失败不该让整个画像打不开，本地那部分照常回
      out.error = e.message;
    }
    res.json(out);
  });

  return router;
}

module.exports = { makeRouter };
