# 第 1 步 · 依赖（便携版 Node + 便携版 Git）
# ⚠ 这一段由服务器分步下发、被 runner 用 iex 在同一会话里执行，不是独立脚本 ——
#   不要加 param() 块，不要用 exit，不要在顶层写裸 break（会打断 runner 的循环）。
#   另外**整份文件不要出现 here-string**：它是跨网络下发的，行尾/空白只要有一处
#   变化，行首的 '@ 就不在行首了，字符串当场截断，而报错信息客户完全看不懂。
#   PowerShell 是自上而下执行的，函数必须写在调用之前。
#
# 为什么是便携版：客户机不弹 UAC。Node 和 Git 都解到 $CCX（引导段按客户选的盘算好的
# 安装根目录）下，卸载 = 删这一个目录，也不碰系统里的任何东西。
#
# 每个包都有几个镜像源，先测速再按快慢顺序下（Get-CcFastestUrl）—— 免得客户卡在
# 一个不通的源上等超时。
#
# Node 是硬需求（机器锁要 scrypt + AES-256-GCM，PowerShell 5.1 两样都没有），
# 装不上就中止；Git 是软需求（没有它 Claude Code 会退化成内置的 PowerShell 工具，
# 官方支持这条路），装不上只警告。

Write-CcStep '安装依赖'

$NODE_VER = '24.9.0'                    # 改这里要连带确认 win-x64 / win-arm64 两个包都在
# Git for Windows 有**两个**版本号，不是一回事，两个都要改：
#   $GIT_VER  release tag，镜像的目录名用它（v2.55.0.windows.5）
#   $GIT_PKG  包名里的产品版本号（2.55.0.5）—— 不能从 $GIT_VER 推导，两者不是简单去个 v
$GIT_VER  = 'v2.55.0.windows.5'
$GIT_PKG  = '2.55.0.5'

$CC_NODE_DIR = Join-Path $CCX 'node'
$CC_GIT_DIR  = Join-Path $CCX 'git'
$CC_NPM_DIR  = Join-Path $CCX 'npm-global'   # claude 的启动器装在这，也是要进 PATH 的那个目录
$CC_TMP      = Join-Path $CCX 'tmp'
New-Item -ItemType Directory -Force -Path $CC_TMP, $CC_NPM_DIR | Out-Null

# ========== 工具函数 ==========

# Win10 1803+ 自带。下面下载和测速都靠它（有就优先用，没有各自退回老办法）
$ccCurl = Join-Path $env:SystemRoot 'System32\curl.exe'
if (-not (Test-Path -LiteralPath $ccCurl)) { $ccCurl = '' }

# 从 URL 里取主机名，只为日志好看 —— 完整 URL 四五个源刷下来看不清
function Get-CcUrlHost {
  param([string]$Url)
  try { return ([Uri]$Url).Host } catch { return $Url }
}

# 同一份文件几个镜像上都有，哪个快完全看客户所在的网络。挨个试的代价是：排在前面的
# 源如果不通，得先等 connect-timeout 耗完才轮到下一个，客户看到的是「卡住不动」。
# 所以先各下 512KB 实测一把，按快慢排好序，再按这个顺序去下真文件。
#
# 用 curl 而不是 WebClient 是因为它给的 %{speed_download} 就是「实际字节数 / 实际耗时」，
# 比自己掐表准（不含进程启动开销）；-r 只要前 512KB，不白下几十兆。
# 一个都测不出来就原样返回 —— 测速失败和装不上是两回事，交给顺序重试兜底。
$CC_PROBE_BYTES = 524288        # 512KB：够跨过 TCP 慢启动，又不至于让测速本身很慢
function Get-CcFastestUrl {
  param([string[]]$Urls)
  if (-not $ccCurl -or @($Urls).Count -lt 2) { return $Urls }

  $ranked = @()
  $dead = @()
  foreach ($u in $Urls) {
    # 不看退出码：不支持 Range 的源会一直下到 --max-time 才被截断，退出码非零但速度
    # 数据照样有效；真连不上时 %{size_download} 是 0，下面会被筛掉
    $r = Get-CcOutput $ccCurl @('-o', 'NUL', '-s', '-L',
                                '-r', ('0-' + ($CC_PROBE_BYTES - 1)),
                                '-w', '%{speed_download} %{size_download}',
                                '--connect-timeout', '5', '--max-time', '15', $u)
    $parts = ([string]($r.Lines -join ' ')).Trim() -split '\s+'
    $speed = 0.0
    $bytes = 0.0
    if ($parts.Count -ge 2) {
      $speed = [double]$parts[0]
      $bytes = [double]$parts[1]
    }
    # 下到的字节太少 = 错误页 / 被运营商劫持的源，速度再高也不算数（它们会秒回一个小页面）
    if ($speed -le 0 -or $bytes -lt 65536) {
      Write-CcLog ('  ' + (Get-CcUrlHost $u) + ' 不可用')
      $dead += $u
      continue
    }
    Write-CcLog ('  ' + (Get-CcUrlHost $u) + ' ' + [math]::Round($speed / 1KB) + ' KB/s')
    $ranked += @{ Url = $u; Speed = $speed }
  }
  if ($ranked.Count -eq 0) { return $Urls }
  # hashtable 用 scriptblock 排序：直接写属性名在 5.1 上对哈希表不可靠
  $fast = @($ranked | Sort-Object -Property { $_.Speed } -Descending | ForEach-Object { $_.Url })
  return @($fast + $dead)
}

