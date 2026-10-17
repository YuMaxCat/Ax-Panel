# 第 7 步 · 自检与完成报告
# ⚠ 这一段由服务器分步下发、被 runner 用 . <(...) 直接 source 到当前 shell，
#   不是独立脚本 —— 不要加 shebang / set -e，也别指望能单独 bash 跑。

step '自检收尾'

# ---------- 安装自检 ----------
# 走完整的启动器跑一遍，把问题暴露在安装阶段，而不是客户第一次敲 claude 的时候
log "正在自检 ..."
selfcheck="$(mktemp)"
if ! claude --version >/dev/null 2>"$selfcheck"; then
  warn "自检未通过，首次运行 claude 时可能会报错："
  sed 's/^/        /' "$selfcheck" >&2 || true
  warn "如果只是网络问题，联网后重跑 claude 即可；否则请联系管理员。"
else
  log "自检通过: $(claude --version 2>/dev/null | head -1)"
fi
rm -f "$selfcheck"

# ---------- 版本目录占用提示 ----------
report_versions() {
  [[ -d "$CC_HOME/versions" ]] || return 0
  local n
  n="$(find "$CC_HOME/versions" -mindepth 1 -maxdepth 1 -type d 2>/dev/null | wc -l)"
  if (( n > 1 )); then
    warn "本机保留了 ${n} 个版本（每个约 224MB），清理旧版本可执行:"
    warn "  ls $CC_HOME/versions && rm -rf $CC_HOME/versions/<旧版本号>"
  fi
}

report_versions

# ---------- 完成 ----------
echo ""
echo "${C_GRN}===== 安装完成 =====${C_RST}"
echo "  Claude Code : ${INSTALLED_VER}"
echo "  npm registry: ${NPM_REGISTRY}"
echo "  模型        : ${MODEL}（small/fast: ${SMALL_MODEL}）"
echo "  上下文窗口  : ${CONTEXT_TOKENS} tokens"
echo "  配置写入    : $(detect_rc) / ~/.claude.json / ~/.claude/settings.json"
echo "  API Key     : ${API_KEY:0:7}****（你自己的 Key，换一个直接改 ~/.claude/settings.json）"
echo "  设备绑定    : 已绑定本机，换机请联系管理员解绑后重装"
echo ""
echo "请执行以下命令使其生效:"
echo "  source $(detect_rc)"
echo "然后运行: claude"
echo ""
