/* ============================================================
   Ax 面板 · 虚拟女友（gf-bot）
   六个分页：概览 / 记忆 / 对话 / 日志 / 调校 / 人设

   数据走 /api/gf/*（面板的薄代理），真正干活的是 gf-bot 自己的 /admin 管理口
   —— 跑在 127.0.0.1:9920 上，只监听回环。

   写法沿用面板的规矩：api() 传 json、toast()/modal()/esc() 用现成的、
   样式优先用 style.css 里的 .card/.btn/.badge/.empty/.input/.switch，
   这里只补面板没有的东西（头像区、聊天气泡、等宽日志）。
   ============================================================ */
'use strict';

var GF_REFRESH_MS = 20000;

var gf = {
  tab: 'overview',
  status: null,
  memory: null,
  messages: null,
  logs: null,
  tuning: null,
  timer: null,
  bound: false
};

function gfApi(p, opts) { return api(API + '/gf' + p, opts); }

/* ---------- 小工具 ---------- */

function gfDur(sec) {
  if (sec == null || sec < 0) return '—';
  var d = Math.floor(sec / 86400);
  var h = Math.floor(sec % 86400 / 3600);
  var m = Math.floor(sec % 3600 / 60);
  if (d) return d + ' 天 ' + h + ' 小时';
  if (h) return h + ' 小时 ' + m + ' 分';
  if (m) return m + ' 分钟';
  return sec + ' 秒';
}

function gfAgo(ts) {
  if (!ts) return '';
  var s = Math.floor((Date.now() - ts) / 1000);
  if (s < 60) return '刚刚';
  if (s < 3600) return Math.floor(s / 60) + ' 分钟前';
  if (s < 86400) return Math.floor(s / 3600) + ' 小时前';
  if (s < 604800) return Math.floor(s / 86400) + ' 天前';
  var d = new Date(ts);
  return (d.getMonth() + 1) + ' 月 ' + d.getDate() + ' 日';
}

function gfClock(ts) {
  var d = new Date(ts);
  var p = function (n) { return n < 10 ? '0' + n : '' + n; };
  return p(d.getMonth() + 1) + '/' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
}

