const express = require('express');
const crypto = require('crypto');
const monitor = require('../lib/monitor');

// 无 since 时只回这段时间内产生的通知：App 首次接入不会把历史通知一股脑全弹出来。
// 之后 App 带上 since（它见过的最后一条 id）走增量，不再受此窗口限制。
const BASELINE_MS = 180 * 1000;
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

function safeEqual(a, b) {
  const A = Buffer.from(String(a));
  const B = Buffer.from(String(b));
  if (A.length !== B.length) return false;
  return crypto.timingSafeEqual(A, B);
}

// 仅供「通知 App」App 轮询拉取，不走登录会话，改用 config.push.token 共享密钥
function makeRouter(config) {
  const router = express.Router();

  function authorized(req) {
    const push = config.push || {};
    if (!push.token) return { ok: false, code: 503, error: '未配置 push.token' };
    const token = req.get('x-token') || req.query.token || '';
    if (!safeEqual(token, push.token)) return { ok: false, code: 401, error: 'unauthorized' };
    return { ok: true };
  }

  router.get('/poll', (req, res) => {
    const a = authorized(req);
    if (!a.ok) return res.status(a.code).json({ error: a.error });

    const limit = Math.min(MAX_LIMIT, Math.max(1, parseInt(req.query.limit, 10) || DEFAULT_LIMIT));
    const since = String(req.query.since || '');
    const all = monitor.getNotifications(MAX_LIMIT); // 已按 新 → 旧 排序

    let list;
    if (since) {
      const idx = all.findIndex((n) => n.id === since);
      // 找不到说明已被裁剪，退回最近一批，App 侧按 id 去重兜底
      list = idx >= 0 ? all.slice(0, idx) : all.slice(0, limit);
    } else {
      const floor = Date.now() - BASELINE_MS;
      list = all.filter((n) => n.ts >= floor);
    }
    list = list.slice(0, limit);

    res.json({
      ok: true,
      cursor: all.length ? all[0].id : '',
      notifications: list.map((n) => ({
        id: n.id,
        title: n.title,
        body: n.message,
        level: n.level,
        time: Math.floor(n.ts / 1000)
      }))
    });
  });

  // 手动造一条通知，用来验证「面板 → App」这条链路
  router.post('/test', (req, res) => {
    const a = authorized(req);
    if (!a.ok) return res.status(a.code).json({ error: a.error });

    const b = req.body || {};
    const level = ['info', 'warning', 'critical'].indexOf(b.level) >= 0 ? b.level : 'info';
    const n = monitor.pushNotification(
      level,
      b.title || '测试通知',
      b.body || '来自 Ax 面板的测试通知'
    );
    if (!n) return res.json({ ok: false, error: '被去重规则拦下（同一级别+标题 5 分钟内只发一次）' });
    res.json({ ok: true, id: n.id });
  });

  return router;
}

module.exports = { makeRouter };
