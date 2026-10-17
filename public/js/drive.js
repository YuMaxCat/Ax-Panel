/* ============================================================
   Ax 面板 · 云盘（Nimbus）
   后端 /api/drive/*，鉴权复用面板登录态
   ============================================================ */
'use strict';

var DRIVE_ROOT = 1;
var DRIVE_ROOT_NAME = '我的云盘';

var drive = {
  folder: DRIVE_ROOT,
  view: 'grid',
  quota: null,
  items: [],
  drag: null          // 拖拽中的条目 {type,id}
};

// 先把上次的视图偏好读出来，首次渲染就直接用对的布局
try { drive.view = localStorage.getItem('driveView') || 'grid'; } catch (e) { /* ignore */ }

/* ---------- 容量 ---------- */

function driveRefreshCapacity() {
  return api(API + '/drive/capacity').then(function (c) {
    drive.quota = c.quota;
    var pct = c.quota ? Math.min(100, Math.round(c.used / c.quota * 100)) : 0;
    $('driveBar').style.width = (c.quota ? pct : 0) + '%';
    $('driveCapTxt').innerHTML =
      '已用 <b>' + formatBytes(c.used) + '</b>' +
      (c.quota ? ' / ' + formatBytes(c.quota) + '（' + pct + '%）' : ' · 未设上限') +
      ' · ' + c.files + ' 个文件';
  }).catch(function () { /* 容量只是展示，失败不打断浏览 */ });
}

/* ---------- 浏览 ---------- */

function loadDrive() {
  return driveNavigate(drive.folder);
}

function driveNavigate(fid, opts) {
  opts = opts || {};
  var box = $('driveItems');
  box.innerHTML = '<div class="empty"><span class="spin"></span></div>';
  return Promise.all([
    api(API + '/drive/files?folder=' + fid),
    api(API + '/drive/path?folder=' + fid)
  ]).then(function (r) {
    drive.folder = fid;
    drive.items = r[0].folders.concat(r[0].files);
    driveRenderCrumbs(r[1]);
    driveRender();
    if (!opts.silent) driveRefreshCapacity();
  }).catch(function (e) {
    box.innerHTML = emptyHtml(e.message);
  });
}

function driveRenderCrumbs(path) {
  var html = '';
  for (var i = 0; i < path.length; i++) {
    var isLast = i === path.length - 1;
    html += (i ? '<span class="sep">/</span>' : '') +
      '<span class="cb' + (isLast ? ' cur' : '') + '" data-fid="' + path[i].id + '">' +
      esc(path[i].name) + '</span>';
  }
  $('driveCrumbs').innerHTML = html;
}

function driveRender() {
  var box = $('driveItems');
  box.className = 'drive-items ' + drive.view;
  if (!drive.items.length) {
    box.innerHTML = emptyHtml(drive.folder === DRIVE_ROOT
      ? '云盘还是空的，点「上传」或把文件拖进来'
      : '这个文件夹是空的');
    return;
  }
  box.innerHTML = drive.items.map(function (it) {
    var isDir = it.type === 'folder';
    var thumb = '<div class="dt-thumb' + (isDir ? ' dir' : '') + '">' + (isDir ? I.folder : I.file) + '</div>';
    var mtime = isDir ? '' : formatTime(it.updated_at);
    return '<div class="dt" data-type="' + it.type + '" data-id="' + it.id + '" data-name="' + esc(it.name) + '" draggable="true">' +
      thumb +
      '<div class="dt-name" title="' + esc(it.name) + '">' + esc(it.name) + '</div>' +
      '<div class="dt-meta">' + formatBytes(it.size) + (mtime ? ' · ' + mtime : '') + '</div>' +
      '<button class="dt-more" data-more="' + it.type + ':' + it.id + '" title="更多">' + I.more + '</button>' +
      '</div>';
  }).join('');
  driveBindItems();
}

/* ---------- 条目交互（点击 / 拖拽移动） ---------- */