function gfNum(n) {
  return String(n == null ? 0 : n).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/* ---------- 拉数据 ---------- */

function gfLoadStatus() {
  return gfApi('/status').then(function (d) {
    gf.status = d;
    gfRenderProfile();
    gfRenderMetrics();
    return d;
  });
}

function gfLoadMemory() {
  return gfApi('/memory').then(function (d) {
    gf.memory = d;
    if (gf.tab === 'memory') gfRenderMemory();
  });
}

function gfLoadMessages() {
  return gfApi('/messages?limit=60').then(function (d) {
    gf.messages = d.messages || [];
    if (gf.tab === 'chat') gfRenderChat();
  });
}

function gfLoadLog() {
  return gfApi('/log?lines=300').then(function (d) {
    gf.logs = d.lines || [];
    if (gf.tab === 'log') gfRenderLog();
  });
}

function gfLoadTuning() {
  return gfApi('/tuning').then(function (d) {
    gf.tuning = d.values;
    if (gf.tab === 'tuning') gfRenderTuning();
  });
}

function gfLoadPersona() {
  return gfApi('/persona').then(function (d) {
    var box = $('gfPersona');
    // 正在写就别覆盖人家
    if (box && document.activeElement !== box) box.value = d.append || '';
  });
}

/* ---------- 概览：她是谁、此刻在干嘛 ---------- */

function gfRenderProfile() {
  var s = gf.status;
  if (!s) return;

  var dot = $('gfDot');
  var state = $('gfStateText');
  var note = $('gfNote');

  if (s.away) {
    if (dot) dot.className = 'gf-dot away';
    if (state) state.textContent = '「' + s.away.why + '」中 · 还有 ' + gfDur(Math.round(s.away.left / 1000)) + ' 才回来';
  } else {
    if (dot) dot.className = 'gf-dot ok';
    if (state) state.textContent = '在 · 已经跑了 ' + gfDur(s.process.uptimeSec);
  }

  // 那句"她此刻"：心情不平常就先说心情，再补一句最后说了什么
  var bits = [];
  if (s.mood.level !== '平常') {
    bits.push('心情' + s.mood.level + (s.mood.why ? '（' + s.mood.why + '）' : ''));
  }
  if (s.lastMessage) {
    bits.push('最后一句是 ' + gfAgo(s.lastMessage.ts) + ' ——「' + s.lastMessage.text + '」');
  }
  if (note) note.textContent = bits.join('　·　');
}

function gfRenderMetrics() {
  var s = gf.status;
  if (!s) return;
  var set = function (id, main, sub) {
    var el = $(id);
    if (!el) return;
    el.innerHTML = esc(main) + (sub ? '<span class="s-sub">' + esc(sub) + '</span>' : '');
  };
  set('gfStMem', gfNum(s.counts.facts), '件');
  set('gfStMsgs', gfNum(s.memory.messages), '句');
  set('gfStLife', gfNum(s.counts.life), '条');
  set('gfStMood', s.mood.level, s.mood.value.toFixed(2));
}

/* ---------- 记忆 ---------- */

function gfRenderMemory() {
  var box = $('gfMemoryBody');
  if (!box) return;
  var m = gf.memory;
  if (!m) { box.innerHTML = '<div class="empty">读取中…</div>'; return; }

  var html = '';

  // 她眼里的他
  var impLines = (m.impression || '').split('\n')
    .filter(function (l) { return l.indexOf('- ') === 0; })
    .map(function (l) { return l.slice(2); });
  html += '<div class="card gf-mb">';
  html += '<div class="gf-sec"><b>她眼里的他</b><span>把碎事实炒成的判断</span></div>';
  html += impLines.length
    ? impLines.map(function (l) { return '<div class="gf-line">' + esc(l) + '</div>'; }).join('')
    : '<div class="empty">还没攒够。多聊一阵，她才会对你有看法。</div>';
  html += '</div>';

  // 她自己的日子
  html += '<div class="card gf-mb">';
  html += '<div class="gf-sec"><b>她自己的日子</b><span>' + m.life.length + ' 条</span></div>';
  html += m.life.length
    ? m.life.slice().reverse().map(function (r) {
      return '<div class="gf-line"><span class="t">' + esc(r.text) + '</span>'
        + '<span class="m">' + esc(gfAgo(r.ts)) + '</span></div>';
    }).join('')
    : '<div class="empty">今天还没生成</div>';
  html += '</div>';

  // 关于他的事
  html += '<div class="card gf-mb">';
  html += '<div class="gf-sec"><b>关于他的事</b><span>' + m.facts.length + ' 条</span></div>';
  html += m.facts.length
    ? m.facts.map(function (f) {
      var tag = f.kind === 'joke' ? '<span class="badge orange">梗</span>'
        : (f.importance >= 3 ? '<span class="badge red">重要</span>' : '');
      return '<div class="gf-line">' + tag + '<span class="t">' + esc(f.text) + '</span>'
        + '<span class="m">' + esc(gfAgo(f.ts)) + '</span></div>';
    }).join('')
    : '<div class="empty">还是空的 —— 她还不认识你</div>';
  html += '</div>';

  box.innerHTML = html;
}

/* ---------- 对话 ---------- */

function gfRenderChat() {
  var box = $('gfChatBody');
  if (!box) return;
  var list = gf.messages;
  if (!list) { box.innerHTML = '<div class="empty">读取中…</div>'; return; }
  if (!list.length) { box.innerHTML = '<div class="empty">还没有聊过</div>'; return; }

  box.innerHTML = '<div class="gf-msgs">' + list.map(function (m) {
    var mine = m.role === 'user';
    return '<div class="gf-msg' + (mine ? ' me' : '') + '">'
      + '<div class="gf-msg-time">' + esc(gfClock(m.ts)) + '</div>'
      + '<div class="gf-bubble">' + esc(m.text) + '</div></div>';
  }).join('') + '</div>';
  box.scrollTop = box.scrollHeight;
}

/* ---------- 日志 ---------- */

/* 按前缀分类上色。前缀是 gf-bot 的 log.js 定的那套：
   ← → 收发消息 / · 过程 / 🧠 思考 / 🔧 工具 / 📝 记忆 / 📊 用量 / 🖼 图 */
function gfLogKind(l) {
  if (l.indexOf('⚠') > -1) return 'warn';
  if (l.indexOf('🔧') > -1) return 'tool';
  if (l.indexOf('🧠') > -1) return 'think';
  if (l.indexOf('📝') > -1) return 'mem';
  if (l.indexOf('📊') > -1) return 'usage';
  if (l.indexOf('🖼') > -1) return 'img';
  if (l.indexOf('←') > -1) return 'in';
  if (l.indexOf('→') > -1) return 'out';
  return '';
}

function gfRenderLog() {
  var box = $('gfLogBody');
  if (!box) return;
  var lines = gf.logs;
  if (!lines || !lines.length) {
    box.innerHTML = '<div class="empty">还没有日志 —— 跟她说句话就有了</div>';
    return;
  }
  // 贴底时才自动滚：往上看历史的时候别把人拽回去
  var atBottom = box.scrollTop + box.clientHeight >= box.scrollHeight - 40;
  box.innerHTML = '<div class="gf-log">' + lines.map(function (l) {
    return '<div class="gf-log-line ' + gfLogKind(l) + '">' + esc(l) + '</div>';
  }).join('') + '</div>';
  if (atBottom) box.scrollTop = box.scrollHeight;
}

/* ---------- 调校 ---------- */

var GF_SWITCH_LABEL = {
  silence: '「她可以不回」总开关',
  ignoreChatter: '懒得理（关掉只留「说走了就真走」）',
  typo: '打错字',
  mood: '心情',
  life: '她自己的日子',
  impression: '她眼里的他',
  draw: '生图',
  voice: '语音消息',
  email: '发邮件',
  search: '上网查',
  phone: '看她手机'
};

var GF_FIELD_LABEL = {
  replyDelayMs: ['回复延迟（毫秒）', '最小 ~ 最大。秒回反而假'],
  msPerChar: ['每多打一个字多等（毫秒）', '打字是要花时间的'],
  typoRate: ['打错字基线概率', '0.04 ≈ 每 25 条错一个虚词'],
  typoBurstChance: ['错字成簇的概率', '真人是一阵一阵错的，不是均匀撒'],
  faceRate: ['发表情的概率', ''],
  repeatRate: ['重复字概率', '嗯 → 嗯嗯嗯'],
  splitSendChance: ['手滑分两条发的概率', ''],
  recallRate: ['撤回重打的概率', '极低，别真把话弄丢'],
  ignoreChance: ['纯闲聊可以不回的概率', '只对「哈哈」「嗯」这种生效'],
  maxSegments: ['一次最多拆几条', ''],
  voiceChanceNight: ['深夜改发语音的概率', ''],
  voiceChanceCute: ['撒娇改发语音的概率', ''],
  halfLifeHours: ['心情半衰期（小时）', '过了就淡一半'],
  step: ['一轮最多能推多少', ''],
  renderAt: ['偏离多少才写进 prompt', ''],
  recallLimit: ['每轮注入几条记忆', ''],
  compactThreshold: ['多少条历史开始压缩', '']
};

function gfRenderTuning() {
  var box = $('gfTuningBody');
  if (!box) return;
  var t = gf.tuning;
  if (!t) { box.innerHTML = '<div class="empty">读取中…</div>'; return; }

  var html = '';

  html += '<div class="card gf-mb"><div class="gf-sec"><b>开关</b><span>关掉立刻生效</span></div>';
  var keys = Object.keys(t.switches);
  for (var i = 0; i < keys.length; i++) {
    var k = keys[i];
    html += '<div class="gf-row"><div class="gf-row-label">' + esc(GF_SWITCH_LABEL[k] || k) + '</div>'
      + '<button class="switch' + (t.switches[k] !== false ? ' on' : '') + '" type="button"'
      + ' data-sw="' + esc(k) + '" aria-label="' + esc(k) + '"></button></div>';
  }
  html += '</div>';

  var sections = [['human', '人味'], ['mood', '心情'], ['memory', '记忆']];
  for (var s = 0; s < sections.length; s++) {
    var sec = sections[s][0];
    var vals = t[sec];
    if (!vals) continue;
    html += '<div class="card gf-mb"><div class="gf-sec"><b>' + esc(sections[s][1]) + '</b></div>';
    var fk = Object.keys(vals);
    for (var j = 0; j < fk.length; j++) {
      var key = fk[j];
      var lab = GF_FIELD_LABEL[key] || [key, ''];
      var v = vals[key];
      var ctl;
      if (Object.prototype.toString.call(v) === '[object Array]') {
        ctl = '<input class="input gf-num" type="number" data-num="' + sec + '.' + key + '.0" value="' + v[0] + '">'
          + '<input class="input gf-num" type="number" data-num="' + sec + '.' + key + '.1" value="' + v[1] + '">';
      } else {
        ctl = '<input class="input gf-num" type="number" step="any" data-num="' + sec + '.' + key + '.x" value="' + v + '">';
      }
      html += '<div class="gf-row"><div class="gf-row-label">' + esc(lab[0])
        + (lab[1] ? '<small>' + esc(lab[1]) + '</small>' : '') + '</div>'
        + '<div class="gf-row-ctl">' + ctl + '</div></div>';
    }
    html += '</div>';
  }

  box.innerHTML = html;
}

/* ---------- 操作 ---------- */

function gfSavePersona() {
  var box = $('gfPersona');
  if (!box) return;
  gfApi('/persona', { json: { append: box.value } })
    .then(function () { toast('人设已保存，下一句就生效'); })
    .catch(function (e) { toast(e.message, true); });
}

function gfWake() {
  gfApi('/wake', { json: {} })
    .then(function () {
      toast('叫醒了 —— 她下次就能回你了');
      gfLoadStatus().catch(function () {});
    })
    .catch(function (e) { toast(e.message, true); });
}

function gfSay() {
  var box = $('gfSayText');
  if (!box) return;
  var text = String(box.value || '').trim();
  if (!text) return toast('先写一句', true);
  gfApi('/say', { json: { text: text } })
    .then(function () {
      box.value = '';
      toast('发出去了');
      setTimeout(function () { gfLoadMessages().catch(function () {}); }, 900);
    })
    .catch(function (e) { toast(e.message, true); });
}

function gfClear(what, label) {
  modal({
    title: '清记忆',
    message: '要清掉' + label + '吗？这一步不可逆。',
    confirmText: '清掉',
    danger: true,
    onConfirm: function () {
      return gfApi('/memory/clear', { json: { what: what } }).then(function () {
        toast('清完了');
        gfLoadStatus().catch(function () {});
        gfLoadMemory().catch(function () {});
      });
    }
  });
}

/* ---------- 事件（只绑一次） ---------- */

function gfBind() {
  if (gf.bound) return;
  gf.bound = true;

  var view = $('view-gf');
  if (!view) return;

  view.addEventListener('click', function (ev) {
    var el = ev.target;

    var tab = el.closest ? el.closest('.gf-tab') : null;
    if (tab) return gfShowTab(tab.getAttribute('data-tab'));

    // 开关（面板的 .switch：靠 on 类表示开）
    var sw = el.closest ? el.closest('[data-sw]') : null;
    if (sw) {
      var k = sw.getAttribute('data-sw');
      var was = sw.classList.contains('on');
      sw.classList.toggle('on', !was);
      // 这个开关是点一下立刻告诉服务端，成了就留着，失败翻回去
      gfApi('/tuning', { json: { section: 'switches', key: k, value: !was } })
        .then(function () { toast((GF_SWITCH_LABEL[k] || k) + ' → ' + (!was ? '开' : '关')); })
        .catch(function (e) { sw.classList.toggle('on', was); toast(e.message, true); });
      return;
    }

    var act = el.getAttribute && el.getAttribute('data-act');
    if (!act) return;

    if (act === 'wake') gfWake();
    else if (act === 'say') gfSay();
    else if (act === 'save-persona') gfSavePersona();
    else if (act === 'clear-messages') gfClear('messages', '聊天记录');
    else if (act === 'clear-facts') gfClear('facts', '关于他的所有记忆');
    else if (act === 'clear-life') gfClear('life', '她自己的日子');
    else if (act === 'clear-all') gfClear('all', '她的全部记忆（对话 + 事实 + 近况 + 心情）');
    else if (act === 'reload') {
      gfLoadStatus().then(function () { toast('刷过了'); }).catch(function () {});
      gfLoadMemory().catch(function () {});
    }
  });

  // 数字改完失焦才提交，免得边打字边发请求
  view.addEventListener('change', function (ev) {
    var el = ev.target;
    var spec = el.getAttribute && el.getAttribute('data-num');
    if (!spec) return;

    var parts = spec.split('.'); // section.key.0|1|x
    var section = parts[0];
    var key = parts[1];
    var idx = parts[2];
    var value;

    if (idx === 'x') {
      value = Number(el.value);
    } else {
      var box = $('gfTuningBody');
      var a = box.querySelector('[data-num="' + section + '.' + key + '.0"]');
      var b = box.querySelector('[data-num="' + section + '.' + key + '.1"]');
      value = [Number(a.value), Number(b.value)];
    }

    gfApi('/tuning', { json: { section: section, key: key, value: value } })
      .then(function (d) {
        gf.tuning = d.values;
        toast('改了：' + (GF_FIELD_LABEL[key] || [key])[0]);
      })
      .catch(function (e) { toast(e.message, true); });
  });

  var say = $('gfSayText');
  if (say) {
    say.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') gfSay();
    });
  }
}

