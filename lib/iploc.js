const http = require('http');

// 复用服务器上现成的 IP 归属地服务（pm2 进程 ip2location，监听 127.0.0.1:9901），
// 它自己优先级是 ip2region 离线库、查不到再用纯真库兜底。这里只做一个薄薄的客户端。

let cfg = null;

const cache = new Map(); // ip → {province, city} | null（null 表示查不到）
const CACHE_MAX = 500;

function start(config) { cfg = config || null; }

// 内网 / 回环地址查不出结果，也没必要查
function isPrivate(ip) {
  return /^127\./.test(ip) || /^10\./.test(ip) || /^192\.168\./.test(ip) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(ip) || /^169\.254\./.test(ip) ||
    /^::1$/.test(ip) || /^f[cd]/i.test(ip) || /^fe80:/i.test(ip);
}

// 「浙江省」→「浙江」、「内蒙古自治区」→「内蒙古」，省 / 市 后缀去掉更好读
function tidy(name) {
  return String(name || '')
    .replace(/(省|市)$/, '')
    .replace(/(维吾尔|壮族|回族)?自治区$/, '')
    .replace(/特别行政区$/, '');
}

// 查一次原始归属地：拿到 {province, city}，查不到给 null。绝不抛异常。
function query(ip) {
  return new Promise((resolve) => {
    let u;
    try { u = new URL(cfg.iploc.url); } catch (e) { return resolve(null); }

    const req = http.request({
      hostname: u.hostname,
      port: u.port || 80,
      path: u.pathname + u.search,
      method: 'GET',
      timeout: cfg.iploc.timeoutMs || 2500,
      headers: { 'X-Real-IP': ip }
    }, (res) => {
      let buf = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { buf += c; });
      res.on('end', () => {
        try {
          const d = JSON.parse(buf);
          if (d.code !== 0) return resolve(null);
          resolve({ province: d.province || '', city: d.city || '' });
        } catch (e) { resolve(null); }
      });
    });
    req.on('timeout', () => { req.destroy(); resolve(null); });
    req.on('error', () => resolve(null));
    req.end();
  });
}

// 带缓存的原始查询。访问统计要按省聚合，用这个才能拿到没被拼成一串的省份字段
// （国外 IP 的省份是「United States」这种带空格的国名，拼成字符串再切分会切错）
async function locateRaw(ip) {
  if (!cfg || !cfg.iploc || !cfg.iploc.enabled) return null;
  ip = String(ip || '').trim();
  if (!ip || ip === 'unknown' || isPrivate(ip)) return null;
  if (cache.has(ip)) return cache.get(ip);

  const loc = await query(ip);
  if (cache.size >= CACHE_MAX) cache.clear();
  cache.set(ip, loc);
  return loc;
}

// 永远 resolve 成字符串（查不到就是 ''），绝不抛异常、绝不阻塞调用方
async function locate(ip) {
  const r = await locateRaw(ip);
  if (!r) return '';
  const parts = [tidy(r.province), tidy(r.city)].filter(Boolean);
  return Array.from(new Set(parts)).join(' '); // 直辖市省市同名，去重
}

module.exports = { start, locate, locateRaw, isPrivate };
