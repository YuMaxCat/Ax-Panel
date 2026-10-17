# 第 1 步 · 依赖检测与安装
# ⚠ 这一段由服务器分步下发、被 runner 用 . <(...) 直接 source 到当前 shell，
#   不是独立脚本 —— 不要加 shebang / set -e，也别指望能单独 bash 跑。

step '安装依赖'

# ---------- 依赖检测与安装 ----------
need_cmd() { command -v "$1" >/dev/null 2>&1; }

install_deps() {
  local missing=() c
  for c in node npm curl; do
    need_cmd "$c" || missing+=("$c")
  done
  if (( ${#missing[@]} > 0 )); then
    log "安装缺失依赖: ${missing[*]} ..."
    pkg install -y nodejs-lts curl      # nodejs-lts 自带 npm
  fi
  for c in node npm curl; do
    need_cmd "$c" || die "$c 安装失败，请手动 pkg install nodejs-lts curl"
  done
  log "依赖已就绪: node $(node -v) / npm $(npm -v) / curl"
}

install_deps

