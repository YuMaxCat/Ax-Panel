const fs = require('fs');
const path = require('path');

// 自定义 Logo 存在 data/branding/logo.png；文件不存在即回退到内置 public/logo.png。
// 版本号用文件的 mtime，前端拿它做 ?v= 查询串，CF / 浏览器缓存才会跟着刷新。
const DIR = path.join(__dirname, '..', 'data', 'branding');
const FILE = path.join(DIR, 'logo.png');

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const MAX_BYTES = 512 * 1024;

function exists() {
  try { return fs.statSync(FILE).isFile(); } catch (e) { return false; }
}

// 返回 0 表示「未设置」，前端据此回退默认图
function version() {
  try { return Math.floor(fs.statSync(FILE).mtimeMs); } catch (e) { return 0; }
}

// 只认 PNG 且以魔数校验，避免塞进任意二进制（哪怕是 HTML/SVG，都会被浏览器当图片 sniff）
function decodePng(dataUrl) {
  const s = String(dataUrl || '');
  const m = /^data:image\/png;base64,([A-Za-z0-9+/=]+)$/.exec(s);
  if (!m) throw new Error('只支持 PNG 图片');
  const buf = Buffer.from(m[1], 'base64');
  if (!buf.length) throw new Error('图片内容为空');
  if (buf.length > MAX_BYTES) throw new Error('图片过大（上限 512KB），请重新选择');
  if (buf.length < 8 || !buf.slice(0, 8).equals(PNG_MAGIC)) throw new Error('文件不是有效的 PNG 图片');
  return buf;
}

function save(dataUrl) {
  const buf = decodePng(dataUrl);
  fs.mkdirSync(DIR, { recursive: true });
  // 先写临时文件再改名：中途失败也不会留下半张坏图
  const tmp = FILE + '.tmp';
  fs.writeFileSync(tmp, buf);
  fs.renameSync(tmp, FILE);
  return version();
}

function remove() {
  try { fs.unlinkSync(FILE); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  return version();
}

module.exports = { FILE, exists, version, save, remove };
