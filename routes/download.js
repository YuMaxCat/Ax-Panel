const express = require('express');
const fs = require('fs');
const path = require('path');
const paths = require('../lib/paths');
const aria2 = require('../lib/aria2');

// 单文件并发连接上限，与 /etc/aria2/aria2.conf 的 max-connection-per-server 对齐
const MAX_CONN = 16;
// 一次最多列多少个任务（含历史）
const LIST_LIMIT = 80;
const NAME_MAX = 200;

function makeRouter(config, requireAuth) {
  const router = express.Router();
  const roots = config.fileRoots;
  const cfg = config.download || {};
  const client = aria2.createClient(cfg);

  // 功能开关关闭时，所有接口统一 503
  function off(res) {
    if (cfg.enabled) return false;
    res.status(503).json({ error: '下载功能已关闭' });
    return true;
  }

  // aria2 连不上 / 调用失败一律 502，前端据此提示「服务未运行」
  function boom(res, e) {
    res.status(502).json({ error: e.message });
  }

  // ---------- 功能状态（前端初始化用） ----------
  router.get('/state', requireAuth, async (req, res) => {
    if (off(res)) return;
    const out = {
      enabled: true,
      available: false,
      version: '',
      dir: cfg.dir || '',
      connections: cfg.connections || MAX_CONN,
      maxConnections: MAX_CONN,
      roots: roots
    };
    try {
      out.version = await client.version();
      out.available = true;
    } catch (e) {
      out.error = e.message;
    }
    res.json(out);
  });

  // ---------- 任务列表 ----------
  router.get('/list', requireAuth, async (req, res) => {
    if (off(res)) return;
    try {
      const [active, waiting, stopped] = await Promise.all([
        client.tellActive(),
        client.tellWaiting(LIST_LIMIT),
        client.tellStopped(LIST_LIMIT)
      ]);
      // tellStopped 按停止时间**由早到晚**返回，倒过来让最新完成的排在最前面
      const tasks = active.concat(waiting, stopped.reverse()).map(aria2.shape);
      let speed = 0;
      for (const t of tasks) { if (t.status === 'active') speed += t.speed; }
      res.json({ tasks: tasks, speed: speed, active: active.length, waiting: waiting.length });
    } catch (e) {
      boom(res, e);
    }
  });

  // ---------- 新建任务 ----------
  router.post('/add', requireAuth, async (req, res) => {
    if (off(res)) return;
    try {
      const url = parseUrl(req.body && req.body.url);
      const dir = resolveDir(req.body && req.body.dir, roots, cfg.dir);
      const name = parseName(req.body && req.body.name);
      const conn = parseConn(req.body && req.body.connections, cfg.connections);

      const opts = {
        dir: dir,
        'max-connection-per-server': String(conn),
        split: String(conn),
        'min-split-size': '1M'
      };
      if (name) opts.out = name;

      const gid = await client.addUri([url], opts);
      res.json({ ok: true, gid: gid, dir: dir, name: name || '' });
    } catch (e) {
      res.status(400).json({ error: e.message });
    }
  });

  // ---------- 暂停 / 继续 ----------
  // gid 校验（400）与 aria2 调用失败（502）要分开：两者都在同一个 catch 里会都报成 502
  function toggle(method) {
    return async (req, res) => {
      if (off(res)) return;
      let g;
      try { g = gid(req.body); } catch (e) { return res.status(400).json({ error: e.message }); }
      try {
        await client[method](g);
        res.json({ ok: true });
      } catch (e) {
        boom(res, e);
      }
    };
  }

  router.post('/pause', requireAuth, toggle('pause'));
  router.post('/resume', requireAuth, toggle('unpause'));

  // ---------- 移除任务（del=true 时连下载的文件与控制文件一起删） ----------
  router.post('/remove', requireAuth, async (req, res) => {
    if (off(res)) return;
    let g;
    try { g = gid(req.body); } catch (e) { return res.status(400).json({ error: e.message }); }
    // 先取文件列表，删掉任务后就查不到了
    const targets = req.body && req.body.del ? await collectFiles(g) : [];

    try { await client.forceRemove(g); } catch (e) { /* 已停止的任务会报错，忽略 */ }
    try { await client.removeResult(g); } catch (e) { /* 不在结果列表里也忽略 */ }

    let deleted = 0;
    for (const p of targets) {
      // 双保险：只删白名单目录内的文件
      try {
        const abs = paths.resolveSafe(p, roots);
        fs.rmSync(abs, { force: true });
        fs.rmSync(abs + '.aria2', { force: true });
        deleted++;
      } catch (e) { /* 越界或已不存在，跳过 */ }
    }
    res.json({ ok: true, deleted: deleted });
  });

  // ---------- 清除已完成 / 出错的历史记录（不动文件） ----------
  router.post('/purge', requireAuth, async (req, res) => {
    if (off(res)) return;
    try {
      const n = await client.purge();
      res.json({ ok: true, purged: n });
    } catch (e) {
      boom(res, e);
    }
  });

  async function collectFiles(g) {
    try {
      const st = await client.tellStatus(g);
      return ((st && st.files) || []).map((f) => f.path).filter(Boolean);
    } catch (e) {
      return [];
    }
  }

  return router;
}

// ---------- 入参校验 ----------

function gid(body) {
  const g = body && body.gid;
  if (typeof g !== 'string' || !/^[0-9a-fA-F]{4,64}$/.test(g)) throw new Error('任务标识不合法');
  return g;
}

// 只放行 http/https：file:// 会让服务器把本地文件当下载源交出来
function parseUrl(raw) {
  const s = String(raw == null ? '' : raw).trim();
  if (!s) throw new Error('请填写下载链接');
  if (s.length > 4096) throw new Error('链接过长');
  let u;
  try { u = new URL(s); } catch (e) { throw new Error('链接格式不正确'); }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    throw new Error('只支持 http / https 链接');
  }
  if (!u.hostname) throw new Error('链接缺少主机名');
  return u.href;
}

// 保存目录：必须落在白名单内、且已经存在
function resolveDir(raw, roots, fallback) {
  const s = String(raw == null || raw === '' ? (fallback || roots[0]) : raw).trim();
  const abs = paths.resolveSafe(s, roots);
  let st;
  try { st = fs.statSync(abs); } catch (e) { throw new Error('保存目录不存在：' + abs); }
  if (!st.isDirectory()) throw new Error('保存位置不是目录');
  return abs;
}

// 文件名：留空交给 aria2 从 URL / Content-Disposition 推断
function parseName(raw) {
  const s = String(raw == null ? '' : raw).trim();
  if (!s) return '';
  if (s.length > NAME_MAX) throw new Error('文件名过长');
  if (s === '.' || s === '..' || s.includes('/') || s.includes('\\') || s.includes('\0')) {
    throw new Error('文件名含非法字符');
  }
  if (s.endsWith('.aria2')) throw new Error('文件名不能以 .aria2 结尾');
  return s;
}

function parseConn(raw, fallback) {
  const n = parseInt(raw, 10);
  const base = Number.isFinite(n) ? n : (parseInt(fallback, 10) || MAX_CONN);
  return Math.max(1, Math.min(MAX_CONN, base));
}

module.exports = { makeRouter };