function driveHasMove(e) {
  return e.dataTransfer && Array.prototype.indexOf.call(e.dataTransfer.types, 'application/x-drive') >= 0;
}

// 每次渲染后重挂：条目是整块重建的，用 onXxx 属性赋值不会叠加监听
function driveBindItems() {
  var items = $('driveItems').querySelectorAll('.dt');
  for (var i = 0; i < items.length; i++) {
    (function (el) {
      var type = el.getAttribute('data-type');
      var id = parseInt(el.getAttribute('data-id'), 10);

      el.onclick = function (e) {
        if (e.target.closest('[data-more]')) return;
        if (type === 'folder') driveNavigate(id);
        else window.location.href = API + '/drive/download/' + id;
      };

      el.ondragstart = function (e) {
        drive.drag = { type: type, id: id };
        e.dataTransfer.setData('application/x-drive', '1');
        e.dataTransfer.effectAllowed = 'move';
        el.classList.add('dragging');
      };
      el.ondragend = function () { el.classList.remove('dragging'); };

      if (type === 'folder') {
        el.ondragover = function (e) {
          if (driveHasMove(e)) { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; el.classList.add('drop-on'); }
        };
        el.ondragleave = function () { el.classList.remove('drop-on'); };
        el.ondrop = function (e) {
          el.classList.remove('drop-on');
          if (!driveHasMove(e)) return;
          e.preventDefault();
          driveMove(id);
        };
      }
    })(items[i]);
  }
}

async function driveMove(targetFolder) {
  var d = drive.drag;
  if (!d) return;
  if (d.type === 'folder' && d.id === targetFolder) { toast('不能移动到自身', true); return; }
  try {
    await api(API + '/drive/move', { json: { type: d.type, id: d.id, parent_id: targetFolder } });
    toast('已移动');
    driveNavigate(drive.folder, { silent: true });
  } catch (e) { toast(e.message, true); }
}

/* ---------- 条目菜单 ---------- */

function driveOpenMenu(anchor, key) {
  driveCloseMenu();
  var parts = key.split(':');
  var type = parts[0];
  var id = parts[1];

  var m = document.createElement('div');
  m.className = 'drive-menu';
  m.innerHTML =
    '<button data-act="download">' + I.download + (type === 'folder' ? '打包下载' : '下载') + '</button>' +
    '<button data-act="rename">' + I.pencil + '重命名</button>' +
    '<hr>' +
    '<button data-act="delete" class="danger">' + I.trash + '删除</button>';
  document.body.appendChild(m);

  var r = anchor.getBoundingClientRect();
  var x = r.right - m.offsetWidth;
  var y = r.bottom + 6;
  if (x < 8) x = 8;
  if (y + m.offsetHeight > window.innerHeight - 8) y = r.top - m.offsetHeight - 6;
  m.style.left = x + 'px';
  m.style.top = y + 'px';

  m.onclick = function (e) {
    var b = e.target.closest('[data-act]');
    if (!b) return;
    var act = b.getAttribute('data-act');
    driveCloseMenu();
    if (act === 'download') {
      window.location.href = API + (type === 'folder' ? '/drive/download-folder/' : '/drive/download/') + id;
    } else if (act === 'rename') {
      driveRename(type, id);
    } else if (act === 'delete') {
      driveDelete(type, id);
    }
  };
  setTimeout(function () {
    document.addEventListener('click', driveCloseMenu, { once: true });
  }, 0);
}

function driveCloseMenu() {
  var m = document.querySelector('.drive-menu');
  if (m) m.remove();
}

function driveItemName(type, id) {
  var el = document.querySelector('#driveItems .dt[data-type="' + type + '"][data-id="' + id + '"]');
  return el ? el.getAttribute('data-name') : '';
}

