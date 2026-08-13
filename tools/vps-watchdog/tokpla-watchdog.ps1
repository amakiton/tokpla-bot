<#
  tokpla-watchdog.ps1  — ยามเฝ้าบอทตกปลาบน VPS (แก้อาการ "แท็บตายเงียบ")
  ------------------------------------------------------------------------
  หลักการ:  บอท (userscript v6.420+) ยิง ping ออก http://127.0.0.1:9111/hb ทุก ~30 วิ
            **เฉพาะตอนที่ยังรันอยู่จริง** (อยู่ในลูป heartbeat)
            แท็บตาย/แช่แข็ง = heartbeat หยุด = ping หาย → สคริปต์นี้รีสตาร์ต Edge ให้เอง
            (v6.413 ในตัวบอทกู้ได้แค่ตอนแท็บยัง "รันโค้ด" อยู่ · ตายสนิทต้องใช้คนนอก = ตัวนี้)

  รันยังไง:  ใช้ install-watchdog.ps1 ตั้ง Scheduled Task ให้รันตอน logon (สิทธิ์สูงสุด)
            หรือทดสอบมือ:  powershell -ExecutionPolicy Bypass -File tokpla-watchdog.ps1

  ต้องรันด้วยสิทธิ์ Administrator (HttpListener ผูกพอร์ตต้องใช้สิทธิ์สูง)
#>

# ===== ตั้งค่า (ต้องตรงกับ WATCHDOG_PORT ในบอท) =====
$Port                   = 9111
$StaleMinutes           = 4     # ไม่มี ping นานเท่านี้ = ถือว่าแท็บตาย
$RestartCooldownMinutes = 10    # กันรีสตาร์ตรัว ๆ — เว้นอย่างน้อยเท่านี้ระหว่างรีสตาร์ต
$GameUrl                = 'https://game.fishbonecast.com/play'
$LogDir                 = Join-Path $env:LOCALAPPDATA 'tokpla-watchdog'
$LogFile                = Join-Path $LogDir 'watchdog.log'
$HeavyCheckEverySec     = 20    # เช็ค Edge/ความสดของ ping ทุกกี่วินาที (ไม่ต้องทุกวิ)

# ===== เตรียมที่เก็บ log =====
if (-not (Test-Path $LogDir)) { New-Item -ItemType Directory -Path $LogDir -Force | Out-Null }

function Write-Log {
  param([string]$Msg, [string]$Level = 'INFO')
  $line = ('{0} [{1}] {2}' -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $Level, $Msg)
  try {
    # ตัด log ถ้าใหญ่เกิน 2 MB (กันไฟล์บวมข้ามเดือน)
    if ((Test-Path $LogFile) -and ((Get-Item $LogFile).Length -gt 2MB)) {
      $keep = Get-Content $LogFile -Tail 400
      Set-Content -Path $LogFile -Value $keep -Encoding UTF8
    }
    Add-Content -Path $LogFile -Value $line -Encoding UTF8
  } catch {}
  Write-Host $line
}

function Get-EdgePath {
  $cands = @(
    (Join-Path $env:ProgramFiles 'Microsoft\Edge\Application\msedge.exe'),
    (Join-Path ${env:ProgramFiles(x86)} 'Microsoft\Edge\Application\msedge.exe')
  )
  foreach ($c in $cands) { if ($c -and (Test-Path $c)) { return $c } }
  return $null
}

function Test-EdgeRunning {
  return [bool](Get-Process -Name msedge -ErrorAction SilentlyContinue)
}

# แฟลกลดการ throttle แท็บพื้นหลังของ Chromium (ช่วยอาการ "แช่แข็ง" · Sleeping Tabs จริง ๆ ปิดที่ policy — ดู installer)
$EdgeArgs = @(
  '--disable-features=IntensiveWakeUpThrottling,CalculateNativeWinOcclusion',
  '--disable-background-timer-throttling',
  '--disable-backgrounding-occluded-windows',
  '--disable-renderer-backgrounding',
  '--restore-last-session=false',
  $GameUrl
)

