const express = require('express');
const cc = require('../lib/cc');
const { clientIp } = require('../lib/net');

/**
 * 按 IP 计数的分钟级限速。三个公开端点的阈值不同，所以做成工厂。
 * 和 routes/license.js 里那段是同一个思路，只是那里写死了一份。
 */
function makeLimiter(perMin) {
  const hits = {};
  return function allow(ip) {
    const now = Date.now();
    const a = hits[ip] || { count: 0, resetAt: now + 60000 };
    if (now > a.resetAt) { a.count = 0; a.resetAt = now + 60000; }
    if (a.count >= perMin) return false;
    a.count++;
    hits[ip] = a;

    // 键来自外部 IP，量大时清掉过期项，避免无限增长
    const keys = Object.keys(hits);
    if (keys.length > 500) {
      for (const k of keys) { if (now > hits[k].resetAt) delete hits[k]; }
    }
    return true;
  };
}

// 两个公开端点都只在装机时用。一次安装 = 1 次 /install + 7 次 /step，
// 客户重试几次很常见，所以 /step 的阈值放宽一些
const allowScript = makeLimiter(30);
const allowStep = makeLimiter(120);

function makeRouter(config, requireAuth) {
  const router = express.Router();

  // 脚本端点的错误回纯文本 —— 消费方是 shell 脚本，JSON 还得再解析一层
  function scriptError(res, status, msg) {
    res.status(status).type('text/plain; charset=utf-8').send(msg + '\n');
  }

  function ccReady(res) {
    if (!config.cc || !config.cc.enabled) {
      scriptError(res, 503, '部署服务当前未开放，请稍后再试。');
      return false;
    }
    return true;
  }

  function host() {
    return String(config.cc.host || '').replace(/\/+$/, '');
  }

  // ---------- 公开：引导段 ----------
  // 只做一次「这张卡现在能不能用」的预检（不带 did，所以不涉及设备绑定），
  // 这样卡密写错时立刻就能看到原因，不用等脚本跑起来。
  //
  // ⚠ 这里**不能**因为卡已绑定就拒绝：这是客户唯一那条命令的入口，而 did 要到脚本
  //   跑起来才算得出来。装机装到一半断网、塞满磁盘、Termux 被切掉，客户重跑同一条
  //   命令是常态 —— 在这里拦掉，同一台手机也永远装不回来。设备是否匹配交给 /step 判，
  //   那里拿得到 did。
  router.get('/install', (req, res) => {
    if (!ccReady(res)) return;
    if (!allowScript(clientIp(req))) return scriptError(res, 429, '请求过于频繁，请稍后再试。');

    const key = String(req.query.key || '');
    const r = cc.verify(key, '');
    if (!r.ok) return scriptError(res, 403, r.msg);

    res.type('text/plain; charset=utf-8').send(cc.runnerScript(r.rec, host(), req.query.os));
  });

  // ---------- 公开：安装步骤 ----------
  // 安装逻辑全在这里，一次给一步。每一步都重新校验卡密 + 设备：
  // 卡被停用、到期、或者换了台手机，下一句话都拿不到。
  //
  // 客户端拿到的是 bash 片段，用 `. <(...)` source 到同一个 shell 里执行，
  // 不落盘 —— 客户机上不会留下「一份可以删掉锁再转发」的完整脚本。
  router.get('/step', (req, res) => {
    if (!ccReady(res)) return;
    if (!allowStep(clientIp(req))) return scriptError(res, 429, '请求过于频繁，请稍后再试。');

    const did = String(req.query.did || '').trim();
    if (!/^[0-9a-f]{32}$/.test(did)) return scriptError(res, 400, '设备标识无效，请重新执行安装命令。');

    const i = Number(req.query.i);
    if (!Number.isInteger(i) || i < 1) return scriptError(res, 400, '步骤序号无效。');

    const r = cc.authorize(String(req.query.key || ''), did, String(req.query.label || ''));
    if (!r.ok) return scriptError(res, 403, r.msg);

    // os 只决定「下发哪一套步骤」，不参与授权判定 —— 换设备认的是 did，跟平台无关
    const os = cc.platformOf(req.query.os);
    const body = cc.stepScript(i, r.rec, did, config.cc.salt, os);
    // 越界 = 没有下一步了。客户端不用预先知道总步数，看到这个标记就收工
    if (body === null) {
      return res.type('text/plain; charset=utf-8').send(cc.doneMarker(os) + '\n');
    }

    cc.touch(r.rec.key, i === 1); // 第一步算一次装机
    // 开头多捎一行总步数，客户端的进度条才画得出来。缺了也不影响安装 ——
    // 它拿不到数就退回 [3] 这种朴素写法
    res.type('text/plain; charset=utf-8')
       .send(cc.stepTotalMarker(os, cc.stepCount(os)) + '\n' + body);
  });

  // ---------- 以下管理操作都要登录 ----------
  router.get('/', requireAuth, (req, res) => {
    res.json({ keys: cc.list(), host: host() });
  });

  router.post('/create', requireAuth, (req, res) => {
    try {
      res.json({ ok: true, item: cc.create(req.body || {}) });
    } catch (e) {
      res.status(400).json({ error: e.message });
    }
  });

  router.post('/update', requireAuth, (req, res) => {
    try {
      const body = req.body || {};
      const patch = {};
      for (const f of ['note', 'baseUrl', 'model', 'smallModel', 'expire', 'enabled']) {
        if (body[f] !== undefined) patch[f] = body[f];
      }
      res.json({ ok: true, item: cc.update(String(body.key || ''), patch) });
    } catch (e) {
      res.status(400).json({ error: e.message });
    }
  });

  router.post('/unbind', requireAuth, (req, res) => {
    try {
      res.json({ ok: true, item: cc.unbind(String((req.body || {}).key || '')) });
    } catch (e) {
      res.status(400).json({ error: e.message });
    }
  });

  router.post('/remove', requireAuth, (req, res) => {
    try {
      res.json(cc.remove(String((req.body || {}).key || '')));
    } catch (e) {
      res.status(400).json({ error: e.message });
    }
  });

  return router;
}

module.exports = { makeRouter };