function driveRename(type, id) {
  var cur = driveItemName(type, id);
  modal({
    title: '重命名',
    input: { value: cur, placeholder: '新名称' },
    confirmText: '保存',
    onConfirm: async function (val) {
      if (!val) return;
      await api(API + '/drive/rename', { json: { type: type, id: parseInt(id, 10), name: val } });
      toast('已重命名');
      driveNavigate(drive.folder, { silent: true });
    }
  });
}

function driveDelete(type, id) {
  var name = driveItemName(type, id);
  modal({
    title: '确认删除',
    message: type === 'folder'
      ? '文件夹「' + name + '」及其内部所有文件都会被永久删除，无法恢复。'
      : '文件「' + name + '」将被永久删除，无法恢复。',
    confirmText: '删除',
    danger: true,
    onConfirm: async function () {
      await api(API + '/drive/delete', { json: { type: type, id: parseInt(id, 10) } });
      toast('已删除');
      driveNavigate(drive.folder, { silent: true });
      driveRefreshCapacity();
    }
  });
}

function driveMkdir() {
  modal({
    title: '新建文件夹',
    input: { value: '新建文件夹', placeholder: '文件夹名称' },
    confirmText: '创建',
    onConfirm: async function (val) {
      if (!val) return;
      await api(API + '/drive/mkdir', { json: { name: val, parent_id: drive.folder } });
      toast('已创建');
      driveNavigate(drive.folder, { silent: true });
    }
  });
}

/* ---------- 上传（最多 3 个并发，边传边显示进度） ---------- */

var driveQueue = [];
var driveActive = 0;
var DRIVE_CONCURRENT = 3;
var driveHideTimer = null;

function driveUploadPanel(show) {
  var p = $('driveUploads');
  if (show) {
    p.classList.add('show');
    if (driveHideTimer) { clearTimeout(driveHideTimer); driveHideTimer = null; }
    return;
  }
  p.classList.remove('show');
}

function driveMaybeHide() {
  if (driveActive || driveQueue.length) return;
  clearTimeout(driveHideTimer);
  driveHideTimer = setTimeout(function () {
    if (!driveActive && !driveQueue.length) driveUploadPanel(false);
  }, 1200);
}

function driveEnqueue(files) {
  if (!files || !files.length) return;
  for (var i = 0; i < files.length; i++) driveQueue.push(files[i]);
  drivePump();
}

function drivePump() {
  while (driveActive < DRIVE_CONCURRENT && driveQueue.length) {
    driveActive++;
    driveStart(driveQueue.shift(), drive.folder);
  }
  driveMaybeHide();
}

function driveStart(file, folderId) {
  driveUploadPanel(true);
  var row = document.createElement('div');
  row.className = 'du-row';
  row.innerHTML = '<div class="du-name" title="' + esc(file.name) + '">' + esc(file.name) + '</div>' +
    '<div class="du-bar"><i></i></div><div class="du-pct"></div>';
  $('driveUploadsList').appendChild(row);
  var bar = row.querySelector('.du-bar i');
  var pct = row.querySelector('.du-pct');

  var fd = new FormData();
  fd.append('folder', folderId);
  fd.append('name', file.name);
  fd.append('file', file);

  var xhr = new XMLHttpRequest();
  xhr.open('POST', API + '/drive/upload');
  xhr.withCredentials = true;
  xhr.upload.onprogress = function (e) {
    if (!e.lengthComputable) return;
    var p = Math.round(e.loaded / e.total * 100);
    bar.style.width = p + '%';
    pct.textContent = p + '%';
  };
  xhr.onload = function () {
    driveActive--;
    if (xhr.status >= 200 && xhr.status < 300) {
      row.classList.add('done');
      bar.style.width = '100%';
      pct.textContent = '完成';
    } else {
      var msg = '上传失败';
      try { msg = JSON.parse(xhr.responseText).error || msg; } catch (e) { /* ignore */ }
      row.classList.add('err');
      pct.textContent = msg;
      toast(msg, true);
    }
    // 目标目录还停在原处才刷新，避免把用户已经跳走的目录拉回来
    if (drive.folder === folderId) driveNavigate(folderId, { silent: true });
    driveRefreshCapacity();
    drivePump();
  };
  xhr.onerror = function () {
    driveActive--;
    row.classList.add('err');
    pct.textContent = '网络中断';
    drivePump();
  };
  xhr.send(fd);
}

