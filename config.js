const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const auth = require('./auth');

function generateSecret(len) {
  return crypto.randomBytes(len).toString('hex');
}

const FILE = path.join(__dirname, 'config.json');

// 设置页改完配置后写回磁盘；入参就是 load() 返回的那个对象
function save(cfg) {
  fs.writeFileSync(FILE, JSON.stringify(cfg, null, 2) + '\n');
}

function defaultConfig() {
  return {
    host: '127.0.0.1',
    port: 9906,
    name: 'Ax 面板',
    secretKey: 'change-me',        // 登录密钥（首次登录后请到「设置」页修改）
    sessionSecret: generateSecret(32),   // 会话签名密钥，首次生成后持久化
    sessionDays: 30,

    // nginx（裸装路径；用宝塔等面板的自行改成对应目录）
    nginx: {
      vhostDir: '/etc/nginx/conf.d',
      stateDir: '/etc/nginx/admin-state',
      bin: '/usr/sbin/nginx',
      conf: '/etc/nginx/nginx.conf',
      maintRoot: '/opt/Ax-Panel/maint'
    },

    // acme.sh（用于证书到期读取与手动续签）
    acme: {
      sh: '/root/.acme.sh/acme.sh',
      dir: '/root/.acme.sh'
    },

    // 文件管理允许访问的根目录（白名单，非此范围内一律拒绝）
    fileRoots: ['/opt', '/etc', '/root', '/'],

    // 日志目录
    pm2LogDir: '/root/.pm2/logs',
    wwwLogDir: '/var/log/nginx',

    // 站点探活（HTTP 可用性）
    uptime: { enabled: true, intervalMs: 300000, timeoutMs: 10000, failThreshold: 2, upThreshold: 2 },

    // IP 归属地：复用服务器上现成的 ip2location 服务（pm2 进程 ip2location）
    iploc: { enabled: true, url: 'http://127.0.0.1:9901/api/location', timeoutMs: 2500 },

    // 访问统计：增量解析 nginx access.log（需要 log_format 末尾带 $host 与
    // $http_cf_connecting_ip，见 /etc/nginx/nginx.conf），按天聚合落 data/weblog/
    weblog: {
      enabled: true,
      file: '/var/log/nginx/access.log',
      intervalMs: 30000,
      retentionDays: 92
    },

    // 雨云 API（只读：查云服务器 / 域名到期与流量；apiKey 仅存服务端，不下发前端）
    rainyun: {
      enabled: false,
      apiKey: '',
      baseUrl: 'https://api.v2.rainyun.com',
      refreshMs: 1800000,   // 30 分钟轮询一次
      expireWarnDays: 7
    },

    // 外部告警通道（SendKey / topic 只存服务端 config.json，不下发前端）
    alert: {
      serverchan: { enabled: true, sendKey: '', endpoint: '', dailyLimit: 5 },
      ntfy: { enabled: true, endpoint: 'https://ntfy.sh', topic: '', token: '' }
    },

    // 面板 App 推送（自建通道，token 只存服务端不下发前端）
    push: { token: '' },

    // 虚拟女友（gf-bot）：url 指向它自己的 /admin 管理口（只监听 127.0.0.1），
    // adminToken 就是 gf-bot 那边 data/secrets.json 里的 httpToken
    gf: {
      enabled: false,
      url: 'http://127.0.0.1:9920',
      adminToken: ''
    },

    // 离线下载：aria2 以 JSON-RPC 常驻（pm2 服务 aria2），面板只做调度与展示。
    // rpcSecret 必须与 /etc/aria2/aria2.conf 里的 rpc-secret 一致，仅存服务端不下发前端。
    download: {
      enabled: false,
      rpcUrl: 'http://127.0.0.1:6800/jsonrpc',
      rpcSecret: '',
      dir: '/opt/Ax-Panel/data/downloads',
      connections: 16,
      timeoutMs: 8000
    },

    // 云盘（内置的 Nimbus 风格云盘）
    // db / storage 用相对路径则按项目根解析（改名搬迁不用动），也可以写绝对路径。
    // maxUploadSize 必须 ≤ nginx 的 client_max_body_size(2g)，否则请求根本到不了这里。
    drive: {
      enabled: true,
      db: 'data/drive.sqlite',
      storage: 'data/drive-storage',
      maxUploadSize: 2147483648,
      diskQuota: 10737418240
    },

    // 登录诱饵：在面板域名下埋一组「像后台入口」的路径，撞上来的一律记录。
    // 真访客只会走 /login，所以撞上来的一定是在找后门的人。
    // ⚠ paths 只放「在那儿摆一个登录页说得通」的路径 —— 埋 /.env 却回一个
    //   登录页，反而等于告诉对方这是诱饵。子路径自动覆盖（/admin 含 /admin/xxx）。
    decoy: {
      enabled: true,
      // 攻击者提交的口令只留「长度 + 加盐指纹」不存明文，这是那份指纹的盐。
      // ⚠ 换了它，历史指纹就跟新记录对不上了（认不出「同一个口令被反复试」）
      salt: '',
      paths: [
        '/admin', '/manage', '/manager', '/panel', '/dashboard', '/cp',
        '/controlpanel', '/administrator', '/adminarea', '/login.php',
        '/user/login', '/wp-login.php', '/wp-admin', '/phpmyadmin', '/pma',
        '/adminer.php'
      ],
      notify: true,
      // 外发到 Server酱 / ntfy。默认关：免费版每天只有 5 条额度，让扫描器吃光之后
      // 真故障（站点掉线、证书到期）就推不出去了，所以诱饵只在面板内提醒
      external: false,
      max: 1000
    },

    // 部署卡：给终端一键安装 Claude Code / 下发机器锁密文。
    // salt 用于加密下发的配置，一旦发卡就不要再换（换了旧卡都解不开）。
    cc: {
      enabled: false,
      salt: '',
      host: '',                 // 面板对外地址，形如 https://panel.example.com
      offlineGraceDays: 7
    }
  };
}

