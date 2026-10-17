# 第 6 步 · 全局 CLAUDE.md
# ⚠ 这一段由服务器分步下发、被 runner 用 . <(...) 直接 source 到当前 shell，
#   不是独立脚本 —— 不要加 shebang / set -e，也别指望能单独 bash 跑。

step '写入全局守则'

# ---------- 全局 CLAUDE.md（已存在则跳过） ----------
# 正文由服务器 base64 下发（和 Windows 版同一份 assets/cc-claude-md.md），
# 经环境变量交给共享脚本落盘 —— 不再用 heredoc：正文里万一出现定界符那一行
# （客户可能自己往里加东西），heredoc 会当场截断，base64 没这个问题。
write_claude_md() {
  local dir js
  mkdir -p "$HOME/tmp"
  dir="$(mktemp -d "$HOME/tmp/cc-md.XXXXXX")"
  TMP_DIRS+=("$dir")
  js="$dir/cc-apply-config.js"
  printf '%s' '@@APPLY_JS_B64@@' | base64 -d > "$js" || die "配置脚本解压失败，安装中止。"
  [[ -s "$js" ]] || die "配置脚本为空，安装中止。"

  CC_HOME="$HOME" \
  CC_MD_B64='@@CLAUDE_MD_B64@@' \
  node "$js" --task=claude-md || die "写全局 CLAUDE.md 失败，安装中止。"
}

write_claude_md