# 下载到文件。curl.exe（Win10 1803+ 自带）优先：能重试、能续传、失败有明确退出码；
# 没有就退回 WebClient。下完**必须 Unblock-File** —— 带着「来自 Internet」标记的
# 文件被执行时会被 SmartScreen 拦，而拦下来是弹窗等人点，客户看到的是「装到一半卡死」。
function Get-CcFile {
  param([string[]]$Urls, [string]$Dest)
  $part = $Dest + '.part'
  # 多个候选源时先测速，把最快的排到最前面
  if (@($Urls).Count -gt 1) {
    Write-CcLog '正在测速选择最快的下载源 ...'
    $Urls = Get-CcFastestUrl -Urls $Urls
  }
  foreach ($u in $Urls) {
    try {
      if (Test-Path -LiteralPath $part) { Remove-Item -LiteralPath $part -Force }
      Write-CcLog ('下载: ' + $u)
      if ($ccCurl) {
        # -sS：不刷进度条（几千行会把安装日志冲没），但错误照报
        $code = Invoke-Cc $ccCurl @('-fL', '-sS', '--retry', '3', '--retry-delay', '2',
                                  '--connect-timeout', '15', '--max-time', '1800',
                                  '-o', $part, $u)
        if ($code -ne 0) { throw ('curl 退出码 ' + $code) }
      } else {
        $wc = New-Object Net.WebClient
        $wc.DownloadFile($u, $part)
      }
      if ((Get-Item -LiteralPath $part).Length -lt 1024) { throw '下到的文件过小，疑似错误页' }
      Move-Item -LiteralPath $part -Destination $Dest -Force
      Unblock-File -LiteralPath $Dest -ErrorAction SilentlyContinue
      return $true
    } catch {
      Write-CcWarn ('  这个源不行: ' + $_.Exception.Message)
    }
  }
  return $false
}

# 不用 Expand-Archive：5.1 上它是纯 PowerShell 逐条走管道，node 那个 zip 有上万个条目，
# 要几分钟。ZipFile 走的是同一个 deflate 实现，几秒。
# .NET Framework 的 ExtractToDirectory 没有「覆盖」参数，目标有同名文件就直接抛，
# 所以先把目标删干净再解。
function Expand-CcZip {
  param([string]$Zip, [string]$Dest)
  Add-Type -AssemblyName System.IO.Compression.FileSystem -ErrorAction SilentlyContinue
  if (Test-Path -LiteralPath $Dest) { Remove-Item -LiteralPath $Dest -Recurse -Force }
  New-Item -ItemType Directory -Force -Path $Dest | Out-Null
  try {
    [IO.Compression.ZipFile]::ExtractToDirectory($Zip, $Dest)
  } catch {
    throw ('解压失败: ' + $_.Exception.Message)
  }
}

# 在一组候选相对路径里找第一个存在的 —— 不假设压缩包里的顶层结构套了几层。
# 候选表一律把「不套层」和「套一层 PortableGit\」两种都列上。
function Find-CcPath {
  param([string]$Root, [string[]]$Candidates)
  foreach ($c in $Candidates) {
    $p = Join-Path $Root $c
    if (Test-Path -LiteralPath $p) { return $p }
  }
  return ''
}

