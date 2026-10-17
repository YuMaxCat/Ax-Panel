/* ============================================================
   Ax 面板 · 前端主逻辑（纯静态，零编译）
   ============================================================ */
'use strict';

var API = '/api';
function $(id) { return document.getElementById(id); }

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
  });
}

/* ---------- 格式化 ---------- */
function formatBytes(b) {
  if (b == null) return '—';
  if (b === 0) return '0 B';
  var u = ['B', 'KB', 'MB', 'GB', 'TB'];
  var i = Math.min(Math.floor(Math.log(b) / Math.log(1024)), u.length - 1);
  return (b / Math.pow(1024, i)).toFixed(i ? 1 : 0) + ' ' + u[i];
}
function formatRate(bps) {
  if (!bps) return '0 B/s';
  var u = ['B/s', 'KB/s', 'MB/s', 'GB/s'];
  var i = Math.min(Math.floor(Math.log(bps) / Math.log(1024)), u.length - 1);
  return (bps / Math.pow(1024, i)).toFixed(i ? 1 : 0) + ' ' + u[i];
}
function formatDuration(sec) {
  sec = Math.floor(sec || 0);
  var d = Math.floor(sec / 86400);
  var h = Math.floor((sec % 86400) / 3600);
  var m = Math.floor((sec % 3600) / 60);
  if (d > 0) return d + ' 天 ' + h + ' 小时';
  if (h > 0) return h + ' 小时 ' + m + ' 分';
  return m + ' 分钟';
}
function formatTime(ts) {
  if (!ts) return '—';
  var d = new Date(ts);
  var p = function (n) { return (n < 10 ? '0' : '') + n; };
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
}
function relTime(ts) {
  var s = Math.floor((Date.now() - ts) / 1000);
  if (s < 60) return '刚刚';
  if (s < 3600) return Math.floor(s / 60) + ' 分钟前';
  if (s < 86400) return Math.floor(s / 3600) + ' 小时前';
  if (s < 86400 * 7) return Math.floor(s / 86400) + ' 天前';
  return formatTime(ts);
}

/* ---------- 图标（Lucide 风格，内联 SVG，零依赖） ---------- */
var I = {
  gauge: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3.6 17.5a9 9 0 1 1 16.8 0"/><path d="M12 13.5 15.6 9.9"/></svg>',

  dashboard: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="9" rx="1.6"/><rect x="14" y="3" width="7" height="5" rx="1.6"/><rect x="14" y="12" width="7" height="9" rx="1.6"/><rect x="3" y="16" width="7" height="5" rx="1.6"/></svg>',
  globe: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M3 12h18"/><path d="M12 3a15 15 0 0 1 0 18a15 15 0 0 1 0-18"/></svg>',
  folder: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/></svg>',
  terminal: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="m4 17 6-6-6-6"/><path d="M12 19h8"/></svg>',
  fileText: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/><path d="M16 13H8"/><path d="M16 17H8"/><path d="M10 9H8"/></svg>',
  cpu: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="4" width="16" height="16" rx="2"/><rect x="9" y="9" width="6" height="6" rx="1"/><path d="M9 2v2M15 2v2M9 20v2M15 20v2M2 9h2M2 15h2M20 9h2M20 15h2"/></svg>',
  bell: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0"/></svg>',
  logout: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><path d="m16 17 5-5-5-5"/><path d="M21 12H9"/></svg>',
  refresh: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-3-6.7"/><path d="M21 3v6h-6"/></svg>',
  upload: '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="m17 8-5-5-5 5"/><path d="M12 3v12"/></svg>',
  download: '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="m7 10 5 5 5-5"/><path d="M12 15V3"/></svg>',
  folderPlus: '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/><path d="M12 10v6"/><path d="M9 13h6"/></svg>',
  filePlus: '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/><path d="M12 12v6"/><path d="M9 15h6"/></svg>',
  pencil: '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/><path d="m15 5 4 4"/></svg>',
  trash: '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>',
  up: '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="m5 12 7-7 7 7"/><path d="M12 19V5"/></svg>',
  file: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/></svg>',
  alert: '<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="m21.7 18-8-14a2 2 0 0 0-3.4 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.7-3Z"/><path d="M12 9v4"/><path d="M12 17h.01"/></svg>',
  info: '<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 16v-4"/><path d="M12 8h.01"/></svg>',
  power: '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2v10"/><path d="M18.4 6.6a9 9 0 1 1-12.77.04"/></svg>',
  server: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="7" rx="2"/><rect x="3" y="13" width="18" height="7" rx="2"/><path d="M7 7.5h.01"/><path d="M7 16.5h.01"/></svg>',
  key: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="7.5" cy="15.5" r="5.5"/><path d="m21 2-9.6 9.6"/><path d="m15.5 7.5 3 3L22 7l-3-3"/></svg>',
  settings: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/><circle cx="12" cy="12" r="3"/></svg>',
  moon: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z"/></svg>',
  sun: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41"/></svg>',
  image: '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="9" cy="9" r="2"/><path d="m21 15-3.09-3.09a2 2 0 0 0-2.82 0L6 21"/></svg>',
  inbox: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M22 12h-6l-2 3h-4l-2-3H2"/><path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"/></svg>',
  code: '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="m16 18 6-6-6-6"/><path d="m8 6-6 6 6 6"/></svg>',
  card: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="5" width="20" height="14" rx="2.4"/><path d="M2 10h20"/><path d="M6 15h3"/></svg>',
  cloud: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M17.5 19H9a7 7 0 1 1 6.71-9h1.79a4.5 4.5 0 1 1 0 9Z"/></svg>',
  grid: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="7" rx="1.4"/><rect x="14" y="3" width="7" height="7" rx="1.4"/><rect x="14" y="14" width="7" height="7" rx="1.4"/><rect x="3" y="14" width="7" height="7" rx="1.4"/></svg>',
  list: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M8 6h13M8 12h13M8 18h13"/><path d="M3 6h.01M3 12h.01M3 18h.01"/></svg>',
  gift: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M20 12v9H4v-9"/><rect x="2" y="7" width="20" height="5" rx="1"/><path d="M12 21V7"/><path d="M12 7H7.5a2.5 2.5 0 0 1 0-5C11 2 12 7 12 7Z"/><path d="M12 7h4.5a2.5 2.5 0 0 0 0-5C13 2 12 7 12 7Z"/></svg>',
  more: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="5" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="12" cy="19" r="1"/></svg>',
  close: '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18M6 6l12 12"/></svg>',
  chart: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 3v18h18"/><path d="M7 15l3.5-4 3 2.5L20 7"/></svg>',
  shield: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10Z"/><path d="m9 12 2 2 4-4"/></svg>',
  sparkles: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9z"/><path d="M19 16l.8 2.2L22 19l-2.2.8L19 22l-.8-2.2L16 19l2.2-.8z"/></svg>',
  coins: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="8" cy="8" r="6"/><path d="M18.09 10.37A6 6 0 1 1 10.34 18"/><path d="M7 6h1v4"/><path d="m16.71 13.88.7.71-2.82 2.82"/></svg>',
  bot: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="8" width="16" height="12" rx="3"/><path d="M12 8V4"/><circle cx="12" cy="3" r="1.3"/><path d="M9 13h.01"/><path d="M15 13h.01"/><path d="M9.5 16.5h5"/></svg>',
  heart: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20.2S4.7 15.6 4.7 10.4A4.2 4.2 0 0 1 12 7.9a4.2 4.2 0 0 1 7.3 2.5c0 5.2-7.3 9.8-7.3 9.8z"/></svg>'
};

function fillIcons(root) {
  var nodes = (root || document).querySelectorAll('[data-icon]');
  for (var i = 0; i < nodes.length; i++) {
    var name = nodes[i].getAttribute('data-icon');
    if (I[name]) nodes[i].innerHTML = I[name];
    nodes[i].removeAttribute('data-icon');
  }
}

/* ---------- API ---------- */
async function api(url, opts) {
  opts = Object.assign({ credentials: 'same-origin' }, opts || {});
  if (opts.json !== undefined) {
    opts.method = opts.method || 'POST';
    opts.headers = Object.assign({ 'Content-Type': 'application/json' }, opts.headers);
    opts.body = JSON.stringify(opts.json);
    delete opts.json;
  }
  var r = await fetch(url, opts);
  if (r.status === 401) { location.href = '/login'; throw new Error('登录已过期'); }
  var d = {};
  try { d = await r.json(); } catch (e) { /* ignore */ }
  if (!r.ok) throw new Error(d.error || ('请求失败 ' + r.status));
  return d;
}

/* ---------- Toast / Modal ---------- */
var toastTimer = null;
function toast(msg, isErr) {
  var t = $('toast');
  t.textContent = msg;
  t.classList.toggle('err', !!isErr);
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(function () { t.classList.remove('show'); }, 2600);
}

function modal(opts) {
  var mask = $('modalMask');
  var box = $('modal');
  var html = '<h3>' + esc(opts.title) + '</h3>';
  if (opts.message) html += '<p>' + esc(opts.message) + '</p>';
  // 单个 input 拿字符串，多个 inputs 拿数组；两者都不给就是纯确认框
  var fields = opts.inputs || (opts.input ? [opts.input] : null);
  if (fields) {
    for (var i = 0; i < fields.length; i++) {
      var f = fields[i] || {};
      html += '<input class="input" id="modalInput' + i + '" type="' + esc(f.type || 'text') +
        '" placeholder="' + esc(f.placeholder || '') + '" value="' + esc(f.value || '') + '">';
    }
  }
  html += '<div class="modal-actions">' +
    '<button class="btn" id="modalCancel">取消</button>' +
    '<button class="btn ' + (opts.danger ? 'btn-danger' : 'btn-primary') + '" id="modalOk">' +
    esc(opts.confirmText || '确定') + '</button></div>';
  box.innerHTML = html;
  mask.classList.add('show');

  var inputs = [];
  if (fields) {
    for (var k = 0; k < fields.length; k++) inputs.push($('modalInput' + k));
    inputs[0].focus();
    inputs[0].select();
  }

  function close() { mask.classList.remove('show'); }
  $('modalCancel').onclick = close;
  $('modalOk').onclick = async function () {
    var val;
    if (!inputs.length) val = null;
    else if (inputs.length === 1) val = inputs[0].value;
    else val = inputs.map(function (el) { return el.value; });
    try { await opts.onConfirm(val); close(); }
    catch (e) { toast(e.message, true); }
  };
  mask.onclick = function (e) { if (e.target === mask) close(); };
  for (var m = 0; m < inputs.length; m++) {
    inputs[m].onkeydown = function (e) { if (e.key === 'Enter') $('modalOk').click(); };
  }
}

/* 复制到剪贴板：https 走标准 API，否则退回临时 textarea（http 访问时也能用） */
function copyText(text, okMsg) {
  function fallback() {
    var ta = document.createElement('textarea');
    ta.value = text;
    ta.style.cssText = 'position:fixed;top:-1000px;opacity:0';
    document.body.appendChild(ta);
    ta.select();
    var ok = false;
    try { ok = document.execCommand('copy'); } catch (e) { ok = false; }
    document.body.removeChild(ta);
    return ok;
  }
  function done(ok) {
    toast(ok ? (okMsg || ('已复制：' + text)) : '复制失败，请手动选中复制', !ok);
  }
  if (navigator.clipboard && window.isSecureContext) {
    navigator.clipboard.writeText(text).then(function () { done(true); }, function () { done(fallback()); });
  } else {
    done(fallback());
  }
}

function emptyHtml(text) {
  return '<div class="empty">' + I.inbox + '<div>' + esc(text) + '</div></div>';
}

/* ---------- 状态 ---------- */
var state = {
  view: 'overview',
  sites: [],
  certs: {},
  services: [],
  keys: [],
  ccKeys: [],
  ccHost: '',
  filesPath: null,
  notifications: [],
  snapshot: null,
  history: [],
  procs: [],
  procSort: { key: 'cpu', dir: -1 },
  procFilter: '',
  procShowKernel: false,
  logFile: null,
  logFollow: true,
  logTimer: null,
  dlTasks: [],
  dlState: null
};

