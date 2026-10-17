const express = require('express');
const proc = require('../lib/proc');

function makeRouter(config, requireAuth) {
  const router = express.Router();

  router.get('/', requireAuth, async (req, res) => {
    try {
      const list = await proc.listProcesses();
      res.json({ list });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  router.post('/kill', requireAuth, (req, res) => {
    try {
      const signal = proc.killProcess(req.body.pid, req.body.signal);
      res.json({ ok: true, signal });
    } catch (e) {
      res.status(400).json({ error: e.message });
    }
  });

  return router;
}

module.exports = { makeRouter };
