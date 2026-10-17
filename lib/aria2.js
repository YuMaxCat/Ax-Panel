const http = require('http');

// aria2 常驻进程（pm2 服务 aria2）的 JSON-RPC 薄客户端。
// 只连回环地址，密钥走 config.download.rpcSecret，须与 /etc/aria2/aria2.conf 的 rpc-secret 一致。
// 若只请求部分字段，aria2 的响应体可以小很多（files 里带 uris，列表长了很占带宽）
const KEYS = [
  'gid', 'status', 'totalLength', 'completedLength', 'downloadSpeed',
  'connections', 'errorCode', 'errorMessage', 'dir', 'files'
];

function createClient(cfg) {
  const url = new URL(cfg.rpcUrl);
  const secret = cfg.rpcSecret || '';
  const timeoutMs = cfg.timeoutMs || 8000;
  let seq = 0;

  // 调一次 RPC。aria2 把业务错误放在 error 字段里（HTTP 仍是 200），这里统一翻成 Error
  function call(method, params) {
    return new Promise((resolve, reject) => {
      const body = JSON.stringify({
        jsonrpc: '2.0',
        id: 'panel-' + (++seq),
        method: 'aria2.' + method,
        params: (secret ? ['token:' + secret] : []).concat(params || [])
      });
      const req = http.request({
        hostname: url.hostname,
        port: url.port || 80,
        path: url.pathname + url.search,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body)
        },
        timeout: timeoutMs
      }, (res) => {
        let raw = '';
        res.setEncoding('utf8');
        res.on('data', (c) => { raw += c; });
        res.on('end', () => {
          let d;
          try { d = JSON.parse(raw); } catch (e) {
            return reject(new Error('aria2 返回了无法解析的内容'));
          }
          if (d.error) {
            const msg = d.error.message || '未知错误';
            return reject(new Error(msg === 'Unauthorized'
              ? 'aria2 鉴权失败（面板配置的 rpc-secret 与 /etc/aria2/aria2.conf 不一致）'
              : msg));
          }
          resolve(d.result);
        });
      });
      req.on('timeout', () => req.destroy(new Error('aria2 响应超时')));
      req.on('error', (e) => reject(new Error('连不上 aria2：' + e.message)));
      req.end(body);
    });
  }

  return {
    call,
    version: () => call('getVersion').then((r) => r.version),
    tellActive: () => call('tellActive', [KEYS]),
    tellWaiting: (n) => call('tellWaiting', [0, n, KEYS]),
    tellStopped: (n) => call('tellStopped', [0, n, KEYS]),
    tellStatus: (gid) => call('tellStatus', [gid, KEYS]),
    addUri: (uris, opts) => call('addUri', [uris, opts]),
    pause: (gid) => call('pause', [gid]),
    unpause: (gid) => call('unpause', [gid]),
    forceRemove: (gid) => call('forceRemove', [gid]),
    removeResult: (gid) => call('removeDownloadResult', [gid]),
    purge: () => call('purgeDownloadResult')
  };
}

// aria2 的状态对象 → 前端好用的扁平结构
function shape(st) {
  const f = (st.files && st.files[0]) || {};
  const total = Number(st.totalLength) || 0;
  const done = Number(st.completedLength) || 0;
  const speed = Number(st.downloadSpeed) || 0;
  return {
    gid: st.gid,
    status: st.status,
    name: f.path ? f.path.split('/').pop() : '',
    path: f.path || '',
    uri: (f.uris && f.uris[0] && f.uris[0].uri) || '',
    dir: st.dir || '',
    total: total,
    done: done,
    speed: speed,
    connections: Number(st.connections) || 0,
    progress: total > 0 ? done / total : 0,
    eta: (speed > 0 && total > done) ? Math.round((total - done) / speed) : 0,
    // aria2 成功时也会带 errorCode:"0"，归一化成空串
    errorCode: (st.errorCode && String(st.errorCode) !== '0') ? String(st.errorCode) : '',
    errorMessage: st.errorMessage || ''
  };
}

module.exports = { createClient, shape, KEYS };
