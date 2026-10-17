const fs = require('fs');
const path = require('path');
const express = require('express');
const { execFile } = require('child_process');

function listDir(dir, label) {
  const out = [];
  if (!dir || !fs.existsSync(dir)) return out;
  let entries;
  try { entries = fs.readdirSync(dir); } catch (e) { return out; }
  for (const name of entries) {
    if (!name.endsWith('.log')) continue;
    const full = path.join(dir, name);
    try {
      const st = fs.statSync(full);
      if (!st.isFile()) continue;
      out.push({ name, group: label, path: full, size: st.size, mtime: st.mtimeMs });
    } catch (e) { /* ignore */ }
  }
  out.sort((a, b) => b.mtime - a.mtime);
  return out;
}

// 只允许读取日志白名单目录内的文件
function resolveLogFile(config, file) {
  const abs = path.resolve(String(file || ''));
  const dirs = [config.pm2LogDir, config.wwwLogDir].filter(Boolean).map((d) => path.resolve(d));
  const ok = dirs.some((d) => abs.startsWith(d + path.sep));
  if (!ok) throw new Error('不允许读取该文件');
  return abs;
}

// 读取文件末尾 N 行（只读最后 512KB，避免大文件全量加载）
function tailFile(file, lines) {
  const st = fs.statSync(file);
  const maxBytes = 512 * 1024;
  const start = Math.max(0, st.size - maxBytes);
  const len = st.size - start;
  const buf = Buffer.alloc(len);
  const fd = fs.openSync(file, 'r');
  try {
    fs.readSync(fd, buf, 0, len, start);
  } finally {
    fs.closeSync(fd);
  }
  let text = buf.toString('utf8');
  if (start > 0) {
    // 丢掉可能被截断的首行
    const nl = text.indexOf('\n');
    if (nl >= 0) text = text.slice(nl + 1);
  }
  const arr = text.split('\n');
  if (arr.length > lines) arr.splice(0, arr.length - lines);
  return arr.join('\n');
}

function makeRouter(config, requireAuth) {
  const router = express.Router();

  router.get('/', requireAuth, (req, res) => {
    const files = [
      ...listDir(config.pm2LogDir, 'pm2'),
      ...listDir(config.wwwLogDir, 'nginx')
    ];
    res.json({ files });
  });

  router.get('/tail', requireAuth, (req, res) => {
    try {
      const file = resolveLogFile(config, req.query.file);
      const lines = Math.min(2000, Math.max(10, parseInt(req.query.lines, 10) || 200));
      if (!fs.existsSync(file)) return res.status(404).json({ error: '文件不存在' });
      res.json({ content: tailFile(file, lines) });
    } catch (e) {
      res.status(400).json({ error: e.message });
    }
  });

  // 清空日志（pm2 flush + 截断选中的文件）
  router.post('/flush', requireAuth, (req, res) => {
    try {
      if (req.body && req.body.file) {
        const file = resolveLogFile(config, req.body.file);
        if (fs.existsSync(file)) fs.truncateSync(file, 0);
        return res.json({ ok: true });
      }
      execFile('pm2', ['flush'], { timeout: 15000 }, (err) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ ok: true });
      });
    } catch (e) {
      res.status(400).json({ error: e.message });
    }
  });

  return router;
}

// tailFile / resolveLogFile 也给其它模块复用：读日志的目录白名单只有这一份，别抄第二遍
module.exports = { makeRouter, tailFile, resolveLogFile };
