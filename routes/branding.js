const express = require('express');
const branding = require('../lib/branding');

// Logo 不带鉴权：登录页（未登录）也要显示。
// 只可能吐出我们自己校验过的 PNG，且是固定路径，不构成目录遍历风险。
function makeRouter() {
  const router = express.Router();

  router.get('/logo', (req, res) => {
    if (!branding.exists()) return res.status(404).json({ error: '未设置自定义 Logo' });
    res.type('png');
    res.set('Cache-Control', 'public, max-age=300');
    res.sendFile(branding.FILE);
  });

  return router;
}

module.exports = { makeRouter };
