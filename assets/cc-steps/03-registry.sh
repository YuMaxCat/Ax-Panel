# 第 3 步 · npm registry 测速
# ⚠ 这一段由服务器分步下发、被 runner 用 . <(...) 直接 source 到当前 shell，
#   不是独立脚本 —— 不要加 shebang / set -e，也别指望能单独 bash 跑。

step '选择下载源'

# npm registry 测速候选，格式 "名称|base_url"
NPM_REGISTRIES=(
  "官方 npmjs|https://registry.npmjs.org"
  "阿里 npmmirror|https://registry.npmmirror.com"
  "腾讯云|https://mirrors.cloud.tencent.com/npm"
  "华为云|https://repo.huaweicloud.com/repository/npm"
)
SPEED_PROBE_PKG="@anthropic-ai/claude-code"

NPM_REGISTRY=""

# ---------- npm registry 自动测速选优 ----------
measure_registry() {
  # 下载探测包的 metadata，3 次取平均耗时（秒）；失败或响应过小输出 -1
  # Accept 头跟 npm 自己保持一致：npm 装包时取的是精简版元数据（约 1/3 大小），
  # 不带的话量到的是「下载完整元数据」的耗时，手机流量还白跑好几 MB
  local base="$1" url="${1%/}/${SPEED_PROBE_PKG}"
  local sum=0 n=0 line t size
  for _ in 1 2 3; do
    line="$(curl -o /dev/null -s -w '%{time_total} %{size_download}' -H 'Accept: application/vnd.npm.install-v1+json' --connect-timeout 5 --max-time 15 "$url" 2>/dev/null || true)"
    t="${line%% *}"; size="${line##* }"
    if [[ -n "$t" ]] && [[ "$t" =~ ^[0-9]+(\.[0-9]+)?$ ]] && (( size >= 1000 )); then
      sum="$(awk -v a="$sum" -v b="$t" 'BEGIN{printf "%.3f", a+b}')"
      n=$((n + 1))
    fi
  done
  if (( n == 0 )); then
    echo "-1"
  else
    awk -v a="$sum" -v n="$n" 'BEGIN{printf "%.3f", a/n}'
  fi
}

pick_fastest_registry() {
  local name base t best_t="-1"
  for c in "${NPM_REGISTRIES[@]}"; do
    name="${c%%|*}"; base="${c#*|}"
    log "测速: ${name} → ${base}"
    t="$(measure_registry "$base")"
    if [[ "$t" == "-1" ]]; then
      warn "  ${name} 不可达，跳过"
      continue
    fi
    log "  下载耗时: ${t}s"
    if [[ "$best_t" == "-1" ]] || awk -v a="$t" -v b="$best_t" 'BEGIN{exit !(a<b)}'; then
      NPM_REGISTRY="$base"; best_t="$t"
    fi
  done
  if [[ -z "$NPM_REGISTRY" ]]; then
    warn "所有 registry 均不可达，回退官方源"
    NPM_REGISTRY="https://registry.npmjs.org"
    best_t="-1"
  fi
  SPEED_RESULT="$best_t"
}

log "开始 npm registry 自动测速（候选: ${#NPM_REGISTRIES[@]} 个）"
pick_fastest_registry
if [[ "$SPEED_RESULT" == "-1" ]]; then
  log "选定 registry: ${NPM_REGISTRY}"
else
  log "选定 registry: ${NPM_REGISTRY} (下载耗时 ${SPEED_RESULT}s)"
fi

