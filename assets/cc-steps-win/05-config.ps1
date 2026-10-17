# 第 5 步 · 写配置
# ⚠ 这一段由服务器分步下发、被 runner 用 iex 在同一会话里执行，不是独立脚本 ——
#   不要加 param() 块，不要用 exit，不要在顶层写裸 break，不要出现 here-string。
#
# 真正干活的是一份 Node 脚本（cc-apply-config.js），Termux 那边用的是同一份 ——
# 配置项以后加一个，两边同时生效，不会各改各的慢慢跑偏。
# 脚本正文 base64 传下来：里面全是 JS 源码，多行文本走 base64 才躲得开引号、
# 转义、here-string 终止条件这些坑。

# 兜底检查：端点/模型是第 2 步（机器锁）解出来的。这一步都到不了的话，
# 与其静默写出一份空端点的配置让客户对着 claude 发呆，不如在这里停下

Write-CcStep '写入配置'

if (-not $UPSTREAM_BASE_URL -or -not $MODEL -or -not $SMALL_MODEL) {
  Stop-Cc '端点配置缺失（机器锁未通过），安装中止。请重新执行一次安装命令。'
}

$ccNode = Join-Path $CC_NODE_DIR 'node.exe'
$ccCfgDir = Join-Path $CC_TMP 'config'
$ccApplyJs = Join-Path $ccCfgDir 'cc-apply-config.js'
New-Item -ItemType Directory -Force -Path $ccCfgDir | Out-Null

try {
  [IO.File]::WriteAllBytes($ccApplyJs, [Convert]::FromBase64String('@@APPLY_JS_B64@@'))

  # CC_HOME 决定 .claude 建在哪 —— 客户在引导段选的那块盘
  $env:CC_HOME = $CC_ROOT
  # 配置目录被重定向到 .claude 下时，.claude.json 也跟着进去（实测行为，官方文档
  # 没写），所以要额外告诉脚本它的落点；不传就还是默认的 CC_HOME 本身
  if ($CC_EXTERNAL) { $env:CC_STATE_DIR = $CC_CLAUDE_DIR }
  $env:CC_BASE_URL = $UPSTREAM_BASE_URL
  $env:CC_API_KEY = $API_KEY
  $env:CC_MODEL = $MODEL
  $env:CC_SMALL_MODEL = $SMALL_MODEL
  # 换行分隔而不是冒号：Windows 的盘符自带冒号
  $env:CC_TRUST_DIRS = $HOME + "`n" + (Get-Location).Path
  $env:CC_RC_FILE = ''                                  # Windows 没有 rc 文件，四个环境变量进 settings.json
  $env:CC_GIT_BASH_PATH = $CC_GIT_BASH                   # 01 步没装成 Git 时是空串，脚本会跳过这一项
  # 上下文窗口；07 步的完成报告要报同一个数，所以走变量而不是写两遍
  $CC_CONTEXT_TOKENS = '1000000'
  $env:CC_CONTEXT_TOKENS = $CC_CONTEXT_TOKENS

  $ccCode = Invoke-Cc $ccNode @($ccApplyJs, '--task=config')
} finally {
  # 把临时文件和这几个变量都清掉：iex 是在客户自己的会话里跑的，
  # 尤其 CC_API_KEY 不该在装完之后还留在窗口里
  Remove-Item -LiteralPath $ccCfgDir -Recurse -Force -ErrorAction SilentlyContinue
  foreach ($n in @('CC_HOME', 'CC_STATE_DIR', 'CC_BASE_URL', 'CC_API_KEY', 'CC_MODEL', 'CC_SMALL_MODEL',
                   'CC_TRUST_DIRS', 'CC_RC_FILE', 'CC_GIT_BASH_PATH', 'CC_CONTEXT_TOKENS')) {
    Remove-Item -LiteralPath ('Env:' + $n) -ErrorAction SilentlyContinue
  }
}

if ($ccCode -ne 0) {
  Stop-Cc '写配置失败，安装中止。请把上面的报错发给管理员。'
}

# ---------- 配置目录重定向 ----------
# 装到了别的盘，就得让 Claude Code 跟着去那儿读配置。CLAUDE_CONFIG_DIR 必须是
# 进程环境变量：它决定 settings.json 去哪儿找，写在 settings.json 的 env 里来不及。
# 所以写用户级注册表（跟 01 步的 PATH 一样，不碰系统级，也不需要管理员）。
#
# 反过来，这次装回用户主目录时要把重定向撤掉，否则 claude 还是去旧盘读。只删
# 「上一次是我们的脚本写进去的」那一种形状，客户自己设过的值不动。
$ccCfgChanged = $false
$ccEnvKey = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Environment', $true)
if (-not $ccEnvKey) {
  if ($CC_EXTERNAL) { Write-CcWarn '读不到用户环境变量注册表项，配置目录重定向没写上，请联系管理员。' }
} else {
  try {
    if ($CC_EXTERNAL) {
      $ccEnvKey.SetValue('CLAUDE_CONFIG_DIR', $CC_CLAUDE_DIR, [Microsoft.Win32.RegistryValueKind]::String)
      $ccCfgChanged = $true
      Write-CcLog ('配置目录: ' + $CC_CLAUDE_DIR + '（已写入用户环境变量 CLAUDE_CONFIG_DIR）')
    } else {
      $ccPrev = ''
      try { $ccPrev = [string]$ccEnvKey.GetValue('CLAUDE_CONFIG_DIR', '', [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames) } catch { }
      if ($ccPrev -match '^[A-Za-z]:\\ClaudeCode\\\.claude$') {
        $ccEnvKey.DeleteValue('CLAUDE_CONFIG_DIR', $false)
        $ccCfgChanged = $true
        Write-CcLog '已撤掉上一次指向别的盘的配置目录重定向。'
      }
    }
  } catch {
    if ($CC_EXTERNAL) { Write-CcWarn ('配置目录重定向没写上（' + $_.Exception.Message + '），请联系管理员。') }
  }
  $ccEnvKey.Close()
}
if ($ccCfgChanged) { Send-CcEnvChange }