var TITLES = {
  overview: '概览', sites: '站点管理', files: '文件管理', download: '下载', drive: '云盘', draw: '抽奖',
  terminal: '终端', logs: '日志', process: '进程', services: '服务', cc: '部署卡', keys: '密钥',
  notify: '通知中心', speedtest: '测速', stats: '访问统计', gf: '虚拟女友', settings: '设置'
};
var SUBS = {
  overview: '实时资源监控', sites: '一键禁止 / 恢复站点访问', files: '服务器文件浏览与操作',
  download: '服务器多分片并发下载，完成后再取回本地',
  drive: '私有云盘：分目录存放、拖拽整理、整目录打包下载',
  draw: '不重复抽名：抽中即移出奖池，状态存在本机浏览器',
  terminal: '真实 shell，以 root 身份执行', logs: 'pm2 与 nginx 日志', process: '任务管理器',
  services: 'pm2 服务：重启 / 停止 / 查看日志',
  cc: 'Termux / Windows 一键部署 Claude Code：发卡 / 换机解绑 / 记部署次数',
  keys: '卡密：生成 / 停用 / 删除',
  notify: '系统告警与提示', speedtest: '对比面板回源与 CF 边缘两段速度',
  stats: '访客来源与站点流量',
  gf: '她的记忆、心情、人设和那点小脾气',
  settings: '面板密钥 / 会话与基本信息'
};

/* ---------- 功能开关 ----------
   服务端 config.json 是唯一真相：关掉的模块连导航项一起摘掉，也不许当落点。
   请求回来之前先用上次的缓存同步摘一遍，否则每次刷新导航里都会闪一下已关闭的入口 */
var FEATURES_KEY = 'features.v1';
var FEATURES = { download: true, drive: true, stats: true, gf: false };

function applyFeatures(f) {
  if (!f) return;
  for (var k in f) FEATURES[k] = !!f[k];
  try { localStorage.setItem(FEATURES_KEY, JSON.stringify(FEATURES)); } catch (e) { /* ignore */ }
  for (var name in FEATURES) {
    var on = FEATURES[name] !== false;
    var items = document.querySelectorAll('.nav-item[data-view="' + name + '"], .dock-item[data-view="' + name + '"]');
    for (var i = 0; i < items.length; i++) items[i].style.display = on ? '' : 'none';
  }
  // 当前正停在一个刚被关掉的模块上（比如在别的标签页改了配置），退回概览
  if (FEATURES[state.view] === false) setView('overview');
}

function featureOff(v) { return FEATURES[v] === false; }

/* ---------- 视图切换 ---------- */
function setView(v) {
  if (!TITLES[v] || featureOff(v)) v = 'overview'; // 没有标题表的模块名（已删除）与关掉的模块，一律退回概览
  stopDlPoll(); // 下载进度轮询只在下载页里跑
  statsStop();  // 访问统计的兜底轮询同理
  state.view = v;
  var views = document.querySelectorAll('.view');
  for (var i = 0; i < views.length; i++) {
    views[i].classList.toggle('active', views[i].id === 'view-' + v);
  }
  var navs = document.querySelectorAll('.nav-item[data-view], .dock-item[data-view]');
  for (var j = 0; j < navs.length; j++) {
    navs[j].classList.toggle('active', navs[j].getAttribute('data-view') === v);
  }
  $('pageTitle').textContent = TITLES[v] || '';
  $('pageSub').textContent = SUBS[v] || '';
  try { localStorage.setItem('view', v); } catch (e) { /* ignore */ }

  if (v === 'overview') loadAssets(false);
  else if (v === 'sites') loadSites();
  else if (v === 'files') loadFiles(state.filesPath);
  else if (v === 'download') loadDownloads();
  else if (v === 'drive') loadDrive();
  else if (v === 'draw') drawInit();
  else if (v === 'terminal') { initTerm(); setTimeout(fitTerm, 80); }
  else if (v === 'logs') loadLogs();
  else if (v === 'process') loadProcs();
  else if (v === 'services') loadServices();
  else if (v === 'cc') loadCc();
  else if (v === 'keys') loadKeys();
  else if (v === 'notify') loadNotify();
  else if (v === 'speedtest') speedtestInit();
  else if (v === 'stats') statsInit();
  else if (v === 'gf') gfInit();
  else if (v === 'settings') loadSettings();
}

/* ==================== 概览 ==================== */

var RING_C = 175.93;

function statCardHtml(key, label, icon) {
  return '<div class="stat-card" data-stat="' + key + '">' +
    '<div class="ring">' +
    '<svg viewBox="0 0 66 66">' +
    '<circle class="track" cx="33" cy="33" r="28"/>' +
    '<circle class="val" cx="33" cy="33" r="28" stroke-dasharray="' + RING_C + '" stroke-dashoffset="' + RING_C + '"/>' +
    '</svg>' +
    '<div class="num" data-num>' + (icon || '0%') + '</div>' +
    '</div>' +
    '<div class="stat-info"><div class="s-label">' + label + '</div>' +
    '<div class="s-main">—</div><div class="s-sub">—</div></div></div>';
}

function buildStats() {
  var grid = $('statsGrid');
  if (grid.getAttribute('data-built')) return;
  grid.innerHTML =
    statCardHtml('cpu', 'CPU', null) +
    statCardHtml('mem', '内存', null) +
    statCardHtml('disk', '磁盘', null);
  grid.setAttribute('data-built', '1');
}

function setStat(key, percent, main, sub) {
  var el = document.querySelector('[data-stat="' + key + '"]');
  if (!el) return;
  el.querySelector('.s-main').textContent = main;
  el.querySelector('.s-sub').textContent = sub;
  if (percent == null) return;
  var p = Math.max(0, Math.min(100, percent));
  var c = el.querySelector('.val');
  c.setAttribute('stroke-dashoffset', (RING_C * (1 - p / 100)).toFixed(1));
  c.setAttribute('class', 'val' + (p >= 90 ? ' crit' : (p >= 75 ? ' warn' : '')));
  el.querySelector('[data-num]').textContent = p.toFixed(0) + '%';
}

function renderStats(s) {
  if (!s || !s.cpu) return;
  buildStats();
  setStat('cpu', s.cpu.usage, s.cpu.usage.toFixed(1) + '%',
    s.cpu.cores + ' 核 · 负载 ' + s.load[0].toFixed(2));
  setStat('mem', s.mem.usagePercent, formatBytes(s.mem.used),
    s.mem.usagePercent.toFixed(1) + '% / ' + formatBytes(s.mem.total) +
    (s.mem.swapTotal ? ' · 交换 ' + s.mem.swapPercent.toFixed(0) + '%' : ''));
  setStat('disk', s.disk.usagePercent, formatBytes(s.disk.used),
    s.disk.usagePercent.toFixed(1) + '% / ' + formatBytes(s.disk.total));
}

function renderInfo(s) {
  if (!s || !s.cpu) return;
  var items = [
    ['运行时间', formatDuration(s.uptime)],
    ['负载均衡(1/5/15分)', s.load.map(function (x) { return x.toFixed(2); }).join(' / ')],
    ['CPU 型号', s.cpu.model || '—'],
    ['CPU 核心', s.cpu.cores + ' 核'],
    ['内存', formatBytes(s.mem.used) + ' / ' + formatBytes(s.mem.total)],
    ['交换分区', formatBytes(s.mem.swapUsed || 0) + ' / ' + formatBytes(s.mem.swapTotal || 0)],
    ['磁盘', formatBytes(s.disk.used) + ' / ' + formatBytes(s.disk.total) + '（' + s.disk.mount + '）'],
    ['进程数', (s.procCount || 0) + ' 个'],
    ['累计接收', formatBytes(s.net.rxTotal)],
    ['累计发送', formatBytes(s.net.txTotal)]
  ];
  $('infoGrid').innerHTML = items.map(function (it) {
    return '<div class="info-row"><span class="k">' + esc(it[0]) + '</span><span class="v">' + esc(it[1]) + '</span></div>';
  }).join('');
}

function drawChart() {
  var c = $('chart');
  if (!c) return;
  var wrap = c.parentNode;
  var dpr = window.devicePixelRatio || 1;
  var w = wrap.clientWidth;
  var h = wrap.clientHeight;
  if (!w || !h) return;
  c.width = Math.round(w * dpr);
  c.height = Math.round(h * dpr);
  var ctx = c.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);

  var cs = getComputedStyle(document.documentElement);
  var accent = cs.getPropertyValue('--accent').trim() || '#f2739b';
  var success = cs.getPropertyValue('--success').trim() || '#35c98a';
  var sep = cs.getPropertyValue('--separator').trim() || 'rgba(0,0,0,.1)';

  var pad = { l: 30, r: 8, t: 8, b: 16 };
  var gw = w - pad.l - pad.r;
  var gh = h - pad.t - pad.b;

  // 网格 + Y 轴刻度
  ctx.strokeStyle = sep;
  ctx.fillStyle = cs.getPropertyValue('--text-3').trim() || '#999';
  ctx.font = '10px -apple-system, sans-serif';
  ctx.lineWidth = 1;
  for (var v = 0; v <= 100; v += 25) {
    var y = pad.t + gh * (1 - v / 100);
    ctx.beginPath();
    ctx.moveTo(pad.l, y);
    ctx.lineTo(w - pad.r, y);
    ctx.stroke();
    ctx.fillText(v + '%', 4, y + 3);
  }

  var data = state.history || [];
  if (data.length < 2) return;
  var n = data.length;

  function drawLine(getter, color) {
    ctx.beginPath();
    ctx.strokeStyle = color;
    ctx.lineWidth = 2;
    ctx.lineJoin = 'round';
    for (var i = 0; i < n; i++) {
      var x = pad.l + gw * (i / (n - 1));
      var val = Math.max(0, Math.min(100, getter(data[i]) || 0));
      var y = pad.t + gh * (1 - val / 100);
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.stroke();
  }
  drawLine(function (p) { return p.cpu; }, accent);
  drawLine(function (p) { return p.mem; }, success);
}

/* ==================== 站点管理 ==================== */

async function loadSites() {
  var box = $('siteList');
  box.innerHTML = '<div class="empty"><span class="spin"></span></div>';
  try {
    // 证书信息失败不影响站点列表本身
    var r = await Promise.all([
      api(API + '/sites'),
      api(API + '/certs').catch(function () { return { certs: [] }; })
    ]);
    state.sites = r[0].sites || [];
    state.certs = {};
    (r[1].certs || []).forEach(function (c) { state.certs[c.domain] = c; });
    renderSites();
  } catch (e) {
    box.innerHTML = emptyHtml(e.message);
  }
}

function certBadge(c) {
  if (!c) return '';
  if (c.error || c.daysLeft === null) return '<span class="badge red">证书异常</span>';
  var d = c.daysLeft;
  var cls = d <= 7 ? 'red' : (d <= 21 ? 'orange' : 'green');
  return '<span class="badge ' + cls + '">证书 ' + d + ' 天</span>';
}

function renderSites() {
  var box = $('siteList');
  $('sitesCount').textContent = state.sites.length + ' 个站点';
  if (!state.sites.length) { box.innerHTML = emptyHtml('未发现站点'); return; }

  box.innerHTML = state.sites.map(function (s) {
    var c = state.certs[s.domain];
    var typeBadge = s.type === 'proxy'
      ? '<span class="badge">反代</span>'
      : (s.type === 'static' ? '<span class="badge">静态</span>' : '<span class="badge gray">其他</span>');
    var stateBadge;
    if (!s.injected) stateBadge = '<span class="badge gray">未接管</span>';
    else if (s.blocked) stateBadge = '<span class="badge red">已禁止</span>';
    else stateBadge = '<span class="badge green">正常</span>';

    var actions = '';
    if (c && !c.error) {
      var canRenew = !!c.acmeDomain;
      actions += '<button class="btn btn-sm" data-act="renew" data-domain="' + esc(s.domain) + '"' +
        ' title="' + (canRenew ? '强制续签该站点证书' : '该证书不由 acme.sh 管理，无法自动续签') + '"' +
        (canRenew ? '' : ' disabled') + '>续签</button>';
    }
    if (!s.injected) {
      actions += '<button class="btn btn-sm" data-act="takeover" data-domain="' + esc(s.domain) + '">接管</button>';
    } else {
      actions += '<button class="switch' + (s.blocked ? ' on danger' : '') + '" data-act="toggle"' +
        ' data-domain="' + esc(s.domain) + '" data-blocked="' + (s.blocked ? 1 : 0) + '"' +
        ' title="' + (s.blocked ? '恢复访问' : '禁止访问') + '"></button>';
    }
    // 探活开关：开着才参与可用性巡检（故意停用的站点可关掉，免误报）
    actions += '<label class="site-toggle" title="关闭后该站点不再参与可用性探活，也不再产生「站点无法访问」告警">' +
      '<span>探活</span>' +
      '<button class="switch' + (s.uptimeIgnored ? '' : ' on') + '" data-act="uptime"' +
      ' data-domain="' + esc(s.domain) + '" data-ignored="' + (s.uptimeIgnored ? 1 : 0) + '"></button>' +
      '</label>';

    var meta = s.proxy ? ('反代 → ' + s.proxy) : (s.root ? ('目录 ' + s.root) : '');
    if (s.names.length > 1) meta += ' · 共 ' + s.names.length + ' 个域名';

    return '<div class="site-item' + (s.blocked ? ' blocked' : '') + '">' +
      '<div class="site-main">' +
      '<div class="site-domain">' + esc(s.domain) + typeBadge + stateBadge + '</div>' +
      '<div class="site-meta">' + certBadge(c) + esc(meta) + '</div>' +
      '</div>' +
      '<div class="site-actions">' + actions + '</div>' +
      '</div>';
  }).join('');
}

