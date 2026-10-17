# 第 4 步 · 安装 Claude Code
# ⚠ 这一段由服务器分步下发、被 runner 用 . <(...) 直接 source 到当前 shell，
#   不是独立脚本 —— 不要加 shebang / set -e，也别指望能单独 bash 跑。

step '安装程序本体'

# ---------- 安装 Claude Code（原生二进制 + patchelf） ----------
CLAUDE_VERSION="${CLAUDE_VERSION:-latest}"
PKG_ARM64="@anthropic-ai/claude-code-linux-arm64"
CC_HOME="$HOME/.local/share/claude"                  # 原生二进制安装根目录
GLIBC_INTERP_DEFAULT="$PREFIX/glibc/lib/ld-linux-aarch64.so.1"
TERMUX_BASH="/data/data/com.termux/files/usr/bin/bash"

CLAUDE_DIR=""
INSTALLED_VER=""

extract_ver() {
  local v="$1"
  if [[ "$v" =~ ([0-9]+\.[0-9]+\.[0-9]+) ]]; then
    echo "${BASH_REMATCH[1]}"
  else
    echo ""
  fi
}

claude_ver() { extract_ver "$(claude --version 2>/dev/null || true)"; }

npm_latest() {
  local pkg="$1"
  npm view --registry="$NPM_REGISTRY" "$pkg" version 2>/dev/null \
    | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | tail -1 || true
}

