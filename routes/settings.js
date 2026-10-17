const express = require('express');
const auth = require('../auth');
const configStore = require('../config');
const monitor = require('../lib/monitor');
const branding = require('../lib/branding');
const rainyun = require('../lib/rainyun');
const weblog = require('../lib/weblog');
const decoy = require('../lib/decoy');
const { clientIp } = require('../lib/net');

const GB = 1024 * 1024 * 1024;
const MB = 1024 * 1024;

// 取整数并卡范围；没传就返回默认值（＝不修改）
function intIn(v, min, max, dft, label) {
  if (v === undefined || v === null || v === '') return dft;
  const n = parseInt(v, 10);
  if (!Number.isInteger(n) || n < min || n > max) throw new Error(label + '需为 ' + min + '~' + max);
  return n;
}

function flag(v, dft) {
  return v === undefined ? dft : !!v;
}

// 各模块开关的当前状态，POST 完原样回给前端
function moduleState(config) {
  return {
    weblog: { enabled: !!config.weblog.enabled, retentionDays: config.weblog.retentionDays },
    download: { enabled: !!config.download.enabled, connections: config.download.connections },
    drive: {
      enabled: !!config.drive.enabled,
      diskQuotaGB: config.drive.diskQuota ? Math.round(config.drive.diskQuota / GB * 10) / 10 : 0,
      maxUploadMB: config.drive.maxUploadSize ? Math.round(config.drive.maxUploadSize / MB) : 0
    },
    cc: { enabled: !!config.cc.enabled, host: config.cc.host || '' },
    decoy: {
      enabled: !!config.decoy.enabled,
      notify: !!config.decoy.notify,
      external: !!config.decoy.external,
      paths: (config.decoy.paths || []).slice()
    }
  };
}

// 会话 cookie 的续签：轮换签名密钥后立刻补发一枚新的，让操作者本人不掉线。
// sid 沿用当前这条会话登记，否则新 token 会因为查不到登记而立刻失效
function reissueCookie(res, req, config) {
  const sid = req.user && req.user.sid;
  const token = auth.sign({ sub: 'admin', iat: Date.now(), sid }, config.sessionSecret);
  const maxAge = config.sessionDays * 86400 * 1000;
  const secure = req.secure || req.get('x-forwarded-proto') === 'https';
  res.cookie(auth.COOKIE, token, { httpOnly: true, sameSite: 'lax', secure, maxAge, path: '/' });
}

