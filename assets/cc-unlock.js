#!/usr/bin/env node
'use strict';
//
// 装机脚本的「机器锁」（Termux 版）
//
// 服务器按客户机的设备指纹 did 生成一段密文，只有那台机器能解开。
// 安装脚本一上来就调它：
//   · 解不开 → 这份脚本不是发给这台设备的（被转发了），直接退出
//   · 解开了 → 把里面的模型和端点交给安装脚本去写配置
//
// 模型和端点**只存在于密文里**（模板里没有明文占位），所以把这段解锁代码
// 删掉，配置也就写不出来了 —— 这是它唯一比「明文 if 判断」强的地方。
// 脚本本体是明文 bash，会折腾的人仍然绕得过去，属防君子不防小人。
//
// 用法: node cc-unlock.js <密文文件> <输出文件>
//
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const CCX = path.join(os.homedir(), '.ccx');
const SALT = '@@SALT@@';

function die(msg) {
  process.stderr.write(msg + '\n');
  process.exit(1);
}

function getprop(prop) {
  try {
    return execFileSync('getprop', [prop], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch (e) {
    return '';
  }
}

// 必须和阶段一脚本里的算法逐字节一致：sha256(brand|model|device|fingerprint|本地串)[:32]
function deviceId() {
  let local = '';
  try { local = fs.readFileSync(path.join(CCX, 'device.id'), 'utf8').trim(); } catch (e) { /* 缺失就是空串 */ }
  const fp = [
    getprop('ro.product.brand'),
    getprop('ro.product.model'),
    getprop('ro.product.device'),
    getprop('ro.build.fingerprint')
  ].join('|');
  return crypto.createHash('sha256').update(fp + '|' + local).digest('hex').slice(0, 32);
}

// 密文布局：base64( iv[12] | authTag[16] | ciphertext )
function unseal(did, blob) {
  const buf = Buffer.from(String(blob).replace(/\s+/g, ''), 'base64');
  if (buf.length < 29) throw new Error('密文长度异常');
  const d = crypto.createDecipheriv('aes-256-gcm', crypto.scryptSync(did, SALT, 32), buf.subarray(0, 12));
  d.setAuthTag(buf.subarray(12, 28));
  return JSON.parse(Buffer.concat([d.update(buf.subarray(28)), d.final()]).toString('utf8'));
}

const did = deviceId();

let payload;
try {
  payload = unseal(did, fs.readFileSync(process.argv[2], 'utf8'));
} catch (e) {
  // GCM 校验失败 = 密文不是给这台机器生成的（换机 / 复制了别人的安装脚本）
  die('这份安装脚本不是发给这台设备的，无法继续。\n' +
      '换机或重装过 Termux 的话，请联系管理员解绑后重新执行安装命令。');
}
if (payload.did && payload.did !== did) die('设备标识不匹配，无法继续。');

// 变量名必须和安装脚本「可配置项」里那几个空常量**逐字一致**（UPSTREAM_BASE_URL /
// MODEL / SMALL_MODEL），否则脚本 source 完仍是空串，直接判为授权文件不完整。
// JSON.stringify 出来的引号正好是 bash 认的写法
const body = [
  'UPSTREAM_BASE_URL=' + JSON.stringify(String(payload.baseUrl || '')),
  'MODEL=' + JSON.stringify(String(payload.model || '')),
  'SMALL_MODEL=' + JSON.stringify(String(payload.smallModel || ''))
].join('\n') + '\n';

try {
  fs.writeFileSync(process.argv[3], body, { mode: 0o600 });
} catch (e) {
  die('写入解锁结果失败：' + (e && e.message ? e.message : e));
}
