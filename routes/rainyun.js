const express = require('express');
const rainyun = require('../lib/rainyun');

function makeRouter(config, requireAuth) {
  const router = express.Router();

  router.get('/', requireAuth, async (req, res) => {
    try {
      const data = await rainyun.snapshot(config.rainyun, req.query.refresh === '1');
      res.json(data);
    } catch (e) {
      res.status(502).json({ error: e.message });
    }
  });

  return router;
}

module.exports = { makeRouter };
