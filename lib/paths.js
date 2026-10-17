const fs = require('fs');
const path = require('path');

// p 是否在 roots 任一目录内（含等于）
function inRoots(p, roots) {
  return roots.some((r) => p === r || p.startsWith(r + '/'));
}

// 规范化 + 白名单校验，返回可安全操作的绝对路径
// 词法校验后还会对真实路径（realpath）复核，防 ../ 穿越与符号链接逃逸
function resolveSafe(input, roots) {
  if (typeof input !== 'string' || !input.trim()) throw new Error('路径不能为空');
  if (input.indexOf('\0') !== -1) throw new Error('非法路径');

  const abs = path.resolve(input);
  if (!inRoots(abs, roots)) throw new Error('路径不在允许范围内');

  // 向上找到最近的已存在祖先，取其真实路径，再拼回剩余部分做真实路径校验
  let probe = abs;
  while (!fs.existsSync(probe)) {
    const up = path.dirname(probe);
    if (up === probe) break;
    probe = up;
  }
  let real;
  try {
    real = path.join(fs.realpathSync(probe), path.relative(probe, abs));
  } catch (e) {
    throw new Error('路径不可访问');
  }
  if (!inRoots(real, roots)) throw new Error('路径不在允许范围内');
  return abs;
}

module.exports = { resolveSafe, inRoots };
