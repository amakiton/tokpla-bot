<#
  install-watchdog.ps1 — ติดตั้ง watchdog เป็น Scheduled Task (รันตอน logon อัตโนมัติ)
  ------------------------------------------------------------------------------------
  ทำ 2 อย่าง:
    1) ตั้ง Task "TokplaWatchdog" ให้รัน tokpla-watchdog.ps1 ทุกครั้งที่ผู้ใช้ logon
       (สิทธิ์สูงสุด · รีสตาร์ตเองถ้าพัง · ไม่รันซ้อน · ไม่มี timeout)
    2) ปิด Edge "Sleeping Tabs" ที่ระดับ policy = แก้ "ต้นเหตุ" ที่ทำแท็บหลับ
       (ข้ามได้ด้วย -SkipEdgePolicy)

  ต้องเปิด PowerShell แบบ "Run as administrator" แล้วรัน:
      powershell -ExecutionPolicy Bypass -File install-watchdog.ps1
  เพิ่ม -StartNow เพื่อเริ่ม watchdog ทันทีหลังตั้ง (ไม่ต้องรอ logon รอบใหม่)
#>
param(
  [switch]$SkipEdgePolicy,
  [switch]$StartNow
)

$ErrorActionPreference = 'Stop'
$TaskName    = 'TokplaWatchdog'
$ScriptPath  = Join-Path $PSScriptRoot 'tokpla-watchdog.ps1'

# ----- ตรวจสิทธิ์ Admin -----
$isAdmin = ([Security.Principal.WindowsPrincipal] [Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltinRole]::Administrator)
if (-not $isAdmin) {
  Write-Host 'ต้องรันด้วยสิทธิ์ Administrator — เปิด PowerShell แบบ "Run as administrator" แล้วลองใหม่' -ForegroundColor Red
  exit 1
}
if (-not (Test-Path $ScriptPath)) {
  Write-Host ("หา {0} ไม่เจอ — ต้องวาง tokpla-watchdog.ps1 ไว้โฟลเดอร์เดียวกับตัวติดตั้งนี้" -f $ScriptPath) -ForegroundColor Red
  exit 1
}

$user = "$env:USERDOMAIN\$env:USERNAME"
Write-Host ("จะตั้ง Task '{0}' ให้รันเป็นผู้ใช้ {1}" -f $TaskName, $user) -ForegroundColor Cyan

# ----- 1) ตั้ง Scheduled Task -----
$action = New-ScheduledTaskAction -Execute 'powershell.exe' `
  -Argument ("-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"{0}`"" -f $ScriptPath)

$trigger = New-ScheduledTaskTrigger -AtLogOn -User $user

$principal = New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Highest

$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
  -StartWhenAvailable -MultipleInstances IgnoreNew -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1)
$settings.ExecutionTimeLimit = 'PT0S'   # ไม่มี timeout (เป็น daemon รันยาว)
$settings.DisallowStartIfOnBatteries = $false

# ลบ Task เดิมถ้ามี (ให้ตั้งใหม่ทับได้)
if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
  Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
  Write-Host 'ลบ Task เดิมออกก่อนแล้ว' -ForegroundColor DarkGray
}

Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger `
  -Principal $principal -Settings $settings -Description 'เฝ้าบอทตกปลา Tokpla — แท็บตาย/ไม่มี heartbeat = รีสตาร์ต Edge' | Out-Null
Write-Host ("✅ ตั้ง Task '{0}' สำเร็จ (รันทุกครั้งที่ logon)" -f $TaskName) -ForegroundColor Green

# ----- 2) ปิด Edge Sleeping Tabs ที่ policy (แก้ต้นเหตุ) -----
if (-not $SkipEdgePolicy) {
  $key = 'HKLM:\SOFTWARE\Policies\Microsoft\Edge'
  if (-not (Test-Path $key)) { New-Item -Path $key -Force | Out-Null }
  New-ItemProperty -Path $key -Name 'SleepingTabsEnabled' -Value 0 -PropertyType DWord -Force | Out-Null
  Write-Host '✅ ตั้ง policy: ปิด Edge Sleeping Tabs (SleepingTabsEnabled=0) — มีผลหลัง Edge เปิดใหม่' -ForegroundColor Green
  Write-Host '   (ตรวจได้ที่ edge://policy หลังรีสตาร์ต Edge · ถ้าไม่อยากให้แตะ policy ใช้ -SkipEdgePolicy)' -ForegroundColor DarkGray
} else {
  Write-Host 'ข้ามการตั้ง Edge policy (-SkipEdgePolicy) — แนะนำปิด "Sleeping tabs" เองที่ edge://settings/system' -ForegroundColor Yellow
}

# ----- เริ่มทันทีถ้าขอ -----
if ($StartNow) {
  Start-ScheduledTask -TaskName $TaskName
  Write-Host '▶ เริ่ม watchdog แล้ว' -ForegroundColor Green
}

Write-Host ''
Write-Host 'เสร็จ · ตรวจสถานะ:' -ForegroundColor Cyan
Write-Host ("  Get-ScheduledTask -TaskName {0}" -f $TaskName)
Write-Host ("  Get-Content `"{0}\tokpla-watchdog\watchdog.log`" -Tail 20" -f $env:LOCALAPPDATA)
Write-Host 'ถอนการติดตั้ง:'
Write-Host ("  Unregister-ScheduledTask -TaskName {0} -Confirm:`$false" -f $TaskName)
