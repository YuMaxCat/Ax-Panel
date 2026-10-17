const path = require('path');
const http = require('http');
const express = require('express');
const cookieParser = require('cookie-parser');
const { WebSocketServer } = require('ws');

const config = require('./config').load();
const auth = require('./auth');
const routes = require('./routes');
const monitor = require('./lib/monitor');
const uptime = require('./lib/uptime');
const terminal = require('./routes/terminal');
const iploc = require('./lib/iploc');
const rainyun = require('./lib/rainyun');
const weblog = require('./lib/weblog');
const authlog = require('./lib/authlog');
const sessions = require('./lib/sessions');
const decoy = require('./lib/decoy');
const intel = require('./lib/intel');

const app = express();
app.set('trust proxy', 1);

// 三处独立的鉴权点（应用壳 / 兜底 sendFile / WS 升级握手）共用这一份判断，
// 免得漏掉一处 —— token 签名有效 + 会话登记还在，两条都过才算登录
function sessionOf(req) {
  const payload = auth.verify(auth.extract(req), config.sessionSecret);
  if (!payload || !sessions.valid(payload.sid)) return null;
  sessions.touch(payload.sid);
  return payload;
}

app.use(cookieParser());
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: false }));

// 登录诱饵：插在 /api 之前，让它第一个看到请求。
// 诱饵只认「配置里那几个路径」，没命中就直接 next()，正常流量无感；
// 命中则就地取证并应答，不会往下走到 API 或静态中间件
app.use(decoy.middleware(config, sessionOf));

// API 路由（全部挂鉴权）
app.use('/api', routes.makeRouter(config));

// 应用壳守卫：未登录访问 / 或 /index.html → 302 登录页（放在静态中间件之前）
app.use((req, res, next) => {
  const isShell = req.method === 'GET' && (req.path === '/' || req.path === '/index.html');
  if (isShell) {
    // 壳子必须每次回源校验，否则改了 index.html 里的 ?v=N 前端却还拿旧壳，
    // 新资源永远拉不到（静态资源本身带 ?v=N，可以放心让浏览器/CF 缓存）
    res.setHeader('Cache-Control', 'no-cache');
    if (sessionOf(req)) return next();
    return res.redirect('/login');
  }
  next();
});

// 静态前端（login.html / css / js / vendor 始终开放）
app.use(express.static(path.join(__dirname, 'public'), { extensions: ['html'], index: 'index.html' }));

// 兜底：未知非 API 路径回退应用壳，同样要求已登录
app.use((req, res) => {
  if (req.path.startsWith('/api/')) return res.status(404).json({ error: 'not found' });
  res.setHeader('Cache-Control', 'no-cache'); // 同壳子守卫：深链回退的也是应用壳，别被缓存住
  if (sessionOf(req)) {
    return res.sendFile(path.join(__dirname, 'public', 'index.html'));
  }
  res.redirect('/login');
});

// 统一错误处理：只回通用文案，不外泄堆栈/内部路径（含 body-parser 的 JSON 解析错误）
// 必须注册在所有路由之后
app.use((err, req, res, next) => { // eslint-disable-line no-unused-vars
  if (res.headersSent) return next(err);
  const status = err.status || err.statusCode || 500;
  console.error('[error]', req.method, req.path, status, err.message);
  const msg = status >= 500 ? '服务器内部错误' : '请求无效';
  if (req.path.startsWith('/api/')) return res.status(status).json({ error: msg });
  res.status(status).type('text/plain').send(msg);
});

const server = http.createServer(app);

// WebSocket：/ws/monitor（指标广播）、/ws/terminal（终端）
// 升级握手先校验 token —— 这是终端等 root 级操作的唯一安全边界
const wss = new WebSocketServer({ noServer: true });
server.on('upgrade', (req, socket, head) => {
  let pathname = '';
  try { pathname = new URL(req.url, 'http://localhost').pathname; } catch (e) { socket.destroy(); return; }

  if (!sessionOf(req)) {
    socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
    socket.destroy();
    return;
  }
  if (pathname === '/ws/monitor') {
    wss.handleUpgrade(req, socket, head, (ws) => monitor.attach(ws, config));
  } else if (pathname === '/ws/terminal') {
    wss.handleUpgrade(req, socket, head, (ws) => terminal.attach(ws, config));
  } else {
    socket.destroy();
  }
});

monitor.start(config);
uptime.start(config); // 依赖 monitor 的 pushNotification，不由 monitor 反向依赖
iploc.start(config);
rainyun.start(config);
weblog.start(config); // 依赖 iploc 查归属地，要排在它后面
authlog.start();      // 同样要 iploc 查归属地
sessions.start(config);
intel.start();        // 反查缓存（诱饵画像按需用，不自动跑网络查询）
decoy.start(config);  // 依赖 iploc 查归属地

server.listen(config.port, config.host, () => {
  console.log(`${config.name} 已启动: http://${config.host}:${config.port}`);
});
