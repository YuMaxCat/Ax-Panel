/* ============================================================
   Ax 面板 · 访问统计
   四个分页：实时地图 / 排行榜 / 时段热力 / 流量用量
   数据来自 /api/weblog/*（后端增量解析 nginx access.log 的聚合结果），
   实时访客走既有的 /ws/monitor，消息类型 'visit'。
   ============================================================ */
'use strict';

var WS_TABS = ['map', 'rank', 'heat', 'usage'];
var WS_RANGES = ['today', '7d', '30d'];
// 带版本号是为了绕过 Cloudflare 与浏览器的缓存：重新生成地图数据时把它 +1
var WS_MAP_SRC = 'vendor/china-map.js?v=25';

// 只用于堆叠柱的配色：两种主题下都能看清，所以不走 CSS 变量
var WS_PALETTE = ['#f2739b', '#ff9ec0', '#35c98a', '#ff9f2e', '#8d7cff', '#4bb6e8', '#ffd166', '#b7a7b0'];

// 34 个省级行政区，与地图数据里的名字一致；写死是因为「排行榜」可能在地图脚本
// 还没加载时就被打开，不能依赖 window.CHINA_MAP 来判断
var WS_CN = ['北京市', '天津市', '河北省', '山西省', '内蒙古自治区', '辽宁省', '吉林省', '黑龙江省',
  '上海市', '江苏省', '浙江省', '安徽省', '福建省', '江西省', '山东省', '河南省',
  '湖北省', '湖南省', '广东省', '广西壮族自治区', '海南省', '重庆市', '四川省', '贵州省',
  '云南省', '西藏自治区', '陕西省', '甘肃省', '青海省', '宁夏回族自治区',
  '新疆维吾尔自治区', '台湾省', '香港特别行政区', '澳门特别行政区'];

var WS_CN_SET = (function () {
  var s = {};
  for (var i = 0; i < WS_CN.length; i++) s[WS_CN[i]] = 1;
  return s;
})();

var ws = {
  tab: 'map',
  range: '7d',
  data: null,      // /api/weblog/stats 的返回
  usage: null,     // /api/weblog/usage 的返回
  month: '',
  live: [],
  liveTimer: null,
  mapSvg: '',      // 地图底图只拼一次
  mapState: 0      // 0 未加载 1 加载中 2 就绪
};

function wsEl(id) { return $(id); }