ensure_glibc_deps() {
  # glibc-runner 提供 Termux 上的 glibc 加载器；glibc-repo 必须先装并 update 才能装前者。
  # patchelf 要用 Termux(bionic) 版，不能用 patchelf-glibc —— 后者自己会被
  # LD_PRELOAD(termux-exec) 毒害而跑不起来。
  # ⚠ 已装齐时一律不调 pkg install：Termux 的 pkg 发现 apt 索引过期会自动先 update，
  #   那一步在手机上常要一两分钟，纯属白等。
  local installed p missing=()
  installed="$(pkg list-installed 2>/dev/null || true)"

  if ! grep -q '^glibc-repo/' <<<"$installed"; then
    log "安装 glibc-repo 并更新索引（首次较慢） ..."
    pkg install -y glibc-repo
    pkg update
    installed="$(pkg list-installed 2>/dev/null || true)"
  fi

  for p in glibc-runner patchelf; do
    grep -q "^${p}/" <<<"$installed" || missing+=("$p")
  done
  if (( ${#missing[@]} > 0 )); then
    log "安装缺失依赖: ${missing[*]} ..."
    pkg install -y "${missing[@]}"
  else
    log "glibc-runner / patchelf 已就绪，跳过 apt"
  fi

  [[ -f "$GLIBC_INTERP_DEFAULT" ]] || die "找不到 glibc 加载器: $GLIBC_INTERP_DEFAULT（先装 glibc-runner）"
}

# 打补丁：把 ELF 解释器指向 Termux 的 glibc 加载器。
# ⚠ 只能改解释器，绝不要加 --set-rpath —— 该二进制带附加载荷，加了会 SIGSEGV。
run_patchelf() {
  local bin="$1"
  env -u LD_PRELOAD "$PREFIX/bin/patchelf" --set-interpreter "$GLIBC_INTERP_DEFAULT" "$bin"
  log "已打补丁: interpreter → $GLIBC_INTERP_DEFAULT"
}

version_bin() { echo "$CC_HOME/versions/$1/claude"; }

download_tarball() {
  local ver="$1" dest="$2"
  local tar_name="claude-code-linux-arm64-${ver}.tgz"
  local mirror="${NPM_REGISTRY%/}/${PKG_ARM64}/-/${tar_name}"
  local official="https://registry.npmjs.org/${PKG_ARM64}/-/${tar_name}"
  local url
  local prog=(-sS)
  [[ -t 1 ]] && prog=(--progress-bar)

  if [[ -f "$dest" ]] && tar tzf "$dest" >/dev/null 2>&1; then
    log "安装包已存在且完整，跳过下载: $dest"
    return 0
  fi

  for url in "$mirror" "$official"; do
    log "下载: $url"
    if curl -fL "${prog[@]}" -C - --retry 3 --retry-delay 2 --connect-timeout 15 -o "$dest" "$url" \
       && tar tzf "$dest" >/dev/null 2>&1; then
      log "下载完成: $(du -h "$dest" | cut -f1)"
      return 0
    fi
    warn "该源下载失败，换下一个"
    rm -f "$dest"
    [[ "$mirror" == "$official" ]] && break
  done
  die "安装包下载失败，请检查网络后重新运行安装命令"
}

check_disk() {
  local avail_kb
  avail_kb="$(df -Pk "$HOME" | awk 'NR==2{print $4}')"
  if [[ -n "$avail_kb" ]] && (( avail_kb < 700000 )); then
    warn "可用空间约 $((avail_kb / 1024))MB，安装 Claude Code 约需 500MB，可能不够"
  fi
}

# 启动器：每次敲 claude 都从 ~/.bashrc 里的环境变量拿端点和 Key，
# 所以它只负责把 glibc 加载器等前置条件安排好，再 exec 真二进制
write_wrapper() {
  local dir="$1" wrapper="$PREFIX/bin/claude"
  if [[ -L "$wrapper" ]]; then
    local bak="$wrapper.bak-$(date +%Y%m%d%H%M%S)"
    mv "$wrapper" "$bak"
    log "原 claude 软链已备份 → $bak"
  fi
  # 安卓没有 /usr/bin/env，所以 shebang 必须写 bash 绝对路径。
  cat > "$wrapper" <<WRAPPER_EOF
#!$TERMUX_BASH
# Termux 专用启动器：上游只发布 linux-arm64 的 glibc 二进制（无 android 构建），
# 该二进制已用 patchelf 把 ELF 解释器指向 Termux 的 glibc 加载器，故可直接原生 exec。
VERSION_DIR=$dir

unset LD_PRELOAD
exec "\$VERSION_DIR/claude" "\$@"
WRAPPER_EOF
  chmod 700 "$wrapper"
}

install_claude() {
  ensure_glibc_deps
  check_disk

  local ver="$CLAUDE_VERSION"
  if [[ "$ver" == "latest" ]]; then
    log "查询最新版本（${PKG_ARM64}） ..."
    ver="$(npm_latest "$PKG_ARM64")"
    [[ -n "$ver" ]] || die "查询最新版本失败"
  fi
  log "目标版本: ${ver}"

  local dest; dest="$(version_bin "$ver")"
  if [[ -x "$dest" ]]; then
    log "Claude Code ${ver} 已安装，跳过下载: $dest"
  else
    local tmp tgz staging pkg_slug
    # Termux 的 /tmp 不可写，临时文件放 ~/tmp
    mkdir -p "$HOME/tmp"
    tmp="$(mktemp -d "$HOME/tmp/cc-install.XXXXXX")"
    TMP_DIRS+=("$tmp")
    # 作用域包名带 / 和 @，直接当文件名会变成子目录路径
    pkg_slug="${PKG_ARM64//\//-}"; pkg_slug="${pkg_slug//@/}"
    tgz="$tmp/${pkg_slug}-${ver}.tgz"
    staging="$CC_HOME/versions/${ver}.staging"

    download_tarball "$ver" "$tgz"

    log "解包 ..."
    tar xzf "$tgz" -C "$tmp" package/claude
    [[ -f "$tmp/package/claude" ]] || die "安装包结构异常，未找到 package/claude"

    rm -rf "$staging"
    mkdir -p "$staging"
    mv "$tmp/package/claude" "$staging/claude"
    chmod 700 "$staging/claude"

    run_patchelf "$staging/claude"
    # 补丁后先试跑，确认真的能起来，再原子落到最终目录
    local out
    out="$(env -u LD_PRELOAD "$staging/claude" --version 2>&1 || true)"
    [[ "$out" == *"$ver"* ]] || die "补丁后二进制无法运行，输出: ${out}"
    log "二进制自检通过: ${out}"

    rm -rf "$CC_HOME/versions/$ver"
    mv "$staging" "$CC_HOME/versions/$ver"
    rm -rf "$tmp"
    log "已安装到: $(version_bin "$ver")"
  fi

  write_wrapper "$(dirname "$dest")"
  CLAUDE_DIR="$(dirname "$dest")"
}

CLAUDE_DIR=""
install_claude

# 走启动器校验一遍，确保二进制真的可用
INSTALLED_VER="$(claude_ver)"
[[ -n "$INSTALLED_VER" ]] || die "校验失败: claude --version 没输出可识别的版本号"
log "校验通过: claude ${INSTALLED_VER}"

