#
# Claude Code 装机脚本 · 引导段（Windows 专用）
#
# 客户在 PowerShell 里粘的是这一条：
#   irm '<host>/api/cc/install?key=AXCC-…&os=win' | iex
# 带 Key 的版本前面多一句 $env:CC_API_KEY='sk-…'。
#
# 这一段本身**不含任何安装逻辑**，只做四件事：
#   1. 校验环境、算出本机设备指纹
#   2. 拿到客户的 API Key（命令里带了就用，没带就问）
#   3. 一步一步向服务器索取安装步骤，就地执行
#   4. 跑完让客户看到结果
#
# 真正的安装逻辑在服务器上，按「卡密 + 设备指纹」逐步下发。客户粘的是 irm | iex，
# 脚本只在管道里过一遍、不落盘 —— 所以这里没有 Termux 那套自毁逻辑：客户机上
# 本来就不存在「一份可以拿去改的安装脚本」。
#
# 为什么 Windows 要这么装:
#   官方安装器（irm https://claude.ai/install.ps1 | iex）从 claude.ai 取包，国内不可达；
#   另外机器锁是 scrypt + AES-256-GCM，PowerShell 5.1（.NET Framework）两样都没有，
#   必须有 Node 才解得开 —— 顺带 npm 装 claude 也用它。Node 和 Git 都用便携版解到
#   安装根目录下的 .ccx\ 里，不弹 UAC。
#
# 装哪个盘由客户在下面选（本机磁盘是现场枚举出来的）：依赖、claude 本体和 .claude
# 配置目录一起落在所选盘的 $CC_ROOT 下，不散在系统盘里。
#
# 兼容 Windows 10 1809+ / Windows 11 自带的 Windows PowerShell 5.1。
# 整段包在一个脚本块里跑：$ErrorActionPreference 之类只影响这次安装，
# 不会把客户自己的 PowerShell 会话改掉。
#
& {

# ---------- 会话设置 ----------
# 客户的 profile 里可能开着 Set-StrictMode -Version Latest，那会让「读一个还没赋值
# 的变量」直接抛异常（各步之间正是靠变量传状态）。显式关掉，不看客户脸色。
Set-StrictMode -Off
$ErrorActionPreference = 'Stop'
$ProgressPreference    = 'SilentlyContinue'   # 5.1 的进度条会让 iwr 慢十倍
$OutputEncoding        = [Text.Encoding]::UTF8
# 5.1 默认只开 SSL3/TLS1.0，连不上只支持 TLS1.2 的服务器。
# 用 -bor 追加而不是覆盖：覆盖会把 .NET 4.8 上的 TLS1.3 一起关掉。
try {
  [Net.ServicePointManager]::SecurityProtocol =
    [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
} catch { }
# 控制台用 UTF-8，否则下面这些中文提示会变成乱码
try { [Console]::OutputEncoding = [Text.Encoding]::UTF8 } catch { }

$CC_KEY  = '@@KEY@@'
$CC_HOST = '@@HOST@@'

# ---------- 端点与模型（占位，真实值由服务器下发） ----------
# 真实值在第 2 步的机器锁密文里，用本机 did 解出来。这里只声明、不写死：
# 万一第 2 步没跑，第 5 步的兜底检查能干净地报错，而不是静默写出一份空端点的配置。
# 变量名必须与 assets/cc-unlock-win.js 吐出来的 JSON 字段对得上（有回归断言盯着）。
$MODEL              = ''
$SMALL_MODEL        = ''
$UPSTREAM_BASE_URL  = ''

$CC_DID   = ''
$API_KEY  = ''                                # 客户自己的 Key

# ---------- 输出 ----------
# 前缀和配色跟 Termux 版保持一致，客户两个平台看到的是一套说法
function Write-CcLog  { param([string]$m) Write-Host ('[Ax] ' + $m) -ForegroundColor Cyan }
function Write-CcWarn { param([string]$m) Write-Host ('[注意] ' + $m) -ForegroundColor Yellow }
# 致命错误一律 throw，**绝不能用 exit** —— 客户是用 irm | iex 跑的，exit 会把
# 他自己的 PowerShell 窗口直接关掉，报错一闪而过什么都看不到
function Stop-Cc      { param([string]$m) Write-Host ''; throw ('[错误] ' + $m) }

# 每步开头的进度条，由各步自己调（标题就写在那一步的文件里，改步骤时不会忘）：
#   [■■■□□□□] 3/7  写入配置
# 总数是服务器随每一步捎下来的（$CC_STEP_TOTAL）。这里包 try 是因为那个值来自外部，
# 万一长得不像数字，[int] 强转就会抛 —— 进度显示是锦上添花，不该反过来把安装搞挂，
# 拿不到数就退回 [3] 这种朴素写法。
function Write-CcStep {
  param([string]$Title)
  $ccTotal = 0
  try { $ccTotal = [int]$CC_STEP_TOTAL } catch { }
  $ccMark = '[' + $CC_STEP + ']'
  if ($ccTotal -gt 0) {
    $ccDone = $CC_STEP
    if ($ccDone -gt $ccTotal) { $ccDone = $ccTotal }
    $ccMark = '[' + ('■' * $ccDone) + ('□' * ($ccTotal - $ccDone)) + '] ' + $CC_STEP + '/' + $ccTotal
  }
  Write-Host ''
  Write-Host ($ccMark + '  ' + $Title) -ForegroundColor Cyan
}

# ---------- 跑外部程序 ----------
# 外部程序（node / npm / git）失败**不抛异常**，只看 $LASTEXITCODE，所以这两个
# 助手一律把退出码返回给调用方判断。
#
# 里面那句「临时把 $ErrorActionPreference 放回 Continue」是关键：原生程序写到
# stderr 的东西在 5.1 里会被包装成 ErrorRecord，而 EAP=Stop 会把它升级成终止错误 ——
# npm 装包时随便写句警告就能把整个安装打断，而且报错信息看着莫名其妙。
function Invoke-Cc {
  param([string]$File, [string[]]$Arguments = @())
  $prev = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try {
    # 输出必须显式丢给 Out-Host 而不是留在管道里：留在管道里的话，它会跟着
    # 下面那句 return 一起变成这个函数的「返回值」，调用方拿到的是一个
    # 「一堆输出行 + 退出码」的数组，判断退出码就全错了。
    # Out-Host 是逐行即时写控制台的，npm 装几百兆时客户能看着进度走。
    & $File @Arguments | Out-Host
    $code = $LASTEXITCODE
  } finally { $ErrorActionPreference = $prev }
  return $code
}

# 同上，但把 stdout 收回来自己解析（比如 claude --version）。stderr 仍然直接显示
function Get-CcOutput {
  param([string]$File, [string[]]$Arguments = @())
  $prev = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try {
    $lines = @(& $File @Arguments)
    $code = $LASTEXITCODE
  } finally { $ErrorActionPreference = $prev }
  return @{ Code = $code; Lines = $lines }
}

# ---------- 1. 环境校验 ----------
if ($env:OS -ne 'Windows_NT') { Stop-Cc '本脚本是 Windows 专用版，当前不是 Windows 环境。' }
if ($PSVersionTable.PSVersion.Major -lt 5) {
  Stop-Cc ('需要 PowerShell 5.1 或更高版本，当前是 ' + $PSVersionTable.PSVersion + '。')
}

# 32 位 PowerShell 跑在 64 位系统上时 PROCESSOR_ARCHITECTURE 会是 x86，
# 真正的架构在 PROCESSOR_ARCHITEW6432 里。ARM64 机器上自带的 powershell.exe
# 也是 x64、跑在模拟层里 —— 只看前者会给 ARM 机器装一套 x64 的东西。
$ccArch = $env:PROCESSOR_ARCHITEW6432
if (-not $ccArch) { $ccArch = $env:PROCESSOR_ARCHITECTURE }
if ($ccArch -eq 'AMD64') {
  $CC_ARCH = 'x64'
} elseif ($ccArch -eq 'ARM64') {
  $CC_ARCH = 'arm64'             # 骁龙本 / Surface Pro X
} else {
  Stop-Cc ('仅支持 64 位的 x64 / arm64 系统，当前架构: ' + $ccArch)
}

# Win10 1809（build 17763）是 Claude Code 的最低要求。低了只警告不拦 ——
# 客户真跑不起来会回来找，卡不会被白白浪费
try {
  $ccBuild = [int](Get-ItemProperty -Path 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion' `
                -Name CurrentBuildNumber -ErrorAction Stop).CurrentBuildNumber
  if ($ccBuild -lt 17763) {
    Write-CcWarn ('当前系统版本较旧（build ' + $ccBuild + '），Claude Code 需要 Windows 10 1809 及以上，可能跑不起来。')
  }
} catch { }

Write-CcLog ('环境: Windows ' + $ccArch + ' / PowerShell ' + $PSVersionTable.PSVersion)

# ---------- 2. 选安装盘 ----------
# 枚举本机磁盘让客户挑一个，后面所有东西都挂在选中的根目录下：
#   <CC_ROOT>\.ccx\     便携 Node、便携 Git、claude 本体（npm-global）、npm 缓存
#   <CC_ROOT>\.claude\  配置（settings.json / CLAUDE.md / .claude.json）
# 选中的盘符通过 $CC_ROOT 一路传到后面各步，卸载就是删一个目录。
#
# 系统盘和别人不一样：C:\ 根目录普通用户建不了文件夹（要管理员），所以用用户主目录
# 当根；其它盘的根目录默认给 Users 完全控制，用 <盘>:\ClaudeCode。客户看到的始终是
# 「装在哪个盘」，不用关心这个区别。

# 本机的本地固定磁盘。U 盘 / 移动硬盘 / 网络盘都不列 —— 那些装完拔掉就跑不起来了
function Get-CcDisk {
  $out = @()
  try {
    foreach ($d in @(Get-CimInstance -ClassName Win32_LogicalDisk -Filter 'DriveType=3' -ErrorAction Stop)) {
      if (-not $d.Size -or $d.Size -le 0) { continue }
      $out += [PSCustomObject]@{
        Letter  = [string]$d.DeviceID
        Label   = [string]$d.VolumeName
        FreeGB  = [math]::Round($d.FreeSpace / 1GB, 1)
        TotalGB = [math]::Round($d.Size / 1GB, 1)
      }
    }
    if ($out.Count -gt 0) { return $out }
  } catch { }
  # CIM 不可用（WMI 服务被关掉之类）时退回 PSDrive，只认盘符根，顺带滤掉网络盘
  foreach ($d in @(Get-PSDrive -PSProvider FileSystem -ErrorAction SilentlyContinue)) {
    if ($d.Root -notmatch '^[A-Za-z]:\\$') { continue }
    if ($null -eq $d.Free -or $null -eq $d.Used) { continue }
    $out += [PSCustomObject]@{
      Letter  = $d.Root.TrimEnd('\')
      Label   = ''
      FreeGB  = [math]::Round($d.Free / 1GB, 1)
      TotalGB = [math]::Round(($d.Free + $d.Used) / 1GB, 1)
    }
  }
  return $out
}

$ccDisks = @(Get-CcDisk)
if ($ccDisks.Count -eq 0) { Stop-Cc '没有检测到可用的本地磁盘，安装中止。' }

# 默认选可用空间最大的那块：装在快满的盘上，「解包到一半没空间了」是最常见的一种失败
$ccSysDrive = [string]$env:SystemDrive
$ccPick = $ccDisks[0]
foreach ($d in $ccDisks) { if ($d.FreeGB -gt $ccPick.FreeGB) { $ccPick = $d } }

if ($ccDisks.Count -gt 1) {
  Write-Host ''
  Write-Host '检测到以下磁盘，请选择把 Claude Code 装到哪个盘：'
  for ($ccI = 0; $ccI -lt $ccDisks.Count; $ccI++) {
    $d = $ccDisks[$ccI]
    $ccRow = '   [' + ($ccI + 1) + '] ' + $d.Letter + '\'
    if ($d.Label) { $ccRow += '  ' + $d.Label }
    if ($d.Letter -eq $ccSysDrive) { $ccRow += '  (系统盘)' }
    $ccRow += '    可用 ' + $d.FreeGB + ' GB / ' + $d.TotalGB + ' GB'
    if ($d.Letter -eq $ccPick.Letter) { $ccRow += '   ← 默认' }
    Write-Host $ccRow
  }
  $ccIn = ''
  try { $ccIn = [string](Read-Host -Prompt ('请输入序号 [1-' + $ccDisks.Count + ']，直接回车用默认')) } catch { }
  $ccIn = $ccIn.Trim()
  if ($ccIn -ne '') {
    # 限 1-3 位数字：再长就不是序号了，而 [int] 强转超长数字串会直接抛异常
    if ($ccIn -notmatch '^\d{1,3}$') { Stop-Cc '输入的序号无效，安装中止。重新执行安装命令即可重来。' }
    $ccN = [int]$ccIn
    if ($ccN -lt 1 -or $ccN -gt $ccDisks.Count) { Stop-Cc '输入的序号超出范围，安装中止。重新执行安装命令即可重来。' }
    $ccPick = $ccDisks[$ccN - 1]
  }
}

# Node 36MB + Git（解开约 350MB）+ npm 缓存 + claude 二进制约 230MB
if ($ccPick.FreeGB -lt 2) {
  Write-CcWarn ('所选磁盘可用空间只剩 ' + $ccPick.FreeGB + ' GB，安装大约需要 1.5 GB，可能会失败。')
}

if ($ccPick.Letter -eq $ccSysDrive) {
  $CC_ROOT = $HOME                                  # 系统盘：用户主目录（C:\ 根目录写不进去）
} else {
  $CC_ROOT = $ccPick.Letter + '\ClaudeCode'
}
$CCX           = Join-Path $CC_ROOT '.ccx'
$CC_CLAUDE_DIR = Join-Path $CC_ROOT '.claude'
# 配置目录不在用户主目录下时，得让 Claude Code 知道去哪儿读：它认的 CLAUDE_CONFIG_DIR
# 只能由进程环境变量提供（写进 settings.json 的 env 里来不及 —— 读 settings 之前就要
# 先靠它定位），第 5 步会把这一条写进用户级环境变量。装回系统盘时要反过来清掉。
$CC_EXTERNAL   = ($CC_ROOT -ne $HOME)

try {
  # 顺手验证这个盘真的能写。选到只读盘 / 没权限的位置时，在这里就报清楚，
  # 而不是等到下完 36MB 的 Node 才失败
  New-Item -ItemType Directory -Force -Path $CCX -ErrorAction Stop | Out-Null
} catch {
  Stop-Cc ('无法在 ' + $CC_ROOT + ' 下创建目录（' + $_.Exception.Message + '），安装中止。')
}
Write-CcLog ('安装位置: ' + $CC_ROOT)

# ---------- 3. 设备指纹 ----------
# 机器码 + 一段本机随机串。机器码单独用不行（同型号机器/克隆盘会撞），随机串单独用
# 也不行（重装一次就换了一台「设备」，售后全乱）。两者混一起才是稳定又可区分的指纹。
#
# 存的是随机串而不是 did —— 直接存 did 的话，复制那个文件就能冒充本机。
# 服务器按这个 did 认设备：换一台电脑，就算把安装命令原样转过去也会被挡下来。
# $CCX（device.id 就存在它下面）已经按上面选的盘算好了。
$ccIdFile = Join-Path $CCX 'device.id'
# 向后兼容：老版本的安装根目录固定在 %USERPROFILE%\.ccx，device.id 也在那儿。
# 这次换到别的盘时把它接过来 —— did 是绑卡的依据，重新生成一个等于「换了台设备」，
# 客户重装一次反而会被服务器当成转发挡下来。
$ccOldId = Join-Path $HOME '.ccx\device.id'
if (-not (Test-Path -LiteralPath $ccIdFile) -and (Test-Path -LiteralPath $ccOldId)) {
  try {
    Copy-Item -LiteralPath $ccOldId -Destination $ccIdFile -Force -ErrorAction Stop
  } catch {
    Write-CcWarn ('旧的设备标识没能迁移过来（这次会被当成新设备）: ' + $_.Exception.Message)
  }
}
if (-not (Test-Path -LiteralPath $ccIdFile) -or (Get-Item -LiteralPath $ccIdFile).Length -eq 0) {
  $ccRand = New-Object byte[] 16
  [Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($ccRand)
  [IO.File]::WriteAllText($ccIdFile, [BitConverter]::ToString($ccRand).Replace('-', '').ToLowerInvariant())
}
$ccLocal = ([IO.File]::ReadAllText($ccIdFile)).Trim()

$ccMachine = ''
try {
  $ccMachine = [string](Get-ItemProperty -Path 'HKLM:\SOFTWARE\Microsoft\Cryptography' `
                 -Name MachineGuid -ErrorAction Stop).MachineGuid
} catch { }
if (-not $ccMachine) { $ccMachine = [string]$env:COMPUTERNAME }   # 读不到就退而求其次，随机串仍然保证唯一

$ccSha = [Security.Cryptography.SHA256]::Create()
$CC_DID = [BitConverter]::ToString(
  $ccSha.ComputeHash([Text.Encoding]::UTF8.GetBytes($ccMachine + '|' + $ccLocal))
).Replace('-', '').ToLowerInvariant().Substring(0, 32)

$CC_LABEL = [string]$env:COMPUTERNAME
Write-CcLog ('设备: ' + $CC_LABEL)

# ---------- 4. 客户自己的 API Key ----------
# 卡密只管「装」这一步，Key 是客户自己的：由安装命令带进来（$env:CC_API_KEY='sk-...'），
# 没带就现场问。全程不经过服务器，也不进任何日志。
$ccInKey = [string]$env:CC_API_KEY
if (-not $ccInKey) {
  Write-Host ''
  Write-Host '还需要你的 DeepSeek API Key（https://platform.deepseek.com 申请，形如 sk-...）'
  try { $ccInKey = [string](Read-Host -Prompt '请粘贴后回车') } catch { $ccInKey = '' }
}
$API_KEY = ($ccInKey -replace '\s', '')

if (-not $API_KEY) { Stop-Cc '没有收到 API Key，安装中止。拿到 Key 后重新执行安装命令即可。' }
# 收紧字符集：下面要把 Key 写进 settings.json，含引号会写坏配置
if ($API_KEY -notmatch '^[A-Za-z0-9._-]+$') {
  Stop-Cc 'API Key 含非法字符（只允许字母、数字、. _ -），请检查后重试。'
}
if ($API_KEY -notlike 'sk-*') { Write-CcWarn '这个 Key 不像 DeepSeek 的（通常以 sk- 开头），仍然继续。' }
Write-CcLog ('已收到 API Key: ' + $API_KEY.Substring(0, [Math]::Min(7, $API_KEY.Length)) + '****')

# ---------- 取一步（非 200 一律抛） ----------
# 非 2xx 时把服务器的中文正文捞出来。要分两路：PowerShell 7 把正文放在
# $_.ErrorDetails.Message 里；而 5.1（客户机上跑的那个）**这一项是 null**
# （PowerShell issue #5555，一直没回填），只能从 WebException 的响应流里读。
# 先试 7 再试 5.1，两个版本都能拿到原因。
function Get-CcErrorBody {
  param($Err)
  try {
    if ($Err.ErrorDetails -and $Err.ErrorDetails.Message) { return [string]$Err.ErrorDetails.Message }
  } catch { }
  try {
    $resp = $Err.Exception.Response
    if ($resp -and $resp.GetResponseStream) {
      $sr = New-Object IO.StreamReader($resp.GetResponseStream(), [Text.Encoding]::UTF8)
      $body = $sr.ReadToEnd()
      $sr.Dispose()
      return $body
    }
  } catch { }
  return ''
}

function Get-CcText {
  param([string]$Uri, [int]$Step)
  try {
    $r = Invoke-WebRequest -Uri $Uri -UseBasicParsing -TimeoutSec 60 -ErrorAction Stop
  } catch {
    $msg = (Get-CcErrorBody $_)
    if (-not $msg) { $msg = [string]$_.Exception.Message }
    Stop-Cc ('第 ' + $Step + ' 步失败：' + $msg.Trim())
  }
  # 一律按 UTF-8 自己解码，不看服务器声明的 charset：这段正文紧接着就要被 iex 执行，
  # 而里面全是中文注释，让 PS 去猜编码（猜成 Latin-1 中文就碎了）太危险
  try { return [Text.Encoding]::UTF8.GetString($r.RawContentStream.ToArray()) }
  catch { return [string]$r.Content }
}

# ---------- 5. 逐步安装 ----------
# 每一步都单独向服务器要，要到就就地执行。用 iex 而不是另起进程：
#   · 变量留得住（下一步要用这一步算出来的 Node 路径、npm 源）；
#   · 代码只从管道过一遍，不落盘 —— 客户机上没有「一份可以拿去改的安装脚本」。
#
# 循环就写在最外层，没包成函数：函数会把每一步的**正常输出**当成返回值吞掉，
# 客户就看不到安装进度了；另外 iex 是在当前作用域里执行的，写在这里各步之间的
# 变量才串得起来。
$CC_STEP = 1
$CC_MAX_STEPS = 30        # 防呆：服务器真出问题时不至于无限循环
$CC_STEP_DONE = $false
Write-CcLog '正在校验卡密并获取安装步骤 ...'
while ($CC_STEP -le $CC_MAX_STEPS) {
  $uri = $CC_HOST + '/api/cc/step?key=' + [Uri]::EscapeDataString($CC_KEY) +
         '&did=' + $CC_DID +
         '&label=' + [Uri]::EscapeDataString($CC_LABEL) +
         '&i=' + $CC_STEP + '&os=win'
  $CC_STEP_DONE = $false
  Invoke-Expression (Get-CcText -Uri $uri -Step $CC_STEP)
  # 服务器把「没有下一步了」也写成一行赋值，客户端不用猜步数
  if ($CC_STEP_DONE) { break }
  $CC_STEP++
}

if (-not $CC_STEP_DONE) {
  Stop-Cc ('安装步骤异常（超过 ' + $CC_MAX_STEPS + ' 步），请联系管理员。')
}

}
