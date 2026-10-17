/* ============================================================
   Ax 面板 · 抽奖
   纯前端：状态存 localStorage，没有后端接口
   逻辑与原站一致 —— 数值积分缓动 / rAF 插值 / WebAudio 合成音效 / 纯 CSS 3D 箱体
   ============================================================ */
'use strict';

// 奖池名单：共 54 人（占位示例，换成自己的名单即可）。
// 原始版本按《汉语拼音正词法基本规则》(GB/T 16159) 写人名；这里用中性占位符。
var DRAW_NAMES = [
  '示例 01', '示例 02', '示例 03', '示例 04', '示例 05', '示例 06',
  '示例 07', '示例 08', '示例 09', '示例 10', '示例 11', '示例 12',
  '示例 13', '示例 14', '示例 15', '示例 16', '示例 17', '示例 18',
  '示例 19', '示例 20', '示例 21', '示例 22', '示例 23', '示例 24',
  '示例 25', '示例 26', '示例 27', '示例 28', '示例 29', '示例 30',
  '示例 31', '示例 32', '示例 33', '示例 34', '示例 35', '示例 36',
  '示例 37', '示例 38', '示例 39', '示例 40', '示例 41', '示例 42',
  '示例 43', '示例 44', '示例 45', '示例 46', '示例 47', '示例 48',
  '示例 49', '示例 50', '示例 51', '示例 52', '示例 53', '示例 54'
];

var DRAW_STORE_KEY = 'choujiang.used.v1';
var DRAW_MUTE_KEY = 'choujiang.muted.v1';
var DRAW_ROUNDS = 5;      // 名单重复圈数，决定滚动距离
var DRAW_TAIL = 40;       // 尾部补足，保证目标居中时右侧不空
var DRAW_TAIL_OFFSET = 27; // 目标在最后一圈中偏后的位置
var DRAW_SPIN_MS = 4600;  // 滚动时长
var DRAW_CHARGE_MS = 900; // 蓄力晃动时长
var DRAW_LEAD_MS = 420;   // 开盖到开始滚动的间隔

var draw = { inited: false, busy: false, pool: [], used: [], el: null };

/* ---------- 缓动：速度曲线数值积分 → 归一化位移曲线 ---------- */

function drawSpeedAt(u) {
  if (u < 0.08) return u / 0.08;      // 起步：快速加速到最高速
  var r = (u - 0.08) / 0.92;
  return Math.pow(1 - r, 1.9);        // 之后一路减速，末尾速度归零
}

function drawBuildEase(steps) {
  var table = new Float64Array(steps + 1);
  var total = 0;
  var i;
  for (i = 1; i <= steps; i++) {
    total += drawSpeedAt(i / steps);
    table[i] = total;
  }
  if (total <= 0) return function (t) { return t; };
  for (i = 0; i <= steps; i++) table[i] /= total;
  return function (t) {
    if (t <= 0) return 0;
    if (t >= 1) return 1;
    var x = t * steps;
    var i0 = Math.floor(x);
    return table[i0] + (table[i0 + 1] - table[i0]) * (x - i0);
  };
}

var drawEase = drawBuildEase(800);

/* ---------- 音效（WebAudio 合成，不依赖任何音频文件） ---------- */

var drawSound = (function () {
  var actx = null;
  var failed = false;
  var muted = false;

  function ac() {
    if (actx || failed) return actx;
    try {
      var AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) { failed = true; return null; }
      actx = new AC();
    } catch (e) {
      failed = true;
      actx = null;
    }
    return actx;
  }

  function resume() {
    var c = ac();
    if (c && c.state === 'suspended' && c.resume) {
      try { c.resume(); } catch (e) { /* ignore */ }
    }
    return c;
  }

  function blip(freq, type, peak, dur) {
    if (muted) return;
    var c = resume();
    if (!c) return;
    try {
      var t = c.currentTime;
      var osc = c.createOscillator();
      var gain = c.createGain();
      osc.type = type;
      osc.frequency.setValueAtTime(freq, t);
      gain.gain.setValueAtTime(0.0001, t);
      gain.gain.exponentialRampToValueAtTime(peak, t + 0.004);
      gain.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      osc.connect(gain);
      gain.connect(c.destination);
      osc.start(t);
      osc.stop(t + dur + 0.02);
    } catch (e) { /* ignore */ }
  }

  return {
    tick: function () { blip(1180, 'triangle', 0.035, 0.045); },
    ding: function () {
      blip(880, 'sine', 0.075, 0.65);
      blip(1320, 'sine', 0.045, 0.55);
      blip(1760, 'sine', 0.028, 0.42);
    },
    resume: resume,
    setMuted: function (m) { muted = !!m; },
    isMuted: function () { return muted; }
  };
})();