async function toggleSite(domain, blocked) {
  await api(API + '/sites/maintenance', { json: { domain: domain, blocked: blocked } });
  toast(blocked ? '已禁止访问：' + domain : '已恢复访问：' + domain);
  await loadSites();
}

async function setUptimeIgnore(domain, ignored) {
  await api(API + '/sites/uptime-ignore', { json: { domain: domain, ignored: ignored } });
  toast(ignored ? '已忽略「' + domain + '」的探活告警' : '已恢复「' + domain + '」的探活');
  await loadSites();
}

async function takeoverSite(domain) {
  await api(API + '/sites/takeover', { json: { domain: domain } });
  toast('已接管：' + domain);
  await loadSites();
}

async function takeoverAll() {
  var pending = state.sites.filter(function (s) { return !s.injected; });
  if (!pending.length) { toast('所有站点都已接管'); return; }
  if (!window.confirm('将接管 ' + pending.length + ' 个站点（会修改其 nginx 配置并 reload）？')) return;
  var ok = 0, fail = 0;
  for (var i = 0; i < pending.length; i++) {
    try { await api(API + '/sites/takeover', { json: { domain: pending[i].domain } }); ok++; }
    catch (e) { fail++; }
  }
  toast('接管完成：成功 ' + ok + (fail ? '，失败 ' + fail : ''), fail > 0);
  await loadSites();
}

async function renewCert(domain) {
  toast('正在续签 ' + domain + ' 的证书，请稍候…');
  try {
    var d = await api(API + '/certs/renew', { json: { domain: domain } });
    toast('续签成功：' + d.acmeDomain);
    await loadSites();
  } catch (e) {
    toast('续签失败：' + e.message, true);
  }
}

/* ==================== 文件管理 ==================== */

async function loadFiles(path) {
  var box = $('fileList');
  box.innerHTML = '<div class="empty"><span class="spin"></span></div>';
  try {
    if (!path) {
      var r = await api(API + '/files/roots');
      path = (r.roots && r.roots[0]) || '/';
    }
    var d = await api(API + '/files/list?path=' + encodeURIComponent(path));
    state.filesPath = d.path;
    renderCrumbs(d.path);
    renderFiles(d.entries);
  } catch (e) {
    box.innerHTML = emptyHtml(e.message);
  }
}

function renderCrumbs(p) {
  var parts = String(p).split('/').filter(Boolean);
  var html = '<span class="cb" data-path="/">根目录</span>';
  var acc = '';
  for (var i = 0; i < parts.length; i++) {
    acc += '/' + parts[i];
    html += '<span class="sep">/</span><span class="cb' + (i === parts.length - 1 ? ' cur' : '') +
      '" data-path="' + esc(acc) + '">' + esc(parts[i]) + '</span>';
  }
  $('crumbs').innerHTML = html;
}

function renderFiles(entries) {
  var box = $('fileList');
  if (!entries || !entries.length) { box.innerHTML = emptyHtml('这个目录是空的'); return; }
  box.innerHTML = entries.map(function (f) {
    return '<div class="file-row" data-path="' + esc(f.path) + '" data-dir="' + (f.dir ? 1 : 0) + '">' +
      '<span class="f-icon' + (f.dir ? ' dir' : '') + '">' + (f.dir ? I.folder : I.file) + '</span>' +
      '<span class="f-name">' + esc(f.name) + '</span>' +
      '<span class="f-size">' + (f.dir ? '—' : formatBytes(f.size)) + '</span>' +
      '<span class="f-time">' + formatTime(f.mtime) + '</span>' +
      '<span class="f-actions">' +
      (f.dir ? '' :
        '<button class="icon-btn" data-fact="edit" title="编辑">' + I.code + '</button>' +
        '<button class="icon-btn" data-fact="download" title="下载">' + I.download + '</button>') +
      '<button class="icon-btn" data-fact="rename" title="重命名">' + I.pencil + '</button>' +
      '<button class="icon-btn" data-fact="delete" title="删除">' + I.trash + '</button>' +
      '</span></div>';
  }).join('');
}

function fileAction(row, act) {
  var p = row.getAttribute('data-path');
  var name = row.querySelector('.f-name').textContent;
  var isDir = row.getAttribute('data-dir') === '1';

  if (act === 'edit') {
    openEditor(p, name);
    return;
  }
  if (act === 'download') {
    window.location.href = API + '/files/download?path=' + encodeURIComponent(p);
    return;
  }
  if (act === 'rename') {
    modal({
      title: '重命名', input: { value: name, placeholder: '新名称' }, confirmText: '保存',
      onConfirm: async function (val) {
        await api(API + '/files/rename', { json: { path: p, name: val } });
        toast('已重命名');
        loadFiles(state.filesPath);
      }
    });
    return;
  }
  if (act === 'delete') {
    modal({
      title: '确认删除', message: (isDir ? '目录「' : '文件「') + name + '」将被永久删除，无法恢复。',
      confirmText: '删除', danger: true,
      onConfirm: async function () {
        await api(API + '/files/delete', { json: { path: p } });
        toast('已删除');
        loadFiles(state.filesPath);
      }
    });
  }
}

async function uploadFiles(files) {
  if (!files || !files.length) return;
  var total = files.length;
  var done = 0;
  for (var i = 0; i < total; i++) {
    var fd = new FormData();
    fd.append('file', files[i]);
    try {
      await fetch(API + '/files/upload?path=' + encodeURIComponent(state.filesPath), {
        method: 'POST', credentials: 'same-origin', body: fd
      }).then(function (r) {
        if (!r.ok) return r.json().then(function (d) { throw new Error(d.error || '上传失败'); });
      });
      done++;
      toast('已上传 ' + done + '/' + total);
    } catch (e) {
      toast(e.message, true);
    }
  }
  loadFiles(state.filesPath);
}

/* ---------- 在线编辑 ---------- */

var editorPath = null;   // 当前编辑的文件绝对路径
var editorDirty = false; // 有无未保存改动

function editorOpen() { return $('editorMask').classList.contains('show'); }

function editorHint(msg, isErr) {
  var h = $('editorHint');
  h.textContent = msg;
  h.classList.toggle('err', !!isErr);
}

async function openEditor(p, name) {
  var mask = $('editorMask');
  var body = $('editorBody');
  editorPath = p;
  editorDirty = false;
  $('editorName').textContent = name;
  body.value = '';
  body.disabled = true;
  $('btnEditorSave').disabled = true;
  editorHint('读取中…');
  mask.classList.add('show');
  body.focus();

  try {
    var d = await api(API + '/files/read?path=' + encodeURIComponent(p));
    editorPath = d.path;
    body.value = d.content;
    body.disabled = false;
    $('btnEditorSave').disabled = false;
    editorHint('已打开 · ' + formatBytes(d.size));
    body.focus();
  } catch (e) {
    editorHint(e.message, true);
  }
}

function closeEditor(force) {
  var mask = $('editorMask');
  if (!mask.classList.contains('show')) return;
  if (editorDirty && !force) {
    modal({
      title: '放弃修改', message: '「' + $('editorName').textContent + '」有未保存的改动，确定关闭？',
      confirmText: '放弃', danger: true,
      onConfirm: function () { closeEditor(true); }
    });
    return;
  }
  mask.classList.remove('show');
  editorPath = null;
  editorDirty = false;
  $('editorBody').value = '';
}

async function saveEditor() {
  if (!editorPath || $('btnEditorSave').disabled) return;
  var btn = $('btnEditorSave');
  btn.disabled = true;
  editorHint('保存中…');
  try {
    var d = await api(API + '/files/write', { json: { path: editorPath, content: $('editorBody').value } });
    editorDirty = false;
    editorHint('已保存 · ' + formatBytes(d.size));
    toast('已保存 ' + $('editorName').textContent);
    loadFiles(state.filesPath);
  } catch (e) {
    editorHint(e.message, true);
    toast(e.message, true);
  }
  btn.disabled = false;
}

// Ctrl/Cmd+S 保存、Esc 关闭；弹窗打开时让弹窗先处理
document.addEventListener('keydown', function (e) {
  if (!editorOpen()) return;
  if ($('modalMask').classList.contains('show')) return;
  if ((e.ctrlKey || e.metaKey) && (e.key === 's' || e.key === 'S')) {
    e.preventDefault();
    saveEditor();
  } else if (e.key === 'Escape') {
    closeEditor(false);
  }
});

/* ==================== 下载（aria2 离线下载） ==================== */

// 有任务在跑时每 1.5 秒刷一次；全部停下就自动停表，不留后台轮询
var DL_POLL_MS = 1500;
var dlTimer = null;

var DL_STATUS = {
  active:   { text: '下载中', cls: '' },
  waiting:  { text: '排队中', cls: 'gray' },
  paused:   { text: '已暂停', cls: 'orange' },
  error:    { text: '出错',   cls: 'red' },
  complete: { text: '已完成', cls: 'green' },
  removed:  { text: '已移除', cls: 'gray' }
};

function stopDlPoll() {
  if (dlTimer) { clearTimeout(dlTimer); dlTimer = null; }
}

function scheduleDlPoll(need) {
  stopDlPoll();
  if (!need) return;
  dlTimer = setTimeout(function () {
    if (state.view !== 'download') return; // 切走就停，回来时会重新拉
    loadDownloads();
  }, DL_POLL_MS);
}

function dlFmtEta(sec) {
  if (!sec || sec <= 0) return '';
  if (sec < 60) return sec + ' 秒';
  if (sec < 3600) return Math.floor(sec / 60) + ' 分';
  return Math.floor(sec / 3600) + ' 时 ' + Math.floor((sec % 3600) / 60) + ' 分';
}

// 表单默认值来自服务端配置，只取一次
async function initDlForm() {
  if (state.dlState) return state.dlState;
  var d = await api(API + '/download/state');
  state.dlState = d;
  $('dlDir').value = d.dir || '';
  $('dlConn').value = d.connections || 16;
  $('dlConn').max = d.maxConnections || 16;
  return d;
}

async function loadDownloads() {
  var box = $('dlList');
  try {
    var st = await initDlForm();
    if (!st.available) {
      stopDlPoll();
      box.innerHTML = emptyHtml('aria2 没有运行 —— ' + (st.error || '请在「服务」页启动 aria2'));
      dlStat('离线', 'red');
      return;
    }
    var d = await api(API + '/download/list');
    state.dlTasks = d.tasks || [];
    renderDownloads(d.tasks);

    var running = (d.active || 0) + (d.waiting || 0);
    dlStat(running
      ? running + ' 个进行中 · ' + (formatBytes(d.speed) + '/s')
      : (d.tasks.length ? d.tasks.length + ' 个任务' : '—'), 'gray');
    scheduleDlPoll(running > 0);
  } catch (e) {
    stopDlPoll();
    box.innerHTML = emptyHtml(e.message);
    dlStat('不可用', 'red');
  }
}

function dlStat(text, cls) {
  var el = $('dlStat');
  el.textContent = text;
  el.className = 'badge ' + cls;
}

function renderDownloads(tasks) {
  var box = $('dlList');
  if (!tasks || !tasks.length) { box.innerHTML = emptyHtml('还没有下载任务'); return; }

  box.innerHTML = tasks.map(function (t) {
    var meta = DL_STATUS[t.status] || { text: t.status, cls: 'gray' };
    var pct = Math.max(0, Math.min(100, (t.progress || 0) * 100));
    var info;

    if (t.status === 'complete') {
      info = formatBytes(t.total) + ' · 已存到 ' + esc(t.dir);
    } else if (t.status === 'error') {
      info = '错误码 ' + esc(t.errorCode || '?') + '：' + esc(t.errorMessage || '未知原因');
    } else {
      info = formatBytes(t.done) + ' / ' + formatBytes(t.total) +
        ' · ' + formatBytes(t.speed) + '/s' +
        ' · ' + t.connections + ' 连接' +
        (t.eta ? ' · 剩余 ' + dlFmtEta(t.eta) : '');
    }

    return '<div class="dl-item" data-gid="' + esc(t.gid) + '">' +
      '<div class="dl-top">' +
        '<span class="dl-name" title="' + esc(t.path || t.name) + '">' + esc(t.name || t.gid) + '</span>' +
        '<span class="badge ' + meta.cls + '">' + esc(meta.text) + '</span>' +
      '</div>' +
      '<div class="dl-bar"><i style="width:' + pct.toFixed(1) + '%"></i></div>' +
      '<div class="dl-meta">' + info + '</div>' +
      '<div class="dl-actions">' + dlActions(t) + '</div>' +
      '</div>';
  }).join('');
}

