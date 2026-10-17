#!/data/data/com.termux/files/usr/bin/bash
#
# Claude Code 装机脚本 · 引导段（Termux 专用）
#
# 这一段本身**不含任何安装逻辑**，只做四件事：
#   1. 校验环境、算出本机设备指纹
#   2. 拿到客户的 API Key（命令里带了就用，没带就问）
#   3. 一步一步向服务器索取安装步骤，就地执行
#   4. 跑完把自己删掉
#
# 真正的安装逻辑在服务器上，按「卡密 + 设备指纹」逐步下发，客户机上不落盘。
# 卡密只管「能不能装」：装完之后服务器不再参与，敲 claude 不联网。
#
# 为什么 Termux 要这么装:
#   上游只发布 linux-arm64 的 glibc 二进制，没有 android 构建。直接跑会报
#   libc.so: invalid ELF header，所以必须自配 glibc 运行时 + patchelf 改 ELF
#   解释器 + 包一层启动器，顺带绕开首次启动的三道确认弹窗。
#
# 跑完本脚本会自动删除自己。
#
set -euo pipefail

CC_KEY='@@KEY@@'
CC_HOST='@@HOST@@'

# ---------- 端点与模型（占位，真实值由服务器下发） ----------
# 真实值在第 2 步的机器锁密文里，用本机 did 解出来。这里只声明、不写死：
# set -u 下，万一第 2 步没跑，第 5 步的兜底检查能干净地报错，而不是崩在 unbound variable。
# 变量名必须与 assets/cc-unlock.js 写出来的一致（有回归断言盯着）。
MODEL=""
SMALL_MODEL=""
UPSTREAM_BASE_URL=""

CC_DID=""
API_KEY=""                                           # 客户自己的 Key

# ---------- 颜色 ----------
if [[ -t 1 ]]; then
  C_RED=$'\033[31m'; C_GRN=$'\033[32m'; C_YLW=$'\033[33m'; C_CYN=$'\033[36m'; C_RST=$'\033[0m'
else
  C_RED=""; C_GRN=""; C_YLW=""; C_CYN=""; C_RST=""
fi
log()  { echo "${C_CYN}[Ax]${C_RST} $*"; }
warn() { echo "${C_YLW}[注意]${C_RST} $*"; }
die()  { echo "${C_RED}[错误]${C_RST} $*" >&2; exit 1; }

# 每步开头的进度条，由各步自己调（标题就写在那一步的文件里，改步骤时不会忘）：
#   [■■■□□□□] 3/7  写入配置
# 总数是服务器随每一步捎下来的。CC_STEP_TOTAL 用 :- 兜住是因为 set -u 开着 ——
# 拿不到数就退回 [3] 这种朴素写法，进度显示是锦上添花，不该反过来把安装搞挂。
step() {
  local total="${CC_STEP_TOTAL:-0}" shown="$CC_STEP" bar="" i
  if [[ "$total" =~ ^[0-9]+$ ]] && (( total > 0 )); then
    (( shown > total )) && shown=$total
    for (( i = 0; i < shown; i++ )); do bar+="■"; done
    for (( i = shown; i < total; i++ )); do bar+="□"; done
    bar="[${bar}] ${CC_STEP}/${total}"
  else
    bar="[${CC_STEP}]"
  fi
  echo ""
  echo "${C_CYN}${bar}  $*${C_RST}"
}

# ---------- 自毁 + 临时目录清理 ----------
self_destruct() {
  local f="$1" sz
  [[ -f "$f" ]] || return 0
  sz="$(stat -c %s "$f" 2>/dev/null || echo 0)"
  if [[ "$sz" -gt 0 ]]; then
    dd if=/dev/urandom of="$f" bs=4096 count=$(( sz / 4096 + 1 )) conv=notrunc status=none 2>/dev/null || true
  fi
  rm -f "$f"
}

TMP_DIRS=()
CC_SELF="$(cd "$(dirname "$0")" 2>/dev/null && pwd)/$(basename "$0")"
[[ -f "$CC_SELF" ]] || CC_SELF=""

cleanup_all() {
  local d
  for d in ${TMP_DIRS[@]+"${TMP_DIRS[@]}"}; do
    [[ -n "$d" && -d "$d" ]] && rm -rf "$d"
  done
  if [[ -n "$CC_SELF" ]]; then self_destruct "$CC_SELF"; fi
  return 0
}
trap cleanup_all EXIT

# ---------- 1. 环境校验 ----------
if [[ ! -d /data/data/com.termux ]] && [[ -z "${TERMUX_VERSION:-}" ]]; then
  die "本脚本是 Termux 专用版，当前不是 Termux 环境。"
fi
if [[ "$(uname -m)" != "aarch64" ]]; then
  die "仅支持 arm64(aarch64) 设备，当前架构: $(uname -m)"
fi
log "环境: Termux / $(uname -m)"

