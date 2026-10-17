# 第 4 步 · 安装 Claude Code
# ⚠ 这一段由服务器分步下发、被 runner 用 iex 在同一会话里执行，不是独立脚本 ——
#   不要加 param() 块，不要用 exit，不要在顶层写裸 break，不要出现 here-string。
#
# Windows 这边走 npm，跟 Termux 那套完全不同（那边是因为上游没有 android 构建，
# 才要手动下 linux-arm64 的 tarball 再 patchelf）。官方的 irm install.ps1 从 claude.ai
# 取包，国内不可达，所以只能用 npm 镜像 —— 好在两个镜像上平台包都是齐的。
#
# 装到 $CCX\npm-global（引导段按客户选的盘算好的安装根目录，01 步已经把它写进用户
# PATH），不碰客户自己的 node_modules 和全局 npm 目录。

Write-CcStep '安装程序本体'

$CC_CLAUDE_PKG = '@anthropic-ai/claude-code'
$CC_PLATFORM_PKG = '@anthropic-ai/claude-code-win32-' + $CC_ARCH   # 原生二进制在这个包（optionalDependency）
$CC_CLAUDE_CMD = Join-Path $CC_NPM_DIR 'claude.cmd'
$CC_NPM_CACHE = Join-Path $CCX 'npm-cache'                          # 缓存放 .ccx 里，卸载就是删一个目录
$ccNpm = Join-Path $CC_NODE_DIR 'npm.cmd'

if (-not (Test-Path -LiteralPath $ccNpm)) {
  Stop-Cc '找不到便携版 npm（第 1 步没跑完？），安装中止。'
}

# claude 的 --version：拿到输出返回 $true，跑不起来返回 $false
function Test-CcClaude {
  # 全新安装时 claude.cmd 根本还不存在，而 & 一个不存在的命令会抛
  # CommandNotFoundException —— 那不是「装过但跑不起来」，是「还没装」，必须先挡住
  if (-not (Test-Path -LiteralPath $CC_CLAUDE_CMD)) { return $false }
  $r = Get-CcOutput $CC_CLAUDE_CMD @('--version')
  if ($r.Code -ne 0) { return $false }
  $m = [regex]::Match([string]($r.Lines -join ' '), '\d+\.\d+\.\d+')
  if (-not $m.Success) { return $false }
  $script:CC_CLAUDE_VER = $m.Value
  return $true
}

# 一次 npm 安装。返回退出码 —— 外部程序的失败不会抛异常，只能看这个
function Install-CcNpm {
  param([string]$Package, [string]$Registry)
  # ⚠ 带 + 的那个元素必须自己加括号：PS 里逗号优先级高于 +，不括号的话后面所有元素
  #   都会被拼进同一条字符串，npm 收到的就是「一个带空格的长参数」，必然装不上
  $npmArgs = @('install', '-g', $Package,
               ('--registry=' + $Registry),
               '--prefix', $CC_NPM_DIR,
               '--cache', $CC_NPM_CACHE,
               '--no-fund', '--no-audit', '--loglevel=error')
  return (Invoke-Cc $ccNpm $npmArgs)
}

# 测速选出来的源优先，官方源兜底（去重，两个一样时只试一次）
$ccRegistries = @($NPM_REGISTRY)
if ($NPM_REGISTRY -ne 'https://registry.npmjs.org') {
  $ccRegistries += 'https://registry.npmjs.org'
}

$CC_CLAUDE_VER = ''
$ccInstalled = $false
if (Test-CcClaude) {
  Write-CcLog ('本机已经装过 Claude Code ' + $CC_CLAUDE_VER + '，跳过安装')
  $ccInstalled = $true
}

if (-not $ccInstalled) {
  foreach ($reg in $ccRegistries) {
    Write-CcLog ('正在安装 Claude Code（源: ' + $reg + '） ...')
    $code = Install-CcNpm -Package $CC_CLAUDE_PKG -Registry $reg
    if ($code -eq 0 -and (Test-CcClaude)) {
      $ccInstalled = $true
      break
    }
    Write-CcWarn ('这个源没装成（退出码 ' + $code + '），换下一个再试')
  }
}

# 主包装上了、但原生二进制没跟下来：平台包是 optionalDependency，
# 客户机上要是开着 omit=optional 之类的设置就会漏装，这里单独补一次
if ($ccInstalled -eq $false -and (Test-Path -LiteralPath $CC_CLAUDE_CMD)) {
  Write-CcWarn '主包装上了但跑不起来，正在补装原生二进制包 ...'
  foreach ($reg in $ccRegistries) {
    $code = Install-CcNpm -Package $CC_PLATFORM_PKG -Registry $reg
    if ($code -eq 0 -and (Test-CcClaude)) {
      $ccInstalled = $true
      break
    }
  }
}

if (-not $ccInstalled) {
  Stop-Cc ('Claude Code 安装失败。卡没有被消耗，网络恢复后重新执行安装命令即可。' + "`r`n" +
           '如果一直失败，请把上面 npm 的报错发给管理员。')
}

Write-CcLog ('Claude Code ' + $CC_CLAUDE_VER + ' 安装完成')
