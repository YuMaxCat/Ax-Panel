const fs = require('fs');
const path = require('path');
const dns = require('dns');
const https = require('https');
const net = require('net');
const iploc = require('./iploc');

// 对来源 IP 的「公开记录」反查：rDNS 反解 + RDAP（现代版 WHOIS）。
//
// ⚠ 这个模块只查记录 —— DNS 查询与公开注册库查询，**绝不向对方主机发起任何连接**。
//   反查是给人看的：判断对面是「被黑的家宽肉鸡」还是「IDC 的扫描节点」，
//   这一步决定了该无视它还是该认真处理。
//
// 结果按 IP 缓存落 data/decoy-intel.json，同一天内不重复查（RDAP 是第三方公共服务，
// 别拿它当自己的数据库刷）。

const DIR = path.join(__dirname, '..', 'data');
const FILE = path.join(DIR, 'decoy-intel.json');
const TTL = 24 * 3600 * 1000;
const MAX = 300;
const RDAP_ROOT = 'https://rdap.org/ip/';

let db = {};        // { ip: { ts, rdns, rdap } }
let dirty = false;
let timer = null;

function load() {
  try {
    const d = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    db = d && typeof d === 'object' && !Array.isArray(d) ? d : {};
  } catch (e) {
    db = {};
  }
}

function flush() {
  dirty = false;
  try {
    if (!fs.existsSync(DIR)) fs.mkdirSync(DIR, { recursive: true });
    // 超上限就丢最旧的，免得这份缓存无限长大
    const keys = Object.keys(db);
    if (keys.length > MAX) {
      keys.sort((a, b) => (db[a].ts || 0) - (db[b].ts || 0));
      for (const k of keys.slice(0, keys.length - MAX)) delete db[k];
    }
    const tmp = FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(db) + '\n');
    fs.renameSync(tmp, FILE); // 原子替换
  } catch (e) { /* 缓存写不进去不影响查询结果 */ }
}

function scheduleSave() {
  dirty = true;
  if (timer) return;
  timer = setTimeout(() => { timer = null; if (dirty) flush(); }, 3000);
  if (timer.unref) timer.unref();
}

function start() {
  load();
  process.on('exit', () => { if (dirty) flush(); });
}

/* ---------- rDNS ---------- */

// 永不 reject：查不到就是空字符串，反查失败不该让画像整块报错
function rdns(ip) {
  return new Promise((resolve) => {
    let r;
    try {
      r = new dns.promises.Resolver({ timeout: 2500, tries: 1 });
    } catch (e) {
      return resolve('');
    }
    r.reverse(ip)
      .then((names) => resolve((names && names[0]) || ''))
      .catch(() => resolve(''));
  });
}

/* ---------- RDAP ---------- */

// rdap.org 只是个跳转入口，得自己跟到权威 RIR —— Node 的 https 不自动跟跳转。
// 但「跟着一个第三方给的地址走」本身就是个 SSRF 原语：rdap.org 被投毒或开放重定向，
// 面板就变成盲 SSRF 客户端。所以跳转目标必须限定在这五家 RIR，且必须仍是 https
const RIR_HOSTS = [
  'rdap.arin.net', 'rdap.apnic.net', 'rdap.db.ripe.net', 'rdap.lacnic.net', 'rdap.afrinic.net'
];
const ENTRY_HOST = 'rdap.org';  // 只有第一跳允许走这个入口，之后必须落在上面五家
const MAX_BODY = 256 * 1024;    // RDAP 对象可以几十 KB，但别无限 +=

function allowed(u, entry) {
  if (u.protocol !== 'https:') return false;
  if (entry && u.hostname === ENTRY_HOST) return true;
  for (const h of RIR_HOSTS) {
    if (u.hostname === h || u.hostname.endsWith('.' + h)) return true;
  }
  return false;
}