/* ---------- 拖拽上传 ---------- */

function driveHasFiles(e) {
  return e.dataTransfer && Array.prototype.indexOf.call(e.dataTransfer.types, 'Files') >= 0;
}

/* ---------- 初始化 ---------- */

function driveInit() {
  $('btnDriveRefresh').onclick = function () { loadDrive(); };
  $('btnDriveUp').onclick = function () {
    var p = $('driveCrumbs').querySelectorAll('.cb');
    if (p.length < 2) return;
    driveNavigate(parseInt(p[p.length - 2].getAttribute('data-fid'), 10));
  };
  $('btnDriveMkdir').onclick = driveMkdir;

  $('btnDriveUpload').onclick = function () { $('driveInput').click(); };
  $('driveInput').onchange = function () {
    driveEnqueue(Array.prototype.slice.call(this.files));
    this.value = '';
  };

  $('driveCrumbs').onclick = function (e) {
    var cb = e.target.closest('.cb');
    if (cb) driveNavigate(parseInt(cb.getAttribute('data-fid'), 10));
  };
  // 面包屑也可作为移动目标
  $('driveCrumbs').ondragover = function (e) { if (driveHasMove(e)) e.preventDefault(); };
  $('driveCrumbs').ondrop = function (e) {
    var cb = e.target.closest('.cb');
    if (!cb || !driveHasMove(e)) return;
    e.preventDefault();
    driveMove(parseInt(cb.getAttribute('data-fid'), 10));
  };

  var seg = $('driveSeg');
  var btns = seg.querySelectorAll('[data-dview]');
  for (var i = 0; i < btns.length; i++) {
    btns[i].classList.toggle('active', btns[i].getAttribute('data-dview') === drive.view);
    btns[i].onclick = function () {
      drive.view = this.getAttribute('data-dview');
      try { localStorage.setItem('driveView', drive.view); } catch (e) { /* ignore */ }
      for (var j = 0; j < btns.length; j++) {
        btns[j].classList.toggle('active', btns[j].getAttribute('data-dview') === drive.view);
      }
      driveRender();
    };
  }

  // ⋯ 菜单走事件委托，容器只挂这一次（条目会被整块重建）
  $('driveItems').addEventListener('click', function (e) {
    var b = e.target.closest('[data-more]');
    if (!b) return;
    e.stopPropagation();
    driveOpenMenu(b, b.getAttribute('data-more'));
  });
  $('driveUploadsClose').onclick = function () { driveUploadPanel(false); };

  // 拖文件到页面上传、拖条目到文件夹移动 —— 只在云盘视图里生效
  var overlay = $('driveDrop');
  var depth = 0;
  function reset() { depth = 0; overlay.classList.remove('show'); }
  document.addEventListener('dragenter', function (e) {
    if (state.view !== 'drive' || !driveHasFiles(e)) return;
    depth++;
    overlay.classList.add('show');
  });
  document.addEventListener('dragleave', function (e) {
    if (state.view !== 'drive' || !driveHasFiles(e)) return;
    if (--depth <= 0) reset();
  });
  document.addEventListener('dragover', function (e) {
    if (state.view === 'drive' && driveHasFiles(e)) e.preventDefault();
  });
  document.addEventListener('drop', function (e) {
    if (state.view !== 'drive') return;
    reset();
    if (driveHasFiles(e) && e.dataTransfer.files.length) {
      e.preventDefault();
      driveEnqueue(Array.prototype.slice.call(e.dataTransfer.files));
    }
  });
}

document.addEventListener('DOMContentLoaded', driveInit);
