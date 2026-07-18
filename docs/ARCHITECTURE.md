# สถาปัตยกรรม tokpla-autofish.user.js (v6.63)

> อัปเดตไฟล์นี้ทุกครั้งที่โครงสร้าง/โครงข้อมูล/ธง เปลี่ยน

## ภาพรวม

- IIFE เดียว `(function(){ 'use strict'; ... })()` — ไม่มี module ไม่มี build
- ทำงานผ่าน DOM ล้วน: อ่านสถานะจาก React HUD → ยิง event กลับผ่าน `unsafeWindow` (`W`)
- แผนที่เกมเป็น Phaser canvas → **บอทเดินไม่ได้** ต้องยืนใกล้บ่ออยู่แล้ว
- ลูปหลัก `tick()` วนด้วย `requestAnimationFrame` (~60fps) · สาขา idle ถูก throttle เหลือ ~7 รอบ/วิ (`lastIdleWork` 150ms)

## ชั้นความรับผิดชอบ (เรียงตามตำแหน่งในไฟล์)

| ชั้น | สัญลักษณ์หลัก |
|---|---|
| Bootstrap | `keepTabAlive` (override document.hidden), `loadCfg`, `loadProfit`, `mountUI`, `autoResumeAfterReload` |
| ค่าคงที่เกม | `CAST_SPAN/DROP`, `REEL_SPAN/DROP`, `RARITY`, `BAIT_TIERS`, `ROD_NAMES`, `PACK_SIZE=100`, `BAIT_CAP=1000` |
| Config | `DEFAULTS`, `loadCfg` (มี migration ค่าเก่า), `saveCfg`, `isOn()`, `hOn()`, `sessionOff` |
| Economy | `profit`, `pushCatch`, `recStat/recFilter`, `baitStats`, `mapStats`, `lifeNet`, `recentCph` |
| Telegram | `tgApi` (ผ่าน GM_xmlhttpRequest), `tgSend`, `tgPoll`, `handleTgCommand`, `tgSetConfig` |
| แชทโลก | `ensureChatObserver`, `chatEnqueue/drainChatQueue`, `chatSendNow` |
| DOM adapter | `qBtn`, `btnByText`, `fireClick`, `pressSpace`, `readCatch`, `readBag*`, `energyPct`, `currentBait/Rod`, `cycleTo`, `readBuffs`, `coinsNow` |
| ร้านค้า/ซื้อ | `openShop/closeShop/shopTab/shopRows`, `runBuyBait`, `sellThenBuy`, `buyCoffee/sustainEnergy`, `buyPotions`, `buyFloat` |
| จดหมาย/เควส | `claimMail`, `runQuests` |
| ทดสอบเหยื่อ | `runBaitTest`, `ensureTestBait/equipTestBait`, `ensureTestBuff/buyTestPotion`, `detectBaitCeil`, `recBuffStat`, `sendTestReport`, `load/save/clearTestProgress` |
| ขาย | `runSell`, `pickSpecies` (กฎล็อก), `sellAllCurrentTab`, `readSellToast` |
| FSM ตกปลา | `tick`, `gameState`, `findBar`, `planAim`, `scoreToOffset`, `sampleReact/sampleCastGap`, `resetRound` |
| Human layer | `resetHumanTimers`, `beginBreak/clearPersistedBreak`, ตัวแปร `breakUntil/nextMicroAt/nextMacroAt/sessionEndAt` |
| Resilience | `recoveryWatch`, `doReload`, `persistEnabled`, `stopBot` |
| Log & diag | `logInfo/logWarn/logErr` + `logRing` (300, persist `tokpla_bot_log`) · `diagReport()` (รายงานปัญหา) · `refreshLogView` · global error/rejection handlers |
| 🧠 Advisor | `advisorDecide` (สมอง) · `advTrimStat` (กำไร/ครั้งตัดฟลุ๊ค) · `advCastsPer30` · `advMeasuredWeightUplift` (rec.w) · `advisorTick` (ทุก 5 นาทีใน tick) · `advisorPotionVerdict` (คุม gate ยาโหมด auto) · cfg: `advisor`/`advisorAuto` · ADV={MINN:30,UPN:100,MARGIN_DOWN:5,MARGIN_UP:15,COOLDOWN:30m,RECENT:50} |
| UI | `buildPanel`, `mountUI`, `updateBadge`, `syncPanel`, `row/labeled/numInput/checkbox/textInput` |
| UI (accordion) | `sectionHead` (หัวข้อคั่น) + `wireCollapse` (จับกลุ่ม sibling ระหว่างหัวข้อ พับ/กาง) · 9 หมวด |
| UI (สถิติ) | `refreshStatsPanel` (การ์ด session/lifetime + 3 ตาราง) · `statRows(buffMode)` · `statsTableEl` · `statTile` · `fmtDur` |