/* ---------- 奖池状态 ---------- */

// 名单 2026-10-14 改过写法之后，localStorage 里的旧记录还是「按音节分写」的形态。
// 先归一化再比对，免得历史记录被当成陌生名字全部丢掉（等于奖池被重置）
function drawNorm(s) {
  var p = String(s == null ? '' : s).trim().split(/\s+/).filter(Boolean);
  if (!p.length) return '';
  function cap(w) { return w.charAt(0).toUpperCase() + w.slice(1).toLowerCase(); }
  if (p.length <= 2) return p.map(cap).join(' ');
  var out = cap(p[0]) + ' ' + cap(p[1]);
  for (var i = 2; i < p.length; i++) {
    var w = p[i].toLowerCase();
    out += /^[aoe]/.test(w) ? "'" + w : w;   // 名的非首音节以 a/o/e 开头要加隔音符号
  }
  return out;
}

function drawLoadUsed() {
  try {
    var raw = localStorage.getItem(DRAW_STORE_KEY);
    var arr = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(arr)) return [];
    var out = [];
    for (var i = 0; i < arr.length; i++) {
      var n = drawNorm(arr[i]);
      if (DRAW_NAMES.indexOf(n) !== -1 && out.indexOf(n) === -1) out.push(n);
    }
    return out;
  } catch (e) {
    return [];
  }
}

function drawSaveUsed() {
  try { localStorage.setItem(DRAW_STORE_KEY, JSON.stringify(draw.used)); } catch (e) { /* ignore */ }
}

function drawRefreshPool() {
  draw.pool = DRAW_NAMES.filter(function (n) { return draw.used.indexOf(n) === -1; });
}

function drawUpdatePoolInfo() {
  draw.el.poolInfo.textContent = '奖池剩余 ' + draw.pool.length + ' / ' + DRAW_NAMES.length + ' 人';
}

function drawShuffle(a) {
  for (var i = a.length - 1; i > 0; i--) {
    var j = Math.floor(Math.random() * (i + 1));
    var t = a[i];
    a[i] = a[j];
    a[j] = t;
  }
  return a;
}

/* ---------- 构建滚筒 ---------- */

function drawBuildReel(target) {
  var seq = [];
  var r, i;

  for (r = 0; r < DRAW_ROUNDS; r++) seq = seq.concat(drawShuffle(DRAW_NAMES.slice()));
  seq = seq.concat(drawShuffle(DRAW_NAMES.slice()).slice(0, DRAW_TAIL));

  var targetIdx = seq.length - DRAW_TAIL - DRAW_TAIL_OFFSET;
  if (targetIdx < 0) targetIdx = seq.length - 1;
  seq[targetIdx] = target;

  var frag = document.createDocumentFragment();
  for (i = 0; i < seq.length; i++) {
    var item = document.createElement('div');
    item.className = 'reel-item';
    var chip = document.createElement('span');
    chip.className = 'reel-chip';
    chip.textContent = seq[i];
    item.appendChild(chip);
    frag.appendChild(item);
  }

  draw.el.reel.innerHTML = '';
  draw.el.reel.appendChild(frag);
  draw.el.reel.style.transform = 'translate3d(0,0,0)';
  return targetIdx;
}

/* ---------- 滚动 ---------- */

function drawSpin(target) {
  var el = draw.el;
  var targetIdx = drawBuildReel(target);

  void el.reel.offsetWidth; // 强制布局，保证能测到真实宽度

  var itemW = el.reel.children[0].offsetWidth;
  var viewW = el.reelWrap.offsetWidth;
  var startX = viewW / 2 - itemW / 2;
  var endX = viewW / 2 - (targetIdx * itemW + itemW / 2);
  var dist = startX - endX;
  var t0 = null;
  var lastSlot = -1;

  el.reel.style.willChange = 'transform';
  el.reel.style.transform = 'translate3d(' + startX + 'px,0,0)';

  function frame(now) {
    if (t0 === null) t0 = now;
    var t = (now - t0) / DRAW_SPIN_MS;
    if (t > 1) t = 1;
    var x = startX - dist * drawEase(t);
    el.reel.style.transform = 'translate3d(' + x + 'px,0,0)';

    // 每划过一格响一声，速度决定滴答密度（减速时自然变慢）
    var slot = Math.floor((startX - x) / itemW);
    if (slot !== lastSlot) {
      lastSlot = slot;
      drawSound.tick();
    }

    if (t < 1) requestAnimationFrame(frame);
    else drawSettle(target, targetIdx);
  }

  requestAnimationFrame(frame);
}

