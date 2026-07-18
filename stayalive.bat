@echo off
REM ============================================================
REM  stayalive.bat
REM  ย้ายเซสชัน RDP ที่กำลังใช้งานไปที่ "console" เพื่อให้เดสก์ท็อป
REM  ยังวาดภาพต่อหลังตัดการเชื่อมต่อ — เกม/บอทจึงเล่นต่อได้
REM
REM  ไฟล์นี้ถูกเรียกโดย Scheduled Task ที่รันด้วยสิทธิ์ SYSTEM
REM  (อย่าดับเบิลคลิกเอง ให้ใช้ leave-vps.bat แทน)
REM ============================================================
setlocal
set "SID="

REM หา ID ของเซสชัน rdp-tcp (คอลัมน์ที่ 3 ของบรรทัดนั้น)
for /f "tokens=3" %%a in ('query session ^| findstr /c:"rdp-tcp#"') do set "SID=%%a"

if not defined SID (
  REM ไม่เจอเซสชัน RDP — อาจย้ายไป console เรียบร้อยแล้ว
  exit /b 0
)

tscon %SID% /dest:console
exit /b 0
