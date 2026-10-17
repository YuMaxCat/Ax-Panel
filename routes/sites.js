const express = require('express');
const nginx = require('../lib/nginx');
const uptime = require('../lib/uptime');

function makeRouter(config, requireAuth) {
  const router = express.Router();

  // 扫描所有 vhost，返回站点列表（附带探活忽略状态）
  router.get('/', requireAuth, (req, res) => {
    try {
      const sites = nginx.listSites(config).map((s) =>
        Object.assign({}, s, { uptimeIgnored: uptime.isIgnored(s.domain) }));
      res.json({ sites });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // 接管站点（首次注入 include）
  router.post('/takeover', requireAuth, (req, res) => {
    try {
      const domain = String(req.body.domain || '');
      res.json(nginx.takeover(config, domain));
    } catch (e) {
      res.status(400).json({ error: e.message });
    }
  });

  // 禁止 / 恢复访问
  router.post('/maintenance', requireAuth, (req, res) => {
    try {
      const domain = String(req.body.domain || '');
      const blocked = !!req.body.blocked;
      res.json(nginx.setMaintenance(config, domain, blocked));
    } catch (e) {
      res.status(400).json({ error: e.message });
    }
  });

  // 探活忽略开关：故意停用的站点不再产生「站点无法访问」告警
  router.post('/uptime-ignore', requireAuth, (req, res) => {
    try {
      const domain = String(req.body.domain || '');
      // 只允许登记真实存在的站点，避免名单里堆积无效项
      if (!nginx.listSites(config).some((s) => s.domain === domain)) {
        throw new Error('未找到站点：' + domain);
      }
      res.json({ ok: true, ignore: uptime.setIgnore(domain, !!req.body.ignored) });
    } catch (e) {
      res.status(400).json({ error: e.message });
    }
  });

  return router;
}

module.exports = { makeRouter };