function dlActions(t) {
  var out = [];
  function btn(act, label, primary) {
    out.push('<button class="btn btn-sm' + (primary ? ' btn-primary' : '') +
      '" data-dact="' + act + '">' + label + '</button>');
  }
  if (t.status === 'active' || t.status === 'waiting') btn('pause', '暂停');
  if (t.status === 'paused') btn('resume', '继续');
  if (t.status === 'complete') {
    btn('save', '下载到本机', true);
    btn('open', '打开目录');
    btn('remove', '删除记录');
  } else {
    if (t.status === 'error' && t.uri) btn('retry', '重试');
    btn('remove', '取消');
  }
  return out.join('');
}

function dlTask(gid) {
  for (var i = 0; i < state.dlTasks.length; i++) {
    if (state.dlTasks[i].gid === gid) return state.dlTasks[i];
  }
  return null;
}

async function dlAction(gid, act) {
  var t = dlTask(gid);
  if (!t) return;

  if (act === 'save') {
    window.location.href = API + '/files/download?path=' + encodeURIComponent(t.path);
    return;
  }
  if (act === 'open') {
    state.filesPath = t.dir;
    setView('files');
    return;
  }
  if (act === 'retry') {
    await api(API + '/download/add', { json: {
      url: t.uri, dir: t.dir, name: t.name, connections: state.dlState ? state.dlState.connections : 16
    }});
    toast('已重新加入队列');
    loadDownloads();
    return;
  }
  if (act === 'remove') {
    var done = t.status === 'complete';
    modal({
      title: done ? '删除记录' : '取消下载',
      message: done ? '只清掉这条记录，已下载的文件会保留在原处。'
                    : '取消这个下载？已经下到的部分会一并删除。',
      confirmText: done ? '删除记录' : '取消下载',
      danger: !done,
      onConfirm: async function () {
        await api(API + '/download/remove', { json: { gid: gid, del: !done } });
        toast(done ? '记录已清除' : '已取消');
        loadDownloads();
      }
    });
    return;
  }

  await api(API + '/download/' + (act === 'pause' ? 'pause' : 'resume'), { json: { gid: gid } });
  loadDownloads();
}

async function dlAdd() {
  var url = $('dlUrl').value.trim();
  if (!url) { toast('请先粘贴下载链接', true); $('dlUrl').focus(); return; }

  var btn = $('btnDlAdd');
  btn.disabled = true;
  btn.textContent = '提交中…';
  try {
    await api(API + '/download/add', { json: {
      url: url,
      dir: $('dlDir').value.trim(),
      name: $('dlName').value.trim(),
      connections: parseInt($('dlConn').value, 10) || 16
    }});
    $('dlUrl').value = '';
    $('dlName').value = '';
    toast('已加入下载队列');
    loadDownloads();
  } catch (e) {
    toast(e.message, true);
  }
  btn.disabled = false;
  btn.textContent = '开始下载';
}

/* ==================== 终端 ==================== */

var term = null;
var fitAddon = null;
var termWs = null;

function initTerm() {
  if (term) return;
  if (!window.Terminal) {
    $('termBody').innerHTML = '<div class="term-notice">终端组件未加载</div>';
    return;
  }
  term = new Terminal({
    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace',
    fontSize: 13,
    cursorBlink: true,
    scrollback: 3000,
    theme: {
      background: '#1c1820', foreground: '#e8dfe8', cursor: '#ff9ec0',
      selectionBackground: 'rgba(255,158,192,.28)', black: '#3a323c', red: '#ff6b7a',
      green: '#4dd9a0', yellow: '#ffb454', blue: '#8bb4ff', magenta: '#ff9ec0',
      cyan: '#6fd7e8', white: '#e8dfe8'
    }
  });
  fitAddon = new FitAddon.FitAddon();
  term.loadAddon(fitAddon);
  term.open($('termBody'));
  try { fitAddon.fit(); } catch (e) { /* ignore */ }

  term.onData(function (d) {
    if (termWs && termWs.readyState === 1) termWs.send(JSON.stringify({ type: 'input', data: d }));
  });
  term.onResize(function (size) {
    if (termWs && termWs.readyState === 1) {
      termWs.send(JSON.stringify({ type: 'resize', cols: size.cols, rows: size.rows }));
    }
  });
  connectTerm();
}

function fitTerm() {
  if (!fitAddon) return;
  try { fitAddon.fit(); } catch (e) { /* ignore */ }
}

function connectTerm() {
  if (termWs) { try { termWs.close(); } catch (e) { /* ignore */ } }
  var proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  termWs = new WebSocket(proto + '//' + location.host + '/ws/terminal');

  termWs.onopen = function () {
    term.write('\r\n\x1b[38;5;218mAx 面板终端已连接\x1b[0m\r\n');
    fitTerm();
    term.focus();
  };
  termWs.onmessage = function (ev) {
    var m = null;
    try { m = JSON.parse(ev.data); } catch (e) { term.write(ev.data); return; }
    if (m.type === 'data') term.write(m.data);
    else if (m.type === 'error') term.write('\r\n\x1b[31m' + m.data + '\x1b[0m\r\n');
  };
  termWs.onclose = function () {
    term.write('\r\n\x1b[33m[连接已断开，点右上角刷新可重连]\x1b[0m\r\n');
  };
}

/* ==================== 日志 ==================== */

async function loadLogs() {
  var side = $('logSide');
  side.innerHTML = '<div class="empty"><span class="spin"></span></div>';
  try {
    var d = await api(API + '/logs');
    var files = d.files || [];
    if (!files.length) { side.innerHTML = emptyHtml('没有日志文件'); return; }
    side.innerHTML = files.map(function (f) {
      return '<div class="log-file" data-path="' + esc(f.path) + '" data-name="' + esc(f.name) + '">' +
        '<div class="lf-name">' + esc(f.name) + '</div>' +
        '<div class="lf-meta">' + esc(f.group) + ' · ' + formatBytes(f.size) + ' · ' + relTime(f.mtime) + '</div></div>';
    }).join('');
    if (!state.logFile) selectLog(files[0].path, files[0].name);
    else selectLog(state.logFile.path, state.logFile.name);
  } catch (e) {
    side.innerHTML = emptyHtml(e.message);
  }
}

function selectLog(path, name) {
  state.logFile = { path: path, name: name };
  $('logName').textContent = name;
  var items = document.querySelectorAll('.log-file');
  for (var i = 0; i < items.length; i++) {
    items[i].classList.toggle('active', items[i].getAttribute('data-path') === path);
  }
  tailLog();
  startLogTimer();
}

async function tailLog() {
  if (!state.logFile) return;
  try {
    var d = await api(API + '/logs/tail?lines=400&file=' + encodeURIComponent(state.logFile.path));
    var view = $('logView');
    var atBottom = view.scrollTop + view.clientHeight >= view.scrollHeight - 40;
    view.textContent = d.content || '(空)';
    if (atBottom) view.scrollTop = view.scrollHeight;
  } catch (e) { /* 跟随失败静默 */ }
}

function startLogTimer() {
  stopLogTimer();
  if (!state.logFollow) return;
  state.logTimer = setInterval(tailLog, 3000);
}

function stopLogTimer() {
  if (state.logTimer) { clearInterval(state.logTimer); state.logTimer = null; }
}

/* ==================== 进程 ==================== */

// 常见进程的中文名：按顺序匹配命令，命中即用；未命中则原样显示命令
var PROC_NAMES = [
  [/pm2-logrotate/, 'pm2 日志轮转'],
  [/^PM2 v[\d.]+: God Daemon/, 'PM2 守护进程'],
  [/node \/opt\/Ax-Panel\/server\.js/, 'Ax 面板'],
  [/node \/opt\/cloud\/server\.js/, '云盘服务'],
  [/node \/opt\/ip2location\/server\.js/, 'IP 归属地'],
  [/node \/opt\/pvcount\/server\.js/, '访问计数'],
  [/node \/opt\/blog-admin\/server\.js/, '博客后台'],
  [/node \/opt\/yhsq-admin\/server\.js/, 'Luosu 授权后台'],
  [/node \/opt\/napcat-bot\/main\.js/, '机器人服务'],
  [/^\/proc\/self\/exe --type=utility/, 'NapCat 子进程'],
  [/\/Napcat\/opt\/QQ\/qq/, 'NapCat（QQ）'],
  [/^Xvfb /, '虚拟显示器'],
  [/^node -e /, '临时调试服务'],
  [/^nginx: master/, 'nginx 主进程'],
  [/^nginx: worker/, 'nginx 工作进程'],
  [/^nginx: cache/, 'nginx 缓存管理'],
  [/^php-fpm: master/, 'PHP 主进程'],
  [/^php-fpm: pool/, 'PHP 工作进程'],
  [/mysqld_safe/, 'MySQL 守护脚本'],
  [/\/mysql\/bin\/mysqld/, 'MySQL 数据库'],
  [/BT-Panel/, '宝塔面板'],
  [/BT-Task/, '宝塔计划任务'],
  [/systemd-journald/, '系统日志'],
  [/systemd-udevd/, '设备管理'],
  [/systemd-logind/, '登录管理'],
  [/systemd-timesyncd/, '时间同步'],
  [/systemd --user/, '用户态 systemd'],
  [/dbus-daemon/, '消息总线'],
  [/rsyslogd/, '日志收集'],
  [/\/usr\/sbin\/cron -f/, '定时任务'],
  [/\/usr\/sbin\/atd/, '延时任务'],
  [/agetty/, '终端登录'],
  [/qemu-ga/, '云主机代理'],
  [/^\(sd-pam\)/, '登录会话辅助'],
  [/^\/sbin\/init/, '系统初始化'],
  [/sshd/, 'SSH 服务']
];

// 内核线程：ps 里命令带方括号（[kworker/0:1] 等），对运维没有意义
function isKernelProc(p) {
  return !p.args || p.args.charAt(0) === '[';
}

function procName(p) {
  var a = p.args || '';
  for (var i = 0; i < PROC_NAMES.length; i++) {
    if (PROC_NAMES[i][0].test(a)) return PROC_NAMES[i][1];
  }
  return '';
}

async function loadProcs() {
  var body = $('procBody');
  body.innerHTML = '<tr><td colspan="9"><div class="empty"><span class="spin"></span></div></td></tr>';
  try {
    var d = await api(API + '/process');
    state.procs = d.list || [];
    renderProcs();
  } catch (e) {
    body.innerHTML = '<tr><td colspan="9">' + emptyHtml(e.message) + '</td></tr>';
  }
}

function renderProcs() {
  var kw = state.procFilter.toLowerCase();
  var all = state.procs;
  var kernelCount = all.filter(isKernelProc).length;
  var list = all.filter(function (p) {
    if (!state.procShowKernel && isKernelProc(p)) return false;
    if (!kw) return true;
    return (p.args || '').toLowerCase().indexOf(kw) >= 0 ||
      procName(p).toLowerCase().indexOf(kw) >= 0 ||
      (p.user || '').toLowerCase().indexOf(kw) >= 0 ||
      String(p.pid).indexOf(kw) >= 0;
  });
  var key = state.procSort.key;
  var dir = state.procSort.dir;
  list.sort(function (a, b) {
    var x = a[key];
    var y = b[key];
    if (typeof x === 'string') return x.localeCompare(y) * dir;
    return (x - y) * dir;
  });

  var hidden = state.procShowKernel ? 0 : kernelCount;
  $('procCount').textContent = list.length + ' / ' + all.length + ' 个进程' +
    (hidden ? ' · 隐藏 ' + hidden + ' 内核' : '');
  var body = $('procBody');
  if (!list.length) { body.innerHTML = '<tr><td colspan="9">' + emptyHtml('没有匹配的进程') + '</td></tr>'; return; }

  body.innerHTML = list.map(function (p) {
    var name = procName(p);
    var cmd = name
      ? '<span class="proc-tag">' + esc(name) + '</span><span class="proc-cmd">' + esc(p.args) + '</span>'
      : esc(p.args);
    return '<tr>' +
      '<td class="num">' + p.pid + '</td>' +
      '<td>' + esc(p.user) + '</td>' +
      '<td class="num">' + p.cpu.toFixed(1) + '</td>' +
      '<td class="num">' + p.mem.toFixed(1) + '</td>' +
      '<td class="num">' + formatBytes(p.rss) + '</td>' +
      '<td>' + esc(p.stat) + '</td>' +
      '<td>' + esc(p.etime) + '</td>' +
      '<td class="args" title="' + esc(p.args) + '">' + cmd + '</td>' +
      '<td><button class="icon-btn" data-kill="' + p.pid + '" title="结束进程">' + I.power + '</button></td>' +
      '</tr>';
  }).join('');
}

