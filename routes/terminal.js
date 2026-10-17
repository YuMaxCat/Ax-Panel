const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { StringDecoder } = require('string_decoder');

// 终端跑在 tools/pty-bridge.py 里 —— 它用系统 python3 的 pty.fork() 开真 PTY，
// 不再依赖 node-pty（那是原生模块，编译产物与 Node 的 ABI 版本绑死）。
// 桥的通道约定：fd 0 键盘输入 / fd 1 终端输出 / fd 2 桥自身的报错 / fd 3 resize 控制命令。
// 缺 python3 时终端降级为「不可用」，面板其他功能不受影响。

const BRIDGE = path.join(__dirname, '..', 'tools', 'pty-bridge.py');
const PYTHON = process.env.PANEL_PYTHON || 'python3';

const IDLE_MS = 30 * 60 * 1000; // 30 分钟无操作自动断开

function attach(ws, config) {
  const shell = process.env.SHELL || '/bin/bash';
  let child;
  try {
    child = spawn(PYTHON, [BRIDGE, shell, '-l'], {
      cwd: os.homedir() || '/root',
      env: Object.assign({}, process.env, {
        TERM: 'xterm-256color',
        LANG: process.env.LANG || 'en_US.UTF-8'
      }),
      stdio: ['pipe', 'pipe', 'pipe', 'pipe']
    });
  } catch (e) {
    try {
      ws.send(JSON.stringify({ type: 'error', data: '终端启动失败：' + e.message }));
    } catch (e2) { /* ignore */ }
    ws.close();
    return;
  }

  const ctrl = child.stdio[3];
  // 一个字符可能被切成两个 chunk，用 decoder 跨块拼接，免得中文变成替换字符
  const decoder = new StringDecoder('utf8');
  let alive = true;
  let idleTimer = null;

  const cleanup = () => {
    if (!alive) return;
    alive = false;
    clearTimeout(idleTimer);
    try { child.kill(); } catch (e) { /* ignore */ }
  };

  const resetIdle = () => {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      try { ws.close(1000, 'idle timeout'); } catch (e) { /* ignore */ }
    }, IDLE_MS);
  };

  const fail = (text) => {
    try {
      if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'error', data: text }));
    } catch (e) { /* ignore */ }
    cleanup();
    try { ws.close(); } catch (e) { /* ignore */ }
  };

  child.on('error', (e) => {
    fail('终端不可用：' + e.message + '（这台机器上需要能跑 python3）');
  });

  child.stdout.on('data', (d) => {
    const text = decoder.write(d);
    if (!text) return;
    try { if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'data', data: text })); } catch (e) { /* ignore */ }
  });

  // 桥自己的 stderr：只有它内部出问题才会有内容，记进面板日志备查
  child.stderr.on('data', (d) => {
    const text = d.toString('utf8').trim();
    if (text) console.error('[terminal]', text);
  });

  child.on('exit', () => {
    cleanup();
    try { ws.close(); } catch (e) { /* ignore */ }
  });

  ws.on('message', (raw) => {
    resetIdle();
    let msg = null;
    try { msg = JSON.parse(raw.toString()); } catch (e) { /* 兼容裸文本输入 */ }
    if (!msg) {
      if (child.stdin.writable) child.stdin.write(raw.toString());
      return;
    }
    if (msg.type === 'input') {
      if (child.stdin.writable) child.stdin.write(String(msg.data || ''));
    } else if (msg.type === 'resize') {
      const cols = Math.max(2, Math.min(500, msg.cols | 0));
      const rows = Math.max(1, Math.min(200, msg.rows | 0));
      if (ctrl && ctrl.writable) ctrl.write('resize ' + cols + ' ' + rows + '\n');
    }
  });

  ws.on('close', cleanup);
  ws.on('error', cleanup);

  resetIdle();
}

module.exports = { attach };
