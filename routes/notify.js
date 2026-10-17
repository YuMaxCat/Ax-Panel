const express = require('express');
const monitor = require('../lib/monitor');

function makeRouter(config, requireAuth) {
  const router = express.Router();

  router.get('/', requireAuth, (req, res) => {
    const limit = Math.min(200, Math.max(1, parseInt(req.query.limit, 10) || 100));
    res.json({ notifications: monitor.getNotifications(limit) });
  });

  router.post('/read', requireAuth, (req, res) => {
    if (req.body.all) monitor.markAllRead();
    else monitor.markRead(String(req.body.id || ''));
    res.json({ ok: true });
  });

  router.post('/clear', requireAuth, (req, res) => {
    monitor.clearNotifications();
    res.json({ ok: true });
  });

  return router;
}

module.exports = { makeRouter };