function killProc(pid, args) {
  modal({
    title: '结束进程',
    message: 'PID ' + pid + '\n' + String(args || '').slice(0, 160),
    confirmText: '结束进程',
    danger: true,
    onConfirm: async function () {
      await api(API + '/process/kill', { json: { pid: Number(pid), signal: 'SIGTERM' } });
      toast('已发送结束信号给 PID ' + pid);
      loadProcs();
    }
  });
}

/* ==================== 通知 ==================== */

var LEVEL_ICON = { critical: I.alert, warning: I.alert, info: I.info };

async function loadNotify() {
  try {
    var d = await api(API + '/notify?limit=100');
    state.notifications = d.notifications || [];
    renderNotify();
  } catch (e) { /* ignore */ }
}

function renderNotify() {
  var list = state.notifications || [];
  var unread = list.filter(function (n) { return !n.read; }).length;

  $('bellDot').classList.toggle('show', unread > 0);
  $('dockDot').classList.toggle('show', unread > 0);
  var badge = $('navBadge');
  badge.textContent = unread > 99 ? '99+' : unread;
  badge.classList.toggle('show', unread > 0);

  var box = $('notifyList');
  if (!box) return;
  if (!list.length) { box.innerHTML = emptyHtml('暂无通知'); return; }
  box.innerHTML = list.map(function (n) {
    var lv = n.level === 'critical' ? 'critical' : (n.level === 'warning' ? 'warning' : 'info');
    return '<div class="notify-item ' + lv + (n.read ? '' : ' unread') + '" data-id="' + esc(n.id) + '">' +
      '<div class="notify-icon">' + (LEVEL_ICON[lv] || I.info) + '</div>' +
      '<div class="notify-body">' +
      '<div class="notify-title">' + esc(n.title) + '</div>' +
      '<div class="notify-msg">' + esc(n.message) + '</div>' +
      '<div class="notify-time">' + relTime(n.ts) + ' · ' + formatTime(n.ts) + '</div>' +
      '</div></div>';
  }).join('');

  // 兜底：若当前不在通知页也保持红点同步
  if (state.view !== 'notify' && unread === 0) { /* noop */ }
}

/* ==================== 服务（pm2） ==================== */

var SVC_STATUS = {
  online: ['green', '运行中'],
  stopped: ['gray', '已停止'],
  errored: ['red', '异常'],
  stopping: ['orange', '停止中'],
  launching: ['orange', '启动中'],
  'one-launch-status': ['orange', '启动中']
};
var SVC_ACT_NAME = { restart: '重启', start: '启动', stop: '停止' };

async function loadServices() {
  var box = $('svcList');
  if (!box) return;
  try {
    var d = await api(API + '/pm2');
    state.services = d.apps || [];
    renderServices();
  } catch (e) {
    box.innerHTML = emptyHtml(e.message);
  }
}

function renderServices() {
  var box = $('svcList');
  var apps = state.services || [];
  var counter = $('svcCount');
  if (counter) {
    var online = apps.filter(function (a) { return a.status === 'online'; }).length;
    counter.textContent = online + ' / ' + apps.length + ' 运行中';
  }
  if (!apps.length) { box.innerHTML = emptyHtml('未发现 pm2 进程'); return; }

  box.innerHTML = apps.map(function (a) {
    var sm = SVC_STATUS[a.status] || ['gray', a.status];
    var isAdmin = a.name === 'admin';
    var running = a.status === 'online';

    var toggle = running
      ? '<button class="btn btn-sm btn-danger" data-act="stop" data-name="' + esc(a.name) + '"' +
        (isAdmin ? ' disabled title="面板自身不可停止，否则将无法远程恢复"' : '') + '>停止</button>'
      : '<button class="btn btn-sm btn-primary" data-act="start" data-name="' + esc(a.name) + '">启动</button>';
    var logBtn = a.logFile
      ? '<button class="btn btn-sm" data-act="log" data-name="' + esc(a.name) +
        '" data-log="' + esc(a.logFile) + '">日志</button>'
      : '';

    return '<div class="svc-card">' +
      '<div class="svc-top">' +
        '<div class="pm2-name">' + esc(a.name) + '<span class="badge ' + sm[0] + '">' + esc(sm[1]) + '</span></div>' +
        '<button class="switch' + (a.ignored ? ' on' : '') + '" data-act="ignore" data-name="' + esc(a.name) +
          '" data-ignored="' + (a.ignored ? 1 : 0) + '" title="' +
          (a.ignored ? '恢复离线告警' : '忽略离线告警') + '"></button>' +
      '</div>' +
      '<div class="svc-meta">重启 ' + a.restarts + ' 次 · CPU ' + (a.cpu || 0).toFixed(1) +
        '% · 内存 ' + formatBytes(a.mem) + '</div>' +
      '<div class="svc-actions">' +
        '<button class="btn btn-sm" data-act="restart" data-name="' + esc(a.name) + '">重启</button>' +
        toggle + logBtn +
      '</div>' +
    '</div>';
  }).join('');
}

async function svcAction(name, act) {
  var r = await api(API + '/pm2/action', { json: { name: name, act: act } });
  toast('已' + (SVC_ACT_NAME[act] || act) + '「' + name + '」' + (r.pending ? '，面板即将重连…' : ''));
  // 面板重启期间接口不可用，等久一点再刷新
  setTimeout(loadServices, r.pending ? 3500 : 800);
}

function confirmSvcStop(name) {
  modal({
    title: '停止服务',
    message: '将停止 pm2 进程「' + name + '」，对应站点会立即无法访问。确认停止？',
    confirmText: '停止', danger: true,
    onConfirm: function () { return svcAction(name, 'stop'); }
  });
}

async function setSvcIgnore(name, ignored) {
  await api(API + '/pm2/ignore', { json: { name: name, ignored: ignored } });
  toast(ignored ? '已忽略「' + name + '」的离线告警' : '已恢复「' + name + '」的离线告警');
  await loadServices();
}

/* ==================== 密钥（Ax 卡密） ==================== */

// 到期按北京时间的自然日算，与后端 lib/license.js 的 today() 保持一致
function bjToday() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Shanghai' });
}

function keyStatus(k) {
  if (!k.enabled) return ['gray', '已停用'];
  if (!k.expire) return ['green', '永久有效'];
  var today = bjToday();
  if (today > k.expire) return ['red', '已过期'];
  var days = Math.round((Date.parse(k.expire + 'T00:00:00Z') - Date.parse(today + 'T00:00:00Z')) / 86400000);
  if (days <= 0) return ['red', '今天到期'];
  if (days <= 7) return ['orange', days + ' 天后到期'];
  return ['green', '可用 · 剩 ' + days + ' 天'];
}

async function loadKeys() {
  var box = $('keyList');
  if (!box) return;
  box.innerHTML = '<div class="empty"><span class="spin"></span></div>';
  try {
    var d = await api(API + '/license');
    state.keys = d.keys || [];
    renderKeys();
  } catch (e) {
    box.innerHTML = emptyHtml(e.message);
  }
}

function renderKeys() {
  var box = $('keyList');
  var list = state.keys || [];
  var counter = $('keyCount');
  if (counter) {
    var usable = list.filter(function (k) { return keyStatus(k)[0] !== 'gray' && keyStatus(k)[0] !== 'red'; }).length;
    counter.textContent = usable + ' / ' + list.length + ' 可用';
  }
  if (!list.length) { box.innerHTML = emptyHtml('还没有密钥，点「生成密钥」建一个'); return; }

  box.innerHTML = list.map(function (k) {
    var st = keyStatus(k);
    var meta = [];
    if (k.note) meta.push(k.note);
    meta.push(k.expire ? ('到期 ' + k.expire) : '永久有效');
    meta.push('已用 ' + (k.useCount || 0) + ' 次');
    meta.push(k.lastUsedAt ? ('最近 ' + relTime(k.lastUsedAt)) : '从未使用');

    return '<div class="svc-card">' +
      '<div class="svc-top">' +
        '<div class="pm2-name"><span class="key-code">' + esc(k.key) + '</span>' +
          '<span class="badge ' + st[0] + '">' + esc(st[1]) + '</span></div>' +
        '<button class="switch' + (k.enabled ? ' on' : '') + '" data-act="toggle" data-key="' + esc(k.key) +
          '" data-enabled="' + (k.enabled ? 1 : 0) + '" title="' +
          (k.enabled ? '停用该密钥（App 立刻校验失败）' : '重新启用该密钥') + '"></button>' +
      '</div>' +
      '<div class="svc-meta">' + esc(meta.join(' · ')) + '</div>' +
      '<div class="svc-actions">' +
        '<button class="btn btn-sm" data-act="copy" data-key="' + esc(k.key) + '">复制</button>' +
        '<button class="btn btn-sm" data-act="edit" data-key="' + esc(k.key) + '">编辑</button>' +
        '<button class="btn btn-sm btn-danger" data-act="remove" data-key="' + esc(k.key) + '">删除</button>' +
      '</div>' +
    '</div>';
  }).join('');
}

function findKey(key) {
  return (state.keys || []).find(function (x) { return x.key === key; });
}

function newKey() {
  modal({
    title: '生成密钥',
    message: '到期日留空表示永久有效，格式 YYYY-MM-DD。生成后立即生效。',
    inputs: [
      { placeholder: '备注（给谁 / 什么用途）' },
      { placeholder: '到期日 YYYY-MM-DD（留空 = 永久）' }
    ],
    confirmText: '生成',
    onConfirm: async function (vals) {
      var d = await api(API + '/license/create', { json: { note: vals[0], expire: vals[1] } });
      copyText(d.item.key, '已生成并复制：' + d.item.key);
      loadKeys();
    }
  });
}

function editKey(key) {
  var k = findKey(key);
  if (!k) { loadKeys(); return; }
  modal({
    title: '编辑密钥',
    message: k.key,
    inputs: [
      { placeholder: '备注', value: k.note || '' },
      { placeholder: '到期日 YYYY-MM-DD（留空 = 永久）', value: k.expire || '' }
    ],
    confirmText: '保存',
    onConfirm: async function (vals) {
      await api(API + '/license/update', { json: { key: k.key, note: vals[0], expire: vals[1] } });
      toast('已保存');
      loadKeys();
    }
  });
}

function removeKey(key) {
  modal({
    title: '删除密钥',
    message: '「' + key + '」将被永久删除，已激活的 App 下次校验就会失败。确认删除？',
    confirmText: '删除', danger: true,
    onConfirm: async function () {
      await api(API + '/license/remove', { json: { key: key } });
      toast('已删除');
      loadKeys();
    }
  });
}

async function toggleKey(key, enabled) {
  await api(API + '/license/update', { json: { key: key, enabled: enabled } });
  toast(enabled ? '已启用「' + key + '」' : '已停用「' + key + '」');
  await loadKeys();
}

/* ==================== 部署卡（Claude Code / Termux） ==================== */

// 客户粘的那一条，Termux / Windows 各一份。卡密写死在命令里，所以别外传。
// 带上客户自己的 Key 时，Key 走环境变量而不是 URL —— URL 会被 nginx 和
// Cloudflare 记进访问日志，Key 就留在了服务器上，而这张卡跟 Key 无关。
// Windows 走 irm | iex（PowerShell 官方安装方式，脚本只在管道里过一遍、不落盘）。
function ccInstallCmd(k, apiKey, platform) {
  var host = state.ccHost || location.origin;
  var url = host + '/api/cc/install?key=' + k.key;
  var key = String(apiKey || '').trim();
  if (platform === 'win') {
    var ps = "irm '" + url + "&os=win' | iex";
    if (!key) return ps;
    return "$env:CC_API_KEY='" + key + "'; " + ps;
  }
  var cmd = "curl -fsSL '" + url + "' -o cc.sh && bash cc.sh";
  if (!key) return cmd;
  return "curl -fsSL '" + url + "' -o cc.sh && CC_API_KEY='" + key + "' bash cc.sh";
}

// 卡片上两行命令的平台标签：客户看到的第一眼就知道哪条是自己的
function ccCmdLine(os, cmd) {
  return '<div class="cc-cmd-line"><span class="cc-cmd-os">' + os + '</span>' +
    '<span class="cc-cmd-text">' + esc(cmd) + '</span></div>';
}