$CC_GIT_EXE_CANDIDATES  = @('cmd\git.exe', 'PortableGit\cmd\git.exe',
                            'bin\git.exe', 'PortableGit\bin\git.exe',
                            'mingw64\bin\git.exe', 'PortableGit\mingw64\bin\git.exe')
$CC_GIT_BASH_CANDIDATES = @('bin\bash.exe', 'PortableGit\bin\bash.exe',
                            'usr\bin\bash.exe', 'PortableGit\usr\bin\bash.exe')

# PATH 合并是纯函数（注册表那半在 Windows 上才跑得了），条目放最前、去重、
# 空段丢掉 —— 重跑安装不会把 PATH 越加越长
function Merge-CcPath {
  param([string]$Old, [string]$Entry)
  $entry = $Entry.TrimEnd('\')
  $key = $entry.ToLowerInvariant()
  $kept = @()
  foreach ($p in ($Old -split ';')) {
    if ($p.Trim() -eq '') { continue }
    if ($p.Trim().TrimEnd('\').ToLowerInvariant() -eq $key) { continue }
    $kept += $p.Trim()
  }
  return (@($entry) + $kept) -join ';'
}

# 往用户级 PATH 里加一条。**不能用 [Environment]::SetEnvironmentVariable** ——
# 它会把值写成 REG_SZ，而用户 PATH 原本是 REG_EXPAND_SZ，客户路径里那些
# %JAVA_HOME%\bin 从此永远不再展开。直接操作注册表并保留原来的类型才对。
function Add-CcUserPath {
  param([string]$Entry)
  $key = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Environment', $true)
  if (-not $key) { Write-CcWarn '读不到用户环境变量注册表项，PATH 没写。'; return $false }

  $old = ''
  try {
    # DoNotExpandEnvironmentNames：拿到的是原始串（还带着 %VAR%），写回去才不会把
    # 客户的变量固化成一条死路径
    $old = [string]$key.GetValue('Path', '', [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
  } catch { }
  $kind = [Microsoft.Win32.RegistryValueKind]::ExpandString
  try { $kind = $key.GetValueKind('Path') } catch { }

  $new = Merge-CcPath $old $Entry
  if ($new.Length -gt 2047) {
    Write-CcWarn ('用户 PATH 太长（' + $new.Length + ' 字符），跳过写入。请手动把下面这条加进 PATH:')
    Write-CcWarn ('  ' + $Entry)
    $key.Close()
    return $false
  }
  try {
    # 改之前留个底：客户要是觉得 PATH 不对，能照着还原
    [IO.File]::AppendAllText((Join-Path $CCX 'path.backup.txt'),
      (Get-Date).ToString('s') + "`r`n" + $old + "`r`n`r`n", (New-Object Text.UTF8Encoding $false))
  } catch { }
  $key.SetValue('Path', $new, $kind)
  $key.Close()
  return $true
}

# 告诉 Explorer 环境变量变了。不广播的话，客户从开始菜单新开的终端拿到的还是
# 旧 PATH，「敲 claude 说找不到命令」得等到注销重登才好。
# MemberDefinition 故意写成一行：避免 here-string（见文件开头的说明）。
function Send-CcEnvChange {
  try {
    if (-not ('CcWin.Native' -as [type])) {
      Add-Type -Namespace CcWin -Name Native -ErrorAction Stop -MemberDefinition '[DllImport("user32.dll", SetLastError=true, CharSet=CharSet.Auto)] public static extern IntPtr SendMessageTimeout(IntPtr hWnd, uint Msg, IntPtr wParam, string lParam, uint fuFlags, uint uTimeout, out IntPtr lpdwResult);'
    }
    $ccRes = [IntPtr]::Zero
    [CcWin.Native]::SendMessageTimeout([IntPtr]0xffff, 0x1A, [IntPtr]::Zero, 'Environment', 2, 5000, [ref]$ccRes) | Out-Null
  } catch { }
}

# ========== 磁盘空间 ==========
# Node 36MB + Git 59MB（解开约 350MB）+ npm 缓存 + claude 二进制约 230MB。
# 查的是 $CCX 所在的盘 —— 客户在引导段选的那块，不是系统盘
try {
  $ccFreeGB = [math]::Round((Get-Item -LiteralPath $CCX).PSDrive.Free / 1GB, 1)
  if ($ccFreeGB -lt 1.5) {
    Write-CcWarn ('磁盘可用空间只剩 ' + $ccFreeGB + ' GB，安装大约需要 1.5 GB，可能会失败。')
  }
} catch { }

# ========== Node ==========
$ccNodeExe = Join-Path $CC_NODE_DIR 'node.exe'
if (Test-Path -LiteralPath $ccNodeExe) {
  Write-CcLog 'Node 已经装过，跳过下载'
} else {
  $ccZipName = 'node-v' + $NODE_VER + '-win-' + $CC_ARCH + '.zip'
  $ccZip = Join-Path $CC_TMP $ccZipName
  # 顺序不重要（多个源会先测速挑最快的），只是并列时的兜底次序：
  # 国内镜像在前，官方源最后 —— 官方源国内基本连不上，当保险留着的
  # ⚠ 每个元素**必须自带括号**：PS 里逗号优先级高于 +，不括号的话整个 @() 会被
  #   拼成一整条带空格的字符串（数组退化成 1 个元素），curl 收到就报 Malformed URL
  if (-not (Get-CcFile -Urls @(
        ('https://registry.npmmirror.com/-/binary/node/v' + $NODE_VER + '/' + $ccZipName),
        ('https://cdn.npmmirror.com/binaries/node/v' + $NODE_VER + '/' + $ccZipName),
        ('https://mirrors.huaweicloud.com/nodejs/v' + $NODE_VER + '/' + $ccZipName),
        ('https://nodejs.org/dist/v' + $NODE_VER + '/' + $ccZipName)
      ) -Dest $ccZip)) {
    Stop-Cc 'Node 下载失败（几个源都不通），请检查网络后重新执行安装命令。'
  }

  Write-CcLog '解压 Node ...'
  $ccStage = Join-Path $CC_TMP 'node-stage'
  Expand-CcZip -Zip $ccZip -Dest $ccStage
  # 官方 zip 里套了一层 node-v24.9.0-win-x64\，但不写死 —— 找到 node.exe 在哪一层，
  # 就把那一层整个挪成 .ccx\node
  $ccFound = Get-ChildItem -LiteralPath $ccStage -Filter 'node.exe' -Recurse -File -ErrorAction SilentlyContinue |
             Select-Object -First 1
  if (-not $ccFound) { Stop-Cc 'Node 解压后没找到 node.exe，安装包结构可能变了，请联系管理员。' }
  if (Test-Path -LiteralPath $CC_NODE_DIR) { Remove-Item -LiteralPath $CC_NODE_DIR -Recurse -Force }
  Move-Item -LiteralPath $ccFound.Directory.FullName -Destination $CC_NODE_DIR
  Remove-Item -LiteralPath $ccStage -Recurse -Force -ErrorAction SilentlyContinue
  Remove-Item -LiteralPath $ccZip -Force -ErrorAction SilentlyContinue
}

$ccNodeExe = Join-Path $CC_NODE_DIR 'node.exe'
if (-not (Test-Path -LiteralPath $ccNodeExe)) { Stop-Cc 'Node 安装失败，安装中止。' }
# npm 跑包的 postinstall 时会在 PATH 里找 node，当前会话也要带上。
# **不动用户级 PATH** —— 把便携 node 插到最前面会把客户自己装的 node 顶掉，
# 白白给人家添乱
$env:Path = $CC_NODE_DIR + ';' + $env:Path
$ccNode = Get-CcOutput $ccNodeExe @('--version')
if ($ccNode.Code -ne 0) { Stop-Cc 'Node 装上了但跑不起来，安装中止。' }
Write-CcLog ('Node ' + ([string]($ccNode.Lines -join ' ')).Trim() + ' 就绪')

# ========== Git（装不上不中断） ==========
$CC_GIT_OK = $false
$CC_GIT_BASH = ''
if ($CC_ARCH -eq 'arm64') { $ccGitArch = 'arm64' } else { $ccGitArch = '64-bit' }

$ccGitExe = Find-CcPath -Root $CC_GIT_DIR -Candidates $CC_GIT_EXE_CANDIDATES
if ($ccGitExe) {
  Write-CcLog 'Git 已经装过，跳过下载'
} else {
  # 首选 PortableGit 自解压包（有完整环境，含 Git Bash）
  $ccGitName = 'PortableGit-' + $GIT_PKG + '-' + $ccGitArch + '.7z.exe'
  $ccGitFile = Join-Path $CC_TMP $ccGitName
  # ⚠ 同 Node：元素要自带括号（PS 里逗号优先级高于 +）
  if (Get-CcFile -Urls @(
        ('https://registry.npmmirror.com/-/binary/git-for-windows/' + $GIT_VER + '/' + $ccGitName),
        ('https://cdn.npmmirror.com/binaries/git-for-windows/' + $GIT_VER + '/' + $ccGitName),
        ('https://mirrors.huaweicloud.com/git-for-windows/' + $GIT_VER + '/' + $ccGitName)
      ) -Dest $ccGitFile) {
    Write-CcLog '解压 Git ...'
    $ccGitStage = Join-Path $CC_TMP 'git-stage'
    New-Item -ItemType Directory -Force -Path $ccGitStage | Out-Null
    try {
      # 7-Zip 自解压包认 7z 的开关：-o 紧跟路径（中间不能有空格），-y 全部确认。
      # 路径末尾绝不能带反斜杠 —— PS 拼出来的 "…\" 会把收尾引号转义掉。
      $ccGitOut = '-o' + $ccGitStage
      $ccGitCode = Invoke-Cc $ccGitFile @($ccGitOut, '-y')
      if ($ccGitCode -ne 0) { throw ('自解压程序退出码 ' + $ccGitCode) }
    } catch {
      Write-CcWarn ('便携版 Git 解压失败（多半是被安全软件拦了）: ' + $_.Exception.Message)
    }
    # 整个 stage 挪过去再探测，不去推算「git.exe 上面还有几层目录」
    if (Find-CcPath -Root $ccGitStage -Candidates $CC_GIT_EXE_CANDIDATES) {
      if (Test-Path -LiteralPath $CC_GIT_DIR) { Remove-Item -LiteralPath $CC_GIT_DIR -Recurse -Force }
      Move-Item -LiteralPath $ccGitStage -Destination $CC_GIT_DIR
    }
    Remove-Item -LiteralPath $ccGitStage -Recurse -Force -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath $ccGitFile -Force -ErrorAction SilentlyContinue
  }
  $ccGitExe = Find-CcPath -Root $CC_GIT_DIR -Candidates $CC_GIT_EXE_CANDIDATES
}

if ($ccGitExe) {
  # 只会用到 bin\bash.exe：它是 Git for Windows 的包装器，自己会把 usr\bin、mingw64\bin
  # 拼进 PATH 再 exec。指到 usr\bin\bash.exe 的话裸 bash 缺这层准备，
  # Claude Code 用 Bash 工具时会找不到 git
  $CC_GIT_BASH = Find-CcPath -Root $CC_GIT_DIR -Candidates $CC_GIT_BASH_CANDIDATES
  if ($CC_GIT_BASH) { $CC_GIT_OK = $true }
  Add-CcUserPath -Entry (Join-Path $CC_GIT_DIR 'cmd') | Out-Null
  Write-CcLog ('Git 就绪: ' + $ccGitExe)
  if (-not $CC_GIT_BASH) { Write-CcWarn '这套 Git 里没有 bash.exe，Bash 工具会用不了（git 本身能用）。' }
} else {
  Write-CcWarn 'Git 没装上。不影响 Claude Code 使用，但 Bash 工具会退化成 PowerShell 工具。'
  # 不用重跑本脚本：Claude Code 自己会去 C:\Program Files\Git 和 PATH 里找 Git Bash，
  # 客户装官方版就够了。但它只在进程启动时探测一次，所以「重开终端」这半句不能省 ——
  # 少了它，客户装完发现还是没生效，会以为装错了。
  Write-CcWarn '想要 Bash 工具的话：装一次官方 Git for Windows（一路默认即可），装完重开终端就会自动认到。'
}

# claude 的启动器目录进 PATH（04 步会把 claude.cmd 装到这里）
Add-CcUserPath -Entry $CC_NPM_DIR | Out-Null
Send-CcEnvChange

if ($CC_GIT_OK) {
  Write-CcLog '依赖就绪（Node + Git）'
} else {
  Write-CcLog '依赖就绪（Node；无 Git）'
}
