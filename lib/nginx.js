const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const SENTINEL = '# ADMIN_PANEL_STATE_INCLUDE';
const SENTINEL_KEY = 'ADMIN_PANEL_STATE_INCLUDE';
const DENY_MARK = 'admin_maint';

/* ---------- nginx 配置文本解析 ---------- */

// 把注释与引号字符串替换为等长空格，保留偏移，便于安全做花括号配平
function maskText(text) {
  let out = '';
  let state = 'code';
  const n = text.length;
  for (let i = 0; i < n; i++) {
    const c = text[i];
    if (state === 'code') {
      if (c === '#') { state = 'comment'; out += ' '; }
      else if (c === "'") { state = 'squote'; out += ' '; }
      else if (c === '"') { state = 'dquote'; out += ' '; }
      else out += c;
    } else if (state === 'comment') {
      if (c === '\n') { state = 'code'; out += '\n'; }
      else out += ' ';
    } else if (state === 'squote') {
      if (c === '\\') { out += '  '; i++; }
      else { if (c === "'") state = 'code'; out += ' '; }
    } else { // dquote
      if (c === '\\') { out += '  '; i++; }
      else { if (c === '"') state = 'code'; out += ' '; }
    }
  }
  return out;
}

// 找出所有 server { ... } 块的区间（start 指向 '{'，end 指向配对的 '}'）
function findServerBlocks(mask) {
  const blocks = [];
  const re = /\bserver\b/g;
  let m;
  while ((m = re.exec(mask))) {
    const brace = mask.indexOf('{', m.index);
    if (brace < 0) break;
    let depth = 0;
    let k = brace;
    for (; k < mask.length; k++) {
      if (mask[k] === '{') depth++;
      else if (mask[k] === '}') { depth--; if (depth === 0) break; }
    }
    if (depth === 0) {
      blocks.push({ start: brace, end: k });
      re.lastIndex = k;
    } else {
      re.lastIndex = brace + 1;
    }
  }
  return blocks;
}

function isHttpsBlock(mask, block) {
  return /listen\s+[^;]*\b443\b/.test(mask.slice(block.start, block.end));
}

// 解析单个 vhost 文件，返回站点信息（无 443 server 块则返回 null）
function parseVhost(text) {
  const mask = maskText(text);
  const blocks = findServerBlocks(mask);
  const https = blocks.find((b) => isHttpsBlock(mask, b));
  if (!https) return null;

  const body = mask.slice(https.start, https.end);
  const sn = body.match(/server_name\s+([^;]+);/);
  if (!sn) return null;
  const names = sn[1].trim().split(/\s+/).filter((n) => n && n !== '_' && n !== 'localhost');
  if (!names.length) return null;

  const rootM = body.match(/\broot\s+([^;]+);/);
  const proxyM = body.match(/\bproxy_pass\s+([^;]+);/);
  // 只会命中 ssl_certificate，不会命中 ssl_certificate_key（其后是 "_" 而非空白）
  const certM = body.match(/(?:^|\s)ssl_certificate\s+([^;]+);/);

  return {
    httpsBlock: https,
    names,
    domain: names[0],
    type: proxyM ? 'proxy' : (rootM ? 'static' : 'other'),
    root: rootM ? rootM[1].trim() : null,
    proxy: proxyM ? proxyM[1].trim() : null,
    cert: certM ? certM[1].trim() : null,
    injected: text.includes(SENTINEL_KEY)
  };
}

/* ---------- nginx 命令 ---------- */

function nginxTest(config) {
  try {
    execFileSync(config.nginx.bin, ['-t', '-c', config.nginx.conf], { stdio: 'pipe' });
    return true;
  } catch (e) {
    return false;
  }
}

function nginxTestMessage(config) {
  try {
    execFileSync(config.nginx.bin, ['-t', '-c', config.nginx.conf], { stdio: 'pipe' });
    return { ok: true, message: '' };
  } catch (e) {
    const msg = (e.stderr && e.stderr.toString()) || (e.stdout && e.stdout.toString()) || e.message;
    return { ok: false, message: msg.trim() };
  }
}

function nginxReload(config) {
  execFileSync(config.nginx.bin, ['-s', 'reload', '-c', config.nginx.conf], { stdio: 'pipe' });
}

/* ---------- 状态文件与维护页 ---------- */

function stateFileOf(config, domain) {
  return path.join(config.nginx.stateDir, domain + '.conf');
}