function drawSettle(target, targetIdx) {
  var el = draw.el;
  el.reel.style.willChange = '';
  el.reel.classList.add('is-settled');
  el.reel.children[targetIdx].classList.add('is-winner');

  el.resultName.textContent = target;
  el.result.classList.add('is-on');
  drawSound.ding();

  // 抽完把扔掉的盖子拼回来
  setTimeout(function () { el.chest.classList.remove('is-opening'); }, 320);

  draw.used.push(target);
  drawSaveUsed();
  drawRefreshPool();
  drawUpdatePoolInfo();

  draw.busy = false;
  el.btnReset.disabled = false;
  el.btnDraw.disabled = draw.pool.length === 0;
  el.btnDraw.textContent = draw.pool.length === 0 ? '已抽完' : '抽奖';
}

/* ---------- 交互 ---------- */

function drawStart() {
  if (draw.busy) return;

  drawRefreshPool();
  if (!draw.pool.length) return;

  var el = draw.el;
  drawSound.resume(); // 必须在用户手势内解锁音频
  draw.busy = true;
  el.btnDraw.disabled = true;
  el.btnReset.disabled = true;
  el.result.classList.remove('is-on');
  el.reel.classList.remove('is-settled');
  el.reelWrap.classList.remove('is-on');
  el.reel.innerHTML = '';

  var target = draw.pool[Math.floor(Math.random() * draw.pool.length)];

  el.chest.classList.remove('is-opening');
  el.chest.classList.add('is-charging');

  setTimeout(function () {
    el.chest.classList.remove('is-charging');
    el.chest.classList.add('is-opening');
    el.reelWrap.classList.add('is-on');
    setTimeout(function () { drawSpin(target); }, DRAW_LEAD_MS);
  }, DRAW_CHARGE_MS);
}

function drawReset() {
  if (draw.busy) return;

  var el = draw.el;
  draw.used = [];
  drawSaveUsed();
  drawRefreshPool();
  drawUpdatePoolInfo();

  el.reelWrap.classList.remove('is-on');
  el.reel.classList.remove('is-settled');
  el.reel.innerHTML = '';
  el.result.classList.remove('is-on');
  el.chest.classList.remove('is-opening');
  el.btnDraw.disabled = false;
  el.btnDraw.textContent = '抽奖';
}

function drawInit() {
  if (draw.inited) return;
  draw.inited = true;

  draw.el = {
    chest: $('drawChest'),
    reelWrap: $('drawReelWrap'),
    reel: $('drawReel'),
    result: $('drawResult'),
    resultName: $('drawResultName'),
    btnDraw: $('drawBtn'),
    btnReset: $('drawReset'),
    poolInfo: $('drawPoolInfo'),
    btnSound: $('drawSound')
  };

  var el = draw.el;
  var muted = false;
  try { muted = localStorage.getItem(DRAW_MUTE_KEY) === '1'; } catch (e) { /* ignore */ }
  drawSound.setMuted(muted);
  if (muted) el.btnSound.classList.add('is-muted');

  el.btnSound.onclick = function () {
    var m = !drawSound.isMuted();
    drawSound.setMuted(m);
    el.btnSound.classList.toggle('is-muted', m);
    if (!m) drawSound.resume();
    try { localStorage.setItem(DRAW_MUTE_KEY, m ? '1' : '0'); } catch (e) { /* ignore */ }
  };

  el.btnDraw.onclick = drawStart;
  el.btnReset.onclick = drawReset;

  draw.used = drawLoadUsed();
  drawRefreshPool();
  drawUpdatePoolInfo();
  el.btnDraw.disabled = draw.pool.length === 0;
  el.btnDraw.textContent = draw.pool.length === 0 ? '已抽完' : '抽奖';
}

document.addEventListener('DOMContentLoaded', drawInit);
