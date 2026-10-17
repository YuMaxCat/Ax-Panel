# 第 2 步 · 机器锁
# ⚠ 这一段由服务器分步下发、被 runner 用 . <(...) 直接 source 到当前 shell，
#   不是独立脚本 —— 不要加 shebang / set -e，也别指望能单独 bash 跑。

step '校验授权'

# ---------- 机器锁 ----------
# 服务器按本机设备指纹生成了这段密文，换台设备就解不开。
# 放在下载 96MB 安装包之前：被转发的脚本几秒内就失败，不浪费客户流量。
unlock_machine() {
  local js="$CCX_DIR/.unlock.js" blob="$CCX_DIR/.lock.enc" out="$CCX_DIR/.unlocked"
  mkdir -p "$CCX_DIR"
  chmod 700 "$CCX_DIR"

  cat > "$js" <<'CCX_UNLOCK_EOF'
@@UNLOCK_JS@@
CCX_UNLOCK_EOF
  cat > "$blob" <<'CCX_LOCK_EOF'
@@LOCK_BLOB@@
CCX_LOCK_EOF
  chmod 600 "$js" "$blob"

  # 解不开时 unlock.js 已经把原因写到 stderr 了，这里不用再补一句
  if ! node "$js" "$blob" "$out"; then
    rm -f "$js" "$blob" "$out"
    exit 1
  fi
  # shellcheck disable=SC1090
  . "$out"
  rm -f "$js" "$blob" "$out"
  log "设备校验通过"
}

unlock_machine

