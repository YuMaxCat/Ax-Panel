# 第 7 步 · 自检与完成报告
# ⚠ 这一段由服务器分步下发、被 runner 用 iex 在同一会话里执行，不是独立脚本 ——
#   不要加 param() 块，不要用 exit，不要在顶层写裸 break，不要出现 here-string。
#
# 最后一步，也是唯一一处「用完即弃」的收尾：自检 + 告诉客户接下来怎么用。

Write-CcStep '自检收尾'

Write-CcLog '正在自检 ...'
$ccSelf = Get-CcOutput $CC_CLAUDE_CMD @('--version')
if ($ccSelf.Code -ne 0) {
  Write-CcWarn '自检未通过，首次运行 claude 时可能会报错：'
  foreach ($line in $ccSelf.Lines) { Write-Host ('        ' + $line) }
  Write-CcWarn '如果只是网络问题，联网后重跑 claude 即可；否则请联系管理员。'
} else {
  Write-CcLog ('自检通过: ' + ([string]($ccSelf.Lines -join ' ')).Trim())
}

# ---------- 执行策略兜底 ----------
# npm 除了 claude.cmd 还会生成一个 claude.ps1，而 PowerShell 里敲 claude 时
# **优先命中 .ps1**。Win10 客户端默认执行策略是 Restricted，那时客户会看到
# 「无法加载文件 … 因为在此系统上禁止运行脚本」。
# 不去动客户的执行策略（那是改人家的安全设置），把它改名让出位置，
# PowerShell 自然回落到 claude.cmd —— 同一个启动器，走 cmd 而已。
$ccClaudePs1 = Join-Path $CC_NPM_DIR 'claude.ps1'
$ccPolicy = ''
try { $ccPolicy = [string](Get-ExecutionPolicy) } catch { }
if ((Test-Path -LiteralPath $ccClaudePs1) -and ($ccPolicy -eq 'Restricted' -or $ccPolicy -eq 'AllSigned')) {
  Rename-Item -LiteralPath $ccClaudePs1 -NewName 'claude.ps1.disabled' -Force -ErrorAction SilentlyContinue
  Write-CcWarn ('本机 PowerShell 执行策略是 ' + $ccPolicy + '，已改用 claude.cmd 启动（不影响使用）。')
}

# ---------- 配置目录自检 ----------
# 装到非系统盘时，配置能不能被读到全看 CLAUDE_CONFIG_DIR 这条用户环境变量写没写上。
# 写失败的话 claude 会去用户主目录找配置、找不到就当新装 —— 客户看到的是「要你登录 /
# 填 API Key」，不像报错，极容易当成卡有问题。而 05 步那句警告早被安装日志刷过去了。
# 所以这里直接回读一次注册表（查的是最终状态，不是当时的写入结果），让下面的完成
# 报告说的是实话。
$ccCfgMark = ''
if ($CC_EXTERNAL) {
  $ccCfgNow = ''
  try { $ccCfgNow = [string][Environment]::GetEnvironmentVariable('CLAUDE_CONFIG_DIR', 'User') } catch { }
  # 字符串比较默认不区分大小写，正好符合 Windows 路径的规则
  if ($ccCfgNow -ne $CC_CLAUDE_DIR) {
    $ccCfgMark = '   ⚠ 重定向未生效'
    Write-CcWarn '配置目录重定向没有生效：claude 会去用户主目录找配置，表现为要求登录 / 填 Key。'
    Write-CcWarn ('请手动把这条加进「用户环境变量」后重开终端：CLAUDE_CONFIG_DIR=' + $CC_CLAUDE_DIR)
  }
}

# ---------- 完成报告 ----------
if ($CC_GIT_OK) {
  $ccGitLine = $CC_GIT_BASH
} else {
  $ccGitLine = '未安装（Bash 工具会用 PowerShell 工具代替）'
}

Write-Host ''
Write-Host '===== 安装完成 =====' -ForegroundColor Green
Write-Host ('  Claude Code : ' + $CC_CLAUDE_VER)
Write-Host ('  npm registry: ' + $NPM_REGISTRY)
Write-Host ('  模型        : ' + $MODEL + '（small/fast: ' + $SMALL_MODEL + '）')
Write-Host ('  上下文窗口  : ' + $CC_CONTEXT_TOKENS + ' tokens')
Write-Host ('  安装位置    : ' + $CCX)
Write-Host ('  配置目录    : ' + $CC_CLAUDE_DIR + '（settings.json / CLAUDE.md）' + $ccCfgMark)
Write-Host ('  API Key     : ' + $API_KEY.Substring(0, [Math]::Min(7, $API_KEY.Length)) + '****（你自己的 Key，换一个改 settings.json 即可）')
Write-Host ('  Git Bash    : ' + $ccGitLine)
Write-Host ('  设备绑定    : 已绑定本机，换机请联系管理员解绑后重装')
Write-Host ''
Write-Host '请新开一个 PowerShell 窗口（PATH 刚更新，旧窗口认不到），然后运行:' -ForegroundColor Green
Write-Host '  claude'
Write-Host ''
