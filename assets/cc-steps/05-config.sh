# 第 5 步 · 全局配置
# ⚠ 这一段由服务器分步下发、被 runner 用 . <(...) 直接 source 到当前 shell，
#   不是独立脚本 —— 不要加 shebang / set -e，也别指望能单独 bash 跑。

step '写入配置'

# ---------- 全局配置 ----------
CONTEXT_TOKENS="${CONTEXT_TOKENS:-1000000}"                  # DeepSeek V4 全系真实窗口 1M
MODEL_BEHAVES_AS="${MODEL_BEHAVES_AS:-claude-opus-4-8}"      # 主模型按 opus 行为跑
SMALL_BEHAVES_AS="${SMALL_BEHAVES_AS:-claude-haiku-4-5}"     # small 按 haiku 行为跑
DEFAULT_MODEL_FIELD="${DEFAULT_MODEL_FIELD:-sonnet[1m]}"

detect_rc() {
  case "$(basename "${SHELL:-bash}")" in
    zsh)  echo "${ZDOTDIR:-$HOME}/.zshrc" ;;
    fish) echo "$HOME/.config/fish/config.fish" ;;
    *)    echo "$HOME/.bashrc" ;;
  esac
}

# 真正落盘的代码在 assets/cc-apply-config.js —— 和 Windows 版**共用同一份**，
# 由服务器 base64 下发、解到临时目录再跑（不落盘到客户会看到的地方，跑完随 TMP_DIRS 清掉）。
# 这里只负责递参数、翻译退出码。
#
# 参数全走环境变量：端点、模型、信任目录里可能有空格和冒号，塞进命令行就得处理引号。
# 信任目录用换行分隔 —— 路径里不会出现换行，比冒号安全。
update_cc_config() {
  local dir js
  mkdir -p "$HOME/tmp"
  dir="$(mktemp -d "$HOME/tmp/cc-config.XXXXXX")"
  TMP_DIRS+=("$dir")
  js="$dir/cc-apply-config.js"
  printf '%s' '@@APPLY_JS_B64@@' | base64 -d > "$js" || die "配置脚本解压失败，安装中止。"
  [[ -s "$js" ]] || die "配置脚本为空，安装中止。"

  # Key 是客户自己的，明文写进 .bashrc 和 settings.json 即可 —— 他自己的机器、
  # 他自己的 Key，藏起来没有意义。装完之后服务器不再参与，敲 claude 不联网。
  #
  # 端点与模型是机器锁解出来的，为空说明第 2 步被跳过了或者没解开 ——
  # 共享脚本会拦住，不会静默写出一份空端点的配置让客户对着 claude 发呆。
  CC_HOME="$HOME" \
  CC_BASE_URL="$UPSTREAM_BASE_URL" \
  CC_API_KEY="$API_KEY" \
  CC_MODEL="$MODEL" \
  CC_SMALL_MODEL="$SMALL_MODEL" \
  CC_CONTEXT_TOKENS="$CONTEXT_TOKENS" \
  CC_MODEL_BEHAVES_AS="$MODEL_BEHAVES_AS" \
  CC_SMALL_BEHAVES_AS="$SMALL_BEHAVES_AS" \
  CC_DEFAULT_MODEL_FIELD="$DEFAULT_MODEL_FIELD" \
  CC_TRUST_DIRS="$HOME"$'\n'"$PWD" \
  CC_RC_FILE="$(detect_rc)" \
  node "$js" --task=config || die "写配置失败，安装中止。请把上面的报错发给管理员。"
}

update_cc_config