function load() {
  let cfg;
  if (fs.existsSync(FILE)) {
    try {
      cfg = Object.assign(defaultConfig(), JSON.parse(fs.readFileSync(FILE, 'utf8')));
    } catch (e) {
      console.error('config.json 解析失败，回退默认配置:', e.message);
      cfg = defaultConfig();
    }
  } else {
    cfg = defaultConfig();
    fs.writeFileSync(FILE, JSON.stringify(cfg, null, 2) + '\n');
  }
  // 旧的明文密钥 → scrypt 指纹，幂等；写回失败不阻断启动（内存里已是指纹）
  if (typeof cfg.secretKey === 'string') {
    if (cfg.secretKey === 'change-me') {
      console.warn('[安全] 正在使用默认登录密钥 change-me，请登录后立即到「设置」页修改');
    }
    cfg.secretKey = auth.hashKey(cfg.secretKey);
    try { save(cfg); } catch (e) { console.error('密钥指纹写回失败:', e.message); }
  }
  // rainyun 是后加的字段：Object.assign 只做浅合并，旧 config.json 缺这一段时会被整个盖掉，这里补齐缺省值
  cfg.rainyun = Object.assign({}, defaultConfig().rainyun, cfg.rainyun || {});

  // download 同理（后加的字段，浅合并会把整段盖掉）
  cfg.download = Object.assign({}, defaultConfig().download, cfg.download || {});

  // push 同理（后加的字段，浅合并会把整段盖掉）
  cfg.push = Object.assign({}, defaultConfig().push, cfg.push || {});

  // drive 同理
  cfg.drive = Object.assign({}, defaultConfig().drive, cfg.drive || {});

  // weblog 同理
  cfg.weblog = Object.assign({}, defaultConfig().weblog, cfg.weblog || {});

  // decoy 同理，且口令指纹的盐缺失时要生成一次并落盘（不能每次启动都换盐）
  cfg.decoy = Object.assign({}, defaultConfig().decoy, cfg.decoy || {});
  // 虚拟女友（gf-bot）同理
  cfg.gf = Object.assign({}, defaultConfig().gf, cfg.gf || {});
  // cc 同理
  cfg.cc = Object.assign({}, defaultConfig().cc, cfg.cc || {});

  // 缺省密钥一律现场生成并落盘：config.json 被删掉后重启也不会让会话随机失效
  let dirty = false;
  if (!cfg.sessionSecret) { cfg.sessionSecret = generateSecret(32); dirty = true; }
  if (!cfg.decoy.salt) { cfg.decoy.salt = generateSecret(16); dirty = true; }
  if (!cfg.cc.salt) { cfg.cc.salt = generateSecret(16); dirty = true; }
  if (dirty) {
    try { save(cfg); } catch (e) { console.error('自动生成密钥写回失败:', e.message); }
  }

  // 环境变量覆盖（部署时用）
  if (process.env.ADMIN_PORT) cfg.port = parseInt(process.env.ADMIN_PORT, 10);
  if (process.env.ADMIN_HOST) cfg.host = process.env.ADMIN_HOST;
  if (process.env.ADMIN_KEY) cfg.secretKey = process.env.ADMIN_KEY;
  if (process.env.ADMIN_SESSION_SECRET) cfg.sessionSecret = process.env.ADMIN_SESSION_SECRET;
  return cfg;
}

module.exports = { load, save, defaultConfig, generateSecret };
