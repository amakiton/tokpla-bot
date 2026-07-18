@echo off
REM ============================================================
REM  setup-stayalive.bat  —  รันครั้งเดียวเท่านั้น
REM  ****  คลิกขวาที่ไฟล์นี้ > Run as administrator  ****
REM
REM  จะติดตั้ง 2 อย่าง:
REM   1) คัดลอก stayalive.bat ไปไว้ที่ C:\
REM   2) สร้าง Scheduled Task ชื่อ "StayAlive" ที่รันด้วยสิทธิ์ SYSTEM
REM ============================================================

REM --- ตรวจว่ารันแบบ administrator หรือยัง ---
net session >nul 2>&1
if %errorlevel% neq 0 (
  echo.
  echo  [X] ต้องรันไฟล์นี้แบบ Run as administrator
  echo      คลิกขวาที่ setup-stayalive.bat แล้วเลือก "Run as administrator"
  echo.
  pause
  exit /b 1
)

REM --- 1) คัดลอก stayalive.bat ไป C:\ ---
copy /y "%~dp0stayalive.bat" "%SystemDrive%\stayalive.bat" >nul
if not exist "%SystemDrive%\stayalive.bat" (
  echo  [X] คัดลอก stayalive.bat ไม่สำเร็จ — ต้องมี stayalive.bat อยู่โฟลเดอร์เดียวกับไฟล์นี้
  pause
  exit /b 1
)

REM --- 2) สร้าง Scheduled Task รันด้วย SYSTEM ---
schtasks /create /tn StayAlive /tr "%SystemDrive%\stayalive.bat" /sc once /st 00:00 /ru SYSTEM /rl HIGHEST /f

echo.
echo  ============================================
echo   [OK] ติดตั้งเสร็จแล้ว!
echo.
echo   เวลาจะออกจาก VPS: ดับเบิลคลิก  leave-vps.bat
echo   RDP จะหลุดทันที แต่เกม/บอทจะยังเล่นต่อ
echo  ============================================
echo.
pause
