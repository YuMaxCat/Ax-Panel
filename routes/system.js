const express = require('express');
const monitor = require('../lib/monitor');

function makeRouter(config, requireAuth) {
  const router = express.Router();

  // 当前快照 + 历史曲线（WebSocket 未连上时的兜底）
  router.get('/', requireAuth, (req, res) => {
    res.json({ snapshot: monitor.getSnapshot(), history: monitor.getHistory() });
  });

  return router;
}

module.exports = { makeRouter };
