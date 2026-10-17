const express = require('express');
const weblog = require('../lib/weblog');

// 访问统计：数据全部来自 lib/weblog.js 对 nginx access.log 的离线聚合，
// 这里只做查询与参数白名单，不碰日志文件本身。
function makeRouter(config, requireAuth) {
  const router = express.Router();
  const cfg = config.weblog || {};
  const RANGES = ['today', '7d', '30d'];

  // 功能开关关闭时，所有接口统一 503
  function off(res) {
    if (cfg.enabled) return false;
    res.status(503).json({ error: '访问统计已关闭' });
    return true;
  }

  router.get('/stats', requireAuth, (req, res) => {
    if (off(res)) return;
    const range = RANGES.indexOf(req.query.range) >= 0 ? req.query.range : '7d';
    try {
      res.json(weblog.getStats(range));
    } catch (e) {
      res.status(500).json({ error: '统计数据读取失败：' + e.message });
    }
  });

  router.get('/live', requireAuth, (req, res) => {
    if (off(res)) return;
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 50, 1), 500);
    res.json({ data: weblog.getLive(limit) });
  });

  router.get('/usage', requireAuth, (req, res) => {
    if (off(res)) return;
    // 只接受 YYYY-MM，其余一律回落到当月，避免拿任意字符串去 startsWith 匹配
    const month = /^\d{4}-\d{2}$/.test(String(req.query.month || '')) ? req.query.month : '';
    try {
      res.json(weblog.getUsage(month));
    } catch (e) {
      res.status(500).json({ error: '流量数据读取失败：' + e.message });
    }
  });

  return router;
}

module.exports = { makeRouter };
