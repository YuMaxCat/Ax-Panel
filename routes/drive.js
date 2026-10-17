const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const express = require('express');
const multer = require('multer');
const archiver = require('archiver');
const driveDb = require('../lib/drive-db');

// 云盘：Nimbus 风格实现。
// 原来的自建登录（独立密钥 + 自己的 cookie）整个废弃 —— 全部接口走面板的 requireAuth，
// 登录面板即登录云盘。

const ROOT_ID = 1;
const ROOT_NAME = '我的云盘';

function makeRouter(config, requireAuth) {
  const router = express.Router();
  const cfg = config.drive || {};

  // 相对路径按项目根解析（改名 / 搬迁不用动配置），绝对路径原样使用
  const root = path.join(__dirname, '..');
  const abs = (p) => (path.isAbsolute(p) ? p : path.join(root, p));
  const storageDir = abs(cfg.storage || 'data/drive-storage');
  const tmpDir = path.join(storageDir, 'tmp');
  fs.mkdirSync(tmpDir, { recursive: true });

  const db = driveDb.init(abs(cfg.db || 'data/drive.sqlite'));

  // multer 的 limits 在构造时就定死了，而「单次上传上限」是设置页可改的，
  // 所以这里只兜一个硬上限（同时 nginx 的 client_max_body_size 是 2g），
  // 真正生效的限额在 uploadOne 里按当前配置判断
  const HARD_MAX = 2 * 1024 * 1024 * 1024;
  const upload = multer({
    storage: multer.diskStorage({
      destination: (req, file, cb) => cb(null, tmpDir),
      filename: (req, file, cb) => cb(null, crypto.randomUUID())
    }),
    limits: { fileSize: HARD_MAX }
  });

  // multer 的体积错误默认会冒到全局错误处理变成 500，这里翻成 413
  function uploadOne(req, res, next) {
    const limit = cfg.maxUploadSize || HARD_MAX;
    // 先用 Content-Length 拦一道，改配置后无需重启面板即可生效（留 1KB 余量给 multipart 头部）
    const len = Number(req.headers['content-length'] || 0);
    if (len && len > limit + 1024) {
      return res.status(413).json({ error: '文件超过单次上传上限（' + fmt(limit) + '）' });
    }
    upload.single('file')(req, res, (err) => {
      if (!err) return next();
      if (err.code === 'LIMIT_FILE_SIZE') {
        return res.status(413).json({ error: '文件超过单次上传上限（' + fmt(limit) + '）' });
      }
      res.status(400).json({ error: '上传失败：' + err.message });
    });
  }

  function off(res) {
    if (cfg.enabled !== false) return false;
    res.status(503).json({ error: '云盘功能已关闭' });
    return true;
  }

  function sanitizeName(name) {
    let n = String(name || '未命名').trim().replace(/[/\\:*?"<>|\x00-\x1f]/g, '_');
    if (!n) n = '未命名';
    if (n.length > 255) n = n.slice(0, 255);
    return n;
  }

  // 从当前目录往上收集，再倒过来 —— 根目录永远在最左（原版用 unshift，顺序是反的）
  function breadcrumb(folderId) {
    const chain = [];
    let cur = folderId;
    let guard = 0;
    while (cur && cur !== ROOT_ID && guard++ < 100000) {
      const row = db.prepare('SELECT id, name, parent_id FROM folders WHERE id = ?').get(cur);
      if (!row) break;
      chain.push({ id: row.id, name: row.name });
      cur = row.parent_id;
    }
    chain.reverse();
    return [{ id: ROOT_ID, name: ROOT_NAME }].concat(chain);
  }

  function isDescendant(ancestorId, folderId) {
    let cur = folderId;
    let guard = 0;
    while (cur && cur !== ROOT_ID && guard++ < 100000) {
      if (cur === ancestorId) return true;
      const row = db.prepare('SELECT parent_id FROM folders WHERE id = ?').get(cur);
      cur = row ? row.parent_id : null;
    }
    return false;
  }

  // ---------- 元信息 ----------
  router.get('/state', requireAuth, (req, res) => {
    if (off(res)) return;
    res.json({
      enabled: true,
      usage: driveDb.usage(db),
      diskQuota: cfg.diskQuota == null ? null : cfg.diskQuota,
      maxUploadSize: cfg.maxUploadSize || 0
    });
  });

  router.get('/capacity', requireAuth, (req, res) => {
    if (off(res)) return;
    const u = driveDb.usage(db);
    const quota = cfg.diskQuota == null ? null : cfg.diskQuota;
    res.json({ used: u.bytes, files: u.files, quota, free: quota == null ? null : Math.max(0, quota - u.bytes) });
  });

  // ---------- 目录 ----------
  router.get('/files', requireAuth, (req, res) => {
    if (off(res)) return;
    const fid = parseInt(req.query.folder || String(ROOT_ID), 10) || ROOT_ID;
    if (fid !== ROOT_ID && !db.prepare('SELECT id FROM folders WHERE id = ?').get(fid)) {
      return res.status(404).json({ error: '文件夹不存在' });
    }
    res.json(driveDb.listFolder(db, fid));
  });

  router.get('/path', requireAuth, (req, res) => {
    if (off(res)) return;
    const fid = parseInt(req.query.folder || String(ROOT_ID), 10) || ROOT_ID;
    res.json(breadcrumb(fid));
  });

  router.post('/mkdir', requireAuth, (req, res) => {
    if (off(res)) return;
    const name = sanitizeName(req.body.name || '新建文件夹');
    const parentId = parseInt(req.body.parent_id || String(ROOT_ID), 10) || ROOT_ID;
    if (!db.prepare('SELECT id FROM folders WHERE id = ?').get(parentId)) {
      return res.status(400).json({ error: '上级目录不存在' });
    }
    const un = driveDb.uniqueName(db, 'folder', { parent_id: parentId }, name);
    const info = db.prepare('INSERT INTO folders (name, parent_id, created_at) VALUES (?,?,?)')
      .run(un, parentId, Date.now());
    res.json({ id: info.lastInsertRowid, name: un, parent_id: parentId });
  });

  router.post('/rename', requireAuth, (req, res) => {
    if (off(res)) return;
    const { type, id } = req.body;
    const name = sanitizeName(req.body.name);
    if (type === 'file') {
      const row = db.prepare('SELECT folder_id FROM files WHERE id = ?').get(id);
      if (!row) return res.status(404).json({ error: '文件不存在' });
      const un = driveDb.uniqueName(db, 'file', { folder_id: row.folder_id }, name);
      db.prepare('UPDATE files SET name = ?, updated_at = ? WHERE id = ?').run(un, Date.now(), id);
      return res.json({ id, name: un });
    }
    if (type === 'folder') {
      if (Number(id) === ROOT_ID) return res.status(400).json({ error: '根目录不能重命名' });
      const row = db.prepare('SELECT parent_id FROM folders WHERE id = ?').get(id);
      if (!row) return res.status(404).json({ error: '文件夹不存在' });
      const un = driveDb.uniqueName(db, 'folder', { parent_id: row.parent_id }, name);
      db.prepare('UPDATE folders SET name = ? WHERE id = ?').run(un, id);
      return res.json({ id, name: un });
    }
    res.status(400).json({ error: '类型不正确' });
  });

  router.post('/move', requireAuth, (req, res) => {
    if (off(res)) return;
    const { type, id } = req.body;
    const target = parseInt(req.body.parent_id, 10);
    if (!db.prepare('SELECT id FROM folders WHERE id = ?').get(target)) {
      return res.status(400).json({ error: '目标文件夹不存在' });
    }
    if (type === 'file') {
      const row = db.prepare('SELECT folder_id FROM files WHERE id = ?').get(id);
      if (!row) return res.status(404).json({ error: '文件不存在' });
      if (row.folder_id === target) return res.json({ ok: true });
      db.prepare('UPDATE files SET folder_id = ?, updated_at = ? WHERE id = ?').run(target, Date.now(), id);
      return res.json({ ok: true });
    }
    if (type === 'folder') {
      const f = db.prepare('SELECT id, parent_id FROM folders WHERE id = ?').get(id);
      if (!f) return res.status(404).json({ error: '文件夹不存在' });
      if (Number(id) === ROOT_ID) return res.status(400).json({ error: '根目录不能移动' });
      if (target === Number(id)) return res.status(400).json({ error: '不能移动到自身' });
      if (isDescendant(Number(id), target)) return res.status(400).json({ error: '不能移动到自身子文件夹' });
      if (f.parent_id === target) return res.json({ ok: true });
      db.prepare('UPDATE folders SET parent_id = ? WHERE id = ?').run(target, id);
      return res.json({ ok: true });
    }
    res.status(400).json({ error: '类型不正确' });
  });

  router.post('/delete', requireAuth, (req, res) => {
    if (off(res)) return;
    const { type, id } = req.body;
    if (type === 'file') {
      const row = db.prepare('SELECT storage_name FROM files WHERE id = ?').get(id);
      if (!row) return res.status(404).json({ error: '文件不存在' });
      db.prepare('DELETE FROM files WHERE id = ?').run(id);
      fs.unlink(path.join(storageDir, row.storage_name), () => {});
      return res.json({ ok: true });
    }
    if (type === 'folder') {
      if (Number(id) === ROOT_ID) return res.status(400).json({ error: '根目录不能删除' });
      const removed = driveDb.deleteFolderRecursive(db, Number(id));
      removed.forEach((r) => fs.unlink(path.join(storageDir, r.storageName), () => {}));
      return res.json({ ok: true, removed: removed.length });
    }
    res.status(400).json({ error: '类型不正确' });
  });

  // ---------- 上传 ----------
  router.post('/upload', requireAuth, uploadOne, (req, res) => {
    if (off(res)) return;
    const f = req.file;
    if (!f) return res.status(400).json({ error: '没有收到文件' });
    const folderId = parseInt(req.body.folder || String(ROOT_ID), 10) || ROOT_ID;
    if (!db.prepare('SELECT id FROM folders WHERE id = ?').get(folderId)) {
      fs.unlink(f.path, () => {});
      return res.status(400).json({ error: '目标文件夹不存在' });
    }
    // 配额预检：超了就当场删掉临时文件，别把磁盘写满
    if (cfg.diskQuota != null) {
      const used = driveDb.usage(db).bytes;
      if (used + f.size > cfg.diskQuota) {
        fs.unlink(f.path, () => {});
        return res.status(413).json({ error: '云盘空间不足' });
      }
    }
    const name = sanitizeName(req.body.name || f.originalname);
    const un = driveDb.uniqueName(db, 'file', { folder_id: folderId }, name);
    const storageName = crypto.randomUUID();
    try {
      fs.renameSync(f.path, path.join(storageDir, storageName));
    } catch (e) {
      fs.unlink(f.path, () => {});
      return res.status(500).json({ error: '文件落盘失败' });
    }
    const now = Date.now();
    const info = db.prepare(
      'INSERT INTO files (name, folder_id, size, mime, storage_name, created_at, updated_at) VALUES (?,?,?,?,?,?,?)'
    ).run(un, folderId, f.size, f.mimetype || 'application/octet-stream', storageName, now, now);
    res.json({ id: info.lastInsertRowid, name: un, size: f.size });
  });

  // ---------- 下载 ----------
  router.get('/download/:id', requireAuth, (req, res) => {
    if (off(res)) return;
    const row = db.prepare('SELECT * FROM files WHERE id = ?').get(req.params.id);
    if (!row) return res.status(404).json({ error: '文件不存在' });
    const p = path.join(storageDir, row.storage_name);
    if (!fs.existsSync(p)) return res.status(404).json({ error: '文件已不存在' });
    res.download(p, row.name);
  });

  // 整目录打包：边遍历边往 zip 流里塞，不占额外磁盘
  router.get('/download-folder/:id', requireAuth, (req, res) => {
    if (off(res)) return;
    const folder = db.prepare('SELECT id, name FROM folders WHERE id = ?').get(req.params.id);
    if (!folder) return res.status(404).json({ error: '文件夹不存在' });
    const base = folder.id === ROOT_ID ? ROOT_NAME : folder.name;
    const archive = archiver('zip', { zlib: { level: 5 } });
    res.attachment(base + '.zip');
    archive.on('error', () => { try { res.destroy(); } catch (e) { /* ignore */ } });
    archive.pipe(res);

    (function collect(folderId, prefix) {
      const folders = db.prepare('SELECT id, name FROM folders WHERE parent_id = ? ORDER BY name COLLATE NOCASE').all(folderId);
      const files = db.prepare('SELECT id, name, storage_name FROM files WHERE folder_id = ? ORDER BY name COLLATE NOCASE').all(folderId);
      for (const f of folders) collect(f.id, prefix + f.name + '/');
      for (const f of files) {
        const p = path.join(storageDir, f.storage_name);
        if (fs.existsSync(p)) archive.file(p, { name: prefix + f.name });
      }
    })(folder.id, '');
    archive.finalize();
  });

  return router;
}

// 只用于拼错误文案
function fmt(bytes) {
  if (!bytes) return '不限';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), u.length - 1);
  return (bytes / Math.pow(1024, i)).toFixed(i ? 1 : 0) + ' ' + u[i];
}

module.exports = { makeRouter };