function get(url, hops, entry) {
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(url); } catch (e) { return reject(new Error('RDAP 地址无效')); }
    if (!allowed(u, entry)) return reject(new Error('RDAP 跳转目标不在允许的注册局范围内'));

    const req = https.request({
      hostname: u.hostname,
      port: 443,
      path: u.pathname + u.search,
      method: 'GET',
      timeout: 8000,
      headers: {
        Accept: 'application/rdap+json, application/json',
        'User-Agent': 'ax-panel/1.0 (decoy intel)'
      }
    }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && hops > 0) {
        res.resume();
        return resolve(get(new URL(res.headers.location, url).toString(), hops - 1, false));
      }
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (c) => {
        text += c;
        if (text.length > MAX_BODY) { req.destroy(); reject(new Error('RDAP 响应过大')); }
      });
      res.on('end', () => {
        if (res.statusCode !== 200) return reject(new Error('RDAP 返回 HTTP ' + res.statusCode));
        try { resolve(JSON.parse(text)); } catch (e) { reject(new Error('RDAP 返回的不是合法 JSON')); }
      });
    });
    req.on('timeout', () => { req.destroy(); reject(new Error('RDAP 查询超时')); });
    req.on('error', (e) => reject(new Error('RDAP 查询失败：' + e.message)));
    req.end();
  });
}

// RDAP 的机构名藏在 vcard 里，形如 ["vcard", [["fn",{},"text","Example Inc."], ...]]
function vcardFn(v) {
  if (!Array.isArray(v) || !Array.isArray(v[1])) return '';
  for (const row of v[1]) {
    if (Array.isArray(row) && row[0] === 'fn' && typeof row[3] === 'string') return row[3];
  }
  return '';
}

// 优先取注册者/管理者的名字，取不到退回顶层 name / handle
function pickOrg(d) {
  const ents = Array.isArray(d.entities) ? d.entities : [];
  for (const e of ents) {
    const roles = Array.isArray(e.roles) ? e.roles : [];
    if (roles.indexOf('registrant') < 0 && roles.indexOf('administrative') < 0) continue;
    const fn = vcardFn(e.vcardArray);
    if (fn) return fn;
  }
  for (const e of ents) {
    const fn = vcardFn(e.vcardArray);
    if (fn) return fn;
  }
  return d.name || d.handle || '';
}

function pickCidr(d) {
  const c = Array.isArray(d.cidr0_cidrs) ? d.cidr0_cidrs[0] : null;
  if (!c) return '';
  const p = c.v4prefix || c.v6prefix || '';
  return p && c.length ? p + '/' + c.length : '';
}

// 只回画像用得上的几项，别把整份 RDAP 丢给前端
function tidy(d) {
  return {
    handle: d.handle || '',
    name: d.name || '',
    org: pickOrg(d),
    country: d.country || '',
    type: d.type || '',
    cidr: pickCidr(d),
    range: d.startAddress && d.endAddress ? d.startAddress + ' - ' + d.endAddress : ''
  };
}

/* ---------- 对外 ---------- */

function valid(ip) {
  // 必须先过这一关：RDAP 的地址是拼出来的，不校验就是路径注入
  return !!ip && net.isIP(String(ip)) > 0;
}

// 查一个 IP 的公开记录。带 24 小时缓存；force 为真则跳过缓存重查。
async function lookup(ip, force) {
  const key = String(ip || '').trim();
  if (!valid(key)) throw new Error('IP 格式不正确');

  const hit = db[key];
  if (!force && hit && Date.now() - (hit.ts || 0) < TTL) {
    return { ip: key, rdns: hit.rdns || '', rdap: hit.rdap || null, ts: hit.ts, cached: true };
  }

  // 内网地址查注册库没有意义，rDNS 还是可以试一下
  const priv = iploc.isPrivate(key);
  const [name, rdap] = await Promise.all([
    rdns(key),
    priv ? Promise.resolve(null) : get(RDAP_ROOT + encodeURIComponent(key), 3, true).then(tidy).catch((e) => ({ error: e.message }))
  ]);

  db[key] = { ts: Date.now(), rdns: name, rdap: rdap || null };
  scheduleSave();
  return { ip: key, rdns: name, rdap: rdap || null, ts: db[key].ts, cached: false };
}

module.exports = { start, lookup, valid };
