# Tokpla Auto-Fisher — กฎการทำงานกับโค้ดนี้

บอทตกปลาอัตโนมัติสำหรับ tokpla.vercel.app / fishbonecast.com (Tampermonkey userscript)
ไฟล์เดียว: `tokpla-autofish.user.js` (~3,550 บรรทัด, IIFE, vanilla JS, ไม่มี build step)
ใช้กับ **1 บัญชีเกม** · เป้าหมาย = **ฟาร์มเงินสูงสุด**

## 📚 เอกสาร — อ่านก่อนแก้

| ไฟล์ | เมื่อไรต้องอ่าน |
|---|---|
| `docs/ARCHITECTURE.md` | ก่อนแก้โครงสร้าง/ลูป/โครงข้อมูล — ชั้นความรับผิดชอบ, FSM, ธงกันชน, โครง profit/recs |
| `docs/GAME.md` | ก่อนแตะ DOM/สูตร — selector ทุกตัว, สูตรคะแนน/ราคา, ราคาไอเทม, HUD chips |
| `docs/CHANGELOG.md` | ก่อนแก้บั๊ก — เช็คว่าเคยเจอ/เคยแก้แล้วหรือยัง (กันแก้ซ้ำ/ถอยหลัง) |

## ⛔ กฎเหล็ก (ห้ามละเมิด)

1. **ห้ามตัด reel gauge** — เกจดึงปลาคือ `state === 'minigame'` / `findBar()` / `reelMin/Max` เป็น core การตกปลา (อย่าสับสนกับ "มินิเกมแข่ง" ที่ถูกตัดไปแล้วใน v6.38)
2. **ห้ามล็อกอินอัตโนมัติ / กรอกรหัสผ่าน** — session หมด = หยุด + แจ้ง Telegram เท่านั้น
3. **การส่งออก "เพื่อแชร์/วิเคราะห์" ต้องตัด** `tgToken, tgControlToken, tgChat, tgControlChat` เสมอ — `cfgExport` (📋 ส่งให้วิเคราะห์) + `diagReport` (📋 รายงานปัญหา) · **ยกเว้น `backup` (📤 สำรอง/ย้าย VPS)** ที่ v6.126 ผู้ใช้สั่งให้เก็บ token + key เรียนรู้ (`extra`) ครบเพื่อย้ายเครื่องจบครั้งเดียว — ต้องมีคำเตือน "ห้ามส่งไฟล์นี้ให้ใคร" กำกับเสมอ (อย่าแก้กลับให้ backup ตัด token)
4. **ระหว่าง `testRunning` ห้ามให้ระบบอื่นแตะ `cfg.baitTier`** — ระบบทดสอบคุมเหยื่อเองทั้งหมด (บั๊กนี้เคยเกิดหลายรอบ ดู CHANGELOG v6.61–6.62)
5. **buff chips ใช้ class `tk-chip`** (ไม่ใช่ `tk-chip-dark`) — เคย regression ครั้งใหญ่ v6.49→6.58
6. **v6.63 ลบ batch + ระบบเลือกเหยื่ออัตโนมัติแล้ว** — อย่าเพิ่มกลับ ต้นทุนคิด "ต่อชิ้น" เท่านั้น (`life.baitCost += baitUnit(tier)` ต่อการตก 1 ครั้ง)
7. **บอทห้าม query ชน UI ตัวเอง** — ทุก element ที่บอทสร้างต้องติด `data-tkbot` และทุกฟังก์ชันที่หา "DOM ของเกม" ต้องข้ามมัน (`isBotUI()` ใน `qBtn`/`btnByText`) · บั๊ก v6.105: หัวข้อแผงบอท `'🪱 เหยื่อ & อุปกรณ์'` (เป็น `<button>`) ถูก `btnByText('🪱 เหยื่อ')` จับ → `openShop` คืน true ทั้งที่ร้านไม่เปิด + กดปุ่มตัวเอง → **วนลูปซื้อเหยื่อไม่จบ** · อย่าใช้ "ข้อความ" ยืนยันว่าแผงเกมเปิด — ใช้ `aria-label` เฉพาะของเกม (เช่น `ปิดร้าน`)

## ✅ ขั้นตอนมาตรฐานหลังแก้โค้ด

1. bump `// @version` ในหัวไฟล์ (+ `BOT_VER` ให้ตรง)
2. `node --check tokpla-autofish.user.js`
3. grep หา dangling refs ของสิ่งที่ลบ/เปลี่ยนชื่อ
4. ถ้าแก้ตรรกะเงิน/สถิติ → เขียนเทสต์ Node จำลองใน scratchpad รันยืนยัน
5. อัปเดต `docs/CHANGELOG.md` (เวอร์ชัน + สิ่งที่แก้ + เหตุผล) และ `docs/ARCHITECTURE.md`/`GAME.md` ถ้าโครง/selector เปลี่ยน
6. **deploy (v6.129+):** `git -C <โฟลเดอร์> add -A && commit && push` → repo **public** `github.com/amakiton/tokpla-bot` (raw URL คือ `@updateURL`) · บอทรันบน **VPS คนละเครื่องกับไฟล์** — Tampermonkey บน VPS ตั้ง `@updateURL` = raw URL นี้ → ผู้ใช้กด "ตรวจหาอัปเดต" หรือรอ auto = ได้เวอร์ชันใหม่ (bump `@version` เท่านั้นถึงจะเด้ง) · **ห้าม commit ไฟล์ที่มีความลับ** (token อยู่ localStorage ไม่ใช่ในโค้ด — repo จึง public ได้)

## แนวโค้ด

- คอมเมนต์ภาษาไทย อธิบาย "ทำไม" ไม่ใช่ "ทำอะไร" · ตามสไตล์เดิมของไฟล์
- งาน async ทุกชิ้นต้องล้อมด้วยธง `busy` / `orchestrating` และเรียกจาก tick แบบ `void fn()`
- งานใหม่ในสาขา idle ของ `tick()` ต้องอยู่หลัง throttle `lastIdleWork` (150ms) และมี cooldown ของตัวเอง
- ตัวเลือกเปิด/ปิดใหม่ → เพิ่มใน `DEFAULTS` + UI panel + (ถ้าเหมาะ) คำสั่ง Telegram
