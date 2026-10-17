const crypto = require('crypto');
const express = require('express');

// 测速：按请求的大小吐一串随机数据流。
// 特意用随机而非全零 —— 中间层（CDN / 代理 / 浏览器）对全零数据可能做压缩或优化，
// 那样测出来的就不是真实带宽了。
const MAX_MB = 100;
const CHUNK = 64 * 1024;

function makeRouter(config, requireAuth) {
  const router = express.Router();
  const block = crypto.randomBytes(CHUNK);

  router.get('/', requireAuth, (req, res) => {
    const mb = Math.min(Math.max(parseFloat(req.query.mb) || 10, 1), MAX_MB);
    const total = Math.round(mb * 1048576);

    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Content-Length', total);
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Content-Disposition', 'inline; filename="speedtest.bin"');
    res.setHeader('X-Accel-Buffering', 'no');   // 别让 nginx 攒够再发，否则测的是缓冲不是网络

    let sent = 0;
    let closed = false;
    res.on('close', () => { closed = true; });

    (function pump() {
      while (sent < total) {
        if (closed) return;
        const size = Math.min(CHUNK, total - sent);
        const ok = res.write(size === CHUNK ? block : block.subarray(0, size));
        sent += size;
        if (!ok) { res.once('drain', pump); return; }
      }
      res.end();
    })();
  });

  return router;
}

module.exports = { makeRouter };
