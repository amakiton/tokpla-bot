@echo off
REM ============================================================
REM  start-edge-tokpla.bat
REM  เปิด Microsoft Edge เข้าเกม พร้อม flag กันการหรี่การทำงาน
REM  ตอนแท็บไม่ได้แสดงผล / ถูกบัง / RDP หลุด
REM ============================================================

REM หา msedge.exe (ลองทั้ง 2 ตำแหน่งมาตรฐาน)
set "EDGE=%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe"
if not exist "%EDGE%" set "EDGE=%ProgramFiles%\Microsoft\Edge\Application\msedge.exe"

if not exist "%EDGE%" (
  echo  [X] หา msedge.exe ไม่เจอ — เปิด Edge เองแล้วเข้า https://fishbonecast.com/play
  pause
  exit /b 1
)

start "" "%EDGE%" ^
  --disable-background-timer-throttling ^
  --disable-backgrounding-occluded-windows ^
  --disable-renderer-backgrounding ^
  --disable-features=CalculateNativeWinOcclusion ^
  "https://fishbonecast.com/play"