## เครื่องสถานะ (gameState → 6 สถานะ)

```
bite      ปุ่ม "ตวัดเบ็ด!"        → pressSpace (หน่วง biteReact ถ้า hReact)
minigame  findBar() เจอเกจ        → เล็ง planAim, กดเฟรมที่ |aim−pos| ≤ |aim−(pos+vel)|
result    ปุ่ม "ตกต่อ!"           → readCatch + pushCatch แล้วกดปิด
waiting   ปุ่ม "เก็บเบ็ด"          → ห้ามแตะ (ทุ่นลอยรอปลา)
reeling   "กำลังดึงขึ้น"           → ห้ามแตะ (ส่งผลไปเซิร์ฟเวอร์)
idle      นอกนั้น                 → งานเบื้องหลังทั้งหมด + เหวี่ยงตัวถัดไป
```

บทเรียนสำคัญ: ห้ามเดา "ไม่มีแถบ = ว่าง" — waiting/reeling/result ก็ไม่มีแถบ เคยทำบอทกดซ้ำจนเกมรวน

## ลำดับเติมพลังงาน (energy top-up) — v6.70

- **coffee block** (พลัง ≤ `coffeeAtEnergy` 35%) ทำงาน**ก่อน** energyManage rest (`energyRestAt` 20%) → เรียก `sustainEnergy()`
- `sustainEnergy()`: **เก็บเควสก่อนเสมอ** (`runQuests`) → ถ้าพลังยัง ≤ coffeeAtEnergy ค่อย `buyCoffee()` · throttle 30วิ (`lastQuestCheck`) = tick แรกเควส, tick ถัดไปกาแฟ
- **`runQuests` เก็บทีละอัน + guard พลัง ≤ 100** (v6.70): ข้ามเควสที่รับแล้วจะล้น เก็บไว้รอบหน้า (กันเสียพลังส่วนเกิน) · reward คงที่ 30/40/30⚡/วัน
- เควสถูกเรียก 3 ทาง: `sustainEnergy` (ตอนพลังต่ำ+buyCoffee) · ตอน `energyResting` (นั่งพัก) · ตามรอบ `questEvery` (พลัง < `questMaxEnergy`)

## ลำดับงานใน idle (ลำดับ = ความสำคัญ)

1. ปุ่มตกปลาถูกปิด? (ยืนไกลบ่อ / เกมเปิดออโต้เอง) → เตือน
2. ☕ กาแฟ (พลัง ≤ coffeeAtEnergy) — ก่อน energyManage เสมอ
3. 🧪 ต่อยา (ทุก 60 วิ) · 🛟 ทุ่น (ทุก 60 นาที) · ✉️ จดหมาย (ตาม mailEvery)
4. ⚡ energyManage (hysteresis RestAt→ResumeAt, นั่งพัก + เก็บเควสระหว่างพัก)
5. อ่านกล่องเตือนเกม: กระเป๋าเต็ม→ขาย/หยุด · ไม่มีเหยื่อ→handleNoBait · พลังหมด→พัก
6. โหมดมนุษย์: พักยาวจบเซสชัน / พักใหญ่ / พักย่อย (ข้ามทั้งหมดถ้า restBlocked=ใช้ยาอยู่)
7. จัดการเหยื่อ/เบ็ด: หมด→สลับ · ใกล้หมด→sellThenBuy · ผิดขั้น→ensureGear  **(ข้ามทั้งบล็อกเมื่อ testRunning)**
8. เควส (questEvery) · ขายตามรอบ (โหมด bot=sellEvery ครั้ง · โหมด gameauto/off=ทุก 90 วิ เพราะ casts ไม่ขยับ)
9. **แยกตาม `fishMode`** (v6.81): `off`→หยุด auto เกม+จบรอบ (ไม่ตก) · `gameauto`→เปิด "ตกปลาอัตโนมัติ" ของเกมให้ ON+ต่ออายุ lastProgressAt · `bot`→gate เวลา (castGate) → fireClick ปุ่มตกปลา (`pendingCast` จนกว่าเกมขยับ = นับ 1 cast)

## โหมดตกปลา `fishMode` (v6.84 · v6.89 เพิ่ม `fishModeEff()`)

> ⚠️ **ทุกจุดที่เป็น "พฤติกรรมการตก/บันทึกสถิติ" ต้องใช้ `fishModeEff()`** (= testRunning ? 'bot' : cfg.fishMode)
> เพราะทดสอบเหยื่อบังคับโหมด bot เสมอ — เคย deadlock ตอนผู้ใช้ตั้ง gameauto/off แล้วกดทดสอบ (v6.89) · UI/badge ใช้ cfg.fishMode ตรงๆ

