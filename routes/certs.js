const express = require('express');
const cert = require('../lib/cert');

function makeRouter(config, requireAuth) {
  const router = express.Router();

  // 所有配置了证书的站点及其到期状态
  router.get('/', requireAuth, (req, res) => {
    try {
      res.json({ certs: cert.listCerts(config) });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // 手动强制续签某站点对应的证书（acme.sh）
  router.post('/renew', requireAuth, (req, res) => {
    try {
      const domain = String(req.body.domain || '');
      res.json(Object.assign({ ok: true }, cert.renewCert(config, domain)));
    } catch (e) {
      res.status(400).json({ error: e.message });
    }
  });

  return router;
}

module.exports = { makeRouter };
