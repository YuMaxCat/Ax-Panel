const express = require('express');
const auth = require('../auth');
const monitor = require('../lib/monitor');
const branding = require('../lib/branding');
const iploc = require('../lib/iploc');
const authlog = require('../lib/authlog');
const sessions = require('../lib/sessions');
const { clientIp } = require('../lib/net');

// 登录限速：同一 IP 每分钟最多 10 次
const attempts = {};

function rateLimit(ip) {
  const now = Date.now();
  let a = attempts[ip] || { count: 0, resetAt: now + 60000 };
  if (now > a.resetAt) { a.count = 0; a.resetAt = now + 60000; }
  if (a.count >= 10) return false;
  a.count++;
  attempts[ip] = a;

  // 键来自外部 IP，量大时清掉过期项，避免无限增长
  const keys = Object.keys(attempts);
  if (keys.length > 500) {
    for (const k of keys) { if (now > attempts[k].resetAt) delete attempts[k]; }
  }
  return true;
}

function bjTime() {
  return new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false });
}

// 登录告警统一走这里：先查 IP 归属地（本机服务，查不到就只显示 IP），再推送。
// 不 await —— 登录响应的速度不该被归属地查询拖慢。
// 归属地并进标题：pushNotification 按「级别+标题」去重，同一来源 5 分钟只提醒一次，
// 不同城市则各算一条（否则第二个城市的尝试会被静默吞掉）
function notifyLogin(level, title, ip, build) {
  iploc.locate(ip).then((loc) => {
    const who = loc ? 'IP ' + ip + '（' + loc + '）' : 'IP ' + ip;
    monitor.pushNotification(level, loc ? title + ' · ' + loc : title, build(who));
  });
}

function makeRouter(config) {
  const router = express.Router();
  const requireAuth = auth.makeRequireAuth(config, sessions);

  // ---------- 认证 ----------
  // 面板名称 / Logo：登录页也要显示，故不带鉴权；只暴露名字与版本号，不含任何密钥
  // 面板名 / Logo / 功能开关一起下发。开关以 config.json 为唯一真相，
  // 前端据此摘掉已关闭模块的导航项（后端各路由自己也有一道 503 兜底）
  router.get('/meta', (req, res) => {
    res.json({
      name: config.name,
      logo: branding.version(),
      features: {
        download: !!(config.download && config.download.enabled),
        drive: !!(config.drive && config.drive.enabled),
        // 开关的键名要跟前端的 data-view 对上（视图叫 stats，后端模块叫 weblog）
        stats: !!(config.weblog && config.weblog.enabled),
        // 虚拟女友（gf-bot）：配好管理口地址和 token 才给入口
        gf: !!(config.gf && config.gf.enabled && config.gf.url && config.gf.adminToken)
      }
    });
  });

  router.post('/login', (req, res) => {
    const key = String(req.body.key || '');
    const ip = clientIp(req);
    const ua = String(req.get('user-agent') || '');
    if (!rateLimit(ip)) {
      authlog.record({ ip, ua, result: 'blocked' });
      notifyLogin('critical', '登录爆破告警', ip, (who) => `${who} 在 1 分钟内失败超过 10 次，已被临时封禁`);
      return res.status(429).json({ error: '尝试过于频繁，请稍后再试' });
    }
    if (!auth.verifyKey(key, config.secretKey)) {
      authlog.record({ ip, ua, result: 'fail' });
      notifyLogin('warning', '登录失败', ip, (who) => `${who} 使用错误的密钥尝试登录面板`);
      return res.status(401).json({ error: '密钥错误' });
    }
    // 登录成功即重置该 IP 计数
    delete attempts[ip];
    authlog.record({ ip, ua, result: 'ok' });
    notifyLogin('info', '面板登录成功', ip, (who) => `${who} 于 ${bjTime()} 登录成功`);
    // sid 落进 token，真正能踢下线的是会话登记里那条记录
    const sid = sessions.create({ ip, ua });
    const token = auth.sign({ sub: 'admin', iat: Date.now(), sid }, config.sessionSecret);
    const maxAge = config.sessionDays * 86400 * 1000;
    const secure = req.secure || req.get('x-forwarded-proto') === 'https';
    res.cookie(auth.COOKIE, token, { httpOnly: true, sameSite: 'lax', secure, maxAge, path: '/' });
    res.json({ ok: true, name: config.name });
  });

  router.post('/logout', (req, res) => {
    // 退出登录顺手把登记项删掉，别在会话列表里留一条永远在线的记录
    const payload = auth.verify(auth.extract(req), config.sessionSecret);
    if (payload && payload.sid) sessions.revoke(sessions.pubId(payload.sid));
    res.clearCookie(auth.COOKIE, { path: '/' });
    res.json({ ok: true });
  });

  router.get('/bootstrap', requireAuth, (req, res) => {
    res.json({ loggedIn: true, name: config.name, fileRoots: config.fileRoots });
  });

  // ---------- 功能模块 ----------
  router.use('/sites', require('./sites').makeRouter(config, requireAuth));
  router.use('/certs', require('./certs').makeRouter(config, requireAuth));
  router.use('/system', require('./system').makeRouter(config, requireAuth));
  router.use('/files', require('./files').makeRouter(config, requireAuth));
  router.use('/logs', require('./logs').makeRouter(config, requireAuth));
  router.use('/process', require('./process').makeRouter(config, requireAuth));
  router.use('/pm2', require('./pm2').makeRouter(config, requireAuth));
  router.use('/notify', require('./notify').makeRouter(config, requireAuth));
  router.use('/push', require('./push').makeRouter(config));
  router.use('/license', require('./license').makeRouter(config, requireAuth));
  router.use('/cc', require('./cc').makeRouter(config, requireAuth));
  router.use('/settings', require('./settings').makeRouter(config, requireAuth));
  router.use('/branding', require('./branding').makeRouter());
  router.use('/rainyun', require('./rainyun').makeRouter(config, requireAuth));
  router.use('/download', require('./download').makeRouter(config, requireAuth));
  router.use('/drive', require('./drive').makeRouter(config, requireAuth));
  router.use('/speedtest', require('./speedtest').makeRouter(config, requireAuth));
  router.use('/weblog', require('./weblog').makeRouter(config, requireAuth));
  router.use('/decoy', require('./decoy').makeRouter(config, requireAuth));
  router.use('/gf', require('./gf').makeRouter(config, requireAuth));

  return router;
}

module.exports = { makeRouter };