// 维护态片段：用命名 location 承接 error_page，
// 命名 location 的内部跳转不会重跑 server 级 rewrite，因此不会被 return 503 再次拦截（无死循环）
function denyConf(config) {
  return (
    '# admin-panel: maintenance ON — 由面板自动生成，请勿手改\n' +
    'error_page 503 @' + DENY_MARK + ';\n' +
    'location @' + DENY_MARK + ' {\n' +
    '    root ' + config.nginx.maintRoot + ';\n' +
    '    try_files /index.html =503;\n' +
    '    add_header Retry-After 3600 always;\n' +
    '    add_header Cache-Control "no-store" always;\n' +
    '}\n' +
    'return 503;\n'
  );
}

const ALLOW_CONF = '# admin-panel: allow\n';

function isBlocked(config, domain) {
  const f = stateFileOf(config, domain);
  try {
    return fs.readFileSync(f, 'utf8').includes(DENY_MARK);
  } catch (e) {
    return false;
  }
}

// 原子写文件
function writeAtomic(file, content, mode) {
  const tmp = file + '.tmp.' + process.pid;
  fs.writeFileSync(tmp, content, { mode: mode || 0o644 });
  fs.renameSync(tmp, file);
  try { fs.chmodSync(file, mode || 0o644); } catch (e) { /* ignore */ }
}

/* ---------- 对外接口 ---------- */

function listSites(config) {
  const dir = config.nginx.vhostDir;
  if (!fs.existsSync(dir)) return [];
  const sites = [];
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith('.conf')) continue;
    const full = path.join(dir, f);
    let text;
    try { text = fs.readFileSync(full, 'utf8'); } catch (e) { continue; }
    const info = parseVhost(text);
    if (!info) continue;
    sites.push({
      domain: info.domain,
      names: info.names,
      file: f,
      type: info.type,
      root: info.root,
      proxy: info.proxy,
      cert: info.cert,
      injected: info.injected,
      blocked: isBlocked(config, info.domain)
    });
  }
  sites.sort((a, b) => a.domain.localeCompare(b.domain));
  return sites;
}

// 首次接管：创建状态文件（必须存在，否则 include 会让 nginx -t 失败），再注入 include
function takeover(config, domain) {
  const site = listSites(config).find((s) => s.domain === domain);
  if (!site) throw new Error('未找到站点: ' + domain);
  if (site.injected) return { changed: false };

  fs.mkdirSync(config.nginx.stateDir, { recursive: true });
  const sf = stateFileOf(config, domain);
  if (!fs.existsSync(sf)) writeAtomic(sf, ALLOW_CONF, 0o644);

  const full = path.join(config.nginx.vhostDir, site.file);
  const text = fs.readFileSync(full, 'utf8');
  const info = parseVhost(text);
  if (!info) throw new Error('解析 vhost 失败');
  if (text.includes(SENTINEL_KEY)) return { changed: false };

  const injectLine = '\n    ' + SENTINEL + '\n    include ' + config.nginx.stateDir + '/' + domain + '.conf;\n';
  const next = text.slice(0, info.httpsBlock.end) + injectLine + text.slice(info.httpsBlock.end);

  // 备份 → 原子替换 → nginx -t 校验 → 失败回滚
  const backup = full + '.bak.' + Date.now();
  fs.copyFileSync(full, backup);
  writeAtomic(full, next, 0o644);

  const test = nginxTestMessage(config);
  if (!test.ok) {
    fs.copyFileSync(backup, full);
    throw new Error('nginx 校验失败，已回滚：' + test.message);
  }
  nginxReload(config);
  return { changed: true, backup };
}

// 切换维护开关
function setMaintenance(config, domain, blocked) {
  const site = listSites(config).find((s) => s.domain === domain);
  if (!site) throw new Error('未找到站点: ' + domain);
  if (!site.injected) throw new Error('该站点尚未接管，请先点「接管」');

  fs.mkdirSync(config.nginx.stateDir, { recursive: true });
  const sf = stateFileOf(config, domain);
  const prev = fs.existsSync(sf) ? fs.readFileSync(sf, 'utf8') : null;

  writeAtomic(sf, blocked ? denyConf(config) : ALLOW_CONF, 0o644);

  const test = nginxTestMessage(config);
  if (!test.ok) {
    if (prev === null) { try { fs.unlinkSync(sf); } catch (e) {} }
    else writeAtomic(sf, prev, 0o644);
    throw new Error('nginx 校验失败，已回滚：' + test.message);
  }
  nginxReload(config);
  return { blocked };
}

module.exports = {
  listSites,
  takeover,
  setMaintenance,
  isBlocked,
  nginxTestMessage,
  SENTINEL_KEY
};
