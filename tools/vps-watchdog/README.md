# 🐕 Tokpla Watchdog — ยามเฝ้าบอทบน VPS (แก้ "แท็บตายเงียบ")

แก้ปัญหาที่บอทดับข้ามคืน/ครึ่งวันเพราะ **แท็บเกมตายสนิท** (heartbeat ค้าง · ไม่มีโค้ดรัน = บอทกู้ตัวเองไม่ได้)

## มันทำงานยังไง

```
บอท (v6.420+) ──ping ทุก 30 วิ──▶ http://127.0.0.1:9111/hb ──▶ tokpla-watchdog.ps1
                                                                      │
   แท็บตาย = heartbeat หยุด = ping หาย ──(ไม่มี ping 4 นาที)──▶ รีสตาร์ต Edge → บอท resume เอง
```

- **ping มาจากลูป heartbeat ของบอทเอง** ที่รันเฉพาะตอนบอท "ยังมีชีวิตจริง" → เป็นสัญญาณที่เชื่อได้
- watchdog เป็น PowerShell ตัวเดียว ฟัง ping + เฝ้าเวลา · ไม่มี ping เกิน 4 นาที (และเว้นจากรีสตาร์ตก่อน ≥10 นาที) = ปิด-เปิด Edge ใหม่ไปที่ `/play`
- บอทตั้ง `enabled=1` + `resumeFlag=1` อยู่แล้ว → เปิดใหม่แล้ว **ฟาร์มต่อเอง**

> ทำไมไม่ใช้ DevTools remote-debugging (อ่าน heartbeat จาก localStorage ตรง ๆ):
> Edge/Chrome รุ่นใหม่ **บล็อก `--remote-debugging-port` บนโปรไฟล์ default** (ต้องใช้โปรไฟล์แยก = Tampermonkey/login หายหมด) → ใช้ไม่ได้กับเครื่องที่ตั้งบอทไว้แล้ว · วิธี ping-out นี้จึงเชื่อถือได้กว่าและไม่แตะโปรไฟล์

## ติดตั้ง (ทำบน VPS 185.145.158.204)

1. **อัปเดตบอทเป็น v6.420+** — Tampermonkey → กด "ตรวจหาอัปเดต" (userscript จะยิง ping เอง · เปิด/ปิดด้วย `/watchdog on|off`)
2. **ก๊อปโฟลเดอร์นี้ไปวางบน VPS** (เช่น `C:\tokpla-watchdog\`) — เอา 2 ไฟล์: `tokpla-watchdog.ps1` + `install-watchdog.ps1`
3. เปิด **PowerShell แบบ Run as administrator** แล้วรัน:

   ```powershell
   powershell -ExecutionPolicy Bypass -File C:\tokpla-watchdog\install-watchdog.ps1 -StartNow
   ```

   ตัวติดตั้งจะ:
   - ตั้ง Scheduled Task `TokplaWatchdog` (รันทุกครั้งที่ logon · รีสตาร์ตเองถ้าพัง)
   - ปิด Edge **Sleeping Tabs** ที่ policy = แก้ **ต้นเหตุ** ที่ทำแท็บหลับ (ข้ามด้วย `-SkipEdgePolicy`)
   - `-StartNow` = เริ่ม watchdog ทันที

4. **รีสตาร์ต Edge หนึ่งครั้ง** (ให้ policy ปิด Sleeping Tabs มีผล) — หรือปล่อยให้ watchdog รีสตาร์ตให้เองรอบแรก

## ตรวจว่าใช้งานได้

```powershell
# 1) log ควรขึ้น "ได้รับ heartbeat แรกจากบอทแล้ว" ภายใน ~30 วิ หลังบอทรัน
Get-Content "$env:LOCALAPPDATA\tokpla-watchdog\watchdog.log" -Tail 20

# 2) Task ติดตั้งแล้วและกำลังรัน
Get-ScheduledTask -TaskName TokplaWatchdog
```

**ทดสอบจริง** (ยืนยันว่ารีสตาร์ตได้): ปิดแท็บเกมทิ้งเฉย ๆ (อย่าปิด Edge ทั้งหมด) → รอ ~4-5 นาที → watchdog ควร log ว่าไม่มี heartbeat แล้วรีสตาร์ต Edge กลับเข้า `/play`

## ค่าที่ปรับได้ (แก้หัวไฟล์ `tokpla-watchdog.ps1`)

| ตัวแปร | ค่าเริ่มต้น | ความหมาย |
|---|---|---|
| `$Port` | 9111 | ต้องตรงกับ `WATCHDOG_PORT` ในบอท |
| `$StaleMinutes` | 4 | ไม่มี ping นานเท่านี้ = ถือว่าตาย |
| `$RestartCooldownMinutes` | 10 | กันรีสตาร์ตรัว ๆ |
| `$GameUrl` | .../play | หน้าที่เปิดหลังรีสตาร์ต |

## ข้อควรรู้

- **แก้ทั้งต้นเหตุ + อาการ:** policy ปิด Sleeping Tabs = ป้องกัน · watchdog = ตาข่ายกันตก (เผื่อแท็บตายด้วยเหตุอื่น เช่น renderer crash/discard)
- watchdog **จะไม่รีสตาร์ตจนกว่าจะเคยได้ ping อย่างน้อย 1 ครั้ง** — ปลอดภัยตอนทยอยอัปเดตบอท (บอทเวอร์ชันเก่าที่ยังไม่ยิง ping จะไม่โดนรีสตาร์ตมั่ว)
- ถ้า Edge ไม่รันเลย (เช่นเพิ่งรีบูต VPS) watchdog เปิด Edge ให้เอง
- ต้องมี **ผู้ใช้ logon ค้างไว้** (session เดสก์ท็อป) เพราะ Edge ต้องรันใน session นั้น — Task เป็นแบบ "at logon" ของผู้ใช้ ไม่ใช่ SYSTEM
- ปิดชั่วคราวฝั่งบอท: `/watchdog off` · ถอน Task: `Unregister-ScheduledTask -TaskName TokplaWatchdog -Confirm:$false`

## ถอนการติดตั้ง

```powershell
Unregister-ScheduledTask -TaskName TokplaWatchdog -Confirm:$false
# คืน Sleeping Tabs (ถ้าอยาก):
Remove-ItemProperty -Path 'HKLM:\SOFTWARE\Policies\Microsoft\Edge' -Name 'SleepingTabsEnabled' -ErrorAction SilentlyContinue
```
