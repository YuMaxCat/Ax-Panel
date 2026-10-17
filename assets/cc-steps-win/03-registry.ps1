# 第 3 步 · 挑一个快的 npm 源
# ⚠ 这一段由服务器分步下发、被 runner 用 iex 在同一会话里执行，不是独立脚本 ——
#   不要加 param() 块，不要用 exit，不要在顶层写裸 break，不要出现 here-string。
#
# 国内直连 registry.npmjs.org 经常几十 KB/s，后面要下上百 MB，先花几秒测一把很划算。
# 每个源跑 3 次取平均，只认「真的下到了东西」（≥1000 字节）的结果 ——
# 被运营商劫持的源会秒回一个错误页，光看耗时它会赢得很离谱。

Write-CcStep '选择下载源'

$SPEED_PROBE_PKG = '@anthropic-ai/claude-code'     # 拿真正要装的包探路，别用个小包测
$NPM_REGISTRIES = @(
  @{ Name = '官方 npmjs';    Url = 'https://registry.npmjs.org' },
  @{ Name = '阿里 npmmirror'; Url = 'https://registry.npmmirror.com' },
  @{ Name = '腾讯云';        Url = 'https://mirrors.cloud.tencent.com/npm' },
  @{ Name = '华为云';        Url = 'https://repo.huaweicloud.com/repository/npm' }
)

$ccCurl = Join-Path $env:SystemRoot 'System32\curl.exe'
if (-not (Test-Path -LiteralPath $ccCurl)) { $ccCurl = '' }

# 返回平均秒数；一个都测不通返回 -1。
# 优先用 curl.exe：只把响应丢掉、不读进内存（这个包的元数据有 0.6~1.5 MB，
# 拿 Invoke-WebRequest 读进 PS 对象纯属浪费）
function Measure-CcRegistry {
  param([string]$Url)
  $probe = $Url.TrimEnd('/') + '/' + $SPEED_PROBE_PKG
  $total = 0.0
  $ok = 0
  for ($k = 0; $k -lt 3; $k++) {
    try {
      if ($ccCurl) {
        # Accept 头跟 npm 自己保持一致：npm 装包时取的是精简版元数据（约 1/3 大小），
        # 不带的话量到的是「下载完整元数据」的耗时，又慢又白传好几 MB
        $r = Get-CcOutput $ccCurl @('-o', 'NUL', '-s', '-w', '%{time_total} %{size_download}',
                                    '-H', 'Accept: application/vnd.npm.install-v1+json',
                                    '--connect-timeout', '5', '--max-time', '15', $probe)
        if ($r.Code -ne 0) { continue }
        $parts = ([string]($r.Lines -join ' ')).Trim() -split '\s+'
        if ($parts.Count -lt 2) { continue }
        $sec = [double]$parts[0]
        $size = [double]$parts[1]
      } else {
        $sw = [Diagnostics.Stopwatch]::StartNew()
        $resp = Invoke-WebRequest -Uri $probe -UseBasicParsing -TimeoutSec 15 -ErrorAction Stop `
                  -Headers @{ Accept = 'application/vnd.npm.install-v1+json' }
        $sw.Stop()
        $sec = $sw.Elapsed.TotalSeconds
        $size = [double]([string]$resp.Content).Length
      }
      if ($size -lt 1000) { continue }
      $total += $sec
      $ok++
    } catch { }
  }
  if ($ok -eq 0) { return -1 }
  return $total / $ok
}

Write-CcLog '正在测 npm 源速度 ...'
$bestSec = [double]::MaxValue
$bestName = ''
$bestUrl = ''
foreach ($reg in $NPM_REGISTRIES) {
  # 每个源要跑 3 次、每次最长 15 秒，一行都不打的话客户会以为卡死了（Termux 那边同理）
  Write-CcLog ('测速: ' + $reg.Name + ' → ' + $reg.Url)
  $sec = Measure-CcRegistry -Url $reg.Url
  if ($sec -lt 0) {
    Write-CcLog ('  ' + $reg.Name + ' 不可达')
    continue
  }
  Write-CcLog ('  ' + $reg.Name + ' ' + [math]::Round($sec, 2) + ' 秒')
  if ($sec -lt $bestSec) {
    $bestSec = $sec
    $bestName = $reg.Name
    $bestUrl = $reg.Url
  }
}

if ($bestUrl) {
  $NPM_REGISTRY = $bestUrl
  $SPEED_RESULT = $bestName
} else {
  # 全都不通还继续，是因为「测速失败」和「装不上」是两回事：
  # 客户可能只是被公司代理挡了这些探测请求，npm 本身走代理是通的
  $NPM_REGISTRY = 'https://registry.npmjs.org'
  $SPEED_RESULT = '官方 npmjs（兜底）'
  Write-CcWarn '所有源都没测通，仍按官方源继续（如果卡住请联系管理员）。'
}

Write-CcLog ('npm 源: ' + $SPEED_RESULT)
