const { DatabaseSync } = require('node:sqlite');

// 云盘的元数据全在 sqlite 里，文件实体落在 storage 目录（按 storage_name 命名）。
// Nimbus 风格云盘的数据层，表结构保持简单。
//
// 走 Node 内置的 node:sqlite，不再依赖 better-sqlite3：后者是原生模块，编译产物与
// Node 的 ABI 版本绑死，会把整台机器钉在某个 Node 大版本上。node:sqlite 的
// prepare / get / all / run / exec 与 better-sqlite3 同名同语义，只有 pragma() 和
// transaction() 没有对应物 —— 前者改写成 exec('PRAGMA ...')，后者用下面的 withTx()。

function init(dbFile) {
  const db = new DatabaseSync(dbFile);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');

  db.exec(`
    CREATE TABLE IF NOT EXISTS folders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      parent_id INTEGER,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS files (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      folder_id INTEGER NOT NULL,
      size INTEGER NOT NULL DEFAULT 0,
      mime TEXT,
      storage_name TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_folders_parent ON folders(parent_id);
    CREATE INDEX IF NOT EXISTS idx_files_folder ON files(folder_id);
  `);

  // 根目录固定 id=1，parent_id 为 NULL，名字留空（界面上的「我的云盘」是前端写的）
  const root = db.prepare('SELECT id FROM folders WHERE id = 1').get();
  if (!root) {
    db.prepare("INSERT INTO folders (id, name, parent_id, created_at) VALUES (1, '', NULL, ?)")
      .run(Date.now());
  }
  return db;
}

// node:sqlite 没有 better-sqlite3 的 db.transaction()，手写一层等价的：
// 正常走 COMMIT，抛错走 ROLLBACK 并把原错误继续抛出去
function withTx(db, fn) {
  db.exec('BEGIN');
  try {
    const out = fn();
    db.exec('COMMIT');
    return out;
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch (e2) { /* 事务已经不在了，忽略 */ }
    throw e;
  }
}

// 某个目录下的子树（含自身）所有 folder id —— 递归 CTE，一次查完
const SUBTREE = `
  WITH RECURSIVE subtree(id) AS (
    SELECT ?
    UNION ALL
    SELECT f.id FROM folders f JOIN subtree s ON f.parent_id = s.id
  )
`;

// 判断某个目录下 name 是否冲突，冲突则自动追加 " (n)"
// kind: 'file' | 'folder'；parentRef: {folder_id} 或 {parent_id}（数值）
function uniqueName(db, kind, parentRef, name) {
  let lead = name;
  let trailing = '';
  if (kind === 'file') {
    const dot = name.lastIndexOf('.');
    if (dot > 0) {
      lead = name.slice(0, dot);
      trailing = name.slice(dot);
    }
  }
  for (let i = 0; ; i++) {
    const candidate = i === 0 ? name : `${lead} (${i})${trailing}`;
    const exists = kind === 'file'
      ? db.prepare('SELECT 1 FROM files WHERE folder_id = ? AND name = ?').get(parentRef.folder_id, candidate)
      : db.prepare('SELECT 1 FROM folders WHERE parent_id = ? AND name = ?').get(parentRef.parent_id, candidate);
    if (!exists) return candidate;
  }
}

function subfolderSize(db, folderId) {
  const row = db.prepare(SUBTREE + `
    SELECT COALESCE(SUM(f.size), 0) AS total
    FROM files f WHERE f.folder_id IN (SELECT id FROM subtree)
  `).get(folderId);
  return row ? row.total : 0;
}

function listFolder(db, folderId) {
  const folders = db.prepare('SELECT id, name, parent_id, created_at FROM folders WHERE parent_id = ? ORDER BY name COLLATE NOCASE ASC').all(folderId);
  const files = db.prepare('SELECT id, name, size, mime, created_at, updated_at FROM files WHERE folder_id = ? ORDER BY name COLLATE NOCASE ASC').all(folderId);
  folders.forEach((f) => { f.type = 'folder'; f.size = subfolderSize(db, f.id); });
  files.forEach((f) => { f.type = 'file'; });
  return { folders, files };
}

function usage(db) {
  const row = db.prepare('SELECT COUNT(*) AS n, COALESCE(SUM(size), 0) AS bytes FROM files').get();
  return { files: row.n, bytes: row.bytes };
}

// 删除整个文件夹（递归），返回实际删除的文件列表（含 storage_name），供调用方同步磁盘
function deleteFolderRecursive(db, folderId) {
  const ids = db.prepare(SUBTREE + 'SELECT id FROM subtree').all(folderId).map((r) => r.id);
  const placeholders = ids.map(() => '?').join(',');
  const fileRows = db.prepare(`SELECT id, storage_name FROM files WHERE folder_id IN (${placeholders})`).all(...ids);
  withTx(db, () => {
    db.prepare(`DELETE FROM files WHERE folder_id IN (${placeholders})`).run(...ids);
    db.prepare(`DELETE FROM folders WHERE id IN (${placeholders})`).run(...ids);
  });
  return fileRows.map((r) => ({ fileRowId: r.id, storageName: r.storage_name }));
}

module.exports = { init, uniqueName, subfolderSize, listFolder, usage, deleteFolderRecursive };
