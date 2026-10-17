const net = require('net');

// 服务在 nginx + Cloudflare 后面，req.ip 恒为 127.0.0.1，真实来源只能从转发头取。
//
// 但转发头是**客户端可伪造**的，而 nginx 的 CF 回源白名单里有 `allow 127.0.0.1`，
// 意味着本机任何进程都能自己塞一个 cf-connecting-ip 进来。以前无条件采信，
// 后果是归属地、登录限速、以及诱饵的溯源画像全都可能被喂假数据 ——
// 对「溯源」这种用途，等于把证据交给被调查的人自己写。
//
// 所以两道闸：只在对端确实是回环（＝确实经过 nginx）时才认这些头，且取出来的必须是合法 IP
const LOOPBACK = /^(::1$|::ffff:127\.|127\.)/;

function valid(ip) {
  if (!ip) return '';
  const s = String(ip).replace(/^::ffff:/, ''); // IPv4-mapped 的写法统一成 IPv4
  return net.isIP(s) ? s : '';
}

function clientIp(req) {
  const sock = (req && req.socket && req.socket.remoteAddress) || '';
  if (!LOOPBACK.test(sock)) return valid(sock) || 'unknown';

  const h = (req && req.headers) || {};
  const pick = (v) => (v ? String(v).split(',')[0].trim() : '');
  const ip = valid(pick(h['cf-connecting-ip'])) || valid(pick(h['x-real-ip'])) || valid(pick(h['x-forwarded-for']));
  return ip || valid(sock) || 'unknown';
}

module.exports = { clientIp };