// 机型由客户端上报，拿不到时退回 did 前缀 —— 至少能区分是哪台机器
function ccDeviceWho(k) {
  return k.deviceLabel || ('设备 ' + String(k.deviceId || '').slice(0, 8));
}

function ccDeviceText(k) {
  if (!k.deviceId) return '未绑定设备，客户首次部署时自动绑定';
  return '已绑定 ' + ccDeviceWho(k) + (k.boundAt ? '（' + formatTime(k.boundAt) + '）' : '');
}

// 客户把 Key 发过来时，替他拼好一条能直接粘的命令；Key 不经过服务器，只在本机拼字符串
function ccCmdWithKey(key, platform) {
  var win = platform === 'win';
  var where = win ? '在 Windows 的 PowerShell 里粘一次就能装完（会自动装好 Node 和 Git）。' : '粘进 Termux 就能一口气装完。';
  modal({
    title: win ? '带 Key 的 Windows 部署命令' : '带 Key 的部署命令',
    message: '粘贴客户自己的 DeepSeek Key（sk-...），拼好的命令复制给他，' + where + 'Key 只在你的浏览器里拼接，不会上传。',
    input: { placeholder: 'sk-...' },
    confirmText: '复制命令',
    onConfirm: function (val) {
      var k = String(val || '').trim();
      if (!k) throw new Error('没填 Key');
      if (!/^[A-Za-z0-9._-]+$/.test(k)) throw new Error('Key 只能包含字母、数字和 . _ -');
      copyText(ccInstallCmd(findCc(key) || { key: key }, k, win ? 'win' : ''), '带 Key 的部署命令已复制');
    }
  });
}

async function loadCc() {
  var box = $('ccList');
  if (!box) return;
  box.innerHTML = '<div class="empty"><span class="spin"></span></div>';
  try {
    var d = await api(API + '/cc');
    state.ccKeys = d.keys || [];
    state.ccHost = String(d.host || '').replace(/\/+$/, '');
    renderCc();
  } catch (e) {
    box.innerHTML = emptyHtml(e.message);
  }
}

function renderCc() {
  var box = $('ccList');
  var list = state.ccKeys || [];
  var counter = $('ccCount');
  if (counter) {
    var usable = list.filter(function (k) { return keyStatus(k)[0] !== 'gray' && keyStatus(k)[0] !== 'red'; }).length;
    counter.textContent = usable + ' / ' + list.length + ' 可用';
  }
  if (!list.length) { box.innerHTML = emptyHtml('还没有部署卡，点「发一张卡」建一张'); return; }

  box.innerHTML = list.map(function (k) {
    var st = keyStatus(k);
    var meta = [];
    if (k.note) meta.push(k.note);
    meta.push(k.expire ? ('到期 ' + k.expire) : '永久有效');
    meta.push('部署 ' + (k.installCount || 0) + ' 次');
    meta.push('校验 ' + (k.checkCount || 0) + ' 次');
    meta.push(k.lastCheckAt ? ('最近 ' + relTime(k.lastCheckAt)) : '从未使用');

    return '<div class="svc-card">' +
      '<div class="svc-top">' +
        '<div class="pm2-name"><span class="key-code">' + esc(k.key) + '</span>' +
          '<span class="badge ' + st[0] + '">' + esc(st[1]) + '</span></div>' +
        '<button class="switch' + (k.enabled ? ' on' : '') + '" data-act="toggle" data-key="' + esc(k.key) +
          '" data-enabled="' + (k.enabled ? 1 : 0) + '" title="' +
          (k.enabled ? '封停该卡（之后无法再用它部署）' : '恢复该卡') + '"></button>' +
      '</div>' +
      '<div class="svc-meta">' + esc(meta.join(' · ')) + '</div>' +
      '<div class="cc-dev">' + esc(ccDeviceText(k)) + '</div>' +
      '<div class="svc-meta"><span class="cc-endpoint">端点 ' + esc(k.baseUrl || '') +
        ' · ' + esc(k.model || '') + '</span></div>' +
      '<div class="cc-cmd">' +
        ccCmdLine('Termux', ccInstallCmd(k)) +
        ccCmdLine('Windows', ccInstallCmd(k, '', 'win')) +
      '</div>' +
      '<div class="svc-actions">' +
        '<button class="btn btn-sm btn-primary" data-act="cmdkey" data-key="' + esc(k.key) + '">带 Key 命令</button>' +
        '<button class="btn btn-sm" data-act="cmdkeywin" data-key="' + esc(k.key) + '">带 Key 命令 (Win)</button>' +
        '<button class="btn btn-sm" data-act="cmd" data-key="' + esc(k.key) + '">复制 Termux 命令</button>' +
        '<button class="btn btn-sm" data-act="cmdwin" data-key="' + esc(k.key) + '">复制 Windows 命令</button>' +
        '<button class="btn btn-sm" data-act="copy" data-key="' + esc(k.key) + '">复制卡密</button>' +
        '<button class="btn btn-sm" data-act="edit" data-key="' + esc(k.key) + '">编辑</button>' +
        (k.deviceId ? '<button class="btn btn-sm" data-act="unbind" data-key="' + esc(k.key) + '">解绑设备</button>' : '') +
        '<button class="btn btn-sm btn-danger" data-act="remove" data-key="' + esc(k.key) + '">删除</button>' +
      '</div>' +
    '</div>';
  }).join('');
}

function findCc(key) {
  return (state.ccKeys || []).find(function (x) { return x.key === key; });
}

function newCc() {
  modal({
    title: '发一张部署卡',
    message: '卡密只决定「能不能装」，服务器不存任何 API Key —— 客户用自己的 Key，由部署命令带进去。发卡后部署命令会自动复制。',
    inputs: [
      { placeholder: '备注（卖给谁 / 什么用途）' },
      { placeholder: '到期日 YYYY-MM-DD（留空 = 永久）' }
    ],
    confirmText: '发卡',
    onConfirm: async function (vals) {
      var d = await api(API + '/cc/create', {
        json: { note: vals[0], expire: vals[1] }
      });
      await loadCc();
      copyText(ccInstallCmd(d.item), '已发卡，Termux 部署命令已复制');
    }
  });
}

function editCc(key) {
  var k = findCc(key);
  if (!k) { loadCc(); return; }
  modal({
    title: '编辑部署卡',
    message: k.key,
    inputs: [
      { placeholder: '备注', value: k.note || '' },
      { placeholder: '到期日 YYYY-MM-DD（留空 = 永久）', value: k.expire || '' },
      { placeholder: '模型', value: k.model || '' },
      { placeholder: 'small/fast 模型', value: k.smallModel || '' },
      { placeholder: '上游端点', value: k.baseUrl || '' }
    ],
    confirmText: '保存',
    onConfirm: async function (vals) {
      await api(API + '/cc/update', {
        json: { key: k.key, note: vals[0], expire: vals[1], model: vals[2], smallModel: vals[3], baseUrl: vals[4] }
      });
      toast('已保存');
      loadCc();
    }
  });
}

function unbindCc(key) {
  var k = findCc(key);
  var who = k ? ccDeviceWho(k) : '当前设备';
  modal({
    title: '解绑设备',
    message: '「' + key + '」将解除与「' + who + '」的绑定。客户拿着同一条部署命令就能在新手机上重装；已经装好的旧机器不受影响。',
    confirmText: '解绑',
    onConfirm: async function () {
      await api(API + '/cc/unbind', { json: { key: key } });
      toast('已解绑');
      loadCc();
    }
  });
}

function removeCc(key) {
  modal({
    title: '删除部署卡',
    message: '「' + key + '」将被永久删除，之后无法再用它部署（已装好的机器不受影响）。确认删除？',
    confirmText: '删除', danger: true,
    onConfirm: async function () {
      await api(API + '/cc/remove', { json: { key: key } });
      toast('已删除');
      loadCc();
    }
  });
}

async function toggleCc(key, enabled) {
  await api(API + '/cc/update', { json: { key: key, enabled: enabled } });
  toast(enabled ? '已恢复「' + key + '」' : '已封停「' + key + '」');
  await loadCc();
}

/* ==================== 主题 ==================== */

// 主题偏好存在本地；head 里的内联脚本已按同一规则先定好 data-theme，避免白闪
function themePref() {
  var t = 'auto';
  try { t = localStorage.getItem('theme') || 'auto'; } catch (e) { /* ignore */ }
  return (t === 'light' || t === 'dark') ? t : 'auto';
}

function themeIsDark(pref) {
  if (pref === 'dark') return true;
  if (pref === 'light') return false;
  return !!(window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches);
}

function applyThemePref(pref) {
  var dark = themeIsDark(pref);
  document.documentElement.setAttribute('data-theme', dark ? 'dark' : 'light');
  // 只换 span 里的图标，别整个重建按钮内容：.icon-btn 的对齐靠的就是这层 span
  var btn = $('btnTheme');
  if (!btn) return;
  (btn.querySelector('span') || btn).innerHTML = I[dark ? 'sun' : 'moon'];
}

function setThemePref(pref) {
  try { localStorage.setItem('theme', pref); } catch (e) { /* ignore */ }
  applyThemePref(pref);
}

function toggleTheme() {
  var next = themeIsDark(document.documentElement.getAttribute('data-theme')) ? 'light' : 'dark';
  setThemePref(next);
  var sel = $('setTheme');
  if (sel) sel.value = next;
}

function initTheme() {
  applyThemePref(themePref());
  // 跟随系统时，系统深浅切换要即时反映到已打开的页面
  if (window.matchMedia) {
    var mq = window.matchMedia('(prefers-color-scheme: dark)');
    var onChange = function () { if (themePref() === 'auto') applyThemePref('auto'); };
    if (mq.addEventListener) mq.addEventListener('change', onChange);
    else if (mq.addListener) mq.addListener(onChange);
  }
}

/* ==================== Logo ==================== */

// v 为 0 表示未自定义，回退到内置 public/logo.png
function logoUrl(v) { return v ? (API + '/branding/logo?v=' + v) : 'logo.png'; }

function applyLogo(v) {
  var imgs = document.querySelectorAll('[data-logo]');
  for (var i = 0; i < imgs.length; i++) imgs[i].src = logoUrl(v);
  if ($('favicon')) $('favicon').href = logoUrl(v);
  if ($('logoPreview')) $('logoPreview').src = logoUrl(v);
}

// 居中裁成正方形再缩放：先按「铺满」比例放大，再取中心，避免留白与变形
function squarePng(img, size) {
  if (!img.width || !img.height) throw new Error('图片尺寸无效');
  var c = document.createElement('canvas');
  c.width = size; c.height = size;
  var ctx = c.getContext('2d');
  var scale = Math.max(size / img.width, size / img.height);
  var w = img.width * scale, h = img.height * scale;
  ctx.drawImage(img, (size - w) / 2, (size - h) / 2, w, h);
  return c.toDataURL('image/png');
}