# ---------- 2. 设备指纹 ----------
# getprop 的部分在同型号手机上是一样的，所以必须混入一段本机随机串才能区分设备。
# 存的是随机串而不是 did —— 直接存 did 的话，复制那个文件就能冒充本机。
# 服务器按这个 did 认设备：换一台手机，就算把安装命令原样转过去也会被挡下来。
CCX_DIR="$HOME/.ccx"                                 # 设备标识目录（装完只剩 device.id）
mkdir -p "$CCX_DIR"
chmod 700 "$CCX_DIR"
if [[ ! -s "$CCX_DIR/device.id" ]]; then
  head -c 16 /dev/urandom | od -An -tx1 | tr -d ' \n' > "$CCX_DIR/device.id"
  chmod 600 "$CCX_DIR/device.id"
fi
CC_LOCAL="$(cat "$CCX_DIR/device.id")"
CC_FP="$(getprop ro.product.brand)|$(getprop ro.product.model)|$(getprop ro.product.device)|$(getprop ro.build.fingerprint)"
CC_DID="$(printf '%s|%s' "$CC_FP" "$CC_LOCAL" | sha256sum | cut -c1-32)"
CC_LABEL="$(getprop ro.product.brand) $(getprop ro.product.model)"
log "设备: ${CC_LABEL}"

# ---------- 3. 客户自己的 API Key ----------
# 卡密只管「装」这一步，Key 是客户自己的：由安装命令带进来（CC_API_KEY='sk-...'），
# 没带就现场问。全程不经过服务器，也不进任何日志。
ask_api_key() {
  if [[ -z "${CC_API_KEY:-}" ]]; then
    {
      echo ""
      echo "还需要你的 DeepSeek API Key（https://platform.deepseek.com 申请，形如 sk-...）"
      printf "请粘贴后回车: "
    } >&2
    # 优先读终端：客户可能把命令塞进别的地方跑，这时候 stdin 已经不是键盘了
    if [[ -r /dev/tty ]] && read -r CC_API_KEY < /dev/tty 2>/dev/null; then
      :
    else
      read -r CC_API_KEY || true
    fi
  fi
  API_KEY="$(printf '%s' "${CC_API_KEY:-}" | tr -d '[:space:]')"

  [[ -n "$API_KEY" ]] || die "没有收到 API Key，安装中止。拿到 Key 后重新执行安装命令即可。"
  # 收紧字符集：下面要把 Key 写进 .bashrc 和 settings.json，含引号/美元符会把配置写坏
  [[ "$API_KEY" =~ ^[A-Za-z0-9._-]+$ ]] || die "API Key 含非法字符（只允许字母、数字、. _ -），请检查后重试。"
  [[ "$API_KEY" == sk-* ]] || warn "这个 Key 不像 DeepSeek 的（通常以 sk- 开头），仍然继续。"

  log "已收到 API Key: ${API_KEY:0:7}****"
}
ask_api_key

# ---------- 4. 逐步安装 ----------
# 每一步都单独向服务器要，要到就就地执行。用 . <(...) 而不是 curl | bash：
#   · 管道会另起一个子 shell，变量和 TMP_DIRS 传不回来，下一步就瞎了；
#   · process substitution 是在**当前 shell** 里 source，状态留得住；
#   · 代码只从管道过一遍，不落盘 —— 客户机上没有「一份可以拿去改的安装脚本」。
CC_STEP=1
CC_MAX_STEPS=30          # 防呆：服务器真出问题时不至于无限循环
log "正在校验卡密并获取安装步骤 ..."
while (( CC_STEP <= CC_MAX_STEPS )); do
  # -w 把状态码追加在最后一行，body 留在内存里（不落地）
  CC_RESP="$(curl -sS -G -w $'\n%{http_code}' \
    --connect-timeout 15 --max-time 60 \
    --data-urlencode "key=$CC_KEY" \
    --data-urlencode "did=$CC_DID" \
    --data-urlencode "label=$CC_LABEL" \
    --data-urlencode "i=$CC_STEP" \
    "$CC_HOST/api/cc/step" 2>/dev/null)" || CC_RESP=$'\n000'
  CC_CODE="${CC_RESP##*$'\n'}"
  CC_BODY="${CC_RESP%$'\n'*}"

  if [[ "$CC_CODE" != "200" ]]; then
    echo "" >&2
    if [[ "$CC_CODE" == "000" ]]; then
      die "连不上授权服务器（第 ${CC_STEP} 步），检查网络后重试。"
    fi
    die "$(printf '%s' "$CC_BODY" | head -c 500)"
  fi

  # shellcheck disable=SC1090
  . <(printf '%s\n' "$CC_BODY")

  # 服务器把「没有下一步了」也写成一行 bash，客户端不用猜步数
  if [[ -n "${CC_STEP_DONE:-}" ]]; then break; fi
  CC_STEP=$(( CC_STEP + 1 ))
done

if (( CC_STEP > CC_MAX_STEPS )); then
  die "安装步骤异常（超过 ${CC_MAX_STEPS} 步），请联系管理员。"
fi
