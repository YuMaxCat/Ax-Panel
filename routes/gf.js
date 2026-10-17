const express = require('express');
const http = require('http');

// 虚拟女友「虚拟女友」（gf-bot）的管理页。跟 axbot 一个路子：这里只是薄壳，
// 鉴权 + 转发，数据全来自 gf-bot 自己的管理口（127.0.0.1 的 /admin/*）。
//
// 为什么不直接读它的 data/gf.db：心情、away 状态这些在它进程的内存和 kv 里，
// 磁盘上不一定是最新的；而且清记忆、改参数这些动作本来就得让它自己执行。
//
// ⚠️ 管理口只监听回环，靠 x-gf-admin 认人（跟 dsapi 的 9909 一个道理）。
// ⚠️ server.js 全局挂了 express.json()，body 已经被吃掉了 —— 转发时要自己
//    重新序列化，不能再 req.pipe(up)（那样转过去是空的）。
const TIMEOUT_MS = 20000;

function makeRouter(config, requireAuth) {
  const router = express.Router();
  const cfg = config.gf || {};

  router.use(requireAuth);

  router.use((req, res) => {
    if (!cfg.enabled) return res.status(503).json({ error: '虚拟女友模块已关闭' });
    if (!cfg.url || !cfg.adminToken) {
      return res.status(503).json({ error: '虚拟女友模块未配置（缺 url 或 adminToken）' });
    }

    let base;
    try { base = new URL(cfg.url); }
    catch { return res.status(503).json({ error: 'gf.url 不是合法地址' }); }

    const body = req.body && Object.keys(req.body).length
      ? Buffer.from(JSON.stringify(req.body), 'utf8')
      : null;

    const headers = {
      host: base.host,
      'x-gf-admin': cfg.adminToken,
      accept: '*/*',
    };
    if (body) {
      headers['content-type'] = 'application/json';
      headers['content-length'] = body.length;
    }

    const up = http.request({
      hostname: base.hostname,
      port: base.port || 80,
      // 挂载点之后的部分前面要补上 /admin —— gf-bot 那边所有管理接口都在 /admin/* 下
      // （axbot 那个不用补，是因为 group-guard 的管理口本身就挂在根上）
      path: '/admin' + req.url,
      method: req.method,
      headers,
    }, (r) => {
      res.writeHead(r.statusCode, {
        'content-type': r.headers['content-type'] || 'application/json; charset=utf-8',
        // 状态和记忆都是活的，一律不缓存
        'cache-control': 'no-store',
      });
      r.pipe(res);
    });

    up.setTimeout(TIMEOUT_MS, () => up.destroy(new Error('gf-bot 管理口响应超时')));
    up.on('error', (e) => {
      if (res.headersSent) return res.end();
      res.status(502).json({ error: 'gf-bot 不可达：' + e.message });
    });

    up.end(body || undefined);
  });

  return router;
}

module.exports = { makeRouter };