function uploadLogo(file) {
  if (!file) return;
  if (!/^image\//.test(file.type)) { toast('请选择图片文件', true); return; }
  var reader = new FileReader();
  reader.onload = function () {
    var img = new Image();
    img.onload = function () {
      var dataUrl;
      try { dataUrl = squarePng(img, 256); }
      catch (e) { toast(e.message, true); return; }
      api(API + '/settings/logo', { json: { data: dataUrl } })
        .then(function (d) { applyLogo(d.logo); toast('Logo 已更新'); })
        .catch(function (err) { toast(err.message, true); });
    };
    img.onerror = function () { toast('图片读取失败', true); };
    img.src = reader.result;
  };
  reader.onerror = function () { toast('图片读取失败', true); };
  reader.readAsDataURL(file);
}

function resetLogo() {
  modal({
    title: '恢复默认 Logo',
    message: '将删除自定义 Logo，全站恢复使用内置图标。',
    confirmText: '恢复默认', danger: true,
    onConfirm: async function () {
      var d = await api(API + '/settings/logo', { method: 'DELETE' });
      applyLogo(d.logo);
      toast('已恢复默认 Logo');
    }
  });
}

/* ==================== 云资源（雨云） ==================== */

function assetBadge(n) {
  if (n == null) return { cls: 'gray', text: '长期' };
  if (n < 0) return { cls: 'red', text: '已到期' };
  if (n === 0) return { cls: 'red', text: '今天到期' };
  if (n <= 3) return { cls: 'red', text: '剩 ' + n + ' 天' };
  if (n <= 7) return { cls: 'orange', text: '剩 ' + n + ' 天' };
  return { cls: 'green', text: '剩 ' + n + ' 天' };
}

function assetDate(ms) {
  if (!ms) return '—';
  var d = new Date(ms);
  var p = function (n) { return (n < 10 ? '0' : '') + n; };
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
}

function assetCard(kind, name, meta, expireAt, daysLeft, footRight) {
  var b = assetBadge(daysLeft);
  return '<div class="asset-item">' +
    '<div class="asset-head"><span class="asset-kind">' + esc(kind) + '</span>' +
    '<span class="badge ' + b.cls + '">' + esc(b.text) + '</span></div>' +
    '<div class="asset-name">' + esc(name) + '</div>' +
    '<div class="asset-meta">' + esc(meta || '—') + '</div>' +
    '<div class="asset-foot"><span>到期 ' + esc(assetDate(expireAt)) + '</span>' +
    '<span>' + esc(footRight || '—') + '</span></div>' +
    '</div>';
}

function renderAssets(d) {
  var grid = $('assetGrid');
  var sec = $('assetSection');
  if (!grid || !sec) return;
  var servers = (d && d.servers) || [];
  var domains = (d && d.domains) || [];
  if (!d || d.enabled === false || (!servers.length && !domains.length)) { sec.hidden = true; return; }

  var html = '';
  servers.forEach(function (s) {
    var meta = [
      s.ip,
      s.spec,
      s.diskGB ? s.diskGB + 'G 硬盘' : '',
      s.netMbps ? s.netMbps + 'M 带宽' : '',
      s.autoRenew ? '自动续费' : '手动续费'
    ].filter(Boolean).join(' · ');
    html += assetCard('云服务器', s.name + (s.plan ? ' · ' + s.plan : ''), meta, s.expireAt, s.daysLeft,
      s.renewPrice != null ? '续费 ¥' + s.renewPrice : '—');
  });
  domains.forEach(function (x) {
    html += assetCard('域名', x.name, x.locked ? '已开启转移锁' : '', x.expireAt, x.daysLeft,
      x.renewPrice != null ? '续费 ¥' + x.renewPrice : '—');
  });
  if (d.stale || d.error) {
    html += '<div class="asset-item"><div class="asset-kind">提示</div>' +
      '<div class="asset-meta">以下是缓存数据，刷新雨云失败：' + esc(d.error || '') + '</div></div>';
  }
  grid.innerHTML = html;
  sec.hidden = false;
}

async function loadAssets(force) {
  try {
    renderAssets(await api(API + '/rainyun' + (force ? '?refresh=1' : '')));
  } catch (e) {
    // 雨云不通不该打断概览，静默即可（通知中心里会有对应的推送）
  }
}

/* ==================== 设置 ==================== */

// 面板名以服务端配置为准，改动后立即同步侧栏品牌与浏览器标题
function applyPanelName(name) {
  if (!name) return;
  var b = $('brandName');
  if (b) b.textContent = name;
  document.title = name;
}

async function loadSettings() {
  try {
    var d = await api(API + '/settings');
    $('setName').value = d.name || '';
    $('setDays').value = d.sessionDays || 30;
    if ($('setTheme')) $('setTheme').value = themePref();
    applyLogo(d.logo);
    var ry = d.rainyun || {};
    if ($('setRyDays')) $('setRyDays').value = ry.expireWarnDays || 7;
    if ($('swRainyun')) $('swRainyun').classList.toggle('on', !!ry.enabled);
    if ($('setRyKey')) $('setRyKey').placeholder = ry.hasKey ? '已保存，留空则不修改' : '在雨云控制台「API 密钥」处获取';
    applyModules(d.modules || {});
  } catch (e) {
    toast(e.message, true);
  }
}

// 回填模块开关与参数。only 传了就只动那一个模块 —— 免得保存 A 卡片时
// 把 B 卡片里还没保存的输入冲掉
function applyModules(m, only) {
  var wl = m.weblog || {}, dl = m.download || {}, dv = m.drive || {}, cc = m.cc || {}, dc = m.decoy || {};
  if (!only || only === 'weblog') {
    if ($('swModWeblog')) $('swModWeblog').classList.toggle('on', !!wl.enabled);
    if ($('setWeblogDays')) $('setWeblogDays').value = wl.retentionDays || 92;
  }
  if (!only || only === 'download') {
    if ($('swModDownload')) $('swModDownload').classList.toggle('on', !!dl.enabled);
    if ($('setDlConns')) $('setDlConns').value = dl.connections || 4;
  }
  if (!only || only === 'drive') {
    if ($('swModDrive')) $('swModDrive').classList.toggle('on', !!dv.enabled);
    if ($('setDriveQuota')) $('setDriveQuota').value = dv.diskQuotaGB || 0;
    if ($('setDriveUpload')) $('setDriveUpload').value = dv.maxUploadMB || 2048;
  }
  if (!only || only === 'cc') {
    if ($('swModCc')) $('swModCc').classList.toggle('on', !!cc.enabled);
    if ($('setCcHost')) $('setCcHost').value = cc.host || '';
  }
  if (!only || only === 'decoy') {
    if ($('swModDecoy')) $('swModDecoy').classList.toggle('on', !!dc.enabled);
    if ($('swDecoyNotify')) $('swDecoyNotify').classList.toggle('on', !!dc.notify);
    if ($('swDecoyExternal')) $('swDecoyExternal').classList.toggle('on', !!dc.external);
    if ($('setDecoyPaths')) $('setDecoyPaths').value = (dc.paths || []).join('\n');
  }
}

async function saveGeneral() {
  var name = $('setName').value.trim();
  var days = parseInt($('setDays').value, 10);
  var d = await api(API + '/settings/general', { json: { name: name, sessionDays: days } });
  applyPanelName(d.name);
  toast('已保存：' + d.name + ' · 会话 ' + d.sessionDays + ' 天');
}

function changePanelKey() {
  var cur = $('setKeyCur').value;
  var next = $('setKeyNew').value;
  if (!cur || !next) { toast('请填写当前密钥和新密钥', true); return; }
  modal({
    title: '修改登录密钥',
    message: '改完立即生效，旧密钥作废。config.json 里只存不可逆指纹，新密钥请自己记牢——丢了找不回来。',
    confirmText: '确认修改',
    onConfirm: async function () {
      await api(API + '/settings/key', { json: { current: cur, next: next } });
      $('setKeyCur').value = '';
      $('setKeyNew').value = '';
      toast('登录密钥已更新');
    }
  });
}

async function saveRainyun() {
  var key = $('setRyKey').value.trim();
  var days = parseInt($('setRyDays').value, 10);
  var enabled = $('swRainyun').classList.contains('on');
  var d = await api(API + '/settings/rainyun', { json: { apiKey: key, expireWarnDays: days, enabled: enabled } });
  $('setRyKey').value = '';
  $('setRyKey').placeholder = d.hasKey ? '已保存，留空则不修改' : '在雨云控制台「API 密钥」处获取';
  toast(d.enabled ? '雨云监控已启用' : '雨云配置已保存（未启用）');
  loadAssets(true);
}

// 四个模块的保存：服务端各自校验，回的是整份模块状态，这里只回填自己那一段
async function saveModule(key, payload) {
  var d = await api(API + '/settings/modules/' + key, { json: payload });
  applyModules(d.modules || {}, key);
  toast('已保存');
  // 开关会影响侧栏入口，改完重新拉一次 features
  try { applyFeatures((await api(API + '/meta')).features); } catch (e) { /* ignore */ }
}

function rotateSession() {
  modal({
    title: '重新生成会话密钥',
    message: '所有已登录的设备 / 浏览器（含任何伪造的 token）会立刻失效，你自己会自动续签、不掉线。确认重新生成？',
    confirmText: '重新生成', danger: true,
    onConfirm: async function () {
      await api(API + '/settings/session/rotate', { json: {} });
      toast('会话密钥已轮换，其它设备已全部下线');
    }
  });
}

/* ==================== WebSocket（指标推送） ==================== */

function connectMonitor() {
  var proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  var ws;
  try { ws = new WebSocket(proto + '//' + location.host + '/ws/monitor'); }
  catch (e) { setTimeout(connectMonitor, 5000); return; }

  ws.onmessage = function (ev) {
    var m = null;
    try { m = JSON.parse(ev.data); } catch (e) { return; }
    if (m.type === 'snapshot') {
      state.snapshot = m.data;
      if (state.view === 'overview') { renderStats(m.data); renderInfo(m.data); }
    } else if (m.type === 'history') {
      state.history = m.data || [];
      if (state.view === 'overview') drawChart();
    } else if (m.type === 'visit') {
      // 实时访客由 lib/weblog.js 每秒攒一批推过来，只有停在该视图时才渲染
      if (state.view === 'stats') statsOnVisit(m.data);
    } else if (m.type === 'notifications') {
      state.notifications = m.data || [];
      renderNotify();
    } else if (m.type === 'notification') {
      state.notifications.unshift(m.data);
      if (state.notifications.length > 200) state.notifications.pop();
      renderNotify();
      toast('【' + (m.data.level === 'critical' ? '严重' : '提示') + '】' + m.data.message, m.data.level === 'critical');
    }
  };
  ws.onclose = function () { setTimeout(connectMonitor, 5000); };
}

/* ==================== 事件绑定 ==================== */

function bindEvents() {
  // 导航
  document.addEventListener('click', function (e) {
    var nav = e.target.closest && e.target.closest('[data-view]');
    if (nav) { setView(nav.getAttribute('data-view')); return; }
  });

  // 顶栏
  $('btnRefresh').onclick = function () {
    if (state.view === 'sites') loadSites();
    else if (state.view === 'files') loadFiles(state.filesPath);
    else if (state.view === 'download') loadDownloads();
    else if (state.view === 'drive') loadDrive();
    else if (state.view === 'draw') drawInit();
    else if (state.view === 'logs') { loadLogs(); tailLog(); }
    else if (state.view === 'process') loadProcs();
    else if (state.view === 'services') loadServices();
    else if (state.view === 'cc') loadCc();
    else if (state.view === 'keys') loadKeys();
    else if (state.view === 'notify') loadNotify();
    else if (state.view === 'stats') statsReload();
    else if (state.view === 'gf') gfReload();
    else if (state.view === 'settings') loadSettings();
    else toast('已刷新');
  };
  $('btnBell').onclick = function () { setView('notify'); };
  $('btnTheme').onclick = toggleTheme;
  $('btnLogout').onclick = doLogout;
  $('btnLogout2').onclick = doLogout;

  // 站点
  $('btnRefreshSites').onclick = loadSites;
  $('btnTakeoverAll').onclick = takeoverAll;
  $('siteList').addEventListener('click', function (e) {
    var el = e.target.closest('[data-act]');
    if (!el) return;
    var domain = el.getAttribute('data-domain');
    var act = el.getAttribute('data-act');
    if (act === 'takeover') { takeoverSite(domain).catch(function (err) { toast(err.message, true); }); return; }
    if (act === 'uptime') {
      setUptimeIgnore(domain, el.getAttribute('data-ignored') !== '1')
        .catch(function (err) { toast(err.message, true); });
      return;
    }
    if (act === 'renew') {
      modal({
        title: '续签证书',
        message: '将对「' + domain + '」对应的证书执行强制续签，并自动重新加载 nginx。连续操作可能触发 CA 频率限制，确认继续？',
        confirmText: '开始续签',
        // 不 await：续签要几十秒，避免弹窗一直转圈
        onConfirm: function () { renewCert(domain); }
      });
      return;
    }
    if (act === 'toggle') {
      var blocked = el.getAttribute('data-blocked') === '1';
      var doIt = function () { toggleSite(domain, !blocked).catch(function (err) { toast(err.message, true); }); };
      if (!blocked) {
        modal({
          title: '禁止访问', message: '站点「' + domain + '」将对所有访客显示维护页，确认禁止？',
          confirmText: '禁止访问', danger: true, onConfirm: doIt
        });
      } else { doIt(); }
    }
  });

  // 文件
  $('btnRefreshFiles').onclick = function () { loadFiles(state.filesPath); };
  $('btnUp').onclick = function () {
    if (!state.filesPath) return;
    var parent = state.filesPath.replace(/\/+$/, '').split('/').slice(0, -1).join('/') || '/';
    loadFiles(parent);
  };
  $('crumbs').addEventListener('click', function (e) {
    var cb = e.target.closest('.cb');
    if (cb) loadFiles(cb.getAttribute('data-path'));
  });
  $('btnNewFolder').onclick = function () {
    modal({
      title: '新建文件夹', input: { placeholder: '文件夹名称' }, confirmText: '创建',
      onConfirm: async function (val) {
        await api(API + '/files/mkdir', { json: { path: state.filesPath, name: val } });
        toast('已创建'); loadFiles(state.filesPath);
      }
    });
  };
  $('btnNewFile').onclick = function () {
    modal({
      title: '新建文件', input: { placeholder: '文件名（含扩展名）' }, confirmText: '创建',
      onConfirm: async function (val) {
        await api(API + '/files/touch', { json: { path: state.filesPath, name: val } });
        toast('已创建'); loadFiles(state.filesPath);
      }
    });
  };
  $('btnUpload').onclick = function () { $('fileInput').click(); };
  $('fileInput').onchange = function (e) { uploadFiles(e.target.files); e.target.value = ''; };
  $('fileList').addEventListener('click', function (e) {
    var row = e.target.closest('.file-row');
    if (!row) return;
    var actBtn = e.target.closest('[data-fact]');
    if (actBtn) { fileAction(row, actBtn.getAttribute('data-fact')); return; }
    if (row.getAttribute('data-dir') === '1') loadFiles(row.getAttribute('data-path'));
  });
  $('editorBody').addEventListener('input', function () {
    if (!editorDirty) { editorDirty = true; editorHint('有未保存的改动'); }
  });
  $('btnEditorCancel').onclick = function () { closeEditor(false); };
  $('btnEditorSave').onclick = saveEditor;
  $('editorMask').addEventListener('click', function (e) {
    if (e.target === $('editorMask')) closeEditor(false);
  });

  // 终端
  $('btnTermReconnect').onclick = function () { if (term) connectTerm(); };

  // 日志
  $('logSide').addEventListener('click', function (e) {
    var el = e.target.closest('.log-file');
    if (el) selectLog(el.getAttribute('data-path'), el.getAttribute('data-name'));
  });
  $('btnLogFollow').onclick = function () {
    state.logFollow = !state.logFollow;
    $('btnLogFollow').textContent = state.logFollow ? '暂停跟随' : '开始跟随';
    if (state.logFollow) startLogTimer(); else stopLogTimer();
  };
  $('btnLogClear').onclick = function () {
    if (!state.logFile) return;
    modal({
      title: '清空日志', message: '将清空「' + state.logFile.name + '」的内容，确认？',
      confirmText: '清空', danger: true,
      onConfirm: async function () {
        await api(API + '/logs/flush', { json: { file: state.logFile.path } });
        toast('已清空'); tailLog();
      }
    });
  };

  // 进程
  $('btnRefreshProc').onclick = loadProcs;
  $('procSearch').oninput = function (e) { state.procFilter = e.target.value.trim(); renderProcs(); };
  $('swProcKernel').onclick = function () {
    state.procShowKernel = !state.procShowKernel;
    this.classList.toggle('on', state.procShowKernel);
    renderProcs();
  };
  document.querySelector('table.ptable thead').addEventListener('click', function (e) {
    var th = e.target.closest('th[data-sort]');
    if (!th) return;
    var k = th.getAttribute('data-sort');
    if (state.procSort.key === k) state.procSort.dir = -state.procSort.dir;
    else { state.procSort.key = k; state.procSort.dir = (k === 'args' || k === 'user' || k === 'stat' || k === 'etime') ? 1 : -1; }
    renderProcs();
  });
  $('procBody').addEventListener('click', function (e) {
    var btn = e.target.closest('[data-kill]');
    if (!btn) return;
    var pid = btn.getAttribute('data-kill');
    var row = btn.closest('tr');
    killProc(pid, row.querySelector('.args').textContent);
  });

  // 通知
  $('btnRefreshNotify').onclick = loadNotify;
  $('btnNotifyReadAll').onclick = async function () {
    await api(API + '/notify/read', { json: { all: true } });
    state.notifications.forEach(function (n) { n.read = true; });
    renderNotify();
  };
  $('btnNotifyClear').onclick = function () {
    modal({
      title: '清空通知', message: '将删除全部通知记录，确认？', confirmText: '清空', danger: true,
      onConfirm: async function () {
        await api(API + '/notify/clear', { json: {} });
        state.notifications = []; renderNotify();
      }
    });
  };
  $('notifyList').addEventListener('click', function (e) {
    var item = e.target.closest('.notify-item');
    if (!item || !item.classList.contains('unread')) return;
    var id = item.getAttribute('data-id');
    item.classList.remove('unread');
    var n = state.notifications.find(function (x) { return x.id === id; });
    if (n) n.read = true;
    renderNotify();
    api(API + '/notify/read', { json: { id: id } }).catch(function () { /* ignore */ });
  });
  // 服务
  $('btnRefreshServices').onclick = loadServices;
  $('svcList').addEventListener('click', function (e) {
    var el = e.target.closest('[data-act]');
    if (!el) return;
    var name = el.getAttribute('data-name');
    var act = el.getAttribute('data-act');
    if (act === 'ignore') {
      setSvcIgnore(name, el.getAttribute('data-ignored') !== '1')
        .catch(function (err) { toast(err.message, true); });
    } else if (act === 'log') {
      selectLog(el.getAttribute('data-log'), name + '-out.log');
      setView('logs');
    } else if (act === 'stop') {
      confirmSvcStop(name);
    } else {
      svcAction(name, act).catch(function (err) { toast(err.message, true); });
    }
  });

  // 部署卡
  $('btnRefreshCc').onclick = loadCc;
  $('btnNewCc').onclick = newCc;
  $('ccList').addEventListener('click', function (e) {
    var el = e.target.closest('[data-act]');
    if (!el) return;
    var key = el.getAttribute('data-key');
    var act = el.getAttribute('data-act');
    if (act === 'cmd') { copyText(ccInstallCmd(findCc(key) || { key: key }), 'Termux 部署命令已复制'); return; }
    if (act === 'cmdwin') { copyText(ccInstallCmd(findCc(key) || { key: key }, '', 'win'), 'Windows 部署命令已复制'); return; }
    if (act === 'cmdkey') { ccCmdWithKey(key, ''); return; }
    if (act === 'cmdkeywin') { ccCmdWithKey(key, 'win'); return; }
    if (act === 'copy') { copyText(key); return; }
    if (act === 'edit') { editCc(key); return; }
    if (act === 'unbind') { unbindCc(key); return; }
    if (act === 'remove') { removeCc(key); return; }
    if (act === 'toggle') {
      toggleCc(key, el.getAttribute('data-enabled') !== '1')
        .catch(function (err) { toast(err.message, true); });
    }
  });

  // 密钥
  $('btnRefreshKeys').onclick = loadKeys;
  $('btnNewKey').onclick = newKey;
  $('keyList').addEventListener('click', function (e) {
    var el = e.target.closest('[data-act]');
    if (!el) return;
    var key = el.getAttribute('data-key');
    var act = el.getAttribute('data-act');
    if (act === 'copy') { copyText(key); return; }
    if (act === 'edit') { editKey(key); return; }
    if (act === 'remove') { removeKey(key); return; }
    if (act === 'toggle') {
      toggleKey(key, el.getAttribute('data-enabled') !== '1')
        .catch(function (err) { toast(err.message, true); });
    }
  });

  // 设置
  $('btnSaveGeneral').onclick = function () {
    saveGeneral().catch(function (err) { toast(err.message, true); });
  };
  $('btnChangeKey').onclick = changePanelKey;
  $('btnRotateSession').onclick = rotateSession;
  $('setTheme').onchange = function () { setThemePref(this.value); };
  $('btnUploadLogo').onclick = function () { var i = $('logoInput'); i.value = ''; i.click(); };
  $('logoInput').onchange = function () { uploadLogo(this.files && this.files[0]); };
  $('btnResetLogo').onclick = resetLogo;
  $('swRainyun').onclick = function () { this.classList.toggle('on'); };
  $('btnSaveRainyun').onclick = function () {
    saveRainyun().catch(function (err) { toast(err.message, true); });
  };
  // 模块开关与参数
  var sw = ['swModWeblog', 'swModDownload', 'swModDrive', 'swModCc',
    'swModDecoy', 'swDecoyNotify', 'swDecoyExternal'];
  for (var i = 0; i < sw.length; i++) {
    if (!$(sw[i])) continue;
    $(sw[i]).onclick = function () { this.classList.toggle('on'); };
  }
  $('btnSaveWeblog').onclick = function () {
    saveModule('weblog', {
      enabled: $('swModWeblog').classList.contains('on'),
      retentionDays: parseInt($('setWeblogDays').value, 10)
    }).catch(function (err) { toast(err.message, true); });
  };
  $('btnSaveDownload').onclick = function () {
    saveModule('download', {
      enabled: $('swModDownload').classList.contains('on'),
      connections: parseInt($('setDlConns').value, 10)
    }).catch(function (err) { toast(err.message, true); });
  };
  $('btnSaveDrive').onclick = function () {
    saveModule('drive', {
      enabled: $('swModDrive').classList.contains('on'),
      diskQuotaGB: parseInt($('setDriveQuota').value, 10) || 0,
      maxUploadMB: parseInt($('setDriveUpload').value, 10)
    }).catch(function (err) { toast(err.message, true); });
  };
  $('btnSaveCc').onclick = function () {
    saveModule('cc', {
      enabled: $('swModCc').classList.contains('on'),
      host: $('setCcHost').value.trim()
    }).catch(function (err) { toast(err.message, true); });
  };
  // 路径一行一条。校验在服务端做（lib/decoy.js 的 check），不合格整份打回，
  // 免得静默丢掉几条让人以为存上了
  $('btnSaveDecoy').onclick = function () {
    saveModule('decoy', {
      enabled: $('swModDecoy').classList.contains('on'),
      notify: $('swDecoyNotify').classList.contains('on'),
      external: $('swDecoyExternal').classList.contains('on'),
      paths: $('setDecoyPaths').value.split('\n')
    }).catch(function (err) { toast(err.message, true); });
  };
  $('btnRefreshAssets').onclick = function () { loadAssets(true); };

  // 下载
  $('btnDlAdd').onclick = function () { dlAdd(); };
  $('btnDlRefresh').onclick = function () { loadDownloads(); };
  $('btnDlPurge').onclick = function () {
    modal({
      title: '清除已完成',
      message: '清掉所有已完成 / 出错 / 已取消的记录，下载好的文件不受影响。',
      confirmText: '清除',
      onConfirm: async function () {
        var d = await api(API + '/download/purge', { json: {} });
        toast(d.purged ? '已清除 ' + d.purged + ' 条记录' : '没有可清除的记录');
        loadDownloads();
      }
    });
  };
  // 回车即开始下载；链接里带 & 时不会被当成表单提交
  $('dlUrl').onkeydown = function (e) { if (e.key === 'Enter') { e.preventDefault(); dlAdd(); } };
  $('dlList').onclick = function (e) {
    var btn = e.target.closest ? e.target.closest('[data-dact]') : null;
    if (!btn) return;
    var item = btn.closest('.dl-item');
    if (!item) return;
    dlAction(item.getAttribute('data-gid'), btn.getAttribute('data-dact'))
      .catch(function (err) { toast(err.message, true); });
  };

  // 窗口尺寸
  window.addEventListener('resize', function () {
    if (state.view === 'overview') drawChart();
    if (state.view === 'terminal') fitTerm();
    if (state.view === 'logs') { /* pre 自适应 */ }
  });
}

async function doLogout() {
  try { await api(API + '/logout', { json: {} }); } catch (e) { /* ignore */ }
  location.href = '/login';
}

/* ==================== 初始化 ==================== */

(function init() {
  fillIcons(document);
  initTheme();
  bindEvents();

  // 先用缓存里的开关摘掉已关闭的入口，再决定落点（避免落到已关闭的模块）
  try { applyFeatures(JSON.parse(localStorage.getItem(FEATURES_KEY) || 'null')); } catch (e) { /* ignore */ }

  var last = 'overview';
  try { last = localStorage.getItem('view') || 'overview'; } catch (e) { /* ignore */ }
  if (!TITLES[last] || last === 'keys' || featureOff(last)) last = 'overview'; // keys 入口已隐藏，不作为落点
  setView(last);

  connectMonitor();

  // 面板名 / Logo / 功能开关以服务端为准（HTML 里的是内置默认值）
  api(API + '/meta').then(function (d) {
    applyPanelName(d.name);
    applyLogo(d.logo);
    applyFeatures(d.features);
  }).catch(function () { /* ignore */ });

  // 轮询兜底：WebSocket 不通时概览也能更新
  setInterval(function () {
    if (state.view === 'overview') {
      api(API + '/system').then(function (d) {
        if (d.snapshot && d.snapshot.cpu) { renderStats(d.snapshot); renderInfo(d.snapshot); }
        if (d.history) { state.history = d.history; drawChart(); }
      }).catch(function () { /* ignore */ });
    }
  }, 5000);
})();
