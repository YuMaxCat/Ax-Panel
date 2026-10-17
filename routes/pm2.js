const express = require('express');
const pm2 = require('../lib/pm2');

function makeRouter(config, requireAuth) {
  const router = express.Router();

  router.get('/', requireAuth, async (req, res) => {
    try {
      res.json({ apps: await pm2.list() });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  router.post('/action', requireAuth, async (req, res) => {
    const name = String(req.body.name || '');
    const act = String(req.body.act || '');
    try {
      if (name === 'admin' && act === 'restart') {
        // 重启面板会把这次 HTTP 响应一起掐断，所以先回包、再延迟执行
        res.json({ ok: true, pending: true });
        setTimeout(() => {
          pm2.action(name, act).catch((e) => console.warn('[pm2] 重启面板失败：' + e.message));
        }, 800);
        return;
      }
      await pm2.action(name, act);
      res.json({ ok: true });
    } catch (e) {
      res.status(400).json({ error: e.message });
    }
  });

  router.post('/ignore', requireAuth, async (req, res) => {
    try {
      const name = String(req.body.name || '');
      const apps = await pm2.list();
      // 只允许登记真实存在的进程，避免名单里堆积无效项
      if (!apps.some((a) => a.name === name)) throw new Error('未找到 pm2 进程：' + name);
      res.json({ ok: true, ignore: pm2.setIgnore(name, !!req.body.ignored) });
    } catch (e) {
      res.status(400).json({ error: e.message });
    }
  });

  return router;
}

module.exports = { makeRouter };