/* ---------- 分页 ---------- */

function gfShowTab(name) {
  gf.tab = name;

  var tabs = document.querySelectorAll('#view-gf .gf-tab');
  for (var i = 0; i < tabs.length; i++) {
    tabs[i].classList.toggle('on', tabs[i].getAttribute('data-tab') === name);
  }
  var panes = document.querySelectorAll('#view-gf .gf-pane');
  for (var j = 0; j < panes.length; j++) {
    panes[j].classList.toggle('on', panes[j].id === 'gfPane-' + name);
  }

  if (name === 'memory') gfLoadMemory().catch(function () {});
  else if (name === 'chat') gfLoadMessages().catch(function () {});
  else if (name === 'log') gfLoadLog().catch(function () {});
  else if (name === 'tuning') gfLoadTuning().catch(function () {});
  else if (name === 'persona') gfLoadPersona().catch(function () {});
}

/* ---------- 入口（app.js 调这两个） ---------- */

function gfInit() {
  gfBind();
  gfShowTab(gf.tab || 'overview');

  gfLoadStatus().catch(function (e) { toast(e.message, true); });
  gfLoadMemory().catch(function () {});
  gfLoadMessages().catch(function () {});
  gfLoadLog().catch(function () {});

  clearInterval(gf.timer);
  gf.timer = setInterval(function () {
    if (document.hidden) return;
    gfLoadStatus().catch(function () {}); // 网络抖一下不管
    if (gf.tab === 'chat') gfLoadMessages().catch(function () {});
    if (gf.tab === 'log') gfLoadLog().catch(function () {});
  }, GF_REFRESH_MS);
}

function gfReload() {
  if (gf.tab === 'chat') gfLoadMessages().then(gfRenderChat).catch(function () {});
  else if (gf.tab === 'memory') gfLoadMemory().then(gfRenderMemory).catch(function () {});
  else if (gf.tab === 'log') gfLoadLog().then(gfRenderLog).catch(function () {});
  else if (gf.tab === 'tuning') gfLoadTuning().then(gfRenderTuning).catch(function () {});
  else gfLoadStatus().catch(function () {});
}
