# 第 6 步 · 全局 CLAUDE.md（守则）
# ⚠ 这一段由服务器分步下发、被 runner 用 iex 在同一会话里执行，不是独立脚本 ——
#   不要加 param() 块，不要用 exit，不要在顶层写裸 break，不要出现 here-string。
#
# 跟第 5 步同一个脚本、换一个 task。正文 base64 传下来（多行 Markdown）。
# 客户自己已经有非空的全局 CLAUDE.md 时脚本会跳过，绝不覆盖。

Write-CcStep '写入全局守则'

$ccNode = Join-Path $CC_NODE_DIR 'node.exe'
$ccMdDir = Join-Path $CC_TMP 'claude-md'
$ccApplyJs = Join-Path $ccMdDir 'cc-apply-config.js'
New-Item -ItemType Directory -Force -Path $ccMdDir | Out-Null

try {
  [IO.File]::WriteAllBytes($ccApplyJs, [Convert]::FromBase64String('@@APPLY_JS_B64@@'))

  # CC_HOME 决定 cc-apply-config.js 把 .claude 建在哪 —— 客户在引导段选的那块盘
  $env:CC_HOME = $CC_ROOT
  $env:CC_MD_B64 = '@@CLAUDE_MD_B64@@'

  $ccCode = Invoke-Cc $ccNode @($ccApplyJs, '--task=claude-md')
} finally {
  Remove-Item -LiteralPath $ccMdDir -Recurse -Force -ErrorAction SilentlyContinue
  foreach ($n in @('CC_HOME', 'CC_MD_B64')) {
    Remove-Item -LiteralPath ('Env:' + $n) -ErrorAction SilentlyContinue
  }
}

if ($ccCode -ne 0) {
  # 守则写不上不算致命：Claude Code 本身已经能跑了，别让客户白装一次
  Write-CcWarn '全局 CLAUDE.md 没写上（上面有原因），不影响 Claude Code 使用。'
}
