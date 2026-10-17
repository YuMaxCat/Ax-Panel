/* ============================================================
   Ax 面板 · 测速
   跑两段做对比：
     ① 面板下载 —— 经 Cloudflare 回源到本机服务器，等于下载云盘文件的真实速度
     ② CF 边缘  —— 完全不回源，只测「你 → Cloudflare 节点」这一段
   ①慢②快 → 瓶颈在回源；两段都慢 → 瓶颈在你到 CF 这一段。
   ============================================================ */
'use strict';

var ST_CF = 'https://speed.cloudflare.com/__down?bytes=';

var st = {
  size: 10,          // 测速大小（MB）
  running: false
};

function stFmt(bps) {
  if (!isFinite(bps) || bps <= 0) return '—';
  return (bps / 1048576).toFixed(2);
}

function stMbps(bps) {
  if (!isFinite(bps) || bps <= 0) return '0.0';
  return (bps * 8 / 1000000).toFixed(1);
}

/* 流式下载：边收边回调，进度和瞬时速度才反映得出来 */
function stFetch(url, onTick, opts) {
  var ctrl = new AbortController();
  var t0 = performance.now();

  return fetch(url, Object.assign({
    signal: ctrl.signal,
    cache: 'no-store',
    credentials: 'same-origin'
  }, opts || {})).then(function (res) {
    if (!res.ok) throw new Error(res.status === 401 ? '登录已失效，请重新登录' : 'HTTP ' + res.status);
    var reader = res.body.getReader();
    var got = 0;

    return (function step() {
      return reader.read().then(function (r) {
        if (r.done) {
          var secs = (performance.now() - t0) / 1000;
          return { bytes: got, secs: secs, bps: secs > 0 ? got / secs : 0 };
        }
        got += r.value.length;
        if (onTick) onTick(got, (performance.now() - t0) / 1000);
        return step();
      });
    })();
  });
}

/* 延迟：连打三次取最小值，避开首次连接的握手开销 */
function stPing() {
  var best = Infinity;
  var left = 3;
  return (function once() {
    var t0 = performance.now();
    return fetch(API + '/meta', { cache: 'no-store' }).then(function () {
      var ms = performance.now() - t0;
      if (ms < best) best = ms;
      if (--left > 0) return once();
      return Math.round(best);
    }).catch(function () { return null; });
  })();
}

/* 当前命中的 Cloudflare 节点（只有经 CF 访问才有这个路径） */
function stColo() {
  return fetch('/cdn-cgi/trace', { cache: 'no-store' })
    .then(function (r) { return r.ok ? r.text() : ''; })
    .then(function (t) {
      var m = /^colo=(\S+)/m.exec(t || '');
      return m ? m[1] : null;
    })
    .catch(function () { return null; });
}

function stPaint(id, value) {
  var el = $(id);
  if (el) el.textContent = value;
}

function stProgress(pct) {
  var bar = $('stBar');
  if (bar) bar.style.width = Math.max(0, Math.min(100, pct)) + '%';
}

/* 实时刷新——每 120ms 一次就够，每块都刷会把 DOM 拖垮 */
function stTicker(numId, subId, totalBytes) {
  var last = 0;
  return function (got, secs) {
    var now = performance.now();
    if (now - last < 120) return;
    last = now;
    stPaint(numId, stFmt(got / secs));
    stProgress(got / totalBytes * 100);
  };
}

function speedtestRun() {
  if (st.running) return;
  st.running = true;

  var btn = $('btnSpeedtest');
  btn.disabled = true;
  btn.textContent = '测速中…';
  stPaint('stPanel', '—');
  stPaint('stPanelSub', '正在测…');
  stPaint('stEdge', '—');
  stPaint('stEdgeSub', '排队中…');
  stPaint('stMeta', '—');
  stProgress(0);

  var total = st.size * 1048576;
  var result = {};

  // ① 面板下载（经 CF 回源）
  stFetch(API + '/speedtest?mb=' + st.size + '&_=' + Date.now(), stTicker('stPanel', 'stPanelSub', total))
    .then(function (panel) {
      result.panel = panel;
      stPaint('stPanel', stFmt(panel.bps));
      stPaint('stPanelSub', stMbps(panel.bps) + ' Mbps · ' + st.size + ' MB / ' + panel.secs.toFixed(1) + 's');
      stProgress(100);

      // ② CF 边缘（不回源）
      stPaint('stEdgeSub', '正在测…');
      stProgress(0);
      return stFetch(ST_CF + total + '&_=' + Date.now(), stTicker('stEdge', 'stEdgeSub', total));
    })
    .then(function (edge) {
      result.edge = edge;
      stPaint('stEdge', stFmt(edge.bps));
      stPaint('stEdgeSub', stMbps(edge.bps) + ' Mbps · ' + st.size + ' MB / ' + edge.secs.toFixed(1) + 's');
      stProgress(100);
      return Promise.all([stColo(), stPing()]);
    })
    .then(function (r) {
      var colo = r[0];
      var ping = r[1];
      var bits = [];
      bits.push('节点 ' + (colo || '未知（可能未经过 CF）'));
      bits.push(ping == null ? '延迟 —' : '延迟 ' + ping + ' ms');
      stPaint('stMeta', bits.join(' · '));

      // 一句话判读，省得对着两个数字发愣
      var p = result.panel.bps;
      var e = result.edge.bps;
      var verdict;
      if (e > 0 && p < e * 0.5) verdict = '瓶颈在「回源」这一段（CF 节点 → 服务器）';
      else if (e > 0 && e < 1048576) verdict = '瓶颈在「你 → CF 节点」这一段（跨境链路慢）';
      else verdict = '两段都不慢，当前链路正常';
      toast('测速完成：面板 ' + stFmt(p) + ' MB/s · 判读：' + verdict);
    })
    .catch(function (e) {
      toast(e.name === 'AbortError' ? '已取消' : (e.message || '测速失败'), true);
      stPaint('stPanelSub', '测速中断');
      stPaint('stEdgeSub', '—');
    })
    .then(function () {
      st.running = false;
      btn.disabled = false;
      btn.textContent = '开始测速';
    });
}

function speedtestInit() {
  var seg = $('stSize');
  if (!seg) return;

  var btns = seg.querySelectorAll('[data-mb]');
  for (var i = 0; i < btns.length; i++) {
    btns[i].classList.toggle('active', parseInt(btns[i].getAttribute('data-mb'), 10) === st.size);
    btns[i].onclick = function () {
      if (st.running) return;
      st.size = parseInt(this.getAttribute('data-mb'), 10);
      for (var j = 0; j < btns.length; j++) {
        btns[j].classList.toggle('active', btns[j] === this);
      }
    };
  }

  $('btnSpeedtest').onclick = speedtestRun;
}