function wsFmt(n) {
  if (n == null) return '—';
  return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

function wsTime(ts) {
  var d = new Date(ts);
  function p(x) { return (x < 10 ? '0' : '') + x; }
  return p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
}

/* ---------- 请求 ---------- */

function wsLoad() {
  var box = wsEl('wsPane-' + ws.tab);
  if (box && !ws.data) box.innerHTML = '<div class="empty"><span class="spin"></span></div>';

  return api(API + '/weblog/stats?range=' + ws.range).then(function (d) {
    ws.data = d;
    wsRender();
  }).catch(function (e) {
    toast(e.message || '统计数据加载失败', true);
  });
}

function wsLoadLive() {
  return api(API + '/weblog/live?limit=40').then(function (d) {
    ws.live = d.data || [];
    if (ws.tab === 'map') wsRenderLive();
  }).catch(function () { /* 实时列表失败不影响主统计 */ });
}

function wsLoadUsage(month) {
  var q = month ? '?month=' + encodeURIComponent(month) : '';
  var box = wsEl('wsPane-usage');
  if (box) box.innerHTML = '<div class="empty"><span class="spin"></span></div>';
  return api(API + '/weblog/usage' + q).then(function (d) {
    ws.usage = d;
    ws.month = d.month;
    wsRenderUsage();
  }).catch(function (e) {
    toast(e.message || '流量数据加载失败', true);
  });
}

/* ---------- 渲染入口 ---------- */

function wsRender() {
  var d = ws.data;
  if (!d) return;
  wsRenderSum(d);
  if (ws.tab === 'map') wsRenderMap(d);
  else if (ws.tab === 'rank') wsRenderRank(d);
  else if (ws.tab === 'heat') wsRenderHeat(d);
  else if (ws.tab === 'usage' && !ws.usage) wsLoadUsage();
}

function wsRenderSum(d) {
  var t = d.totals || {};
  var box = wsEl('wsSum');
  if (!box) return;
  box.innerHTML =
    wsCard('总请求', wsFmt(t.req), '次') +
    wsCard('出向流量', formatBytes(t.out), '') +
    wsCard('入向流量', formatBytes(t.in), '') +
    wsCard('来源地区', wsFmt((d.prov || []).length), '个');
}

function wsCard(k, v, unit) {
  return '<div><div class="k">' + k + '</div><div class="v">' + v +
    (unit ? '<em>' + unit + '</em>' : '') + '</div></div>';
}

/* ---------- 实时地图 ---------- */

// 省份底图 287KB，只在第一次打开地图分页时才拉。就绪返回 true
function wsEnsureMap() {
  if (ws.mapState === 2) return true;
  if (ws.mapState === 1) return false;               // 正在拉，onload 回来自己重画
  ws.mapState = 1;
  var s = document.createElement('script');
  s.src = WS_MAP_SRC;
  s.onload = function () {
    ws.mapState = 2;
    if (ws.tab === 'map') wsRender();
  };
  s.onerror = function () {
    ws.mapState = 0;
    var card = wsEl('wsMapCard');
    if (card) card.innerHTML = '<div class="empty">地图数据加载失败，刷新页面重试</div>';
  };
  document.head.appendChild(s);
  return false;
}

function wsMapBase() {
  if (ws.mapSvg) return ws.mapSvg;
  var m = window.CHINA_MAP;
  var out = ['<svg viewBox="0 0 ' + m.w + ' ' + m.h + '" xmlns="http://www.w3.org/2000/svg"><g>'];
  for (var i = 0; i < m.provinces.length; i++) {
    out.push('<path class="ws-prov" d="' + m.provinces[i].d + '"></path>');
  }
  out.push('</g><g id="wsBub"></g></svg>');
  ws.mapSvg = out.join('');
  return ws.mapSvg;
}

// 地图上认得出的省份（那 34 个），其余一律算「其他」
function wsIsCnProvince(name) { return !!WS_CN_SET[name]; }

function wsRenderMap(d) {
  var box = wsEl('wsPane-map');
  if (!box) return;
  if (!box.getAttribute('data-built')) {
    box.innerHTML =
      '<div class="ws-map-wrap">' +
      '<div class="ws-map-card" id="wsMapCard"><div class="empty"><span class="spin"></span></div></div>' +
      '<div class="ws-live"><div class="ws-live-head"><i class="dot"></i>最近访客' +
      '<span style="flex:1"></span><span class="badge gray" id="wsLiveN">0</span></div>' +
      '<div class="ws-live-list" id="wsLiveList"></div></div>' +
      '</div>';
    box.setAttribute('data-built', '1');
  }
  if (wsEnsureMap()) {
    var card = wsEl('wsMapCard');
    if (card && window.CHINA_MAP) {
      // 底图 287KB，只贴一次，切时间范围时只重画气泡
      if (!wsEl('wsBub')) {
        card.innerHTML = wsMapBase() +
          '<div class="ws-map-foot" id="wsMapFoot"></div>' +
          '<div class="ws-tip" id="wsTip"></div>';
        wsBindTip();
      }
      wsDrawBubbles(d.prov || []);
    }
  }
  wsRenderLive();
}

function wsDrawBubbles(prov) {
  var bub = wsEl('wsBub');
  if (!bub) return;

  var map = {};
  for (var i = 0; i < prov.length; i++) map[prov[i].name] = prov[i].n;

  var list = [];
  for (var j = 0; j < window.CHINA_MAP.provinces.length; j++) {
    var p = window.CHINA_MAP.provinces[j];
    if (!p.n || p.x == null || !map[p.n]) continue;
    list.push({ n: p.n, x: p.x, y: p.y, v: map[p.n] });
  }
  list.sort(function (a, b) { return b.v - a.v; });

  var max = list.length ? list[0].v : 0;
  var html = '';
  for (var k = 0; k < list.length; k++) {
    var it = list[k];
    // 半径按平方根走，否则一个省几万次会把其他省压成一个点
    var r = 4 + 15 * Math.sqrt(it.v / max);
    html += '<g class="ws-bub" data-n="' + it.n + '" data-v="' + it.v + '">' +
      '<circle class="halo" cx="' + it.x + '" cy="' + it.y + '" r="' + r.toFixed(1) + '"></circle>' +
      '<circle class="core" cx="' + it.x + '" cy="' + it.y + '" r="' + Math.max(2, r * 0.36).toFixed(1) + '"></circle>' +
      (r >= 9 ? '<text x="' + it.x + '" y="' + (it.y + 3) + '">' + it.v + '</text>' : '') +
      '</g>';
  }
  bub.innerHTML = html;

  var foot = wsEl('wsMapFoot');
  if (!foot) return;
  var off = [];
  for (var m = 0; m < prov.length; m++) {
    if (!wsIsCnProvince(prov[m].name)) off.push(prov[m]);
  }
  foot.innerHTML = '<span>' + list.length + ' 个省份有访客</span>' +
    (off.length ? '<span>未落图：' + off.slice(0, 6).map(function (o) {
      return wsEsc(o.name) + ' ' + o.n;
    }).join(' · ') + '</span>' : '');
}

function wsBindTip() {
  var card = wsEl('wsMapCard');
  if (!card || card.getAttribute('data-tip')) return;
  card.setAttribute('data-tip', '1');
  var tip = wsEl('wsTip');

  card.addEventListener('mousemove', function (e) {
    var g = e.target.closest && e.target.closest('.ws-bub');
    if (!g || !tip) { if (tip) tip.classList.remove('on'); return; }
    tip.textContent = g.getAttribute('data-n') + ' · ' + wsFmt(g.getAttribute('data-v')) + ' 次';
    tip.classList.add('on');
    var r = card.getBoundingClientRect();
    tip.style.left = (e.clientX - r.left + 12) + 'px';
    tip.style.top = (e.clientY - r.top - 30) + 'px';
  });
  card.addEventListener('mouseleave', function () {
    if (tip) tip.classList.remove('on');
  });
}

function wsRenderLive() {
  var box = wsEl('wsLiveList');
  if (!box) return;
  var n = wsEl('wsLiveN');
  if (n) n.textContent = ws.live.length;
  if (!ws.live.length) {
    box.innerHTML = '<div class="empty">还没有新的访客</div>';
    return;
  }
  var html = '';
  for (var i = 0; i < ws.live.length; i++) {
    var v = ws.live[i];
    html += '<div class="ws-live-row">' +
      '<div class="who"><div class="loc">' + wsEsc(v.loc || v.prov || '未知') + '</div>' +
      '<div class="ip">' + wsEsc(v.ip || '') + ' · ' + wsEsc(v.host || '') + '</div>' +
      '<div class="p" title="' + wsEsc(v.path || '') + '">' + wsEsc(v.path || '') + '</div></div>' +
      '<span class="tm">' + wsTime(v.ts) + '</span></div>';
  }
  box.innerHTML = html;
}

/* ---------- 排行榜 ---------- */

// esc 在 app.js 里可能有别的实现，这里用一个独立名避免撞车
function wsEsc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function wsRankRows(list, mono) {
  if (!list.length) return '<div class="empty">暂无数据</div>';
  var max = list[0].n || 1;
  var html = '';
  for (var i = 0; i < list.length; i++) {
    var pct = Math.max(2, (list[i].n / max) * 100);
    html += '<div class="ws-rrow">' +
      '<div class="top"><span class="nm' + (mono ? ' mono' : '') + '" title="' + wsEsc(list[i].name) + '">' +
      wsEsc(list[i].name) + '</span><span class="n">' + wsFmt(list[i].n) + '</span></div>' +
      '<div class="track"><i style="width:' + pct.toFixed(1) + '%"></i></div></div>';
  }
  return html;
}

function wsRenderRank(d) {
  var box = wsEl('wsPane-rank');
  if (!box) return;

  var cn = [];
  var other = [];
  var prov = d.prov || [];
  for (var i = 0; i < prov.length; i++) {
    (wsIsCnProvince(prov[i].name) ? cn : other).push(prov[i]);
  }

  var ua = d.ua || {};
  var UANAME = { browser: '浏览器', bot: '爬虫 / 脚本', other: '其他' };
  var chips = '';
  for (var k in UANAME) {
    if (ua[k]) chips += '<span class="badge gray">' + UANAME[k] + ' ' + wsFmt(ua[k]) + '</span>';
  }
  var st = d.status || {};
  var STNAME = { s1: '1xx', s2: '2xx', s3: '3xx', s4: '4xx', s5: '5xx' };
  for (var s in STNAME) {
    if (st[s]) chips += '<span class="badge ' + (s === 's4' || s === 's5' ? 'orange' : 'gray') + '">' +
      STNAME[s] + ' ' + wsFmt(st[s]) + '</span>';
  }
  if (!chips) chips = '<span class="badge gray">暂无数据</span>';

  box.innerHTML =
    '<div class="ws-rank-grid">' +
    '<div class="ws-rank-card"><h4>省份排行</h4>' + wsRankRows(cn.slice(0, 12)) + '</div>' +
    '<div class="ws-rank-card"><h4>热门路径 TOP 12</h4>' + wsRankRows((d.paths || []).slice(0, 12), true) + '</div>' +
    '<div class="ws-rank-card"><h4>其他来源</h4>' + wsRankRows(other.slice(0, 12)) + '</div>' +
    '<div class="ws-rank-card"><h4>访客与状态码</h4><div class="ws-chips">' + chips + '</div></div>' +
    '</div>';
}

/* ---------- 时段热力图 ---------- */

function wsRenderHeat(d) {
  var box = wsEl('wsPane-heat');
  if (!box) return;
  var heat = d.heat || [];
  if (!heat.length) {
    box.innerHTML = '<div class="ws-heat-card"><div class="empty">暂无数据</div></div>';
    return;
  }

  var max = 0;
  for (var i = 0; i < heat.length; i++) {
    for (var h = 0; h < 24; h++) {
      if (heat[i].hours[h] > max) max = heat[i].hours[h];
    }
  }

  var html = '<div class="ws-heat"><div></div>';
  for (var x = 0; x < 24; x++) html += '<div class="hh">' + x + '</div>';
  for (var r = 0; r < heat.length; r++) {
    html += '<div class="hd">' + heat[r].date.slice(5) + '</div>';
    for (var c = 0; c < 24; c++) {
      var v = heat[r].hours[c] || 0;
      // 有数据至少给 0.16，免得少的那一格看着像没有
      var op = v ? (0.16 + 0.84 * Math.sqrt(v / max)).toFixed(2) : 0;
      html += '<div class="hc" title="' + heat[r].date + ' ' + c + ' 时 · ' + wsFmt(v) + ' 次">' +
        '<i style="opacity:' + op + '"></i></div>';
    }
  }
  html += '</div><div class="ws-heat-legend"><span>少</span>';
  var steps = [0.16, 0.35, 0.55, 0.78, 1];
  for (var s = 0; s < steps.length; s++) html += '<span style="opacity:' + steps[s] + '"></span>';
  html += '<span>多</span>（最深一格 ' + wsFmt(max) + ' 次）</div>';

  box.innerHTML = '<div class="ws-heat-card">' + html + '</div>';
}

/* ---------- 流量用量 ---------- */

function wsRenderUsage() {
  var box = wsEl('wsPane-usage');
  if (!box || !ws.usage) return;
  var u = ws.usage;
  var hosts = u.hosts || [];
  var rows = u.rows || [];
  var color = {};
  for (var i = 0; i < hosts.length; i++) color[hosts[i]] = WS_PALETTE[i % WS_PALETTE.length];

  var head = '<div class="ws-usage-card"><div class="ws-head" style="margin:0">' +
    '<span class="badge gray">合计出向 ' + formatBytes(u.total.out) + '</span>' +
    '<span class="badge gray">合计入向 ' + formatBytes(u.total.in) + '</span>' +
    '<span class="badge gray">合计请求 ' + wsFmt(u.total.req) + '</span>' +
    '<span style="flex:1"></span>' +
    '<input class="input" type="month" id="wsMonth" value="' + u.month + '" style="width:160px"></div>';

  if (!rows.length) {
    box.innerHTML = head + '<div class="empty">这个月还没有数据</div></div>';
    wsBindMonth();
    return;
  }

  var max = 0;
  for (var r = 0; r < rows.length; r++) if (rows[r].out > max) max = rows[r].out;

  var bars = '';
  for (var j = 0; j < rows.length; j++) {
    var row = rows[j];
    var h = max ? Math.max(1, (row.out / max) * 100) : 0;
    var seg = '';
    for (var k = 0; k < hosts.length; k++) {
      var hb = row.hosts[hosts[k]];
      if (!hb || !hb.out) continue;
      seg += '<i style="height:' + (row.out ? (hb.out / row.out) * 100 : 0).toFixed(2) +
        '%;background:' + color[hosts[k]] + '"></i>';
    }
    // 柱子本身的高度就是当天的量，段高按站点占比分配（column-reverse → 先写的在底部）
    bars += '<div class="ws-bar" style="height:' + h.toFixed(1) + '%" title="' +
      row.date + ' · 出向 ' + formatBytes(row.out) + ' / 入向 ' + formatBytes(row.in) +
      ' · ' + wsFmt(row.req) + ' 次">' + seg +
      '<span class="d">' + row.date.slice(8) + '</span></div>';
  }

  var legend = '';
  for (var m = 0; m < hosts.length; m++) {
    legend += '<div><i style="background:' + color[hosts[m]] + '"></i>' + wsEsc(hosts[m]) + '</div>';
  }

  box.innerHTML = head +
    '<div class="ws-bars">' + bars + '</div>' +
    (legend ? '<div class="ws-legend">' + legend + '</div>' : '') +
    '</div>';
  wsBindMonth();
}

function wsBindMonth() {
  var el = wsEl('wsMonth');
  if (!el) return;
  el.onchange = function () {
    if (this.value) wsLoadUsage(this.value);
  };
}

/* ---------- 交互 ---------- */

function wsInit() {
  var tabs = wsEl('wsTab');
  if (tabs) {
    var btns = tabs.querySelectorAll('[data-tab]');
    for (var i = 0; i < btns.length; i++) {
      btns[i].onclick = function () {
        ws.tab = this.getAttribute('data-tab');
        for (var j = 0; j < btns.length; j++) btns[j].classList.toggle('active', btns[j] === this);
        for (var k = 0; k < WS_TABS.length; k++) {
          var p = wsEl('wsPane-' + WS_TABS[k]);
          if (p) p.classList.toggle('on', WS_TABS[k] === ws.tab);
        }
        if (ws.tab === 'usage') { if (!ws.usage) wsLoadUsage(); else wsRenderUsage(); }
        else wsRender();
      };
    }
  }

  var seg = wsEl('wsRange');
  if (seg) {
    var rb = seg.querySelectorAll('[data-range]');
    for (var m = 0; m < rb.length; m++) {
      rb[m].onclick = function () {
        ws.range = this.getAttribute('data-range');
        for (var j = 0; j < rb.length; j++) rb[j].classList.toggle('active', rb[j] === this);
        wsLoad();
      };
    }
  }
}

// setView('stats') 的入口
function statsInit() {
  wsInit();
  var pane = wsEl('wsPane-' + ws.tab);
  if (pane) pane.classList.add('on');
  wsLoad();
  wsLoadLive();
  if (ws.liveTimer) clearInterval(ws.liveTimer);
  // WebSocket 断线时的兜底，正常情况下列表由服务端推送刷新
  ws.liveTimer = setInterval(function () {
    if (state.view === 'stats') wsLoadLive();
  }, 30000);
}

// 顶栏「刷新」按钮
function statsReload() {
  wsLoad();
  wsLoadLive();
  if (ws.tab === 'usage') wsLoadUsage(ws.month);
}

// 切走时停掉兜底轮询
function statsStop() {
  if (ws.liveTimer) { clearInterval(ws.liveTimer); ws.liveTimer = null; }
}

// /ws/monitor 推来的实时访客（app.js 只在 stats 视图下转过来）
function statsOnVisit(batch) {
  if (!batch || !batch.length) return;
  for (var i = 0; i < batch.length; i++) ws.live.unshift(batch[i]);
  if (ws.live.length > 60) ws.live.length = 60;
  wsRenderLive();
}