function Start-GameEdge {
  $edge = Get-EdgePath
  if (-not $edge) { Write-Log 'หา msedge.exe ไม่เจอ — ตรวจว่าติดตั้ง Edge ไว้ไหม' 'ERROR'; return $false }
  try {
    Start-Process -FilePath $edge -ArgumentList $EdgeArgs | Out-Null
    Write-Log ('เปิด Edge ไปที่ {0}' -f $GameUrl)
    return $true
  } catch {
    Write-Log ('เปิด Edge ล้มเหลว: {0}' -f $_.Exception.Message) 'ERROR'
    return $false
  }
}

function Restart-GameEdge {
  Write-Log 'ปิด Edge ทั้งหมดแล้วเปิดใหม่...' 'WARN'
  try { Get-Process -Name msedge -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue } catch {}
  Start-Sleep -Seconds 3
  Start-GameEdge | Out-Null
}

# ===== เปิด HttpListener =====
$listener = New-Object System.Net.HttpListener
$prefix = ('http://127.0.0.1:{0}/' -f $Port)
$listener.Prefixes.Add($prefix)
try {
  $listener.Start()
} catch {
  Write-Log ('เปิดพอร์ต {0} ไม่ได้ (อาจมี watchdog อีกตัวรันอยู่ หรือไม่ได้รันด้วยสิทธิ์ Admin): {1}' -f $Port, $_.Exception.Message) 'ERROR'
  exit 1
}
Write-Log ('watchdog เริ่มทำงาน · ฟัง {0} · stale={1}นาที · cooldown={2}นาที' -f $prefix, $StaleMinutes, $RestartCooldownMinutes)

# ===== สถานะ =====
$now         = Get-Date
$lastPing    = $now      # เริ่มด้วย grace (ยังไม่ฟ้องทันที)
$lastRestart = $now
$everSeenPing = $false
$lastHeavy   = $now
$pingCount   = 0

# ถ้า Edge ยังไม่รันตอนเริ่ม = เปิดให้เลย (เช่นเพิ่งรีบูต VPS)
if (-not (Test-EdgeRunning)) { Write-Log 'ตอนเริ่ม watchdog ยังไม่มี Edge รันอยู่ — เปิดให้'; Start-GameEdge | Out-Null }

$ctxTask = $listener.GetContextAsync()
while ($true) {
  if ($ctxTask.Wait(1000)) {
    # ---- มี ping เข้ามา ----
    try {
      $ctx = $ctxTask.Result
      $ctx.Response.StatusCode = 200
      $buf = [System.Text.Encoding]::ASCII.GetBytes('ok')
      $ctx.Response.OutputStream.Write($buf, 0, $buf.Length)
      $ctx.Response.Close()
    } catch {}
    $lastPing = Get-Date
    $pingCount++
    if (-not $everSeenPing) { $everSeenPing = $true; Write-Log 'ได้รับ heartbeat แรกจากบอทแล้ว — เริ่มเฝ้าจริง' }
    $ctxTask = $listener.GetContextAsync()
  }

  # ---- ตรวจหนักทุก ๆ HeavyCheckEverySec วินาที ----
  $now = Get-Date
  if (($now - $lastHeavy).TotalSeconds -ge $HeavyCheckEverySec) {
    $lastHeavy = $now

    if (-not (Test-EdgeRunning)) {
      # Edge หายทั้งโปรเซส (crash/ปิดเอง/รีบูต) → เปิดใหม่ ไม่ต้องรอ ping (ปลอดภัย)
      Write-Log 'ไม่พบโปรเซส Edge เลย — เปิดใหม่' 'WARN'
      Start-GameEdge | Out-Null
      $lastPing = Get-Date       # grace ให้แท็บใหม่เริ่ม ping
      $lastRestart = Get-Date
    }
    elseif ($everSeenPing) {
      $sincePing = ($now - $lastPing).TotalMinutes
      $sinceRestart = ($now - $lastRestart).TotalMinutes
      if ($sincePing -ge $StaleMinutes -and $sinceRestart -ge $RestartCooldownMinutes) {
        Write-Log ('ไม่ได้รับ heartbeat มา {0:N1} นาที (เกิน {1}) — แท็บน่าจะตาย → รีสตาร์ต Edge (ยิงมาแล้วรวม {2} ครั้ง)' -f $sincePing, $StaleMinutes, $pingCount) 'WARN'
        Restart-GameEdge
        $lastRestart = Get-Date
        $lastPing = Get-Date     # grace ให้แท็บใหม่เริ่ม ping
      }
    }
  }
}