- `bot` (ค่าเริ่มต้น — ตกเองได้โบนัสโชค/คะแนนสูงกว่า auto เกม): เอนจินมินิเกมใหม่ครบวงจร
  - **สถานะใหม่ใน gameState()** (เฉพาะโหมด bot): `bite` (orb "❗") → `gauge` (วงล้อ conic-gradient · `readGaugeWheel`→wheelCache) → `fight` ("กดรัว" · เช็คก่อน tug) → `tug` (กรอบ+ปลา · `readTugState`→tugCache) → `waiting` จาก **`sceneIsFishing()`** (Phaser ผ่าน fiber · สำคัญ: orb ไม่ disabled ตอนสายในน้ำ)
  - tick branch: gauge = กดเมื่อเข็ม∈โซนแดง (hReact หน่วง ×0.5) · fight = กดรัว throttle 65-110ms · tug = **PD hold** (`orbDown/orbUp` + `orbHeld` flag · predBox 0.22s / predFish 0.08s / EMA 0.6/0.4)
  - `resetFishEngine()` เรียกจาก stopBot/toggle + ทุกครั้งที่ state ออกจาก tug (กันปุ่มค้าง)
  - ต้นทุน: `pushCastCost()` ตอนเหวี่ยงติด (เหมือนเดิม) · รายได้: `recordGameCatch` (ไม่คิด cost ซ้ำในโหมด bot)
  - degrade: Phaser หาย (`sceneIsFishing()===null`) → เว้นเหวี่ยง ≥8วิ กันกดตัดสายที่ลอยอยู่
- `gameauto` (สำรอง): บอทคุมปุ่ม "ตกปลาอัตโนมัติ" ของเกม · top-of-tick หยุด auto เมื่อ busy/พัก/ทดสอบ แล้ว idle เปิดคืน · ใช้เมื่อเกมอัปเดตจนเอนจิน bot พัง
- `off`: maintenance ครบแต่ไม่เหวี่ยง
- **สถิติ**: ผลปลาไม่มี popup DOM แล้ว → ทุกโหมด (ยกเว้น off) เก็บผ่าน `pollGameCatches()` (poll ~100ms อ่าน React hook array) · migration v6.84: saved `gameauto` (ค่าที่ระบบบังคับช่วง bot พัง) → `bot` ครั้งเดียวด้วย flag `fishModeV684`

## ธงกันชน (ห้ามลืม)

| ธง | ความหมาย |
|---|---|
| `busy` | กำลังเปิดกระเป๋า/ร้าน/ขาย — tick ไม่ทำอะไร |
| `orchestrating` | ลำดับหลายขั้น (ขาย→ซื้อ) — กัน tick แทรกกลาง |
| `testRunning` | โหมดทดสอบคุมเหยื่อ/ยา/นับเอง — tick ข้ามการจัดการเหยื่อทั้งหมด และห้ามใครแตะ `cfg.baitTier` |
| `pendingCast` | กดตกปลาแล้วรอเกมขยับ — ยังไม่นับ cast |
| `paused` / `pauseUntil` / `breakUntil` | พักแบบต่าง ๆ |
| `energyResting` / `energySat` | นั่งพักรอพลัง (hysteresis) |

## โครงข้อมูล (localStorage)

### `tokpla_bot_profit` — ตั้งแต่ v6.64 (ต่อชิ้น · แยกเหวี่ยง/ติดปลา · มีเวอร์ชัน)

