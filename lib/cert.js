const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const nginx = require('./nginx');

const WARN_DAYS = 21;
const CRIT_DAYS = 7;
const RENEW_COOLDOWN_MS = 10 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

const lastRenew = {}; // acme 域名 → 上次续签时间戳

function md5(buf) {
  return crypto.createHash('md5').update(buf).digest('hex');
}

function unquote(s) {
  s = String(s == null ? '' : s).trim();
  const a = s[0];
  if ((a === "'" || a === '"') && s[s.length - 1] === a) return s.slice(1, -1);
  return s;
}

// 从 acme.sh 的 .conf 里取形如 Le_Domain='xxx' 的值
function confValue(conf, key) {
  const m = conf.match(new RegExp('^' + key + '=(.*)$', 'm'));
  return m ? unquote(m[1]) : '';
}

function tail(s, n) {
  const t = String(s == null ? '' : s).trim();
  return t.length > n ? '…' + t.slice(-n) : t;
}

/* ---------- acme.sh 索引 ---------- */

// 扫描 <acme.dir>/*_ecc/<域名>.conf，用 fullchain.cer 的内容指纹建立索引。
// 不能靠 Le_RealCertPath 匹配：实测 ai 的 conf 里记的是 example.com.pem，
// 而 vhost 实际引用的是 example.com.fullchain.pem，路径对不上，只能比内容。
function buildAcmeEntries(config) {
  const dir = (config.acme && config.acme.dir) || '';
  const entries = [];
  let names;
  try { names = fs.readdirSync(dir); } catch (e) { return entries; }

  for (const n of names) {
    if (!n.endsWith('_ecc')) continue;
    const certDir = path.join(dir, n);
    const confFile = path.join(certDir, n.slice(0, -'_ecc'.length) + '.conf');
    let conf;
    try { conf = fs.readFileSync(confFile, 'utf8'); } catch (e) { continue; }

    const domain = confValue(conf, 'Le_Domain');
    if (!domain) continue;
    const alt = confValue(conf, 'Le_Alt');

    let hash = null;
    try { hash = md5(fs.readFileSync(path.join(certDir, 'fullchain.cer'))); } catch (e) { hash = null; }

    entries.push({
      acmeDomain: domain,
      altNames: alt ? alt.split(',').map((x) => x.trim()).filter(Boolean) : [],
      certDir,
      hash
    });
  }
  return entries;
}

function matchEntry(entries, hash, domain) {
  if (hash) {
    const hit = entries.find((e) => e.hash && e.hash === hash);
    if (hit) return hit;
  }
  // 退化匹配：acme 目录的主域名或备用名里包含该站点域名
  return entries.find((e) => e.acmeDomain === domain || e.altNames.indexOf(domain) >= 0) || null;
}

// 按「已装证书文件内容」定位它属于哪个 acme 证书
function entryForCertFile(entries, file, domain) {
  let hash = null;
  try { hash = md5(fs.readFileSync(file)); } catch (e) { hash = null; }
  return matchEntry(entries, hash, domain);
}

// 读一张证书：到期信息 + 对应哪个 acme 域名
function inspectCert(file, entries, domain) {
  let buf;
  try {
    buf = fs.readFileSync(file);
  } catch (e) {
    return { expiresAt: null, daysLeft: null, subject: '', error: '证书文件不存在', acmeDomain: null, altNames: [] };
  }

  let info;
  try {
    // 文件里第一张即叶子证书
    const cert = new crypto.X509Certificate(buf);
    const exp = new Date(cert.validTo);
    if (isNaN(exp.getTime())) throw new Error('无法解析到期时间');
    info = {
      expiresAt: exp.toISOString(),
      daysLeft: Math.floor((exp.getTime() - Date.now()) / DAY_MS),
      subject: cert.subject.replace(/\s+/g, ' ').trim(),
      error: null
    };
  } catch (e) {
    info = { expiresAt: null, daysLeft: null, subject: '', error: '证书解析失败：' + e.message };
  }

  const hit = matchEntry(entries, md5(buf), domain);
  info.acmeDomain = hit ? hit.acmeDomain : null;
  info.altNames = hit ? hit.altNames : [];
  return info;
}

/* ---------- 对外 ---------- */

// 列出所有配置了 SSL 证书的站点及其证书状态
function listCerts(config) {
  let sites;
  try { sites = nginx.listSites(config); } catch (e) { return []; }
  const entries = buildAcmeEntries(config);

  const out = [];
  for (const s of sites) {
    if (!s.cert) continue;
    out.push(Object.assign({ domain: s.domain, certPath: s.cert }, inspectCert(s.cert, entries, s.domain)));
  }
  return out;
}

// 手动强制续签某站点对应证书。domain 必须命中扫描结果，acme 域名来自 conf 文件，
// 全程用参数数组调 execFileSync，不经 shell
function renewCert(config, domain) {
  const sites = nginx.listSites(config);
  const site = sites.find((s) => s.domain === domain);
  if (!site) throw new Error('未找到站点：' + domain);
  if (!site.cert) throw new Error('该站点未配置 SSL 证书');
  if (!fs.existsSync(site.cert)) throw new Error('证书文件不存在：' + site.cert);

  const hit = entryForCertFile(buildAcmeEntries(config), site.cert, site.domain);
  if (!hit) throw new Error('该证书不由 acme.sh 管理，无法自动续签');

  const now = Date.now();
  const last = lastRenew[hit.acmeDomain];
  if (last && now - last < RENEW_COOLDOWN_MS) {
    const wait = Math.ceil((RENEW_COOLDOWN_MS - (now - last)) / 60000);
    throw new Error('刚续签过，请约 ' + wait + ' 分钟后再试（避免触发 CA 频率限制）');
  }

  let output;
  try {
    output = execFileSync(config.acme.sh, ['--renew', '-d', hit.acmeDomain, '--ecc', '--force'], {
      encoding: 'utf8',
      timeout: 180000, // 实测一次 DNS-01 续签约 70s，留足余量
      maxBuffer: 4 * 1024 * 1024,
      stdio: 'pipe'
    });
  } catch (e) {
    const msg = (e.stdout || '') + (e.stderr || '') || e.message;
    throw new Error('续签失败：' + tail(msg, 600));
  }

  lastRenew[hit.acmeDomain] = Date.now();
  return { acmeDomain: hit.acmeDomain, output: tail(output, 800) };
}

module.exports = { listCerts, renewCert, WARN_DAYS, CRIT_DAYS };
