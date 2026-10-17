#!/usr/bin/env bash
# 从 public/logo.png 重新生成维护页 maint/index.html 里的圆形头像（内联 base64）。
# 换了 Logo 之后跑一次即可，不用手改那串 base64。
#   用法：bash tools/make-maint-logo.sh
#   依赖：python3 + Pillow（本地 Termux 跑；服务器上没有 Pillow，也不需要——
#         在本地生成好后把 maint/index.html 传到 /opt/Ax-Panel/maint/ 即可）
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SRC="$DIR/public/logo.png"
DST="$DIR/maint/index.html"

[ -f "$SRC" ] || { echo "找不到 $SRC" >&2; exit 1; }
[ -f "$DST" ] || { echo "找不到 $DST" >&2; exit 1; }

python3 - "$SRC" "$DST" <<'PY'
import base64, io, re, sys
from PIL import Image

src, dst = sys.argv[1], sys.argv[2]

im = Image.open(src).convert('RGB')
w, h = im.size
s = min(w, h)
# 居中裁正方形（横向居中、纵向从顶部起），保住脸部构图
sq = im.crop(((w - s) // 2, 0, (w - s) // 2 + s, s)).resize((320, 320), Image.LANCZOS)

buf = io.BytesIO()
sq.save(buf, format='JPEG', quality=88, optimize=True, progressive=True)
b64 = base64.b64encode(buf.getvalue()).decode()

html = open(dst, encoding='utf-8').read()
new, n = re.subn(r'(data:image/jpeg;base64,)[A-Za-z0-9+/=]+',
                 lambda m: m.group(1) + b64, html)
if n != 1:
    sys.exit('期望替换 1 处 base64，实际 %d 处 —— 中止，请检查 %s' % (n, dst))

open(dst, 'w', encoding='utf-8').write(new)
print('ok: %s -> %s  (%d 字节 jpeg / %d 字符 base64)' % (src, dst, len(buf.getvalue()), len(b64)))
PY
