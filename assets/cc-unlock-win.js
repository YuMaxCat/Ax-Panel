#!/usr/bin/env node
'use strict';
//
// 装机脚本的「机器锁」（Windows 版）
//
// 服务器按客户机的设备指纹 did 生成一段密文，只有那台机器能解开。
// 安装脚本第 2 步调它：
//   · 解不开 → 这份安装脚本不是发给这台设备的（被转发了），直接退出
//   · 解开了 → 把里面的模型和端点交给安装脚本去写配置
//
// 模型和端点**只存在于密文里**（模板里没有明文占位），所以把这段解锁代码
// 删掉，配置也就写不出来了 —— 这是它唯一比「明文 if 判断」强的地方。
// 脚本本体是明文 JS，会折腾的人仍然绕得过去，属防君子不防小人。
//
// 跟 Termux 版（cc-unlock.js）的差别只有一处、但很关键：**did 由命令行传进来**，
// 这里不自己算。Termux 那版自己算是因为历史形态；Windows 侧如果也各算一份，
// 「PowerShell 算 did」和「Node 算 did」就有了两套实现，哪天改了一处忘了另一处，
// 表现是「装机永远卡在第 2 步」，而且极难查。这里只留一份实现（在引导段里）。
//
// 用法: node cc-unlock-win.js <密文文件> <did>
// 输出: 一行 JSON（{"baseUrl":…,"model":…,"smallModel":…}），错误走 stderr + 非零退出码
//
const fs = require('fs');
const crypto = require('crypto');

const SALT = '@@SALT@@';

function die(msg) {
  process.stderr.write(msg + '\n');
  process.exit(1);
}

// 密文布局：base64( iv[12] | authTag[16] | ciphertext )
function unseal(did, blob) {
  const buf = Buffer.from(String(blob).replace(/\s+/g, ''), 'base64');
  if (buf.length < 29) throw new Error('密文长度异常');
  const d = crypto.createDecipheriv('aes-256-gcm', crypto.scryptSync(did, SALT, 32), buf.subarray(0, 12));
  d.setAuthTag(buf.subarray(12, 28));
  return JSON.parse(Buffer.concat([d.update(buf.subarray(28)), d.final()]).toString('utf8'));
}

const blobFile = process.argv[2];
const did = String(process.argv[3] || '').trim();
if (!blobFile || !did) die('用法: node cc-unlock-win.js <密文文件> <did>');

let payload;
try {
  payload = unseal(did, fs.readFileSync(blobFile, 'utf8'));
} catch (e) {
  // GCM 校验失败 = 密文不是给这台机器生成的（换机 / 复制了别人的安装脚本）
  die('这份安装脚本不是发给这台设备的，无法继续。\n' +
      '换过电脑的话，请联系管理员解绑后重新执行安装命令。');
}
if (payload.did && payload.did !== did) die('设备标识不匹配，无法继续。');

// 只吐 JSON：PowerShell 那边直接 ConvertFrom-Json，不用再解析文本格式。
// 字段名必须和引导段里那几个空常量对得上（有回归断言盯着）。
process.stdout.write(JSON.stringify({
  baseUrl: String(payload.baseUrl || ''),
  model: String(payload.model || ''),
  smallModel: String(payload.smallModel || '')
}) + '\n');
