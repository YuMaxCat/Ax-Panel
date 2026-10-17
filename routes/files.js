const fs = require('fs');
const path = require('path');
const express = require('express');
const multer = require('multer');
const paths = require('../lib/paths');

// 在线编辑的文本大小上限，超过就让用户下载后编辑
const MAX_EDIT = 1024 * 1024;

function makeRouter(config, requireAuth) {
  const router = express.Router();
  const roots = config.fileRoots;

  const upload = multer({
    storage: multer.diskStorage({
      destination: (req, file, cb) => {
        try {
          const dir = paths.resolveSafe(req.query.path || roots[0], roots);
          if (!fs.statSync(dir).isDirectory()) throw new Error('目标不是目录');
          cb(null, dir);
        } catch (e) {
          cb(e);
        }
      },
      filename: (req, file, cb) => cb(null, path.basename(file.originalname))
    }),
    limits: { fileSize: 2 * 1024 * 1024 * 1024 } // 单文件 2GB
  });

  // 允许访问的根目录（供前端做初始导航）
  router.get('/roots', requireAuth, (req, res) => {
    res.json({ roots });
  });

  // 目录列表
  router.get('/list', requireAuth, (req, res) => {
    try {
      const abs = paths.resolveSafe(req.query.path || roots[0], roots);
      if (!fs.statSync(abs).isDirectory()) throw new Error('不是目录');
      const entries = [];
      for (const name of fs.readdirSync(abs)) {
        const full = path.join(abs, name);
        let s;
        try { s = fs.lstatSync(full); } catch (e) { continue; }
        let dir = s.isDirectory();
        const isLink = s.isSymbolicLink();
        if (isLink) {
          try { dir = fs.statSync(full).isDirectory(); } catch (e) { /* 断链保持 false */ }
        }
        entries.push({
          name,
          path: full,
          dir,
          link: isLink,
          size: dir ? 0 : s.size,
          mtime: s.mtimeMs
        });
      }
      entries.sort((a, b) => (b.dir - a.dir) || a.name.localeCompare(b.name));
      res.json({ path: abs, entries });
    } catch (e) {
      res.status(400).json({ error: e.message });
    }
  });

  // 新建文件夹
  router.post('/mkdir', requireAuth, (req, res) => {
    try {
      const base = paths.resolveSafe(req.body.path, roots);
      const name = sanitizeName(req.body.name);
      const target = path.join(base, name);
      paths.resolveSafe(target, roots);
      fs.mkdirSync(target);
      res.json({ ok: true, path: target });
    } catch (e) {
      res.status(400).json({ error: e.message });
    }
  });

  // 新建空文件
  router.post('/touch', requireAuth, (req, res) => {
    try {
      const base = paths.resolveSafe(req.body.path, roots);
      const name = sanitizeName(req.body.name);
      const target = path.join(base, name);
      paths.resolveSafe(target, roots);
      fs.closeSync(fs.openSync(target, 'wx'));
      res.json({ ok: true, path: target });
    } catch (e) {
      res.status(400).json({ error: e.message });
    }
  });

  // 重命名
  router.post('/rename', requireAuth, (req, res) => {
    try {
      const abs = paths.resolveSafe(req.body.path, roots);
      const name = sanitizeName(req.body.name);
      const target = path.join(path.dirname(abs), name);
      paths.resolveSafe(target, roots);
      fs.renameSync(abs, target);
      res.json({ ok: true, path: target });
    } catch (e) {
      res.status(400).json({ error: e.message });
    }
  });

  // 删除（文件或目录）
  router.post('/delete', requireAuth, (req, res) => {
    try {
      const abs = paths.resolveSafe(req.body.path, roots);
      if (roots.includes(abs)) throw new Error('不能删除根目录');
      fs.rmSync(abs, { recursive: true, force: true });
      res.json({ ok: true });
    } catch (e) {
      res.status(400).json({ error: e.message });
    }
  });

  // 上传（multipart，字段名 file，目标目录走 URL 的 ?path=）
  router.post('/upload', requireAuth, (req, res) => {
    upload.single('file')(req, res, (err) => {
      if (err) return res.status(400).json({ error: err.message });
      if (!req.file) return res.status(400).json({ error: '未收到文件' });
      res.json({ ok: true, name: req.file.filename, size: req.file.size });
    });
  });

  // 下载
  router.get('/download', requireAuth, (req, res) => {
    try {
      const abs = paths.resolveSafe(req.query.path, roots);
      if (fs.statSync(abs).isDirectory()) throw new Error('不能下载目录');
      res.download(abs);
    } catch (e) {
      res.status(400).json({ error: e.message });
    }
  });

  // 读取文本内容（在线编辑用）
  router.get('/read', requireAuth, (req, res) => {
    try {
      const abs = paths.resolveSafe(req.query.path, roots);
      const st = fs.statSync(abs);
      if (st.isDirectory()) throw new Error('不能编辑目录');
      if (!st.isFile()) throw new Error('只能编辑普通文件');
      if (st.size > MAX_EDIT) throw new Error('文件超过 ' + fmtSize(MAX_EDIT) + '，请下载后编辑');
      const buf = fs.readFileSync(abs);
      // 含 NUL 的一律当二进制：图片/压缩包/可执行文件在 textarea 里只会显示成一堆乱码
      if (buf.includes(0)) throw new Error('这是二进制文件，无法在线编辑');
      res.json({ path: abs, name: path.basename(abs), size: buf.length, content: buf.toString('utf8') });
    } catch (e) {
      res.status(400).json({ error: e.message });
    }
  });

  // 保存文本内容
  router.post('/write', requireAuth, (req, res) => {
    let tmp = null;
    try {
      const abs = paths.resolveSafe(req.body && req.body.path, roots);
      const content = req.body && req.body.content;
      if (typeof content !== 'string') throw new Error('内容格式不正确');
      if (Buffer.byteLength(content, 'utf8') > MAX_EDIT) throw new Error('内容超过 ' + fmtSize(MAX_EDIT));

      const st = fs.statSync(abs); // 文件不存在会抛，等同拒绝新建（新建走 /touch）
      if (!st.isFile()) throw new Error('只能保存普通文件');

      // 先写同目录临时文件再 rename：中途失败也不会把原文件截成半截
      tmp = path.join(path.dirname(abs), '.' + path.basename(abs) + '.tmp' + process.pid);
      fs.writeFileSync(tmp, content);
      fs.chmodSync(tmp, st.mode);
      try { fs.chownSync(tmp, st.uid, st.gid); } catch (e) { /* 非 root 跑时忽略 */ }
      fs.renameSync(tmp, abs);
      tmp = null; // 已改名，无需清理
      res.json({ ok: true, size: fs.statSync(abs).size });
    } catch (e) {
      if (tmp) { try { fs.unlinkSync(tmp); } catch (e2) { /* 没写成就算了 */ } }
      res.status(400).json({ error: e.message });
    }
  });

  return router;
}

function fmtSize(n) {
  return n >= 1048576 ? (n / 1048576) + 'MB' : Math.round(n / 1024) + 'KB';
}

// 名称校验：禁止路径分隔符与 .. 等
function sanitizeName(name) {
  const s = String(name == null ? '' : name).trim();
  if (!s) throw new Error('名称不能为空');
  if (s === '.' || s === '..' || s.includes('/') || s.includes('\\') || s.includes('\0')) {
    throw new Error('名称含非法字符');
  }
  return s;
}

module.exports = { makeRouter };