```js
// บนดิสก์: { v: 2, life, recs } · โครงเก่า (ไม่มี v) โหลดได้ + สำรองลง _bak ก่อน migrate
profit = {
  life: { revenue, baitCost, casts, catches, coffeeCost, potionCost, floatCost },
  recs: { [tier]: [ {fish, rarity, price, shiny, junk?, at, map?, bw?, bl?, sc?, md?, w?}, ... ] }  // ring buffer ≤ statKeep/ขั้น · w=น้ำหนัก(v6.75) · md='b'/'g' โหมดที่ตก(v6.88)
}
// pushCastCost() — ตอนคาสต์เข้าน้ำจริง (pendingCast confirm · โหมด bot เท่านั้น):
//   life.baitCost += baitUnit(tier) · life.casts += 1        ← เหวี่ยงพลาดก็เสียเหยื่อ
// pushCatch(c) — โหมด bot: อ่าน popup ผล (มี sc=คะแนน) → life.revenue/catches + push rec + feedModeStats('bot')
// recordGameCatch(r) — โหมด gameauto: อ่าน React state (pollGameCatches) → life.baitCost/casts/revenue/catches + push rec + feedModeStats('gameauto')
//   ⚠️ 1 ตัว = 1 เส้นทางเท่านั้น (v6.88 แก้นับซ้ำ): pollGameCatches gated=gameauto · result branch pushCatch gated≠gameauto
// สถิติเซสชัน (in-memory, รีเซ็ตตอน toggle เปิด): sessRev/sessBait/sessCatches · sessNet()
// lifeNet() = revenue − baitCost − coffeeCost − potionCost − floatCost · เซฟ throttle ≥3วิ

### `tokpla_bot_modestats` — สถิติ 2 แบบถาวร (v6.88 · เทียบ bot vs gameauto)
modeStats = { v:1, bot:BUCKET, gameauto:BUCKET }
BUCKET = { n, rev, baitCost, wSum, junk, rar:{[rarity]:n}, tier:{[tier]:n}, gauge:{n,star,sumDist}, eFirst, eLast, since, lastAt }
//   feedModeStats(mode,{price,baitCost,weight,rarity,junk,tier}) ป้อนจาก pushCatch+recordGameCatch · พลังจาก energyPct() (DOM)
//   modeCompareText/cmpModeLine: กำไรสุทธิ/ตัว · แรร์+% · ขยะ% · พลัง%/ตัว · (bot)เกจโดนดาว% · save throttle 5วิ+unload
```

### คีย์อื่น

| คีย์ | เนื้อหา |
|---|---|
| `tokpla_bot_cfg` | คอนฟิกทั้งหมด (ดู DEFAULTS) |
| `tokpla_bot_test` | ความคืบหน้าทดสอบ `{N, done:{'tier-phase':true}, potionByTier, startAt}` |
| `tokpla_bot_enabled` / `_at` | สถานะเปิด + heartbeat 30 วิ (auto-resume ถ้าสดภายใน 5 นาที) |
| `tokpla_bot_break_end` / `_label` | พักยาวคงอยู่หลังรีโหลด (เพดาน 60 นาที) |
| `tokpla_bot_reload_count` | ตัวนับกันลูปรีโหลด (ล้างเมื่อตกได้) |
| `tokpla_bot_log` | Log ring 300 บรรทัดล่าสุด (`{at,lv,m}`) — ไว้ทำรายงานปัญหา |

## UI accordion (v6.65) — ข้อควรรู้ก่อนแก้ buildPanel

- โครงเป็น **flat**: ทุกอย่าง `panel.appendChild(...)` เรียงกัน · `sectionHead(title, opened)` วาง "หัวข้อคั่น" (มี `dataset.sec`) · ทุก element หลังหัวข้อจนถึงหัวข้อถัดไป = กลุ่มเดียวกัน
- `wireCollapse()` (เรียกท้าย buildPanel) เดินลูก panel จับกลุ่ม + ผูกคลิกพับ/กาง + ตั้งสถานะเริ่มต้น
- **กฎ**: จะเพิ่ม row ใหม่ ต้องวางไว้ระหว่าง sectionHead ที่ถูกต้อง (ตำแหน่งในโค้ด = หมวดที่มันจะไปอยู่) · อย่าวาง element ที่ต้องโชว์ตลอด (เช่น ปุ่มลัด/statusEl) หลัง sectionHead ใด ๆ ไม่งั้นจะถูกพับ — ให้วาง "ก่อน" sectionHead แรก
- `pfHeadEl._onOpen = refreshStatsPanel` → เปิดหมวดสถิติแล้วรีเฟรชตัวเลข · `refreshProfit()` (เรียกตอนซื้อ/รีเซ็ต) ก็รีเฟรชตารางให้

## ระบบทดสอบเหยื่อ (สรุปกลไก)

- ทดสอบขั้น 1..`baitCeil` (อ่านจริงจากร้านด้วย `detectBaitCeil`) × 2 เฟส (**buff ก่อน plain** — ให้ยาหมดอายุพอดี) × `testCasts` ครั้ง
- ข้อมูลเข้า `profit.recs` ปกติ (ไม่แยกที่เก็บ) · รายงานใช้ `recBuffStat(tier, wantBuff, N, potionCost, test.startAt)` — time-fence กันข้อมูลเก่า
- นับเฉพาะ: เหยื่อตรงขั้น ∧ สถานะยาตรงเฟส (buff = 🐋∧🍀 ทั้งคู่ · plain = ไม่มีเลย) — ใช้ค่า `rec` ที่คืนจาก pushCatch (การอ่านครั้งเดียวกัน)
- เหยื่อ: equip จากกระเป๋าก่อน (`equipTestBait`/cycleTo) ค่อยซื้อถ้าไม่มี · resume ข้ามรอบที่ done · รอบล้มเหลวไม่มาร์ค done · stall-skip 8 นาที
