# 第 2 步 · 机器锁
# ⚠ 这一段由服务器分步下发、被 runner 用 iex 在同一会话里执行，不是独立脚本 ——
#   不要加 param() 块，不要用 exit，不要在顶层写裸 break，不要出现 here-string。
#
# 服务器按本机设备指纹 did 生成了一段密文（只有这台机器解得开），端点、模型全在里面，
# 模板里没有明文 —— 把解锁脚本删掉，配置也就写不出来了。
# 排在下 96MB 的安装包之前：被转发的脚本几秒钟就失败，不浪费客户流量。
#
# 解锁脚本和密文都是 base64 传下来的（两段正文都多行，base64 能彻底躲开
# here-string 终止条件、引号、转义这些坑）。还原到临时目录跑完就删，
# 不给客户机留下一份「可以拿去改的安装脚本」。

Write-CcStep '校验授权'

$ccNodeExe = Join-Path $CC_NODE_DIR 'node.exe'
if (-not (Test-Path -LiteralPath $ccNodeExe)) {
  Stop-Cc '找不到便携版 Node（第 1 步没跑完？），安装中止。'
}

$ccLockDir  = Join-Path $CC_TMP 'lock'
$ccUnlockJs = Join-Path $ccLockDir 'cc-unlock-win.js'
$ccLockBlob = Join-Path $ccLockDir 'lock.enc'
New-Item -ItemType Directory -Force -Path $ccLockDir | Out-Null

try {
  # 用 WriteAllBytes 而不是写文本：base64 解码出来的是字节，走一次文本再转回来
  # 只会平白多一次编码风险
  [IO.File]::WriteAllBytes($ccUnlockJs, [Convert]::FromBase64String('@@UNLOCK_B64@@'))
  [IO.File]::WriteAllText($ccLockBlob, '@@LOCK_B64@@', (New-Object Text.UTF8Encoding $false))

  # Get-CcOutput 会把解锁脚本的 stderr（中文失败原因）直接显示给客户，stdout 收回来解析
  $ccLock = Get-CcOutput $ccNodeExe @($ccUnlockJs, $ccLockBlob, $CC_DID)
  if ($ccLock.Code -ne 0) {
    Stop-Cc ('这个安装脚本不是发给这台设备的，无法继续。' + "`r`n" +
             '换过电脑的话，请联系管理员解绑后重新执行安装命令。')
  }
} finally {
  Remove-Item -LiteralPath $ccLockDir -Recurse -Force -ErrorAction SilentlyContinue
}

try {
  $ccJson = ([string]($ccLock.Lines -join "`n")).Trim() | ConvertFrom-Json
} catch {
  Stop-Cc '设备校验结果解析失败，请联系管理员。'
}

# 变量名必须与 assets/cc-unlock-win.js 的输出字段、引导段里的空常量三方对齐（有回归断言盯着）
$UPSTREAM_BASE_URL = [string]$ccJson.baseUrl
$MODEL             = [string]$ccJson.model
$SMALL_MODEL       = [string]$ccJson.smallModel

if (-not $UPSTREAM_BASE_URL -or -not $MODEL -or -not $SMALL_MODEL) {
  Stop-Cc '设备校验通过但端点/模型是空的，请联系管理员检查这张卡。'
}

# 这三个变量交给第 5 步写进 settings.json 的 env（Termux 那边写的是 .bashrc，
# 一个道理）。这里不动 $env: —— 客户这个 PowerShell 窗口是他自己的，
# 装完不该留一堆改动在里面
Write-CcLog '设备校验通过'