function makeRouter(config, requireAuth) {
  const router = express.Router();

  router.get('/', requireAuth, (req, res) => {
    res.json({
      name: config.name,
      sessionDays: config.sessionDays,
      logo: branding.version(),
      keyAlgo: config.secretKey && config.secretKey.algo ? config.secretKey.algo : 'plain',
      // 只回报「有没有配置」，key 本身不出服务端
      rainyun: {
        enabled: !!config.rainyun.enabled,
        hasKey: !!config.rainyun.apiKey,
        expireWarnDays: config.rainyun.expireWarnDays
      },
      modules: moduleState(config)
    });
  });

  // 面板基本信息
  router.post('/general', requireAuth, (req, res) => {
    try {
      const name = String(req.body.name == null ? '' : req.body.name).trim();
      const days = parseInt(req.body.sessionDays, 10);
      if (!name || name.length > 30) throw new Error('面板名称需为 1~30 个字符');
      if (!Number.isInteger(days) || days < 1 || days > 365) throw new Error('会话时长需为 1~365 天');
      config.name = name;
      config.sessionDays = days;
      configStore.save(config);
      res.json({ ok: true, name: config.name, sessionDays: config.sessionDays });
    } catch (e) {
      res.status(400).json({ error: e.message });
    }
  });

  // 修改登录密钥：必须先验旧密钥，避免被劫持的会话直接把门锁换掉
  router.post('/key', requireAuth, (req, res) => {
    try {
      const current = String(req.body.current || '');
      const next = String(req.body.next || '');
      if (!auth.verifyKey(current, config.secretKey)) throw new Error('当前密钥不正确');
      if (next.length < 6 || next.length > 64) throw new Error('新密钥需为 6~64 个字符');
      if (auth.verifyKey(next, config.secretKey)) throw new Error('新密钥不能与当前密钥相同');
      config.secretKey = auth.hashKey(next);
      configStore.save(config);
      monitor.pushNotification('warning', '面板密钥已修改', 'IP ' + clientIp(req) + ' 修改了面板登录密钥');
      res.json({ ok: true });
    } catch (e) {
      res.status(400).json({ error: e.message });
    }
  });

  // 轮换会话签名密钥：一次性作废所有已发出的 token（也包含伪造的），操作者本人续签不掉线
  router.post('/session/rotate', requireAuth, (req, res) => {
    config.sessionSecret = configStore.generateSecret(32);
    configStore.save(config);
    reissueCookie(res, req, config);
    monitor.pushNotification('warning', '会话密钥已轮换', 'IP ' + clientIp(req) + ' 轮换了会话签名密钥，其它设备已全部下线');
    res.json({ ok: true });
  });

  // 自定义 Logo：前端已用 canvas 裁成正方形 PNG 再传，这里只做校验与落盘
  router.post('/logo', requireAuth, (req, res) => {
    try {
      const v = branding.save(req.body && req.body.data);
      monitor.pushNotification('info', '面板 Logo 已更新', 'IP ' + clientIp(req) + ' 更换了面板 Logo');
      res.json({ ok: true, logo: v });
    } catch (e) {
      res.status(400).json({ error: e.message });
    }
  });

  router.delete('/logo', requireAuth, (req, res) => {
    try {
      branding.remove();
      res.json({ ok: true, logo: 0 });
    } catch (e) {
      res.status(400).json({ error: e.message });
    }
  });

  // 雨云 API：key 只进不出；留空表示不修改已保存的 key
  router.post('/rainyun', requireAuth, (req, res) => {
    try {
      const b = req.body || {};
      const key = typeof b.apiKey === 'string' ? b.apiKey.trim() : '';
      if (key && (key.length < 16 || key.length > 128)) throw new Error('API Key 长度不正确');
      const days = b.expireWarnDays === undefined ? config.rainyun.expireWarnDays : parseInt(b.expireWarnDays, 10);
      if (!Number.isInteger(days) || days < 1 || days > 90) throw new Error('到期提醒天数需为 1~90');

      const wasEnabled = config.rainyun.enabled && !!config.rainyun.apiKey;
      if (key) config.rainyun.apiKey = key;
      config.rainyun.expireWarnDays = days;

      if (b.enabled !== undefined) config.rainyun.enabled = !!b.enabled;
      if (config.rainyun.enabled && !config.rainyun.apiKey) throw new Error('启用前请先填写 API Key');
      configStore.save(config);

      // 从关到开时把轮询线程拉起来（本来就在跑的话 start 里会再挂一个定时器，故先停）
      rainyun.stop();
      rainyun.start(config);
      if (!wasEnabled && config.rainyun.enabled) {
        monitor.pushNotification('info', '雨云监控已启用', 'IP ' + clientIp(req) + ' 开启了雨云到期监控');
      }
      res.json({ ok: true, enabled: !!config.rainyun.enabled, hasKey: !!config.rainyun.apiKey, expireWarnDays: config.rainyun.expireWarnDays });
    } catch (e) {
      res.status(400).json({ error: e.message });
    }
  });

  /* ---------- 模块开关与参数 ---------- */

  // 访问统计
  router.post('/modules/weblog', requireAuth, (req, res) => {
    try {
      const b = req.body || {};
      config.weblog.enabled = flag(b.enabled, config.weblog.enabled);
      config.weblog.retentionDays = intIn(b.retentionDays, 7, 365, config.weblog.retentionDays, '数据保留天数');
      configStore.save(config);
      // 解析线程的启停和参数都要重新挂，先把旧定时器收掉再起（start 内部也会 stop）
      weblog.stop();
      weblog.start(config);
      res.json({ ok: true, modules: moduleState(config) });
    } catch (e) {
      res.status(400).json({ error: e.message });
    }
  });

  // 离线下载：connections 是「新建任务默认用几条连接」，changing 后立即对后续任务生效
  router.post('/modules/download', requireAuth, (req, res) => {
    try {
      const b = req.body || {};
      config.download.enabled = flag(b.enabled, config.download.enabled);
      config.download.connections = intIn(b.connections, 1, 16, config.download.connections, '连接数');
      configStore.save(config);
      res.json({ ok: true, modules: moduleState(config) });
    } catch (e) {
      res.status(400).json({ error: e.message });
    }
  });

  // 云盘：配额 0 表示不限；单文件上限改完即刻生效（routes/drive.js 里按 Content-Length 现取）
  router.post('/modules/drive', requireAuth, (req, res) => {
    try {
      const b = req.body || {};
      const quotaGB = intIn(b.diskQuotaGB, 0, 1024, null, '磁盘配额');
      const uploadMB = intIn(b.maxUploadMB, 1, 2048, null, '单文件上限');
      config.drive.enabled = flag(b.enabled, config.drive.enabled);
      if (quotaGB !== null) config.drive.diskQuota = quotaGB ? Math.round(quotaGB * GB) : 0;
      if (uploadMB !== null) config.drive.maxUploadSize = Math.round(uploadMB * MB);
      configStore.save(config);
      res.json({ ok: true, modules: moduleState(config) });
    } catch (e) {
      res.status(400).json({ error: e.message });
    }
  });

  // 部署卡：host 是客户脚本回连面板用的地址，改错会让新装的客户连不上
  router.post('/modules/cc', requireAuth, (req, res) => {
    try {
      const b = req.body || {};
      const host = String(b.host === undefined ? config.cc.host : b.host).trim().replace(/\/+$/, '');
      if (!/^https?:\/\/[A-Za-z0-9.-]+(:\d+)?$/.test(host)) throw new Error('面板地址需形如 https://example.com');
      config.cc.enabled = flag(b.enabled, config.cc.enabled);
      config.cc.host = host;
      configStore.save(config);
      res.json({ ok: true, modules: moduleState(config) });
    } catch (e) {
      res.status(400).json({ error: e.message });
    }
  });

  // 登录诱饵：路径列表整体替换（前端就是一张列表，逐条增删后整份提交）
  router.post('/modules/decoy', requireAuth, (req, res) => {
    try {
      const b = req.body || {};
      const src = b.paths === undefined ? (config.decoy.paths || []) : b.paths;
      if (!Array.isArray(src)) throw new Error('路径列表格式不正确');
      if (src.length > 40) throw new Error('诱饵路径最多 40 条');

      // 逐条校验 + 去重，有一条不合格就整份打回 —— 静默丢掉几条的话，用户会以为存上了。
      // 存的是归一化后的形态：存原始写法的话，/Admin 这种条目会因为比对用的是小写而永不命中
      const paths = [];
      const seen = {};
      for (const raw of src) {
        const p = String(raw == null ? '' : raw).trim();
        if (!p) continue;
        const why = decoy.check(p);
        if (why) throw new Error('「' + p + '」不可用：' + why);
        const c = decoy.canon(p);
        if (seen[c]) continue;
        seen[c] = 1;
        paths.push(c);
      }

      const wasOn = !!config.decoy.enabled;
      config.decoy.enabled = flag(b.enabled, config.decoy.enabled);
      config.decoy.notify = flag(b.notify, config.decoy.notify);
      config.decoy.external = flag(b.external, config.decoy.external);
      config.decoy.paths = paths;
      configStore.save(config);

      if (config.decoy.enabled && !wasOn) {
        monitor.pushNotification('info', '登录诱饵已启用', 'IP ' + clientIp(req) + ' 开启了登录诱饵');
      }
      res.json({ ok: true, modules: moduleState(config) });
    } catch (e) {
      res.status(400).json({ error: e.message });
    }
  });

  return router;
}

module.exports = { makeRouter };
