// ==UserScript==
// @name         Tokpla Auto-Fisher — Fishbone Cast 🎣
// @namespace    tokpla.bot
// @version      6.223
// @description  ตกปลาอัตโนมัติ + ความแม่นปรับได้ + ขาย/ซื้อ/ล็อกปลาอัตโนมัติ + เลือกเบ็ด + แจ้งเตือน Telegram + โหมดมนุษย์ + คำนวณกำไร + เลือกเหยื่อจากกำไร/ชม.จริง + บริดจ์แชทโลก
// @match        *://tokpla.vercel.app/*
// @match        *://fishbonecast.com/*
// @updateURL    https://raw.githubusercontent.com/amakiton/tokpla-bot/main/tokpla-autofish.user.js
// @downloadURL  https://raw.githubusercontent.com/amakiton/tokpla-bot/main/tokpla-autofish.user.js
// @grant        unsafeWindow
// @grant        GM_xmlhttpRequest
// @connect      api.telegram.org
// @connect      enhajkbbpdviekpbqwud.supabase.co
// @run-at       document-idle
// @noframes
// ==/UserScript==

// หมายเหตุ: ต้องมี @grant (ไม่ใช่ none) ไม่งั้น CSP ของ Vercel จะบล็อกสคริปต์

(function () {
  'use strict';

  // ใช้ window จริงของหน้าเว็บ เพื่อให้ React ได้ยิน event ที่เรายิง
  const W = (typeof unsafeWindow !== 'undefined' && unsafeWindow) || window;

  // หลอก Page Visibility API ให้เกมเห็นว่าแท็บ "เปิดอยู่" เสมอ
  // เกมเด้ง "พักจอนาน 5 นาที" เมื่อ document.hidden = true นานเกิน 5 นาที (แท็บถูกซ่อน/พับ/RDP หลุด)
  // override นี้ทำให้ hidden = false ตลอด + กลืน visibilitychange จึงไม่มีวันเด้ง (และลด throttle ด้วย)
  (function keepTabAlive() {
    try {
      if (W.localStorage.getItem('tokpla_bot_cfg') && JSON.parse(W.localStorage.getItem('tokpla_bot_cfg')).keepAlive === false) return;
    } catch {}
    try {
      Object.defineProperty(W.document, 'hidden', { configurable: true, get: () => false });
      Object.defineProperty(W.document, 'visibilityState', { configurable: true, get: () => 'visible' });
      W.document.addEventListener('visibilitychange', (e) => e.stopImmediatePropagation(), true);
      W.addEventListener('blur', (e) => e.stopImmediatePropagation(), true);
    } catch (e) { console.warn('[Tokpla Bot] keepAlive override ไม่สำเร็จ:', e); }
  })();

  const MAX_JUMP_PX = 60;      // เข็มขยับเกินนี้ใน 1 เฟรม = เกมรีเซ็ตรอบ ไม่ใช่การวิ่งจริง
  const CFG_KEY = 'tokpla_bot_cfg';
  const BOT_VER = '6.223';   // ⚠️ ให้ตรงกับ @version เสมอ — ใช้ใน statsExport/diagReport/console (จุดเดียว กันเลขค้าง)

  // สูตรคะแนนของเกม (แกะจากโค้ด) — ใช้คำนวณย้อนกลับว่าต้องกดห่างจากกึ่งกลางเท่าไร
  //   เกจตวัด : diff<=.09   -> 100 - diff/.09*40      (คะแนน 60..100)
  //   ดึงปลา  : diff<=.0165 -> 100 ทันที (โซนแดง)
  //             diff<=.11   -> 100 - diff/.11*30      (คะแนน 70..95)
  //   *ดึงปลาไม่มีคะแนน 96-99 อยู่จริง มันกระโดด 95 -> 100
  const CAST_SPAN = 0.09, CAST_DROP = 40;
  const REEL_SPAN = 0.11, REEL_DROP = 30;

  // ระดับความหายากของเกม — การ์ดปลาฝังสีขอบไว้ใน inline style (--tw-ring-color)
  // จึงอ่านระดับกลับมาจากสีได้ตรงๆ (แกะจาก RARITY_STYLE ในโค้ดเกม)
  const RARITY = [
    { key: 'common',    label: 'ทั่วไป',     color: '#9ca3af' },
    { key: 'uncommon',  label: 'ไม่ธรรมดา',  color: '#22c55e' },
    { key: 'rare',      label: '💙 หายาก',   color: '#3b82f6' },
    { key: 'epic',      label: '💜 สุดยอด',  color: '#a855f7' },
    { key: 'legendary', label: '🏅 ตำนาน',   color: '#f59e0b' },
    { key: 'mythic',    label: '🌈 เทพนิยาย', color: '#ec4899' },
  ];
  const RARITY_LABEL = Object.fromEntries(RARITY.map((r) => [r.key, r.label]));

  // 🎨 v6.222: แปลงสตริงสีใดๆ → [r,g,b] · รองรับ hex 3/6 หลัก · rgb()/rgba() · คั่นด้วย , หรือเว้นวรรค (Tailwind v3) · มี /alpha
  //   ที่มา: เดิมจับคู่สีแบบ "ตรงเป๊ะ" (#9ca3af หรือ 'rgb(156, 163, 175)') → เกม render เป็นรูปแบบอื่น (space-separated/alpha) = อ่านไม่ออก
  //   → ปลาระดับที่อ่านสีไม่ออกถูกถือว่า null = ไม่ขาย (ปลาธรรมดาค้างกระเป๋า "บางครั้ง")
  function colorToRGB(str) {
    if (!str) return null;
    str = String(str).trim().toLowerCase();
    let m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})/.exec(str);
    if (m) return [parseInt(m[1], 16), parseInt(m[2], 16), parseInt(m[3], 16)];
    m = /^#([0-9a-f])([0-9a-f])([0-9a-f])\b/.exec(str);
    if (m) return [17 * parseInt(m[1], 16), 17 * parseInt(m[2], 16), 17 * parseInt(m[3], 16)];
    m = /rgba?\(([^)]+)\)/.exec(str);
    if (m) { const n = m[1].split(/[\s,/]+/).map((x) => parseFloat(x)).filter((x) => !isNaN(x)); if (n.length >= 3) return [n[0], n[1], n[2]]; }
    return null;
  }
  const RARITY_RGB = RARITY.map((r) => ({ key: r.key, c: colorToRGB(r.color) }));
  // จับคู่สี → ระดับความหายาก (ใกล้สุดภายใน tolerance) · null = ไม่มีสี/ไม่ตรงพอ
  //   ปลอดภัย: สีระหว่างระดับห่างกัน (ผลรวม 3 ช่อง) > 150 เสมอ → tolerance 90 ไม่มีทางข้ามไประดับข้างเคียง
  function rarityFromColor(str) {
    const rgb = colorToRGB(str); if (!rgb) return null;
    let best = null, bestD = Infinity;
    for (const r of RARITY_RGB) { const d = Math.abs(rgb[0] - r.c[0]) + Math.abs(rgb[1] - r.c[1]) + Math.abs(rgb[2] - r.c[2]); if (d < bestD) { bestD = d; best = r.key; } }
    return bestD <= 90 ? best : null;
  }

  // เหยื่อ/เบ็ด 8 ขั้น (แกะจาก BAIT_TIERS / ROD_TIERS) — ราคาเหยื่อคือต่อชิ้น ขายเป็นแพ็ค 100
  const BAIT_TIERS = [
    { tier: 1, name: 'ไส้เดือน',            unit: 5,   lv: 1 },
    { tier: 2, name: 'มัดไส้เดือนอ้วน',      unit: 12,  lv: 5 },
    { tier: 3, name: 'จิ้งหรีดเขียว',        unit: 25,  lv: 10 },
    { tier: 4, name: 'กุ้งฝอยสด',           unit: 45,  lv: 16 },
    { tier: 5, name: 'เหยื่อปลอมปลาเงิน',    unit: 80,  lv: 24 },
    { tier: 6, name: 'หนอนทองคำ',           unit: 140, lv: 32 },
    { tier: 7, name: 'สปินเนอร์ขนนก',        unit: 250, lv: 44 },
    { tier: 8, name: 'เหยื่อปลารุ้งมายา',    unit: 450, lv: 56 },
  ];
  const ROD_NAMES = ['', 'เบ็ดกิ่งไม้', 'เบ็ดไผ่ด้ามแดง', 'เบ็ดไฟเบอร์', 'เบ็ดคาร์บอนดำ',
    'เบ็ดเงินฝังพลอย', 'เบ็ดทองคำหรู', 'เบ็ดคริสตัลน้ำแข็ง', 'เบ็ดมังกรตำนาน'];
  const PACK_SIZE = 100, BAIT_CAP = 1000;

  const DEFAULTS = {
    // 🎣 โหมดตกปลา (กลไกใหม่ = มินิเกมจับจังหวะหลายเฟส):
    //   'bot'      = บอทเล่นมินิเกมเองครบทุกเฟส (v6.84 — ถอดรหัส UI overlay สำเร็จ ทดสอบสดได้ปลาจริง)
    //                เหวี่ยง→ตวัด(❗)→เกจวงล้อ(กดโซนแดง)→ชักเย่อ(PD คุมกรอบ)→สู้(กดรัว) — ตกเองได้โบนัสโชค/คะแนนสูงกว่า auto เกม
    //   'gameauto' = ให้ระบบ auto ของเกมตก (สำรอง — เสถียรสุดถ้าเกมอัปเดตจนเอนจิน bot พัง)
    //   'off'      = ไม่ตกปลา แต่ยังทำระบบอื่น (ขาย/ซื้อ/เควส/จดหมาย/พลังงาน)
    //   ทั้ง bot และ gameauto เก็บสถิติต่อตัวผ่าน readGameCatchArr (ผลปลาไม่โชว์ popup DOM แล้ว)
    fishMode: 'bot',
    turbo: false,                // ⚡ โหมดเร็วสุด: ตัด castGap/พักย่อย-ใหญ่-เซสชัน/หน่วงรีแอค ให้น้อยสุด — คงเกจเล็งดาวเป๊ะ (ความแม่นไม่ลด) · แลกกับความสมจริง (เสี่ยงโดนจับว่าเป็นบอท)
    // 👹 ล่าบอส (แผนที่ boss_cave "ถ้ำบ่อโบราณ") — ใกล้เวลาบอสเกิด เดินไปล่า แล้วกลับแมพเดิมฟาร์มต่อ
    bossHunt: false,             // เปิดระบบล่าบอสอัตโนมัติ (ดีฟอลต์ปิด — กลไก "สู้บอส" ต้องจูนกับบอสจริงก่อน)
    bossLeadMin: 5,              // เริ่มเดินทางก่อนบอสเกิดกี่นาที (เผื่อเวลาเดินข้ามแมพ)
    bossMaxWaitMin: 8,           // อยู่ในถ้ำบอสสูงสุดกี่นาที (รอบอส+สู้) — ครบแล้วกลับบ้านแม้บอสไม่ตาย/ไม่มา
    bossHomeMap: '',             // แมพที่จะกลับไปฟาร์มต่อ (ว่าง = แมพที่อยู่ตอนเริ่มล่า)
    bossBaitTier: 2,             // 👹 เหยื่อ "จุดอ่อนบอส" ระหว่างตี (วิดีโอ: มัดอ้วนขั้น2/กุ้งฝอยขั้น4 = ดาเมจ x1.5) · 0 = ไม่สลับ
    bossStatKeep: 20,            // 📊 v6.195: เก็บสถิติล่าบอสกี่ "ครั้งล่าสุด" (ring buffer · 0 = ปิดการเก็บ)
    bossIntervalMin: 180,        // 🔮 v6.211: บอสมาทุกกี่นาที (ข้อมูลจริง = 3 ชม.) — ใช้ทำนายรอบถัดไปตอนอ่านเวลาจาก DOM ไม่ได้
    rodSwitchOn: true,          // ⛔ v6.189: ปิดไว้ — พิสูจน์แล้วว่า G สลับได้แค่ "tier" ไม่ใช่ "ชิ้นเบ็ด" (CHANGELOG v6.188)
                                 //   เปิดมีประโยชน์กรณีเดียว: เบ็ดบอส/เบ็ดฟาร์มของคุณอยู่คนละ tier กันจริงๆ
    bossRodId: '',               // 🎣 v6.174: UUID "ชิ้นเบ็ด" ที่ใช้ตอนตีบอส (เช่นชิ้นที่ติดหินดาเมจบอส) · ว่าง = ไม่สลับ
    farmRodId: '',               // 🎣 v6.174: UUID "ชิ้นเบ็ด" ที่ใช้ตอนฟาร์มปกติ · ว่าง = กลับไปชิ้นเดิมก่อนเข้าไฟต์

    // 🏪 ระบบ NPC เมืองชาวประมง (v6.150) — เดินไปด้วย game A* แล้วกลับแมพเดิมฟาร์มต่อ
    npcStorageOn: false,         // 🏬 ลุงคลัง: ฝากปลาระดับ >= npcStorageRarity เข้าคลัง (ปลอดภัย+ไม่กินช่องกระเป๋า) เมื่อมี >= npcStorageMin ตัว
    npcStorageRarity: 'legendary',
    npcStorageMin: 5,
    npcEssenceOn: false,         // 🧪 ยายแก่น: แลกปลาระดับ >= npcEssenceRarity เป็นแก่นปลา เมื่อมี >= npcEssenceMin ตัว
    npcEssenceRarity: 'rare',
    npcEssenceMin: 10,
    npcStorageBagPct: 0,         // 🛡️ C: ฝากปลา(เข้าเกณฑ์)เมื่อกระเป๋าเต็มถึง % นี้ (กันบอทขายปลาแพงตอนกระเป๋าเต็ม) · 0=ปิด (ใช้เกณฑ์จำนวนอย่างเดียว)
    // 🪨 v6.178: ตัดระบบช่างหิน (orbsmith) ทั้งหมด — ผู้ใช้สั่ง "แลก/ตีหินเอง ใช้แค่ลุงคลังกับยายแก่นพอ" (อย่าเพิ่มกลับ)

    // 🌈 โหมดล่าปลาเทพ (legendary/mythic + ปลาหนัก) — "ชั้นนโยบาย" override ที่จุดอ่าน ไม่เขียนทับค่าผู้ใช้ (ปิด = กลับค่าเดิมทันที)
    mythicHunt: false,           // เปิดโหมดล่าปลาเทพ
    mythicBait: 0,               // เหยื่อขณะล่า · 0 = ออโต้ (ทดสอบเองว่าขั้นไหน "มูลค่าปลาเทพ/cast" คุ้มส่วนต่างราคาเหยื่อสุด แล้วใช้ขั้นนั้น) · 1-8 = ล็อกขั้น
    mythicLuck: true,            // ยา 🍀 โชคปลาแรร์ อัตโนมัติระหว่างล่า (+8% แรร์ · อยู่ใต้ no-loss gate)
    mythicWeight: true,          // ยา 🐋 ปลาตัวใหญ่ อัตโนมัติระหว่างล่า (ปลาหนักขายแพง +15% · อยู่ใต้ no-loss gate)
    mythicMap: '',               // แมพเป้าหมาย (ชื่อบน HUD) · ว่าง = เลือกอัตโนมัติจากสถิติ "มูลค่าปลาเทพ/ชม." ของจริง
    mythicCheckMin: 15,          // no-loss gate: เช็คกำไรสุทธิทุกกี่นาที (ติดลบ 1 รอบ→งดยา · 2 รอบติด→พักโหมด)
    castMin: 95, castMax: 100,   // ช่วงคะแนนเกจตวัดที่ต้องการ (สุ่มในช่วงนี้) — ใช้เฉพาะโหมด bot
    reelMin: 95, reelMax: 100,   // ช่วงคะแนนมินิเกมดึงปลา — ใช้เฉพาะโหมด bot
    loop: true,                  // ตกต่อเนื่องไหม
    limit: 99,                   // จำนวนครั้ง (0 = ไม่จำกัด)

    sell: false,                 // ขายอัตโนมัติ
    sellEvery: 10,               // เปิดกระเป๋าเช็คทุกๆ กี่ครั้งที่เหวี่ยง
    sellAtPct: 80,               // ขายเมื่อกระเป๋าเต็มกี่ % (0 = ไม่ใช้เงื่อนไขนี้) — ปรับตาม bagSlots จริง
    sellAtCount: 0,              // ขายเมื่อของในกระเป๋าถึงกี่ชิ้น (0 = ไม่ใช้เงื่อนไขนี้)
    sellAtCoins: 0,              // ขายเมื่อมูลค่ารวมถึงกี่เหรียญ (0 = ไม่ใช้เงื่อนไขนี้)
    sellJunk: true,              // ขายกลุ่มขยะ 🗑️ ทั้งหมดด้วยทุกครั้งที่ขาย (ขยะไม่มีล็อก ขายเกลี้ยง)
    // ===== 📊 ระบบสถิติใหม่ (per-cast records): ทุกครั้งที่ตก บันทึก เหยื่อ/ราคาได้/กำไร/แมพ/ยา =====
    statKeep: 200,               // เก็บสถิติกี่รายการล่าสุด "ต่อชนิดเหยื่อ" (ring buffer — เกินแล้วตัวเก่าหลุด)
    excludeRarities: ['mythic', 'legendary'], // ไม่นับระดับนี้ในสถิติเลือกเหยื่อ — mythic+legendary = ตัวแพงฟลุ๊ค ราคาสูงมากแต่มาจากดวง (แทบไม่ขึ้นกับขั้นเหยื่อ) ทำให้เลือกเหยื่อเพี้ยน · ตัดออก = ตัดสินนิ่งขึ้น (ยังตกได้เท่าเดิม)
    excludeSpecies: '',          // ไม่นับปลาชนิดนี้ (คั่นด้วยจุลภาค) · ว่าง = ไม่ยกเว้นเพิ่ม
    adaptFilterMap: true,        // 🗺️ กรองสถิติเฉพาะ "แมพปัจจุบัน" ตอนตัดสินใจ (แต่ละแมพปลา/ราคาต่างกัน)
    adaptFilterBuff: false,      // 🧪 กรองสถิติเฉพาะรายการที่ "สถานะยาตรงกับตอนนี้" (เข้มขึ้น ข้อมูลน้อยลง)
    speciesMode: 'all',          // all = ขายทุกชนิด | only = เฉพาะที่ระบุ | except = ทุกชนิดยกเว้นที่ระบุ
    speciesList: '',             // ชื่อปลาคั่นด้วยจุลภาค
    keepShiny: true,             // ล็อกชนิดที่มีตัว ✨ อยู่ในกระเป๋า
    lockRarities: ['rare', 'epic', 'legendary', 'mythic'],   // ระดับที่ห้ามขาย

    autoBuy: false,              // ซื้อเหยื่ออัตโนมัติเมื่อใกล้หมด
    sellBeforeBuy: true,         // ขายปลาก่อน "ซื้อเหยื่อใหม่"
    statWin: 100,                // 📊 สถิติ: ใช้กี่รายการล่าสุด/ขั้นในการแสดงผล (ต่อชนิดเหยื่อ)
    testCasts: 100,              // 🧪 ทดสอบเหยื่อกี่ครั้ง/รอบ (รอบไม่ใช้ยา + รอบใช้ยา = 2 รอบ/ขั้น)
    testBuffMode: 'both',        // 🧪 รอบยาของการทดสอบ: 'plain'=ไม่ใช้ยาอย่างเดียว · 'buff'=ใช้ยา 🐋🍀 อย่างเดียว · 'both'=ทั้งคู่ (เทียบยาคุ้มไหม · จำนวนรอบ ×2)
    testMode: 'bot',             // 🧪 ทดสอบโหมดไหน: 'bot'=บอทเหวี่ยงเอง · 'gameauto'=ออโต้ของเกม · 'both'=ทั้งคู่ (จำนวนรอบ ×2)
    testDoneAction: 'stop',      // 🧪 ทดสอบครบทุกรอบแล้วทำอะไรต่อ: 'stop'=หยุดบอท · 'bot'=ตกต่อโหมดบอท · 'gameauto'=ตกต่อโหมดออโต้เกม
    testNoTiers: '',             // 🧪 ข้ามขั้นเหยื่อที่ไม่อยากทดสอบ (CSV เช่น "6,7,8") — กันเสียเงินทดสอบขั้นแพง/ขาดทุน · ว่าง = ทดสอบทุกขั้น
    testSkipLosing: true,        // 🧪📉 ข้ามขั้นที่ "ข้อมูลจริงพิสูจน์แล้วว่าขาดทุน" อัตโนมัติ (ดู provenLossTier) — v6.186: เทสต์เคยเผาเงินฟาร์มขั้น 8 ที่ -366/ครั้ง ทั้งที่มีข้อมูล 400 ตัวอย่างชี้ชัดแล้ว

    noRestOnBuff: true,          // 🧪 ถ้ากำลังใช้ยาบัฟอยู่ (🐋/🍀) ห้ามพัก/นั่งพัก — ตกต่อจนยาหมด (ไม่เสียเวลายา 30 นาที)
    energyManage: false,         // จัดการพลังงานเชิงรุก (พักเมื่อถึงเกณฑ์ล่าง กลับมาตกเมื่อถึงเกณฑ์บน)
    energyRestAt: 20,            // พักเมื่อพลังงานเหลือ ≤ กี่ %
    energyResumeAt: 80,          // กลับมาตกเมื่อพลังงานฟื้นถึง ≥ กี่ %
    energySit: true,             // นั่งพัก (ท่าทาง) ระหว่างรอพลังฟื้น

    autoQuest: false,            // เก็บเควสรายวันอัตโนมัติ (รางวัลพลังงาน ⚡)
    questEvery: 30,              // เช็คเควสทุกกี่นาที
    questMaxEnergy: 100,         // รับเควสเฉพาะตอนพลังงาน < กี่ % (กันพลังล้นเสียเปล่า)
    // 🎒 v6.194: "ใช้ของฟรีในกระเป๋าก่อนเสมอ" — แยกจากการซื้อ (เสียเงิน) · เดิมโค้ดใช้ของฝังใน buyCoffee/buyPotions
    //   → ปิดการซื้อ = ไม่แตะของฟรีในกระเป๋าเลย (กาแฟ/ยา จากจดหมาย/รางวัลค้างทิ้ง) · เปิดไว้ = ใช้ของฟรีแม้ปิดการซื้อ
    useBagConsumables: true,     // ใช้กาแฟ/ยา ที่มีในกระเป๋าก่อน แม้ปิดการซื้ออัตโนมัติ (ของฟรี ไม่เสียเงิน)
    buyCoffee: false,            // ซื้อ ☕ กาแฟเติมพลังในร้าน (หลังเก็บเควสหมด) เพื่อตกต่อเนื่อง 24 ชม.
    coffeeAtEnergy: 35,          // ซื้อกาแฟเมื่อพลัง ≤ กี่ % (เก็บเควสก่อน ถ้าไม่พอค่อยซื้อ) · กาแฟ +50 พลัง 1,500 🪙
    buyPotion: false,            // ซื้อยาบัฟอัตโนมัติเมื่อบัฟหมด (เฉพาะตอนรายได้/ชม.ถึงเกณฑ์ = คุ้ม)
    potionWeight: true,          // 🐋 ยาปลาตัวใหญ่ (+15% น้ำหนัก=ราคาขาย 30 นาที · 2,000 🪙)
    potionLuck: false,           // 🍀 ยาโชคปลาแรร์ (+8% โอกาสแรร์ 30 นาที · 2,500 🪙)
    potionMinCph: 25000,         // ซื้อยาเฉพาะเมื่อรายได้ ≥ กี่ 🪙/ชม. (ต่ำกว่านี้ไม่คุ้มต้นทุนยา)
    potionMinEnergy: 20,         // 🧪 ห้ามใช้ยาเมื่อพลังเหลือ < กี่ % (ยาอยู่ 30 นาที — พลังต่ำแล้วเปิดยา = พักกลางบัฟ ทิ้งยาเปล่า) · 0 = ปิดเกณฑ์นี้
    potionRequireBoth: false,    // 🧪 ต้องเปิดยาครบทั้งคู่ (🐋+🍀) เท่านั้น — เปิดได้ไม่ครบ = ไม่เปิดเลย (สถิติรอบยาเทียบง่าย · เปลืองน้อยกว่าเปิดตัวเดียวแล้วไม่คุ้ม)
    potionBaitTiers: '',         // 🧪 อนุญาตให้ "ใช้ยา" เฉพาะตอนใส่เหยื่อขั้นเหล่านี้ (คั่นด้วย , เช่น "5,6,7") · ว่าง = ทุกขั้น · ขั้นนอกรายการจะไม่ต่อยา (บัฟที่ค้างอยู่ยังใช้ต่อจนหมด)
    advisor: false,              // 🧠 ผู้ช่วยอัจฉริยะ: วิเคราะห์เหยื่อ+ยาทุก 5 นาที แล้ว "แนะนำ" (ไม่ลงมือ)
    advisorAuto: false,          // 🧠🤖 ให้ Advisor ลงมือเอง: สลับขั้นเหยื่อ + คุมจังหวะซื้อยา (ต้องเปิด advisor ด้วย)
    advisorNoTiers: '',          // 🚫 ห้าม Advisor เลือกขั้นเหยื่อเหล่านี้ (คั่นด้วย , เช่น "6,7,8") · ว่าง = เลือกได้ทุกขั้น · ห้ามครบทุกขั้น = ยกเลิกการห้าม (กันบอทค้าง)
    autoMail: true,              // ✉️ เปิดจดหมายเก็บของขวัญจากผู้พัฒนาอัตโนมัติ (ฟรี ไม่เก็บ = ค้างเฉยๆ)
    mailEvery: 240,              // เช็คจดหมายทุกกี่นาที
    baitTier: 3,                 // เหยื่อระดับที่ใช้ (ตั้งเอง) — ค่ากลางถูกๆ ที่คุ้ม ไม่ใช่ขั้นแพงที่เปลืองเปล่า
    buyBelow: 20,                // เหลือน้อยกว่านี้ค่อยซื้อ
    // 🪱 v6.193: "ไล่ใช้สต๊อกเหยื่อที่กองอยู่ให้หมดก่อนซื้อใหม่" — เหยื่อที่ซื้อแล้ว = ต้นทุนจม ใช้ฟรี
    //   เลือกไล่ "ขั้นที่รายได้/ครั้งสูงสุด (ตัดฟลุ๊ค) ในบรรดาที่มีกองใหญ่" ก่อน · ไล่เฉพาะขั้นที่ "ไม่แย่กว่า" ขั้นที่ Advisor จะเลือก
    //   → ไม่ไล่ขั้นรายได้ต่ำ (เช่น 7/8) เพราะเอามาตกได้น้อยกว่าฟาร์มขั้น 1 ด้วยซ้ำ (ขายคืน 50% คุ้มกว่า)
    useBaitStock: false,         // ปิดไว้ (opt-in) — เปิด = ไล่ใช้สต๊อกเหยื่อขั้นคุ้มก่อน แล้วค่อยกลับไปให้ Advisor เลือก
    baitStockMin: 200,           // นับเป็น "กองใหญ่ที่ควรไล่" เมื่อมี ≥ เท่านี้
    // 🔬 v6.207: "สำรวจขั้นเหยื่อเป็นระยะ" — Advisor ใช้ข้อมูล statWin ล่าสุด "เฉพาะขั้นที่ตกอยู่"
    //   ขั้นอื่นจึงค้างข้อมูลเก่าถาวร → เกมปรับ % / ราคาปลาเมื่อไร บอทไม่มีทางรู้ (exploit อย่างเดียว ไม่ explore)
    //   เปิดแล้ว = เป็นระยะจะสลับไปเก็บตัวอย่างขั้นที่ "ข้อมูลเก่าสุด" สั้นๆ แล้วกลับมาขั้นที่ Advisor เลือก
    advExplore: false,           // opt-in (การสำรวจมีต้นทุน — ตกด้วยขั้นที่อาจแย่กว่าชั่วคราว)
    advExploreHours: 6,          // สำรวจทุกกี่ชั่วโมง
    advExploreCasts: 30,         // สำรวจครั้งละกี่ครั้ง (ยิ่งมากยิ่งแม่น แต่ยิ่งแพง)
    advExploreMaxCost: 3000,     // งบต่อรอบสำรวจ (🪙) — ประเมินจาก (กำไรขั้นที่ดีสุด − ขั้นที่จะลอง) × จำนวนครั้ง · เกินงบ = ข้ามขั้นนั้น

    // 🎁 v6.216: เก็บหีบสมบัติที่โผล่ในแมพเป็นระยะ (opt-in — ต้องเดินออกจากจุดตกปลา · บอส/เมือง/ล่าปลาเทพ สำคัญกว่า)
    grabChest: false,            // เปิด = เจอหีบในแมพปัจจุบัน → เดินไปเปิด (กด E) แล้วกลับมาตกต่อ · มีลิมิตต่อวันของเกมเอง (chestDailyComplete)
    chestCheckMin: 3,            // เช็คหาหีบทุกกี่นาที (ถี่ไป = เดินบ่อยเสียเวลาตก · ห่างไป = หีบอาจหมดอายุก่อน)
    buyPacks: 1,                 // ซื้อกี่แพ็ค (แพ็คละ 100 ชิ้น)
    forceBait: false,            // บังคับสลับไปใช้เหยื่อระดับที่ตั้งไว้
    forceRod: false,             // บังคับสลับไปใช้เบ็ดขั้นที่ตั้งไว้
    rodTier: 1,                  // เบ็ดขั้นที่อยากใช้ (ต้องมีเบ็ดขั้นนั้นแล้ว)

    tgOn: false,                 // เปิดแจ้งเตือน Telegram
    tgToken: '',                 // token จาก @BotFather
    tgChat: '',                  // chat_id ปลายทาง
    tgRarities: ['legendary', 'mythic'],   // แจ้งเตือนเมื่อได้ปลาระดับเหล่านี้
    tgShiny: true,               // แจ้งเมื่อได้ปลา ✨
    tgNew: true,                 // แจ้งเมื่อได้ปลาตัวใหม่ (NEW!)
    tgRecord: true,              // แจ้งเมื่อทำลายสถิติน้ำหนักตัวเอง
    tgStop: true,                // แจ้งเมื่อบอทหยุด
    tgPause: true,               // แจ้งเมื่อพักรอพลัง
    tgTrade: false,              // แจ้งเมื่อขาย/ซื้อสำเร็จ
    tgProfit: false,             // ส่งสรุปกำไร/สถิติเหยื่อทาง Telegram (เมื่อกดปุ่มสรุป)
    tgEvery: 0,                  // ส่งสรุปทุกๆ กี่ครั้งที่ตกได้ (0 = ปิด)
    tgStart: true,               // แจ้งเมื่อบอทเริ่มทำงาน (ยืนยันหลังรีสตาร์ท)
    tgWarn: true,                // แจ้งเมื่อมีเหตุต้องดูแล (ขายไม่ได้/ซื้อไม่ได้/พักระบบ)
    tgLevel: true,               // แจ้งเมื่อเลเวลอัพ (ปลดล็อกเบ็ด/เหยื่อใหม่)
    tgWeather: true,             // แจ้งเมื่อสภาพอากาศเปลี่ยน (ฝนตก/ปลาชุก = ปลากินไวขึ้น)
    tgHeartbeat: 0,              // ส่งรายงานสถานะทุกๆ กี่นาที (0 = ปิด) — ไว้เช็คว่าบอทยังรันอยู่

    keepAlive: true,             // หลอกให้เกมคิดว่าแท็บเปิดอยู่ตลอด (กันเด้ง "พักจอนาน 5 นาที")
    autoRecover: true,           // เด้งออก/ค้าง -> รีโหลดกลับเข้าเกมเอง แล้วตกต่อ
    recoverStuckMin: 8,          // ไม่มีความคืบหน้ากี่นาที ถือว่าค้าง แล้วรีโหลด
    tgControl: false,            // รับคำสั่งควบคุมบอทผ่าน Telegram (poll getUpdates)
    tgControlToken: '',          // Bot Token สำหรับ "ห้องควบคุม" แยก (ว่าง = ใช้ตัวเดียวกับแจ้งเตือน)
    tgControlChat: '',           // chat_id ห้องควบคุม (ว่าง = ใช้ห้องเดียวกับแจ้งเตือน)
    chatBridge: false,           // บริดจ์แชทโลก <-> Telegram: อ่านแชทโลกส่งเข้า TG + พิมพ์ใน TG ส่งเข้าแชทโลก (ต้องเปิด tgControl)

    // ===== โหมดมนุษย์ (Layer 1: จังหวะ+คะแนนสมจริง) =====
    human: false,                // สวิตช์รวม (ปิด = ทุกอย่างกลับเป็นแม่นสุด/เร็วสุด)
    hReact: true,                // หน่วงรีแอคตอนปลาฮุบ
    hMiss: true,                 // กดพลาดบ้าง
    hCastGap: true,              // จังหวะเหวี่ยงสุ่ม + เหม่อ
    hBreak: true,                // พักย่อย/พักใหญ่
    hSession: true,              // จำกัดเวลาต่อเซสชัน
    hEnergy: true,               // พักรอพลังแบบสุ่ม
    reactMinMs: 190,             // หน่วงรีแอคตอนปลาฮุบ ต่ำสุด (ms)
    reactMaxMs: 430,             // ...สูงสุด — ยิ่งช้า hook score ยิ่งลง (สมจริง)
    missChance: 6,               // % ครั้งที่จงใจกดคะแนนต่ำ (มนุษย์พลาดบ้าง)
    castGapMinMs: 800,           // จังหวะเหวี่ยงสุ่ม ต่ำสุด (ms)
    castGapMaxMs: 2600,          // ...สูงสุด
    distractChance: 8,           // % ครั้งที่จะ "เหม่อ" นานกว่าปกติ
    distractMinMs: 5000,         // ช่วงเหม่อ ต่ำสุด (ms)
    distractMaxMs: 16000,        // ...สูงสุด

    // ===== Layer 2: พัก + จำกัดเวลาเซสชัน =====
    microEvery: 25,              // พักย่อยทุกๆ กี่ครั้ง (สุ่ม ±40%)
    microMinSec: 5,              // พักย่อย ต่ำสุด (วินาที)
    microMaxSec: 30,             // ...สูงสุด
    macroEvery: 120,             // พักใหญ่ทุกๆ กี่ครั้ง (สุ่ม ±30%)
    macroMinMin: 2,              // พักใหญ่ ต่ำสุด (นาที)
    macroMaxMin: 10,             // ...สูงสุด
    sessionMinMin: 25,           // เล่นต่อเซสชัน ต่ำสุด (นาที)
    sessionMaxMin: 75,           // ...สูงสุด
    sessionAction: 'break',      // 'break' = พักยาวแล้วเล่นต่อ | 'stop' = หยุดบอท
    sessionBreakMinMin: 10,      // พักยาวจบเซสชัน ต่ำสุด (นาที)
    sessionBreakMaxMin: 30,      // ...สูงสุด
    energyPauseMinSec: 45,       // พักรอพลังสุ่ม ต่ำสุด (วินาที)
    energyPauseMaxSec: 90,       // ...สูงสุด
  };

  let cfg = loadCfg();
  let enabled = false;
  let busy = false;       // กำลังเปิดกระเป๋า/ขายอยู่ — หยุดตกชั่วคราว
  let orchestrating = false;   // กำลังทำลำดับหลายขั้น (ขาย→สรุป→ซื้อ) — กัน tick แทรกกลาง
  let baitCeil = 8;            // ขั้นเหยื่อสูงสุดที่ใช้ได้จริง (เรียนรู้จากที่เจอ locked)
  let lastKnownBaitTier = 0;   // ขั้นเหยื่อที่ "รู้แน่ๆ" ล่าสุด (จาก currentBait สำเร็จ หรือ "ใส่อยู่ ✓" ในร้าน) — fallback สถิติที่แม่นกว่า cfg.baitTier
  let testRunning = false;     // 🧪 โหมดทดสอบเหยื่อกำลังทำงาน (บอทควบคุมเหยื่อ/ยา/นับ 100 ครั้ง/รอบ)
  let test = null;             // { data:{tier:{plain,buff}}, tier, phase, N }
  let lastPress = 0;      // กันกด Space รัวเกินไป
  let lastCast = 0;       // กันคลิกปุ่มตกปลารัวเกินไป
  let prevPos = null;     // ตำแหน่งเข็มเฟรมก่อนหน้า (ไว้คำนวณความเร็ว)
  let zoneKey = null;     // ตำแหน่งโซนเขียว — เปลี่ยนเมื่อไหร่ = ขึ้นรอบใหม่
  let armed = true;       // ยังไม่ได้กดในรอบนี้
  let aimPx = null;       // จุดที่ตั้งใจกดในรอบนี้ (px บนจอ)
  let casts = 0;          // นับจำนวนครั้งที่เหวี่ยงสำเร็จ
  let lastCheck = 0;      // เช็คกระเป๋าครั้งล่าสุดตอน casts เท่าไร
  let earned = 0;         // เหรียญที่ขายได้ในเซสชันนี้ (นับจากที่เกมบอก)
  let roundAt = 0;        // เวลาที่เริ่มรอบมินิเกมรอบนี้ (ไว้กันบอทค้าง)
  let pendingCast = 0;    // เวลาที่กดปุ่มตกปลาไปแล้วแต่เกมยังไม่ขยับ
  let failedCasts = 0;    // กดตกปลาแล้วไม่ติดกี่ครั้งติดกัน
  let lastBuyTry = 0;     // ลองแวะซื้อเหยื่อครั้งล่าสุดเมื่อไร
  // 🛡️ v6.105 กันวนลูป: ถ้า "หาแถวเหยื่อในร้านไม่เจอ" ติดกันหลายครั้ง (selector พัง/แท็บไม่สลับ) ให้ถอยแล้วแจ้ง
  //   ไม่งั้น ensureGear ตั้ง needBuy ใหม่ทุกรอบ → เปิด-ปิดร้านทุก ~4 วิ ไม่มีที่สิ้นสุด (บั๊กจริง v6.104)
  let baitRowMiss = 0, baitBuyFailUntil = 0;
  let needBuy = false;    // สลับไปเหยื่อขั้นที่ตั้งไว้ไม่ได้เพราะของหมด — ต้องไปซื้อก่อน
  let warnAt = 0;         // จัดการคำเตือนของเกมครั้งล่าสุดเมื่อไร (กันจัดการซ้ำ)
  let pauseUntil = 0;     // พักรอพลัง ⚡ ถึงเวลาไหน
  let awayAt = 0;         // ปุ่มตกปลาถูกปิด (ยืนไกลบ่อ) ตั้งแต่เมื่อไร
  let bagFullTries = 0;   // เจอกระเป๋าเต็มแล้วขายไม่ออกกี่ครั้งติด
  let storageFullUntil = 0;   // 🏬 v6.223: คลังลุงคลังเต็ม → พักระบบฝากถึงเวลานี้ (กันวนไปเมืองฝากไม่ได้ไม่จบ)
  let catchNotified = false;   // แจ้ง popup ปลาตัวนี้ไปแล้วหรือยัง (popup เดียวอยู่หลายเฟรม)
  let pauseNotified = false;   // แจ้งเรื่องพักพลังไปแล้วหรือยัง
  let energyResting = false;   // กำลังนั่งพักรอพลังฟื้น (จัดการเชิงรุก)
  let lastRestCoffeeAt = -1e9;   // v6.209: throttle การลองกาแฟระหว่างนั่งพัก (นาทีละครั้ง)
  let energySat = false;       // กดปุ่มนั่งพักไปแล้ว (ไว้ลุกตอนกลับมาตก)
  let sessionStart = 0;        // เวลาเปิดบอทรอบนี้ (ไว้คำนวณ uptime)
  let lastHeartbeat = 0;       // ส่งรายงานสถานะครั้งล่าสุดเมื่อไร
  let lastProgressAt = 0;      // มีความคืบหน้า (ตกได้/เปลี่ยนสถานะ) ครั้งล่าสุดเมื่อไร
  let loginAlerted = false;    // แจ้งเรื่องเด้งไป login ไปแล้วหรือยัง
  let paused = false;          // พักชั่วคราว (บอทยังเปิด แต่ไม่ตก)
  let lastQuestCheck = 0;      // เช็คเควสครั้งล่าสุดเมื่อไร
  let lastTimeSellAt = 0;      // เช็คขายแบบอิงเวลา (โหมด gameauto/off ที่ตัวนับ casts ไม่ขยับ) ครั้งล่าสุด
  let gameAutoSayAt = 0;       // ประกาศ "เปิดตกปลาอัตโนมัติของเกม" ครั้งล่าสุด (throttle กันสแปมตอน restart หลัง maintenance)
  let lastGameCatchPoll = 0;   // อ่านผลตกจาก state เกม (โหมด gameauto) ครั้งล่าสุด — throttle ~100ms
  let curMap = null;           // ชื่อแมพปัจจุบัน (อ่านจาก HUD chip "📍 ...") — ใช้ tag catch + แยกสถิติตามแมพ
  let lastIdleWork = 0;        // throttle งานเบื้องหลังใน idle branch (ไม่ต้องเช็คทุกเฟรม)
  let barCache = null;         // ผล findBar() ของเฟรมนี้ (gameState หาไว้ → branch ดึงปลาใช้ต่อ ไม่ scan ซ้ำ)
  let biteAt = 0;         // เห็นปุ่มตวัดครั้งแรกเมื่อไร (โหมดมนุษย์)
  let biteReact = 0;      // หน่วงรีแอคที่สุ่มไว้รอบนี้ (ms)
  let castArmed = false;  // ตั้งเวลาพักก่อนเหวี่ยงครั้งถัดไปแล้วหรือยัง
  let gateStart = 0;      // เริ่มจับเวลารอเหวี่ยงเมื่อไร
  let castGate = 0;       // ระยะรอก่อนเหวี่ยง (ms) — สุ่มต่อครั้ง
  let breakUntil = 0;     // พักย่อย/ใหญ่/จบเซสชัน ถึงเวลาไหน
  let breakLabel = '';    // ป้ายบอกว่าพักแบบไหน
  let nextMicroAt = 0;    // casts ที่จะพักย่อยครั้งถัดไป
  let nextMacroAt = 0;    // casts ที่จะพักใหญ่ครั้งถัดไป
  let sessionEndAt = 0;   // เวลาที่เซสชันควรจบ
  let btn = null, panel = null, statusEl = null;

  const now = () => performance.now();
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
  const rand = (lo, hi) => lo + Math.random() * (hi - lo);
  const randInt = (lo, hi) => Math.round(rand(Math.min(lo, hi), Math.max(lo, hi)));

  function loadCfg() {
    try {
      const raw = W.localStorage.getItem(CFG_KEY);
      if (raw) {
        const old = JSON.parse(raw);
        const c = { ...DEFAULTS, ...old };
        // ย้ายค่าเก่า: เวอร์ชันก่อนหน้ายังไม่มี sellAtPct และใช้ sellAtCount = 40 เป็นค่าเริ่มต้น
        // ถ้ายังเป็นค่าเริ่มต้นเดิม เปลี่ยนมาใช้ % (ปรับตามขนาดกระเป๋าเองได้)
        // ถ้าผู้ใช้เคยตั้งตัวเลขเอง ให้เคารพค่านั้นแล้วปิด % ไป จะได้ไม่เปลี่ยนพฤติกรรมโดยไม่บอก
        if (!('sellAtPct' in old)) {
          if (old.sellAtCount === undefined || old.sellAtCount === 40) { c.sellAtCount = 0; c.sellAtPct = 80; }
          else c.sellAtPct = 0;
        }
        // ย้ายค่าเก่า adaptUse → statWin (หน้าต่างสถิติ)
        if ('adaptUse' in old && !('statWin' in old)) c.statWin = old.adaptUse;
        // (ลบ migration เก่าที่บังคับเพิ่ม legendary ให้ excludeRarities=['mythic'] ออกแล้ว —
        //  มันเขียนทับค่าที่ผู้ใช้ตั้งเองทุกครั้งที่รีโหลด = การตั้งค่า "ไม่จำ" · เคารพค่าที่ผู้ใช้ตั้งเสมอ)
        // ย้ายค่าเก่า → ระบบสถิติใหม่: perMapStats เดิม = ตัวกรองแมพตัวใหม่
        if ('perMapStats' in old && !('adaptFilterMap' in old)) c.adaptFilterMap = !!old.perMapStats;
        // v6.84: 'gameauto' ใน v6.81-6.83 เป็นค่าที่ระบบบังคับ (โหมด bot ยังพัง) ไม่ใช่ตัวเลือกผู้ใช้
        // → เอนจิน bot ใช้ได้แล้ว ย้ายให้ครั้งเดียว (หลังจากนี้ผู้ใช้เลือกเองใน UI ระบบเคารพเสมอ)
        if (!('fishModeV684' in old)) { if (old.fishMode === 'gameauto') c.fishMode = 'bot'; c.fishModeV684 = true; }
        // v6.95: testGameAuto (bool) → testMode ('bot'/'gameauto'/'both') — เปิดออโต้เกมเดิม = ทดสอบทั้งคู่
        if (!('testMode' in old)) c.testMode = old.testGameAuto ? 'both' : 'bot';
        // v6.101: testBuff (bool) → testBuffMode ('plain'/'buff'/'both') — เดิม true=ทั้งคู่ · false=ไม่ใช้ยาอย่างเดียว
        if (!('testBuffMode' in old)) c.testBuffMode = old.testBuff === false ? 'plain' : 'both';
        return c;
      }
    } catch {}
    return { ...DEFAULTS };
  }
  // 🛑 v6.128: ระหว่าง "กู้คืน backup → รอรีโหลด" ห้ามทุก save เขียน localStorage —
  //   บั๊กร้ายแรง: กู้คืนเขียนข้อมูลลงแล้ว แต่ beforeunload/pagehide flush (saveCfg/saveProfit/saveModeStats)
  //   เอาค่า "ในหน่วยความจำของเครื่องใหม่ (ว่างเปล่า)" เขียนทับก่อนหน้ารีโหลด = restore ไม่เคยติดเลย
  let restoring = false;
  function saveCfg() {
    if (restoring) return;
    try { W.localStorage.setItem(CFG_KEY, JSON.stringify(cfg)); } catch {}
  }

  // ===== คำนวณกำไรแบบ "ต่อชิ้น" (ไม่มีแบทช์แล้ว) =====
  // ต้นทุนคิด "ต่อเหวี่ยง" (เหวี่ยงติด = ใช้เหยื่อ 1 ชิ้น แม้ปลาหลุด/ไม่ติด) · รายได้คิด "ต่อติดปลา"
  // life = ยอดสะสมตลอด · recs = สถิติละเอียดต่อขั้นเหยื่อ · เก็บแบบมีเวอร์ชัน {v:2,...} + สำรองก่อน migrate
  const PROFIT_KEY = 'tokpla_bot_profit', PROFIT_V = 2;
  const newLife = () => ({ revenue: 0, baitCost: 0, casts: 0, catches: 0, coffeeCost: 0, potionCost: 0, floatCost: 0 });
  function loadProfit() {
    try {
      const r = W.localStorage.getItem(PROFIT_KEY);
      if (r) {
        const box = JSON.parse(r);           // v2 = {v,life,recs} · โครงเก่าไม่มี v แต่ life/recs อยู่ root เหมือนกัน
        const o = box || {};
        if (o.life) {
          const L = o.life, life = newLife();
          for (const k of Object.keys(life)) if (typeof L[k] === 'number') life[k] = L[k];
          // ข้อมูลก่อน v2: casts เดิมนับเฉพาะตอนอ่านผล (จริงๆ คือ catches) — ย้ายให้ตรงความหมายใหม่
          if (typeof L.catches !== 'number') life.catches = life.casts;
          let recs = o.recs || {};
          if (!o.recs && o.byBait) for (const [t, s] of Object.entries(o.byBait)) if (Array.isArray(s?.catches) && s.catches.length) recs[t] = s.catches;  // migrate ของเก่ามาก
          if (box.v !== PROFIT_V) { try { W.localStorage.setItem(PROFIT_KEY + '_bak', r); } catch {} }   // สำรองข้อมูลเดิมครั้งเดียวก่อนเขียนทับโครงใหม่
          return { life, recs };
        }
      }
    } catch {}
    return { life: newLife(), recs: {} };
  }
  let profit = loadProfit();
  function saveProfit() { if (restoring) return; try { W.localStorage.setItem(PROFIT_KEY, JSON.stringify({ v: PROFIT_V, life: profit.life, recs: profit.recs })); } catch {} }

  // 🎣 โหมดตกปลาที่ "มีผลจริง" — ระหว่างทดสอบเหยื่อบังคับเป็น 'bot' เสมอ (เทสต์ต้องเหวี่ยง+เล่นมินิเกมเอง
  // ไม่งั้นตั้ง gameauto/off ไว้แล้วกดทดสอบ = ค้างตลอด เพราะสาขา idle จะ return ก่อนถึงการเหวี่ยงของเทสต์)
  // ใช้ตัวนี้กับทุกจุดที่เป็น "พฤติกรรมการตก/บันทึกสถิติ" · ส่วน UI/badge ใช้ cfg.fishMode ตรงๆ ได้
  const fishModeEff = () => (testRunning ? ((test && test.mode) || 'bot') : cfg.fishMode);
  // 🧪 โหมดที่จะทดสอบ (ตาม cfg.testMode) — 'both'=บอท+ออโต้เกม · อื่นๆ=โหมดเดียว
  const testModesArr = () => cfg.testMode === 'both' ? ['bot', 'gameauto'] : cfg.testMode === 'gameauto' ? ['gameauto'] : ['bot'];

  // ===== 📊 ระบบสถิติใหม่: บันทึก "ต่อการตก 1 ครั้ง" แยกตามชนิดเหยื่อ (ring buffer ล่าสุด statKeep รายการ) =====
  // แต่ละรายการ: ปลา/ระดับ/ราคาขาย/เวลา/แมพ/สถานะยา — กำไรต่อครั้ง = ราคาขาย − ราคาเหยื่อ/ชิ้น (คำนวณตอนอ่าน)
  // นับ "มูลค่าปลาที่ตกได้จริง" ไม่ว่าจะขายหรือล็อก = ไม่ bias · ไม่มีแนวคิด window ต่อขั้น/แบทช์สถิติอีกต่อไป
  const baitUnit = (t) => BAIT_TIERS[t - 1]?.unit ?? 0;   // ราคาเหยื่อต่อชิ้นของขั้นนั้น
  // Throttle save: ตกไว (~500/ชม.) เขียน localStorage ทุกครั้งเปลืองไป · เว้น ≥3วิ/ครั้ง
  let lastCatchSaveAt = 0;
  // คืน { tier, weight, luck } = สถานะจริงตอนบันทึกตัวนี้ (ให้ตัวนับทดสอบใช้ค่าเดียวกัน · null = ไม่ได้บันทึก)
  function pushCatch(c) {
    if (!c || (!c.junk && !c.price)) return null;    // ปลาที่อ่านราคาไม่ออก = ข้าม · ขยะ = เก็บ (กินเหยื่อ 1 ชิ้นเหมือนกัน)
    // ผูกกับเหยื่อที่ใส่อยู่จริง (อ่านจาก DOM) · อ่านไม่ได้ → ใช้ค่าปัจจุบันสด cfg.baitTier
    // สำคัญ: ตอนโชว์ผลปลา (result) เกม unmount ปุ่มเหยื่อ → currentBait() อ่านไม่ได้
    // จึงใช้ castTier (จับไว้ตอนเหวี่ยง ปุ่มยังอยู่) เป็นหลัก — ผูกต้นทุน+รายได้ของการเหวี่ยงเดียวกัน
    let tier = castTier || currentBait()?.tier || lastKnownBaitTier || cfg.baitTier;
    if (!tier) return null;                    // อ่านเหยื่อไม่ได้จริงๆ ค่อยข้าม
    const buffs = readBuffs();                 // สถานะยาตอนตกตัวนี้ (🐋 น้ำหนัก / 🍀 โชค) — อ่านครั้งเดียว ใช้ทั้งบันทึก+นับ
    const rec = { fish: c.name, rarity: c.rarity, price: c.price || 0, shiny: !!c.shiny, junk: c.junk || undefined, at: Date.now(),
                  map: curMap || undefined, bw: buffs.weight || undefined, bl: buffs.luck || undefined,
                  sc: (typeof c.score === 'number' ? c.score : undefined),    // คะแนนมินิเกม — ไว้วิเคราะห์คุณภาพเล็งย้อนหลัง
                  md: (fishModeEff() || '').charAt(0) || undefined,           // โหมดที่ตกตัวนี้ (b=บอท · g=เกมออโต้) — ไว้กรองแยกโหมด
                  w: (typeof c.weight === 'number' && c.weight > 0 ? +c.weight.toFixed(2) : undefined) };   // น้ำหนักปลา (กก.) — ไว้วัด uplift ยา 🐋 ตรงๆ (แม่นกว่าเทียบราคาเพราะไม่โดน rarity ปน)
    const list = (profit.recs[tier] ||= []);
    list.push(rec);
    const cap = Math.max(30, cfg.statKeep || 200);
    if (list.length > cap) list.splice(0, list.length - cap);   // ring buffer: เก็บเฉพาะ N รายการล่าสุด
    mythicBaitOnCatch(tier, c.rarity, c.price);   // 🌈 ปลาเทพเข้าสถิติออโต้เลือกเหยื่อ (ข้างในกรองเฉพาะ legendary/mythic)
    // ฝั่ง "ติดปลา": รายได้ +ราคาปลา · catches +1  (ต้นทุนเหยื่อ/casts คิดไปแล้วตอนเหวี่ยงติด — ดู pushCastCost)
    profit.life.revenue += c.price || 0;
    profit.life.catches += 1;
    sessRev += c.price || 0; sessCatches += 1;
    feedModeStats(fishModeEff(), { price: c.price || 0, baitCost: baitUnit(tier), weight: +c.weight || 0, rarity: c.rarity, junk: c.junk, tier });   // 🔬 สถิติ 2 แบบ
    // 📋 log สรุปทุกขั้นตอนของปลาตัวนี้ (โหมด bot — v6.88 เคยหายไปเพราะย้าย log เข้า recordGameCatch ที่โหมด bot ไม่เรียก)
    fishSeq++;
    logInfo(`🎣 #${fishSeq} ${c.name}(${c.rarity || '?'})${typeof c.weight === 'number' ? ` ${c.weight}กก` : ''} ${c.price ? c.price.toLocaleString() + '🪙' : (c.junk ? 'ขยะ' : 'ล็อก')}${typeof c.score === 'number' ? ` ${c.score}/100` : ''} | ${traceSummary()}`);
    fishTrace = null;
    // Persist ทุก ≥3 วิ · รีโหลดกลางคัน อย่างแย่หาย ~1-2 รายการล่าสุด
    if (Date.now() - lastCatchSaveAt >= 3000) { lastCatchSaveAt = Date.now(); saveProfit(); }
    return { tier, weight: buffs.weight, luck: buffs.luck };
  }
  // ฝั่ง "เหวี่ยง": เรียกเมื่อกดตกปลาแล้วเกมขยับจริง (คาสต์เข้าน้ำ = ใช้เหยื่อ 1 ชิ้น แม้ปลาหลุด/ไม่ติด)
  // แยกจาก pushCatch — ไม่งั้น casts=catches เสมอ และเหวี่ยงพลาดไม่ถูกคิดต้นทุน (กำไรสูงเกินจริง)
  function pushCastCost() {
    const tier = currentBait()?.tier || lastKnownBaitTier || cfg.baitTier;
    if (!tier) return;
    castTier = tier;   // จำขั้นของ "การเหวี่ยงนี้" ไว้ให้ pushCatch ใช้ตอนผลปลาโชว์ (ปุ่มเหยื่อหายไปแล้ว)
    mythicBaitOnCast(tier);   // 🌈 นับตัวอย่างให้ระบบออโต้เลือกเหยื่อล่าปลาเทพ (นับทุกโหมด — ข้อมูลสะสมเร็วกว่า)
    profit.life.baitCost += baitUnit(tier);
    profit.life.casts += 1;
    sessBait += baitUnit(tier);
    if (Date.now() - lastCatchSaveAt >= 3000) { lastCatchSaveAt = Date.now(); saveProfit(); }
  }
  // 📈 สถิติเฉพาะเซสชันนี้ (รีเซ็ตตอนเปิดบอท) — "รอบนี้ทำได้เท่าไหร่" แยกจากยอดสะสม
  let sessRev = 0, sessBait = 0, sessCatches = 0;
  let castTier = 0;   // ขั้นเหยื่อของการเหวี่ยงล่าสุด (จับตอนเหวี่ยง ใช้ตอนบันทึกปลา — ปุ่มเหยื่อ unmount ตอน result)
  const sessNet = () => sessRev - sessBait;
  const profPct = (cost, rev) => (cost > 0 ? (rev - cost) / cost * 100 : null);
  const signed = (n) => (n >= 0 ? '+' : '') + Math.round(n).toLocaleString();

  // ===== 📊 สถิติต่อชนิดเหยื่อจาก recs (ตัวกรอง: แมพ/ยา/ระดับปลา + ใช้ N รายการล่าสุด) =====
  // คืน null ถ้าข้อมูลหลังกรอง < minN (ไม่พอเชื่อได้) — กำไร/ครั้ง = เฉลี่ย(ราคาขาย − ราคาเหยื่อ/ชิ้น)
  const ADAPT_MIN_N = 30;   // ขั้นต่ำที่ยอมตัดสินใจ
  // keepRarity=true → ไม่ตัด mythic/legendary (ใช้ตอนเช็ค "กำไร/ขาดทุนจริง" — ตัวแพงคือรายได้จริง)
  function recFilter(list, useN, keepRarity = false) {
    const exSpec = excludeSet();
    let f = list;
    if (cfg.adaptFilterMap && curMap) f = f.filter((c) => c.map === curMap);
    if (cfg.adaptFilterBuff) {
      const b = readBuffs();
      f = f.filter((c) => !!c.bw === !!b.weight && !!c.bl === !!b.luck);   // สถานะยาตรงกับตอนนี้เท่านั้น
    }
    f = keepRarity ? f.filter((c) => c && !exSpec.has(c.fish))             // นับทุก rarity (ตัดเฉพาะชนิดที่ผู้ใช้ยกเว้น)
                   : f.filter((c) => catchPassesFilter(c, exSpec));
    return useN > 0 && f.length > useN ? f.slice(-useN) : f;
  }
  function recStat(tier, useN, minN = ADAPT_MIN_N, keepRarity = false) {
    const f = recFilter(profit.recs[tier] || [], useN, keepRarity);
    if (f.length < minN) return null;
    const unit = baitUnit(tier);
    const revenue = f.reduce((a, c) => a + (c.price || 0), 0);
    const pf = revenue - f.length * unit;
    const mins = activeMins(f);
    const rare = f.filter((c) => ['rare', 'epic', 'legendary', 'mythic'].includes(c.rarity)).length;
    // % แยกรายระดับ (rare/epic/legendary/mythic) — รวมเป็นก้อนเดียวมองไม่เห็นว่าขั้นไหนดึงตัวแพงจริง
    const pctOf = (rar) => f.filter((c) => c.rarity === rar).length / f.length * 100;
    return { tier, unit, n: f.length, revenue, pf,
             pfCast: pf / f.length, revCast: revenue / f.length,
             pfHr: mins > 0 ? pf / (mins / 60) : null, mins,
             rarePct: rare / f.length * 100,
             byR: { rare: pctOf('rare'), epic: pctOf('epic'), legendary: pctOf('legendary'), mythic: pctOf('mythic') },
             total: (profit.recs[tier] || []).length };
  }


  function profitLines() {
    const l = profit.life;
    const lpf = l.revenue - l.baitCost, lpp = profPct(l.baitCost, l.revenue);   // กำไร(ปลา−เหยื่อต่อชิ้น) + %
    const rows = baitStats();
    let bestLine = '';
    if (curMap) bestLine += `\n🗺️ แมพ: ${curMap}${cfg.adaptFilterMap ? ' (สถิติกรองแมพนี้)' : ''}`;
    if (rows.length) {
      const byCast = [...rows].sort((a, b) => b.pfCast - a.pfCast)[0];
      const byHour = [...rows].filter((r) => r.pfHr != null).sort((a, b) => b.pfHr - a.pfHr)[0];
      if (byCast) bestLine += `\n💰 กำไร/ครั้งสุด: ขั้น ${byCast.tier} ${byCast.name} — ${signed(byCast.pfCast)}/ครั้ง [${byCast.n}]`;
      if (byHour) bestLine += `\n⏱️ กำไร/ชม.สุด: ขั้น ${byHour.tier} ${byHour.name} — ${signed(byHour.pfHr)} 🪙/ชม.`;
    }
    const lCoffee = l.coffeeCost || 0, lPotion = l.potionCost || 0, lFloat = l.floatCost || 0;
    const lNet = lpf - lCoffee - lPotion - lFloat;   // กำไรสุทธิสะสม = กำไรปลา−เหยื่อ − กาแฟ − ยา − ลงทุนทุ่น
    const extra = [];
    if (lCoffee > 0) extra.push(`☕${lCoffee.toLocaleString()}`);
    if (lPotion > 0) extra.push(`🧪${lPotion.toLocaleString()}`);
    if (lFloat > 0) extra.push(`🛟${lFloat.toLocaleString()}`);
    const coffeeLine = extra.length ? `\nหักต้นทุน ${extra.join(' + ')} 🪙 → กำไรสุทธิ ${signed(lNet)} 🪙` : '';
    return `สะสม: เหวี่ยง ${l.casts.toLocaleString()} · ติดปลา ${(l.catches || 0).toLocaleString()} · ทุนเหยื่อ ${l.baitCost.toLocaleString()} · มูลค่าปลา ${l.revenue.toLocaleString()} 🪙
`
         + `  กำไร ${signed(lpf)} 🪙${lpp != null ? ` (${signed(lpp)}%)` : ''}`
         + coffeeLine
         + gaugeLine()
         + bestLine;
  }
  function refreshProfit() { refreshStatsPanel?.(); }   // อัปเดตแท็บสถิติ (session + สะสม + ตาราง)

  // ===== สถิติกำไรแยกตามขั้นเหยื่อ — ตอบว่าเหยื่อไหนทำเงิน/กำไรดีสุด =====
  // ---- Filter: catch ผ่านเงื่อนไข exclude ไหม (rarity/species) ----
  let _exRaw = null, _exSet = new Set();
  function excludeSet() {   // memoize: parse ใหม่เฉพาะตอนสตริงเปลี่ยน (เรียกหลายจุดใน hot path)
    if (cfg.excludeSpecies !== _exRaw) {
      _exRaw = cfg.excludeSpecies;
      _exSet = new Set(String(cfg.excludeSpecies || '').split(',').map((x) => x.trim()).filter(Boolean));
    }
    return _exSet;
  }
  function catchPassesFilter(c, exSpec) {
    if (!c) return false;
    if (Array.isArray(cfg.excludeRarities) && cfg.excludeRarities.includes(c.rarity)) return false;
    if (exSpec.has(c.fish)) return false;
    return true;
  }

  // เวลา "ตกจริง" จากรายการ catches: รวม gap ระหว่างตัวติดกัน cap ช่องละ 2 นาที (นาที)
  function activeMins(list) {
    let ms = 0;
    for (let i = 1; i < list.length; i++) {
      const gap = (list[i].at || 0) - (list[i - 1].at || 0);
      if (gap > 0) ms += Math.min(gap, 120000);
    }
    return ms / 60000;
  }

  // ---- baitStats (โชว์สถิติ): แถวต่อขั้นเหยื่อจาก recs — ตัวกรอง statWin/แมพ/ยา ----
  function baitStats() {
    const rows = [];
    for (const tier of Object.keys(profit.recs || {})) {
      const r = recStat(+tier, cfg.statWin || 100, 1);   // minN=1: โชว์ทุกขั้นที่มีข้อมูล
      if (r) rows.push({ ...r, name: BAIT_TIERS[r.tier - 1]?.name ?? `ขั้น ${r.tier}` });
    }
    return rows;
  }
  // ---- statRows: แถวต่อขั้นเหยื่อ สำหรับตาราง UI — กรอง buff แบบ "ระบุชัด" (ไม่อิง cfg.adaptFilterBuff) ----
  // buffMode: 'all' = ไม่สนใจยา · 'buff' = เฉพาะรายการที่ใช้ยาทั้ง 2 (🐋+🍀) · 'plain' = เฉพาะรายการที่ไม่ใช้ยาเลย
  // ใช้ตัวกรองแมพ + exclude + statWin เดียวกับสถิติหลัก เพื่อให้ตัวเลข 3 ตารางเทียบกันได้ตรง
  function statRows(buffMode = 'all') {
    const exSpec = excludeSet();
    const win = cfg.statWin || 100;
    const rows = [];
    for (const tier of Object.keys(profit.recs || {})) {
      const t = +tier;
      let arr = profit.recs[t] || [];
      if (cfg.adaptFilterMap && curMap) arr = arr.filter((c) => c.map === curMap);
      if (buffMode === 'buff') arr = arr.filter((c) => c.bw && c.bl);
      else if (buffMode === 'plain') arr = arr.filter((c) => !c.bw && !c.bl);
      arr = arr.filter((c) => catchPassesFilter(c, exSpec));
      if (arr.length > win) arr = arr.slice(-win);
      const n = arr.length;
      if (!n) continue;
      const unit = baitUnit(t);
      const revenue = arr.reduce((a, c) => a + (c.price || 0), 0);
      const mins = activeMins(arr);
      const pf = revenue - n * unit;
      const scArr = arr.filter((c) => typeof c.sc === 'number');
      const pctOf = (rar) => arr.filter((c) => c.rarity === rar).length / n * 100;
      rows.push({
        tier: t, name: BAIT_TIERS[t - 1]?.name ?? `ขั้น ${t}`, n, unit,
        pfCast: pf / n, revCast: revenue / n, pfHr: mins > 0 ? pf / (mins / 60) : null,
        avgScore: scArr.length ? scArr.reduce((a, c) => a + c.sc, 0) / scArr.length : null,
        byR: { rare: pctOf('rare'), epic: pctOf('epic'), legendary: pctOf('legendary'), mythic: pctOf('mythic') },
      });
    }
    return rows.sort((a, b) => b.pfCast - a.pfCast);
  }

  // rankBy: 'money' | 'hour' | 'cast' (กำไร/ครั้ง — ตัวชี้ขาดของระบบใหม่)
  function baitStatsLines(rankBy = 'cast') {
    const rows = baitStats();
    if (!rows.length) return 'ยังไม่มีข้อมูลกำไรต่อเหยื่อ — เริ่มตกปลาก่อน (บอทจะบันทึกทุกครั้งที่ตกอัตโนมัติ)';
    const byMoney = [...rows].sort((a, b) => b.pf - a.pf);
    const byHour = [...rows].filter((r) => r.pfHr != null).sort((a, b) => b.pfHr - a.pfHr);
    const byCast = [...rows].sort((a, b) => b.pfCast - a.pfCast);
    const rnd = (v) => v == null ? '-' : signed(v);
    const filt = [];
    if (cfg.adaptFilterMap && curMap) filt.push(`แมพ:${curMap}`);
    if (cfg.adaptFilterBuff) filt.push('ยาตรงสถานะ');
    if (cfg.excludeRarities?.length) filt.push(`ยกเว้น:${cfg.excludeRarities.join(',')}`);
    if (cfg.excludeSpecies) filt.push(cfg.excludeSpecies);
    const filtNote = filt.length ? `\n<i>ตัวกรอง: ${esc(filt.join(' · '))} · ใช้ ${cfg.statWin || 100} รายการล่าสุด</i>` : '';
    const head =
      (byCast[0] ? `💰 กำไร/ครั้งสุด: ขั้น ${byCast[0].tier} ${byCast[0].name} — ทุน ${byCast[0].unit}/ชิ้น รายได้ ${Math.round(byCast[0].revCast)}/ครั้ง = ${rnd(byCast[0].pfCast)}/ครั้ง [${byCast[0].n} รายการ]\n` : '')
      + (byHour[0] ? `⏱️ กำไร/ชม.สุด: ขั้น ${byHour[0].tier} ${byHour[0].name} — ${rnd(byHour[0].pfHr)} 🪙/ชม.\n` : '')
      + `🏆 ทำเงินรวมสุด: ขั้น ${byMoney[0].tier} ${byMoney[0].name} — ${rnd(byMoney[0].pf)} 🪙${filtNote}`;
    const ordered = rankBy === 'money' ? byMoney
                  : rankBy === 'hour' || rankBy === 'hr' ? byHour
                  : byCast;
    const body = ordered.map((r, i) =>
      `${i + 1}. ขั้น ${r.tier} ${r.name} [${r.n}/${r.total} รายการ]\n`
      + `   💰 ทุน ${r.unit}/ชิ้น · รายได้ ${Math.round(r.revCast)}/ครั้ง = ${rnd(r.pfCast)}/ครั้ง\n`
      + `   ⏱ ${rnd(r.pfHr)} 🪙/ชม. · แรร์+ ${r.rarePct.toFixed(0)}% (💙${r.byR.rare.toFixed(0)} 💜${r.byR.epic.toFixed(0)} 🏅${r.byR.legendary.toFixed(0)} 🌈${r.byR.mythic.toFixed(0)})`
    ).join('\n');
    return `${head}\n${body}`;
  }

  // ===== 🗺️ ตรวจจับแมพปัจจุบัน + สถิติกำไรแยกตามแมพ =====
  // เกมโชว์ chip "📍 <ชื่อแมพ> · <ช่วงเวลา>" ใน HUD ตลอด (tk-chip-dark) — อ่านชื่อแมพจากตรงนี้
  const MAP_NAMES = ['บ่อตกปลา', 'ลำธารผาทราย', 'หมู่บ้านน้ำแข็ง', 'บึงบัวน้ำใส', 'ท่าเรือทะเล'];
  // รับ chips ที่สแกนมาแล้วได้ (กัน query ซ้ำ) — ถ้าไม่ส่งมาค่อยสแกนเอง
  function scanMap(chips) {
    for (const c of (chips || document.querySelectorAll('[class*="tk-chip-dark"]'))) {
      const t = (c.textContent || '').trim();
      if (t.startsWith('📍')) return t.replace(/^📍\s*/, '').split('·')[0].trim() || null;
    }
    return null;
  }
  // รวม catches ทุกขั้นเหยื่อ แล้วจัดกลุ่มตามแมพ — ตอบว่า "แมพไหนทำกำไร/ชม.เยอะสุด"
  function mapStats() {
    const exSpec = excludeSet();
    const byMap = {};
    for (const [tier, list] of Object.entries(profit.recs || {})) {
      const unit = baitUnit(+tier);
      for (const c of (list || [])) {
        if (!catchPassesFilter(c, exSpec)) continue;
        const m = c.map || '(ไม่ทราบแมพ)';
        const g = (byMap[m] ||= { casts: 0, revenue: 0, baitCost: 0, rare: 0, list: [] });
        g.casts++; g.revenue += c.price || 0; g.baitCost += unit;
        g.list.push(c);
        if (['rare', 'epic', 'legendary', 'mythic'].includes(c.rarity)) g.rare++;
      }
    }
    const rows = [];
    for (const [m, g] of Object.entries(byMap)) {
      const pf = g.revenue - g.baitCost;
      g.list.sort((a, b) => (a.at || 0) - (b.at || 0));   // catches มาจากหลายขั้นเหยื่อ — เรียงเวลาก่อนคิด gap
      const mins = activeMins(g.list);                     // เวลาตกจริง (ไม่นับช่วงหายไปแมพอื่น/ออฟไลน์)
      rows.push({ map: m, casts: g.casts, revenue: g.revenue, pf,
                  profitPerHour: mins > 0 ? pf / (mins / 60) : null,
                  profitPerCast: g.casts > 0 ? pf / g.casts : null,
                  rarePct: g.casts > 0 ? g.rare / g.casts * 100 : 0 });
    }
    return rows.sort((a, b) => (b.profitPerHour ?? -Infinity) - (a.profitPerHour ?? -Infinity));
  }
  function mapStatsLines() {
    const rows = mapStats();
    if (!rows.length) return 'ยังไม่มีข้อมูลแยกตามแมพ — ตกปลาก่อน (บอทจะ tag แมพให้อัตโนมัติ)';
    const head = `🗺️ <b>เทียบกำไรตามแมพ</b>${curMap ? ` (ตอนนี้: ${esc(curMap)})` : ''}`;
    const body = rows.map((r, i) =>
      `${i + 1}. ${esc(r.map)}${r.map === curMap ? ' ◀' : ''} — ${r.profitPerHour != null ? signed(r.profitPerHour) : '-'} 🪙/ชม.\n`
      + `   ${signed(r.profitPerCast)}/ครั้ง · ${r.casts} ตัว · แรร์+ ${r.rarePct.toFixed(0)}%`
    ).join('\n');
    return `${head}\n${body}`;
  }
  // ส่งออกสถิติ (JSON) — ปลอดภัยส่งให้ AI/ผู้พัฒนาวิเคราะห์: มีสรุป+ข้อมูลดิบ recs · ไม่มี token/ข้อมูลลับ
  // includeRaw=false → ตัด recs ดิบออก (ไฟล์เล็ก เหมาะ paste ในแชท) · true → แนบ recs ครบ (วิเคราะห์ลึก)
  function statsExport(includeRaw = true) {
    const bs = baitStats().map((r) => ({
      tier: r.tier, name: r.name, n: r.n, total: r.total, unit: r.unit,
      pfCast: Math.round(r.pfCast), revCast: Math.round(r.revCast),
      pfHr: r.pfHr != null ? Math.round(r.pfHr) : null, mins: Math.round(r.mins || 0),
      rarePct: +(r.rarePct || 0).toFixed(1),
      byRarity: { rare: +r.byR.rare.toFixed(1), epic: +r.byR.epic.toFixed(1), legendary: +r.byR.legendary.toFixed(1), mythic: +r.byR.mythic.toFixed(1) },
    }));
    const ms = mapStats().map((m) => ({ map: m.map, casts: m.casts, pfHr: m.profitPerHour != null ? Math.round(m.profitPerHour) : null, pfCast: m.profitPerCast != null ? Math.round(m.profitPerCast) : null, rarePct: +(m.rarePct || 0).toFixed(1) }));
    const recCounts = Object.fromEntries(Object.keys(profit.recs || {}).map((t) => [t, (profit.recs[t] || []).length]));
    const out = {
      app: 'tokpla-bot-stats', ver: BOT_VER, ts: Date.now(), curMap: curMap || null,
      filters: { statWin: cfg.statWin, statKeep: cfg.statKeep, filterMap: cfg.adaptFilterMap, filterBuff: cfg.adaptFilterBuff, excludeRarities: cfg.excludeRarities, excludeSpecies: cfg.excludeSpecies },
      life: profit.life,                 // ยอดสะสม (รายได้/ทุนเหยื่อต่อชิ้น/เหวี่ยง/ติดปลา/กาแฟ/ยา/ทุ่น)
      lifeNet: lifeNet(),
      baitStats: bs, mapStats: ms, recCounts,
      modeStats,                         // 🔬 สถิติ 2 แบบ (บอทตกเอง vs เกมออโต้) — ไว้เปรียบเทียบ/วิเคราะห์
    };
    if (includeRaw) out.recs = profit.recs;   // ข้อมูลดิบต่อการตก (ปลา/ราคา/เวลา/แมพ/ยา/คะแนน) — ไม่มีข้อมูลลับ
    return JSON.stringify(out, null, includeRaw ? 0 : 1);
  }

  // ===== 📝 ระบบ Log (ring buffer + persist) — ไว้คัดลอกส่งให้ AI/ผู้พัฒนาเวลามีปัญหา =====
  // เก็บล่าสุด LOG_KEEP บรรทัด · persist ลง localStorage (throttle 4 วิ · error เซฟทันทีกันหายตอน crash/reload)
  const LOG_KEY = 'tokpla_bot_log', LOG_KEEP = 300;
  let logRing = [];
  let lastLogSave = 0;
  try { const a = JSON.parse(W.localStorage.getItem(LOG_KEY) || '[]'); if (Array.isArray(a)) logRing = a.slice(-LOG_KEEP); } catch {}
  function saveLog(force) {
    const t = Date.now();
    if (!force && t - lastLogSave < 4000) return;
    lastLogSave = t;
    try { W.localStorage.setItem(LOG_KEY, JSON.stringify(logRing.slice(-LOG_KEEP))); } catch {}
  }
  function logPush(lv, msg) {
    logRing.push({ at: Date.now(), lv, m: String(msg) });
    if (logRing.length > LOG_KEEP) logRing.splice(0, logRing.length - LOG_KEEP);
    saveLog(lv === 'error');
    refreshLogView?.();
  }
  const hhmmss = (ts) => { const d = new Date(ts), p = (n) => String(n).padStart(2, '0'); return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`; };
  function logInfo(msg) { logPush('info', msg); console.log('[Tokpla Bot]', msg); }
  function logWarn(msg) { logPush('warn', msg); console.warn('[Tokpla Bot]', msg); }
  function logErr(msg, e) { const full = e !== undefined ? `${msg}: ${e?.message || e}` : String(msg); logPush('error', full); console.error('[Tokpla Bot]', full); }
  let logViewEl = null;
  function refreshLogView() {
    if (!logViewEl) return;
    const stick = logViewEl.scrollTop + logViewEl.clientHeight >= logViewEl.scrollHeight - 30;   // เกาะล่างสุดไหม
    logViewEl.value = logRing.slice(-80).map((e) => `${hhmmss(e.at)} ${e.lv[0].toUpperCase()} ${e.m}`).join('\n');
    if (stick) logViewEl.scrollTop = logViewEl.scrollHeight;   // ตามล่าสุด (เว้นแต่ผู้ใช้เลื่อนขึ้นดูเอง)
  }

  // สร้าง "รายงานปัญหา" — รวมสถานะ + config (ตัด token) + สรุปสถิติ + log ล่าสุด → ให้ผู้ใช้คัดลอกส่ง
  function diagReport(logLines = 80) {
    const safe = (fn, fb = '?') => { try { const v = fn(); return v == null ? fb : v; } catch { return fb; } };
    const L = profit.life, out = [];
    out.push('===== 🎣 Tokpla Bot — รายงานปัญหา =====');
    out.push(`เวอร์ชัน: ${BOT_VER} · เวลา: ${new Date().toLocaleString('th-TH')}`);
    out.push(`หน้า: ${safe(() => W.location.pathname)} · GM: ${hasGM ? 'มี' : 'ไม่มี (วางใน console?)'}`);
    out.push(`บอท: ${enabled ? 'เปิด' : 'ปิด'}${paused ? ' · พักชั่วคราว' : ''}${testRunning ? ' · กำลังทดสอบ' : ''} · busy=${busy} orch=${orchestrating}`);
    out.push(`สถานะเกม: ${safe(() => gameState())} · แมพ: ${curMap || '?'} · พลัง: ${safe(() => energyPct())}%`);
    const b = safe(() => currentBait(), null);
    out.push(`เหยื่อที่ใส่(อ่านได้): ขั้น ${b?.tier ?? 'อ่านไม่ได้'} เหลือ ${b?.stock ?? '?'} · รู้ล่าสุด=${lastKnownBaitTier || '-'} · cfg.baitTier=${cfg.baitTier} · เบ็ด ${safe(() => currentRod())} · เพดาน=${baitCeil}`);
    if (b?.tier == null) { const bb = safe(() => baitButton(), null); if (bb) out.push('⚠️ ปุ่มเหยื่อ HTML: ' + String(bb.outerHTML || '').replace(/\s+/g, ' ').slice(0, 300)); }
    const bf = safe(() => readBuffs(), {});
    out.push(`บัฟ: 🐋${bf.weight ? '✓' : '✗'} 🍀${bf.luck ? '✓' : '✗'} · ปิดชั่วคราว: ${sessionOff.size ? [...sessionOff].join(',') : '-'}`);
    out.push(`เซสชันนี้: เหวี่ยง ${casts} · ติดปลา ${sessCatches} · กำไร ${signed(sessNet())} 🪙`);
    out.push(`Advisor: ${cfg.advisor ? (cfg.advisorAuto ? 'ลงมือเอง' : 'แนะนำ') : 'ปิด'}${lastAdvice ? ` · ล่าสุด: ขั้น ${lastAdvice.bestTier}${lastAdvice.urgent ? ' (ด่วน)' : ''}` : ''}`);
    out.push(`สะสม: เหวี่ยง ${L.casts} · ติดปลา ${L.catches || 0} · รายได้ ${L.revenue} · เหยื่อ ${L.baitCost} · กำไรสุทธิ ${signed(lifeNet())} 🪙`);
    out.push(`recs: ${Object.keys(profit.recs || {}).map((t) => `ขั้น${t}=${profit.recs[t].length}`).join(' ') || '(ว่าง)'}`);
    if (gaugeStat.n) out.push(`เกจ: โดนดาว ${gaugeStat.star}/${gaugeStat.n} (${Math.round(gaugeStat.star / gaugeStat.n * 100)}%) · เฉลี่ย ${(gaugeStat.sumDist / gaugeStat.n).toFixed(1)}° จากดาว · ล่าสุด ${gaugeStat.last}°`);
    if (modeStats.bot.n || modeStats.gameauto.n) { out.push('--- เทียบโหมด ---'); out.push(modeCompareText()); }
    const { tgToken, tgControlToken, tgChat, tgControlChat, ...safeCfg } = cfg;   // ตัดข้อมูลลับก่อนส่ง
    out.push('--- config (ตัด token/chat แล้ว) ---');
    out.push(JSON.stringify(safeCfg));
    const tail = logRing.slice(-logLines);
    out.push(`--- log ${tail.length} บรรทัดล่าสุด ---`);
    for (const e of tail) out.push(`${hhmmss(e.at)} ${e.lv.toUpperCase()[0]} ${e.m}`);
    return out.join('\n');
  }

  function say(msg) {
    if (statusEl) statusEl.textContent = msg || '';
    if (msg) logInfo(msg);   // ทุกข้อความสถานะเข้า log ring ด้วย (เป็น breadcrumb เวลามีปัญหา)
  }

  // ---- ปิดฟีเจอร์ชั่วคราวเฉพาะเซสชันนี้ ----
  // เดิมเวลาเจอปัญหา (เหรียญไม่พอ / เซิร์ฟเวอร์ไม่รองรับ) บอทเขียน cfg.x = false ลง localStorage
  // ผู้ใช้เปิดเบราว์เซอร์ใหม่ก็ยังปิดอยู่ โดยไม่รู้ว่าใครไปปิด — ตอนนี้เก็บไว้ในหน่วยความจำอย่างเดียว
  const sessionOff = new Set();
  const isOn = (key) => cfg[key] && !sessionOff.has(key);
  // โหมดมนุษย์: master เปิด + สวิตช์ย่อยเปิด
  // 🧪 ระหว่างทดสอบเหยื่อ: บังคับปิด "พักย่อย/พักใหญ่/จบเซสชัน" อัตโนมัติ (พักยาว >8 นาที = รอบทดสอบถูกข้าม)
  //   คืนค่าเองเมื่อ testRunning=false — ไม่แตะ cfg จึงไม่ต้องเซฟ/คืน (hReact/hCastGap ยังทำงาน = จังหวะยังสมจริง)
  //   ⚡ turbo ก็ปิด "พักย่อย/พักใหญ่/จบเซสชัน" เช่นกัน (เน้นตกไวสุด — ไม่พักระหว่างตก)
  const hOn = (key) => isOn('human') && !!cfg[key] && !((testRunning || turboEff()) && (key === 'hBreak' || key === 'hSession'));
  // ขั้นเหยื่อที่จะใช้/ซื้อ = ค่าที่ผู้ใช้ตั้ง แต่ไม่เกินเพดานที่ปลดล็อกแล้ว (baitCeil)
  // 🌈 โหมดล่าปลาเทพ override "ขั้นเหยื่อเป้าหมาย" ที่จุดอ่านกลางนี้จุดเดียว — cfg.baitTier ของผู้ใช้ไม่ถูกแตะ
  //   mythicBait 0 = ออโต้: เลือกจากสถิติปลาเทพจริงต่อขั้น (mythicAutoTier — explore→exploit) · 1-8 = ล็อกขั้น
  const targetBait = () => {
    if (mythicActive()) {
      const m = parseInt(cfg.mythicBait, 10) || 0;
      return Math.min(m > 0 ? clamp(m, 1, 8) : mythicAutoTier(), baitCeil || 8);
    }
    // 🔬 v6.207: กำลังสำรวจขั้นเหยื่อ — ใช้ขั้นที่สำรวจก่อน (ไม่แตะตอนทดสอบ กฎเหล็ก #4)
    if (exploreTier && !testRunning) return Math.min(exploreTier, baitCeil || 8);
    // 🪱 v6.193: โหมดไล่สต๊อก — ใช้ขั้นที่กำลังไล่ก่อน (override Advisor/cfg · ไม่แตะตอนทดสอบ กฎเหล็ก #4)
    if (isOn('useBaitStock') && drainTier && !testRunning) return Math.min(drainTier, baitCeil || 8);
    return Math.min(cfg.baitTier || 1, baitCeil || 8);
  };
  // ต้องบังคับให้เหยื่อที่ใส่ = เป้าหมายไหม (forceBait เปิด · Advisor โหมดลงมือเอง · โหมดล่าปลาเทพ · ไล่สต๊อก — ต้องคุมขั้นเหยื่อเอง)
  const enforceBait = () => isOn('forceBait') || (isOn('advisor') && isOn('advisorAuto')) || mythicActive() || (isOn('useBaitStock') && !!drainTier) || !!exploreTier;
  // ⚡ turbo มีผลจริงไหม — โหมดล่าปลาเทพบังคับเปิด (แรร์สุ่มต่อครั้ง → ตกถี่สุด = โอกาสมากสุด)
  const turboEff = () => isOn('turbo') || mythicActive();
  function disableForSession(key, why) {
    sessionOff.add(key);
    syncPanel();
    say(why);
    if (cfg.tgWarn && isOn('tgOn')) void tgSend(`⚠️ ${esc(why)}`);
  }

  // ================= แจ้งเตือน Telegram =================
  // เว็บนี้ตั้ง CSP ไว้ว่า  connect-src 'self' https://*.supabase.co
  // fetch() ไป api.telegram.org จึงถูกบล็อก ต้องยิงผ่าน GM_xmlhttpRequest ของ Tampermonkey
  // ซึ่งทำงานนอก sandbox ของหน้าเว็บ (ข้าม CSP และ CORS ได้)
  const hasGM = typeof GM_xmlhttpRequest !== 'undefined';
  let tgFails = 0;

  function tgApi(method, params, tokenOverride) {
    return new Promise((resolve) => {
      const token = (tokenOverride || cfg.tgToken || '').trim();
      if (!token) return resolve({ ok: false, error: 'ยังไม่ได้ใส่ Bot Token' });
      if (!hasGM) return resolve({ ok: false, error: 'ต้องรันผ่าน Tampermonkey (CSP ของเว็บบล็อกการยิงตรง)' });
      GM_xmlhttpRequest({
        method: 'POST',
        url: `https://api.telegram.org/bot${token}/${method}`,
        headers: { 'Content-Type': 'application/json' },
        data: JSON.stringify(params || {}),
        timeout: 12000,
        onload: (r) => { try { resolve(JSON.parse(r.responseText)); } catch { resolve({ ok: false, error: 'ตอบกลับไม่ใช่ JSON' }); } },
        onerror: () => resolve({ ok: false, error: 'ส่งไม่สำเร็จ (network)' }),
        ontimeout: () => resolve({ ok: false, error: 'หมดเวลา' }),
      });
    });
  }

  const esc = (t) => String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const ctrlToken = () => (cfg.tgControlToken || cfg.tgToken || '').trim();
  const ctrlChat = () => (cfg.tgControlChat || cfg.tgChat || '').trim();
  // ส่งข้อความไปห้อง/บอทที่ระบุ (ใช้กับห้องควบคุมที่แยกจากแจ้งเตือน)
  async function tgSendTo(text, token, chat) {
    const tk = (token || '').trim(), ch = (chat || '').trim();
    if (!hasGM || !tk || !ch) return;
    await tgApi('sendMessage', { chat_id: ch, text, parse_mode: 'HTML', disable_web_page_preview: true }, tk);
  }

  async function tgSend(text) {
    if (!isOn('tgOn') || !(cfg.tgChat || '').trim()) return;
    const r = await tgApi('sendMessage', {
      chat_id: cfg.tgChat.trim(), text, parse_mode: 'HTML', disable_web_page_preview: true,
    });
    if (r.ok) { tgFails = 0; return; }
    logWarn('Telegram: ' + (r.description || r.error));
    // ส่งไม่ผ่านติดกัน 3 ครั้ง = token/chat ผิด หรือเน็ตมีปัญหา — พักไว้ ไม่ให้รบกวนการตกปลา
    if (++tgFails >= 3) disableForSession('tgOn', `แจ้งเตือน Telegram ส่งไม่สำเร็จ: ${r.description || r.error}`);
  }

  // ---- รายงานสถานะบอท (heartbeat) — ไว้เช็คว่ายังรันอยู่ + ผลงานตอนนี้ ----
  function botStateLabel() {
    if (energyResting) return '⚡ นั่งพักรอพลัง';
    if (pauseUntil > now()) return '⚡ พักรอพลัง';
    if (breakUntil > now()) return `😌 ${breakLabel}`;
    // 👹/🌈 บอกโหมดพิเศษที่กำลังทำงาน (ไว้ดูสถานะระยะไกลผ่าน heartbeat — v6.131)
    if (bossPhase !== 'idle') return '👹 กำลังล่าบอส';
    if (busy || orchestrating) return '🛒 จัดการเมนู';
    if (mythicActive()) return `🌈 กำลังล่าปลาเทพ${mythicPotOff ? ' (งดยา)' : ''}`;
    return '🎣 กำลังตกปลา';
  }
  // กำไรสุทธิสะสม = รายได้ − เหยื่อ − กาแฟ − ยา − ทุ่น (หักต้นทุนครบ)
  function lifeNet() {
    const l = profit.life;
    return (l.revenue || 0) - (l.baitCost || 0) - (l.coffeeCost || 0) - (l.potionCost || 0) - (l.floatCost || 0);
  }
  function heartbeatMsg() {
    const up = Math.max(0, Math.round((now() - sessionStart) / 60000));
    const upStr = up >= 60 ? `${Math.floor(up / 60)} ชม ${up % 60} นาที` : `${up} นาที`;
    const e = energyPct();
    // v6.131: โชว์เหยื่อขั้น "จริง" ที่ใช้ตอนนี้ (targetBait รวม override โหมดล่าปลาเทพ/auto) ไม่ใช่แค่ cfg
    const bt = targetBait(), bn = BAIT_TIERS[bt - 1]?.name ?? '?';
    const myt = mythicActive();
    const baitLine = myt && !(parseInt(cfg.mythicBait, 10) > 0)
      ? `🪱 เหยื่อขั้น ${bt} (${bn}) · 🤖 auto`
      : `🪱 เหยื่อขั้น ${bt} (${bn})`;
    return `📊 <b>สถานะบอท</b>\n` +
      `${botStateLabel()} · รันมา ${upStr}\n` +
      `🎣 เหวี่ยง ${casts} · ติดปลา ${sessCatches}${earned > 0 ? ` · ขายได้ ${earned.toLocaleString()} 🪙` : ''}\n` +
      `💵 รอบนี้: กำไร ${signed(sessNet())} 🪙 (ปลา ${sessRev.toLocaleString()} − เหยื่อ ${sessBait.toLocaleString()})\n` +
      `⚡ พลัง ${e != null ? Math.round(e) + '%' : '?'} · ${baitLine}\n` +
      `📈 สะสม: กำไรสุทธิ <b>${signed(lifeNet())}</b> 🪙 (หักเหยื่อ+กาแฟ+ยา+ทุ่น)` +
      (myt ? `\n🌈 ล่าปลาเทพ: เจอเทพรอบนี้ ${mythicRoundCount()} ตัว` : '') +
      (testRunning ? `\n${esc(testStatus())}` : '');
  }
  function maybeHeartbeat() {
    if (!enabled || !isOn('tgOn') || cfg.tgHeartbeat <= 0) return;
    if (now() - lastHeartbeat < cfg.tgHeartbeat * 60000) return;
    lastHeartbeat = now();
    void tgSend(heartbeatMsg());
  }

  // ---- ควบคุมบอทผ่าน Telegram: poll getUpdates แล้วรับคำสั่งจากเจ้าของ (chat เดียว) ----
  let tgOffset = 0, tgPollInit = false, tgPolling = false;
  const TG_HELP = [
    '🎣 <b>คำสั่งบอท Tokpla</b>',
    '/status - ดูสถานะ',
    '/on /off - เปิด/ปิดบอท',
    '/pause /resume - พัก/เล่นต่อ',
    '/sell - ขายเดี๋ยวนี้',
    '/buy - ซื้อเหยื่อเดี๋ยวนี้',
    '/quest - เก็บเควสรายวัน',
    '/bait N - ตั้งเหยื่อขั้น N (1-8)',
    '/profit - สรุปกำไรสะสม (ต่อชิ้น)',
    '/baitstats [hour|money|%] - สถิติเหยื่อ (default = กำไร/ชม.)',
    '/statuse N - ตัดสินใจจากกี่รายการล่าสุด (30-500)',
    '🗺️ /maps - เทียบกำไรตามแมพ (แมพไหนคุ้มสุด)',
    '📝 /log [N] - ดู log ล่าสุด N บรรทัด · /report - รายงานปัญหาเต็ม',
    '🔬 /compare - เทียบโหมดบอท vs เกมออโต้ (ตกเยอะ/พลังงาน/แรร์) · /cmpreset - ล้าง',
    '📊 /statsexport - ส่งออกสถิติ (สรุป) ไว้ส่งวิเคราะห์',
    '🧠 /advisor - ดูคำแนะนำเหยื่อ+ยาจากสถิติจริง',
    '🧪 /testbait - ทดสอบเหยื่อใหม่ · /testcont - ทำต่อ · /teststop - หยุด · /testprog - ความคืบหน้า',
    '👹 /boss - สถานะบอส · /bosshunt - ออกล่าเดี๋ยวนี้ · /bosslog - log สู้บอส',
    '🌈 /mythic - สถานะล่าปลาเทพ · /mythic on|off · /mythic map ชื่อแมพ|auto - ล็อกแมพล่า',
    '🌍 /chat - เปิด/ปิดคุยแชทโลกผ่าน TG (พิมพ์ข้อความมาได้เลย)',
    '🌍 /w ข้อความ - ส่งเข้าแชทโลกครั้งเดียว',
    '/cfg - ดูค่าที่ตั้งไว้',
    '/get key - ดูค่า',
    '/set key value - ตั้งค่า (เช่น /set energyManage on)',
    '/help - คำสั่งทั้งหมด',
  ].join('\n');

  function settingsSummary() {
    return [
      '⚙️ <b>ค่าที่ตั้งไว้</b>',
      `เหยื่อขั้น: ${cfg.baitTier} · ซื้ออัตโนมัติ: ${cfg.autoBuy ? 'เปิด' : 'ปิด'} · บังคับใช้เหยื่อ: ${cfg.forceBait ? 'เปิด' : 'ปิด'}`,
      `ขายอัตโนมัติ: ${cfg.sell ? 'เปิด' : 'ปิด'} · ขายก่อนซื้อ: ${cfg.sellBeforeBuy ? 'เปิด' : 'ปิด'} · ขายขยะ 🗑️: ${cfg.sellJunk ? 'เปิด' : 'ปิด'}`,
      `จัดการพลัง: ${cfg.energyManage ? `เปิด (${cfg.energyRestAt}-${cfg.energyResumeAt}%)` : 'ปิด'}`,
      `โหมดมนุษย์: ${cfg.human ? 'เปิด' : 'ปิด'} · กันเด้ง: ${cfg.keepAlive ? 'เปิด' : 'ปิด'} · กู้คืน: ${cfg.autoRecover ? 'เปิด' : 'ปิด'}`,
    ].join('\n');
  }

  function tgSetConfig(args, reply) {
    const key = args[0];
    const val = args.slice(1).join(' ').trim();
    if (!key || !(key in DEFAULTS)) { reply(`ไม่มีค่า "${esc(key || '')}" · พิมพ์ /cfg ดูค่าที่มี`); return; }
    // กฎเหล็ก #4: ระหว่างทดสอบเหยื่อ ห้ามแตะ baitTier (ระบบทดสอบคุมเอง)
    if (key === 'baitTier' && testRunning) { reply('🧪 กำลังทดสอบเหยื่ออยู่ — แก้ baitTier ไม่ได้ (หยุดก่อน: /teststop)'); return; }
    const t = typeof DEFAULTS[key];
    if (t === 'boolean') cfg[key] = /^(on|true|1|เปิด|yes)$/i.test(val);
    else if (t === 'number') { const n = parseFloat(val); if (isNaN(n)) { reply('ค่าต้องเป็นตัวเลข'); return; } cfg[key] = n; }
    else if (typeof cfg[key] === 'string' || t === 'string') cfg[key] = val;
    else { reply(`ตั้งค่า "${esc(key)}" ผ่าน Telegram ไม่ได้ (ชนิดซับซ้อน)`); return; }
    sessionOff.delete(key);
    saveCfg(); syncPanel();
    reply(`✅ ${esc(key)} = <b>${esc(String(cfg[key]))}</b>`);
  }

  let pendingOff = false;   // ยืนยันก่อนปิดบอท (พิมพ์ /off สองครั้งภายใน 30 วิ)
  async function handleTgCommand(text, reply) {
    // ข้อความธรรมดา (ไม่ขึ้นต้น /) = คุยแชทโลก เมื่อเปิดโหมดบริดจ์ (คุยได้เหมือนพิมพ์ในเกม)
    if (!text.startsWith('/')) {
      if (isOn('chatBridge')) { chatEnqueue(text) ? reply('🌍 กำลังส่งเข้าแชทโลก...') : reply('ข้อความว่าง'); }
      else reply('💤 โหมดแชทปิดอยู่ — /chat เปิดคุยแชทโลก · หรือ /w <ข้อความ> ส่งครั้งเดียว');
      return;
    }
    const parts = text.split(/\s+/);
    const c = parts[0].toLowerCase().replace(/^\//, '');
    const args = parts.slice(1);
    switch (c) {
      case 'help': case 'start': reply(TG_HELP); break;
      case 'status': reply(enabled ? heartbeatMsg() : '⏹ บอทปิดอยู่ · /on เพื่อเปิด'); break;
      case 'fish': case 'rarity':   // 🏷️ v6.201: บอทเห็นปลาแต่ละชนิดเป็นระดับอะไร + จะขาย/ฝาก/แลก (ต้องเปิดกระเป๋าค้างไว้)
        reply(`<pre>${esc(fishRarityReport())}</pre>`); break;
      case 'explore': case 'สำรวจ': {   // 🔬 v6.213: ไทม์ไลน์สำรวจเหยื่อ · "clear" = ล้าง
        if ((args[0] || '').toLowerCase() === 'clear') { try { W.localStorage.removeItem(EXPLORE_EV_KEY); } catch {} reply('🔬 ล้างเหตุการณ์สำรวจแล้ว'); break; }
        const cur = exploreTier ? `\n🔬 กำลังสำรวจขั้น ${exploreTier} (เหลือ ${exploreLeft} ครั้ง)` : '';
        reply(`<pre>📋 เหตุการณ์สำรวจเหยื่อ (ใหม่→เก่า)${cur}\n\n${esc(exploreEventsText())}</pre>`); break;
      }
      case 'bossstats': case 'bossstat': {   // 📊 v6.195/6.196: ตารางรายไฟต์ (default) · "avg"=เฉลี่ย · "clear"=ล้าง
        const sub = (args[0] || '').toLowerCase();
        if (sub === 'clear') { try { W.localStorage.removeItem(BOSS_STATS_KEY); W.localStorage.removeItem(BOSS_EV_KEY); } catch {} reply('📊 ล้างสถิติ+เหตุการณ์ล่าบอสแล้ว'); break; }
        if (sub === 'avg' || sub === 'เฉลี่ย') { reply(bossStatsSummary()); break; }
        if (sub === 'ev' || sub === 'log') { reply(`<pre>${esc(bossEventsText())}</pre>`); break; }   // v6.199: ทำไมไป/ไม่ไป
        reply(`<pre>${esc(bossStatsTable())}</pre>`); break;   // <pre> = monospace จัดคอลัมน์ตรงใน Telegram
      }
      case 'on': if (!enabled) toggle(); reply('▶️ เปิดบอทแล้ว'); break;
      case 'off': case 'stop':
        if (!enabled) { reply('บอทปิดอยู่แล้ว'); break; }
        if (!pendingOff) { pendingOff = true; setTimeout(() => { pendingOff = false; }, 30000); reply('⚠️ ยืนยันปิดบอท? พิมพ์ /off อีกครั้งภายใน 30 วิ'); break; }
        pendingOff = false; toggle(); reply('⏹ ปิดบอทแล้ว'); break;
      case 'pause': if (enabled) { paused = true; updateBadge(); reply('⏸ พักชั่วคราว'); } else reply('บอทปิดอยู่'); break;
      case 'resume': if (enabled) { paused = false; updateBadge(); reply('▶️ เล่นต่อ'); } else reply('บอทปิดอยู่'); break;
      case 'sell': reply('💰 สั่งขาย...'); void runWhenIdle('ขาย', () => runSell(true)); break;
      case 'buy': reply('🪱 สั่งซื้อเหยื่อ...'); void runWhenIdle('ซื้อเหยื่อ', () => sellThenBuy(true)); break;
      case 'quest': reply('🎁 เก็บเควส...'); void runWhenIdle('รับเควส', runQuests); break;
      case 'bait': { if (testRunning) { reply('🧪 กำลังทดสอบเหยื่ออยู่ — ระบบทดสอบคุมเหยื่อเองทั้งหมด (หยุดก่อน: /teststop)'); break; } const n = parseInt(args[0], 10); if (n >= 1 && n <= 8) { cfg.baitTier = n; saveCfg(); syncPanel(); reply(`🪱 ตั้งเหยื่อขั้น ${n} (${BAIT_TIERS[n - 1].name})${isOn('advisor') && isOn('advisorAuto') ? '\n⚠️ Advisor โหมดลงมือเองเปิดอยู่ — อาจสลับกลับตามสถิติ (ปิด: /set advisorAuto off)' : ''}`); } else reply('ใช้: /bait 1-8'); break; }
      case 'profit': reply(profitLines()); break;
      case 'baitstats': case 'bs': {
        const a = (args[0] || '').toLowerCase();
        const mode = /^(pct|%|percent)$/.test(a) ? 'pct'
                   : /^(money|เงิน|\$)$/.test(a) ? 'money'
                   : 'hour';   // default = กำไร/ชม. (ตัวชี้ขาดฟาร์มเงิน)
        reply(baitStatsLines(mode)); break;
      }
      case 'maps': case 'map': reply(mapStatsLines()); break;
      case 'testbait': case 'test': reply('🧪 เริ่มทดสอบเหยื่อใหม่ทั้งหมด'); void runBaitTest(false); break;
      case 'testcont': case 'testresume': reply('🧪 ทำต่อจากความคืบหน้าเดิม'); void runBaitTest(true); break;
      case 'teststop': stopTest(); reply('🧪 หยุดทดสอบแล้ว (ทำต่อได้ด้วย /testcont)'); break;
      case 'testprog': case 'testprogress': case 'testprg': case 'prog': reply(esc(testStatus())); break;
      case 'boss': {
        const min = bossTimerMin(), map = bossMapId(), rb = raidBossState();
        reply(`👹 <b>สถานะบอส</b>\nแมพตอนนี้: ${esc(map || '?')} · เฟสล่าบอส: ${bossPhase}\n` +
          `บอสถัดไป: ${min == null ? 'อ่านไม่ได้' : min <= 0 ? 'โผล่แล้ว/ใกล้มาก!' : min < 60 ? `อีก ${min} นาที` : `อีก ${Math.floor(min/60)} ชม. ${min%60} นาที`}` +
          `${rb ? `\nบอสในฉาก: ${rb.present ? 'อยู่' : 'ยังไม่มา'}${rb.dead ? ' (ตายแล้ว)' : ''}` : ''}` +
          `\nระบบล่าบอส: ${isOn('bossHunt') ? 'เปิด' : 'ปิด'} · กราฟแมพที่รู้: ${Object.keys(loadBossGraph()).join(', ') || '(ยังไม่มี)'}`);
        break;
      }
      case 'bosslog': {
        let bl = bossFightLog;
        if (!bl.length) { try { bl = JSON.parse(W.localStorage.getItem('tokpla_boss_fightlog') || '[]'); } catch {} }
        reply(bl.length ? '👹 <b>ไทม์ไลน์บอสล่าสุด</b>\n<code>' + esc(bl.join('\n')) + '</code>' : '👹 ยังไม่มีบันทึกการสู้บอส (บอทจะเก็บให้อัตโนมัติเมื่อเจอบอส)');
        break;
      }
      case 'bosshunt': case 'huntboss': {
        if (!isOn('bossHunt')) { reply('👹 เปิดระบบล่าบอสก่อน (/set bossHunt on หรือติ๊กในแผง)'); break; }
        if (bossPhase !== 'idle' || orchestrating) { reply('👹 กำลังล่า/ทำงานอื่นอยู่'); break; }
        if (!enabled) toggle();
        reply('👹 สั่งออกล่าบอสเดี๋ยวนี้'); void runBossHunt(); break;
      }
      case 'chest': case 'chests': {   // 🎁 หีบสมบัติ — สถานะ/สั่งเก็บเดี๋ยวนี้
        const a = (args[0] || '').toLowerCase();
        if (a === 'on' || a === 'off') {
          cfg.grabChest = a === 'on'; sessionOff.delete('grabChest'); saveCfg(); syncPanel();
          reply(`🎁 เก็บหีบสมบัติ: <b>${a === 'on' ? 'เปิด' : 'ปิด'}</b>`); break;
        }
        if (a === 'now' || a === 'go') {
          if (!isOn('grabChest')) { reply('🎁 เปิดระบบเก็บหีบก่อน (/chest on)'); break; }
          if (orchestrating || busy || bossPhase !== 'idle') { reply('🎁 กำลังทำงานอื่นอยู่ ลองใหม่อีกครั้ง'); break; }
          if (chestDailyDone()) { reply('🎁 เปิดครบลิมิตวันนี้แล้ว'); break; }
          const n = findChests().length;
          if (!n) { reply('🎁 ไม่พบหีบที่ยังเปิดได้ในแมพนี้'); break; }
          lastChestCheckAt = now(); reply(`🎁 สั่งเก็บหีบเดี๋ยวนี้ (พบ ${n} ใบ)`); void runChestGrab(); break;
        }
        const open = findChests().length, done = chestDailyDone();
        reply(`🎁 <b>สถานะหีบสมบัติ</b>\nระบบ: ${isOn('grabChest') ? 'เปิด' : 'ปิด'} · เช็คทุก ${clamp(cfg.chestCheckMin || 3, 1, 120)} นาที\n` +
          `แมพตอนนี้: ${esc(bossMapId() || '?')} · หีบที่ยังเปิดได้: ${open} ใบ${done ? ' · ⛔ ครบลิมิตวันนี้' : ''}\n` +
          `<code>${esc(chestEventsText())}</code>`);
        break;
      }
      case 'mythic': case 'myth': {   // 🌈 โหมดล่าปลาเทพ — สถานะ/เปิด/ปิด
        const a = (args[0] || '').toLowerCase();
        if (a === 'on' || a === 'off') {
          cfg.mythicHunt = a === 'on'; sessionOff.delete('mythicHunt'); saveCfg(); syncPanel();
          reply(`🌈 โหมดล่าปลาเทพ: <b>${a === 'on' ? 'เปิด' : 'ปิด'}</b>${a === 'on' ? ' — เหยื่อถูกสุด+ตกถี่สุด+ยา+เลือกแมพอัตโนมัติ · กันขาดทุนด้วย no-loss gate' : ''}`);
          break;
        }
        if (a === 'map') {   // /mythic map <ชื่อแมพ> · /mythic map auto = กลับอัตโนมัติ
          const nm = args.slice(1).join(' ').trim();
          if (!nm || /^auto$/i.test(nm)) { cfg.mythicMap = ''; saveCfg(); syncPanel(); reply('🌈 แมพเป้า: <b>อัตโนมัติ (ตามสถิติ)</b>'); break; }
          const hit = MYTHIC_MAPS.find(([n]) => n.includes(nm));
          if (!hit) { reply(`🌈 ไม่รู้จักแมพ "${esc(nm)}" — เลือกได้: ${MYTHIC_MAPS.map(([n]) => n).join(' · ')} หรือ auto`); break; }
          cfg.mythicMap = hit[0]; lastMythicMoveAt = 0; saveCfg(); syncPanel();
          reply(`🌈 แมพเป้า: <b>${esc(hit[0])}</b>${mapIdOfName(hit[0]) ? ' — จะเดินไปเมื่อถึงจังหวะ' : ' — ⚠️ ยังไม่รู้เส้นทางแมพนี้ (จะเดินได้เมื่อบอทเคยไปครั้งแรก)'}`);
          break;
        }
        const since = mythicStartAt || 0;
        const lm = [];
        for (const t of Object.keys(profit.recs || {})) for (const r of (profit.recs[t] || [])) if ((r.at || 0) >= since && MYTHIC_RAR.has(r.rarity)) lm.push(r);
        const heavy = lm.reduce((m, c) => Math.max(m, c.w || 0), 0);
        const val = lm.reduce((s, c) => s + (c.price || 0), 0);
        const sc = mythicMapScores().slice(0, 3).map((s) => `· ${esc(s.map)}: ${s.lmValHr.toLocaleString()}🪙/ชม. (${s.lmN} ตัวใน ${s.hr.toFixed(1)} ชม.)`);
        // 🧠 ตารางเรียนรู้เหยื่อ: ตัวอย่าง/ปลาเทพ/คะแนน (มูลค่าเทพ/cast − ส่วนต่างราคาเหยื่อ) ต่อขั้น
        const st = mbLoad();
        const mAuto = !(parseInt(cfg.mythicBait, 10) > 0);
        const bl = Object.keys(st.tiers).sort((x, y) => x - y).map((tk) => {
          const s = st.tiers[tk], scv = mbScore(s, +tk);
          const phase = s.c < MB_MIN_SAMPLE ? `สำรวจ ${s.c}/${MB_MIN_SAMPLE}` : `คะแนน ${scv == null ? '-' : scv.toFixed(1)}`;
          return `· ขั้น ${tk}: ${s.c} ครั้ง · เทพ ${s.mn} ตัว (${s.c ? (s.mv / s.c).toFixed(1) : 0}🪙/cast) · ${phase}${+tk === st.cur && mAuto ? ' ← ใช้อยู่' : ''}`;
        });
        reply(`🌈 <b>ล่าปลาเทพ</b> ${mythicActive() ? (mythicPotOff ? 'กำลังล่า (งดยา — กำไรเพิ่งติดลบ)' : 'กำลังล่า') : isOn('mythicHunt') ? 'เปิดไว้ (รอ — อาจติดทดสอบ/พักชั่วคราว)' : 'ปิด'}\n` +
          `${since ? `รอบนี้: เจอปลาเทพ ${lm.length} ตัว · มูลค่า ${val.toLocaleString()}🪙 · หนักสุด ${heavy} กก\n` : ''}` +
          `เหยื่อ: ${mAuto ? `🤖 ออโต้ → ขั้น ${st.cur || '?'} (เหลือ ${st.left} cast ในรอบนี้)` : `ล็อกขั้น ${parseInt(cfg.mythicBait, 10)}`}\n${bl.join('\n') || '(ยังไม่มีข้อมูล)'}\n` +
          `แมพดีสุดตามสถิติ:\n${sc.join('\n') || '(ข้อมูลยังไม่พอ — ตกต่อไปก่อน เดี๋ยวรู้เอง)'}\nใช้: /mythic on|off · /mythic map ชื่อ|auto`);
        break;
      }
      case 'statwin': case 'statuse': case 'bswin': case 'window': {   // ตั้งจำนวนรายการที่ใช้แสดงสถิติ
        const n = parseInt(args[0], 10);
        if (isNaN(n) || n < 30 || n > 500) { reply(`ตอนนี้แสดงสถิติจาก ${cfg.statWin} รายการล่าสุด · เก็บสูงสุด ${cfg.statKeep}/ขั้น\nใช้: /statwin N (30-500)`); break; }
        cfg.statWin = n; saveCfg(); syncPanel(); refreshProfit();
        reply(`✅ แสดงสถิติจาก ${n} รายการล่าสุด/ขั้น`); break;
      }
      case 'advisor': case 'adv': {   // ดูคำแนะนำ Advisor สดๆ (คำนวณใหม่ตอนนี้)
        try {
          const a = advisorDecide();
          reply(esc(a.lines.join('\n')) + (isOn('advisor') ? '' : '\n\n(โหมด Advisor ปิดอยู่ — เปิดในแผง หรือ /set advisor on)'));
        } catch (e) { reply('Advisor ล้มเหลว: ' + esc(e?.message || e)); }
        break;
      }
      case 'statsexport': case 'exportstats': {   // ส่งออกสถิติ (สรุป JSON) — ไว้ส่งต่อให้ AI วิเคราะห์
        let s = statsExport(false);
        if (s.length > 3900) s = s.slice(0, 3900) + '\n...(ตัด — ใช้ปุ่มในแผงเอาฉบับเต็ม+ข้อมูลดิบ)';
        reply('📊 <b>สถิติ (สรุป)</b>\n<code>' + esc(s) + '</code>'); break;
      }
      case 'log': {   // ส่ง log ล่าสุด N บรรทัด (default 30) — ตัดไม่เกิน ~3800 ตัวอักษร
        const n = clamp(parseInt(args[0], 10) || 30, 5, 120);
        const tail = logRing.slice(-n);
        if (!tail.length) { reply('(log ว่าง)'); break; }
        let body = tail.map((e) => `${hhmmss(e.at)} ${e.lv[0].toUpperCase()} ${e.m}`).join('\n');
        if (body.length > 3800) body = body.slice(-3800);
        reply('📝 <b>Log ล่าสุด</b>\n<code>' + esc(body) + '</code>'); break;
      }
      case 'report': case 'diag': {   // รายงานปัญหาเต็ม (สถานะ+cfg+log) — ตัดไม่เกิน ~3900 ตัวอักษร
        let rep = diagReport(45);
        if (rep.length > 3900) rep = rep.slice(0, 3900) + '\n...(ตัด — ดูฉบับเต็มจากปุ่มในแผง)';
        reply('<code>' + esc(rep) + '</code>'); break;
      }
      case 'compare': case 'cmp': {   // 🔬 เทียบโหมดบอท vs เกมออโต้
        reply('<code>' + esc(modeCompareText()) + '</code>'); break;
      }
      case 'cmpreset': { resetModeCmp(); reply('♻️ ล้างข้อมูลเทียบโหมดแล้ว'); break; }
      case 'chat': {   // เปิด/ปิดโหมดบริดจ์แชทโลก
        cfg.chatBridge = !cfg.chatBridge; sessionOff.delete('chatBridge'); saveCfg(); syncPanel();
        if (cfg.chatBridge) { ensureChatObserver(); reply('🌍 เปิดโหมดแชทโลกแล้ว — พิมพ์ข้อความมาได้เลย (ไม่ต้องมี /) · แชทในเกมจะส่งมาที่นี่'); }
        else reply('🌍 ปิดโหมดแชทโลกแล้ว');
        break;
      }
      case 'w': case 'say': {   // ส่งแชทโลกครั้งเดียว (ไม่ต้องเปิดโหมด)
        const msg = args.join(' ').trim();
        if (!msg) { reply('ใช้: /w <ข้อความ>'); break; }
        chatEnqueue(msg) ? reply('🌍 กำลังส่งเข้าแชทโลก...') : reply('ข้อความว่าง');
        break;
      }
      case 'cfg': case 'settings': reply(settingsSummary()); break;
      case 'get': { const k = args[0]; const secret = k && /^tg(Token|ControlToken|Chat|ControlChat)$/.test(k); reply(k && k in DEFAULTS ? `${esc(k)} = <b>${esc(secret ? (cfg[k] ? '(ตั้งค่าแล้ว — ไม่แสดงของลับ)' : '(ว่าง)') : String(cfg[k]))}</b>` : `ไม่มีค่า "${esc(k || '')}"`); break; }
      case 'set': tgSetConfig(args, reply); break;
      default: reply(`ไม่รู้จักคำสั่ง "${esc(c)}" — พิมพ์ /help`);
    }
  }

  async function tgPoll() {
    const token = ctrlToken(), chat = ctrlChat();
    if (tgPolling || !isOn('tgControl') || !token || !chat) return;   // ใช้ห้องควบคุม (แยกได้จากแจ้งเตือน)
    tgPolling = true;
    try {
      const r = await tgApi('getUpdates', tgOffset ? { offset: tgOffset, timeout: 0, limit: 20 } : { timeout: 0, limit: 20 }, token);
      if (!r || !r.ok || !Array.isArray(r.result)) return;
      const reply = (t) => tgSendTo(t, token, chat);
      for (const u of r.result) {
        tgOffset = u.update_id + 1;
        if (!tgPollInit) continue;   // รอบแรก: ข้าม backlog แค่เลื่อน offset (กันรันคำสั่งเก่าซ้ำ)
        const m = u.message || u.channel_post;
        if (!m || !m.text || String(m.chat?.id) !== chat) continue;   // เฉพาะแชทห้องควบคุมเท่านั้น
        void handleTgCommand(m.text.trim(), reply);
      }
      tgPollInit = true;
    } finally { tgPolling = false; }
  }

  // ================= บริดจ์แชทโลก 🌍 <-> Telegram =================
  // อ่าน: MutationObserver บนลิสต์ข้อความแชท -> ส่งข้อความคนอื่นเข้า Telegram (ห้องควบคุม)
  // ส่ง: พิมพ์ใน Telegram -> ตั้งค่า input แบบ React (native setter + input event) -> submit form -> send() จริง
  // เกมจำกัด: แชทโลกเว้น 5 วิ/ข้อความ · สูงสุด 200 ตัวอักษร · มีตัวกรองคำหยาบ
  const CHAT_INPUT_SEL = 'input[aria-label="พิมพ์ข้อความแชท"]';
  const chatInputEl = () => document.querySelector(CHAT_INPUT_SEL);
  const chatOpenBtn = () => qBtn('เปิดแชท');
  const chatHideBtn = () => qBtn('หุบแชท');
  const worldTabBtn = () => [...document.querySelectorAll('button')].find((b) => /^🌍\s*โลก/.test(b.textContent.trim())) || null;
  function chatMsgList() {
    const input = chatInputEl();
    const box = input?.closest('div[class*="flex-col"]');
    return box?.querySelector('div[class*="overflow-y-auto"]') || null;
  }
  // แยกชื่อ+ข้อความจาก element ข้อความ (เฉพาะของคนอื่น: span แรกลงท้าย ":" · ของเราเองไม่มีชื่อ = ข้าม กันสะท้อนกลับ)
  function parseChatMsg(el) {
    if (!el.querySelectorAll) return null;
    if (/items-end/.test(String(el.className || ''))) return null;   // ข้อความของเราเอง (self จัดชิดขวา) — ข้ามกันสะท้อนกลับ
    const spans = el.querySelectorAll('span');
    const nameSpan = [...spans].find((s) => /:\s*$/.test(s.textContent || ''));
    if (!nameSpan) return null;
    const name = nameSpan.textContent.replace(/:\s*$/, '').trim();
    const text = (nameSpan.nextElementSibling?.textContent || '').trim();
    if (!name || !text) return null;
    return { name, text };
  }

  let chatObserver = null, chatListEl = null;
  const seenChatMsgs = new WeakSet();
  function forwardChatMsg(el) {
    if (!el || seenChatMsgs.has(el)) return;
    const m = parseChatMsg(el);
    if (!m) return;
    seenChatMsgs.add(el);
    if (!isOn('chatBridge')) return;
    void tgSendTo(`🌍 <b>${esc(m.name)}</b>: ${esc(m.text)}`, ctrlToken(), ctrlChat());
  }
  // ผูก observer เข้ากับลิสต์ข้อความ (เรียกซ้ำได้ ผูกเมื่อเจอลิสต์/ลิสต์เปลี่ยน) — เบากว่าเฝ้าทั้ง body
  function ensureChatObserver() {
    if (!isOn('chatBridge')) { chatObserver?.disconnect(); chatObserver = null; chatListEl = null; return; }
    const list = chatMsgList();
    if (!list || list === chatListEl) return;
    chatObserver?.disconnect();
    chatListEl = list;
    chatObserver = new MutationObserver((muts) => {
      // ข้อความ (tI) เป็นลูกโดยตรงของลิสต์ — forward เฉพาะ node ที่ถูกเพิ่ม (ไม่สแกน descendant กันซ้ำ)
      for (const mu of muts) for (const node of mu.addedNodes) {
        if (node.nodeType === 1) forwardChatMsg(node);
      }
    });
    chatObserver.observe(list, { childList: true });
  }

  // ---- ส่งข้อความเข้าแชทโลก (คิว + เคารพ cooldown 5 วิ) ----
  const chatQueue = [];
  let chatSending = false, chatLastSend = 0;
  function chatEnqueue(text) {
    text = String(text || '').replace(/\s+/g, ' ').trim();
    if (!text) return false;
    // ยาวเกิน 200 ตัด/แยกเป็นหลายข้อความ
    while (text.length > 200) { chatQueue.push(text.slice(0, 200)); text = text.slice(200); }
    if (text) chatQueue.push(text);
    void drainChatQueue();
    return true;
  }
  async function drainChatQueue() {
    if (chatSending) return;
    chatSending = true;
    try {
      while (chatQueue.length) {
        const wait = 5500 - (Date.now() - chatLastSend);   // แชทโลกเว้น 5 วิ + เผื่อ
        if (wait > 0) await sleep(wait);
        const text = chatQueue.shift();
        const res = await chatSendNow(text);
        chatLastSend = Date.now();
        if (!res.ok && ctrlChat()) void tgSendTo(`⚠️ ส่งแชทไม่สำเร็จ${res.reason ? `: ${esc(res.reason)}` : ''}`, ctrlToken(), ctrlChat());
      }
    } finally { chatSending = false; }
  }
  async function chatSendNow(text) {
    const gotIdle = await waitFor(() => !busy, 8000);   // รอให้ว่างจากเมนูอื่น (กระเป๋า/ร้าน/เควส)
    if (!gotIdle) return { ok: false, reason: 'บอทไม่ว่าง (กำลังทำงานอื่น) ลองใหม่' };
    busy = true;   // จับล็อก: กันตกปลาแทรกตอนพิมพ์ (สเปซจะไม่หลุดเข้าช่องแชท)
    try {
      if (!chatInputEl()) { const o = chatOpenBtn(); if (o) fireClick(o); await sleep(350); }
      const wt = worldTabBtn(); if (wt) { fireClick(wt); await sleep(150); }   // ต้องอยู่แท็บ 🌍 โลก
      const input = chatInputEl();
      if (!input) return { ok: false, reason: 'หาช่องแชทไม่เจอ (เปิดแชทไม่ได้?)' };
      // ตั้งค่า input แบบ React: native value setter + dispatch input event ให้ onChange ทำงาน
      const proto = Object.getPrototypeOf(input);
      const desc = Object.getOwnPropertyDescriptor(proto, 'value') || Object.getOwnPropertyDescriptor(W.HTMLInputElement.prototype, 'value');
      desc.set.call(input, text);
      input.dispatchEvent(new Event('input', { bubbles: true }));
      await sleep(100);
      const form = input.closest('form');
      if (form?.requestSubmit) form.requestSubmit();
      else { const sb = form && [...form.querySelectorAll('button')].find((b) => b.type === 'submit'); if (sb) fireClick(sb); }
      // สำเร็จ = เกมเคลียร์ค่า input ให้ (n.ok ? j("")) · ล้มเหลว = ค่ายังอยู่
      const ok = await waitFor(() => chatInputEl()?.value === '', 4000);
      chatInputEl()?.blur?.();
      const hide = chatHideBtn(); if (hide) fireClick(hide);   // หุบแชทคืน (การอ่านยังทำงานตอนหุบ)
      return ok ? { ok: true } : { ok: false, reason: 'เกมไม่รับ (cooldown/คำหยาบ/ออฟไลน์?)' };
    } finally { busy = false; }
  }

  // ================= อ่าน/กด DOM ของเกม =================

  function fireClick(el) {
    const r = el.getBoundingClientRect();
    const base = {
      bubbles: true, cancelable: true, button: 0,
      clientX: r.left + r.width / 2, clientY: r.top + r.height / 2,
      pointerId: 1, isPrimary: true,
    };
    el.dispatchEvent(new PointerEvent('pointerdown', base));
    el.dispatchEvent(new PointerEvent('pointerup', base));
    el.dispatchEvent(new MouseEvent('click', base));
  }

  function pressSpace() {
    const t = now();
    if (t - lastPress < 120) return;
    lastPress = t;
    // กดปุ่ม action ด้วย (เผื่อคีย์ไม่ติดในบางสถานะ) — ใช้ selector เบาๆ ไม่อ่าน innerText กันหน่วงจังหวะ
    // เกม debounce ในรอบ (c.current) อยู่แล้ว จึงไม่ดับเบิลแท็บ
    // กลไกใหม่ (v6.82): ทุกเฟส (ฮุบ/เกจ/ดึง) กดปุ่ม orb "ตกปลา (F)" เดิม · เผื่อปุ่มเก่า "ตวัดเบ็ด!"/"ดึง!"
    const ab = qBtn('ตกปลา (F)') || qBtn('ตวัดเบ็ด!') || btnByText('🎣 ดึง!') || btnByText('ดึง!');
    if (ab && !ab.disabled) { try { fireClick(ab); } catch {} }
    const opts = { key: ' ', code: 'Space', keyCode: 32, which: 32, bubbles: true, cancelable: true };
    W.dispatchEvent(new KeyboardEvent('keydown', opts));
    W.dispatchEvent(new KeyboardEvent('keyup', opts));
  }

  // รวมรูปแบบ selector ปุ่มไว้ที่เดียว (aria-label ของเกม) — ถ้าเกมเปลี่ยน label แก้จุดเดียว
  // 🛡️ v6.105 บั๊กร้ายแรง: บอทเคย "จับปุ่มของตัวเอง" — หัวข้อในแผงบอทชื่อ '🪱 เหยื่อ & อุปกรณ์' เป็น <button>
  //   → btnByText('🪱 เหยื่อ') (แท็บร้าน) ไปเจอปุ่มบอทก่อน → openShop คืน true ทั้งที่ร้านไม่เปิด + shopTab กดปุ่มตัวเอง
  //   → shopRows อ่านแท็บผิด → "หาเหยื่อขั้น N ในร้านไม่เจอ" → ensureGear ตั้ง needBuy ใหม่ = วนลูปไม่จบ (log ผู้ใช้ v6.104)
  //   กันถาวร: ทุก element ที่บอทสร้างติด data-tkbot → ทุก query ของ "DOM เกม" ต้องข้ามมันเสมอ
  const isBotUI = (el) => !!(el && el.closest && el.closest('[data-tkbot]'));
  const qBtn = (label) => {
    for (const b of document.querySelectorAll(`button[aria-label="${label}"]`)) if (!isBotUI(b)) return b;
    return null;
  };

  const btnByText = (prefix) =>
    [...document.querySelectorAll('button')].find((b) => !isBotUI(b) && b.textContent.trim().startsWith(prefix)) || null;

  // 🎣 ระบบ "ตกปลาอัตโนมัติ" ของเกม (ปุ่มเดียวสลับ ตกปลาอัตโนมัติ ↔ หยุดตกอัตโนมัติ · aria-label ทั้งคู่)
  //   เกมย้ายกลไกตก (จังหวะฮุบ/มินิเกมดึง) ไปวาดบน canvas ที่บอทอ่านไม่ได้ตั้งแต่เวอร์ชันล่าสุด
  //   → โหมด gameauto ให้เกมเป็นคนตกเอง บอทแค่คุมสวิตช์ + ทำระบบรอบข้าง (ขาย/ซื้อ/เควส/พลังงาน)
  const gameAutoRunning = () => !!qBtn('หยุดตกอัตโนมัติ');
  const startGameAuto = () => { const b = qBtn('ตกปลาอัตโนมัติ'); if (b && !b.disabled) { fireClick(b); return true; } return false; };
  const stopGameAuto = () => { const b = qBtn('หยุดตกอัตโนมัติ'); if (b) { fireClick(b); return true; } return false; };

  // ===== 📊 อ่านผลตกจาก state ในเกม (โหมด gameauto) — v6.83 =====
  // กลไกใหม่ตกบน Phaser canvas → ไม่มี popup ผลใน DOM ให้ readCatch อ่าน (สถิติหยุดทำงานในโหมด auto)
  // แต่ผลปลาแต่ละตัวโผล่ชั่วคราวใน React hook: array ของ {id, r:{fish,rarity,weight,isShiny,price,bait,mapId}}
  // เดินจาก <canvas> → React fiber (ขึ้น ~2 ชั้น) → หา hook ที่เป็น array ทรงนี้ (เช็คทั้ง fiber + alternate เพราะ React สลับ 2 ต้นไม้)
  // ยืนยันสด (Claude for Chrome): อ่าน {fish:"ปลาตะเพียน",rarity:"common",weight:0.98,price:24,bait:2,...} ได้จริง
  // ⚠️ เปราะต่อการอัปเดตเกม (hook index/ชื่อ minified เปลี่ยนได้) → ออกแบบให้ degrade เงียบ ๆ ถ้าหาไม่เจอ
  const __isCatchArr = (v) => Array.isArray(v) && v.length && v[0] && typeof v[0] === 'object' && v[0].r && typeof v[0].r === 'object' && 'fish' in v[0].r;
  function readGameCatchArr() {
    try {
      const c = document.querySelector('canvas'); if (!c) return null;
      let hostEl = c, fkey;
      while (hostEl) { fkey = Object.keys(hostEl).find((k) => k.startsWith('__reactFiber')); if (fkey) break; hostEl = hostEl.parentElement; }
      if (!fkey) return null;
      let f = hostEl[fkey], up = 0;
      while (f && up < 16) {
        for (const fib of [f, f.alternate]) {
          if (!fib) continue;
          let s = fib.memoizedState, i = 0;
          while (s && i < 30) { if (__isCatchArr(s.memoizedState)) return s.memoizedState; s = s.next; i++; }
        }
        f = f.return; up++;
      }
    } catch {}
    return null;
  }
  const gameCatchSeen = [];   // ring ของ id ที่บันทึกแล้ว (กันนับซ้ำ · ทน id รีเซ็ตหลังรีโหลด)
  function pollGameCatches() {
    const arr = readGameCatchArr(); if (!arr) return;
    for (const e of arr) {
      if (!e || e.id == null || !e.r) continue;
      if (gameCatchSeen.includes(e.id)) continue;
      gameCatchSeen.push(e.id); if (gameCatchSeen.length > 200) gameCatchSeen.shift();
      try { recordGameCatch(e.r); } catch (err) { logErr('บันทึกผลตก (gameauto) ล้มเหลว', err); }
    }
  }
  // ป้อนผลปลา 1 ตัว (จาก state เกม) เข้าระบบสถิติ — ใช้ tier จาก r.bait ตรง ๆ
  // โหมด gameauto: คิดต้นทุนเหยื่อ+casts ที่นี่ (บอทไม่ได้เหวี่ยงเอง ≈ 1 catch/cast)
  // โหมด bot (v6.84): pushCastCost() คิดต้นทุนไปแล้วตอนเหวี่ยงติด → ที่นี่คิดเฉพาะรายได้ (กันนับต้นทุนซ้ำ · ตัวที่หลุดก็โดนต้นทุนถูกต้อง)
  function recordGameCatch(r) {
    const tier = (r.bait | 0) || lastKnownBaitTier || cfg.baitTier;
    if (!tier) return;
    const price = +r.price || 0;
    const junk = r.rarity === 'junk' || (!price && !r.rarity);
    const buffs = readBuffs();   // สถานะยาตอนตกตัวนี้ (DOM chips ยังอ่านได้ในโหมด auto)
    // ฟังก์ชันนี้ถูกเรียกจาก pollGameCatches เท่านั้น (gate = โหมด gameauto) → คิดต้นทุน+นับแบบ gameauto ตรงๆ
    profit.life.baitCost += baitUnit(tier);
    profit.life.casts += 1;
    sessBait += baitUnit(tier);
    profit.life.revenue += price;
    profit.life.catches += 1;
    sessRev += price; sessCatches += 1;
    const rec = { fish: r.fish, rarity: r.rarity, price, shiny: !!r.isShiny, junk: junk || undefined,
                  at: Date.now(), map: curMap || undefined, bw: buffs.weight || undefined, bl: buffs.luck || undefined,
                  md: 'g',   // g=เกมออโต้ (เส้นทางนี้มีแต่ gameauto)
                  w: (typeof r.weight === 'number' && r.weight > 0 ? +r.weight.toFixed(2) : undefined) };
    const list = (profit.recs[tier] ||= []);
    list.push(rec);
    const cap = Math.max(30, cfg.statKeep || 200);
    if (list.length > cap) list.splice(0, list.length - cap);
    feedModeStats('gameauto', { price, baitCost: baitUnit(tier), weight: +r.weight || 0, rarity: r.rarity, junk, tier });   // 🔬 สถิติ 2 แบบ
    // 🧪 นับเข้ารอบทดสอบ (รอบ gameauto) — เหยื่อตรงขั้น + สถานะยาตรงรอบ (buff=มีทั้งคู่ · plain=ไม่มีเลย)
    if (testRunning && test && test.mode === 'gameauto' && tier === test.tier) {
      const both = buffs.weight && buffs.luck, none = !buffs.weight && !buffs.luck;
      if (test.buff ? both : none) test.count++;
    }
    lastKnownBaitTier = tier;
    casts++;   // นับกิจกรรมให้ badge
    // 📋 สรุป 1 บรรทัด/ตัวลง log (ผู้ใช้ /report ส่งให้วิเคราะห์ได้)
    fishSeq++;
    const wkg = typeof r.weight === 'number' ? `${r.weight.toFixed(2)}กก` : '';
    logInfo(`🎣 #${fishSeq} ${r.fish}(${r.rarity || '?'}) ${wkg} ${price ? price.toLocaleString() + '🪙' : 'ล็อก/ขยะ'} | โหมดเกมออโต้`);
    if (Date.now() - lastCatchSaveAt >= 3000) { lastCatchSaveAt = Date.now(); saveProfit(); }
    // แจ้งเตือน Telegram ปลาน่าสนใจ (reuse ตรรกะเดียวกับ readCatch เดิม)
    if (isOn('tgOn')) {
      const why = catchWorthNotifying({ name: r.fish, rarity: r.rarity, price, weight: r.weight, shiny: !!r.isShiny });
      if (why) {
        const net = price - baitUnit(tier);
        void tgSend(`🎣 <b>${esc(r.fish)}</b>\n${why.join(' · ')}\nน้ำหนัก ${r.weight} กก.${price ? ` · ขายได้ ${price.toLocaleString()} 🪙 · กำไรสุทธิ ${signed(net)} 🪙 (หักเหยื่อ ${baitUnit(tier)})` : ''}\nตกไปแล้ว ${casts} ตัว (โหมดเกมออโต้)`);
      }
    }
  }

  // ===== 🤖 เอนจินตกเองสำหรับกลไกใหม่ (v6.84 — ถอดรหัส+ทดสอบสดผ่านครบทุกเฟส ดู docs/GAME.md) =====
  // ทุกเฟสขับผ่านปุ่ม orb "ตกปลา (F)" เดิม + UI overlay เป็น DOM/React (ไม่ใช่ canvas อย่างที่เคยสรุป):
  //   ปลากิน = orb "❗" (~2วิ) → เกจวงล้อ conic-gradient (โซนแดง a0..a1 องศา · เข็ม = div transform:rotate)
  //   → ชักเย่อ = กรอบ border-2 (bottom/height เป็น % — ระวังเกมห่อ calc()) + ปลา emoji (bottom calc(X% - Ypx))
  //   → ปลาสู้ = ข้อความ "กดรัว/ปลาสู้" (กดรัว) → ผลไม่โชว์ popup DOM (สถิติมาจาก readGameCatchArr)
  //   สถานะ "สายอยู่ในน้ำ" อ่านจาก Phaser: scene.isFishing (สำคัญ! orb ไม่ disabled ตอนรอ — เคยทำบอทเหวี่ยงซ้ำตัดสายตัวเอง)
  let phaserSceneRef = null, phaserSceneAt = 0;
  function getPhaserScene() {
    if (phaserSceneRef && now() - phaserSceneAt < 5000) return phaserSceneRef;
    phaserSceneAt = now();
    try {
      const c = document.querySelector('canvas'); if (!c) return (phaserSceneRef = null);
      let hostEl = c, fkey;
      while (hostEl) { fkey = Object.keys(hostEl).find((k) => k.startsWith('__reactFiber')); if (fkey) break; hostEl = hostEl.parentElement; }
      if (!fkey) return (phaserSceneRef = null);
      const isGm = (v) => v && typeof v === 'object' && v.isBooted !== undefined && v.scene && v.renderer && v.textures;
      let f = hostEl[fkey], up = 0;
      while (f && up < 16) {
        for (const fib of [f, f.alternate]) {
          if (!fib) continue;
          let s = fib.memoizedState, i = 0;
          while (s && i < 32) {
            const v = s.memoizedState;
            if (isGm(v)) return (phaserSceneRef = v.scene.keys.main || v.scene.scenes[0]);
            if (v && typeof v === 'object' && v.current && isGm(v.current)) return (phaserSceneRef = v.current.scene.keys.main || v.current.scene.scenes[0]);
            s = s.next; i++;
          }
        }
        f = f.return; up++;
      }
    } catch {}
    return (phaserSceneRef = null);
  }
  // true=สายอยู่ในน้ำ · false=ว่าง · null=อ่านไม่ได้ (Phaser หาย — degrade ไปใช้ heuristic เดิม)
  const sceneIsFishing = () => { const s = getPhaserScene(); try { return s ? !!s.isFishing : null; } catch { return null; } };

  // ============================================================================
  // 👹 ระบบล่าบอส (boss_cave "ถ้ำบ่อโบราณ") — ยืนยันสดกับเกม v6.103:
  //   • เวลาบอส: ป้าย HUD "บอสถัดไป HH:MM (อีก ...)" อ่านได้ทุกแมพ (ไม่ต้องเดา period) — 2 รูปแบบ ดู bossTimerMin()
  //   • เปลี่ยนแมพ: ยิง WASD สังเคราะห์ → ตัวเดินจริง → เดินเข้าโซน exit → เปลี่ยนแมพ (พิสูจน์แล้ว)
  //   • เส้นทาง: scene.mapManager.def.zones = exit ทุกอัน (targetMap + x/y/w/h) → เรียนรู้กราฟ + BFS
  //   • บอส: scene.raidBoss {hidden,dead,phase} · scene.playerHp/playerHpMax · orb aria "ตีบอส"
  //   ✅ กลไกสู้บอส (ถอดจากวิดีโอ+log จริง v6.113-6.116): RAID HP ~204k (เก็บ reward ตามส่วน · ฆ่าเดี่ยวไม่ได้) ·
  //     ตี = orb ตีบอส → เกจ conic → กดแถบแดง (readGaugeWheel+fallback) · หลบ = กดปุ่ม "กระโดด" ตอน "🌀 บอสหมุน!" ·
  //     โดนตี HP ลดแต่ respawn 100% (ไม่ตายถาวร) · จบเมื่อบอสหาย/ตาย · ⚠️ เกจของบอทยังไม่ยืนยันสด (bossHunt ต้องเปิดให้ตีจริง)
  // ============================================================================
  const BOSS_MAP = 'boss_cave';
  const BOSS_GRAPH_KEY = 'tokpla_boss_graph', BOSS_STATE_KEY = 'tokpla_boss_state';
  let bossPhase = 'idle';        // idle | travel | fight | return — persist กันหลุดตอนรีโหลด
  let bossHome = '';             // แมพบ้านที่จะกลับ (จำตอนเริ่มล่า)
  const heldKeys = new Set();    // ปุ่มทิศที่กดค้างอยู่ (ต้องปล่อยเสมอเมื่อจบ)

  const bossMapId = () => { try { return getPhaserScene()?.mapManager?.def?.id || null; } catch { return null; } };
  const bossMapExits = () => { try { return (getPhaserScene().mapManager.def.zones || []).filter((z) => z.type === 'exit'); } catch { return []; } };
  // 🛡️ v6.107: ต้องเป็น "ตัวละครที่เราคุมได้จริง" เท่านั้น — ตรวจสดกับเกมพบว่า getPhaserScene().player
  //   บางจังหวะ (ระหว่าง transition/หลังโหลดแมพ) resolve ได้ object คนละตัว (ผู้เล่นคนอื่น: ไม่มี rodTier/avatar)
  //   → boss-hunt อ่านพิกัดผิด/เดินผิดตัว · local player แท้ต้องมีฟิลด์อุปกรณ์ (rodTier + avatar/cosmetics)
  function bossLocalPlayer() {
    try { const p = getPhaserScene()?.player;
      if (p && typeof p.x === 'number' && p.rodTier !== undefined && (p.avatar !== undefined || p.cosmetics !== undefined)) return p;
    } catch {}
    return null;
  }
  const bossPlayerXY = () => { const p = bossLocalPlayer(); return p ? { x: p.x, y: p.y } : null; };
  const bossFishingZone = () => { try { return (getPhaserScene().mapManager.def.zones || []).find((z) => z.type === 'fishing') || null; } catch { return null; } };
  function raidBossState() {
    try { const b = getPhaserScene()?.raidBoss; if (!b) return null;
      return { present: !b.hidden && !b.destroyed, dead: !!b.dead, phase: b.phase, x: b.x, y: b.y }; } catch { return null; }
  }
  function bossPlayerHpPct() {
    try { const s = getPhaserScene(); if (!s || !s.playerHpMax) return null; return s.playerHp / s.playerHpMax * 100; } catch { return null; }
  }
  // ⚔️ อ่าน "ดาเมจ/ส่วนร่วม" ของเราจาก HUD ตอนสู้บอส — รูปแบบ "⚔️ ของเรา 7,991 (5.5%)" (คืน null ถ้าไม่เจอ)
  function readBossContribution() {
    try {
      const m = (document.body.innerText || '').match(/ของเรา\s*([\d,]+)\s*\(([\d.]+)\s*%\)/);
      if (!m) return { dmg: null, pct: null };
      return { dmg: parseInt(m[1].replace(/,/g, ''), 10), pct: parseFloat(m[2]) };
    } catch { return { dmg: null, pct: null }; }
  }

  // 📋 v6.199: บันทึก "เหตุการณ์/เหตุผล" ของระบบล่าบอสแยกจาก log หลัก
  //   ทำไมต้องแยก: log หลักเก็บ 300 บรรทัด แต่ทุกครั้งที่ตกปลาเขียน 1 บรรทัด → เต็มใน ~38 นาที
  //   → ตอนผู้ใช้ถามว่า "ทำไมบอทออกล่า 10:36 แทน 10:22" หลักฐานหมุนทับไปแล้ว วินิจฉัยไม่ได้เลย
  //   ที่นี่เขียนเฉพาะเหตุการณ์บอส (นานๆ ครั้ง) → เก็บได้เป็นวัน
  // 📋 v6.213: event ring ทั่วไป (บอส + สำรวจเหยื่อ ใช้ร่วมกัน) — แยกจาก log หลัก 300 บรรทัดที่หมุนเร็ว → อยู่ได้เป็นวัน
  const loadEvents = (key) => { try { const a = JSON.parse(W.localStorage.getItem(key) || '[]'); return Array.isArray(a) ? a : []; } catch { return []; } };
  const pushEvent = (key, m, cap = 80) => { try { const a = loadEvents(key); a.push({ at: Date.now(), m }); while (a.length > cap) a.shift(); W.localStorage.setItem(key, JSON.stringify(a)); } catch {} };
  const eventsText = (key, empty) => {
    const a = loadEvents(key);
    if (!a.length) return empty;
    const t = (ts) => { const d = new Date(ts); const z = (x) => String(x).padStart(2, '0'); return `${z(d.getDate())}/${z(d.getMonth() + 1)} ${z(d.getHours())}:${z(d.getMinutes())}:${z(d.getSeconds())}`; };
    return a.slice().reverse().map((e) => `${t(e.at)}  ${e.m}`).join('\n');
  };
  const BOSS_EV_KEY = 'tokpla_boss_events';
  const bossEvent = (m) => pushEvent(BOSS_EV_KEY, m);
  const bossEventsText = () => eventsText(BOSS_EV_KEY, '(ยังไม่มีเหตุการณ์บอสบันทึกไว้)');
  const EXPLORE_EV_KEY = 'tokpla_bait_explore_ev';
  const exploreEvent = (m) => pushEvent(EXPLORE_EV_KEY, m, 60);
  const exploreEventsText = () => eventsText(EXPLORE_EV_KEY, '(ยังไม่มีเหตุการณ์สำรวจเหยื่อ)');

  // 📊 v6.195: สถิติล่าบอส — ring buffer เก็บ "N ครั้งล่าสุด" (ตั้งได้ที่ cfg.bossStatKeep)
  const BOSS_STATS_KEY = 'tokpla_boss_stats';
  const loadBossStats = () => { try { const a = JSON.parse(W.localStorage.getItem(BOSS_STATS_KEY) || '[]'); return Array.isArray(a) ? a : []; } catch { return []; } };
  function recordBossFight(rec) {
    const keep = clamp(cfg.bossStatKeep || 0, 0, 200);
    if (!keep) return;                                   // 0 = ปิดการเก็บ
    try {
      const arr = loadBossStats();
      arr.push(rec);
      while (arr.length > keep) arr.shift();             // ตัดให้เหลือ N ครั้งล่าสุด
      W.localStorage.setItem(BOSS_STATS_KEY, JSON.stringify(arr));
    } catch (e) { logErr('บันทึกสถิติบอสล้มเหลว', e); }
  }
  // สรุปสถิติเป็นข้อความ (ใช้ทั้งแผง/Telegram) — เฉลี่ยเฉพาะไฟต์ที่มีข้อมูลนั้นจริง
  function bossStatsSummary() {
    const arr = loadBossStats();
    if (!arr.length) return '📊 ยังไม่มีสถิติล่าบอส (จะเริ่มเก็บหลังจบไฟต์แรก)';
    const n = arr.length;
    const kills = arr.filter((r) => r.outcome === 'kill').length;
    const deaths = arr.reduce((s, r) => s + (r.deaths || 0), 0);
    const avg = (sel) => { const v = arr.map(sel).filter((x) => x != null && !isNaN(x)); return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null; };
    const fmt = (x, d = 0) => x == null ? '–' : x.toLocaleString(undefined, { maximumFractionDigits: d });
    const aDmg = avg((r) => r.dmg), aPct = avg((r) => r.pct), aGauge = avg((r) => r.gauge);
    const aHpMin = avg((r) => r.hpMin), aAoe = avg((r) => r.aoeDodges), aDur = avg((r) => r.durMs);
    const lines = [
      `📊 <b>สถิติล่าบอส</b> (${n} ครั้งล่าสุด · เก็บสูงสุด ${cfg.bossStatKeep})`,
      `🏆 ฆ่าสำเร็จ ${kills}/${n} (${Math.round(kills / n * 100)}%) · 💀 ตายรวม ${deaths}`,
      `⚔️ ดาเมจเฉลี่ย ${fmt(aDmg)}${aPct != null ? ` (${aPct.toFixed(1)}%)` : ''} · 🎯 กดเกจเฉลี่ย ${fmt(aGauge)}`,
      `❤️ HP ต่ำสุดเฉลี่ย ${aHpMin != null ? Math.round(aHpMin) + '%' : '–'} · 🌀 หลบ AoE เฉลี่ย ${fmt(aAoe, 1)} · ⏱️ ${aDur != null ? Math.round(aDur / 1000) + ' วิ/ไฟต์' : '–'}`,
    ];
    // 🎁 v6.206: สรุปรางวัลรวม + ของที่ได้บ่อย
    const totCoin = arr.reduce((s, r) => s + ((r.reward && r.reward.coins) || 0), 0);
    const itemCnt = {};
    for (const r of arr) for (const it of ((r.reward && r.reward.items) || [])) {
      const nm = String(it).replace(/×\d+$/, '').trim(); const n = parseInt((/×(\d+)$/.exec(it) || [])[1] || 1, 10);
      itemCnt[nm] = (itemCnt[nm] || 0) + n;
    }
    const itemTop = Object.entries(itemCnt).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([k, v]) => `${k}×${v}`);
    const nRw = arr.filter((r) => r.reward && r.reward.coins).length;
    if (totCoin || itemTop.length) {
      lines.push(`🎁 รางวัลรวม ${totCoin.toLocaleString()} 🪙${nRw ? ` (เฉลี่ย ${Math.round(totCoin / nRw).toLocaleString()}/ไฟต์ จาก ${nRw} ไฟต์ที่มีข้อมูล)` : ''}`
        + (itemTop.length ? `\n📦 ของที่ได้: ${itemTop.join(' · ')}` : ''));
    }
    // 5 ไฟต์ล่าสุด (ใหม่สุดบน)
    const recent = arr.slice(-5).reverse().map((r) => {
      const t = r.ts ? new Date(r.ts).toLocaleString('th-TH', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : '?';
      const icon = r.outcome === 'kill' ? '✅' : r.outcome === 'timeout' ? '🏁' : '⌛';
      return `${icon} ${t} · ดาเมจ ${fmt(r.dmg)}${r.pct != null ? `(${r.pct}%)` : ''} · เกจ ${r.gauge ?? '–'} · หลบ ${r.aoeDodges ?? '–'} · ตาย ${r.deaths ?? 0} · HP↓${r.hpMin != null ? Math.round(r.hpMin) + '%' : '–'}`;
    });
    return lines.join('\n') + '\n— ล่าสุด —\n' + recent.join('\n');
  }
  // 📊 v6.196: ตารางเทียบ "รายไฟต์" (ไม่ใช่เฉลี่ย) — ใหม่→เก่า · ASCII/ตัวเลขล้วนในเซลล์เพื่อจัดคอลัมน์ตรงใน monospace
  function bossStatsTable() {
    const arr = loadBossStats();
    if (!arr.length) return '📊 ยังไม่มีสถิติล่าบอส (จะเริ่มเก็บหลังจบไฟต์แรก)';
    const pad = (s, w, right = true) => { s = String(s); return right ? s.padStart(w) : s.padEnd(w); };
    const dt = (ts) => { if (!ts) return '??/?? ??:??'; const d = new Date(ts); const z = (x) => String(x).padStart(2, '0'); return `${z(d.getDate())}/${z(d.getMonth() + 1)} ${z(d.getHours())}:${z(d.getMinutes())}`; };
    const res = (o) => o === 'kill' ? 'k' : o === 'timeout' ? 't' : 'm';
    const cols = [
      { h: '#', w: 3, g: (r, i) => i + 1 },
      { h: 'date', w: 11, right: false, g: (r) => dt(r.ts) },
      { h: 'res', w: 3, right: false, g: (r) => res(r.outcome) },
      { h: 'dmg', w: 8, g: (r) => r.dmg != null ? r.dmg.toLocaleString() : '-' },
      { h: 'pct', w: 5, g: (r) => r.pct != null ? r.pct.toFixed(1) : '-' },
      { h: 'gg', w: 4, g: (r) => r.gauge ?? '-' },
      { h: 'dg', w: 3, g: (r) => r.aoeDodges ?? '-' },
      { h: 'di', w: 3, g: (r) => r.deaths ?? 0 },
      { h: 'hp', w: 5, g: (r) => r.hpMin != null ? r.hpMin + '%' : '-' },
      { h: 'sec', w: 4, g: (r) => r.durMs ? Math.round(r.durMs / 1000) : '-' },
      { h: 'coin', w: 8, g: (r) => r.reward && r.reward.coins ? r.reward.coins.toLocaleString() : '-' },   // 🎁 v6.206
    ];
    const rows = arr.slice().reverse();   // ใหม่สุดอยู่บน
    const header = cols.map((c) => pad(c.h, c.w, c.right === false ? false : true)).join(' ');
    const sep = cols.map((c) => '-'.repeat(c.w)).join(' ');
    const body = rows.map((r, i) => cols.map((c) => pad(c.g(r, i), c.w, c.right === false ? false : true)).join(' ')).join('\n');
    const kills = arr.filter((r) => r.outcome === 'kill').length;
    // 🎁 v6.206: รายละเอียดรางวัล (ของ/ไอเทม) แสดงแยกใต้ตาราง — ยาวเกินใส่คอลัมน์
    const rw = rows.filter((r) => r.reward && (r.reward.coins || (r.reward.items || []).length))
      .map((r, i) => {
        const d = new Date(r.ts); const z = (x) => String(x).padStart(2, '0');
        const items = [...new Set(r.reward.items || [])];
        return `  ${z(d.getDate())}/${z(d.getMonth() + 1)} ${z(d.getHours())}:${z(d.getMinutes())}  `
          + [r.reward.coins ? `${r.reward.coins.toLocaleString()} 🪙` : null, items.length ? items.join(' + ') : null].filter(Boolean).join(' · ');
      });
    const totCoin = arr.reduce((s, r) => s + ((r.reward && r.reward.coins) || 0), 0);
    return `📊 เทียบรายไฟต์ล่าบอส (${arr.length} ครั้ง · ใหม่→เก่า) · ฆ่า ${kills}/${arr.length}`
      + (totCoin ? ` · รางวัลรวม ${totCoin.toLocaleString()} 🪙` : '') + '\n'
      + `res: k=ฆ่า t=หมดเวลา m=ไม่มา · gg=กดเกจ dg=หลบAoE di=ตาย hp=HPต่ำสุด sec=วินาที coin=เหรียญรางวัล\n\n`
      + header + '\n' + sep + '\n' + body
      + (rw.length ? `\n\n🎁 รางวัลที่ได้รับรายไฟต์\n${rw.join('\n')}` : '\n\n🎁 (ยังไม่มีข้อมูลรางวัล — จะเก็บตั้งแต่ไฟต์ถัดไป)');
  }
  // แสดงข้อความ/ตารางในหน้าต่างของบอทเอง (monospace · ไม่พึ่ง alert ที่ฟอนต์ไม่ตรง) — data-tkbot กัน isBotUI จับ
  //   v6.201: แยกเป็นตัวใช้ซ้ำ (สถิติบอส + ตรวจระดับปลา ใช้ร่วมกัน)
  function showTextModal(title, text) {
    document.querySelectorAll('[data-tkbot="text-modal"]').forEach((e) => e.remove());
    const ov = document.createElement('div');
    ov.setAttribute('data-tkbot', 'text-modal');
    ov.style.cssText = 'position:fixed;inset:0;z-index:2147483647;background:rgba(0,0,0,.72);display:flex;align-items:center;justify-content:center;padding:16px;';
    const box = document.createElement('div');
    box.style.cssText = 'background:#1a202c;border:1px solid #4a5568;border-radius:10px;max-width:96vw;max-height:88vh;overflow:auto;padding:14px 16px;box-shadow:0 8px 40px rgba(0,0,0,.6);';
    const h = document.createElement('div');
    h.textContent = title;
    h.style.cssText = 'color:#f6e05e;font-size:13px;font-weight:700;margin-bottom:8px;';
    const pre = document.createElement('pre');
    pre.textContent = text;
    pre.style.cssText = 'margin:0;font-family:Consolas,"Courier New",monospace;font-size:12px;line-height:1.5;color:#e2e8f0;white-space:pre;';
    const close = document.createElement('button');
    close.setAttribute('data-tkbot', '1');
    close.textContent = '✕ ปิด';
    close.style.cssText = 'margin-top:12px;padding:6px 14px;border-radius:7px;border:1px solid #4a5568;background:#2d3748;color:#e2e8f0;font-size:12px;cursor:pointer;';
    close.addEventListener('click', () => ov.remove());
    ov.addEventListener('click', (e) => { if (e.target === ov) ov.remove(); });
    box.appendChild(h); box.appendChild(pre); box.appendChild(close); ov.appendChild(box); document.body.appendChild(ov);
  }
  function showBossStatsModal() {
    document.querySelectorAll('[data-tkbot="bossstat-modal"]').forEach((e) => e.remove());
    const ov = document.createElement('div');
    ov.setAttribute('data-tkbot', 'bossstat-modal');
    ov.style.cssText = 'position:fixed;inset:0;z-index:2147483647;background:rgba(0,0,0,.72);display:flex;align-items:center;justify-content:center;padding:16px;';
    const box = document.createElement('div');
    box.style.cssText = 'background:#1a202c;border:1px solid #4a5568;border-radius:10px;max-width:96vw;max-height:88vh;overflow:auto;padding:14px 16px;box-shadow:0 8px 40px rgba(0,0,0,.6);';
    const pre = document.createElement('pre');
    // v6.199: ตารางไฟต์ + "บันทึกเหตุการณ์/เหตุผล" (ทำไมไป/ไม่ไป) — log หลักหมุนทับเร็ว ตัวนี้อยู่ได้เป็นวัน
    pre.textContent = bossStatsTable() + '\n\n📋 เหตุการณ์ระบบล่าบอส (ใหม่→เก่า)\n' + bossEventsText();
    pre.style.cssText = 'margin:0;font-family:Consolas,"Courier New",monospace;font-size:12px;line-height:1.5;color:#e2e8f0;white-space:pre;';
    const close = document.createElement('button');
    close.setAttribute('data-tkbot', '1');
    close.textContent = '✕ ปิด';
    close.style.cssText = 'margin-top:12px;padding:6px 14px;border-radius:7px;border:1px solid #4a5568;background:#2d3748;color:#e2e8f0;font-size:12px;cursor:pointer;';
    close.addEventListener('click', () => ov.remove());
    ov.addEventListener('click', (e) => { if (e.target === ov) ov.remove(); });   // คลิกพื้นหลัง = ปิด
    box.appendChild(pre); box.appendChild(close); ov.appendChild(box); document.body.appendChild(ov);
    try { console.table(loadBossStats().slice().reverse()); } catch {}   // โบนัส: ตารางจริงใน DevTools
  }

  // อ่านนาทีจนบอสเกิดครั้งถัดไป จากป้าย HUD (ทุกแมพ) — null = อ่านไม่ได้
  //   ⚠️ v6.106 บั๊กร้ายแรง: เกมใช้ "2 รูปแบบ" ตามเวลาที่เหลือ (ยืนยันสด)
  //     • เหลือ ≥ 1 ชม. → "บอสถัดไป 16:30 (อีก 1 ชม. 27 นาที)"
  //     • เหลือ < 1 ชม. → "บอสถัดไป 16:30 (อีก 2:20)"  = MM:SS นับถอยหลังทุกวินาที
  //       (วัดสด: 2:20 → 1:30 ใน 51 วิ = ลด 1 หน่วย/วินาที · ไม่ใช่ H:MM)
  //   v6.103 รู้จักแต่รูปแบบแรก → พอเหลือ < 1 ชม. (ซึ่งเป็นช่วงที่ bossLeadMin ต้องใช้เสมอ!) คืน null
  //   → bossHuntDue() เป็นเท็จตลอด = ระบบล่าบอสไม่เคยทำงานเลย
  // 🐯 v6.170 (เจอสด): ป้ายบอสมี "โหมดย่อ" — เป็นปุ่ม title="แตะดูเวลาเต็ม" แสดงแค่ `MM:SS` (หรือ `H:MM:SS`)
  //   ไม่มีคำว่า "บอสถัดไป" เลย → TreeWalker เดิมหาไม่เจอ → คืน null → bossHuntDue เป็นเท็จ = ไม่ล่าบอส
  //   (ยืนยันสด: chip ขึ้น 28:32 = บอสอีก 28 นาที แต่บอทมองไม่เห็นเลย) · ผู้ใช้สลับโหมดย่อ/เต็มได้เอง บอทจึงต้องอ่านได้ทั้งคู่
  //   หน่วยเป็น นาที:วินาที (ไม่ใช่ ชม.:นาที) — ยืนยันจากการวัดสดใน v6.106
  function bossTimerChipMin() {
    try {
      const b = [...document.querySelectorAll('button')].find((x) =>
        !isBotUI(x) && x.offsetParent && /แตะดูเวลาเต็ม/.test(x.getAttribute('title') || ''));
      if (!b) return null;
      const t = (b.textContent || '').trim();
      // 🐯 v6.184: chip โหมดย่อมี 3 รูปแบบ (เจอสด) — เดิมรองรับแค่แบบที่ 1 → เหลือ >1 ชม. อ่านไม่ออก คืน null
      //   ① "26:43" = นาที:วินาที  ② "1:28:32" = ชม.:นาที:วินาที  ③ "1 ชม." / "1 ชม. 27 นาที" = ตอนเหลือเกิน 1 ชม.
      if (/^\d{1,2}:\d{2}(:\d{2})?$/.test(t)) {
        const p = t.split(':').map(Number);
        if (p.some(isNaN)) return null;
        return p.length === 3 ? p[0] * 60 + p[1] : p[0];
      }
      const hm = /(?:(\d+)\s*ชม\.?)?\s*(?:(\d+)\s*นาที)?/.exec(t);
      if (hm && (hm[1] || hm[2])) return (parseInt(hm[1] || 0, 10) * 60) + parseInt(hm[2] || 0, 10);
      return null;
    } catch { return null; }
  }
  let bossNowLabelSeen = false;   // v6.169: กัน log ซ้ำทุก 5 วิ ตอนป้าย "ถึงรอบบอสแล้ว" ค้างอยู่
  function bossTimerDom() {
    let sawNowLabel = false;   // v6.173: เจอป้าย "ถึงรอบบอสแล้ว" ไหม — ตัดสินใจทีหลัง (ตัวนับถอยหลังต้องชนะก่อน)
    try {
      const tw = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      let n;
      while ((n = tw.nextNode())) {
        if (n.parentElement && n.parentElement.closest('[data-tkbot]')) continue;   // กฎเหล็ก #7: ข้าม UI บอทเอง (log/แผงบอทมีคำว่า "บอส" เพียบ = false positive)
        const t = n.textContent || '';
        // 🐯 v6.164: ป้าย "ถึงรอบบอสแล้ว!" (ไม่มีคำว่า "บอสถัดไป") = ถึงเวลาบอสแล้ว
        // 🐛 v6.173 แก้ regression ของ v6.164: ป้ายนี้ **ค้างบนหน้าเพจแม้บอสตายไปแล้ว**
        //   (เจอสด: โชว์พร้อมกันกับ "บอสถัดไป 16:30 (อีก 2 ชม. 38 นาที)") · v6.164 `return 0` ทันทีที่เจอ
        //   → bossHuntDue() จริงตลอด → บอทวนออกล่าไม่จบ ติดค้างในถ้ำ ตกปลาไม่ได้ (เทสต์เหยื่อก็เริ่มไม่ได้)
        //   ลำดับความสำคัญที่ถูก: **ตัวนับถอยหลังที่ระบุเวลาชัดเจนชนะเสมอ** · ป้าย "ถึงรอบ" ใช้ได้ต่อเมื่อ "ไม่มีตัวนับใดๆ บนจอ"
        if (t.length < 60 && /ถึงรอบบอส|บอสมาแล้ว/.test(t)) { sawNowLabel = true; continue; }
        if (!/บอสถัดไป/.test(t)) continue;
        // รูปแบบ ≥ 1 ชม.
        const rel = /อีก\s*(?:(\d+)\s*ชม\.?)?\s*(?:(\d+)\s*นาที)?/.exec(t);
        if (rel && (rel[1] || rel[2])) return (parseInt(rel[1] || 0, 10) * 60) + parseInt(rel[2] || 0, 10);
        // รูปแบบ < 1 ชม. (MM:SS) — ปัดลงเป็นนาที (ทริกเร็วกว่าเล็กน้อย = ปลอดภัยกว่าไปสาย)
        const ms = /อีก\s*(\d{1,2}):([0-5]\d)\b/.exec(t);
        if (ms) return parseInt(ms[1], 10);
        if (/โผล่แล้ว|กำลังโผล่|มาแล้ว/.test(t)) return 0;
      }
    } catch {}
    const chip = bossTimerChipMin();   // 🐯 v6.170: ไม่เจอป้ายแบบข้อความ → ลองอ่าน "chip โหมดย่อ" (MM:SS)
    if (chip != null) return chip;
    // เหลือทางเดียวจริงๆ ค่อยเชื่อป้าย "ถึงรอบบอสแล้ว" (v6.173: ไม่ให้ชนะตัวนับอีกต่อไป)
    // 🔁 v6.203 (ผู้ใช้เจอสด "เดินซ้ำรัวๆ"): ป้ายนี้ **ค้างยาวหลังบอสตาย** และตอนเมนูซ้ายถูกย่อจะ "หาตัวนับไม่เจอ"
    //   → เข้าเงื่อนไขนี้ทุกครั้ง → คืน 0 → ออกล่า → ถึงถ้ำอ่านได้จริง 139 นาที → กลับ → วนใหม่ทุก ~12 นาที (ปิงปอง)
    //   ตัวชี้ขาดคือ arm gate (v6.200): ถ้า "รอบนี้ล่าไปแล้ว" (disarmed) ป้ายค้างต้องไม่มีสิทธิ์ปลุกการล่าอีก
    //   → คืน null (ไม่รู้) แทน 0 · การล่าจะกลับมาได้เมื่อเห็น "ตัวนับรอบใหม่จริง" เท่านั้น
    //   (บอสโผล่ตรงหน้าในถ้ำยังตีได้ตามปกติ — bossFightHere ดูตัวบอสจริง ไม่ผ่านป้ายนี้)
    if (sawNowLabel && !bossArmed) {
      if (!bossNowLabelSeen) { bossNowLabelSeen = true; logInfo('🐯 ป้าย "ถึงรอบบอสแล้ว" ค้างอยู่ แต่รอบนี้ล่าไปแล้ว → ไม่เชื่อป้าย (รอตัวนับรอบใหม่)'); }
      return null;
    }
    if (sawNowLabel) {
      if (!bossNowLabelSeen) { bossNowLabelSeen = true; logInfo('🐯 ป้าย "ถึงรอบบอสแล้ว" + ไม่มีตัวนับถอยหลังบนจอ → ถือว่าถึงเวลาบอส'); }
      return 0;
    }
    bossNowLabelSeen = false;
    return null;
  }

  // 🔮 v6.211 (ผู้ใช้เจอสด 10:30): เกมบางจังหวะโชว์แค่ป้าย "ถึงรอบบอสแล้ว!" ที่ค้าง — **ไม่มีตัวนับถอยหลังใน DOM เลย**
  //   → บอทไม่มีสัญญาณ "อีก N นาที" ให้ออกก่อนเวลาตาม lead · เห็นบอสตอนโผล่แล้ว (0 lead) = ไปสาย พลาดบอส
  //   ความจริง: บอสมา "ทุก 3 ชม.ตรง" (ข้อมูลจริง 13:31·16:31·19:31·22:31·10:30) → ทำนายรอบถัดไปได้
  //   กลไก: จำเวลาบอสรอบถัดไป (bossNextMs) จากครั้งที่อ่าน DOM ได้ล่าสุด · พออ่าน DOM ไม่ได้ = เลื่อน bossNextMs
  //         ไปทีละ interval จนเป็นอนาคต แล้วคืนเป็น "นาที" · ทำนายผิด = ขา v6.202 ส่งกลับบ้าน + re-sync ทันทีที่ถึงถ้ำ
  const BOSS_NEXT_KEY = 'tokpla_boss_nextms';
  let bossNextMs = 0;
  try { bossNextMs = +W.localStorage.getItem(BOSS_NEXT_KEY) || 0; } catch {}
  const setBossNext = (ms) => { bossNextMs = ms; try { W.localStorage.setItem(BOSS_NEXT_KEY, String(ms)); } catch {} };
  function bossPredictNextMin() {
    // seed จาก "ไฟต์บอสล่าสุดที่บันทึกไว้" ถ้ายังไม่เคยมีฐาน (เพิ่งอัปเดตเวอร์ชัน = ทำนายได้ทันที)
    if (!bossNextMs) { try { const a = loadBossStats(); const last = a[a.length - 1]; if (last && last.ts) setBossNext(last.ts); } catch {} }
    if (!bossNextMs) return null;
    const iv = clamp(cfg.bossIntervalMin || 180, 10, 720) * 60000;
    let target = bossNextMs;
    while (target < Date.now() - 90000) target += iv;   // เลยรอบไปแล้ว → เลื่อนไปรอบถัดไป (−90วิ เผื่อบอสเพิ่งโผล่)
    return Math.max(0, Math.round((target - Date.now()) / 60000));
  }
  let bossPredictSayAt = 0;
  function bossTimerMin() {
    const dom = bossTimerDom();
    if (dom != null && dom > 0) { setBossNext(Date.now() + dom * 60000); return dom; }   // ตัวนับจริง = ความจริง · sync ตัวทำนาย
    // 🐛 v6.215 (ผู้ใช้เจอสด 23:22): ป้าย "ถึงรอบบอสแล้ว!" โชว์ทั้งที่เวลาบอสจริงยังอีก 11 ชม. (เกมเพี้ยน)
    //   → bossTimerDom คืน 0 (armed) → บอทไปเก้อทุก ~10 นาที · ต้อง cross-check กับ "เวลาบอสที่รู้จริง" (bossNextMs)
    if (dom === 0) {
      const lead = clamp(cfg.bossLeadMin, 1, 60);
      const rawGap = bossNextMs ? (bossNextMs - Date.now()) / 60000 : 0;   // ช่องว่างจริงถึงบอส (ไม่ roll)
      // เชื่อป้าย "บอสมาแล้ว" เฉพาะเมื่อเวลาจริงใกล้ตอนนี้ (บอสเพิ่งขึ้น -6 ถึง +lead+2 นาที) หรือยังไม่มีฐานให้เทียบ
      if (!bossNextMs || (rawGap >= -6 && rawGap <= lead + 2)) return 0;
      // ป้ายแย้งเวลาจริง (บอสยังอีกไกล) = ป้ายค้าง/เพี้ยน → ไม่เชื่อ ใช้ตัวทำนายแทน
      if (now() - bossPredictSayAt > 600000) {
        bossPredictSayAt = now();
        logInfo(`🔮 ป้าย "ถึงรอบบอส" โชว์ทั้งที่เวลาบอสจริงยังอีก ~${Math.round(rawGap)} นาที (เกมเพี้ยน) → ไม่เชื่อป้าย ใช้ตัวทำนาย`);
      }
      return bossPredictNextMin();
    }
    // dom == null (ไม่มีทั้งตัวนับและป้าย) → ทำนาย
    const pred = bossPredictNextMin();
    if (pred != null && now() - bossPredictSayAt > 600000) {   // log ทุก 10 นาที กันสแปม
      bossPredictSayAt = now();
      logInfo(`🔮 อ่านเวลาบอสจาก DOM ไม่ได้ (ป้ายค้าง/ไม่มีตัวนับ) → ทำนายจากรอบก่อน: อีก ~${pred} นาที (รอบทุก ${clamp(cfg.bossIntervalMin || 180, 10, 720)} นาที)`);
    }
    return pred;   // null ถ้ายังไม่เคยอ่าน DOM สำเร็จเลย (ไม่มีฐานให้ทำนาย)
  }

  // ---- เรียนรู้กราฟแมพ (persist) : map -> { targetMap: {x,y} } ----
  function loadBossGraph() { try { return JSON.parse(W.localStorage.getItem(BOSS_GRAPH_KEY) || '{}') || {}; } catch { return {}; } }
  function saveBossGraph(g) { if (restoring) return; try { W.localStorage.setItem(BOSS_GRAPH_KEY, JSON.stringify(g)); } catch {} }
  function recordBossGraph() {
    const map = bossMapId(); if (!map) return;
    const g = loadBossGraph(); g[map] = g[map] || {};
    for (const e of bossMapExits()) if (e.targetMap) g[map][e.targetMap] = { x: e.x, y: e.y, w: e.width, h: e.height };
    saveBossGraph(g);
  }
  // BFS หา "แมพถัดไปที่ควรเดินเข้า" จากกราฟที่เรียนรู้ · คืน targetMap ของ hop แรก (null = ไม่รู้ทาง)
  function bossNextHop(from, to) {
    const g = loadBossGraph();
    if (from === to) return null;
    const q = [[from]], seen = new Set([from]);
    while (q.length) {
      const path = q.shift(), last = path[path.length - 1];
      for (const nb of Object.keys(g[last] || {})) {
        if (seen.has(nb)) continue;
        const np = path.concat(nb);
        if (nb === to) return np[1];        // hop แรกจาก from
        seen.add(nb); q.push(np);
      }
    }
    return null;
  }

  // ---- เดิน WASD สังเคราะห์ ----
  const bossKeyEv = (type, code, kc) => new KeyboardEvent(type, { key: code.replace('Key', '').toLowerCase(), code, keyCode: kc, which: kc, bubbles: true });
  const BOSS_DIRK = { up: ['KeyW', 87], down: ['KeyS', 83], left: ['KeyA', 65], right: ['KeyD', 68] };
  // 🎯 v6.142: เกมฟังปุ่มที่ document (+ canvas) ไม่ใช่ window! — ทดสอบสด: ยิง window ตัวขยับ 12px, ยิง document ขยับ 706px
  // นี่คือต้นตอที่ auto-travel/หนีถ้ำ/เดินหาบอส พังมาตลอด: บอทยิงที่ W (window) เกมไม่ได้ยิน → ตัวไม่เดิน
  // ยิงทั้ง document + canvas + window (สร้าง event ใหม่ทุกเป้า เพราะ 1 event dispatch ได้ครั้งเดียว)
  const bossFireKey = (type, c, k) => {
    try { document.dispatchEvent(bossKeyEv(type, c, k)); } catch {}
    try { const cv = document.querySelector('canvas'); if (cv) cv.dispatchEvent(bossKeyEv(type, c, k)); } catch {}
    try { W.dispatchEvent(bossKeyEv(type, c, k)); } catch {}
  };
  // ⎋ v6.165: `Esc` = "ปิดหน้าต่างทั้งหมด" (ยืนยันจากตารางคีย์ลัดในเกม) — ปุ่มเดียวล้างทุก modal ที่บังจอ
  //   แก้ปัญหา "หน้าต่างค้าง" ทั้งคลาสที่เคยไล่แก้ทีละอัน: popup "ตกต่อ", จดหมาย, ร้านค้า, กระเป๋า, สมุดปลา,
  //   และ story dialog "ฤๅษีเงา" ที่ยึด input ระหว่างเดินทาง (อันตรายที่เคยทำ auto-travel พัง)
  //   ยิงช่องทางเดียวกับ bossFireKey (document + canvas + window) เพราะเกมฟังที่ document
  const gameEscape = () => {
    // 🐛 v6.171: ห้ามปิด "หน้าต่างที่ยังมีรางวัลรอรับ" — v6.165 เผลอ Esc ทิ้ง victory dialog ตอนเดินกลับบ้าน
    //   → auto-claim ไม่มีวันได้เห็น = รางวัลบอสค้างในเมล์ (เจอจริง 2 ใบ) · เจอปุ่มรับ = ข้ามการล้างจอรอบนี้
    try {
      const keep = [...document.querySelectorAll('button')].some((b) => !isBotUI(b) && b.offsetParent
        && (/เปิดจดหมาย/.test(b.textContent || '') || (b.classList.contains('tk-btn-primary') && !b.disabled && b.textContent.trim() === 'รับของ')));
      if (keep) { logInfo('⎋ ข้ามการกด Esc — มีหน้าต่างรางวัลรอรับอยู่'); return; }
    } catch {}
    for (const type of ['keydown', 'keyup']) {
      const mk = () => new KeyboardEvent(type, { key: 'Escape', code: 'Escape', keyCode: 27, which: 27, bubbles: true, cancelable: true });
      try { document.dispatchEvent(mk()); } catch {}
      try { const cv = document.querySelector('canvas'); if (cv) cv.dispatchEvent(mk()); } catch {}
      try { W.dispatchEvent(mk()); } catch {}
    }
  };
  function bossHold(dir) {
    for (const d of Object.keys(BOSS_DIRK)) {
      const want = d === dir, on = heldKeys.has(d);
      if (want && !on) { const [c, k] = BOSS_DIRK[d]; bossFireKey('keydown', c, k); heldKeys.add(d); }
      else if (!want && on) { const [c, k] = BOSS_DIRK[d]; bossFireKey('keyup', c, k); heldKeys.delete(d); }
    }
  }
  const bossReleaseAll = () => bossHold(null);
  // 🎯 v6.149: กดหลายทิศพร้อมกัน (เดินทแยง) — ใช้หลบ AoE (เข้าวงเขียว/หนีวงแดง) ต้องขยับเร็วแนวทแยง
  function bossMoveDirs(dirs) {
    for (const d of Object.keys(BOSS_DIRK)) {
      const want = dirs.includes(d), on = heldKeys.has(d);
      if (want && !on) { const [c, k] = BOSS_DIRK[d]; bossFireKey('keydown', c, k); heldKeys.add(d); }
      else if (!want && on) { const [c, k] = BOSS_DIRK[d]; bossFireKey('keyup', c, k); heldKeys.delete(d); }
    }
  }
  // 🛡️ v6.107: ทดสอบว่า "คุมตัวละครได้จริง" ก่อนออกล่า — ตรวจสดพบว่าบางสภาพ คีย์ลงทะเบียน (wasd.isDown=true)
  //   แต่ตัวไม่ขยับ (เกม/โฟกัสไม่รับ input) → ถ้าปล่อยให้ล่าทั้งที่เดินไม่ได้ = ตัวละครค้าง/เสียเวลา/หลุดจังหวะบอส
  //   เดินซ้าย-ขวาอย่างละสั้นๆ (สมมาตร กันตกบ่อ/ออกนอกเขต) แล้ววัดว่าพิกัดขยับเกิน 3px ไหม
  async function bossCanControl() {
    const p0 = bossPlayerXY(); if (!p0) return false;
    for (const dir of ['left', 'right', 'up', 'down']) {
      bossHold(dir); await sleep(280); bossReleaseAll(); await sleep(120);
      const p = bossPlayerXY();
      if (p && (Math.abs(p.x - p0.x) > 3 || Math.abs(p.y - p0.y) > 3)) return true;   // ขยับได้ = คุมได้
    }
    return false;
  }
  // เดินเข้าหา (tx,ty) จนใกล้/ติด/หมดเวลา — คืน 'arrived'|'stuck'|'timeout'|'mapchanged'|'err'
  async function bossWalkTo(tx, ty, opts = {}) {
    const thresh = opts.thresh || 20, maxMs = opts.maxMs || 22000, startMap = bossMapId();
    // 🐛 v6.221: opts.anyMode = ผู้เรียกที่ "ไม่ใช่บอส/ปลาเทพ" (เก็บหีบ ฯลฯ) — เดิม gate นี้ทำให้ no-op เงียบเมื่อ bossHunt ปิด (ค่า default!)
    const active = () => enabled && (opts.anyMode || isOn('bossHunt') || mythicActive());
    const t0 = now(); let lastX = null, lastY = null, stuck = 0, slide = 0, slideDir = 1;
    try {
      while (active() && now() - t0 < maxMs) {   // v6.132: โหมดล่าปลาเทพยืมระบบเดิน — ห้ามผูกกับสวิตช์ล่าบอส
        if (bossMapId() !== startMap) { bossReleaseAll(); return 'mapchanged'; }
        const p = bossPlayerXY(); if (!p) { bossReleaseAll(); return 'err'; }
        const dx = tx - p.x, dy = ty - p.y;
        if (Math.abs(dx) < thresh && Math.abs(dy) < thresh) { bossReleaseAll(); return 'arrived'; }
        if (lastX != null && Math.abs(p.x - lastX) < 3 && Math.abs(p.y - lastY) < 3) stuck++; else stuck = 0;
        lastX = p.x; lastY = p.y;
        if (stuck > 20) { bossReleaseAll(); return 'stuck'; }
        // 🧱 v6.144: ติด → "สไลด์" แกนตั้งฉากเป็นชุดยาว (~12 tick) สลับทิศทุกครั้งที่ติดใหม่ (up↔down / left↔right)
        //   เดิม: แค่สลับแกนราย tick + ยอมแพ้ stuck>10 → ข้ามสะพาน/เลี่ยงแม่น้ำไม่ได้ · พิสูจน์สด: สไลด์ยาวสลับทิศ = ข้ามสะพาน river_bank สำเร็จ
        if (stuck >= 4 && slide === 0) { slide = 12; slideDir = -slideDir; }
        let dir;
        if (slide > 0) {
          slide--;
          const slideX = Math.abs(dx) <= Math.abs(dy);   // แกนหลัก Y → สไลด์แกน X (และกลับกัน)
          dir = slideX ? (slideDir > 0 ? 'right' : 'left') : (slideDir > 0 ? 'down' : 'up');
        } else {
          dir = (Math.abs(dx) > Math.abs(dy)) ? (dx > 0 ? 'right' : 'left') : (dy > 0 ? 'down' : 'up');
        }
        bossHold(dir);
        await sleep(140);
      }
    } finally { bossReleaseAll(); }
    return 'timeout';
  }

  // 🎮 v6.146: ใช้ A* pathfinder "ในตัวเกม" (scene.autoWalker) เดินข้ามแมพอัตโนมัติ — เลี่ยงสิ่งกีดขวาง (สระบัว/แม่น้ำ) + ข้ามแมพเอง
  //   ทดสอบสด: navigate({x,y,mapId}) เรียกครั้งเดียว เกมเดินยาว sea_dock↔boss_cave ครบ 3 แมพ (~17-28s) เลี่ยงสระ/ข้ามสะพานเนียน 0 ติด
  //   ⚠️ ต้องมี mapId! (planCurrentLeg: currentMapId()===target.mapId → เดินในแมพ; ไม่งั้นเข้า branch ข้ามแมพหา mapId=undefined = fail)
  //   เกม pump step() เองใน update loop → ไม่ต้องกดปุ่มเอง · จุดถึงต่อแมพ = โซนตกปลา/สู้ (เดินไปจุดไหนก็ได้ เกมหาเส้นเอง)
  const BOSS_NAV_TARGET = { boss_cave: { x: 841, y: 445 }, sea_dock: { x: 350, y: 490 }, village: { x: 752, y: 490 }, river_bank: { x: 1467, y: 700 }, fisher_town: { x: 687, y: 770 }, ice_village: { x: 700, y: 500 }, lotus_marsh: { x: 700, y: 500 } };
  const gameWalker = () => { try { const sc = getPhaserScene(); return sc && sc.autoWalker && typeof sc.autoWalker.navigate === 'function' ? sc.autoWalker : null; } catch { return null; } };
  async function bossGameNavTo(targetMap, maxMs = 90000, anyMode = false) {
    gameEscape();   // ⎋ v6.165: story dialog (เช่น "ฤๅษีเงา") ยึด input ระหว่างเดินทาง = ตัวไม่เดิน — ล้างก่อนเสมอ
    const aw = gameWalker(); if (!aw) return false;
    const t = BOSS_NAV_TARGET[targetMap] || { x: 700, y: 500 };
    const t0 = now(); let lastNav = 0, lastP = null, stillFor = 0;
    // 🐛 v6.221: anyMode = ผู้เรียกที่ไม่ใช่บอส/ปลาเทพ (ธุระเมือง NPC) — เดิม no-op เงียบเมื่อ bossHunt ปิด → ธุระเมืองพัง + วน bag-full
    while (enabled && (anyMode || isOn('bossHunt') || mythicActive()) && now() - t0 < maxMs) {
      const cur = bossMapId(), p = bossPlayerXY();
      if (cur === targetMap && p && Math.abs(p.x - t.x) < 70 && Math.abs(p.y - t.y) < 70) { aw.cancel && aw.cancel(); return true; }
      // นับว่า "นิ่ง" (ไม่ขยับ) กี่รอบ — ถ้านิ่งนานทั้งที่ยังไม่ถึง = สั่ง navigate ใหม่ (เผื่อ NPC/หลุด)
      if (lastP && p && Math.abs(p.x - lastP.x) < 3 && Math.abs(p.y - lastP.y) < 3) stillFor++; else stillFor = 0;
      lastP = p;
      if ((!aw.walking || stillFor >= 6) && now() - lastNav > 2500) {
        lastNav = now(); stillFor = 0;
        let ok = false; try { ok = aw.navigate({ x: t.x, y: t.y, mapId: targetMap }); } catch {}
        if (!ok) { if (bossMapId() === targetMap) return true; return false; }   // หาเส้นไม่ได้ → ให้ fallback ทำต่อ (ยกเว้นถึงแล้ว)
      }
      await sleep(400);
    }
    return bossMapId() === targetMap;
  }
  // เดินทางไปแมพเป้าหมาย (ข้ามหลายแมพผ่านกราฟ) — คืน true ถ้าถึง
  async function bossTravelTo(targetMap) {
    // 🎮 v6.146: ลอง A* ในตัวเกมก่อน (เชื่อถือได้กว่าเดิน WASD สุ่ม + ข้ามแมพเอง) · ไปไม่ถึง = fallback วิธีเดิม (waypoint + wall-slide)
    if (gameWalker()) {
      say(`👹 เดินทาง (A* เกม): → ${targetMap}`);
      if (await bossGameNavTo(targetMap)) return true;
      say('👹 A* เกมไปไม่ถึง — สลับไปเดินเอง');
    }
    for (let hop = 0; hop < 10 && enabled && (isOn('bossHunt') || mythicActive()); hop++) {   // v6.132: ล่าปลาเทพใช้ bossTravelTo ด้วย — เดิม bossHunt ปิด = เดินไม่ออกเงียบๆ
      const cur = bossMapId();
      if (!cur) { await sleep(1000); continue; }
      if (cur === targetMap) return true;
      recordBossGraph();
      let nextTarget = bossNextHop(cur, targetMap);
      // v6.139: ไปถ้ำบอสแต่ยังไม่รู้ route → มุ่งไป "village" ก่อน (boss_cave ต่อ village) → ถึง village = เรียน village→boss_cave (passive) แล้วไปต่อ
      if (!nextTarget && targetMap === BOSS_MAP && cur !== 'village') nextTarget = bossNextHop(cur, 'village');
      const exits = bossMapExits();
      // ไม่รู้ทาง → heuristic: ลอง "หมู่บ้าน" (hub) ก่อน ไม่งั้นสำรวจ exit แรกที่ยังไม่เคยไป
      let exit = nextTarget ? exits.find((e) => e.targetMap === nextTarget) : null;
      if (!exit) exit = exits.find((e) => e.targetMap === 'village') || exits.find((e) => e.targetMap !== bossHome) || exits[0];
      if (!exit) { say('👹 หาทางออกจากแมพนี้ไม่เจอ — ยกเลิกล่าบอส'); return false; }
      say(`👹 เดินทาง: ${cur} → ${exit.targetMap} (เป้า ${targetMap})`);
      // 🧭 v6.145: เดินตาม waypoint ที่ "เรียนรู้จากการเดินจริง" (tokpla_route_wps) ก่อนถึงปากทาง —
      //   เลี่ยงสระบัวกลาง village (เลียบขอบเหนืออ้อมสระ) + จุดติดหินก่อนสะพาน river_bank ที่เดินตรงๆ ไม่ผ่าน
      //   key = 'fromMap>toMap' · ไม่มี = เดินตรงแบบเดิม (backward-compatible) · waypoint สุดท้ายมักเป็นจุด trigger ปากทาง
      try {
        const rw = (JSON.parse(W.localStorage.getItem('tokpla_route_wps') || '{}') || {})[cur + '>' + exit.targetMap];
        if (Array.isArray(rw)) for (const wp of rw) {
          if (bossMapId() !== cur) break;
          if (await bossWalkTo(wp[0], wp[1], { thresh: 40, maxMs: 12000 }) === 'mapchanged') break;
        }
      } catch {}
      if (bossMapId() !== cur) { await sleep(1200); continue; }   // waypoint สุดท้าย trigger ปากทางแล้ว
      const r = await bossWalkTo(exit.x, exit.y, { thresh: 24 });
      if (r === 'mapchanged') { await sleep(1200); continue; }   // เข้า transition แล้ว
      // เดินถึงปากทางแล้วแต่ยังไม่เปลี่ยนแมพ → เดินย้ำเข้าโซนอีกนิด (เผื่อ trigger ต้อง overlap)
      await bossWalkTo(exit.x, exit.y + (exit.height ? 30 : 0), { thresh: 10, maxMs: 4000 });
      await waitFor(() => bossMapId() !== cur, 6000, 300);
      if (bossMapId() === cur) { say(`👹 เปลี่ยนแมพไม่สำเร็จที่ ${cur} — ลองใหม่`); await sleep(800); }
    }
    return bossMapId() === targetMap;
  }

  // orb ที่ใช้ตีบอส (aria "ตีบอส" · สำรอง orb ตกปลาปกติ) — qBtn ข้าม UI บอทแล้ว
  const bossHitOrb = () => qBtn('ตีบอส') || qBtn('ตกปลา (F)');
  // สู้บอส — ตี = เกจเดิม (กด orb ตีบอส → เกจหมุน → กดตอนเข็มเข้าแถบแดง) · หลบ = กดกระโดด · บอสตาย/หาย = จบ
  // 🦘 v6.116 (ยืนยันจาก log จริง): การหลบ = "กดกระโดด" ไม่ใช่เดินออกวง! (log: sceneZone[raidDodge] · เตือน "🌀 บอสหมุน! กดกระโดดหลบ!")
  //   log: เตือน["🌀 บอสหมุน! กดกระโดดหลบ!"] → เตือน["💨 หลบทัน!"] · มีปุ่ม aria "กระโดด"
  function bossSpinWarning() {
    try {
      const tw = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT); let n;
      while ((n = tw.nextNode())) {
        // 🛡️ v6.181 (กฎเหล็ก #7): ข้าม UI บอทเอง — คำอธิบายในแผง "ระบบตีบอส" มีคำว่า "กระโดดหลบตอนบอสหมุน" อยู่
        //   ถ้าไม่กัน = bossSpinWarning() คืน true ตลอดทั้งไฟต์ → บอทกระโดดรัวทุก 1.2 วิ แทนที่จะตีเกจ (เสีย DPS เงียบๆ)
        if (n.parentElement && n.parentElement.closest('[data-tkbot]')) continue;
        const t = n.textContent || ''; if (/บอสหมุน|กดกระโดด|กระโดดหลบ/.test(t) && t.length < 40) return true;
      }
    } catch {}
    return false;
  }
  async function bossFight(maxMin) {
    // 🕐 v6.148: รอให้ "ครอบเวลาบอสจริง" — ถ้าบอสยังอีก N นาที ต้องรออย่างน้อย N+3 นาที
    //   บั๊กที่ทำให้พลาดบอส: bossLeadMin(เช่น 20) > bossMaxWaitMin(10) → ออกไปถ้ำ 20 นาทีก่อน แต่รอแค่ 10 → ยอมแพ้ตอนบอสยังอีก 10 นาที เดินกลับ = พลาดตลอด
    //   แก้: เวลารอ = min(45, max(maxMin, เวลาบอสจากป้าย HUD + 3)) → รอจนบอสมาจริงเสมอ ไม่ขึ้นกับ config lead/wait ที่ตั้งเพี้ยน
    const tmin = bossTimerMin();
    // 🚨 v6.202 (ผู้ใช้เจอสด 10:45): มาถึงถ้ำแล้วอ่านเวลาจริงได้ "อีก 164 นาที" แต่สูตรข้างล่างสั่ง "รอ 45 นาที"
    //   สูตร v6.148 ตั้งใจกัน "ยอมแพ้ก่อนบอสมา" แต่ไม่มีเพดานสติ → **ยิ่งบอสไกล ยิ่งยืนรอนาน** (ในถ้ำตกปลาไม่ได้ = เสียเวลาฟาร์มเปล่า)
    //   ต้นเหตุที่พามาผิดรอบ: ป้าย "ถึงรอบบอสแล้ว!" ค้างหลังบอสตาย (arm gate v6.200 กันขาไปแล้ว — อันนี้กันขากลับ)
    //   เกณฑ์: บอทจะออกเดินทางเมื่อ tmin ≤ lead → มาถึงแล้ว tmin ควรใกล้ lead · ถ้าไกลกว่ามาก = มาผิดรอบ กลับเลย
    //   (ยังรักษาเคส v6.148 ไว้: lead 20 / maxWait 10 / บอสอีก 20 นาที → 20 ≤ 20+10 = อยู่รอต่อตามเดิม)
    const leadNow = clamp(cfg.bossLeadMin, 1, 60);
    if (tmin != null && tmin > leadNow + 10 && !((raidBossState() || {}).present)) {
      const msg = `บอสยังอีก ~${tmin} นาที (ตั้งล่วงหน้าไว้ ${leadNow}) — มาผิดรอบ ไม่ยืนรอ กลับไปฟาร์มต่อ`;
      say(`👹 ${msg}`); bossEvent(`↩️ ${msg}`);
      bossWrongRound = true;   // v6.203: ไม่ได้สู้เลย → ข้าม linger/เก็บเมล์ (ไม่มีอะไรให้รอ/ให้เก็บ)
      return false;
    }
    const effMin = Math.min(45, Math.max(maxMin, (tmin != null && tmin >= 0 ? tmin : 0) + 3));
    const until = now() + effMin * 60000;
    if (effMin > maxMin) say(`👹 บอสยังอีก ~${tmin} นาที — รอในถ้ำถึง ${effMin} นาที (กันยอมแพ้ก่อนบอสมา)`);
    const fz = bossFishingZone();
    // เหยื่อจุดอ่อน (วิดีโอ: ขั้น2 มัดอ้วน / ขั้น4 กุ้งฝอย = ดาเมจ x1.5) — สลับก่อนตี (DOM ไม่ต้องเดิน)
    //   v6.121: จำขั้นเดิมไว้สลับคืนหลังสู้จบ — ไม่งั้นถ้าผู้ใช้ปิด forceBait เหยื่อจะค้างขั้นจุดอ่อนตลอด (ฟาร์มต่อผิดเหยื่อ)
    // 🎣 v6.174 (ผู้ใช้ขอ): สลับ "ชิ้นเบ็ด" ไปตัวที่อัปเกรดมาตีบอส (เช่นติดหินดาเมจบอสจากช่างหิน) แล้วสลับคืนตอนฟาร์ม
    //   เกมแยกเบ็ดเป็น instance (tokpla_rod_instance = UUID) → เบ็ด "ชนิดเดียวกันแต่อัปเกรดต่างกัน" แยกออกจากกันได้จริง
    const prevRodId = currentRodId();
    // ⛔ v6.189: ปิดการสลับเบ็ดโดยปริยาย — พิสูจน์แล้วว่า G สลับได้แค่ "tier" (ดู CHANGELOG v6.188)
    //   ผลที่เกิดจริงถ้าปล่อยไว้: บอทกด G หาชิ้นที่ไม่อยู่ในวง → เขี่ยผู้ใช้หลุดจากเบ็ดบอสที่ใส่ไว้เอง
    //   → **แล้วคืนกลับไม่ได้** (ชิ้นนอกวง G เข้าถึงได้ทางหน้ากระเป๋าเท่านั้น) = แย่กว่าไม่ทำอะไรเลย
    // v6.190: เลือกเบ็ด "ดาเมจบอส สูงสุด" ผ่านกระเป๋า (ไม่ใช้ UUID แล้ว — ทน UUID เปลี่ยนตอนตีหิน)
    if (isOn('rodSwitchOn')) {
      busy = true;
      try {
        say('👹 เลือกเบ็ดที่ดาเมจบอสสูงสุด');
        if (!(await equipRodBy('boss'))) say('⚠️ ใช้เบ็ดชิ้นเดิมตีบอสแทน');
      } catch (e) { logErr('เลือกเบ็ดบอสล้มเหลว', e); }
      finally { busy = false; }
    } else {
      logInfo('👹 ปิดการสลับเบ็ดไว้ — ใช้เบ็ดที่ใส่อยู่ตีบอส');
    }
    let prevBaitTier = null;
    if (cfg.bossBaitTier > 0 && currentBait() && currentBait().tier !== cfg.bossBaitTier) {
      prevBaitTier = currentBait().tier;
      busy = true;
      try { say(`👹 สลับเหยื่อจุดอ่อนขั้น ${cfg.bossBaitTier} (x1.5 ดาเมจ)`); await cycleTo('เลือกเหยื่อ', cfg.bossBaitTier, () => currentBait()?.tier); } catch {}
      finally { busy = false; }
    }
    gameEscape();   // ⎋ v6.165: ล้าง dialog/หน้าต่างค้างก่อนเริ่มตี (popup ตกปลา/ร้าน/story ฤๅษีเงา บังปุ่มตี+ยึด input)
    // ⚡ v6.176: **ข้ามการเดินไปขอบบ่อถ้าบอสโผล่แล้ว** — การตี = คลิกปุ่ม orb ไม่ต้องยืนใกล้บ่อเลย (คอมเมนต์เดิมก็ระบุไว้)
    //   เดิมเดินก่อนเสมอ (นานได้ถึง 12 วิ) → บอสโผล่แล้วบอท "ดูเหมือนไม่ทำอะไร" 14 วิ (ผู้ใช้เห็นแล้วต้องกดตีเอง)
    //   ยังเดินอยู่ในกรณีมารอ "ก่อน" บอสโผล่ (ว่างอยู่แล้ว ไม่เสียโอกาสตี)
    const bossAlready = !!(raidBossState() || {}).present;
    if (fz && !bossAlready) await bossWalkTo(fz.x, fz.y + 140, { thresh: 40, maxMs: 12000 });   // ยืนขอบบ่อ (ในรัศมี cast)
    else if (bossAlready) logInfo('⚡ บอสโผล่แล้ว — ข้ามการเดินไปขอบบ่อ เข้าตีทันที');
    say('👹 ถึงถ้ำบอสแล้ว — สู้ (เกจ กดแถบแดง) + หลบด้วยกระโดดตอนบอสหมุน');
    if (isOn('tgOn')) void tgSend('👹 <b>ถึงถ้ำบอส</b> — เริ่มตี (เกจ→กดแถบแดง) + กระโดดหลบตอนบอสหมุน');
    let killed = false, hits = 0, gaugePresses = 0, dodges = 0, lastEngage = 0, lastPress = 0;
    let bossSeen = false, goneAt = 0, lastSpinChk = 0, spinNow = false, lastJump = 0, bossDodging = false, aoeDodges = 0, deaths = 0;
    // ⚙️ v6.162: เกจอัจฉริยะ — วัดความเร็วเข็ม (deg/s, EMA) แล้วกด "ล่วงหน้า" ชดเชย latency ~120ms
    //   เดิมกดเฉพาะเข็มอยู่ในแถบ ±2° เป๊ะ → เข็มเร็ว+latency = กดตอนเข็มเลยแถบไปแล้ว/พลาดหน้าต่างทั้งรอบ
    let gPrevAng = null, gPrevAt = 0, gVel = 0;
    const gaugeReady = (g) => {
      let na = g.ang; if (g.a0 < 0 && na > 180) na -= 360;
      const t = now();
      if (gPrevAng != null && t > gPrevAt && t - gPrevAt < 500) {
        let d = na - gPrevAng; if (d > 180) d -= 360; else if (d < -180) d += 360;
        const v = d / ((t - gPrevAt) / 1000);
        if (Math.abs(v) < 720) gVel = gVel ? gVel * 0.6 + v * 0.4 : v;   // กัน spike ตอนเกจรีเซ็ตรอบใหม่
      }
      gPrevAng = na; gPrevAt = t;
      const inb = (x) => x >= g.a0 - 2 && x <= g.a1 + 2;
      return inb(na) || inb(na + gVel * 0.12);   // ตอนนี้ หรือ ที่คาดว่าเข็มจะอยู่ตอนคลิกถึงเกม
    };
    // 🧭 v6.162: recenter — ยืน "กึ่งกลางวง AoE" ให้การหลบครั้งถัดไปวิ่งสั้นสุด (ข้อมูลไฟต์จริง: วงโผล่ x∈{671,946,1011} y≈744
    //   ยืนสุดปลายเคยต้องวิ่ง 399px) · seed จุดกลางจากข้อมูลจริง 1 จุด + เก็บวงใหม่ทุกครั้ง = ปรับตัวเองถ้า pattern เปลี่ยน
    // 🧭 v6.178: จำวง AoE "ข้ามไฟต์" (localStorage) — เดิมเริ่มนับใหม่ทุกไฟต์จาก seed จุดเดียว จุดกลางเลยแกว่งช่วงต้นไฟต์
    //   สะสมทุกวงที่เคยเห็น (เก็บ 30 วงล่าสุด) → จุดกลางนิ่งขึ้นเรื่อยๆ ทุกไฟต์ · pattern เกมเปลี่ยน = ค่าเฉลี่ยเลื่อนตามเอง
    let aoeSamples = [[841, 744]];
    try { const sv = JSON.parse(W.localStorage.getItem('tokpla_aoe_samples') || 'null'); if (Array.isArray(sv) && sv.length) aoeSamples = sv; } catch {}
    let lastRecenter = 0, recenters = 0;
    // 📊 v6.191: วัด HP จริงตลอดไฟต์ (start→ต่ำสุด→จบ) + นับ "ค้างหลบ" (ปากทางกินทิศหลบหมด)
    //   ผู้ใช้ยืนยัน: เกมไม่ฟื้นเลือด → ทางรอดเดียวคือหลบไม่ให้โดน · ต้องรู้ว่าเสียเลือดตรงไหนก่อนปรับ
    let hpStart = null, hpMin = 101, lastHpChk = 0, aoeStalls = 0;
    let fightT0 = 0, lastContrib = { dmg: null, pct: null };   // 📊 v6.195: จับเวลาไฟต์ (ตั้งตอนเห็นบอสครั้งแรก) + อ่านดาเมจล่าสุด
    // 🛡️ v6.175: เดิมเงื่อนไขลูปมี isOn('bossHunt') → **ปิดโหมดล่าบอสกลางไฟต์ = ทิ้งบอสทันที**
    //   เจอสด 16:30:14: เข้าตีตอน 16:30:00 แล้วโดนตัดจบใน 14 วิ ("กดเกจ 0") ทั้งที่บอสยืนอยู่ตรงหน้า
    //   ซ้ำร้าย พอเปิดโหมดใหม่ ขา "เข้าถ้ำ" ชนกับขา "กลับบ้าน" → แมพเด้ง ถ้ำ↔บ่อตกปลา 6 รอบ โดนตีฟรีจน HP เหลือ 16%
    //   ใหม่: ถ้า "เห็นบอสแล้ว" ให้ตีต่อจนจบไฟต์ (บอสตาย/หาย/หมดเวลา) แล้วค่อยเคารพการปิดโหมด
    //         ปิดโหมดตอนยัง "ไม่เห็นบอส" (ยังรออยู่) = ออกได้ทันทีตามเจตนาผู้ใช้
    while (enabled && now() < until) {
      if (!isOn('bossHunt') && !bossSeen) break;
      const rb = raidBossState();
      const present = !!(rb && rb.present);
      if (present) { bossSeen = true; goneAt = 0; if (!fightT0) fightT0 = now(); }
      // 📊 วัด HP แบบ throttle (getPhaserScene แพง) — เก็บ start ครั้งแรกที่อ่านได้ + ต่ำสุดตลอดไฟต์
      if (present && now() - lastHpChk > 400) {
        lastHpChk = now(); const _h = bossPlayerHpPct();
        if (_h != null) { if (hpStart == null) hpStart = _h; if (_h < hpMin) hpMin = _h; }
        // อ่านดาเมจ/ส่วนร่วมล่าสุดไว้ (HUD หายหลังบอสตาย — ต้องเก็บระหว่างยังเห็น)
        const _c = readBossContribution(); if (_c.dmg != null) lastContrib = _c;
      }
      if (rb && rb.dead) { killed = true; break; }
      // 💀 v6.149: ตายถูกส่งออกจากถ้ำ (บ่อน้ำหมู่บ้าน · เลือดหมดจากโดน AoE) → รอ respawn ~10 วิ แล้วกลับเข้าถ้ำสู้ต่อ (เดิมหลุดออก = จบเลย เสีย reward)
      if (bossSeen && bossMapId() !== BOSS_MAP) {
        bossReleaseAll(); bossDodging = false; deaths++;
        // v6.157: หลุดออกจากถ้ำได้ 2 กรณี — ตายจริง (เลือดหมด→respawn ~10วิ) หรือเดินหลบทะลุปากทาง (แก้แล้วด้วย exit-clamp แต่กันเหนียว)
        //   HP ~0 = ตายจริงต้องรอเกิดใหม่ · HP ยังอยู่ = แค่เดินออก กลับได้เลย (ไม่เสีย 10 วิเปล่า)
        const hp = bossPlayerHpPct(), died = (hp == null || hp < 8);
        say(`⚠️ หลุดออกจากถ้ำ (ครั้งที่ ${deaths}${died ? ' · เลือดหมด/ตาย' : ' · เดินหลบออก'}) — กลับเข้าถ้ำสู้ต่อ`);
        await sleep(died ? 10000 : 800);   // ตาย = รอ respawn · เดินออก = กลับทันที
        if (!(await bossGameNavTo(BOSS_MAP, 60000))) { say('⚠️ กลับเข้าถ้ำไม่สำเร็จ — เลิกสู้'); break; }
        continue;
      }
      // 🏁 บอสเคยมาแล้วตอนนี้หายไป (ยืนยัน >1.5วิ กันอ่านพลาด) → จบทันที เก็บ reward กลับไปฟาร์ม (ไม่รอครบ maxMin เปล่าๆ)
      if (bossSeen && !present) {
        if (!goneAt) goneAt = now();
        else if (now() - goneAt > 1500) break;
      }
      // 🎯 v6.149: หลบ AoE ด้วยการ "เดิน" — scene.raidDodge {mode:'reach'(เขียว→เข้าวง dist<r) | 'flee'(แดง→หนีออก dist>r), cx,cy,r}
      //   นี่คือปัญหาหลักที่ผู้ใช้บอก: ไม่เข้าวงเขียว/ไม่หนีวงแดง = โดนตี→มึน→ตาย · เดิมบอทแค่กดกระโดด ไม่ขยับตัว
      //   (deadline เป็น Phaser time เทียบ Date.now ไม่ได้ → เช็คแค่ raidDodge ยังอยู่ + ยังไม่ dodged)
      const _sc = getPhaserScene(); const raid = _sc && _sc.raidDodge;
      if (raid && _sc.player && !raid.dodged) {
        const dx = raid.cx - _sc.player.x, dy = raid.cy - _sc.player.y, dist = Math.hypot(dx, dy);
        const green = raid.mode === 'reach';                     // reach=เขียว(เข้า) · flee=แดง(หนี)
        // 🎯 v6.156: relax margin (เกมเช็ค dist<r/dist>r เป๊ะ) — หยุดขยับทันทีที่ "ปลอดภัยพอ+เผื่อ latency นิดเดียว"
        //   เดิม 0.7/1.3 ต้องวิ่งเลยเส้นเยอะ = ช้า/ไม่ทัน deadline (โดยเฉพาะวงโผล่ไกล) → ตาย · 0.9/1.12 = วิ่งน้อยลง ถึงเร็วขึ้น
        const safe = green ? dist < raid.r * 0.9 : dist > raid.r * 1.12;
        if (!safe) {
          const gx = green ? dx : -dx, gy = green ? dy : -dy;     // เขียว=เข้าหาศูนย์ · แดง=ทิศตรงข้าม
          const dirs = [];
          if (gx > 6) dirs.push('right'); else if (gx < -6) dirs.push('left');   // dead zone แคบลง (6) = เล็งแม่นขึ้น
          if (gy > 6) dirs.push('down'); else if (gy < -6) dirs.push('up');
          // 🚪 v6.157: กัน "เดินหลบทะลุปากทางออกถ้ำ" (boss_cave→village @≈836,915) แล้วหลุดออกจากถ้ำกลางสู้ (เข้าใจผิดว่าตาย)
          //   ต้นเหตุ: หลบ (เข้าเขียว/หนีแดง) ดันตัวไปทางปากทาง → เหยียบพอร์ทัล → เปลี่ยนแมพ · แก้: ใกล้ปากทาง <120px = ตัด "ทิศที่เข้าหาปากทาง" ออก (ยังเดินแนวขนานหลบได้ แต่ไม่ออกถ้ำ)
          let clampExit = null;    // ปากทางที่ใกล้สุด — ไว้คำนวณ slide ถ้าตัดทิศจนหมด
          try {
            for (const ex of (bossMapExits() || [])) {
              const ecx = ex.x + (ex.w || 0) / 2, ecy = ex.y + (ex.h || 0) / 2, edx = ecx - _sc.player.x, edy = ecy - _sc.player.y;
              const ed = Math.hypot(edx, edy);
              if (ed < 120) {
                if (!clampExit || ed < clampExit.d) clampExit = { dx: edx, dy: edy, d: ed };
                let i; if (edx > 10) { if ((i = dirs.indexOf('right')) >= 0) dirs.splice(i, 1); } else if (edx < -10 && (i = dirs.indexOf('left')) >= 0) dirs.splice(i, 1);
                if (edy > 10) { if ((i = dirs.indexOf('down')) >= 0) dirs.splice(i, 1); } else if (edy < -10 && (i = dirs.indexOf('up')) >= 0) dirs.splice(i, 1);
              }
            }
          } catch {}
          // 🚪 v6.191: ปากทางกินทิศหลบจนหมด แต่ยัง "ไม่ปลอดภัย" → เดิม bossMoveDirs([]) = ยืนนิ่งกิน AoE เต็มๆ
          //   แก้: เลื่อนตัว "ขนานปากทาง" (perpendicular) ทางที่มุ่งเข้าที่ปลอดภัยมากสุด — ขยับหลบได้โดยไม่ทะลุออกถ้ำ
          //   ยังไม่มี log ยืนยันว่าเคยเกิดจริง จึงนับ aoeStalls ไว้ให้ไฟต์หน้าพิสูจน์ (วัดก่อนเชื่อ)
          if (!dirs.length && clampExit) {
            const perps = [[-clampExit.dy, clampExit.dx], [clampExit.dy, -clampExit.dx]];
            const s = perps.sort((a, b) => (b[0] * gx + b[1] * gy) - (a[0] * gx + a[1] * gy))[0];
            if (s[0] > 6) dirs.push('right'); else if (s[0] < -6) dirs.push('left');
            if (s[1] > 6) dirs.push('down'); else if (s[1] < -6) dirs.push('up');
            if (dirs.length) { aoeStalls++; if (aoeStalls === 1) logInfo(`🚪 หลบชิดปากทาง — เลื่อนขนานแทนยืนนิ่ง (${dirs.join('+')})`); }
          }
          bossMoveDirs(dirs);
          if (!bossDodging) {
            bossDodging = true; aoeDodges++;
            aoeSamples.push([Math.round(raid.cx), Math.round(raid.cy)]);   // 🧭 เก็บตำแหน่งวงจริง — จุดกลาง recenter ปรับตามข้อมูลสด
            if (aoeSamples.length > 30) aoeSamples = aoeSamples.slice(-30);
            try { W.localStorage.setItem('tokpla_aoe_samples', JSON.stringify(aoeSamples)); } catch {}   // v6.178: จำข้ามไฟต์
            try { _sc.autoWalker.cancel(); } catch {}                 // กัน autoWalker (recenter) เดินแย้งกับ WASD หลบ
            // v6.156: log ตำแหน่งวง (ออกแบบ recenter) · v6.159: + จับ "ตอนหลบตีบอสได้ไหม" — orb เปิด/มีเกจ = ตีระหว่างหลบได้ (ไม่ต้อง facetank) · HP = ประเมิน budget โดน AoE
            const _o = bossHitOrb(), _gz = readGaugeWheel(), _hp = bossPlayerHpPct();
            logInfo(`🎯 ${green ? 'เข้าวงเขียว' : 'หนีวงแดง'} วง@${Math.round(raid.cx)},${Math.round(raid.cy)} r${Math.round(raid.r)} · ตัว@${Math.round(_sc.player.x)},${Math.round(_sc.player.y)} ระยะ${Math.round(dist)} · orb=${_o ? (_o.disabled ? 'ปิด' : 'เปิด') : 'ไม่มี'} เกจ=${_gz && _gz.ang != null ? 'มี' : 'ไม่มี'} HP=${_hp != null ? Math.round(_hp) + '%' : '?'}`);
          }
          // ⚔️ v6.161: "ตีระหว่างหลบ" — diagnostic v6.159 ยืนยันสด 7/7 ครั้ง: ตอน AoE ทุกครั้ง `orb=เปิด เกจ=มี`
          //   = บอสโจมตีได้ระหว่าง AoE · เดิม continue ข้ามการตี = ทิ้ง DPS ฟรี (~7 ช่วง/ไฟต์)
          //   เดินหลบ (WASD ค้าง) กับกดเกจ (คลิกปุ่ม) เป็นคนละ input channel → ทำพร้อมกันได้ ไม่ยกเลิกการหลบ
          //   ⚠️ ดีกว่า "facetank ยอมเลือดลด" ที่ผู้ใช้ถาม: ได้ดาเมจเพิ่มโดยไม่โดนตีเพิ่มเลย
          const gd = readGaugeWheel();
          if (gd && gd.ang != null && gaugeReady(gd)) {
            const orbd = bossHitOrb();
            if (orbd && !orbd.disabled && now() - lastPress > 60) { lastPress = now(); fireClick(orbd); gaugePresses++; }
          }
          await sleep(80); continue;   // react ไว กว่าจังหวะตี
        }
        if (bossDodging) { bossReleaseAll(); bossDodging = false; }   // ถึงที่ปลอดภัยแล้ว → ปล่อยปุ่ม
      } else if (bossDodging) { bossReleaseAll(); bossDodging = false; }
      // 🧭 v6.162: recenter — ไม่มีวง AoE ค้าง + ห่างจุดกลาง >60px → เดิน (game A*) ไปยืนกลางสนาม
      //   ให้การหลบครั้งถัดไปวิ่ง ≤~75px (แทน 245-399px จากสุดปลาย) = แทบไม่เสียจังหวะตี · ตีระหว่างเดินได้ (v6.161 คนละ channel)
      if (!raid && present && now() - lastRecenter > 4000 && _sc && _sc.player) {
        const mx = aoeSamples.reduce((s, a) => s + a[0], 0) / aoeSamples.length, my = aoeSamples.reduce((s, a) => s + a[1], 0) / aoeSamples.length;
        const dHome = Math.hypot(mx - _sc.player.x, my - _sc.player.y);
        if (dHome > 60) {
          lastRecenter = now(); recenters++;
          try { _sc.autoWalker.navigate({ x: Math.round(mx), y: Math.round(my), mapId: BOSS_MAP }); } catch {}
          // v6.169: log ครั้งแรกของไฟต์ — ยืนยัน recenter ทำงาน + เห็นจุดกลางที่คำนวณได้จริง (เดิมเงียบสนิท วัดผลไม่ได้)
          if (recenters === 1) logInfo(`🧭 recenter → กลางสนาม @${Math.round(mx)},${Math.round(my)} (จาก ${aoeSamples.length} วง) · ตัวห่าง ${Math.round(dHome)}px`);
        }
      }
      const orb = bossHitOrb();
      // (1) 🦘 หลบ: บอสหมุน → กดกระโดด · v6.117: เช็คเตือน (TreeWalker แพง) ทุก 180ms + กระโดด 1 ครั้ง/สปิน (cooldown 1.2วิ)
      if (now() - lastSpinChk > 180) { lastSpinChk = now(); spinNow = bossSpinWarning(); }
      if (spinNow && now() - lastJump > 1200) {
        lastJump = now();
        // 🦘 v6.165: Space = "กระโดด" คีย์ทางการของเกม (ตอนสู้บอสไม่ได้ตกปลา → Space จึงเป็นกระโดด ไม่ชนกับเกจ)
        //   ยิงคีย์ตรงเสถียรกว่าไล่หาปุ่มใน DOM · คงปุ่ม/tryJump ไว้เป็นสำรองซ้อน 2 ชั้น
        bossFireKey('keydown', 'Space', 32); bossFireKey('keyup', 'Space', 32); dodges++;
        logInfo('🦘 บอสหมุน — กระโดดหลบ (Space)');
        const jump = qBtn('กระโดด');
        if (jump && !jump.disabled) fireClick(jump);
        else { try { getPhaserScene()?.player?.tryJump?.(); } catch {} }
        await sleep(300); continue;
      }
      // (2) ⚙️ เกจโผล่ (กำลังตี) → กดตอนเข็มเข้าแถบแดง [a0,a1] (เกจบอส=conic เหมือนตกปลา · readGaugeWheel มี fallback)
      const g = readGaugeWheel();
      if (g && g.ang != null) {
        // ⚙️ v6.162: ใช้ gaugeReady — เทียบทั้ง "ตำแหน่งเข็มตอนนี้" และ "ตำแหน่งที่คาด (ความเร็วเข็ม × latency 120ms)"
        const inRed = gaugeReady(g);
        if (inRed && orb && !orb.disabled && now() - lastPress > 60) { lastPress = now(); fireClick(orb); gaugePresses++; }
        await sleep(30);   // ถี่พอจับเข็ม
      } else if (orb && !orb.disabled && now() - lastEngage > 220) {
        lastEngage = now(); fireClick(orb); hits++;   // ไม่มีเกจ + ปุ่มกดได้ = เริ่มตีครั้งใหม่ (คลิก orb ตีบอส)
        await sleep(60);
      } else { await sleep(120); }
    }
    // สลับเหยื่อคืนขั้นเดิม (สู้จบแล้ว — เหยื่อจุดอ่อนไว้ตีบอสเท่านั้น)
    if (prevBaitTier != null && currentBait()?.tier !== prevBaitTier) {
      busy = true;
      try { await cycleTo('เลือกเหยื่อ', prevBaitTier, () => currentBait()?.tier); } catch {}
      finally { busy = false; }
    }
    // 🎣 v6.190: คืนเบ็ด — เลือกชิ้นที่ "โบนัสปลา" สูงสุดกลับมาฟาร์ม (ไม่อิง UUID เดิมแล้ว)
    if (isOn('rodSwitchOn')) {
      busy = true;
      try { say('🎣 สลับกลับเบ็ดสำหรับฟาร์ม'); await equipRodBy('farm'); }
      catch (e) { logErr('เลือกเบ็ดฟาร์มล้มเหลว', e); }
      finally { busy = false; }
    }
    const outcome = killed ? '✅ บอสตาย!' : bossSeen ? '🏁 บอสหมดเวลา/หายไป — เก็บ reward ตามส่วนที่ช่วยตี' : '⌛ บอสไม่มาในเวลาที่รอ';
    // v6.169: เพิ่มตัวเลขวัดผลของใหม่ — recenter (v6.162) · ความเร็วเข็มที่วัดได้ (เกจอัจฉริยะ v6.162) · จุดกลางวง AoE ที่เรียนรู้
    //   เดิมสรุปไม่มีตัวเลขพวกนี้เลย = อัปเกรดแล้ววัดไม่ได้ว่าดีขึ้นจริงไหม
    const aoeMid = aoeSamples.length > 1 ? ` · กลางวง ${Math.round(aoeSamples.reduce((s, a) => s + a[0], 0) / aoeSamples.length)},${Math.round(aoeSamples.reduce((s, a) => s + a[1], 0) / aoeSamples.length)}` : '';
    // 📊 v6.191: HP โปรไฟล์ (start→จบ + ต่ำสุด) แทนตัวเลข HP เดี่ยว — วัดว่าหลบดีขึ้นไหมโดยดู "ต่ำสุด" ไม่ใช่แค่ตอนจบ
    const hpEnd = bossPlayerHpPct();
    const hpTxt = `HP ${hpStart != null ? Math.round(hpStart) + '%' : '?'}→${hpEnd != null ? Math.round(hpEnd) + '%' : '?'}${hpMin <= 100 ? ` (ต่ำสุด ${Math.round(hpMin)}%)` : ''}`;
    // 📊 v6.195: อ่านดาเมจครั้งสุดท้ายเผื่อ HUD ยังอยู่ — v6.200: เฉพาะเมื่อ "เจอบอสจริง" เท่านั้น
    //   (ข้อมูลจริงพิสูจน์: เที่ยว noshow 22:49/23:11 ติดดาเมจ 9,680 ของไฟต์ 22:31 มา — HUD "ของเรา" ค้างข้ามรอบ)
    if (bossSeen) { const _c = readBossContribution(); if (_c.dmg != null && (lastContrib.dmg == null || _c.dmg >= lastContrib.dmg)) lastContrib = _c; }
    const dmgTxt = lastContrib.dmg != null ? ` · ดาเมจ ${lastContrib.dmg.toLocaleString()}${lastContrib.pct != null ? ` (${lastContrib.pct}%)` : ''}` : '';
    const stat = `เริ่มตี ${hits} · กดเกจ ${gaugePresses} · กระโดด ${dodges} · หลบ AoE ${aoeDodges}${aoeStalls ? `(ค้างปากทาง ${aoeStalls})` : ''} · recenter ${recenters} · เข็ม ${Math.round(Math.abs(gVel))}°/s · ตาย ${deaths} · ${hpTxt}${dmgTxt}`;
    logInfo(`👹 จบสู้บอส: ${outcome} · ${stat}${aoeMid}`);
    bossEvent(`🏁 จบไฟต์: ${outcome}${dmgTxt} · กดเกจ ${gaugePresses} · หลบ ${aoeDodges} · ตาย ${deaths}`);
    // 📊 v6.195: เก็บสถิติไฟต์นี้เข้า ring buffer (N ครั้งล่าสุด · ตั้งที่ bossStatKeep)
    recordBossFight({
      ts: Date.now(),
      outcome: killed ? 'kill' : bossSeen ? 'timeout' : 'noshow',
      dmg: lastContrib.dmg, pct: lastContrib.pct,
      gauge: gaugePresses, hits, aoeDodges, aoeStalls, recenters, deaths,
      hpStart: hpStart != null ? Math.round(hpStart) : null,
      hpMin: hpMin <= 100 ? Math.round(hpMin) : null,
      hpEnd: hpEnd != null ? Math.round(hpEnd) : null,
      gVel: Math.round(Math.abs(gVel)), map: bossMapId() || BOSS_MAP,
      durMs: fightT0 ? Math.round(now() - fightT0) : 0,
    });
    if (isOn('tgOn')) void tgSend(`👹 <b>จบสู้บอส</b> ${esc(outcome)}\n${esc(stat)}\nกำลังกลับไปฟาร์ม`);
    say(`👹 ${outcome}`);
    bossReleaseAll();
    return killed;
  }

  function saveBossState() { try { W.localStorage.setItem(BOSS_STATE_KEY, JSON.stringify({ phase: bossPhase, home: bossHome, ts: Date.now() })); } catch {} }
  function clearBossState() { try { W.localStorage.removeItem(BOSS_STATE_KEY); } catch {} }

  // 👹 v6.134: ซื้อเหยื่อจุดอ่อนบอสให้พร้อม "ก่อน" เดินเข้าถ้ำ — ในถ้ำบอสไม่มีร้าน ซื้อไม่ได้
  //   (เดิม bossFight แค่ "สลับ" ไปขั้นจุดอ่อน ถ้าไม่มีในกระเป๋า = ตีด้วยเหยื่อผิด ไม่ได้ดาเมจ x1.5)
  //   1 แพ็ค (100 ชิ้น) พอตีบอส 1 ตัว (~110 วิ) เหลือเผื่อรอบถัดไป · ราคาถูก (ขั้น2 = ~1,200🪙)
  async function ensureBossBaitStock() {
    const bt = cfg.bossBaitTier;
    if (!(bt > 0) || bossMapId() === BOSS_MAP) return;
    busy = true;
    try {
      if (!await openShop()) return;
      await shopTab('🪱 เหยื่อ'); await sleep(300);
      const row = shopRows().find((r) => r.tier === bt);
      if (!row) { say(`👹 หาเหยื่อจุดอ่อนขั้น ${bt} ในร้านไม่เจอ — ตีด้วยเหยื่อปัจจุบัน`); await closeShop(); return; }
      if (row.lockedLv) { say(`👹 เหยื่อจุดอ่อนขั้น ${bt} ยังไม่ปลดล็อก (Lv.${row.lockedLv}) — ตีด้วยเหยื่อปัจจุบัน`); await closeShop(); return; }
      if ((row.stock || 0) >= 100) { await closeShop(); return; }   // มีพอแล้ว (≥1 แพ็ค)
      if (!row.addBtn || row.addBtn.disabled) { await closeShop(); return; }
      fireClick(row.addBtn); await sleep(300);
      const buy = btnByText('ซื้อเลย!') || btnByText('เหรียญไม่พอ');
      if (!buy || buy.disabled || /เหรียญไม่พอ/.test(buy.textContent)) { say(`👹 เงินไม่พอซื้อเหยื่อจุดอ่อนขั้น ${bt} — ตีด้วยเหยื่อปัจจุบัน`); await closeShop(); return; }
      fireClick(buy);
      const done = await waitFor(() => { const t = document.body.innerText; if (t.includes('✅ ซื้อสำเร็จ!')) return 'ok'; if (t.includes('❌')) return 'fail'; return null; }, 8000);
      if (done === 'ok') { profit.life.baitCost += baitUnit(bt) * PACK_SIZE; saveProfit(); say(`👹 เตรียมเหยื่อจุดอ่อนขั้น ${bt} (1 แพ็ค) พร้อมล่าบอส`); }
      await sleep(300); await closeShop();
    } catch (e) { logErr('เตรียมเหยื่อบอสล้มเหลว', e); await closeShop(); }
    finally { busy = false; }
  }

  // orchestrator หลัก — เดินไปล่าแล้วกลับ (ครอบด้วย orchestrating เพื่อหยุดฟาร์มปกติชั่วคราว)
  // ⏳ v6.163 (ผู้ใช้สั่ง): จบไฟต์แล้ว "อยู่ในถ้ำต่ออีก 20-30 วิ (สุ่ม)" ก่อนเดินกลับ/ทำอย่างอื่น
  //   สุ่มช่วง = จังหวะออกจากถ้ำไม่ซ้ำเป๊ะทุกรอบ · นอนเป็นช่วงละ 1 วิ เช็ค enabled → กดหยุดบอทแล้วออกได้ทันที ไม่ค้าง 30 วิ
  async function bossLinger() {
    if (bossMapId() !== BOSS_MAP) return 0;   // หลุดออกจากถ้ำไปแล้ว (ตาย/เดินออก) = ไม่ต้องหน่วง
    const ms = 20000 + Math.floor(Math.random() * 10001);
    say(`👹 อยู่ในถ้ำต่ออีก ~${Math.round(ms / 1000)} วิ ก่อนไปต่อ`);
    for (let left = ms; left > 0 && enabled; left -= 1000) await sleep(Math.min(1000, left));
    return ms;
  }

  async function runBossHunt(resumeHome) {
    // ถูกเรียกตอน resume แต่มีงานอื่นยึดอยู่ (เช่น ทดสอบเหยื่อ resume ก่อน) → ล้าง state ทิ้ง (ไม่มีใคร retry ให้ —
    //   ถ้ายังค้างในถ้ำ strandedInBossCave จะพาออกเอง) กัน tokpla_boss_state ค้างข้ามวัน
    if (orchestrating || busy) { if (resumeHome) clearBossState(); return; }
    orchestrating = true;
    // 🐛 v6.117: บ้านต้องไม่ใช่ boss_cave — ถ้าเริ่มล่าตอนอยู่ในถ้ำแล้ว ใช้แมพฟาร์มล่าสุด/ที่ตั้ง/village
    const here = bossMapId();
    bossHome = resumeHome || cfg.bossHomeMap || (here && here !== BOSS_MAP ? here : bossLastMapId) || 'village';
    if (bossHome === BOSS_MAP) bossHome = 'village';   // กันเหนียว: บ้านห้ามเป็นถ้ำบอส
    try {
      // 🛡️ v6.107: ถ้าอยู่ boss_cave อยู่แล้ว ไม่ต้องเดินไป (ข้ามเทสต์คุมตัว) · ไม่งั้นต้องคุมตัวละครได้ก่อน
      if (!resumeHome && bossMapId() !== BOSS_MAP) {
        say('👹 ใกล้เวลาบอส — ทดสอบว่าคุมตัวละครได้ก่อน...');
        if (!await bossCanControl()) {
          say('⚠️ ยกเลิกล่าบอส — เดินตัวละครไม่ได้ตอนนี้ (แท็บไม่โฟกัส/เกมไม่รับปุ่ม?) ลองใหม่ใน 1 นาที');
          if (isOn('tgOn') && isOn('tgWarn')) void tgSend('⚠️ <b>ยกเลิกล่าบอส</b> — บอทเดินตัวละครไม่ได้ (ต้องเปิดแท็บเกมไว้หน้าสุด) · จะลองใหม่ใน 1 นาที');
          bossEvent('⚠️ ยกเลิกก่อนออกเดินทาง — เทสต์เดินตัวละครไม่ผ่าน (แท็บไม่โฟกัส/มีแผงเปิดค้าง?) · คูลดาวน์สั้น 60 วิ แล้วลองใหม่');
          // 👹 v6.199: ยกเลิก "ก่อนออกเดินทาง" = ยังไม่เจอบอสเลย → คูลดาวน์สั้น (เดิม 10 นาที = พลาดบอสทั้งรอบ)
          bossReleaseAll(); bossPhase = 'idle'; clearBossState(); stampBossHunt(60000); orchestrating = false; return;
        }
      }
      if (!resumeHome) {
        bossPhase = 'travel'; saveBossState();
        say('👹 ใกล้เวลาบอส — ออกเดินทางไปถ้ำบ่อโบราณ');
        bossEvent(`🚶 ออกเดินทางไปถ้ำ (บอสอีก ${bossTimerMin() ?? '?'} นาที · ตั้ง lead ${cfg.bossLeadMin} · จาก ${bossHome})`);
        if (isOn('tgOn')) void tgSend(`👹 <b>ออกล่าบอส</b> — จากแมพ ${bossHome} → ถ้ำบ่อโบราณ (จะกลับมาฟาร์มต่อ)`);
        recordBossGraph();
        await ensureBossBaitStock();   // 👹 v6.134: ซื้อเหยื่อจุดอ่อนก่อนเข้าถ้ำ (ในถ้ำซื้อไม่ได้)
        const reached = await bossTravelTo(BOSS_MAP);
        if (!reached) { say('👹 ไปถ้ำบอสไม่สำเร็จ — กลับบ้าน'); bossEvent('❌ เดินไปถ้ำไม่สำเร็จ — กลับบ้าน'); }
        else {
          bossPhase = 'fight'; saveBossState();
          bossWrongRound = false;
          await bossFight(cfg.bossMaxWaitMin);
          // v6.203: มาผิดรอบ (ไม่ได้สู้เลย) → ข้ามการรอในถ้ำ + เก็บเมล์ · กลับไปฟาร์มทันที
          if (!bossWrongRound) {
            await bossLinger();
            await claimBossMail(true);   // 📬 v6.171: รับรางวัล "ก่อน" เดินกลับ — ไม่งั้น gameEscape ตอนเดินทางจะปิด victory dialog ทิ้ง
          }
        }
      }
      bossPhase = 'return'; saveBossState();
      const back = await bossTravelTo(bossHome);
      say(back ? `👹 กลับถึง ${bossHome} — ฟาร์มต่อ` : `👹 กลับบ้านไม่สำเร็จ (อยู่ ${bossMapId()}) — ฟาร์มที่นี่ไปก่อน`);
      if (isOn('tgOn')) void tgSend(back ? `🎣 กลับมาฟาร์มต่อที่ ${bossHome}` : `⚠️ กลับแมพเดิมไม่สำเร็จ — อยู่ ${bossMapId()}`);
    } catch (e) { logErr('ล่าบอสล้มเหลว', e); }
    finally { bossReleaseAll(); bossPhase = 'idle'; clearBossState(); orchestrating = false; lastCast = now(); pendingCast = 0; stampBossHunt(); resumeTestAfterBoss(); }
  }

  // 📬 v6.158: รับรางวัลบอสจากจดหมายอัตโนมัติ — บอสตายจะเด้ง dialog "รางวัลส่งเข้าจดหมายแล้ว" (ปุ่ม "📬 เปิดจดหมาย")
  //   บอทรัน 24 ชม. ไม่มีคนกดรับ → รางวัล (เหรียญ/เศษบอส) กองค้างในเมล์ · trigger = ปุ่มเปิดจดหมาย หรือ mail เปิดค้างที่มี "รับของ"
  //   จดหมาย = modal ที่ "ไม่บล็อกฟิชชิ่ง" (ตกปลาทำงานใต้จอได้ + minigame re-render ปิดเอง) → ปิดด้วย × / Escape + auto-close (ไม่ deadlock)
  //   ไม่มีปุ่ม "รับทั้งหมด" → กด "รับของ" ทีละใบ (รับแล้ว = ปุ่ม disabled ข้อความ "รับแล้ว") · ทุกปุ่ม tk-btn-primary ข้าม UI บอท (data-tkbot)
  let mailClaiming = false;
  const mailOpenBtn = () => [...document.querySelectorAll('button')].find((b) => !isBotUI(b) && b.offsetParent && /เปิดจดหมาย/.test(b.textContent || '')) || null;
  const mailClaimBtns = () => [...document.querySelectorAll('button.tk-btn-primary')].filter((b) => !isBotUI(b) && !b.disabled && b.offsetParent && b.textContent.trim() === 'รับของ');
  //   🐛 v6.171: เพิ่ม force — ตอนจบไฟต์บอท "อยู่ใน orchestrating" ตลอด (runBossHunt) → watcher ปกติถูกบล็อก
  //     และ v6.165 ยัง Esc ปิด victory dialog ทิ้งตอนเดินกลับบ้าน = รางวัลค้างไม่มีวันได้รับ (เจอจริง 2 ใบ)
  // 🎁 v6.206: อ่าน "ได้อะไรบ้าง" จากแถวจดหมาย — ต้องอ่าน **ก่อนกดรับ** (กดแล้วข้อความเปลี่ยนเป็น "รับแล้ว")
  //   เก็บข้อความดิบไว้ด้วยเสมอ — รูปแบบรางวัลของเกมยังไม่เคยเห็นครบ ถ้า parse พลาดจะได้ไม่สูญข้อมูล
  function mailRowText(btn) {
    let p = btn;
    for (let i = 0; i < 6 && p; i++) {
      p = p.parentElement;
      const t = (p?.textContent || '').replace(/\s+/g, ' ').trim();
      if (t.length > 12 && t.length < 400) return t.replace(/รับของ|รับแล้ว|รอรับ/g, ' ').replace(/\s+/g, ' ').trim();
    }
    return '';
  }
  function parseReward(txt) {
    const out = { coins: 0, items: [] };
    // 🪙 v6.210 (เจอจากข้อมูลจริง): ข้อความรางวัลมี 🪙 หลายตัว — "ของรางวัล2🪙เหรียญ 996 🪙"
    //   parser เดิมจับตัวแรก (2 = จำนวนชนิดรางวัล) แทนเหรียญจริง (996) → บันทึกเหรียญผิด
    //   แก้: เชื่อ "เหรียญ N" ก่อน · ไม่มีก็เอาเลข 🪙 ที่ "มากสุด" (เหรียญรางวัลมักใหญ่กว่าเลข label)
    const cn = /เหรียญ\s*([\d,]+)/.exec(txt);
    if (cn) out.coins = parseInt(cn[1].replace(/,/g, ''), 10) || 0;
    else {
      const all = [...txt.matchAll(/([\d,]+)\s*🪙/g)].map((m) => parseInt(m[1].replace(/,/g, ''), 10) || 0);
      if (all.length) out.coins = Math.max(...all);
    }
    // 🎁 v6.223 (จากข้อมูลจริง): รางวัลเรียงต่อกันโดยมี "ไอคอนอิโมจิ" นำหน้าแต่ละชิ้น —
    //   "🎁ของรางวัล2🪙เหรียญ 996 🪙🪱เหยื่อปลอมปลาเงิน x20🎣เบ็ดเจ้าดุกนรก👕ชุดปลาดุกน้อย"
    //   parser เดิมจับเฉพาะ "ชื่อ×จำนวน" → **ของที่ไม่มีจำนวน (เบ็ด/ชุดแต่งตัว/ของยูนีค) หลุดหมด** (ผู้ใช้เจอจริง)
    //   วิธีใหม่: ตัดเอาช่วง "หลัง 🎁" แล้วแยกชิ้นตามอิโมจิ → แต่ละชิ้น = "ชื่อ [x จำนวน]" (ไม่มีจำนวน = 1 ชิ้น)
    let sec = txt;
    const gi = txt.indexOf('🎁');
    if (gi >= 0) sec = txt.slice(gi);
    else { const gi2 = txt.indexOf('ของรางวัล'); if (gi2 >= 0) sec = txt.slice(gi2); }
    const seen = new Set();
    const SKIP = /^(ของรางวัล|เหรียญ|กดรับ|รับเข้า|รับของ|รับแล้ว|รอรับ|ด้านล่าง|เปิดหีบ|เปิดจดหมาย|คุณ|สมบัติ)/;
    for (let ch of sec.split(/[\p{Extended_Pictographic}️‍]+/u)) {
      ch = ch.replace(/^ของรางวัล\s*\d*/, '').replace(/\s+/g, ' ').trim();
      if (!ch || SKIP.test(ch)) continue;
      // "ชื่อ [x/× จำนวน]" — ชื่อเป็นไทย/อังกฤษ (มีเว้นวรรคได้) ยาวไม่เกิน 39 · จำนวนไม่มี = ยูนีค (×1)
      const m = /^([ก-๙A-Za-z][ก-๙A-Za-z\s]{0,38}?)\s*(?:[×x]\s*(\d+))?\s*$/.exec(ch);
      if (!m) continue;
      const name = m[1].trim();
      if (!name || SKIP.test(name)) continue;
      const key = m[2] ? `${name}×${m[2]}` : name;
      if (!seen.has(key)) { seen.add(key); out.items.push(key); }
    }
    return out;
  }
  // ผูกรางวัลเข้ากับ "ไฟต์ล่าสุด" ในสถิติ (recordBossFight เขียนไปก่อนแล้ว รางวัลมาทีหลัง)
  function updateLastBossReward(r) {
    try {
      const arr = loadBossStats();
      const last = arr[arr.length - 1];
      if (!last) return;
      if (Date.now() - (last.ts || 0) > 15 * 60000) return;   // ห่างเกินไป = ไม่ใช่รางวัลของไฟต์นี้ อย่าผูกมั่ว
      const rw = last.reward || (last.reward = { coins: 0, items: [], mails: 0, raw: [] });
      rw.coins += r.coins || 0;
      rw.mails += r.mails || 0;
      for (const it of (r.items || [])) rw.items.push(it);
      for (const t of (r.raw || [])) if (rw.raw.length < 6) rw.raw.push(t.slice(0, 160));
      W.localStorage.setItem(BOSS_STATS_KEY, JSON.stringify(arr));
    } catch (e) { logErr('บันทึกรางวัลบอสล้มเหลว', e); }
  }

  async function claimBossMail(force) {
    if (mailClaiming || (!force && (busy || orchestrating))) return 0;
    const ob = mailOpenBtn();
    if (!ob && !mailClaimBtns().length) return 0;      // ไม่มี dialog รางวัล/ของค้างรับ → ออก (เบา: query ทุก 2 วิ)
    if (gameState() === 'minigame') return 0;          // อย่าแทรกตอนกำลังดึงปลา (เกจ core — กฎเหล็ก #1)
    mailClaiming = true; busy = true;
    let claimed = 0;
    const got = { coins: 0, items: [], raw: [], mails: 0 };   // 🎁 v6.206: เก็บว่าได้อะไรบ้าง
    const coinBefore = coinsNow();
    try {
      if (ob) { fireClick(ob); await sleep(900); }     // เปิดจดหมายจาก victory dialog
      for (let i = 0; i < 20; i++) {                    // กด "รับของ" ทุกใบ (เผื่อมีหลายบอสค้าง)
        const b = mailClaimBtns()[0];
        if (!b) break;
        const txt = mailRowText(b);                     // ต้องอ่านก่อนกด — กดแล้วข้อความหาย
        if (txt) { got.raw.push(txt); const p = parseReward(txt); got.coins += p.coins; got.items.push(...p.items); }
        fireClick(b); claimed++; got.mails++;
        await sleep(400);
      }
      // ปิดจดหมาย — เฉพาะเมื่อ mail เปิดจริง (ยืนยันด้วยแถว "รับแล้ว"/"รับของ") เพื่อกันคลิกปุ่มผิด
      const mailOpen = [...document.querySelectorAll('button.tk-btn-primary')].some((b) => !isBotUI(b) && b.offsetParent && /^รับ(ของ|แล้ว)$/.test(b.textContent.trim()));
      if (mailOpen) {
        const x = [...document.querySelectorAll('button')].find((b) => !isBotUI(b) && b.offsetParent && (/^(✕|×|✖|❌)$/.test(b.textContent.trim()) || /^(ปิด|close)/i.test(b.getAttribute('aria-label') || '')));
        if (x) fireClick(x);
        gameEscape();   // v6.165: ใช้ "ปิดหน้าต่างทั้งหมด" ทางการแทนการยิง Escape เองแบบเดิม
      }
      if (claimed) {
        // 🎁 v6.206/6.210: "ส่วนต่างเหรียญบน HUD" = ค่าจริงที่สุด (ground truth) — ใช้เมื่อมากกว่าที่ parse ได้
        //   (parse อาจจับเลขผิดตัวจากข้อความหลาย 🪙 · ส่วนต่าง HUD วัดเหรียญที่เข้าจริง)
        await sleep(500);
        const coinAfter = coinsNow();
        if (coinBefore != null && coinAfter != null && coinAfter - coinBefore > got.coins) got.coins = coinAfter - coinBefore;
        const items = [...new Set(got.items)];
        const detail = [got.coins ? `${got.coins.toLocaleString()} 🪙` : null, items.length ? items.join(' + ') : null]
          .filter(Boolean).join(' · ') || '(อ่านรายละเอียดไม่ได้)';
        say(`📬 รับรางวัลบอส ${claimed} ใบ — ${detail}`);
        bossEvent(`🎁 รางวัล ${claimed} ใบ: ${detail}`);
        updateLastBossReward({ coins: got.coins, items, mails: got.mails, raw: got.raw });
        if (isOn('tgOn')) void tgSend(`📬 <b>รับรางวัลบอส</b> ${claimed} ใบ\n${esc(detail)}`);
      }
    } catch (e) { logErr('รับรางวัลบอสล้มเหลว', e); }
    finally { busy = false; mailClaiming = false; }
    return claimed;
  }

  // 🔴 v6.176 บั๊กร้ายแรงที่ทำให้ "บอสมาแต่บอทไม่ไปล่า" (เจอจากไทม์ไลน์จริง 16:22 รีโหลด → 16:30 พลาดบอส):
  //   `now()` = performance.now() ซึ่ง **รีเซ็ตเป็น ~0 ทุกครั้งที่รีโหลดหน้า** แต่ตัวจับเวลาพวกนี้เริ่มที่ 0 เช่นกัน
  //   → เงื่อนไขกันซ้ำแบบ `now() - lastXxxAt < N` จึงเป็นจริงทันทีหลังรีโหลด = **บล็อกฟีเจอร์ไปทั้งช่วง N**
  //   กรณีบอส: กันล่าซ้ำ 10 นาที → รีโหลดแล้วบอทล่าบอสไม่ได้เลย 10 นาทีแรก (รีโหลดใกล้เวลาบอส = พลาดทั้งรอบ)
  //   แก้: เริ่มที่ค่าติดลบมากๆ = "ไม่เคยทำมาก่อน" จริงๆ (ใช้กับทุกตัวจับเวลาที่เป็น cooldown)
  const NEVER = -1e9;
  let lastBossHuntAt = NEVER, lastBossEscapeAt = NEVER, bossEscapeFails = 0, bossLastMapId = '', lastBossHereChk = 0;
  // 🕐 v6.177: persist cooldown ล่าบอสด้วย "เวลาจริง" (Date.now) — v6.176 แก้ฝั่ง "รีโหลดแล้วโดนบล็อก" แต่เหลือฝั่งกลับกัน:
  //   รีโหลดหลังเพิ่งล่าเสร็จ → cooldown หาย → ถ้าป้าย "ถึงรอบบอส" ยังค้าง (รอบบอสยังเปิด) บอทจะวิ่งไปหาบอสที่ตายแล้วซ้ำ
  //   แปลง epoch → ฐาน performance.now(): lastAt = now() - (เวลาจริงที่ผ่านไป) → เงื่อนไข now()-lastAt ทำงานถูกข้ามรีโหลด
  try {
    const t = +W.localStorage.getItem('tokpla_boss_lasthunt') || 0;
    if (t && Date.now() - t < 10 * 60000) lastBossHuntAt = now() - (Date.now() - t);
  } catch {}
  // 👹 v6.199: คูลดาวน์แยกตามสาเหตุ — เดิมทุกกรณีกิน 10 นาทีเท่ากัน รวมถึง "ยกเลิกก่อนออกเดินทาง"
  //   เคสจริงที่ผู้ใช้เจอ: เทสต์เดินตัวละครล้มเหลวตอน ~10:22 → ยกเลิก + ประทับคูลดาวน์ 10 นาที
  //   → ไปไม่ได้จนถึง ~10:32 · บอสเกิด 10:30 · บอทออกจริง 10:36 = พลาดช่วงต้นไฟต์ทั้งที่ตั้ง lead ไว้ 8 นาที
  //   ใหม่: ยกเลิกก่อนเดินทาง (ยังไม่ได้เจอบอสเลย) = คูลดาวน์สั้น ลองใหม่ได้ทัน · จบไฟต์จริง = 10 นาทีเหมือนเดิม
  let bossHuntCoolMs = 10 * 60000;
  // 🔫 v6.200 arm gate — event log (v6.199) เผยบั๊กใหญ่: หลังบอสตาย ป้าย "ถึงรอบบอสแล้ว!" ค้าง → อ่านได้ 0 นาทีตลอด
  //   → พอคูลดาวน์ 10 นาทีหมด บอทเดินไปถ้ำใหม่ → รอเก้อเต็ม bossMaxWaitMin → "บอสไม่มา" → วนซ้ำ
  //   ข้อมูลจริง: ฆ่า 5 / เที่ยวเปล่า 8! (22:43+23:07 หลังฆ่า 22:31 · 19:54+20:18+20:36 หลังฆ่า 19:31)
  //   แก้: ล่าจบ (เจอหรือไม่เจอบอสก็ตาม) = ปลด arm · ต้อง "เห็นตัวนับรอบใหม่ > lead" ก่อน ถึงจะ arm กลับ
  //   → ป้ายค้าง 0 นาทีไม่มีวันปลุกการล่าซ้ำได้อีก · persist ข้ามรีโหลด (ป้ายค้างอยู่นานกว่าอายุหน้าเว็บ)
  let bossWrongRound = false;   // v6.203: ไฟต์ล่าสุดจบเพราะ "มาผิดรอบ" (ไม่ได้สู้) → ข้าม linger/เมล์
  let bossArmed = true;
  try { bossArmed = W.localStorage.getItem('tokpla_boss_armed') !== '0'; } catch {}
  const setBossArmed = (v) => { bossArmed = v; try { W.localStorage.setItem('tokpla_boss_armed', v ? '1' : '0'); } catch {} };
  const stampBossHunt = (coolMs) => {
    lastBossHuntAt = now();
    bossHuntCoolMs = coolMs || 10 * 60000;
    if (!coolMs) setBossArmed(false);   // จบรอบเต็ม (ไฟต์/รอครบ) = ปลด arm · ยกเลิกก่อนเดินทาง (coolMs สั้น) ยัง arm อยู่
    try { W.localStorage.setItem('tokpla_boss_lasthunt', String(Date.now())); } catch {}
  };
  // 👹 v6.112: "ติดอยู่ในถ้ำบอส" โดยไม่ได้กำลังล่า/ไม่มีบอส — ถ้ำบอสตกปกติไม่ได้ → บอทตกไม่ออก → recoveryWatch รีโหลดวนเปล่า
  //   (เกิดเมื่อ bossHunt เดินไปแล้วกลับบ้านไม่สำเร็จ เพราะ WASD ไม่เสถียร) · แก้: เดินออกไปแมพบ้านเอง · เดินไม่ได้ = แจ้ง+หยุดลองสแปม
  //   v6.138: หนีออกเฉพาะตอน "ปิดล่าบอส" — ถ้าเปิดล่าบอสแล้วอยู่ในถ้ำ = ผู้ใช้/บอทตั้งใจมารอตีบอส ห้ามเดินหนีออก
  //   🐛 v6.140: ตัดเงื่อนไข !isOn('bossHunt') ออก — v6.138 กัน escape ทุกกรณีที่เปิดล่าบอส ทำให้ถ้า return จากถ้ำล้มเหลว
  //     (bossTravelTo คืน false) บอทติดในถ้ำถาวร: ตกปลาไม่ได้ ("ปุ่มตกปลากดไม่ได้" วนรัว) + บอส "ไม่มาในเวลาที่รอ" วนเปล่า
  //     (ยืนยันจาก log จริง healthcheck: ติด 30+ นาที ฟาร์มศูนย์) · ความจริง: บอทไม่เคย "ตั้งใจ" idle ในถ้ำ —
  //     ช่วงเดินไป/สู้บอสจริงถูกกันด้วย orchestrating + bossPhase!=='idle' อยู่แล้ว → idle+ในถ้ำ+ไม่มีบอส = ติดเสมอ (แม้เปิดล่าบอส)
  //     ถ้าบอสโผล่จริง (present) → !present กันไว้ → tick เรียก bossFightHere เข้าตีแทน · escape ยิงเฉพาะตอน "ไม่มีบอส"
  //   🐛 v6.143: v6.140 ตัด !bossHunt ทิ้ง → "มารอบอสก่อนบอสโผล่" (เปิดบอทในถ้ำ / เดินมารอเอง) โดนหนีออกทันที!
  //     แก้ให้ถูกทั้งสองเคส: หนีเฉพาะตอน "ติดจริง" = บอสไม่ได้กำลังจะมา (timer ไกล/อ่านไม่ได้ = return บ้านล้มเหลว บอสรอบหน้าห่างเป็นชั่วโมง)
  //     ถ้าเปิดล่าบอส + บอสใกล้ (<= รอสูงสุด+ไปก่อน) → รอในถ้ำ (เดี๋ยว bossHuntDue/bossFightHere จัดการ) ไม่หนี
  const strandedInBossCave = () => {
    if (bossMapId() !== BOSS_MAP || bossPhase !== 'idle' || orchestrating || busy) return false;
    if ((raidBossState() || {}).present) return false;   // มีบอส → ไม่หนี (tick เรียก bossFightHere ตีแทน)
    if (isOn('bossHunt')) {                                // v6.143: รอบอสที่ใกล้จะมา ห้ามหนี
      if (now() - bossTimerCacheAt > 5000) { bossTimerCacheAt = now(); bossTimerCache = bossTimerMin(); }
      if (bossTimerCache != null && bossTimerCache <= clamp(cfg.bossMaxWaitMin, 1, 30) + clamp(cfg.bossLeadMin, 1, 60)) return false;
    }
    return true;                                           // ติดจริง (idle+ในถ้ำ+ไม่มีบอส+บอสไม่ใกล้) → หนีออกไปฟาร์ม
  };
  async function escapeBossCave() {
    if (orchestrating || busy) return;
    orchestrating = true;
    try {
      const home = cfg.bossHomeMap || 'village';
      if (!await bossCanControl()) {
        bossEscapeFails++;
        lastBossEscapeAt = now() + (bossEscapeFails >= 2 ? 300000 : 0);   // ล้มเหลว 2 ครั้ง → เว้น 5 นาที กันสแปม
        if (bossEscapeFails === 2) {
          say('⚠️ ติดในถ้ำบอส เดินออกเองไม่ได้ (แท็บไม่โฟกัส/เกมไม่รับปุ่ม?) — เปิดแท็บเกมไว้หน้าสุด แล้วเดินออกเอง หรือกด Alt+B ปิด/เปิดบอท');
          if (isOn('tgOn') && isOn('tgWarn')) void tgSend('⚠️ <b>บอทติดในถ้ำบอส</b> — เดินออกไม่ได้ (ต้องเปิดแท็บเกมไว้หน้าสุด) · เดินออกเอง หรือ /off แล้ว /on');
        }
        return;
      }
      bossEscapeFails = 0;
      say('👹 ติดอยู่ในถ้ำบอส (ไม่มีบอส) — เดินออกไปฟาร์มต่อ');
      const reached = await bossTravelTo(home);
      if (reached) { say(`👹 ออกจากถ้ำบอสแล้ว — ฟาร์มต่อที่ ${home}`); lastProgressAt = now(); }
      else say('👹 ยังออกจากถ้ำบอสไม่สำเร็จ — จะลองใหม่');
    } catch (e) { logErr('ออกจากถ้ำบอสล้มเหลว', e); }
    finally { bossReleaseAll(); orchestrating = false; lastCast = now(); pendingCast = 0; }
  }
  // 👹 v6.119: บอสอยู่ตรงหน้าแล้ว (อยู่ในถ้ำบอสอยู่แล้ว — เดินเอง / มาถึงก่อน timer / runBossHunt จบแต่ยังอยู่) → ตีเลย ไม่ต้องเดินทาง
  //   บั๊กเดิม (bot.log): ตีบอสได้เฉพาะตอน timer สั่ง runBossHunt · ถ้าอยู่ในถ้ำอยู่แล้ว บอสโผล่มา "ตกปลา"แทน (ปุ่มตกปลากดไม่ได้ วนเปล่า)
  async function bossFightHere() {
    if (orchestrating || busy) return;
    // ตั้งบ้านก่อนเซฟ state — ไม่งั้น bossHome ว่าง (เข้าตีโดยไม่ผ่าน runBossHunt) → รีโหลดกลางไฟต์แล้ว resume ไม่ทำงาน
    bossHome = cfg.bossHomeMap || bossLastMapId || 'village';
    if (bossHome === BOSS_MAP) bossHome = 'village';
    orchestrating = true; bossPhase = 'fight'; saveBossState();
    try {
      say('👹 เจอบอสในถ้ำ — เข้าตี (เกจ→กดแถบแดง + กระโดดหลบ)');
      if (isOn('tgOn')) void tgSend('👹 <b>เจอบอสในถ้ำ</b> — เข้าตีทันที (ไม่ต้องเดินทาง)');
      await bossFight(cfg.bossMaxWaitMin);
      await bossLinger();   // ⏳ v6.163: อยู่ในถ้ำต่อ 20-30 วิ (สุ่ม) ก่อนเดินกลับ
      await claimBossMail(true);   // 📬 v6.171: รับรางวัลก่อนเดินกลับ (เหตุผลเดียวกับใน runBossHunt)
      // 👹 v6.139: หลังตีจบ เดินกลับแมพบ้าน — ฟาร์มต่อ (เช่น sea_dock ที่สถิติปลาเทพดี) + "เรียนรู้เส้นทาง" ระหว่างเดินผ่าน village
      //   → ครั้งหน้า runBossHunt auto-travel ไป boss_cave ได้เอง (แก้บั๊กบอทไม่รู้ route ต้องเดินเอง) · เดินไม่ได้ = ฟาร์มในถ้ำต่อ
      if (bossMapId() === BOSS_MAP && bossHome && bossHome !== BOSS_MAP) {
        bossPhase = 'return'; saveBossState();
        say(`👹 ตีบอสจบ — เดินกลับ ${bossHome} (เรียนรู้เส้นทางไปด้วย)`);
        const back = await bossTravelTo(bossHome);
        say(back ? `👹 กลับถึง ${bossHome} — ฟาร์มต่อ` : `👹 กลับบ้านไม่สำเร็จ (อยู่ ${bossMapId()}) — ฟาร์มที่นี่ก่อน`);
      }
    } catch (e) { logErr('สู้บอส(ในถ้ำ)ล้มเหลว', e); }
    finally { bossReleaseAll(); bossPhase = 'idle'; clearBossState(); orchestrating = false; lastCast = now(); pendingCast = 0; stampBossHunt(); resumeTestAfterBoss(); }
  }

  // ===== 🏪 ระบบ NPC เมืองชาวประมง (v6.150) — ลุงคลัง(ฝากของ) + ยายแก่น(แลกแก่นปลา) =====
  //   NPC จริงในเกม: questNpcs · khlang(service 'storage') @≈447,434 · kaen(service 'essence') @≈1048,365 · scene.nearNpcId บอกตัวที่อยู่ใกล้
  //   เดินไปด้วย A* ในตัวเกม (bossGameNavTo/autoWalker) แล้วกลับแมพเดิมฟาร์มต่อ · นับปลาจาก readBag (เปิดกระเป๋าอ่าน rarity จากสีขอบ)
  const NPC_POS = { khlang: { x: 447, y: 470 }, kaen: { x: 1048, y: 400 } };   // v6.178: ตัด orbsmith — ผู้ใช้ตีหินเอง
  const rarityRank = (k) => { const i = RARITY.findIndex((r) => r.key === k); return i < 0 ? 99 : i; };
  // 🧠 v6.153: ยายแก่นแลกเฉพาะช่วง [essenceMin, storageMin) — "ตัวสูงสุดเก็บเข้าคลัง, ตัวกลางทำแก่น" · กันแลก+ฝากทับกัน
  //   ทำงานเมื่อ storage เปิด + ตั้งระดับสูงกว่า essence เท่านั้น (ไม่งั้นไม่ cap = แลกตามช่วงเดิม)
  const npcEssTake = (rk, essMin, stoMin) => rk >= essMin && (!isOn('npcStorageOn') || !(stoMin > essMin) || rk < stoMin);
  let lastNpcErrandAt = NEVER, lastNpcCheckAt = NEVER;   // v6.176: เหตุผลเดียวกัน — เดิมรีโหลดแล้วทริปเมืองถูกบล็อก 3 นาที + นับกระเป๋าถูกบล็อก 2 นาที
  // เปิดกระเป๋าอ่าน → นับปลา "ปลดล็อก + ระดับ >= ขั้นต่ำ" ของแต่ละบริการ → ปิด (แพง เลยเรียกแบบ throttle)
  let lastBagPct = null;   // v6.165: %เต็มกระเป๋าล่าสุด (ให้ npcErrandCheck ยอมแทรกตอนเทสต์เหยื่อได้ถ้าใกล้เต็ม)
  async function npcCountBag() {
    const res = { storage: 0, essence: 0, bagPct: 0 };
    busy = true;   // 🛡️ v6.178 (จาก audit): เดิมเปิดกระเป๋านับโดยไม่ยกธง busy → ลูปตกปลาหลักพยายามเหวี่ยงทั้งที่กระเป๋าบังจอ
    try {
      await ensureMenuOpen();
      if (!(await openBagUI())) return res;   // v6.167: มีคีย์ลัด B เป็นทางสำรองในตัว
      if (!(await waitFor(() => readBagCount(), 3000))) { await closeMenu(); return res; }
      await sleep(250);
      const bc = readBagCount(); if (bc && bc.slots > 0) { res.bagPct = bc.count / bc.slots * 100; lastBagPct = res.bagPct; }   // 🛡️ C: ความเต็มกระเป๋า (v6.165: จำไว้ให้ npcErrandCheck ตัดสินว่า "วิกฤต" ไหม)
      const stoMin = rarityRank(cfg.npcStorageRarity), essMin = rarityRank(cfg.npcEssenceRarity);
      for (const c of readBag()) {
        if (c.rarity == null) continue;                       // อ่านสีไม่ออก = ข้าม (กันฝาก/แลกผิดตัว)
        const rk = rarityRank(c.rarity), n = Math.max(0, c.count - c.lockedCount);   // ไม่นับตัวที่ผู้เล่นล็อก
        if (isOn('npcStorageOn') && rk >= stoMin) res.storage += n;
        if (isOn('npcEssenceOn') && npcEssTake(rk, essMin, stoMin)) res.essence += n;   // 🧠 ไม่แลกตัวที่ลุงคลังจะเก็บ (ระดับ >= storage)
      }
      await closeMenu();
    } catch (e) { logErr('npcCountBag', e); }
    finally { busy = false; }   // v6.178: คู่กับ busy=true ด้านบน — ปล่อยธงเสมอแม้ error/return กลางทาง
    return res;
  }
  // เดินเข้าใกล้ NPC ในเมืองประมง (สมมติอยู่ fisher_town แล้ว) จน scene.nearNpcId ตรง
  async function npcWalkNear(id) {
    const t = NPC_POS[id]; if (!t) return false;
    try { getPhaserScene().autoWalker.navigate({ x: t.x, y: t.y, mapId: 'fisher_town' }); } catch {}
    return !!await waitFor(() => { try { return getPhaserScene()?.nearNpcId === id; } catch { return false; } }, 15000, 300);
  }
  // 🛡️ v6.180: ปิด dialog NPC ให้ได้จริง — เดิมหาแค่ปุ่มที่ "ข้อความ" เป็น ✕/× ซึ่งเปราะมาก
  //   DOM จริงของคลัง: <button aria-label="ปิดคลัง">✕</button> → ใช้ aria-label เป็นหลัก (เจาะจงกว่า) แล้วค่อย fallback
  //   ปิดไม่ได้ = popup ค้างบังจอ ตกปลาต่อไม่ได้ (อาการที่ผู้ใช้เจอ) จึงซ้อน 3 ชั้น + Escape ปิดท้าย
  const npcCloseDialog = () => {
    const vis = (b) => !isBotUI(b) && b.offsetParent !== null;
    const byAria = [...document.querySelectorAll('button')].find((b) => vis(b) && /^ปิด/.test(b.getAttribute('aria-label') || ''));
    const byText = [...document.querySelectorAll('button')].find((b) => vis(b) && /^(✕|×|✖)$/.test((b.textContent || '').trim()));
    const x = byAria || byText;
    if (x) fireClick(x);
    gameEscape();   // ชั้นสุดท้าย: Esc = "ปิดหน้าต่างทั้งหมด" (มีข้อยกเว้นหน้าต่างรางวัลอยู่แล้ว)
  };
  // ปิดเฉพาะ popup "เลือกจำนวน" (ไม่ปิดคลังทั้งบาน) — ใช้ตอนฝากใบนี้ไม่ได้แล้วจะลองใบถัดไป
  const npcCloseQtyPopup = () => {
    const b = [...document.querySelectorAll('button')].find((x) => !isBotUI(x) && x.offsetParent !== null && /^(ยกเลิก|ปิด)$/.test((x.textContent || '').trim()));
    if (b) fireClick(b);
  };
  const npcVisible = (el) => { try { const r = el.getBoundingClientRect(); return el.offsetParent !== null && r.width > 10 && r.height > 10; } catch { return false; } };
  // 🏷️ v6.201: ตารางคำ "ระดับความหายาก" — ดึงคำจริงจาก i18n ของเกม (fishing.rarity.* + hud.announce.tag.*)
  //   ยืนยันจากบันเดิลเกม: common=ทั่วไป · uncommon=ไม่ธรรมดา · rare=หายาก · epic=สุดยอด · legendary=ตำนาน · mythic=เทพนิยาย
  //   ⚠️ เกมมี "คำที่สอง" สำหรับระดับเดียวกันด้วย (ป้ายประกาศ): แรร์ / อีพิค / เลเจนดารี / มิธิค — ตัวเดิมไม่รู้จักเลย
  //   ⚠️ และตัวเดิม **ไม่มี common** → แถวปลาทั่วไปอ่านระดับไม่ออก
  //   🐛 กับดักซับสตริง: 'ไม่ธรรมดา' มีคำว่า 'ธรรมดา' อยู่ข้างใน → ต้องจับ "คำที่ยาวที่สุดก่อน" ไม่งั้น uncommon กลายเป็น common
  const RAR_WORDS = [
    ['ไม่ธรรมดา', 'uncommon'], ['เลเจนดารี', 'legendary'], ['เทพนิยาย', 'mythic'],
    ['ทั่วไป', 'common'], ['ธรรมดา', 'common'], ['หายาก', 'rare'], ['แรร์', 'rare'],
    ['สุดยอด', 'epic'], ['อีพิค', 'epic'], ['ตำนาน', 'legendary'], ['มิธิค', 'mythic'],
  ].sort((a, b) => b[0].length - a[0].length);   // ยาวสุดก่อนเสมอ (กัน 'ธรรมดา' ชน 'ไม่ธรรมดา')
  // อ่านระดับจากข้อความ (แถวปลาใน NPC ฯลฯ) — คืน null ถ้าไม่เจอคำที่รู้จัก
  const rarityFromText = (t) => { for (const [w, k] of RAR_WORDS) if (t.includes(w)) return k; return null; };
  // เก็บแถวที่อ่านระดับไม่ออก → เตือนครั้งเดียวตอนจบธุระ (ถ้าเกมเปลี่ยนคำ เราจะรู้ทันที ไม่ใช่เงียบแล้วเลือกผิด)
  const npcRarMiss = new Set();
  // 🛡️ v6.181 — กฎเหล็ก #7 ซ้ำรอย v6.105: เช็ค "หน้าต่าง NPC เปิดแล้ว" ด้วยการหาข้อความทั้ง document
  //   ไปแมตช์ **คำอธิบายในแผงบอทเอง** (แผงตั้งค่า NPC มีคำว่า "คลังลุงคลัง"/"ยายแก่น" อยู่) → waitFor ผ่านทันทีเสมอ
  //   ทั้งที่หน้าต่างจริงยังไม่เปิด → บอทไปอ่านการ์ด = ไม่เจอ → "ฝาก 0" + popup ค้าง (อาการที่ผู้ใช้เจอ)
  //   ต้องนับเฉพาะ element ที่ "มองเห็นจริง + ไม่ใช่ UI บอท" เท่านั้น
  const gameTextVisible = (re) => [...document.querySelectorAll('h1,h2,h3,h4,div,span,p')].some((e) => {
    if (isBotUI(e) || e.offsetParent === null) return false;
    if (e.children.length > 3) return false;                       // เอาเฉพาะ node ใกล้ใบ กันจับ container ยักษ์
    return re.test(e.textContent || '');
  });
  const npcDismissCatchPopup = () => { const c = [...document.querySelectorAll('button')].find((b) => /^ตกต่อ/.test((b.textContent || '').trim())); if (c) fireClick(c); };   // ปิด popup ผลตกปลาที่ค้างบัง
  // 🧪 ยายแก่น (v6.151 ยืนยันสด): คลิกแถวปลา (เลือก) → กด "สกัดเลย!" → ได้แก่น · ทีละตัวจนไม่มีปลาเข้าเกณฑ์ (rare+/ตาม config)
  async function npcDoEssence() {
    // v6.180: ครอบ try/finally เหมือนลุงคลัง — early-return เดิมไม่ปิด dialog = เสี่ยง popup ค้างแบบเดียวกัน
    let done = 0;
    try {
      npcDismissCatchPopup(); await sleep(200);
      const talk = [...document.querySelectorAll('button')].find((b) => /คุยกับยายแก่น/.test(b.textContent || ''));
      if (!talk) { say('🧪 หาปุ่มคุยยายแก่นไม่เจอ'); return 0; }
      fireClick(talk);
      if (!(await waitFor(() => gameTextVisible(/โต๊ะปรุงของยายแก่น/), 6000))) {   // v6.181: เฉพาะ element ที่เห็นจริง + ไม่ใช่ UI บอท
        say('🧪 เปิดโต๊ะยายแก่นไม่สำเร็จ (รอ 6 วิ)'); return 0;
      }
      const essMin = rarityRank(cfg.npcEssenceRarity), stoMin = rarityRank(cfg.npcStorageRarity);
      for (let i = 0; i < 80; i++) {
      const fb = [...document.querySelectorAll('button')].find((b) => {
        if (!npcVisible(b) || b.disabled) return false; const t = (b.textContent || ''); if (!/kg/.test(t)) return false;   // แถวปลา = มีน้ำหนัก "N kg"
        // v6.201: ใช้ rarityFromText (รู้จักคำที่สองของเกม + จับคำยาวสุดก่อน) · อ่านไม่ออก = ไม่แตะ (ปลอดภัยไว้ก่อน)
        const rk = rarityFromText(t); if (rk == null) { npcRarMiss.add(t.replace(/\s+/g, ' ').slice(0, 40)); return false; }
        return npcEssTake(rarityRank(rk), essMin, stoMin);   // 🧠 ไม่แลกตัวที่ลุงคลังจะเก็บ
      });
      if (!fb) break;
      fireClick(fb); await sleep(350);                       // เลือกปลา
      const craft = [...document.querySelectorAll('button')].find((b) => /สกัดเลย/.test(b.textContent || '') && npcVisible(b) && !b.disabled);
      if (!craft) break;
      fireClick(craft); done++; await sleep(800);            // สกัด → ได้แก่น
      }
    } catch (e) { logErr('npcDoEssence', e); }
    finally {
      // 🏷️ v6.201: เกมเปลี่ยนคำระดับเมื่อไร จะได้รู้ทันที (เดิมอ่านไม่ออก = ข้ามเงียบ เลือกปลาผิดโดยไม่มีใครรู้)
      if (npcRarMiss.size) {
        const list = [...npcRarMiss].slice(0, 3).join(' · ');
        logWarn(`🏷️ อ่าน "ระดับความหายาก" จากแถวปลาไม่ออก ${npcRarMiss.size} แถว — เกมอาจเปลี่ยนคำ · ตัวอย่าง: ${list}`);
        if (isOn('tgOn') && isOn('tgWarn')) void tgSend(`⚠️ <b>อ่านระดับปลาไม่ออก</b> ${npcRarMiss.size} แถว (เกมอาจเปลี่ยนคำ)\n${esc(list)}`);
        npcRarMiss.clear();
      }
      npcCloseDialog(); await sleep(300);   // v6.180: ปิดเสมอ
    }
    return done;
  }
  // 🏬 ลุงคลัง (v6.151 ยืนยันสด): คลิกการ์ดปลา(ที่มองเห็น) → popup จำนวน → "ทั้งหมด" → "เลือก N ตัว" → "ฝาก →"
  //   ระวัง: เกมมี layout ซ้อน (มือถือ sm:hidden + จอใหญ่) → readBag เจอการ์ดซ้ำ ต้องเลือกเฉพาะ "ที่มองเห็น" (npcVisible)
  async function npcDoStorage() {
    // 🐛 v6.180 (ผู้ใช้รายงาน + ยืนยันจาก log): "เดินไปหาลุงคลัง แต่ไม่ฝาก + popup ค้างเปิดทิ้งไว้ แล้วเดินกลับ"
    //   ต้นเหตุ 2 ชั้นที่เจอ: (1) early-return หลายจุด **ไม่ปิด dialog** → popup ค้างบังจอถาวร
    //   (2) หลังกดแท็บ "🐟 ปลา" รอแค่ 300ms คงที่ แล้วอ่านการ์ดทันที — React ยังเรนเดอร์ grid ไม่เสร็จ
    //       → readBag() ได้ 0 ใบ → break ทันที → "ฝาก 0" (log จริง: ทริปจบใน 14 วิ)
    //   แก้: ครอบ try/finally ปิด dialog เสมอ + รอ "การ์ดโผล่จริง" แทนหน่วงคงที่ + log บอกจุดที่ล้ม
    let done = 0, storageFull = false;
    try {
      npcDismissCatchPopup(); await sleep(200);
      const talk = [...document.querySelectorAll('button')].find((b) => /ฝากของ/.test(b.textContent || b.getAttribute('aria-label') || ''));
      if (!talk) { say('🏬 หาปุ่มฝากของไม่เจอ'); return 0; }
      fireClick(talk);
      if (!(await waitFor(() => gameTextVisible(/คลังลุงคลัง/), 6000))) {   // v6.181: เดิมแมตช์คำอธิบายในแผงบอทเอง = ผ่านทันทีเสมอ (กฎเหล็ก #7)
        say('🏬 เปิดคลังลุงคลังไม่สำเร็จ (รอ 6 วิ)'); return 0;
      }
      const ft = [...document.querySelectorAll('button')].find((b) => /🐟\s*ปลา/.test(b.textContent || '') && npcVisible(b)); if (ft) { fireClick(ft); }
      // ⏳ รอ "การ์ดปลาโผล่จริง" (ไม่ใช่หน่วงคงที่) — ต้นเหตุ "ฝาก 0" ที่ผู้ใช้เจอ
      const gotCards = await waitFor(() => readBag().some((c) => c.rarity != null && npcVisible(c.el)), 4000, 200);
      if (!gotCards) { say('🏬 เปิดคลังแล้วแต่การ์ดปลาไม่โผล่ — ข้ามรอบนี้'); return 0; }
      const stoMin = rarityRank(cfg.npcStorageRarity);
      let fullSig = 0;   // 🏬 v6.223: กด "ฝาก →" ไม่ได้กี่ใบติด (คลังเต็ม = ปุ่มถูก disable/เกมขึ้น "เต็ม")
      for (let round = 0; round < 40; round++) {
      const card = readBag().find((c) => c.rarity != null && rarityRank(c.rarity) >= stoMin && (c.count - c.lockedCount) > 0 && npcVisible(c.el));
      if (!card) break;
      fireClick(card.el); await sleep(400);                  // เปิด popup เลือกจำนวน
      // 🏬 v6.223: เกมขึ้นข้อความ "คลังเต็ม" (ผู้ใช้เจอจริง: ของเต็ม บอทมีปัญหาทันที) → เลิกทันที ไม่วนเปล่า
      if (gameTextVisible(/คลัง[^]{0,6}เต็ม|เต็มแล้ว|พื้นที่[^]{0,6}เต็ม|เก็บเต็ม|ช่อง[^]{0,6}เต็ม/)) { storageFull = true; npcCloseQtyPopup(); break; }
      // ⚠️ v6.166 (เจอสด): คลังจำกัด "เลือกทีละไม่เกิน 100 ตัว" — กอง >100 ถ้ากด "ทั้งหมด" ปุ่ม "ฝาก →" จะกดไม่ได้
      //   ผลเดิม: บอทวนเปล่าครบ 40 รอบแล้วเลิก โดยไม่ได้ฝากอะไรเลย (กระเป๋าเต็มต่อ → หยุดบอท)
      //   แก้: กอง >100 กด "ครึ่ง" แทน (≤100 เสมอสำหรับกอง ≤200 · กองใหญ่กว่านั้นรอบถัดไปจะเล็กลงเรื่อยๆ จนฝากหมด)
      const stack = Math.max(0, card.count - card.lockedCount);
      const pick = stack > 100
        ? [...document.querySelectorAll('button')].find((b) => /^ครึ่ง$/.test((b.textContent || '').trim()) && npcVisible(b))
        : [...document.querySelectorAll('button')].find((b) => /^ทั้งหมด$/.test((b.textContent || '').trim()) && npcVisible(b));
      if (pick) { fireClick(pick); await sleep(250); }
      const sel = [...document.querySelectorAll('button')].find((b) => /^เลือก\s*\d+\s*(ตัว|ชิ้น)/.test((b.textContent || '').trim()) && npcVisible(b)); if (sel) { fireClick(sel); await sleep(400); }
      const dep = [...document.querySelectorAll('button')].find((b) => /ฝาก\s*→/.test(b.textContent || '') && npcVisible(b) && !b.disabled);
      // 🏬 v6.223: เลือกจำนวน ≤100 แล้วยังกด "ฝาก →" ไม่ได้ = คลังเต็ม (ไม่ใช่ปัญหากอง >100 ที่ ครึ่ง แก้แล้ว)
      //   เดิม continue เฉยๆ → ปลาใบเดิมถูกเลือกซ้ำทุกรอบ = วน 40 รอบเปล่า → กลับไปกระเป๋าเต็ม → วนไปเมืองไม่จบ
      if (!dep) { npcCloseQtyPopup(); await sleep(250); if (++fullSig >= 3) { storageFull = true; break; } continue; }
      fireClick(dep); done++; fullSig = 0; await sleep(800);              // ฝากได้ = รีเซ็ตตัวนับเต็ม
      }
      if (storageFull) {
        storageFullUntil = now() + 30 * 60000;   // พักระบบฝาก 30 นาที (กันวนไปเมืองฝากไม่ได้)
        say(`🏬 คลังลุงคลังเต็ม — ฝากได้ ${done} ใบแล้วเต็ม · พักระบบฝาก 30 นาที (ขยายคลัง / ปรับ "ระดับที่ฝาก" ให้แคบลง / เปิดแลกยายแก่น / หรือปิดฝาก)`);
        if (isOn('tgOn')) void tgSend(`⚠️ <b>คลังลุงคลังเต็ม</b> — บอทฝากปลาไม่ได้อีก (ฝากรอบนี้ ${done} ใบ) · พักระบบฝาก 30 นาที\nแนะนำ: ขยายคลัง หรือปรับ "ระดับที่ฝาก" ให้แคบลง หรือเปิดแลกยายแก่น เพื่อให้บอทระบายปลาต่อได้`);
      } else if (!done) say('🏬 เปิดคลังได้แต่ไม่มีปลาเข้าเกณฑ์ให้ฝาก');
    } catch (e) { logErr('npcDoStorage', e); }
    finally { npcCloseDialog(); await sleep(300); }   // 🛡️ v6.180: ปิด dialog เสมอ ไม่ว่าออกทางไหน (กัน popup ค้างบังจอแล้วเดินกลับ)
    return done;
  }
  // 🏪 v6.152 (B): ไปทำธุระเมืองประมง "ครั้งเดียวทำครบ" (แลกแก่น + ฝากของ + สุ่มหิน ตามที่ถึงเกณฑ์/เปิด) แล้วกลับแมพเดิม
  async function runTownErrands(due) {
    if (orchestrating || busy) return;
    orchestrating = true;
    // 🛡️ v6.160: fallback แมพบ้าน — ถ้า bossMapId() คืน null (scene งอแง) จะได้ไม่ค้างที่ fisher_town (แมพกับดักเดิน) เพราะ home=null ทำให้ข้ามการเดินกลับ
    const home = bossMapId() || cfg.bossHome || 'sea_dock';
    try {
      // 🔗 B (v6.155): มาเมืองทีเดียว = ทำ "ทุกบริการที่เปิด" เลย (ไม่ต้องรอ threshold แยกของแต่ละอัน) —
      //   เช่น trip นี้ถูก trigger เพราะแก่นครบ → ฝาก legendary ที่มี + สุ่มหิน ไปเลยในคราวเดียว (แม้ legendary ยังไม่ครบ min)
      //   npcDo* คืน 0 เองถ้าไม่มีอะไรทำ → เรียกได้ปลอดภัยเมื่อเปิด
      gameEscape();   // ⎋ v6.165: ล้างหน้าต่างค้างก่อนออกเดินทาง (dialog บังอยู่ = คลิก NPC/เดินไม่ได้)
      const storageOk = isOn('npcStorageOn') && now() >= storageFullUntil;   // 🏬 v6.223: คลังเต็มอยู่ = ข้ามฝาก (ไม่เสียเที่ยว)
      const plan = [isOn('npcEssenceOn') && 'แลกแก่น', storageOk && 'ฝากของ'].filter(Boolean).join(' + ') || '(คลังเต็ม — ข้ามฝาก)';   // v6.178: ตัดสุ่มหิน
      say(`🏪 ไปทำธุระเมืองประมง (ทีเดียวครบ): ${plan}`);
      if (!(await bossGameNavTo('fisher_town', 90000, true))) { say('🏪 ไปเมืองประมงไม่สำเร็จ'); return; }
      let es = 0, st = 0;
      if (isOn('npcEssenceOn')) { if (await npcWalkNear('kaen')) es = await npcDoEssence(); }
      if (storageOk) { if (await npcWalkNear('khlang')) st = await npcDoStorage(); }
      npcCloseDialog(); await sleep(300);   // 🛡️ v6.180: กันเดินกลับทั้งที่ popup NPC ยังค้างบังจอ (อาการที่ผู้ใช้เจอ)
      say(`🏪 ธุระเสร็จ — แลกแก่น ${es} · ฝาก ${st} — กลับไปฟาร์ม`);
      if (isOn('tgOn')) void tgSend(`🏪 ธุระเมืองประมงเสร็จ: แลกแก่น ${es} · ฝาก ${st}`);
      lastNpcErrandAt = now();
      if (home && home !== 'fisher_town') await bossGameNavTo(home, 90000, true);   // กลับแมพเดิม
    } catch (e) { logErr('runTownErrands', e); }
    finally { orchestrating = false; lastCast = now(); pendingCast = 0; }
  }
  // เช็คถึงเกณฑ์ไปเมืองประมงไหม (เรียกจาก idle branch · throttle หนักเพราะเปิดกระเป๋านับ = แพง/หยุดตกชั่วคราว)
  //   B: รวมทริป (ธุระที่ถึงเกณฑ์ทำครบทีเดียว) · C: ฝากเมื่อกระเป๋าเต็มถึง % (กันขายปลาแพง) · A: สุ่มหินพ่วงไปตอนถึงเมือง
  async function npcErrandCheck() {
    // 🧪 v6.165: เดิม testRunning บล็อกทริปเมือง "ตลอด" → เทสต์ยาว/ค้าง = rare+ ไม่มีทางระบาย → กระเป๋าเต็ม → บอทหยุด (เจอจริง)
    //   ตอนนี้: ถ้ากระเป๋าใกล้เต็ม (≥90%) ให้ไประบายได้แม้กำลังเทสต์ — กระเป๋าเต็ม = เทสต์เดินต่อไม่ได้อยู่ดี
    const bagCrit = bagFullTries > 0 || (lastBagPct != null && lastBagPct >= 90);
    if (orchestrating || busy || bossPhase !== 'idle' || mythicActive()) return;
    if (testRunning && !bagCrit) return;
    if (!isOn('npcStorageOn') && !isOn('npcEssenceOn')) return;   // v6.178: ตัด orbsmith
    if (now() - lastNpcErrandAt < 3 * 60000) return;          // เพิ่งไปมา = พัก 3 นาที
    if (now() - lastNpcCheckAt < 120000) return;              // นับกระเป๋าอย่างมากทุก 2 นาที
    lastNpcCheckAt = now();
    const c = await npcCountBag();
    const essenceDue = isOn('npcEssenceOn') && c.essence >= clamp(cfg.npcEssenceMin, 1, 300);
    const storageDue = isOn('npcStorageOn') && now() >= storageFullUntil    // 🏬 v6.223: คลังเต็มอยู่ = ไม่ทริกทริปฝาก (กันวนไปเมืองฝากไม่ได้)
      && (c.storage >= clamp(cfg.npcStorageMin, 1, 300)
      || (cfg.npcStorageBagPct > 0 && c.bagPct >= cfg.npcStorageBagPct && c.storage > 0));   // 🛡️ C: กระเป๋าเต็มถึง% + มีปลาเข้าเกณฑ์
    if (essenceDue || storageDue) return void runTownErrands({ essence: essenceDue, storage: storageDue });
  }

  // 👹 เฝ้าบันทึกสถานะบอส — เรียกทุก ~1 วิ (ทุกโหมด) · log เฉพาะตอน "สถานะเปลี่ยน" (present/dead/phase/ปุ่ม/HP)
  //   เก็บลง log ring → /report เห็นได้ · ไว้ถอดรหัสกลไกสู้บอส (ตีเอง/บอทตี ก็จับได้)
  //   บันทึกไทม์ไลน์บอสตัวล่าสุดแยกไว้ (bossFightLog) เผื่ออยากดูเป็นชุด
  let lastBossObs = 0, bossObsPrev = '', bossFightLog = [], bossObsHot = false, bossGaugeDom = '', lastGraphMap = '';
  function bossObserve() {
    try {
      const cm = bossMapId(); if (cm && cm !== BOSS_MAP) bossLastMapId = cm;   // v6.117: จำแมพฟาร์มล่าสุด (ไว้เป็นบ้าน)
      // 👹 v6.139: เรียนรู้กราฟแมพ "passive" — บันทึก exit ของแมพปัจจุบันทุกครั้งที่เปลี่ยนแมพ (จากการเดินปกติ/ผู้ใช้เดินเอง)
      //   แก้บั๊ก bossTravelTo ไม่รู้ route (เช่น village→boss_cave) — เดิม recordBossGraph เรียกเฉพาะตอน hunt · ตอนนี้เรียนจากทุกการเดิน
      if (cm && cm !== lastGraphMap) { lastGraphMap = cm; recordBossGraph(); }
      const rb = raidBossState();
      const orb = document.querySelector('button[aria-label="ตีบอส"]');
      const orbOn = !!(orb && !orb.disabled);
      bossObsHot = !!(rb || orb);   // มี context บอส (อยู่ถ้ำ/มีปุ่มตีบอส) → ให้ tick เฝ้าถี่ขึ้น
      if (!rb && !orb) { bossObsPrev = ''; return; }         // แมพปกติ ไม่มีบอส
      const hp = bossPlayerHpPct();
      // 🔍 v6.110: ตอนบอสอยู่ ดักจับ selector ที่ยังไม่ยืนยัน — เกจ + candidate "วงเขียว/แจ้งเตือนหลบ"
      let extra = '', gPresent = false, zoneKeys = '', greenN = 0, warnTxt = '';
      if (rb && rb.present) {
        const g = readGaugeWheel();
        if (g) { gPresent = true; extra += ` · เกจ[แดง ${g.a0}-${g.a1}° เข็ม ${g.ang}]`; }
        // v6.115: เก็บ style ดิบของ conic (เกจบอส) ครั้งเดียว/บอส → ยืนยัน/แก้ selector ได้ถ้า readGaugeWheel ยังพลาด
        if (!bossGaugeDom) { const cd = [...document.querySelectorAll('div[style*="conic-gradient"]')].find((e) => e.offsetWidth >= 180);
          if (cd) { bossGaugeDom = (cd.getAttribute('style') || '').slice(0, 300); try { W.localStorage.setItem('tokpla_boss_gauge_dom', bossGaugeDom); } catch {} logInfo(`🔎 เกจบอส conic: ${bossGaugeDom.slice(0, 120)}`); } }
        try { const sc = getPhaserScene();
          const zk = sc ? Object.keys(sc).filter((k) => /safe|dodge|zone|circle|telegraph|ring|green|warn/i.test(k)) : [];
          zoneKeys = zk.join(','); if (zk.length) extra += ` · sceneZone[${zoneKeys}]`;
        } catch {}
        greenN = [...document.querySelectorAll('div[class*="rounded-full"],div[class*="circle"]')]
          .filter((d) => { const s = getComputedStyle(d); return /rgb\(\s*\d{0,2},\s*(1[2-9]\d|2\d\d)/.test(s.backgroundColor) && d.offsetWidth > 40; }).length;
        if (greenN) extra += ` · DOMเขียว×${greenN}`;
        // 🔴 v6.113 (จากวิดีโอ): วงแดง AoE (bg แดง วงกลมใหญ่) = จังหวะโจมตี + HP บอส "X / Y" + ข้อความ "หลบ"
        const redN = [...document.querySelectorAll('div[class*="rounded-full"],div[class*="border"]')]
          .filter((d) => { const s = getComputedStyle(d); return /rgb\(\s*(1[5-9]\d|2\d\d),\s*\d{0,2},/.test(s.backgroundColor + s.borderColor) && d.offsetWidth > 100; }).length;
        if (redN) extra += ` · วงแดง×${redN}`;
        const bossHp = (document.body.innerText.match(/([\d,]{3,})\s*\/\s*([\d,]{3,})/) || [])[0];
        if (bossHp) extra += ` · บอสHP[${bossHp}]`;
        warnTxt = ([...document.querySelectorAll('div,button,span')].map((d) => (d.childElementCount === 0 ? (d.textContent || '') : '')).find((t) => /หลบ|เข้าวง|วงเขียว|โจมตี|ระวัง|ปลอดภัย/.test(t) && t.length < 40) || '').trim();
        if (warnTxt) extra += ` · เตือน["${warnTxt}"]`;
      }
      // key รวมสัญญาณใหม่ (มีเกจ/โซน/เขียว/เตือน) → log ตอน "โผล่/หาย" ไม่ spam ทุกองศาเข็ม
      const key = `${rb ? rb.present : '-'}|${rb ? rb.dead : '-'}|${rb ? rb.phase : '-'}|${orbOn}|${hp != null ? Math.round(hp / 5) : '-'}|${gPresent}|${zoneKeys}|${greenN}|${warnTxt}`;
      if (key === bossObsPrev) return;
      bossObsPrev = key;
      const line = `👹 บอส: มา=${rb ? rb.present : '?'} ตาย=${rb ? rb.dead : '?'} เฟส=${rb ? rb.phase : '?'} · ปุ่มตีบอส=${orb ? (orbOn ? 'กดได้!' : 'กดไม่ได้') : 'ไม่มี'} · HP=${hp != null ? Math.round(hp) + '%' : '?'} · แมพ=${bossMapId() || '?'}${extra}`;
      logInfo(line);
      bossFightLog.push(`${new Date().toLocaleTimeString('th-TH')} ${line}`);
      if (bossFightLog.length > 60) bossFightLog.shift();
      try { W.localStorage.setItem('tokpla_boss_fightlog', JSON.stringify(bossFightLog)); } catch {}
      // แจ้ง Telegram จังหวะสำคัญ (บอสโผล่/ตาย) — ไว้รู้ว่าควรเข้าไปดู
      if (isOn('tgOn') && rb && rb.present && rb.phase >= 2 && !rb.dead && orbOn) {
        if (now() - (bossObserve._tgAt || 0) > 60000) { bossObserve._tgAt = now(); void tgSend(`👹 <b>บอสโผล่แล้ว!</b> (ปุ่มตีบอสกดได้) HP เรา ${hp != null ? Math.round(hp) + '%' : '?'} · แมพ ${esc(bossMapId() || '?')}`); }
      }
    } catch {}
  }
  // เงื่อนไขเริ่มล่า (เรียกจาก idle branch) — ใกล้เวลา + ยังไม่เพิ่งล่า + อยู่โหมด bot/gameauto (ไม่ใช่ off)
  //   v6.121: idle branch เรียกทุก 150ms แต่ bossTimerMin = TreeWalker ทั้ง DOM (แพง) → cache ผล 5 วิ (เวลาบอสละเอียดระดับนาที เหลือเฟือ)
  let bossTimerCache = null, bossTimerCacheAt = 0;
  let lastBossBlockLog = 0;
  function bossHuntDue() {
    if (!isOn('bossHunt')) return false;
    // 📋 v6.199: อ่านเวลาบอส "ก่อน" เช็คตัวขวาง — เพื่อบันทึกได้ว่า "ถึงเวลาแล้วแต่ไม่ไปเพราะอะไร"
    //   (เดิม return ออกก่อนอ่านเวลา → ไม่มีทางรู้ย้อนหลังว่าพลาดเพราะคูลดาวน์/busy/เทสต์)
    if (now() - bossTimerCacheAt > 5000) { bossTimerCacheAt = now(); bossTimerCache = bossTimerMin(); }
    const min = bossTimerCache;
    // 🔫 v6.200: เห็นตัวนับ "รอบใหม่จริง" (มากกว่า lead) = arm กลับ — แปลว่าเกมตั้งรอบถัดไปแล้ว ไม่ใช่ป้ายค้าง
    if (!bossArmed && min != null && min > clamp(cfg.bossLeadMin, 1, 60)) setBossArmed(true);
    const due = min != null && min <= clamp(cfg.bossLeadMin, 1, 60);
    // 🛡️ v6.175: กัน "ออกล่ารอบใหม่ทับขากลับบ้านที่ยังเดินไม่ถึง" — ต้นเหตุแมพเด้ง ถ้ำ↔บ่อตกปลา 6 รอบ (HP เหลือ 16%)
    //   v6.199: คูลดาวน์ยาว/สั้นตามสาเหตุครั้งก่อน (ดู stampBossHunt) · อย่างน้อย 45 วิเสมอ
    const coolMs = Math.max(45000, bossHuntCoolMs);
    const coolLeft = coolMs - (now() - lastBossHuntAt);
    const why = orchestrating ? 'กำลังทำงานอื่น (orchestrating)'
      : busy ? 'บอทติดงานอื่นอยู่ (busy — เปิดร้าน/กระเป๋า/สลับเหยื่อ)'
      : bossPhase !== 'idle' ? `ยังอยู่ในเฟส ${bossPhase}`
      : coolLeft > 0 ? `คูลดาวน์หลังล่าครั้งก่อน เหลืออีก ${Math.ceil(coolLeft / 1000)} วิ`
      : !bossArmed ? 'รอบนี้ล่าไปแล้ว — รอเห็นตัวนับรอบใหม่ก่อน (กันป้าย "ถึงรอบบอสแล้ว" ค้างปลุกเที่ยวเปล่า)'
      : testRunning ? 'กำลังทดสอบเหยื่อ'
      : null;
    // บันทึกเฉพาะตอน "ถึงเวลาแล้วแต่ไปไม่ได้" (throttle 30 วิ กันสแปม) — นี่คือหลักฐานที่เคยหายไป
    if (due && why && now() - lastBossBlockLog > 30000) {
      lastBossBlockLog = now();
      bossEvent(`⏳ ถึงเวลาล่าแล้ว (บอสอีก ${min} นาที ≤ ตั้งไว้ ${cfg.bossLeadMin}) แต่ยังไม่ไป — ${why}`);
    }
    // 🧪 v6.148: เทสต์เหยื่อรันอยู่ + บอสใกล้มา → หยุดเทสต์ไปล่าบอสก่อน (resumeTestAfterBoss ทำต่อให้เอง)
    if (!orchestrating && !busy && bossPhase === 'idle' && coolLeft <= 0 && bossArmed && testRunning) {
      if (due) stopTest(true);   // v6.200: ต้อง armed ด้วย — ป้ายค้างห้ามไปหยุดเทสต์เหยื่อฟรีๆ
      return false;
    }
    if (why) return false;
    return due;
  }

  // ===== 🌈 โหมดล่าปลาเทพ (v6.122) — legendary/mythic + ปลาหนัก · อัตโนมัติ · กันขาดทุน =====
  // ปรัชญา: เป็น "ชั้นนโยบาย" ครอบระบบเดิม (override ที่ targetBait/turboEff/enforceBait/ยา) — ไม่เขียน cfg ผู้ใช้เลย
  //   ความจริงเกม: แรร์สุ่มต่อการตก 1 ครั้ง (สูตรโชคครอบด้วยคะแนน timing ที่บอทได้เต็มอยู่แล้ว · เหยื่อช่วย +0.02-0.33 น้อยมาก)
  //   → "บังคับ" ให้ออกปลาเทพไม่ได้ ทำได้แค่: ตกถี่สุด (turbo) + ต้นทุนต่ำสุด (เหยื่อถูก) + แมพอัตราดีสุด + ยา 🍀/🐋
  let mythicPotOff = false, mythicStrikes = 0, mythicNetPrev = null, mythicNetAt = 0, mythicStartAt = 0;
  let lastMythicChk = 0, lastMythicMoveAt = 0, lastMapLearnAt = 0;
  function mythicActive() { return isOn('mythicHunt') && !testRunning; }
  const MYTHIC_RAR = new Set(['legendary', 'mythic']);
  // จำนวนปลาเทพ (legendary+mythic) ที่ได้ตั้งแต่เริ่มล่ารอบนี้ — ใช้ใน heartbeat/สถานะ
  function mythicRoundCount() {
    const since = mythicStartAt || 0; let n = 0;
    for (const t of Object.keys(profit.recs || {})) for (const r of (profit.recs[t] || [])) if ((r.at || 0) >= since && MYTHIC_RAR.has(r.rarity)) n++;
    return n;
  }
  // เรียนรู้ "ชื่อแมพบน HUD ↔ id ใน Phaser" อัตโนมัติ — สถิติ (recs) เก็บชื่อ แต่ระบบเดินข้ามแมพใช้ id
  const MAP_NAME_KEY = 'tokpla_map_names';
  function learnMapName() {
    if (now() - lastMapLearnAt < 10000) return;   // bossMapId เดิน fiber — ไม่ทำถี่
    lastMapLearnAt = now();
    try {
      const id = bossMapId(), nm = curMap;
      if (!id || !nm || id === BOSS_MAP) return;
      const m = JSON.parse(W.localStorage.getItem(MAP_NAME_KEY) || '{}');
      if (m[nm] !== id) { m[nm] = id; W.localStorage.setItem(MAP_NAME_KEY, JSON.stringify(m)); }
    } catch {}
  }
  // คู่ชื่อ↔id ที่รู้แล้ว (ยืนยันสด 4 ตัวแรก · 2 ตัวหลังอนุมานจากผัง hub ใน GAME.md) — ค่าที่ "เรียนรู้สด" ชนะ seed เสมอ
  const MYTHIC_MAPS = [
    ['บ่อตกปลา', 'village'], ['ท่าเรือทะเล', 'sea_dock'], ['เมืองชาวประมง', 'fisher_town'],
    ['ลำธารผาทราย', 'river_bank'], ['หมู่บ้านน้ำแข็ง', 'ice'], ['บึงบัวน้ำใส', ''],   // บึงบัว: ยังไม่รู้ id — รอเรียนรู้สด
  ];
  function mapIdOfName(nm) {
    try { const learned = JSON.parse(W.localStorage.getItem(MAP_NAME_KEY) || '{}')[nm]; if (learned) return learned; } catch {}
    return (MYTHIC_MAPS.find(([n]) => n === nm) || [])[1] || null;
  }
  // ---- 🧠 ออโต้เลือกขั้นเหยื่อจากผลปลาเทพจริง (explore → exploit) ----
  //   ปัญหา: ปลาเทพ ~1%/cast → ตัวอย่างเล็กหลอกง่ายมาก · ทางแก้: (1) seed จากประวัติ recs ที่มีอยู่ (ไม่เริ่มตาบอด)
  //   (2) ขั้นไหนตัวอย่าง < 300 = "สำรวจ" หมุนเก็บทีละรอบ 150 cast เริ่มจากขั้นถูก (เสี่ยงเงินต่ำสุด)
  //   (3) ครบแล้ว "ใช้ตัวเด่น": คะแนน = มูลค่าปลาเทพ/cast − ส่วนต่างราคาเหยื่อจากขั้น 1 (ตอบตรงคำถาม "จ่ายแพงขึ้นคุ้มไหม")
  //       ขั้นแพงต้องมีปลาเทพ ≥3 ตัวในตัวอย่างถึงชนะได้ (1-2 ตัว = ฟลุ๊ค) · สุ่มสำรวจต่อ 10% กันข้อมูลตกยุค
  const MYTHIC_BAIT_KEY = 'tokpla_mythic_bait';
  const MB_ROUND = 150, MB_MIN_SAMPLE = 300, MB_MIN_MYTH = 3;
  let mbState = null;
  function mbLoad() {
    if (mbState) return mbState;
    try { mbState = JSON.parse(W.localStorage.getItem(MYTHIC_BAIT_KEY) || 'null'); } catch {}
    if (!mbState || !mbState.tiers) mbState = { tiers: {}, cur: 0, left: 0, seeded: false };
    // v6.132: seed ตั้งแต่โหลดครั้งแรก (ก่อนตัวนับสดเริ่มเดิน) — เดิม seed ตอน mbPick ครั้งแรก = "เขียนทับ" ตัวนับสดที่สะสมมาก่อน
    if (!mbState.seeded) mbSeed(mbState);
    return mbState;
  }
  function mbSave() { if (restoring) return; try { W.localStorage.setItem(MYTHIC_BAIT_KEY, JSON.stringify(mbState)); } catch {} }
  function mbSeed(st) {   // เครดิตประวัติจริงที่มีอยู่ให้ก่อน — ขั้นที่เคยตกเยอะไม่ต้องสำรวจซ้ำ
    // v6.132: merge แบบ max (ไม่ทับตัวนับสด/skipUntil) · หมายเหตุ: recs นับ "ติดปลา" ไม่ใช่เหวี่ยง แต่อัตราติด ~99% (11090/11199) เพี้ยน <1%
    for (const t of Object.keys(profit.recs || {})) {
      const list = profit.recs[t] || []; if (!list.length) continue;
      const lm = list.filter((r) => MYTHIC_RAR.has(r.rarity));
      const cur = st.tiers[t] || {};
      st.tiers[t] = {
        c: Math.max(cur.c || 0, list.length),
        mn: Math.max(cur.mn || 0, lm.length),
        mv: Math.max(cur.mv || 0, lm.reduce((a, r) => a + (r.price || 0), 0)),
        ...(cur.skipUntil ? { skipUntil: cur.skipUntil } : {}),
      };
    }
    st.seeded = true;
  }
  const mbScore = (s, t) => s && s.c ? s.mv / s.c - (baitUnit(t) - baitUnit(1)) : null;
  function mbPick() {
    const st = mbLoad();
    const cands = []; for (let t = 1; t <= (baitCeil || 8); t++) cands.push(t);
    // v6.132: ข้ามขั้นที่เพิ่งซื้อไม่ไหว (skipUntil) + ขั้นที่เงินตอนนี้ไม่พอ 1 แพ็ค (กันเดินเข้าร้านเก้อ)
    //   ใช้ pool เดียวกันทุกสาขา (สำรวจ/ตัวเด่น/สุ่ม) — เดิมกรองแค่สาขาสำรวจ ตัวเด่น/สุ่มยังเลือกขั้นที่ skip ได้ = วนซื้อพลาดซ้ำ
    const coins = coinsNow();
    const canTry = (t) => !(st.tiers[t]?.skipUntil > now()) && (coins == null || coins >= baitUnit(t) * PACK_SIZE);
    const pool = cands.filter(canTry);
    if (!pool.length) { st.cur = 1; st.left = MB_ROUND; mbSave(); return 1; }   // ซื้อไม่ไหวสักขั้น → ขั้น 1 (ถูกสุด/มีของเดิม)
    const under = pool.filter((t) => (st.tiers[t]?.c || 0) < MB_MIN_SAMPLE);
    let pick;
    if (under.length) pick = under[0];   // สำรวจขั้นถูกสุดที่ข้อมูลยังไม่พอก่อน
    else {
      let bestSc = -Infinity; pick = pool[0];
      for (const t of pool) {
        const s = st.tiers[t], sc = mbScore(s, t);
        if (sc == null) continue;
        if (t > 1 && (s.mn || 0) < MB_MIN_MYTH) continue;   // ขั้นแพงต้องพิสูจน์ด้วยปลาเทพ ≥3 ตัว
        if (sc > bestSc) { bestSc = sc; pick = t; }
      }
      if (Math.random() < 0.1) { const oth = pool.filter((t) => t !== pick); if (oth.length) pick = oth[randInt(0, oth.length - 1)]; }
    }
    st.cur = pick; st.left = MB_ROUND; mbSave();
    return pick;
  }
  function mythicAutoTier() { const st = mbLoad(); return (st.cur && st.left > 0) ? st.cur : mbPick(); }
  // hook จาก pushCastCost/pushCatch — เก็บทุกโหมด (ข้อมูลคือข้อมูล ความแม่นเกจเท่ากันทุกโหมด bot)
  function mythicBaitOnCast(tier) {
    const st = mbLoad(); const s = (st.tiers[tier] ||= { c: 0, mn: 0, mv: 0 });
    let roundEnded = false;
    s.c++; if (st.cur === tier && st.left > 0) { st.left--; roundEnded = st.left === 0; }
    // v6.132: เซฟเฉพาะทุก 20 cast หรือ "จบรอบพอดี" — เดิมเงื่อนไข st.left===0 ค้าง = เขียน localStorage ทุก cast (~500 ครั้ง/ชม.)
    if (s.c % 20 === 0 || roundEnded) mbSave();
  }
  function mythicBaitOnCatch(tier, rarity, price) {
    if (!MYTHIC_RAR.has(rarity)) return;
    const st = mbLoad(); const s = (st.tiers[tier] ||= { c: 0, mn: 0, mv: 0 });
    s.mn++; s.mv += price || 0; mbSave();
    if (mythicActive()) say(`🌈 ได้ปลาเทพ! ${rarity} ${(price || 0).toLocaleString()}🪙 (เหยื่อขั้น ${tier})`);
  }

  // คะแนนแมพ = มูลค่าปลาเทพ (legendary+mythic) ต่อชั่วโมงตกจริง — จาก recs ทุกขั้นเหยื่อ (เวลาคิดแบบ gap-capped)
  function mythicMapScores() {
    const by = {};
    for (const t of Object.keys(profit.recs || {})) for (const r of (profit.recs[t] || [])) { if (r.map) (by[r.map] = by[r.map] || []).push(r); }
    const out = [];
    for (const nm of Object.keys(by)) {
      const list = by[nm].sort((a, b) => (a.at || 0) - (b.at || 0));
      const mins = activeMins(list);
      if (mins < 45) continue;   // ตกจริงน้อยกว่า ~45 นาที = สถิติยังไม่พอ
      const lm = list.filter((r) => MYTHIC_RAR.has(r.rarity));
      out.push({ map: nm, hr: mins / 60, lmN: lm.length, lmValHr: Math.round(lm.reduce((a, c) => a + (c.price || 0), 0) / (mins / 60)) });
    }
    return out.sort((a, b) => b.lmValHr - a.lmValHr);
  }
  // 🛡️ no-loss gate: วัด "กำไรสุทธิจริง/ชม." (lifeNet รวมทุกต้นทุน เหยื่อ+ยา+กาแฟ) เป็นช่วงๆ
  //   ติดลบ 1 รอบ → งดยาโหมด (ตัดต้นทุนใหญ่สุด) · ติดลบ 2 รอบติด → พักโหมดทั้งตัว (sessionOff — ค่าที่ผู้ใช้ตั้งไม่ถูกแตะ)
  function mythicGateTick() {
    if (now() - lastMythicChk < clamp(cfg.mythicCheckMin, 5, 120) * 60000) return;
    lastMythicChk = now();
    const net = lifeNet();
    if (mythicNetPrev == null) { mythicNetPrev = net; mythicNetAt = now(); return; }   // รอบแรก = ตั้งจุดอ้างอิง
    const hrs = (now() - mythicNetAt) / 3600000;
    // v6.132: หน้าต่างวัดยาวผิดปกติ (>2 เท่าของรอบเช็ค) = บอทเพิ่งกลับจากพัก/แท็บถูกซ่อน — ตั้งจุดอ้างอิงใหม่ ไม่ตัดสิน
    //   (wall-clock คร่อมช่วงไม่ได้ตก: จ่ายค่ายาก่อนพักนิดเดียวก็ดูเหมือน "ติดลบ" ทั้งที่ตกจริงกำไร)
    if (hrs > (clamp(cfg.mythicCheckMin, 5, 120) / 60) * 2) { mythicNetPrev = net; mythicNetAt = now(); return; }
    const rate = hrs > 0 ? Math.round((net - mythicNetPrev) / hrs) : 0;
    mythicNetPrev = net; mythicNetAt = now();
    // deadband −300/ชม.: ลบจิ๋วระดับเศษค่าเหยื่อ = noise ไม่ใช่ขาดทุนจริง (เดิม −1 ก็โดน strike)
    if (rate >= -300) {
      if (mythicStrikes || mythicPotOff) say('🌈 กำไรสุทธิกลับเป็นบวก — ล่าต่อเต็มรูปแบบ');
      mythicStrikes = 0; mythicPotOff = false;
      return;
    }
    mythicStrikes++;
    if (mythicStrikes === 1) {
      mythicPotOff = true;
      say(`🌈 กำไรสุทธิติดลบ (${rate.toLocaleString()}/ชม.) — งดยาโหมดล่าปลาเทพชั่วคราว (กันขาดทุน)`);
      if (isOn('tgOn') && isOn('tgWarn')) void tgSend(`🌈 <b>ล่าปลาเทพ: กำไรเริ่มติดลบ</b> (${rate.toLocaleString()}/ชม.) — งดยาชั่วคราว · ถ้าลบอีกรอบจะพักโหมดเอง`);
    } else {
      mythicStrikes = 0; mythicPotOff = false;
      disableForSession('mythicHunt', `🌈 กำไรสุทธิติดลบ 2 รอบติด (${rate.toLocaleString()}/ชม.) — พักโหมดล่าปลาเทพ กลับฟาร์มปกติ (เปิดใหม่ได้ในแผง)`);
    }
  }
  // เลือกแมพเป้า: ผู้ใช้ล็อก (mythicMap) หรืออัตโนมัติจากสถิติ — ย้ายเฉพาะเมื่อดีกว่าเดิมชัดเจน (>25%) และรู้ id แล้ว
  let lastMythicEvalAt = 0;
  function mythicMoveDue() {
    if (now() - lastMythicMoveAt < 30 * 60000) return null;   // ไม่ย้ายถี่กว่า 30 นาที (เสียเวลาเดิน = เสียโอกาสตก)
    // 🐛 v6.132 perf: พอพ้น cooldown แล้วถ้าคืน null (อยู่แมพดีสุด/ไม่รู้ id) ไม่มีอะไรอัปเดต lastMythicMoveAt
    //   → mythicMapScores (ไล่ recs ทุกขั้น + sort) โดนเรียกทุก idle tick (150ms) ตลอด → ประเมินแค่ทุก 60 วิ พอ
    if (now() - lastMythicEvalAt < 60000) return null;
    lastMythicEvalAt = now();
    let name = null, id = null;
    // v6.132: ไม่รู้ id = "ไม่เดิน" จริงๆ — เดิม fallback เป็นชื่อไทย → bossTravelTo เดินสำรวจมั่ว 10 hops ทุก 30 นาที
    if (cfg.mythicMap) { name = cfg.mythicMap; id = mapIdOfName(cfg.mythicMap); }
    else {
      const sc = mythicMapScores();
      if (!sc.length) return null;
      const best = sc[0];
      if (best.lmN < 3) return null;                                    // ปลาเทพ < 3 ตัว = ฟลุ๊คได้ ยังไม่ย้ายตาม
      const cur = sc.find((s) => s.map === curMap);
      if (cur && cur.map === best.map) return null;                     // อยู่แมพดีสุดแล้ว
      if (cur && best.lmValHr < cur.lmValHr * 1.25) return null;        // ดีกว่าไม่ถึง 25% = ไม่คุ้มเดิน
      name = best.map; id = mapIdOfName(best.map);
    }
    if (!id || id === BOSS_MAP || id === bossMapId()) return null;      // ไม่รู้ id (จะรู้เองเมื่อเคยไป+learnMapName) / อยู่แล้ว
    return { id, name };
  }
  async function runMythicMove(id, name) {
    if (orchestrating || busy) return;
    orchestrating = true;
    try {
      say(`🌈 ย้ายไปล่าปลาเทพที่ ${name || id} (สถิติมูลค่าปลาเทพ/ชม. ดีสุด)`);
      if (!await bossCanControl()) {
        say('🌈 เดินไม่ได้ตอนนี้ (แท็บเกมต้องอยู่หน้าสุด) — ล่าที่แมพเดิมไปก่อน');
        lastMythicMoveAt = now() + 25 * 60000;   // เว้นนานขึ้น กันลองรัว
        return;
      }
      const ok = await bossTravelTo(id);
      say(ok ? `🌈 ถึง ${name || id} — เริ่มล่า` : '🌈 เดินไปแมพเป้าไม่สำเร็จ — ล่าที่เดิมไปก่อน');
      if (ok && isOn('tgOn')) void tgSend(`🌈 ย้ายไปล่าปลาเทพที่ <b>${esc(name || id)}</b>`);
    } catch (e) { logErr('ย้ายแมพล่าปลาเทพล้มเหลว', e); }
    finally { bossReleaseAll(); orchestrating = false; lastMythicMoveAt = now(); lastCast = now(); pendingCast = 0; }
  }

  // เกจวงล้อ: โซนแดง [a0,a1] องศา + มุมเข็ม
  //   v6.118: จับสดตอนบอสจริง — "เกจบอส" = conic-gradient แดงพันรอบยอด [340,360]∪[0,20] กว้างแค่ "104px"
  //     (เล็กกว่าเกจตกปลา 180+) → เดิม threshold ≥180 เลย skip = อ่านเกจบอสไม่ได้เลย!
  //     แก้: ≥90 (ตัดสำเนา orb ~56) + เลือก "วงแดงใหญ่สุด" (fishing→180+, boss→104, กันสำเนาเล็กแย่ง)
  //     + รองรับแดงพันรอบ: มีแดงจบที่ 360° → ตั้ง a0 ติดลบ (340-360=-20) ให้ inRed ครอบแถบเต็มยอดได้
  function readGaugeWheel() {
    let best = null, bestW = 0;
    for (const d of document.querySelectorAll('div[style*="conic-gradient"]')) {
      const w = d.offsetWidth;
      if (w < 90 || w <= bestW) continue;                      // ≥90 ตัดสำเนา orb · เอาวงใหญ่สุดที่มีแดง
      const st = d.getAttribute('style') || '';
      let a0, a1;
      const m = st.match(/conic-gradient\(rgb\(255,\s*\d+,\s*\d+\)\s*([\d.]+)deg,\s*rgb\(255,\s*\d+,\s*\d+\)\s*([\d.]+)deg/);
      if (m) { a0 = +m[1]; a1 = +m[2]; }                       // แดงมาก่อน (เกจตกปลา + เกจบอส)
      else {
        // fallback: หา color-stop สีแดง (r>190,g<110,b<110) แล้วโซนแดง = [deg ของแดง, deg stop ถัดไป]
        const stops = [...st.matchAll(/rgb\(\s*(\d+),\s*(\d+),\s*(\d+)\s*\)\s*([\d.]+)deg/g)]
          .map((s) => ({ r: +s[1], g: +s[2], b: +s[3], deg: +s[4] }));
        if (stops.length < 2) continue;
        const ri = stops.findIndex((s) => s.r > 190 && s.g < 110 && s.b < 110);
        if (ri < 0) continue;
        a0 = stops[ri].deg;
        a1 = ri + 1 < stops.length ? stops[ri + 1].deg : a0 + 22;
      }
      // แดงพันรอบยอด (เกจบอส): แดงอีกช่วงจบที่ 360° เช่น rgb(255,..) 340deg, rgb(255,..) 360deg)
      //   → ขยาย a0 เป็นค่าลบ (=-20) ให้ครอบ [340,360]∪[0,a1] (เกจตกปลาจบด้วยทอง/เขียว = ไม่เข้าเงื่อนไข)
      const wm = st.match(/rgb\(255,\s*\d+,\s*\d+\)\s*([\d.]+)deg,\s*rgb\(255,\s*\d+,\s*\d+\)\s*360deg\)/);
      if (wm && +wm[1] > a1) a0 = +wm[1] - 360;
      // เข็ม: sibling ก่อน (เกจตกปลา) · ไม่เจอ → หาในลูกหลาน parent/grandparent (เกจบอสอาจซ้อนลึก)
      let ang = null;
      for (const sib of d.parentElement.children) {
        const mm = (sib.getAttribute('style') || '').match(/rotate\((-?[\d.]+)deg\)/);
        if (mm) { ang = +mm[1]; break; }
      }
      if (ang == null) {
        for (const p of [d.parentElement, d.parentElement && d.parentElement.parentElement]) {
          if (!p) continue;
          for (const el of p.querySelectorAll('[style*="rotate"]')) {
            const mm = (el.getAttribute('style') || '').match(/rotate\((-?[\d.]+)deg\)/); if (mm) { ang = +mm[1]; break; }
          }
          if (ang != null) break;
        }
      }
      best = { a0, a1, ang, w }; bestW = w;                    // เก็บวงใหญ่สุดที่มีแดง แล้ววนต่อ (ไม่ return ทันที) · w ให้ผู้เรียกแยกเกจตกปลา/บอส
    }
    return best;
  }
  // ชักเย่อ (เฟส 4): กรอบ (bottom/height %) + ปลา (bottom % หรือ calc(X% ± Ypx)) — เกมห่อ calc() บางจังหวะ
  function readTugState() {
    let box = null, fish = null, boxEl = null;
    for (const d of document.querySelectorAll('div[class*="border-2"]')) {
      const st = d.getAttribute('style') || '';
      if (!/bottom/.test(st) || !/height/.test(st)) continue;
      const mb = st.match(/bottom:\s*(?:calc\()?\s*([\d.]+)%/), mh = st.match(/height:\s*(?:calc\()?\s*([\d.]+)%/);
      if (mb && mh) { box = { b: +mb[1], h: +mh[1] }; boxEl = d; break; }
    }
    if (!boxEl) return null;
    // ปลาเป็น sibling ใน container เดียวกับกรอบ (emoji สัตว์น้ำ + style bottom)
    for (const d of boxEl.parentElement.children) {
      const tx = (d.textContent || '').trim();
      if (tx.length > 4 || !/[\u{1F41F}\u{1F420}\u{1F421}\u{1F988}\u{1F990}\u{1F980}\u{1F419}]/u.test(tx)) continue;
      const st = d.getAttribute('style') || '';
      const mc = st.match(/bottom:\s*calc\(([\d.]+)%\s*([+-])\s*([\d.]+)px\)/);
      const mp = st.match(/bottom:\s*(?:calc\()?\s*([\d.]+)%/);
      if (mc) fish = { pct: +mc[1], px: (mc[2] === '-' ? -1 : 1) * +mc[3] };
      else if (mp) fish = { pct: +mp[1], px: 0 };
      if (fish) break;
    }
    if (!fish) return null;
    const H = boxEl.parentElement.getBoundingClientRect().height || 340;
    return { boxB: box.b, boxH: box.h, fishPct: fish.pct + (fish.px / H) * 100 };
  }
  // ปลาสู้ (เฟส 5): สัญญาณหลัก = orb "🔥" (เหมือน ❗ ตวัด / ✊ ชักเย่อ) — เชื่อได้สุด
  //   ⚠️ v6.86: เดิมสแกน banner bg-black แต่ banner จริงใช้ bg-[#c0392b] (แดงเข้ม) → หาไม่เจอ = บอทไม่กดสู้ (บั๊กที่ผู้ใช้เจอ)
  const fightActive = () => {
    const orb = qBtn('ตกปลา (F)');
    if (orb && (orb.textContent || '').includes('🔥')) return true;
    for (const d of document.querySelectorAll('div[class*="rounded-full"]')) {   // เผื่อ orb อ่านไม่ได้
      if (/กดรัว|ปลาสู้/.test(d.textContent || '')) return true;
    }
    return false;
  };
  // กดค้าง/ปล่อย orb (ชักเย่อใช้ pointerdown ค้างไว้ · เกมฟัง onPointerDown/Up ผ่าน React)
  let orbHeld = false;
  function orbDown(el) { if (!el || orbHeld) return; const r = el.getBoundingClientRect(); const b = { bubbles: true, cancelable: true, button: 0, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2, pointerId: 1, isPrimary: true }; el.dispatchEvent(new PointerEvent('pointerdown', b)); el.dispatchEvent(new MouseEvent('mousedown', b)); orbHeld = true; }
  function orbUp(el) { if (!orbHeld) return; el = el || qBtn('ตกปลา (F)'); if (el) { const r = el.getBoundingClientRect(); const b = { bubbles: true, cancelable: true, button: 0, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2, pointerId: 1, isPrimary: true }; el.dispatchEvent(new PointerEvent('pointerup', b)); el.dispatchEvent(new MouseEvent('mouseup', b)); } orbHeld = false; }
  // สถานะภายในเอนจิน (รีเซ็ตเมื่อออกจากเฟส)
  let gaugeDone = false, gaugeStartMs = 0, gaugeSwept = false, gaugeMiss = false;
  let tugPrevBox = null, tugPrevFish = null, tugPrevT = 0, tugVBox = 0, tugVFish = 0;
  let lastFightTap = 0;
  function resetGaugeTracking() { gaugeDone = false; gaugeStartMs = 0; gaugeSwept = false; gaugeMiss = false; }
  function resetFishEngine() { resetGaugeTracking(); tugPrevBox = null; tugVBox = 0; tugVFish = 0; if (orbHeld) orbUp(null); }

  // 🎯 ตัววัดความแม่นเกจ — ให้ผู้ใช้ตรวจว่า "กดโดนดาวจริงไหม" (ตาดูไม่ทันเพราะเข็มหมุน ~280°/วิ)
  //   วัดสด: ดาวครอบ ±7.3° รอบ 0° (กว้าง 33px / รัศมี 128px) → เกณฑ์ 8° = โดนดาว · แดง = [0,22°]
  //   บอทอ่านมุมเข็ม (transform:rotate) ตอนกดได้แม่นระดับ 0.1° จึงรู้แน่ชัดว่ากดโดนที่กี่องศา
  const GAUGE_STAR_DEG = 8;
  let gaugeStat = { n: 0, sumDist: 0, star: 0, last: null };
  function recordGaugePress(ang, rev) {
    const dist = Math.min(Math.abs(ang), 360 - Math.abs(ang));   // ระยะจากดาว (0°) แบบวนรอบ
    gaugeStat.n++; gaugeStat.sumDist += dist; gaugeStat.last = +dist.toFixed(1);
    if (dist <= GAUGE_STAR_DEG) gaugeStat.star++;
    // สถิติเกจถาวรต่อโหมด (เกจมีเฉพาะโหมด bot) — ไว้เทียบความแม่นระยะยาว
    const gb = modeStats.bot.gauge; gb.n++; gb.sumDist += dist; if (dist <= GAUGE_STAR_DEG) gb.star++;
    if (fishTrace) { fishTrace.gaugeDist = +dist.toFixed(1); fishTrace.gaugeRev = rev || 0; }
    console.log(`[Tokpla Bot] 🎯 เกจ: กดที่ ${dist.toFixed(1)}° จากดาว ${dist <= GAUGE_STAR_DEG ? '⭐ โดนดาว!' : '(ในแดง ไม่โดนดาว)'}`);
    if (gaugeStat.n % 10 === 0) logInfo(`🎯 เกจ ${gaugeStat.n} ครั้ง: โดนดาว ${Math.round(gaugeStat.star / gaugeStat.n * 100)}% (${gaugeStat.star}/${gaugeStat.n}) · เฉลี่ย ${(gaugeStat.sumDist / gaugeStat.n).toFixed(1)}° จากดาว`);
  }
  function gaugeLine() {
    if (!gaugeStat.n) return '';
    return `\n🎯 เกจ: โดนดาว ${gaugeStat.star}/${gaugeStat.n} (${Math.round(gaugeStat.star / gaugeStat.n * 100)}%) · เฉลี่ย ${(gaugeStat.sumDist / gaugeStat.n).toFixed(1)}° จากดาว · ล่าสุด ${gaugeStat.last}°`;
  }

  // 📋 บันทึกทุกขั้นตอนการตกปลา "ต่อ 1 ตัว" → สรุป 1 บรรทัดลง log (ผู้ใช้ /report ส่งให้วิเคราะห์ได้)
  //   เก็บ: เวลาตวัด(ปลากิน→กด) · มุมกดเกจ+จำนวนรอบที่รอ · เวลาชักเย่อ+progress · จำนวนกดสู้ · เวลารวม
  let fishTrace = null, fishSeq = 0;
  function traceCast() { fishTrace = { t0: now(), hook: null, gaugeDist: null, gaugeRev: 0, tugStart: null, tugEnd: null, tugProg: null, fightTaps: 0 }; }
  function traceHook() { if (fishTrace && fishTrace.hook == null) fishTrace.hook = Math.round(now() - fishTrace.t0); }
  function traceSummary() {
    if (!fishTrace) return '(ไม่มีข้อมูลจังหวะ)';
    const T = fishTrace, parts = [];
    parts.push(T.hook != null ? `ตวัด ${T.hook}ms` : 'ตวัด —');
    parts.push(T.gaugeDist != null ? `เกจ ${T.gaugeDist}°${T.gaugeDist <= GAUGE_STAR_DEG ? '⭐' : '🔴'}${T.gaugeRev ? ` (รอ ${T.gaugeRev} รอบ)` : ''}` : 'เกจ —');
    if (T.tugStart != null) parts.push(`ชักเย่อ ${T.tugEnd != null ? ((T.tugEnd - T.tugStart) / 1000).toFixed(1) : '?'}s${T.tugProg != null ? `→${T.tugProg}%` : ''}`);
    parts.push(`สู้ ${T.fightTaps} กด`);
    parts.push(`รวม ${((now() - T.t0) / 1000).toFixed(1)}s`);
    return parts.join(' · ');
  }

  // ===== 🔬 ระบบสถิติ 2 แบบ (v6.88) — เก็บแยก "บอทตกเอง" vs "เกมตกอัตโนมัติ" แบบถาวร =====
  // เพื่อเปรียบเทียบ+วิเคราะห์ระยะยาว · เก็บต่อโหมด: จำนวน · รายได้ · ต้นทุนเหยื่อ · น้ำหนัก · ขยะ · rarity · ขั้นเหยื่อ · พลังงาน · (bot) ความแม่นเกจ
  // ป้อนต่อการตก 1 ตัว จาก 2 เส้นทางที่แยกกันชัด: pushCatch (bot/popup DOM มีคะแนน) · recordGameCatch (gameauto/React state)
  // พลังไม่เกี่ยวความแรร์ (ยืนยัน tooltip เกม: แรร์=จังหวะกดโดนดาว) → บอทกดดาวแม่นจึงควรแรร์กว่า auto
  const MODESTATS_KEY = 'tokpla_bot_modestats';
  const newModeBucket = () => ({ n: 0, rev: 0, baitCost: 0, wSum: 0, junk: 0, rar: {}, tier: {}, gauge: { n: 0, star: 0, sumDist: 0 }, eFirst: null, eLast: null, since: 0, lastAt: 0 });
  function loadModeStats() {
    try { const r = W.localStorage.getItem(MODESTATS_KEY); if (r) { const o = JSON.parse(r); if (o && o.bot && o.gameauto) { o.bot.gauge ||= { n: 0, star: 0, sumDist: 0 }; o.gameauto.gauge ||= { n: 0, star: 0, sumDist: 0 }; return o; } } } catch {}
    return { v: 1, bot: newModeBucket(), gameauto: newModeBucket() };
  }
  let modeStats = loadModeStats();
  let lastModeSave = 0;
  function saveModeStats() { if (restoring) return; try { W.localStorage.setItem(MODESTATS_KEY, JSON.stringify(modeStats)); } catch {} }
  // ป้อนสถิติ 1 ตัวเข้ากล่องของโหมดนั้น — เรียกจาก pushCatch (bot) + recordGameCatch (gameauto) · พลังอ่านจาก DOM (มีทั้ง 2 โหมด)
  function feedModeStats(mode, d) {
    if (mode !== 'bot' && mode !== 'gameauto') return;
    const b = modeStats[mode]; if (!b) return;
    b.n++; b.rev += d.price || 0; b.baitCost += d.baitCost || 0; b.wSum += d.weight || 0;
    if (d.junk) b.junk++;
    const rar = d.rarity || '?'; b.rar[rar] = (b.rar[rar] || 0) + 1;
    if (d.tier) b.tier[d.tier] = (b.tier[d.tier] || 0) + 1;
    const e = energyPct(); if (e != null) { if (b.eFirst == null) b.eFirst = +e.toFixed(2); b.eLast = +e.toFixed(2); }
    if (!b.since) b.since = Date.now();
    b.lastAt = Date.now();
    if (Date.now() - lastModeSave >= 5000) { lastModeSave = Date.now(); saveModeStats(); }
  }
  const RARE_SET = new Set(['rare', 'epic', 'legendary', 'mythic']);
  const rareCount = (rar) => Object.entries(rar).filter(([k]) => RARE_SET.has(k)).reduce((s, [, v]) => s + v, 0);
  function cmpModeLine(mode) {
    const b = modeStats[mode];
    const tag = mode === 'bot' ? '🤖 บอทตกเอง' : '🎮 เกมออโต้';
    if (!b || !b.n) return `${tag}: (ยังไม่มีข้อมูล — สลับมาโหมดนี้แล้วตกสักพัก)`;
    const net = b.rev - b.baitCost;
    const rarePct = Math.round(rareCount(b.rar) / b.n * 100);
    const junkPct = Math.round(b.junk / b.n * 100);
    const eDrop = (b.eFirst != null && b.eLast != null) ? +(b.eFirst - b.eLast).toFixed(1) : null;
    const ePer = (eDrop != null && b.n > 1) ? (eDrop / (b.n - 1)).toFixed(3) : '?';
    const mins = (b.since && b.lastAt > b.since) ? (b.lastAt - b.since) / 60000 : 0;
    const perHr = mins > 0.5 ? Math.round(b.n / mins * 60) : null;
    const gauge = (mode === 'bot' && b.gauge.n) ? ` · เกจโดนดาว ${Math.round(b.gauge.star / b.gauge.n * 100)}% (เฉลี่ย ${(b.gauge.sumDist / b.gauge.n).toFixed(1)}°)` : '';
    const tierStr = Object.entries(b.tier).sort((a, c) => c[1] - a[1]).map(([t, v]) => `ขั้น${t}:${v}`).join(' ') || '—';
    const rarStr = Object.entries(b.rar).sort((a, c) => c[1] - a[1]).map(([k, v]) => `${k} ${v}`).join(' · ');
    return `${tag}: ${b.n} ตัว${perHr ? ` (~${perHr}/ชม · ${mins.toFixed(0)} นาที)` : ''}\n`
         + `   💰 เฉลี่ย ${Math.round(b.rev / b.n).toLocaleString()}🪙/ตัว · กำไรสุทธิหักเหยื่อ ${signed(net)}🪙 (${signed(net / b.n)}/ตัว)\n`
         + `   น้ำหนักเฉลี่ย ${(b.wSum / b.n).toFixed(2)}กก · แรร์+ ${rarePct}% · ขยะ ${junkPct}%${gauge}\n`
         + `   พลังงาน ${eDrop != null ? `${b.eFirst}%→${b.eLast}% (${ePer}%/ตัว)` : '—'} · เหยื่อ ${tierStr}\n`
         + `   rarity: ${rarStr}`;
  }
  function modeCompareText() {
    const b = modeStats.bot, g = modeStats.gameauto;
    let verdict = '';
    if (b.n >= 5 && g.n >= 5) {
      const bNet = (b.rev - b.baitCost) / b.n, gNet = (g.rev - g.baitCost) / g.n;
      verdict = `\n\n📌 สรุปต่อตัว: กำไร บอท ${signed(bNet)} vs เกมออโต้ ${signed(gNet)}🪙 · แรร์+ บอท ${Math.round(rareCount(b.rar)/b.n*100)}% vs ${Math.round(rareCount(g.rar)/g.n*100)}%`;
    }
    return `🔬 เทียบโหมดตกปลา (สะสมถาวร · พลังไม่เกี่ยวแรร์ · แรร์=กดโดนดาว)\n\n${cmpModeLine('bot')}\n\n${cmpModeLine('gameauto')}${verdict}\n\nℹ️ ตกโหมดบอทสักพัก→สลับเกมออโต้สักพัก→เทียบ · เงิน/ชม.จริง = กำไร/ตัว × ตัว/ชม · กด ♻️ ล้างเริ่มนับใหม่`;
  }
  function resetModeCmp() { modeStats = { v: 1, bot: newModeBucket(), gameauto: newModeBucket() }; saveModeStats(); }

  // ---- ปุ่ม "ขายทั้งหมด" ของแท็บปัจจุบัน ----
  // เกมเปลี่ยน UI กระเป๋าเป็นระบบแท็บ (ปลา/ขยะ/อุปกรณ์) ข้อความปุ่มจึงเปลี่ยนจาก
  //   "ขายทั้งหมด N 🪙"  →  "ขายปลาทั้งหมด N 🪙" / "ขายขยะทั้งหมด N 🪙"
  // (ไม่แมตช์ "ขายคืนทั้งหมด" ของแท็บเหยื่อ เพราะขึ้นต้น "ขายคืน")
  const SELL_ALL_RE = /^ขาย(ปลา|ขยะ)?ทั้งหมด/;
  const sellAllBtn = () =>
    [...document.querySelectorAll('button')].find((b) => SELL_ALL_RE.test(b.textContent.trim())) || null;

  // ---- ปุ่มสลับแท็บกระเป๋า (ปลา/ขยะ/เบ็ด/...) : ข้อความปุ่ม = label เช่น "🗑️ ขยะ" ----
  // แมตช์แบบตรงตัวก่อน ถ้าพลาด (emoji เพี้ยน) ค่อย fallback หา keyword โดยตัดปุ่ม "ขาย.."/"แน่ใจ.." ออก
  const tabBtn = (label, kw) =>
    [...document.querySelectorAll('button')].find((b) => b.textContent.trim() === label) ||
    [...document.querySelectorAll('button')].find((b) => {
      const t = b.textContent.trim();
      return t.includes(kw) && !/^ขาย|^แน่ใจ/.test(t);
    }) || null;
  const junkTabBtn = () => tabBtn('🗑️ ขยะ', 'ขยะ');

  // ---- อ่าน toast ผลการขาย + บวกยอด earned (กันนับซ้ำด้วย WeakSet ต่อ element) ----
  // ใช้ร่วมกันทั้งการขายปลาและขายขยะ (ขาย 2 รอบต่อเนื่อง จึงต้อง dedup ไม่ให้ยอดซ้ำ)
  const seenEarned = new WeakSet();
  async function readSellToast() {
    const scopeEl = () => qBtn('ปิดเมนู')?.closest('div[class*="fixed"], div[class*="absolute"]');
    const freshToast = () => {
      for (const scope of [scopeEl(), document]) {
        if (!scope) continue;
        for (const el of scope.querySelectorAll(TOAST_SEL)) {
          if (!/bg-\[#6fb54a\]|bg-red-600/.test(el.className)) continue;
          if (seenEarned.has(el)) continue;          // ข้าม toast รอบก่อนที่นับไปแล้ว
          if (el.textContent.trim()) return el;
        }
      }
      return null;
    };
    const el = await waitFor(freshToast, 8000);
    if (!el) { say('ขายแล้ว แต่ไม่เห็นข้อความยืนยัน'); return null; }
    seenEarned.add(el);
    const toast = el.textContent.trim();
    const m = /\+([\d,]+)\s*🪙/.exec(toast);
    if (m) earned += parseInt(m[1].replace(/,/g, ''), 10);   // earned = ยอดโชว์บนป้าย · กำไรนับผ่าน observer แยก
    say(toast);
    if (/ไม่สำเร็จ|ยังไม่พร้อม/.test(toast)) {
      disableForSession('sell', `${toast} — พักระบบขายอัตโนมัติไว้ก่อน (เซสชันนี้)`);
    } else if (cfg.tgTrade) {
      void tgSend(`💰 ${esc(toast)}`);
    }
    return toast;
  }

  // ---- กดขายทั้งหมดของแท็บปัจจุบัน (ปลา/ขยะ) แล้วยืนยัน + อ่านผล ----
  async function sellAllCurrentTab() {
    const b1 = sellAllBtn();
    if (!b1) { say('หาปุ่มขายทั้งหมดไม่เจอ'); return false; }
    fireClick(b1);
    const b2 = await waitFor(() => btnByText('แน่ใจนะ?'), 2000);
    if (!b2) { say('ปุ่มยืนยันไม่โผล่'); return false; }
    fireClick(b2);
    await readSellToast();
    return true;
  }

  async function waitFor(fn, timeout = 5000, step = 100) {
    const t0 = now();
    for (;;) {
      const v = fn();
      if (v) return v;
      if (now() - t0 > timeout) return null;
      await sleep(step);
    }
  }

  // ---- อ่านการ์ดของในกระเป๋า ----
  // v7: aria-label = "✨ ชื่อปลา ×3" และต่อท้าย " ล็อก N" เมื่อกลุ่มมีตัวที่ผู้เล่นล็อกไว้ (เกมกันไม่ให้ขาย)
  //     สีขอบระดับความหายากย้ายไปอยู่ที่ div ครอบ (.tk-inner ที่มี --tw-ring-color) ไม่ใช่ที่ตัวปุ่มแล้ว
  // 🎨 v6.222: ระดับที่ "เคยบันทึกตอนจับ" (จาก popup ผลตกปลา — คนละ code path กับสีขอบกระเป๋า) → fallback เมื่ออ่านสีขอบไม่ได้
  //   ปลอดภัย: ปลาชนิดเดียวกันมีระดับเดียวเสมอ (คอมเมนต์ sellPlan) → ใช้ระดับที่จำได้แทนได้ตรง
  function recordedRarity(species) {
    try {
      for (const t of Object.keys(profit.recs || {})) {
        const arr = profit.recs[t] || [];
        for (let i = arr.length - 1; i >= 0; i--) { const c = arr[i]; if (c && c.fish === species && c.rarity && !c.junk) return c.rarity; }
      }
    } catch {}
    return null;
  }
  function readBag() {
    const cards = [];
    for (const b of document.querySelectorAll('button[aria-label]')) {
      const m = /^(✨\s)?(.+?)\s×(\d+)(?:\s+ล็อก\s+(\d+))?$/.exec(b.getAttribute('aria-label'));
      if (!m) continue;
      // 🎨 v6.222: สีขอบอาจตั้งผ่าน inline style หรือ class (computed) — ลองทั้งสอง แล้ว parse แบบทนทุกรูปแบบ
      const ring = b.closest('[style*="--tw-ring-color"]') || b.closest('[class*="ring"]');
      let color = (ring?.style.getPropertyValue('--tw-ring-color') || '').trim();
      if (!color && ring) { try { color = getComputedStyle(ring).getPropertyValue('--tw-ring-color').trim(); } catch {} }
      const count = +m[3];
      const lockedCount = m[4] ? +m[4] : 0;
      const species = m[2].trim();
      // อ่านจากสีก่อน · อ่านไม่ออก → ใช้ระดับที่เคยจับได้ (แทน null=ไม่ขายทั้งที่เป็นปลาธรรมดา)
      let rarity = rarityFromColor(color);
      if (rarity == null) rarity = recordedRarity(species);
      cards.push({
        el: b,
        species,
        shiny: !!m[1],
        count,
        lockedCount,                     // ผู้เล่นล็อกไว้กี่ตัวในกลุ่มนี้ (เกมกันไม่ให้ขาย)
        sellable: count - lockedCount,   // ขายได้จริงกี่ตัว
        rarity,                          // null = อ่านไม่ออก + ไม่เคยจับ (ยังถือว่าล็อกไว้ก่อน — ปลอดภัยกับปลาแพง)
      });
    }
    return cards;
  }

  function readBagCount() {
    for (const el of document.querySelectorAll('span')) {
      const m = /🎒\s*(\d+)\s*\/\s*(\d+)/.exec(el.textContent);
      if (m) return { count: +m[1], slots: +m[2] };
    }
    return null;
  }

  function readTotalCoins() {
    const b = sellAllBtn();
    if (!b) return 0;
    const m = /([\d,]+)\s*🪙/.exec(b.textContent);
    return m ? parseInt(m[1].replace(/,/g, ''), 10) : 0;
  }

  // ---- ข้อความแจ้งผลการขายในหน้ากระเป๋า (แถบเขียว = สำเร็จ, แดง = ล้มเหลว) ----
  // เกม render ด้วยคลาสชุดนี้เป๊ะๆ:
  //   "mt-2 rounded-2xl px-3 py-2 text-center text-sm font-bold text-white bg-[#6fb54a]|bg-red-600/90"
  // เดิมจับแค่ (สีเขียว + rounded-2xl) ซึ่ง element อื่นก็ใช้คลาสคู่นี้ได้ จึงระบุให้ครบชุด
  // แล้วยืนยันอีกชั้นด้วยสีพื้นหลัง + ต้องอยู่ในโมดัลกระเป๋าที่มีปุ่ม "ปิดเมนู" เท่านั้น
  // อ่านผล toast ใช้ readSellToast() (นิยามไว้ใกล้ๆ ปุ่มขาย) · ที่นี่เก็บแค่ selector ที่ใช้ร่วมกัน
  const TOAST_SEL = 'div[class*="mt-2"][class*="rounded-2xl"][class*="text-center"][class*="font-bold"][class*="text-white"]';

  // ---- กล่องเตือนของเกม (tk-chip-dark ที่ bottom-24) ----
  // เกมพิมพ์บอกทุกอย่างในกล่องนี้: กระเป๋าเต็ม / ไม่มีเหยื่อ / พลังหมด / ปลาหลุด
  // อ่านกล่องนี้กล่องเดียวก็รู้ว่าทำไมกดตกปลาไม่ติด — ไม่ต้องเดาจากการที่เกมเงียบ
  // เกมพร้อมเล่นไหม (ไม่ใช่หน้า login + มี UI สนามตก) — ใช้ selector เบา ไม่มี innerText/'*' walk
  function detectGameReady() {
    if (/\/login|signin|\/auth|register/i.test(W.location.pathname)) return false;
    return !!(qBtn('ตกปลา (F)') || qBtn('ตวัดเบ็ด!') || btnByText('ตกต่อ!') || btnByText('เก็บเบ็ด') || findBar());
  }
  let notReadySince = 0;

  function warnText() {
    for (const d of document.querySelectorAll('div[class*="bottom-24"]')) {
      const t = d.textContent.trim();
      if (t) return t;
    }
    return null;
  }

  // 🛡️ v6.218: ยามเฝ้า "ป๊อบอัพค้าง" ทั่วไป — กันทุกฟีเจอร์ (ปัจจุบัน+อนาคต) ทิ้ง dialog ค้างจนบอทตกปลาต่อไม่ได้
  //   ที่มา: เปิดหีบ/รับรางวัล/error ของเกมหลายอันเป็น dialog ที่ "ไม่ปิดเอง" + ต้องกดปุ่ม (ESC เดี่ยวๆ ไม่พอทุกอัน)
  //   วิธีคิด: แทนที่จะไล่แก้ทีละป๊อบอัพ ให้มี "จุดเดียว" คอยเคลียร์ตอน "ควรตกได้แต่ตกไม่ได้เพราะมี dialog ค้าง"
  //   ⚠️ ไม่แตะหน้าต่าง "รับรางวัล" (รับของ/เปิดจดหมาย) — ปล่อย auto-claim จัดการ กันเผลอปิดทิ้งรางวัล (กฎเดียวกับ gameEscape)
  const CLAIM_RE = /รับของ|เปิดจดหมาย|รับรางวัล|^รับ$/;
  function closeLikeBtns() {
    try {
      return [...document.querySelectorAll('button')].filter((b) => {
        if (isBotUI(b) || !b.offsetParent) return false;
        const t = (b.textContent || '').trim(), a = b.getAttribute('aria-label') || '';
        if (CLAIM_RE.test(t) || CLAIM_RE.test(a)) return false;                 // ปุ่มรับรางวัล — ห้ามแตะ
        return t === 'ปิด' || t === 'ตกลง' || t === 'รับทราบ' || /^(✕|×|✖|✗|❌)$/.test(t) || /^ปิด/.test(a);
      });
    } catch { return []; }
  }
  const hasBlockingDialog = () => closeLikeBtns().length > 0;
  // เคลียร์ป๊อบอัพที่ปิดได้ (กดปุ่มปิดก่อน เพราะบาง dialog ของเกมไม่ตอบ ESC) แล้วตบท้ายด้วย ESC
  function clearBlockingUI() {
    let did = false;
    for (const b of closeLikeBtns()) { fireClick(b); did = true; }
    gameEscape();   // ชั้นสุดท้าย (gameEscape มี guard ไม่ปิดหน้าต่างที่มีรางวัลรอรับอยู่แล้ว)
    return did;
  }
  let uiBlockedSince = 0, lastPopupClear = 0, popupClearCount = 0;
  // เรียกจากสาขา idle เท่านั้น (ไม่ busy/orchestrating) — คืน true ถ้าเพิ่งเคลียร์ (ผู้เรียกควร return รอเฟรมหน้า)
  function popupWatchdog() {
    // เหตุที่เกมบอกไว้แล้ว (กระเป๋าเต็ม/ไม่มีเหยื่อ/พลังหมด) = ระบบอื่นจัดการอยู่ ไม่ใช่ป๊อบอัพค้าง
    const w = warnText();
    if (w && /กระเป๋าเต็ม|ไม่มีเหยื่อ|เหยื่อหมด|พลังหมด/.test(w)) { uiBlockedSince = 0; return false; }
    // ตกปลาได้อยู่ (มีปุ่มตกปลา/เกจ/ตกต่อ/เก็บเบ็ด) = ไม่มีอะไรบัง — ปกติ
    if (detectGameReady()) { uiBlockedSince = 0; return false; }
    // ตกไม่ได้ แต่ก็ไม่มี dialog ที่ปิดได้ (อาจกำลังโหลด/เปลี่ยนแมพ) = ไม่ใช่หน้าที่เรา
    if (!hasBlockingDialog()) { uiBlockedSince = 0; return false; }
    // มี dialog ค้าง + ตกไม่ได้ → จับเวลา ให้ต่อเนื่อง ≥3 วิ ค่อยเคลียร์ (กัน false positive ช่วง transition)
    if (!uiBlockedSince) { uiBlockedSince = now(); return false; }
    if (now() - uiBlockedSince < 3000 || now() - lastPopupClear < 3000) return false;
    lastPopupClear = now(); uiBlockedSince = 0; popupClearCount++;
    clearBlockingUI();
    logInfo(`🛡️ เจอป๊อบอัพค้าง (ตกปลาต่อไม่ได้ ≥3 วิ) → เคลียร์อัตโนมัติ · รวมเคลียร์ ${popupClearCount} ครั้ง`);
    return true;
  }

  // ---- อ่าน popup ปลาที่เพิ่งตกได้ (ก่อนกด "ตกต่อ!") ---- (ใช้ rarityFromColor v6.222 · เดิมมี RGB2RARITY แบบตรงเป๊ะ ถอดแล้ว)

  function readCatch() {
    const cont = btnByText('ตกต่อ!');
    if (!cont) return null;
    let card = cont.parentElement;
    while (card && !card.textContent.includes('คะแนนรวม')) card = card.parentElement;
    if (!card) return null;

    let rarity = null, shiny = false;
    for (const el of card.querySelectorAll('div[style*="background-color"]')) {
      const key = rarityFromColor(el.style.backgroundColor);   // 🎨 v6.222: parse ทนทุกรูปแบบ (เดิม RGB2RARITY ตรงเป๊ะอย่างเดียว)
      if (key) { rarity = key; shiny = /SHINY/i.test(el.textContent); break; }
    }
    const text = card.innerText || card.textContent || '';
    const nameEl = card.querySelector('div[class*="text-2xl"][class*="font-black"]');
    const junk = /ได้ขยะ/.test(text);

    return {
      name: junk ? 'ขยะ' : (nameEl?.textContent.trim() || '?'),
      rarity, shiny, junk,
      weight: parseFloat(/น้ำหนัก\s*([\d.]+)/.exec(text)?.[1] ?? '0'),
      price: parseInt((/ขายได้\s*([\d,]+)/.exec(text)?.[1] ?? '0').replace(/,/g, ''), 10),
      score: parseInt(/คะแนนรวม\s*(\d+)/.exec(text)?.[1] ?? '0', 10),
      isNew: /NEW!\s*ปลาตัวใหม่/.test(text),
      isRecord: /สถิติใหม่/.test(text),
    };
  }

  // ---- ตัดสินว่าปลาตัวนี้ควรแจ้งเตือนไหม (คืนเหตุผล หรือ null) ----
  function catchWorthNotifying(c) {
    if (!c || c.junk) return null;
    const why = [];
    if (c.rarity && cfg.tgRarities.includes(c.rarity)) why.push(RARITY_LABEL[c.rarity]);
    if (c.shiny && cfg.tgShiny) why.push('✨ SHINY');
    if (c.isNew && cfg.tgNew) why.push('📖 ปลาตัวใหม่');
    if (c.isRecord && cfg.tgRecord) why.push('🏆 สถิติใหม่');
    return why.length ? why : null;
  }

  // ---- แถบพลัง ⚡ (chip ที่มี title ขึ้นต้นว่า "พลังตกปลา") ----
  // UI ใหม่: chip โชว์ "87.5%" ตอนปกติ แต่ตอนพลังกำลังฟื้นจะโชว์ "พัก ~N นาที" (ไม่มี %)
  // เดิมเจอคำว่า "พัก" แล้วคืน 0 → บอทเห็นพลัง 0% ค้าง เลยไม่กลับมาตก
  // จึงอ่านจาก "ความกว้างแถบพลัง" (style width:X%) เป็นหลัก เพราะสะท้อนค่าจริงทุกสถานะ
  function energyPct() {
    for (const d of document.querySelectorAll('[title]')) {
      if (!d.getAttribute('title').startsWith('พลังตกปลา')) continue;
      // 1) อ่านจากความกว้างของแถบ (แม่นสุด ใช้ได้ทั้งตอนปกติและตอน "พัก ~N นาที")
      for (const s of d.querySelectorAll('span[style*="width"]')) {
        const w = /width:\s*([\d.]+)%/.exec(s.getAttribute('style') || '');
        if (w) return parseFloat(w[1]);
      }
      // 2) สำรอง: อ่านตัวเลข % จากข้อความ (ข้าม "พัก ~N นาที" ที่ N เป็นนาที ไม่ใช่ %)
      const t = d.textContent;
      if (/พัก/.test(t)) return null;   // อยู่ในสถานะฟื้นแต่อ่านแถบไม่ได้ → ไม่รู้ค่า (อย่าเดาว่า 0)
      const m = /(\d+(?:\.\d+)?)\s*%/.exec(t);
      if (m) return parseFloat(m[1]);
      return null;
    }
    return null;
  }

  // ================= อ่านอุปกรณ์ที่ใช้อยู่บนหน้าจอเกม =================

  // ดึงเลขขั้นเหยื่อจากสตริง (asset/class/attr) — ทนหลายรูปแบบที่เกมอาจเปลี่ยนชื่อไฟล์
  // รองรับ: bait-tier-07 · bait_tier_7 · baitTier7 · bait-07 · bait/7
  function tierFromStr(s) {
    if (!s) return null;
    const m = /bait[-_\s/]*tier[-_\s/]*0*(\d+)/i.exec(s) || /bait[-_/]0*([1-8])(?:\D|$)/i.exec(s);
    return m ? +m[1] : null;
  }
  // หาปุ่มเลือกเหยื่อ (aria-label หลัก · สำรอง: ปุ่มที่ aria-label/text มีคำว่า "เหยื่อ")
  function baitButton() {
    return qBtn('เลือกเหยื่อ')
      || [...document.querySelectorAll('button')].find((b) => /เหยื่อ/.test(b.getAttribute('aria-label') || ''))
      || null;
  }
  // จับคู่ชื่อเหยื่อในข้อความ → ขั้น (เลือกชื่อ "ยาวสุด" ก่อน เพราะ "มัดไส้เดือนอ้วน"⊃"ไส้เดือน")
  function tierFromName(txt) {
    if (!txt) return null;
    let best = null;
    for (let i = 0; i < BAIT_TIERS.length; i++) {
      const nm = BAIT_TIERS[i].name;
      if (nm && txt.includes(nm) && (!best || nm.length > best.len)) best = { tier: i + 1, len: nm.length };
    }
    return best ? best.tier : null;
  }
  let lastBaitWarn = 0;
  // ปุ่ม "เลือกเหยื่อ" — อ่านขั้นที่ใส่อยู่ + จำนวนคงเหลือ (หลายทางกันเกมอัปเดตแล้วพัง)
  function currentBait() {
    const b = baitButton();
    if (!b) return null;
    let tier = null;
    // 1) ไอคอน: background-image(style) / <img src> / class / data-tier — ลองทุกทาง
    for (const el of b.querySelectorAll('[style],img,[class*="bait"],[data-tier]')) {
      const g = (a) => (el.getAttribute ? el.getAttribute(a) : null);
      tier = tierFromStr(g('style')) || tierFromStr(g('src')) || tierFromStr(g('class'))
          || (/^[1-8]$/.test(g('data-tier') || '') ? +g('data-tier') : null);
      if (tier) break;
    }
    // 2) สำรอง: ชื่อเหยื่อในปุ่ม (เกมโชว์ชื่อ เช่น "สปินเนอร์ขนนก"=ขั้น7) — ทนต่อการเปลี่ยนชื่อไฟล์
    if (!tier) tier = tierFromName(b.textContent || '');
    // จำนวนคงเหลือ = เลขล้วนตัวท้ายในปุ่ม (badge มุมล่างขวา)
    const nums = [...b.querySelectorAll('span')].map((s) => s.textContent.trim()).filter((s) => /^\d{1,4}$/.test(s));
    const stock = nums.length ? +nums[nums.length - 1] : 0;
    if (tier) lastKnownBaitTier = tier;   // จำไว้เป็น fallback ที่แม่น (currentBait อาจอ่านไม่ได้บางเฟรม)
    const hasIcon = !!b.querySelector('[style*="bait"],img[src*="bait"],[class*="bait"]');
    if (tier == null && !hasIcon && stock === 0) return { tier: null, stock: 0 };   // เหยื่อหมดเกลี้ยง (ไอคอนเปล่า)
    // อ่านขั้นไม่ได้ทั้งไอคอน+ชื่อ แต่มีเหยื่ออยู่ → DOM เปลี่ยน: เตือน+เก็บ HTML ไว้ในรายงานปัญหา (throttle 5 นาที)
    if (tier == null && Date.now() - lastBaitWarn > 300000) {
      lastBaitWarn = Date.now();
      logWarn('อ่านขั้นเหยื่อไม่ได้ (DOM อาจเปลี่ยน) — จะใช้ cfg.baitTier แทน · ปุ่ม=' + String(b.outerHTML || '').replace(/\s+/g, ' ').slice(0, 320));
    }
    return { tier, stock };
  }

  // ปุ่ม "เลือกเบ็ด" มีป้าย "Lv.N" บอกขั้นที่ใช้อยู่
  function currentRod() {
    const b = qBtn('เลือกเบ็ด');
    if (!b) return null;
    const m = /Lv\.\s*(\d+)/.exec(b.textContent);
    return m ? +m[1] : null;
  }

  // กดปุ่มสลับวนจนกว่าจะได้ค่าที่ต้องการ (เกมสลับได้ทีละขั้น ไม่มีเมนูให้เลือกตรงๆ)
  // 🔤 v6.165: คีย์ลัดเกม (ตารางในเกม) เป็น "ทางสำรอง" เมื่อปุ่มใน DOM ไม่มี/กดไม่ได้
  //   V = สลับเหยื่อ (ตอนใกล้น้ำ) · G = สลับเบ็ด — ไม่ต้องพึ่งเมนูกาง/ปุ่มโผล่ = กันพังตอนแผงเมนูถูกย่อ (บั๊ก v6.104)
  const CYCLE_HOTKEY = { 'เลือกเหยื่อ': ['KeyV', 86], 'เลือกเบ็ด': ['KeyG', 71] };
  async function cycleTo(label, want, read, maxTries = 9) {
    const b = document.querySelector(`button[aria-label="${label}"]`);
    const hk = CYCLE_HOTKEY[label];
    if (!b || b.disabled) {
      if (!hk) return false;
      for (let i = 0; i < maxTries; i++) {
        if (read() === want) return true;
        bossFireKey('keydown', hk[0], hk[1]); bossFireKey('keyup', hk[0], hk[1]);
        await sleep(170);
      }
      if (read() === want) { logInfo(`🔤 สลับ "${label}" ด้วยคีย์ลัด (ปุ่มใน DOM ใช้ไม่ได้)`); return true; }
      return false;
    }
    for (let i = 0; i < maxTries; i++) {
      if (read() === want) return true;
      fireClick(b);
      await sleep(140);
    }
    return read() === want;
  }

  // ================= ร้านค้า: ซื้อเหยื่อ + อ่านอุปกรณ์ =================

  const shopTab = async (label) => { const t = btnByText(label); if (t) { fireClick(t); await sleep(300); } };

  // 🆕 v6.104: เกมใหม่มีปุ่ม "ย่อแผงเมนูเก็บข้างจอ" — ย่อแล้วปุ่ม กระเป๋า/ร้านค้า/เควส/จดหมาย **หายจาก DOM ทั้งหมด**
  //   (เหลือแค่ "กางแผงเมนู") → ทุกงานที่ต้องเปิดเมนูต้องกางก่อน ไม่งั้น qBtn คืน null = ขาย/ซื้อ/เควส/จดหมาย พังเงียบ
  async function ensureMenuOpen() {
    const exp = qBtn('กางแผงเมนู');
    if (!exp) return true;                       // กางอยู่แล้ว (ปกติ)
    fireClick(exp);
    const ok = !!await waitFor(() => !!qBtn('กระเป๋า'), 2500, 150);
    if (!ok) logWarn('กางแผงเมนูไม่สำเร็จ — เมนูอาจถูกย่อไว้ (ขาย/ซื้อ/เควส/จดหมาย จะทำไม่ได้)');
    return ok;
  }

  // 🔤 v6.167: เปิดกระเป๋า/ร้าน "ด้วยคีย์ลัดเกม" เป็นทางสำรอง (B=กระเป๋า · P=ร้านค้า จากตารางคีย์ลัดในเกม)
  //   แก้อาการที่โผล่ซ้ำใน log จริง: "หาปุ่มกระเป๋าไม่เจอ" / "เปิดร้านไม่สำเร็จ" — เกิดเมื่อแผงเมนูถูกย่อ
  //   แล้วปุ่มหายจาก DOM ทั้งหมด (บั๊ก v6.104) · คีย์ลัดไม่พึ่ง DOM เลยจึงกันพังได้ถาวร
  //   ปลอดภัยหลัง v6.164: บอทย้ายปุ่มตัวเองไป Alt+B/Alt+P แล้ว → ยิง B/P เปล่าไม่ไปสลับสถานะบอทเอง
  const gameHotkey = (code, kc) => { bossFireKey('keydown', code, kc); bossFireKey('keyup', code, kc); };
  async function openBagUI() {
    await ensureMenuOpen();
    const b = qBtn('กระเป๋า');
    if (b) { fireClick(b); return true; }
    gameHotkey('KeyB', 66);
    const ok = !!await waitFor(() => !!readBagCount(), 2000, 150);
    if (ok) logInfo('🔤 เปิดกระเป๋าด้วยคีย์ลัด B (ปุ่มในแผงเมนูไม่มี)');
    return ok;
  }

  // 🎣 v6.174: สลับ "ชิ้นเบ็ด" (instance) — รองรับเบ็ดชนิดเดียวกันหลายชิ้นที่อัปเกรดต่างกัน (เช่นติดหินดาเมจบอส)
  //   เกมเก็บชิ้นที่ใส่อยู่ใน localStorage `tokpla_rod_instance` (UUID) แยกจาก `tokpla_rod_selected` (ขั้น/ชนิด)
  //   วิธีสลับ: กดคีย์ลัด G (สลับเบ็ด — จากตารางคีย์ลัดในเกม) วนไปเรื่อยๆ แล้วอ่าน UUID จนตรงเป้า
  //   → ไม่ต้องพึ่งโครง DOM ของหน้าจออุปกรณ์เลย (เปิด UI ตอนบอทกำลังเหวี่ยงไม่ได้อยู่แล้ว)
  const currentRodId = () => { try { return W.localStorage.getItem('tokpla_rod_instance') || ''; } catch { return ''; } };
  // 🛡️ v6.185 (ผู้ใช้เจอสด): เดิมถ้าวนหาไม่เจอ จะ **ทิ้งเบ็ดไว้ที่ชิ้นสุ่มๆ ที่วนไปเจอ** = แย่กว่าไม่สลับเลย
  //   เคสจริง 19:27: เบ็ดบอสที่บันทึกไว้หายจากคลัง (รหัสชิ้นเปลี่ยนตอนตีหิน/อัปเกรด) → วน 15 ครั้งไม่เจอ
  //   → ตีบอสด้วยเบ็ดผิดชิ้นทั้งไฟต์ จนผู้ใช้ต้องเข้าไปเลือกเองกลางถ้ำ
  //   ใหม่: จำชิ้นเดิมไว้ก่อนวน · หาไม่เจอ = **วนกลับไปชิ้นเดิมให้ครบ** แล้วเตือน TG ให้ตั้งใหม่
  // ⛔ v6.188 — วัดสดแล้วพบว่า **G สลับ "tier ของเบ็ด" ไม่ใช่ "ชิ้นเบ็ด"** → สมมติฐานของ v6.174 ผิดตั้งแต่ต้น
  //   ลำดับจริง (instance/tier): bb7590f6/8 → 353bc421/8 → 7ecb6347/1 → 353bc421/8 → 7ecb6347/1 → …
  //   tokpla_rod_selected สลับ 8→1→8→1 = วน "tier ที่มี" · แต่ละ tier เกมเลือก "ชิ้นประจำ" ให้เอง
  //   (tier8→353bc421, tier1→7ecb6347) → เบ็ด tier 8 ชิ้นอื่น (bb7590f6 = ชิ้นที่ติดหินดาเมจบอสจริง)
  //   **G ไม่มีวันเลือกได้เลย** และพอออกจากชิ้นนั้นแล้วกลับเข้าไม่ได้อีกด้วย
  //
  //   ⚠️ อันตรายที่ถอนออก: v6.187 ตีความ "วนครบวงแล้วไม่เจอ" = "ไม่มีในคลัง" แล้ว **ล้าง cfg ทิ้งเอง**
  //   ซึ่งผิด — วง G ไม่ใช่คลังทั้งหมด · ถ้าปล่อยไว้จะลบเบ็ดบอสที่ถูกต้องของผู้ใช้ทิ้ง
  //   → ห้ามลบ config จากหลักฐานวง G เด็ดขาด (การเดาผิดต้องไม่ทำลายค่าที่ผู้ใช้ตั้งเอง)
  //
  //   คงไว้แค่ประโยชน์ที่จริง: หยุดเร็วเมื่อวงซ้ำ (ไม่กดเก้อ 15 ครั้ง) + คืนชิ้นเดิมเสมอ (บทเรียน v6.185)
  //   การเลือก "ชิ้น" เจาะจงต้องทำผ่านหน้าอุปกรณ์ในเกมเท่านั้น — ยังไม่ได้ทำ (ดู CHANGELOG v6.188)
  // จำ "ชิ้นที่ G เข้าไม่ถึง" ไว้ (ไม่ใช่ลบค่าที่ผู้ใช้ตั้ง!) — กันบอทลองซ้ำทุกไฟต์แล้วเขี่ยผู้ใช้หลุดจากเบ็ดที่ใส่ไว้เอง
  //   ล้างเครื่องหมายนี้เมื่อผู้ใช้กด "จำ" ใหม่ (ดู mkRodBtn) = ผู้ใช้ยืนยันเจตนาอีกครั้ง
  const RODX_KEY = 'tokpla_rod_unreachable';
  const rodUnreachable = () => { try { return new Set(JSON.parse(W.localStorage.getItem(RODX_KEY) || '[]')); } catch { return new Set(); } };
  const rodMarkUnreachable = (id) => { try { const s = rodUnreachable(); s.add(id); W.localStorage.setItem(RODX_KEY, JSON.stringify([...s])); } catch {} };
  const rodClearUnreachable = (id) => { try { const s = rodUnreachable(); s.delete(id); W.localStorage.setItem(RODX_KEY, JSON.stringify([...s])); } catch {} };

  async function switchRodTo(id, _cfgKey = '') {
    if (!id) return false;
    const before = currentRodId();
    if (before === id) return true;
    // เคยพิสูจน์แล้วว่า G เข้าไม่ถึงชิ้นนี้ → อย่าลองอีก (ลองแล้วคืนชิ้นเดิมไม่ได้ = ทำให้แย่ลง)
    if (rodUnreachable().has(id)) {
      logWarn(`🎣 ข้ามการสลับเบ็ด — ชิ้น ${id.slice(0, 8)} เคยพิสูจน์แล้วว่าปุ่ม G เข้าไม่ถึง (G วนได้แค่ tier) · เลือกชิ้นนี้เองจากหน้าอุปกรณ์ แล้วกด "จำ" ใหม่ถ้าต้องการให้ลองอีก`);
      return false;
    }
    const MAX = 16;
    const seen = new Set(before ? [before] : []);
    let repeat = 0;
    for (let i = 0; i < MAX; i++) {
      gameHotkey('KeyG', 71);
      await sleep(320);
      const r = currentRodId();
      if (r === id) { logInfo(`🎣 สลับเบ็ดสำเร็จ (กด G ${i + 1} ครั้ง)`); return true; }
      if (r && seen.has(r)) { if (++repeat >= 3) break; }   // เห็นซ้ำ 3 ครั้ง = วงนิ่งแล้ว เป้าไม่อยู่ในวง
      if (r) { seen.add(r); }
    }
    // คืนชิ้นเดิมถ้าทำได้ — แต่ถ้าชิ้นเดิมอยู่นอกวง G ก็คืนไม่ได้ (ต้องบอกผู้ใช้ตรงๆ)
    let restored = currentRodId() === before;
    if (!restored && before) {
      for (let i = 0; i < MAX && !restored; i++) {
        gameHotkey('KeyG', 71);
        await sleep(320);
        restored = currentRodId() === before;
      }
    }
    rodMarkUnreachable(id);   // ครั้งหน้าไม่ลองแล้ว — แต่ค่าที่ผู้ใช้ตั้งไว้ยังอยู่ครบ
    const rods = [...seen].map((x) => x.slice(0, 8)).join(', ') || '(อ่านไม่ได้)';
    const msg = `🎣 สลับไปเบ็ด ${id.slice(0, 8)} ไม่ได้ — ปุ่ม G ของเกมวนได้แค่ "tier" (เข้าถึงชิ้น: ${rods}) `
      + `ไม่ใช่ทุกชิ้นในคลัง · ${restored ? 'คืนชิ้นเดิมแล้ว' : '⚠️ คืนชิ้นเดิมไม่ได้ — ชิ้นเดิมอยู่นอกวง G ต้องเลือกเองจากหน้าอุปกรณ์'}`;
    logWarn(msg);
    if (isOn('tgOn') && isOn('tgWarn')) void tgSend(`⚠️ <b>สลับเบ็ด</b>\n${esc(msg)}`);
    return false;
  }

  // ---------- 🎣 v6.190: สลับ "ชิ้นเบ็ด" ผ่านกระเป๋า — ทางเดียวที่ทำได้จริง ----------
  //   G สลับได้แค่ tier (พิสูจน์แล้ว v6.188) · ชิ้นเจาะจงต้อง: เปิดกระเป๋า → แท็บ 🎣เบ็ด → แตะการ์ด → "ใช้เบ็ดนี้"
  //   เลือกจาก "หินที่ติด" ไม่ใช่ UUID → ทน UUID ที่เปลี่ยนทุกครั้งที่อัปเกรด/ตีหิน (ต้นเหตุ v6.185)
  //
  //   ☠️ กติกาเหล็ก: ปุ่ม "ขายคืน +100,000 🪙" อยู่ในแผงเดียวกัน ใต้ปุ่มใช้พอดี
  //      1) กดได้เฉพาะปุ่มที่ข้อความ === 'ใช้เบ็ดนี้' เป๊ะๆ   2) ต้องเจอปุ่มเดียวเท่านั้น
  //      3) ปุ่มมีคำว่า "ขาย" เมื่อไร = ยกเลิกทั้งงานทันที   4) ห้ามกดปุ่มอื่นในแผงนี้เด็ดขาด
  const ROD_USE_TXT = 'ใช้เบ็ดนี้';

  // การ์ดเบ็ด — สโคปใต้หัวข้อ "🎣 เบ็ดที่มี" เท่านั้น (กลุ่ม 🛟 ทุ่น หน้าตาเหมือนกันเป๊ะ ชื่อซ้ำด้วย!)
  function rodGroupCards() {
    const head = [...document.querySelectorAll('span,div')].find((e) =>
      !isBotUI(e) && e.offsetParent && (e.textContent || '').trim() === '🎣 เบ็ดที่มี');
    if (!head) return [];
    let box = head;
    for (let i = 0; i < 6 && box; i++) {
      const c = [...box.querySelectorAll('button.tk-inner')].filter((b) => b.offsetParent && !isBotUI(b));
      if (c.length) return c.map((el) => ({
        el, name: el.getAttribute('title') || '',
        equipped: /ใช้อยู่/.test(el.getAttribute('aria-label') || ''),
        orb: ((el.getAttribute('style') || '').match(/#[0-9a-f]{6}/i) || [''])[0],
      }));
      box = box.parentElement;
    }
    return [];
  }

  // อ่านแผงรายละเอียด (ขวา) หลังแตะการ์ด — ค่าที่ใช้ตัดสินว่าเบ็ดชิ้นนี้เก่งด้านไหน
  // 🔍 v6.205: อ่าน "หินโชค/คริ" ด้วย — เดิมอ่านแค่ 2 ค่า เลยมองไม่เห็นว่าเบ็ดอีกชิ้นมี 🍀 โชคปลาแรร์ +8%
  //   (ตรวจสดจากแผงจริง: เบ็ดมังกรตำนาน 2 ชิ้น โบนัสปลา +35% เท่ากัน ต่างกันแค่หิน — 🍀 โชค +8% vs ⚔️ ดาเมจบอส +6%)
  //   รู้ค่าจริงแล้ว = เลือกด้วย "ข้อมูล" ไม่ต้องพึ่งการเดาจาก tie-break อย่างเดียว
  function rodDetail() {
    // 🐟 v6.214 (ผู้ใช้ได้เบ็ดดรอปบอส "เจ้าดุกนรก"): เบ็ดบางคันมี "ดาเมจบอสในตัว" จากคำโปรย ("ตีบอสแรงขึ้น 15%")
    //   แยกจาก "หินดาเมจบอส +12%" ที่ติดเพิ่ม → ดาเมจบอสรวม = ในตัว + หิน (ดุกนรก = 15+12 = 27%)
    //   เดิมอ่านแค่หิน (12) → ยังเลือกดุกนรกถูก (12>6) แต่ค่าที่โชว์ไม่ครบ · อ่านครบ = แม่นยำ+log ชัด+เผื่อเบ็ดบอสในอนาคต
    const d = { boss: null, fish: null, luck: null, crit: null };
    let bossStone = null, bossBase = null;
    for (const e of document.querySelectorAll('div,span,p')) {
      if (isBotUI(e) || !e.offsetParent || e.children.length) continue;
      const t = (e.textContent || '').replace(/\s+/g, ' ').trim();
      if (t.length > 70) continue;
      let m = /ดาเมจบอส\s*\+?(\d+(?:\.\d+)?)\s*%/.exec(t); if (m) bossStone = parseFloat(m[1]);
      m = /ตีบอส[^0-9%]{0,15}?(\d+(?:\.\d+)?)\s*%/.exec(t); if (m) bossBase = parseFloat(m[1]);   // ดาเมจบอสในตัวเบ็ด (คำโปรย)
      m = /โบนัสปลา\s*\+?(\d+(?:\.\d+)?)\s*%/.exec(t); if (m) d.fish = parseFloat(m[1]);
      m = /โชคปลาแรร์\s*\+?(\d+(?:\.\d+)?)\s*%/.exec(t); if (m) d.luck = parseFloat(m[1]);
      m = /คริติคอล\s*\+?(\d+(?:\.\d+)?)\s*%/.exec(t); if (m) d.crit = parseFloat(m[1]);
    }
    if (bossStone != null || bossBase != null) d.boss = (bossStone || 0) + (bossBase || 0);
    return d;
  }

  async function bagOpenRodTab() {
    if (!rodGroupCards().length) { await openBagUI(); await sleep(500); }
    const tab = [...document.querySelectorAll('button')].find((b) =>
      !isBotUI(b) && b.offsetParent && /🎣เบ็ด/.test(b.textContent || ''));
    if (tab) { tab.click(); await sleep(450); }
    return !!rodGroupCards().length;
  }

  // เลือกเบ็ดที่เก่งด้าน kind ที่สุด · kind: 'boss' (ดาเมจบอส) | 'farm' (โบนัสปลา)
  async function equipRodBy(kind) {
    const field = kind === 'boss' ? 'boss' : 'fish';
    const label = kind === 'boss' ? 'ดาเมจบอส' : 'โบนัสปลา';
    if (!await bagOpenRodTab()) { logWarn('🎣 เปิดแท็บเบ็ดในกระเป๋าไม่ได้ — ข้ามการสลับเบ็ด'); return false; }
    const n = rodGroupCards().length;
    const scored = [];
    for (let i = 0; i < n; i++) {
      const c = rodGroupCards()[i];      // DOM รีเรนเดอร์ทุกครั้งที่แตะ → ต้องหยิบใหม่ทุกรอบ
      if (!c) continue;
      c.el.click(); await sleep(420);
      const d = rodDetail();
      scored.push({ i, name: c.name, orb: c.orb, equipped: c.equipped, boss: d.boss, fish: d.fish, luck: d.luck, crit: d.crit, val: d[field] });
    }
    // ⚖️ v6.204 (ผู้ใช้เจอ "ล่าบอสเสร็จแล้วไม่เปลี่ยนเบ็ดกลับ"):
    //   v6.190 ตัดสินด้วยค่าเดียว + "เสมอ = คงของเดิม" → เบ็ดมังกร 2 ชิ้นโบนัสปลา 35% เท่ากัน
    //   ชิ้นที่ใส่อยู่ (เบ็ดบอส) เลยชนะแบบเสมอทุกครั้ง = ฟาร์มด้วยเบ็ดบอสตลอด
    //   ความจริง: **หินดาเมจบอสไม่ช่วยตกปลาเลย** ส่วนหินของอีกชิ้นเราอ่านค่าไม่ได้ (โชค/คริ ไม่โผล่ใน 2 ค่านี้)
    //   → ตัวตัดสินรอง: ฟาร์ม = โบนัสปลาก่อน · **เสมอให้เลือกชิ้นที่ "ไม่มีดาเมจบอส"** (เก็บเบ็ดบอสไว้ใช้ตอนตีบอส)
    //     ตีบอส = ดาเมจบอสก่อน · เสมอค่อยดูโบนัสปลา
    //   v6.205: ฟาร์มดูของจริงเพิ่ม — โบนัสปลา → 🍀 โชคปลาแรร์ → 🎯 คริติคอล → สุดท้ายค่อยเลี่ยงหินบอส
    const rank = (s) => kind === 'boss'
      ? [s.boss ?? -1, s.fish ?? -1]
      : [s.fish ?? -1, s.luck ?? 0, s.crit ?? 0, -(s.boss ?? 0)];
    const cmp = (a, b) => { const ra = rank(a), rb = rank(b); for (let k = 0; k < ra.length; k++) if (rb[k] !== ra[k]) return rb[k] - ra[k]; return 0; };
    const ordered = scored.slice().sort(cmp);
    const best = ordered.find((s) => (s.val ?? 0) > 0);
    const stats = (s) => [`ปลา${s.fish ?? '–'}`, s.luck != null ? `โชค${s.luck}` : null, s.crit != null ? `คริ${s.crit}` : null, s.boss != null ? `บอส${s.boss}` : null].filter(Boolean).join('/');
    const brief = scored.map((s) => `${s.name}${s.orb ? `(${s.orb})` : ''}=${stats(s)}`).join(' · ');
    if (!best) { logWarn(`🎣 ไม่มีเบ็ดชิ้นไหนมี ${label} เลย — ใช้ชิ้นเดิม · ที่สแกนได้: ${brief}`); await closeBagUI(); return false; }
    const cur = scored.find((s) => s.equipped);
    if (cur && cmp(cur, best) <= 0) {   // ชิ้นที่ใส่อยู่ดีที่สุดตามลำดับนี้แล้ว → ไม่ต้องแตะแผง (มีปุ่มขายอยู่)
      logInfo(`🎣 คงเบ็ดเดิม — ${cur.name} เหมาะกับ${kind === "boss" ? "การตีบอส" : "การฟาร์ม"}ที่สุดแล้ว (${stats(cur)}) · ที่สแกน: ${brief}`);
      await closeBagUI(); return true;
    }

    const before = currentRodId();
    const card = rodGroupCards()[best.i];
    if (!card) { await closeBagUI(); return false; }
    card.el.click(); await sleep(450);
    // ☠️ จุดอันตราย — ตรวจ 3 ชั้นก่อนกด
    const btns = [...document.querySelectorAll('button')].filter((b) =>
      b.offsetParent && !isBotUI(b) && (b.textContent || '').trim() === ROD_USE_TXT);
    if (btns.length !== 1) { logWarn(`🎣 ยกเลิกการสลับเบ็ด — หาปุ่ม "${ROD_USE_TXT}" ได้ ${btns.length} ปุ่ม (ต้องเจอ 1 เท่านั้น)`); await closeBagUI(); return false; }
    if (/ขาย/.test(btns[0].textContent || '')) { logWarn('🎣 ยกเลิก — ปุ่มที่จะกดมีคำว่า "ขาย"'); await closeBagUI(); return false; }
    btns[0].click(); await sleep(700);

    const after = currentRodId();
    await closeBagUI();
    if (after && after !== before) {
      logInfo(`🎣 สลับเบ็ดสำหรับ${kind === 'boss' ? 'ตีบอส' : 'ฟาร์ม'}แล้ว: ${best.name}${best.orb ? `(${best.orb})` : ''} ${stats(best)} (${before.slice(0, 8)}→${after.slice(0, 8)}) · ที่สแกน: ${brief}`);
      return true;
    }
    logWarn(`🎣 กด "${ROD_USE_TXT}" แล้วแต่เบ็ดไม่เปลี่ยน (${(before || '').slice(0, 8)}) — ใช้ชิ้นเดิมต่อ`);
    return false;
  }

  async function closeBagUI() { try { gameEscape(); } catch {} await sleep(250); }

  async function openShop() {
    await ensureMenuOpen();
    const s = qBtn('ร้านค้านักตกปลา');
    if (!s) { gameHotkey('KeyP', 80); const ok = !!await waitFor(() => !!qBtn('ปิดร้าน'), 2500, 150); if (ok) logInfo('🔤 เปิดร้านด้วยคีย์ลัด P (ปุ่มในแผงเมนูไม่มี)'); return ok; }
    fireClick(s);
    // v6.105: ยืนยันด้วย aria "ปิดร้าน" (มีเฉพาะตอนร้านเปิดจริง · ชนกับ UI บอทไม่ได้)
    //   เดิมรอ btnByText('🪱 เหยื่อ') = ข้อความ ซึ่งไปแมตช์หัวข้อแผงบอท → คืน true ทั้งที่ร้านยังไม่เปิด
    return !!await waitFor(() => qBtn('ปิดร้าน'), 4000);
  }

  async function closeShop() {
    const x = qBtn('ปิดร้าน');
    if (x) fireClick(x);
    await sleep(300);
  }

  // แถวสินค้าในร้าน = div.tk-inner — ดึง "ขั้น N", จำนวนที่มี, และปุ่มในแถว
  // 🆙 v6.104: เลเวลผู้เล่น — เกมใหม่โชว์ "นักตกปลา Lv.N" ที่ "หัวร้านค้า" (เห็นเฉพาะตอนเปิดร้าน)
  //   ซึ่งพอดีกับที่ต้องใช้: shopRows/detectBaitCeil ทำงานตอนร้านเปิดอยู่แล้ว · cache ไว้เผื่ออ่านไม่ได้
  let lastKnownLevel = null;
  function playerLevel() {
    try {
      const tw = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      let n;
      while ((n = tw.nextNode())) {
        if (n.parentElement && n.parentElement.closest('[data-tkbot]')) continue;   // v6.181: กฎเหล็ก #7 — กันอ่านเลเวลจากข้อความในแผงบอทเอง
        const m = /นักตกปลา\s*Lv\.?\s*(\d+)/.exec(n.textContent || '');
        if (m) return (lastKnownLevel = +m[1]);
      }
    } catch {}
    return lastKnownLevel;
  }

  function shopRows() {
    const plv = playerLevel();   // อ่านครั้งเดียวต่อการสแกน (ร้านเปิดอยู่ = อ่านได้)
    return [...document.querySelectorAll('div[class*="tk-inner"]')].map((row) => {
      const text = row.innerText || row.textContent || '';
      const tier = /ขั้น\s*(\d+)/.exec(text);
      const stock = /มี\s*(\d+)/.exec(text);
      const addBtn = [...row.querySelectorAll('button')].find((b) => b.textContent.trim() === 'ใส่ตะกร้า') || null;
      // 🔓 v6.104 บั๊กจากเกมอัปเดต: ป้ายล็อกเปลี่ยน "🔒 Lv.N" → "ปลด Lv.N" ที่ขึ้น **ทุกแถว** (แม้ขั้นที่ปลดแล้ว
      //   เช่น ขั้น 1 = "ปลด Lv.1") → regex เก่าไม่เจอเลย = คิดว่าปลดครบ 8 ขั้น → detectBaitCeil ผิด → ทดสอบ/ซื้อขั้นที่ล็อก
      //   แก้: ตัดสินด้วย "เลเวลที่ต้องปลด > เลเวลผู้เล่น" · เก็บ 🔒 เดิมไว้เผื่อเกมย้อนกลับ · อ่านเลเวลไม่ได้ค่อยเดาจากปุ่ม disabled
      const lockOld = /🔒\s*Lv\.\s*(\d+)/.exec(text);
      const needM = lockOld || /ปลด\s*Lv\.?\s*(\d+)/.exec(text);
      const needLv = needM ? +needM[1] : null;
      let lockedLv = null;
      if (lockOld) lockedLv = +lockOld[1];                                   // รูปแบบเก่า: มี 🔒 = ล็อกแน่
      else if (needLv != null && plv != null) lockedLv = needLv > plv ? needLv : null;   // ใหม่: เทียบเลเวล
      else if (needLv != null && addBtn && addBtn.disabled) lockedLv = needLv;           // สำรอง: อ่านเลเวลไม่ได้
      return {
        row, text,
        tier: tier ? +tier[1] : null,
        stock: stock ? +stock[1] : null,
        lockedLv,
        full: /สต๊อกเต็ม|เต็มเพดาน/.test(text),
        owned: /มีแล้ว ✓/.test(text),
        equipped: /ใส่อยู่ ✓/.test(text),
        addBtn,
      };
    });
  }

  // ลำดับก่อนซื้อเหยื่อรอบใหม่: ขายปลาให้หมดก่อน → แล้วค่อยซื้อ
  // orchestrating ค้างไว้ตลอดลำดับ กัน tick แทรกกลาง (เผลอเหวี่ยง/ขายซ้ำ) ระหว่างช่วงต่อ
  async function sellThenBuy(forced) {
    if (busy || orchestrating) return;
    orchestrating = true;
    try {
      if (isOn('sellBeforeBuy')) {
        say('💰 ขายปลาที่เหลือก่อนซื้อเหยื่อ...');
        await runSell(true);           // ขายตามกฎล็อก (ปลาที่ล็อกไว้ไม่ขาย) — รับรู้รายได้ให้ครบ
        await sleep(400);              // เผื่อ observer นับรายได้ครั้งสุดท้าย
      }
      await runBuyBait(forced);        // ซื้อเหยื่อรอบใหม่
    } finally {
      orchestrating = false;
      lastCast = now();
    }
  }

  // 🛑 v6.182: เบรกเกอร์กัน "ซื้อรัว" — ครอบทุกการซื้อเหยื่อไม่ว่าระบบไหนสั่ง (เทสต์/Advisor/ปกติ)
  //   เคสจริง: ซื้อ 9 แพ็คใน ~60 วินาที ≈ 256,000 🪙 · ไม่มีสถานการณ์ปกติใดที่ต้องซื้อถี่ขนาดนี้
  //   เก็บเวลาซื้อ (epoch — รอดข้ามรีโหลด) แล้วบล็อกถ้าเกินโควตาในหน้าต่างเวลา
  const BUY_WINDOW_MS = 10 * 60000, BUY_MAX_IN_WINDOW = 3;
  const buyLog = () => { try { return JSON.parse(W.localStorage.getItem('tokpla_buy_log') || '[]'); } catch { return []; } };
  const buyLogPush = () => { try { const a = buyLog().filter((t) => Date.now() - t < BUY_WINDOW_MS); a.push(Date.now()); W.localStorage.setItem('tokpla_buy_log', JSON.stringify(a.slice(-20))); } catch {} };
  const buyBlocked = () => buyLog().filter((t) => Date.now() - t < BUY_WINDOW_MS).length >= BUY_MAX_IN_WINDOW;

  async function runBuyBait(force) {
    if (busy) return;
    if (buyBlocked()) {
      const msg = `⛔ กันซื้อรัว: ซื้อเหยื่อครบ ${BUY_MAX_IN_WINDOW} แพ็คใน 10 นาทีแล้ว — พักการซื้อ (กันบั๊กดูดเงิน)`;
      if (now() - (runBuyBait._sayAt || 0) > 60000) { runBuyBait._sayAt = now(); say(msg); if (isOn('tgOn') && isOn('tgWarn')) void tgSend(`⛔ <b>เบรกเกอร์กันซื้อรัวทำงาน</b>\nซื้อเหยื่อครบ ${BUY_MAX_IN_WINDOW} แพ็คใน 10 นาที — หยุดซื้อชั่วคราว\nถ้าไม่ได้ตั้งใจ ให้ตรวจว่าบอทสลับเหยื่อไม่ได้ (ต้องยืนใกล้น้ำ)`); }
      return;
    }
    busy = true;
    try {
      if (!await openShop()) { say('เปิดร้านไม่สำเร็จ'); return; }
      await shopTab('🪱 เหยื่อ');

      const want = BAIT_TIERS.find((b) => b.tier === targetBait());
      say(`ซื้อ ${want.name}...`);
      const rows = shopRows().filter((r) => r.tier && r.stock !== null);
      { const eq = rows.find((r) => r.equipped && r.tier); if (eq) lastKnownBaitTier = eq.tier; }   // ซิงก์ขั้นที่ใส่จริงจาก "ใส่อยู่ ✓" (แม่น — ใช้เป็น fallback สถิติ)
      const row = rows.find((r) => r.tier === targetBait());
      if (!row) {
        // v6.105: ถอยเมื่อพลาดติดกัน — กันวนเปิด-ปิดร้านไม่จบ (ดู baitBuyFailUntil)
        baitRowMiss++;
        // 🔍 v6.105: เก็บหลักฐานให้ครบ — reproduce บั๊กนี้กับบัญชีทดสอบไม่ออก ต้องรู้ว่า "ตอนพลาดเห็นอะไรจริงๆ"
        //   (ร้านเปิดจริงไหม / มีแถวกี่แถว / แถวหน้าตาแบบไหน) → ผู้ใช้ส่ง /report มาแล้ววิเคราะห์ได้ทันที
        const allRows = shopRows();
        logWarn(`ซื้อเหยื่อพลาด: หาขั้น ${targetBait()} ไม่เจอ · ร้านเปิด=${!!qBtn('ปิดร้าน')} · tk-inner=${allRows.length} · ผ่านกรอง=${rows.length}`
          + ` · ขั้นที่เห็น=[${allRows.map((r) => r.tier).join(',')}] · แถวแรก="${(allRows[0]?.text || '').replace(/\s+/g, ' ').slice(0, 70)}"`);
        say(`หาเหยื่อขั้น ${targetBait()} ในร้านไม่เจอ (ครั้งที่ ${baitRowMiss}/3 · เห็น ${rows.length}/${allRows.length} แถว)`);
        if (baitRowMiss >= 3) {
          baitBuyFailUntil = now() + 300000;   // พัก 5 นาที
          baitRowMiss = 0;
          logWarn(`ซื้อเหยื่อขั้น ${targetBait()} ไม่ได้ 3 ครั้งติด (แท็บร้านไม่สลับ/รูปแบบร้านเปลี่ยน?) — พักระบบซื้อ 5 นาที`);
          say('⚠️ ซื้อเหยื่อไม่ได้ 3 ครั้งติด — พักระบบซื้อ 5 นาที (ดู /report)');
          if (isOn('tgOn') && isOn('tgWarn')) void tgSend(`⚠️ <b>ซื้อเหยื่อไม่สำเร็จ</b> — หาแถวเหยื่อขั้น ${targetBait()} ในร้านไม่เจอ 3 ครั้งติด · พักระบบซื้อ 5 นาที\nอาจเป็นเพราะเกมเปลี่ยนหน้าร้าน — ส่ง /report มาให้ตรวจ`);
        }
        await closeShop(); return;
      }
      baitRowMiss = 0;   // เจอแถวแล้ว = ปกติ

      if (row.lockedLv) {
        // ขั้นนี้ยังไม่ปลดล็อก -> เรียนรู้เพดานจริงจากแถวในร้าน แล้วลดลงมาใช้ขั้นสูงสุดที่ใช้ได้
        const usable = rows.filter((r) => !r.lockedLv).map((r) => r.tier);
        baitCeil = usable.length ? Math.max(...usable) : 1;
        if (cfg.baitTier > baitCeil && !testRunning) { cfg.baitTier = baitCeil; saveCfg(); syncPanel(); }   // ทดสอบไม่แก้ขั้นเอง
        say(`เหยื่อขั้น ${targetBait()} ยังไม่ปลดล็อก (Lv.${row.lockedLv}) — จำกัดที่ขั้น ${baitCeil} (${BAIT_TIERS[baitCeil - 1].name})`);
        await closeShop(); return;
      }
      if (row.full) { say(`สต๊อก ${want.name} เต็มแล้ว (${row.stock})`); await closeShop(); return; }
      // 🛑 v6.182 (บั๊กเงินหาย ~256,000 · ผู้ใช้รายงาน): เดิมเช็คสต๊อกเฉพาะตอน `!force`
      //   → ระบบทดสอบเรียก sellThenBuy(true) = force → **ข้ามการเช็คสต๊อกทั้งหมด** → มีเหยื่อ 906 ชิ้นก็ยังซื้อซ้ำ
      //   → วนซื้อ 4 แพ็ค/ขั้น (เหยื่อขั้น 8 = 45,000 × 4 = 180,000 ใน 30 วินาที)
      //   กฎใหม่ (เด็ดขาด): **"มีของครบ 1 แพ็คแล้ว ห้ามซื้อ ไม่ว่ากรณีใด"** — force แปลว่า "ข้ามคูลดาวน์/เกณฑ์"
      //   ไม่ใช่ "ข้ามการตรวจว่ามีของอยู่แล้ว" · เป็นเพดานที่ระบบอื่นสั่งข้ามไม่ได้เลย
      if (row.stock >= PACK_SIZE) {
        say(`⛔ ไม่ซื้อ — มี ${want.name} อยู่แล้ว ${row.stock} ชิ้น (≥1 แพ็ค)`);
        await closeShop(); return;
      }
      if (!force && row.stock > cfg.buyBelow) {
        say(`ยังไม่ต้องซื้อ — มี ${want.name} อยู่ ${row.stock} ชิ้น`);
        await closeShop(); return;
      }
      if (!row.addBtn) { say('หาปุ่มใส่ตะกร้าไม่เจอ'); await closeShop(); return; }

      // ใส่ตะกร้า 1 แพ็ค แล้วกด + เพิ่มจนครบจำนวนที่ตั้งไว้ (ไม่ให้เกินเพดาน 1000)
      const maxPacks = Math.max(1, Math.floor((BAIT_CAP - row.stock) / PACK_SIZE));
      const packs = Math.min(cfg.buyPacks, maxPacks);
      fireClick(row.addBtn);
      await sleep(250);

      const plus = document.querySelector(`button[aria-label="เพิ่มจำนวน ${want.name}"]`);
      for (let i = 1; i < packs && plus; i++) { fireClick(plus); await sleep(120); }

      const buy = btnByText('ซื้อเลย!') || btnByText('เหรียญไม่พอ');
      if (!buy || buy.disabled || buy.textContent.includes('เหรียญไม่พอ')) {
        const cost = (want.unit * PACK_SIZE * packs).toLocaleString();
        // 🌈 v6.132: โหมดล่าปลาเทพ (เหยื่อ auto) ซื้อขั้นที่กำลังสำรวจไม่ไหว → "ข้ามขั้นนี้" (พัก 1 ชม.) แล้วไปสำรวจขั้นถัดไป
        //   — ไม่ปิด autoBuy ทั้งระบบ (เดิมทำให้ขั้นถูกที่ยังซื้อไหวพลอยซื้อไม่ได้ + วนสลับเหยื่อที่ไม่มีของ = stall)
        if (mythicActive() && !(parseInt(cfg.mythicBait, 10) > 0)) {
          const st = mbLoad();
          if (st.cur === want.tier) {
            const s = (st.tiers[want.tier] ||= { c: 0, mn: 0, mv: 0 });
            s.skipUntil = now() + 60 * 60000;
            st.left = 0; mbSave();
            say(`🌈 เงินไม่พอสำรวจเหยื่อขั้น ${want.tier} (${cost} 🪙) — ข้ามขั้นนี้ไว้ก่อน ไปขั้นถัดไป (ลองใหม่ใน ~1 ชม.)`);
            await closeShop(); return;
          }
        }
        disableForSession('autoBuy', `เหรียญไม่พอซื้อ ${want.name} ${packs} แพ็ค (${cost} 🪙) — พักระบบซื้อไว้ก่อน`);
        await closeShop(); return;
      }
      fireClick(buy);

      const done = await waitFor(() => {
        const t = document.body.innerText;
        if (t.includes('✅ ซื้อสำเร็จ!')) return 'ok';
        if (t.includes('❌')) return 'fail';
        return null;
      }, 8000);
      if (done === 'ok') buyLogPush();   // 🛑 v6.182: นับเข้าเบรกเกอร์กันซื้อรัว (เฉพาะที่ซื้อสำเร็จจริง)
      say(done === 'ok'
        ? `✅ ซื้อ ${want.name} ${packs} แพ็ค (${packs * PACK_SIZE} ชิ้น · ${(want.unit * PACK_SIZE * packs).toLocaleString()} 🪙)`
        : `ซื้อไม่สำเร็จ (${want.name})`);
      // 🛑 v6.182: การซื้อ = เสียเงินจริง → แจ้ง TG "เสมอ" ไม่ขึ้นกับ tgTrade (เดิมปิดอยู่ ผู้ใช้เลยไม่รู้ตอนบอทดูดเงิน 256,000)
      //   แนบยอดสะสมในหน้าต่าง 10 นาที = เห็นทันทีถ้าเริ่มผิดปกติ
      if (done === 'ok' && isOn('tgOn')) {
        const n = buyLog().filter((t) => Date.now() - t < BUY_WINDOW_MS).length;
        void tgSend(`🪱 ซื้อ ${esc(want.name)} ${packs} แพ็ค (${packs * PACK_SIZE} ชิ้น · <b>${(want.unit * PACK_SIZE * packs).toLocaleString()} 🪙</b>)${n > 1 ? `\n⚠️ ซื้อไปแล้ว ${n} ครั้งใน 10 นาที` : ''}`);
      }
      await sleep(500);
      await closeShop();
    } catch (e) {
      logErr('ซื้อเหยื่อไม่สำเร็จ', e);
      say('เกิดข้อผิดพลาดตอนซื้อ — ดู Console');
      await closeShop();
    } finally {
      busy = false;
      pendingCast = 0;
      lastCast = now();
    }
  }

  // ===== 🎒 กดใช้ไอเทมจากกระเป๋า (เกมล่าสุด: ซื้อ consumable แล้ว "เก็บไว้กดใช้" ไม่ออกฤทธิ์ทันที) =====
  // flow (ยืนยันจาก DOM สด): กระเป๋า → แท็บ "🎒 ของใช้" → คลิกปุ่มไอเทม (aria "ยาปลาตัวใหญ่ ×N") → กด "ใช้เลย"
  // ⚠️ ผู้เรียกถือ busy อยู่แล้ว (buyCoffee/buyPotions/buyTestPotion) — ฟังก์ชันนี้ไม่แตะ busy เอง
  async function useConsumable(nameRe) {
    try {
      await ensureMenuOpen();   // v6.104: เมนูถูกย่อ = ปุ่มกระเป๋าหายจาก DOM
      if (!(await openBagUI())) return false;
      await sleep(700);
      const tab = btnByText('🎒 ของใช้');
      if (!tab) { await closeMenu(); return false; }
      fireClick(tab); await sleep(450);
      const item = [...document.querySelectorAll('button')].find((b) =>
        nameRe.test(b.getAttribute('aria-label') || '') || nameRe.test(b.textContent || ''));
      if (!item) { await closeMenu(); return false; }   // ไม่มีของ (ซื้อไม่ติด?)
      fireClick(item); await sleep(450);
      const use = [...document.querySelectorAll('button')].find((b) => /ใช้เลย/.test(b.textContent) && !b.disabled);
      if (!use) { await closeMenu(); return false; }
      fireClick(use); await sleep(600);
      await closeMenu();
      return true;
    } catch (e) { logErr('กดใช้ไอเทมล้มเหลว', e); await closeMenu(); return false; }
  }

  // ===== ☕ ซื้อกาแฟเติมพลัง (เกมล่าสุด: อยู่แท็บ "🧪 ยา" · ซื้อแล้วต้องกดใช้จากกระเป๋า · จำกัด 3/วัน) =====
  const COFFEE_PRICE = 1500;
  // ☕🧪 v6.179 (audit — คลาสบั๊กเดียวกับ v6.176): cooldown "ซื้อไม่สำเร็จ พัก 2 ชม." เดิมอยู่บนฐาน performance.now()
  //   → หายทุกรีโหลด → บอทเปิดร้านลองซื้อซ้ำหลังรีโหลดทุกครั้งทั้งที่ครบลิมิตวัน (เห็นจริงใน log 16:22:28)
  //   persist เป็นเวลาจริง (epoch) แล้วแปลงกลับตอนโหลด — เสียเวลาเปิดร้านฟรี ~10-15 วิ/รีโหลด หายไป
  const loadFailUntil = (key) => { try { const t = +W.localStorage.getItem(key) || 0; return t > Date.now() ? now() + (t - Date.now()) : 0; } catch { return 0; } };
  const saveFailUntil = (key, perfUntil) => { try { W.localStorage.setItem(key, String(Date.now() + Math.max(0, perfUntil - now()))); } catch {} };
  let coffeeFailUntil = loadFailUntil('tokpla_coffee_failuntil');   // cooldown เมื่อซื้อไม่สำเร็จ (ทุกกรณี — กันวนเปิดร้านรัวๆ ตอนพลังต่ำค้าง)
  let coffeeBagFailUntil = 0;   // v6.133: พักลอง "กาแฟจากกระเป๋า" เมื่อใช้แล้วพลังไม่ขึ้น (กันวนสแปม)
  let lastCoffeeTry = 0;
  async function buyCoffee() {
    if (busy) return false;
    if (now() - lastCoffeeTry < 15000) return false;   // v6.133: throttle 15 วิ — กันวนใช้/ซื้อกาแฟรัวๆ ไม่ว่าสาเหตุใด
    lastCoffeeTry = now();
    busy = true;
    let ok = false;
    try {
      // ☕ v6.93: ใช้กาแฟที่มีในกระเป๋าก่อนเสมอ (ฟรี · ไม่เสียเงิน · ไม่กินลิมิตซื้อ 3/วัน)
      //   บั๊กเดิม: มีกาแฟในกระเป๋า (จากจดหมาย/รางวัล) แต่บอทเปิดร้านซื้อใหม่ทิ้ง = เปลืองเงิน+ลิมิต
      //   🐛 v6.133: ต้อง "ยืนยันว่าพลังขึ้นจริง" — ไม่งั้นไอเทมชื่อมี "กาแฟ" ที่ไม่ให้พลัง (หรือใช้ไม่ติด)
      //     ทำให้ tick เรียกซ้ำทุกจังหวะ = วนใช้กาแฟ+สแปม Telegram ไม่จบ (cast ค้าง ไม่ได้ตก)
      if (now() > coffeeBagFailUntil) {
        const e0 = energyPct();
        if (await useConsumable(/กาแฟ/)) {
          await sleep(500);   // รอเกมอัปเดตพลัง
          const e1 = energyPct();
          if (e0 == null || e1 == null || e1 > e0 + 2) {   // พลังขึ้นจริง = กาแฟพลังจริง
            ok = true;
            say('☕ ใช้กาแฟจากกระเป๋า +50 พลัง (ฟรี) — ตกต่อ');
            if (cfg.tgTrade && isOn('tgOn')) void tgSend(`☕ ใช้กาแฟจากกระเป๋า +50 พลัง (ฟรี · ไม่เสียเงิน · ตกไปแล้ว ${casts} ครั้ง)`);
            return true;
          }
          // ใช้แล้วพลังไม่ขึ้น → ไอเทมไม่ใช่กาแฟพลัง/ใช้ไม่ติด → พักลองกระเป๋า 30 นาที แล้วไปซื้อจริง (กันวนสแปม)
          coffeeBagFailUntil = now() + 30 * 60000;
          logWarn(`ใช้ "กาแฟ" จากกระเป๋าแล้วพลังไม่ขึ้น (${e0}%→${e1}%) — อาจเป็นไอเทมชื่อคล้าย/ใช้ไม่ติด · พักลองกระเป๋า 30 นาที ไปซื้อ/เก็บเควสแทน`);
        }
      }
      // 🎒 v6.194: ไม่มีในกระเป๋า + ปิดการซื้อ = จบ (ใช้แค่ของฟรี ไม่เปิดร้านซื้อ) · พัก 10 นาทีกันเปิดกระเป๋าหาซ้ำถี่
      if (!isOn('buyCoffee')) { coffeeFailUntil = Math.max(coffeeFailUntil, now() + 600000); return false; }
      // ไม่มีในกระเป๋า → ซื้อจากร้าน
      if (!await openShop()) { say('เปิดร้านซื้อกาแฟไม่สำเร็จ'); return false; }
      await shopTab('🧪 ยา');   // consumable (ยา/กาแฟ) ย้ายมาแท็บนี้ (เดิม 👕 ชุด)
      await sleep(350);
      const row = [...document.querySelectorAll('div[class*="tk-inner"]')].find((r) => /กาแฟนักตกปลา/.test(r.textContent || ''));
      if (!row) { say('หากาแฟในร้านไม่เจอ'); await closeShop(); return false; }
      const add = [...row.querySelectorAll('button')].find((b) => /ใส่ตะกร้า/.test(b.textContent) && !b.disabled);
      if (!add) { say('ซื้อกาแฟไม่ได้ (พลังเกิน 95 หรือมีในตะกร้าแล้ว)'); await closeShop(); return false; }
      fireClick(add); await sleep(300);
      const buy = btnByText('ซื้อเลย!') || btnByText('เหรียญไม่พอ');
      if (!buy || buy.disabled || /เหรียญไม่พอ/.test(buy.textContent)) {
        say('☕ เหรียญไม่พอซื้อกาแฟ — พักซื้อ 3 นาที');
        await closeShop(); return false;
      }
      fireClick(buy);
      const done = await waitFor(() => {
        const t = document.body.innerText;
        if (t.includes('✅ ซื้อสำเร็จ!')) return 'ok';
        if (t.includes('❌')) return 'fail';
        return null;
      }, 8000);
      if (done === 'ok') {
        profit.life.coffeeCost = (profit.life.coffeeCost || 0) + COFFEE_PRICE;
        saveProfit(); refreshProfit();
        await sleep(300); await closeShop();
        // เกมล่าสุด: ซื้อแล้วของเข้ากระเป๋า ต้อง "กดใช้" ถึงได้พลัง
        ok = await useConsumable(/กาแฟ/);
        if (ok) {
          say(`☕ ซื้อ+ใช้กาแฟ +50 พลัง (−${COFFEE_PRICE.toLocaleString()} 🪙) — ตกต่อ`);
          if (cfg.tgTrade && isOn('tgOn')) void tgSend(`☕ เติมพลัง +50 ด้วยกาแฟ (−${COFFEE_PRICE.toLocaleString()} 🪙 · ตกไปแล้ว ${casts} ครั้ง)`);
        } else say('☕ ซื้อกาแฟแล้วแต่กดใช้ไม่สำเร็จ — ของอยู่ในกระเป๋า (แท็บ 🎒 ของใช้)');
        return ok;
      }
      // ❌ = ซื้อไม่ผ่าน (อาจติดลิมิต 3/วัน) — พักยาว 2 ชม. กันวนพยายามทั้งวัน
      coffeeFailUntil = now() + (done === 'fail' ? 7200000 : 180000);
      saveFailUntil('tokpla_coffee_failuntil', coffeeFailUntil);   // v6.179: จำข้ามรีโหลด
      say('☕ ซื้อกาแฟไม่สำเร็จ' + (done === 'fail' ? ' (อาจครบลิมิต 3 แก้ว/วัน — พัก 2 ชม.)' : ''));
      await sleep(400); await closeShop();
      return false;
    } catch (e) {
      logErr('ซื้อกาแฟล้มเหลว', e); say('ซื้อกาแฟล้มเหลว — ดู Console/รายงานปัญหา');
      await closeShop(); return false;
    } finally {
      if (!ok) coffeeFailUntil = Math.max(coffeeFailUntil, now() + 180000);   // ล้มเหลว = พักอย่างน้อย 3 นาที (ไม่ย่อ cooldown ยาวที่ตั้งไว้แล้ว เช่น ลิมิตรายวัน 2 ชม.)
      busy = false; pendingCast = 0; lastCast = now();
    }
  }

  // ลำดับเติมพลัง (ตามที่ผู้ใช้ต้องการ): 1) เก็บเควส (ฟรี) ก่อนเสมอ → 2) เควสหมด/ไม่พอ ค่อยซื้อกาแฟ (จ่ายเงิน)
  // กลไก: tick แรกที่พลังต่ำ → runQuests (ตั้ง lastQuestCheck) · ถ้าเควสดันพลัง > เกณฑ์กาแฟ = จบ ไม่ซื้อกาแฟ
  //       ถ้ายังต่ำ → tick ถัดๆ (ภายใน 30 วิ throttle ข้ามเควส) ค่อยตกมาซื้อกาแฟ = "เควสก่อน กาแฟทีหลัง" เสมอ
  async function sustainEnergy() {
    if (cfg.autoQuest && now() - lastQuestCheck > 30000) {
      lastQuestCheck = now();
      await runQuests();
      if ((energyPct() ?? 100) > cfg.coffeeAtEnergy) return;   // เควสช่วยแล้ว ไม่ต้องกาแฟ
    }
    if (now() < coffeeFailUntil) return;                       // เพิ่งซื้อไม่ได้ (เงินไม่พอ/ครบลิมิต) — รอ cooldown
    await buyCoffee();
  }

  // ===== 🧪 ซื้อยาบัฟอัตโนมัติ (🐋 หนัก+15% · 🍀 โชค+8%) — ซื้อเมื่อบัฟหมด & รายได้ถึงเกณฑ์คุ้ม =====
  let potionFailUntil = loadFailUntil('tokpla_potion_failuntil'), lastPotionCheck = 0, lastPotionEnergySayAt = 0, lastPotionCphSayAt = 0;   // v6.179: persist ข้ามรีโหลด
  // ขั้นเหยื่อที่ "อนุญาตให้ต่อยา" (จาก cfg.potionBaitTiers) — memoize parse ใหม่เฉพาะตอนสตริงเปลี่ยน
  let _potRaw = null, _potSet = new Set();
  function potionTierSet() {
    if (cfg.potionBaitTiers !== _potRaw) {
      _potRaw = cfg.potionBaitTiers;
      _potSet = new Set(String(cfg.potionBaitTiers || '').split(',').map((x) => parseInt(x, 10)).filter((n) => n >= 1 && n <= 8));
    }
    return _potSet;
  }
  // ขั้น t ใช้ยาได้ไหม · รายการว่าง = อนุญาตทุกขั้น
  const potionTierOk = (t) => { const s = potionTierSet(); return s.size === 0 || s.has(t); };
  // อ่านบัฟที่กินอยู่จาก HUD chip — เกมล่าสุด chip เป็น "✨ บัฟที่ใช้อยู่ 🐋ปลาตัวใหญ่ +15% NN น." (ยืนยันจาก DOM สด)
  // ⚠️ ไม่มีคำว่า "หนัก/โชค" แล้ว → แมตช์แค่อีโมจิ 🐋/🍀 ใน tk-chip (chip แชท/แมพเป็น tk-chip-dark ไม่มีอีโมจิพวกนี้)
  function readBuffs() {
    let weight = false, luck = false;
    for (const c of document.querySelectorAll('[class*="tk-chip"]')) {
      const t = c.textContent || '';
      if (t.includes('🐋')) weight = true;
      if (t.includes('🍀')) luck = true;
    }
    return { weight, luck };
  }
  const buffActive = () => { const b = readBuffs(); return b.weight || b.luck; };
  // รายได้ปลา/ชม.ล่าสุด — ใช้เป็น ROI gate ว่าคุ้มซื้อยาไหม (จาก recs ขั้นที่ "ใส่อยู่จริง")
  const FLUKE_RARITY = new Set(['legendary', 'mythic']);   // ปลาฟลุ๊ค — สุ่มล้วน ไม่ใช่ "รายได้ที่ทำซ้ำได้"
  function recentCph() {
    // รายได้ "จริง"/ชม. จาก 30 รายการดิบล่าสุดของขั้นที่ใส่จริง (fallback = cfg.baitTier)
    // ไม่กรองแมพ/ยา — ยา ROI ต้องดูรายได้ที่ทำได้จริงตอนนี้ (ไม่งั้นเวลาถูกนับต่ำ → cph เฟ้อ → ซื้อยาเกินจำเป็น)
    // ⚠️ v6.102 บั๊กจริงจากข้อมูลผู้ใช้: เดิมนับทุก rarity → mythic ตัวเดียว (37,500🪙) ในหน้าต่าง 30 ตัว
    //   ทำ cph พุ่ง ~18,000 → ~490,000/ชม. → ทะลุทุกเกณฑ์ → ซื้อยาทั้งที่รายได้ปกติต่ำมาก
    //   แก้: ตัดฟลุ๊คออกจาก "รายได้" แต่ยังนับมันใน "เวลา" (list เต็ม = หน้าต่างต่อเนื่อง — เหตุผลเดิม v6.47 ยังอยู่)
    const list = (profit.recs[currentBait()?.tier || lastKnownBaitTier || cfg.baitTier] || []).slice(-30);
    if (list.length < 15) return null;                         // ข้อมูลน้อยไป ยังไม่ตัดสิน
    const rev = list.reduce((a, c) => a + (FLUKE_RARITY.has(c.rarity) ? 0 : (c.price || 0)), 0);
    const mins = activeMins(list);
    return mins > 0 ? rev / (mins / 60) : null;
  }
  async function buyPotions() {
    if (busy) return;
    // 🌈 v6.129: แยกยา "โหมดล่าปลาเทพ" กับ "ยาหลัก" ขาดจากกัน —
    //   อยู่โหมดล่าปลาเทพ = ใช้ยาตามสวิตช์ของโหมดเท่านั้น (mythicWeight/mythicLuck) · ยาหลัก (potionWeight/Luck) ไม่เกี่ยว
    //   ไม่อยู่โหมด = ใช้ยาหลักตามเดิม (ตัวเรียก gate ด้วย isOn('buyPotion') อยู่แล้ว)
    // 🐛 v6.132: ตอน no-loss gate สั่ง "งดยา" ต้องไม่มียาเลย — เดิม myt=false แล้วตกไปสาขา "ยาหลัก" = ยารั่วกลับมาทั้งที่สั่งงด
    if (mythicActive() && mythicPotOff) return;
    const myt = mythicActive();
    // 🎒 v6.194: "อยากได้บัฟ" แยกจาก "จะซื้อ" — เดิมผูกกับ isOn('buyPotion') → ปิดซื้อ = ไม่แตะยาฟรีในกระเป๋าเลย
    //   ตอนนี้ want = บัฟที่เปิดสวิตช์ไว้ (potionWeight/Luck) · การซื้อ (เสียเงิน) ไป gate ทีหลัง (หลังใช้ของฟรี)
    const wWeight = myt ? isOn('mythicWeight') : isOn('potionWeight');
    const wLuck   = myt ? isOn('mythicLuck')   : isOn('potionLuck');
    const buffs = readBuffs();
    let want = [];
    if (wWeight && !buffs.weight) want.push({ re: /ยาปลาตัวใหญ่/, name: '🐋 ยาปลาตัวใหญ่', price: 2000, kind: 'weight' });
    if (wLuck   && !buffs.luck)   want.push({ re: /ยาโชคปลาแรร์/, name: '🍀 ยาโชคปลาแรร์', price: 2500, kind: 'luck' });
    if (!want.length) return;                                  // บัฟที่เปิดไว้ยังอยู่ครบ
    // 🧪 เช็ค "ขั้นเหยื่อที่อนุญาตให้ใช้ยา": ขั้นที่ใส่อยู่ไม่อยู่ในรายการ → ไม่ต่อยา (return)
    //   กรณีพิเศษที่ผู้ใช้ต้องการรองรับเอง: ถ้ามีบัฟค้างจากตอนอยู่ขั้นที่อนุญาต แล้วเหยื่อขั้นนั้นหมด สลับมาขั้นต้องห้าม
    //   → บัฟเดิม "ยังทำงานต่อ" (บอทตกด้วยเหยื่อต้องห้ามได้จนบัฟหมด · โค้ดตรงนี้แค่ "ไม่ซื้อยาใหม่" ไม่ได้หยุดตก)
    //   → พอบัฟหมด อยู่ขั้นต้องห้าม จึงไม่ต่อยาอีก (ตรงตามที่ผู้ใช้ต้องการ)
    // 🌈 โหมดล่าปลาเทพข้าม gate รายได้/ขั้นเหยื่อ — มันจงใจใช้เหยื่อถูก (cph ต่ำเป็นธรรมชาติ) และมี no-loss gate คุมแทน
    //   (เกณฑ์พลังงาน potionMinEnergy ยังบังคับเสมอ — เปิดยาแล้วไม่มีแรงตกคือทิ้งเงินทุกโหมด)
    const curT = currentBait()?.tier || lastKnownBaitTier || cfg.baitTier;
    if (!myt && !potionTierOk(curT)) return;
    // ⚡ v6.101: พลังต่ำกว่าเกณฑ์ = ห้ามเปิดยา (ยาอยู่ 30 นาที — พลังหมดกลางบัฟ = ทิ้งเงินยาเปล่า) · 0 = ปิดเกณฑ์
    const ePot = energyPct();
    if (cfg.potionMinEnergy > 0 && ePot != null && ePot < cfg.potionMinEnergy) {
      if (now() - lastPotionEnergySayAt > 600000) { lastPotionEnergySayAt = now(); say(`🧪 งดใช้ยา — พลัง ${Math.round(ePot)}% < เกณฑ์ ${cfg.potionMinEnergy}% (กันเปิดยาแล้วไม่มีพลังตก)`); }
      return;
    }
    busy = true;
    let ok = false;
    try {
      // 🎒 v6.194: ใช้ยาที่มีในกระเป๋าก่อนเสมอ (ฟรี · จากจดหมาย/รางวัล/ซื้อแล้วกดใช้พลาด) — แม้ปิดการซื้อ
      //   เดิม (v6.121) ใช้กระเป๋าก่อนเหมือนกัน แต่ทั้งฟังก์ชันถูก gate ด้วย isOn('buyPotion') → ปิดซื้อ = ไม่แตะของฟรี
      //   ของฟรี "ไม่ติด gate เงิน" (cph/advisor) — มันฟรีอยู่แล้ว · ติดแค่ gate "คุ้มใช้ไหม" (พลัง/ขั้นเหยื่อ ด้านบน)
      if (isOn('useBagConsumables') || myt || isOn('buyPotion')) {
        const still = [];
        for (const w of want) {
          if (await useConsumable(w.re)) { ok = true; say(`🧪 ใช้ ${w.name} จากกระเป๋า (ฟรี · ไม่เสียเงิน)`); }
          else still.push(w);
        }
        want = still;
      }
      if (!want.length) return;                                 // ครบจากกระเป๋าแล้ว (ฟรี)
      // 🛒 ยังขาดบัฟ + จะซื้อ (เสียเงิน) → ต้องเปิด "ซื้อยา" · ปิด = ใช้แค่ของฟรี แล้วพักเช็ค 10 นาที (กันเปิดกระเป๋าถี่)
      if (!myt && !isOn('buyPotion')) { potionFailUntil = Math.max(potionFailUntil, now() + 600000); return; }
      // ---- gate เฉพาะ "การซื้อ" (ของฟรีข้างบนผ่านมาแล้ว ไม่โดน gate พวกนี้) ----
      const cph = recentCph();
      // 💰 v6.102: potionMinCph = "พื้นแข็ง" ของผู้ใช้ (ไม่นับปลาฟลุ๊ค) · Advisor เข้มขึ้นได้ ผ่อนต่ำกว่าไม่ได้
      if (!myt && cfg.potionMinCph > 0 && (cph == null || cph < cfg.potionMinCph)) {
        if (now() - lastPotionCphSayAt > 600000) {
          lastPotionCphSayAt = now();
          say(`🧪 ไม่ซื้อยาเพิ่ม — รายได้ ${cph == null ? 'ข้อมูลไม่พอ' : Math.round(cph).toLocaleString() + '/ชม.'} < เกณฑ์ ${cfg.potionMinCph.toLocaleString()}/ชม. (ของฟรีในกระเป๋าใช้ไปแล้วถ้ามี)`);
        }
        return;
      }
      // Advisor Auto: อนุมัติราย "ตัวยา" แยกกัน — กรอง want เหลือเฉพาะที่ advisor ว่าคุ้มซื้อ
      if (!myt && advisorPotionVerdict) {
        want = want.filter((w) => advisorPotionVerdict[w.kind]);
        if (!want.length) return;
      }
      // 🧪 v6.102: "ต้องครบทั้งคู่" — re-read buffs เผื่อกระเป๋าเพิ่งเปิดบัฟไปตัวนึง (buffs ตัวบนอ่านก่อนใช้กระเป๋า)
      if (isOn('potionRequireBoth') && isOn('potionWeight') && isOn('potionLuck')) {
        const nb = readBuffs();
        const missing = (nb.weight ? 0 : 1) + (nb.luck ? 0 : 1);
        if (want.length < missing) {
          if (now() - lastPotionCphSayAt > 600000) { lastPotionCphSayAt = now(); say('🧪 ไม่ซื้อยา — "ต้องครบทั้งคู่" เปิดอยู่ แต่ซื้อได้ไม่ครบ 🐋+🍀'); }
          return;
        }
      }
      if (!await openShop()) { say('เปิดร้านซื้อยาไม่สำเร็จ'); return; }
      await shopTab('🧪 ยา'); await sleep(350);   // ยาย้ายมาแท็บของตัวเอง (เดิม 👕 ชุด)
      const addedItems = [];                                   // เก็บ "ตัวที่ใส่ตะกร้าได้จริง" (ไว้รายงานชื่อ/ราคาให้ตรง)
      for (const w of want) {                                  // ใส่ยาที่ต้องการลงตะกร้าก่อน แล้วซื้อรวดเดียว
        const row = [...document.querySelectorAll('div[class*="tk-inner"]')].find((r) => w.re.test(r.textContent || ''));
        const add = row && [...row.querySelectorAll('button')].find((b) => /ใส่ตะกร้า/.test(b.textContent) && !b.disabled);
        if (!add) continue;                                    // ซื้อไม่ได้ (บัฟยังอยู่/หมดสต็อก)
        fireClick(add); await sleep(300); addedItems.push(w);
      }
      if (!addedItems.length) { await closeShop(); return; }
      const spent = addedItems.reduce((a, w) => a + w.price, 0);
      const buy = btnByText('ซื้อเลย!') || btnByText('เหรียญไม่พอ');
      if (!buy || buy.disabled || /เหรียญไม่พอ/.test(buy.textContent)) {
        say('🧪 เหรียญไม่พอซื้อยา — พัก 3 นาที'); await closeShop(); return;
      }
      fireClick(buy);
      const done = await waitFor(() => {
        const t = document.body.innerText;
        if (t.includes('✅ ซื้อสำเร็จ!')) return 'ok';
        if (t.includes('❌')) return 'fail';
        return null;
      }, 8000);
      if (done === 'ok') {
        profit.life.potionCost = (profit.life.potionCost || 0) + spent;
        saveProfit(); refreshProfit();
        await sleep(300); await closeShop();
        // เกมล่าสุด: ยาเข้ากระเป๋า ต้อง "กดใช้" ทีละตัวถึงได้บัฟ
        let used = 0;
        for (const w of addedItems) { if (await useConsumable(w.re)) used++; }
        ok = used > 0;
        const names = addedItems.map((w) => w.name).join(' + ');
        if (ok) {
          say(`🧪 ซื้อ+ใช้ยา ${names} (−${spent.toLocaleString()} 🪙) — บัฟทำงาน`);
          if (cfg.tgTrade && isOn('tgOn')) void tgSend(`🧪 เปิดบัฟ ${names} (−${spent.toLocaleString()} 🪙${cph != null ? ` · รายได้ ${Math.round(cph).toLocaleString()} 🪙/ชม.` : ''})`);
        } else say('🧪 ซื้อยาแล้วแต่กดใช้ไม่สำเร็จ — ของอยู่ในกระเป๋า (แท็บ 🎒 ของใช้)');
        return;
      }
      // ❌ = อาจติดลิมิต 5 ขวด/วัน — พักยาว 2 ชม.
      potionFailUntil = now() + (done === 'fail' ? 7200000 : 180000);
      saveFailUntil('tokpla_potion_failuntil', potionFailUntil);   // v6.179: จำข้ามรีโหลด
      say('🧪 ซื้อยาไม่สำเร็จ' + (done === 'fail' ? ' (อาจครบลิมิต 5 ขวด/วัน — พัก 2 ชม.)' : ''));
      await sleep(400); await closeShop();
    } catch (e) {
      logErr('ซื้อยาล้มเหลว', e); say('ซื้อยาล้มเหลว — ดู Console/รายงานปัญหา');
      await closeShop();
    } finally {
      if (!ok) potionFailUntil = Math.max(potionFailUntil, now() + 180000);   // ล้มเหลว = พักอย่างน้อย 3 นาที (ไม่ย่อ cooldown ลิมิตรายวัน)
      busy = false; pendingCast = 0; lastCast = now();
    }
  }

  // อ่านเหรียญจาก HUD (tk-chip ที่เป็นตัวเลขล้วน = ชิพเหรียญ) — ไว้กันเงินหมดเกลี้ยงตอนซื้อของแพง
  function coinsNow() {
    for (const c of document.querySelectorAll('[class*="tk-chip"]')) {
      if (/tk-chip-dark/.test(c.className)) continue;                 // chip เหรียญเป็น tk-chip ธรรมดา (dark = แมพ/channel)
      const t = (c.textContent || '').trim();
      // ต้องเป็นตัวเลขล้วน + มีไอคอนเหรียญ (span พื้นหลังรูป) — กันไปอ่าน badge ตัวเลขอื่น
      if (/^[\d,]+$/.test(t) && c.querySelector('span[style*="background"]')) return +t.replace(/,/g, '');
    }
    return null;
  }
  // (v6.137 ตัดฟีเจอร์ "🛟 อัพเกรดทุ่นอัตโนมัติ" ออกตามผู้ใช้ — ไม่ซื้อทุ่นอีก · profit.life.floatCost เดิมยังนับในกำไรสุทธิ เพราะเป็นเงินที่จ่ายไปจริง)

  // ===== 🧠 Advisor: สมองเลือกเหยื่อ + จัดสรรยา (โหมดเดียว 2 ระดับ: แนะนำ / ลงมือเอง) =====
  // หลักคิด (จากข้อมูลจริง 1,300+ casts): ขั้นเหยื่อแทบไม่เปลี่ยนคุณภาพปลา · ปลาแพง (legendary/mythic)
  // คือฟลุ๊คที่เกิดเท่ากันทุกขั้น → เทียบขั้นด้วย "กำไร/ครั้งแบบตัดฟลุ๊ค" (trimmed) · prior = ขั้นถูกสุดชนะ
  // บทเรียนระบบเก่า (v6.46-6.63 ที่ถูกลบ): ต้องมี margin + cooldown + ลงเร็วขึ้นช้า ไม่งั้นสลับมั่วตามโชค
  const ADV = {
    MINN: 30,            // ข้อมูลขั้นต่ำ/ขั้น (ในแมพปัจจุบัน) ถึงเชื่อค่า
    UPN: 100,            // จะ "อัพขั้นแพงกว่า" ต้องมีข้อมูลขั้นนั้น ≥ นี้ (ขึ้นช้า)
    MARGIN_DOWN: 5,      // ลงขั้นถูกกว่า: ชนะ ≥ 5 🪙/ครั้ง ก็ลง (ลงเร็ว — เสี่ยงต่ำ)
    MARGIN_UP: 15,       // ขึ้นขั้นแพงกว่า: ต้องชนะ ≥ 15 🪙/ครั้ง (ขึ้นช้า — เสี่ยงสูง)
    COOLDOWN: 30 * 60000, // เว้นระหว่างการสลับอัตโนมัติ ≥ 30 นาที (กัน churn)
    RECENT: 50,          // หน้าต่างสั้นไว้จับ "กำไรช่วงหลังตก"
  };
  let lastAdvisorAt = 0, lastAutoSwitchAt = 0, lastAdviceKey = '', lastAdviceTgAt = 0, lastAdvice = null;
  let advisorPotionVerdict = null;   // null = advisor ไม่คุม (ใช้ gate potionMinCph เดิม) · {weight,luck} = อนุมัติแยกราย (โหมด auto)
  // ขั้นเหยื่อที่ "ห้าม Advisor เลือก" (จาก cfg.advisorNoTiers) — memoize parse ใหม่เฉพาะตอนสตริงเปลี่ยน
  let _advNoRaw = null, _advNoSet = new Set();
  function advisorNoSet() {
    if (cfg.advisorNoTiers !== _advNoRaw) {
      _advNoRaw = cfg.advisorNoTiers;
      _advNoSet = new Set(String(cfg.advisorNoTiers || '').split(',').map((x) => parseInt(x, 10)).filter((n) => n >= 1 && n <= 8));
    }
    return _advNoSet;
  }
  // Advisor เลือกขั้น t ได้ไหม · ถ้าห้ามครบทุกขั้น 1..baitCeil (ตั้งผิด) = ไม่บังคับ (กันบอทค้างไม่มีขั้นให้เลือก)
  function advTierOk(t) {
    const no = advisorNoSet();
    if (!no.size) return true;
    let anyAllowed = false;
    for (let x = 1; x <= (baitCeil || 8); x++) if (!no.has(x)) { anyAllowed = true; break; }
    return !anyAllowed || !no.has(t);
  }

  // ---- 📉 v6.186: "ขั้นนี้ขาดทุนแน่แล้ว" — prior แข็งจากข้อมูลจริงทุกแมพ ----
  //   ทำไมไม่กรองแมพ/ไม่ตัดฟลุ๊คเหมือน advTrimStat: ตรงนี้ไม่ได้ "เทียบขั้นไหนดีกว่า" แต่ถามคำถามหยาบกว่าคือ
  //   "ขั้นนี้เผาเงินทิ้งจริงไหม" → ยิ่งเอาข้อมูลดิบทั้งหมดยิ่งตัดสินแม่น (ตัวอย่างเยอะ) และรวมฟลุ๊คเข้าไปด้วย
  //   = เข้าข้างขั้นแพงแล้ว ถ้ายังขาดทุนอยู่ก็คือขาดทุนจริง
  const LOSS_MIN_N = 150;          // ต่ำกว่านี้ = ยังไม่ฟันธง (เทสต์ 1 รอบ = 100 → ต้องมากกว่า 1 รอบถึงเชื่อ)
  function baitNet(t) {
    const list = profit.recs[t] || [];
    if (list.length < LOSS_MIN_N) return null;
    const rev = list.reduce((a, c) => a + (c.price || 0), 0);
    return { n: list.length, net: rev / list.length - baitUnit(t) };
  }
  // ขาดทุนเกิน 10% ของค่าเหยื่อถึงนับ — กันขั้นที่ก้ำกึ่ง (-1,-2 🪙) ถูกตัดทิ้งเพราะ noise
  function provenLossTier(t) {
    const s = baitNet(t);
    return s && s.net < -Math.max(5, baitUnit(t) * 0.1) ? { t, ...s } : null;
  }
  // ที่ลงจอดเวลาเหยื่อเดิมใช้ไม่ได้ = ให้ Advisor ตัดสิน (อย่าคำนวณเองซ้ำ!)
  //   ⚠️ บทเรียน v6.186: ตอนแรกเขียนเป็น "ขั้นที่ net ดิบสูงสุด" → ได้ขั้น 5 เพราะข้อมูลดิบรวมทุกแมพ
  //   ถูกปลา legendary ตัวเดียวลากขึ้น (บึงบัว n=51 · ดิบ +578 · ตัดฟลุ๊คจริง -38) = เลือกผิดสนิท
  //   Advisor กรองแมพปัจจุบัน + ตัด legendary/mythic + คุมขนาดตัวอย่างอยู่แล้ว → แม่นกว่า
  function bestLandingTier() {
    try {
      const t = advisorDecide()?.bestTier;
      return (t >= 1 && t <= (baitCeil || 8)) ? t : null;
    } catch { return null; }
  }

  // สถิติแบบ "ตัดฟลุ๊ค": กรองแมพปัจจุบัน + ตัด legendary/mythic (ฟลุ๊ค EV เท่ากันทุกขั้น — ตัดแล้วเทียบขั้นแม่น)
  // ขยะ/ปลาปกตินับหมด (กินเหยื่อจริง) · คืน null ถ้าไม่มีข้อมูล
  function advTrimStat(tier, useN) {
    let list = profit.recs[tier] || [];
    if (curMap) list = list.filter((c) => c.map === curMap);
    list = list.filter((c) => c && c.rarity !== 'legendary' && c.rarity !== 'mythic');
    const f = useN > 0 && list.length > useN ? list.slice(-useN) : list;
    if (!f.length) return null;
    const rev = f.reduce((a, c) => a + (c.price || 0), 0);
    return { tier, n: f.length, revCast: rev / f.length, score: rev / f.length - baitUnit(tier) };
  }
  // จำนวนครั้ง/30นาที จากจังหวะตกจริงล่าสุดของขั้น t (ใช้ประเมินมูลค่ายา)
  function advCastsPer30(t) {
    const list = (profit.recs[t] || []).slice(-100);
    if (list.length < 10) return null;
    const mins = activeMins(list);
    return mins > 0 ? list.length / mins * 30 : null;
  }
  // วัด uplift ยา 🐋 จาก "น้ำหนักจริง" (rec.w — เริ่มเก็บ v6.75): เทียบเฉลี่ยมียา vs ไม่มียา (แมพปัจจุบัน ทุกขั้น)
  function advMeasuredWeightUplift() {
    const on = [], off = [];
    for (const t in profit.recs) for (const c of profit.recs[t]) {
      if (typeof c.w !== 'number' || c.junk) continue;
      if (curMap && c.map !== curMap) continue;
      (c.bw ? on : off).push(c.w);
    }
    if (on.length < 40 || off.length < 40) return null;   // ข้อมูลน้อยไป ยังไม่สรุป
    const avg = (a) => a.reduce((x, y) => x + y, 0) / a.length;
    return avg(on) / avg(off) - 1;   // เช่น 0.14 = +14%
  }

  // สมองตัดสินใจ — คืน { bestTier, curT, why, urgent, pot:{weight,luck,note[]}, lines[] }
  function advisorDecide() {
    const curT = currentBait()?.tier || lastKnownBaitTier || cfg.baitTier;
    // ---- เหยื่อ ---- (ข้ามขั้นที่ผู้ใช้ห้าม Advisor เลือก · advisorNoTiers)
    const stats = {};
    for (let t = 1; t <= (baitCeil || 8); t++) {
      if (!advTierOk(t)) continue;
      const s = advTrimStat(t, cfg.statWin || 200);
      if (s && s.n >= ADV.MINN) stats[t] = s;
    }
    const known = Object.values(stats).sort((a, b) => b.score - a.score);
    let bestTier = curT, why = '', urgent = false;
    if (!known.length) {
      let low = 1; while (low < (baitCeil || 8) && !advTierOk(low)) low++;   // prior: ขั้นถูกสุด "ที่อนุญาต"
      bestTier = low;
      why = `ยังไม่มีข้อมูลพอในแมพนี้ — เริ่มขั้น ${low} (ถูกสุดที่อนุญาต เสี่ยงต่ำสุด)`;
    } else {
      const best = known[0], cur = stats[curT];
      if (best.tier === curT) why = `ขั้น ${curT} ดีสุดอยู่แล้ว (${signed(best.score)}/ครั้ง หลังตัดฟลุ๊ค · n=${best.n})`;
      else if (!cur) { bestTier = best.tier; why = `ขั้น ${curT} ยังไม่มีข้อมูลพอในแมพนี้ → ใช้ขั้น ${best.tier} ที่วัดแล้ว (${signed(best.score)}/ครั้ง · n=${best.n})`; }
      else {
        const diff = best.score - cur.score;
        if (best.tier < curT && diff >= ADV.MARGIN_DOWN) { bestTier = best.tier; why = `ลงขั้น ${best.tier} (ถูกกว่า+กำไรดีกว่า ${signed(diff)}/ครั้ง: ${signed(best.score)} vs ${signed(cur.score)})`; }
        else if (best.tier > curT && diff >= ADV.MARGIN_UP && best.n >= ADV.UPN) { bestTier = best.tier; why = `ขึ้นขั้น ${best.tier} (ชนะชัด ${signed(diff)}/ครั้ง · n=${best.n} — ผ่านเกณฑ์ขึ้นช้า)`; }
        else why = `คงขั้น ${curT} (${signed(cur.score)}/ครั้ง · ตัวดีสุดห่าง ${signed(diff)} ไม่พอ margin)`;
      }
      // จับกำไรช่วงหลังตก (หน้าต่างสั้น) — ขาดทุนจริงหรือร่วง >40% จาก baseline = เตือนด่วน
      const recent = advTrimStat(curT, ADV.RECENT), base = stats[curT];
      if (recent && base && recent.n >= 25 && (recent.score < 0 || recent.score < base.score * 0.6)) {
        urgent = true;
        why += ` · ⚠️ ${ADV.RECENT} ครั้งหลังกำไรตก (${signed(recent.score)}/ครั้ง vs ปกติ ${signed(base.score)})`;
      }
    }
    // ---- ยา (จัดสรรตามความคุ้ม + จังหวะ · ลิมิต 5 ขวด/วัน = ทรัพยากรที่ต้องลงชั่วโมงที่ทำเงินดีสุด) ----
    const pot = { weight: false, luck: false, note: [] };
    if (!potionTierOk(bestTier)) pot.note.push(`ขั้น ${bestTier} ไม่อยู่ในรายการอนุญาตใช้ยา (potionBaitTiers)`);
    else {
      const cph = recentCph();
      // 🐋 คุ้มเมื่อรายได้ ≥ ~26,667/ชม. (+15% × 30 นาที ≥ 2,000) — แต่ต้องไม่ต่ำกว่า "พื้นแข็ง" ที่ผู้ใช้ตั้ง (potionMinCph)
      //   v6.102: เดิม advisor ใช้ 26,667 ล้วน → บอก "คุ้ม" แล้ว buyPotions บล็อก (หรือแย่กว่า: ซื้อจริงต่ำกว่าที่ผู้ใช้ตั้ง)
      const wNeed = Math.max(Math.round(2000 / (0.15 * 0.5)), cfg.potionMinCph || 0);
      if (cph != null && cph >= wNeed) { pot.weight = true; pot.note.push(`🐋 คุ้ม — รายได้ ${Math.round(cph).toLocaleString()}/ชม. ≥ เกณฑ์ ${wNeed.toLocaleString()}`); }
      else pot.note.push(`🐋 ยังไม่คุ้ม — รายได้ ${cph != null ? Math.round(cph).toLocaleString() : 'ข้อมูลไม่พอ'} < เกณฑ์ ${wNeed.toLocaleString()}/ชม.`);
      // 🍀: มูลค่า = +8% โอกาสแรร์ × (ราคาแรร์เฉลี่ย − ปลาปกติ) × ครั้ง/30นาที ≥ 2,500
      const inMap = [];
      for (const t in profit.recs) for (const c of profit.recs[t]) if ((!curMap || c.map === curMap) && !c.junk) inMap.push(c);
      const rares = inMap.filter((c) => c.rarity === 'rare' || c.rarity === 'epic');
      const commons = inMap.filter((c) => c.rarity === 'common' || c.rarity === 'uncommon');
      const c30 = advCastsPer30(curT);
      if (rares.length >= 15 && commons.length >= 50 && c30) {
        const avg = (a) => a.reduce((x, y) => x + (y.price || 0), 0) / a.length;
        const gain = 0.08 * c30 * (avg(rares) - avg(commons));
        // v6.102: 🍀 ต้องผ่าน "พื้นแข็ง" potionMinCph ด้วย (เดิมดูแค่ gain → ผ่านทั้งที่รายได้ต่ำกว่าที่ผู้ใช้ตั้ง)
        const cphOk = !(cfg.potionMinCph > 0) || (cph != null && cph >= cfg.potionMinCph);
        if (gain >= 2500 && cphOk) { pot.luck = true; pot.note.push(`🍀 คุ้ม — ประเมิน +${Math.round(gain).toLocaleString()} 🪙/ขวด (แรร์แพงกว่าปกติ ${Math.round(avg(rares) - avg(commons))} × ${c30.toFixed(0)} ครั้ง/30นาที)`); }
        else if (gain >= 2500) pot.note.push(`🍀 คุ้มในทฤษฎี (+${Math.round(gain).toLocaleString()}) แต่รายได้ ${cph != null ? Math.round(cph).toLocaleString() : '?'} < เกณฑ์ที่ตั้ง ${cfg.potionMinCph.toLocaleString()}/ชม.`);
        else pot.note.push(`🍀 ยังไม่คุ้ม — ประเมิน +${Math.round(gain).toLocaleString()} < ค่ายา 2,500`);
      } else pot.note.push('🍀 ข้อมูลแรร์ในแมพนี้ยังไม่พอประเมิน');
      // เงื่อนไขจังหวะ: ยาอยู่ 30 นาที — พลังต้องพอตกต่อเนื่อง (ต่ำ+ไม่มีกาแฟ = เสี่ยงบัฟทิ้งเปล่า)
      const e = energyPct();
      // ⚡ v6.101: เกณฑ์แข็งของผู้ใช้ (potionMinEnergy) — ให้คำตัดสิน advisor ตรงกับ gate จริงใน buyPotions (ไม่บอก "คุ้ม" แล้วโดนบล็อกเงียบ)
      if ((pot.weight || pot.luck) && cfg.potionMinEnergy > 0 && e != null && e < cfg.potionMinEnergy) {
        pot.weight = pot.luck = false;
        pot.note.push(`⚡ พลัง ${Math.round(e)}% < เกณฑ์ห้ามใช้ยา ${cfg.potionMinEnergy}% — งดยาจนพลังฟื้น`);
      } else if ((pot.weight || pot.luck) && e != null && e < 25 && !isOn('buyCoffee')) {
        pot.weight = pot.luck = false;
        pot.note.push(`⚡ พลังเหลือ ${Math.round(e)}% และไม่มีกาแฟ — เลื่อนยาไว้ก่อน (เสี่ยงพักกลางบัฟ)`);
      }
      // uplift วัดจริงจากน้ำหนัก (rec.w) — สายตรวจสอบ ไม่ใช่ตัวตัดสิน (ข้อมูลต้องสะสมก่อน)
      const up = advMeasuredWeightUplift();
      if (up != null) pot.note.push(`📐 วัดจริง: ยา🐋 เพิ่มน้ำหนักเฉลี่ย ${signed(up * 100)}% (ทฤษฎี +15%)`);
    }
    const lines = [
      `🧠 Advisor${curMap ? ` · 🗺️ ${curMap}` : ''}${isOn('advisorAuto') ? ' · โหมดลงมือเอง' : ' · โหมดแนะนำ'}`,
      `🪱 เหยื่อ: ${bestTier === curT ? `คงขั้น ${curT}` : `แนะนำขั้น ${curT} → ${bestTier}`} — ${why}`,
      ...pot.note.map((n) => `🧪 ${n}`),
    ];
    return { bestTier, curT, why, urgent, pot, lines };
  }

  // รอบทำงาน Advisor (เรียกจาก tick ทุก 5 นาที · เว้นตอนทดสอบ) — แนะนำ หรือ ลงมือ ตามโหมด
  function advisorTick(force) {
    // 🌈 โหมดล่าปลาเทพ: advisor พัก — เป้าคนละอย่าง (advisor เพิ่มกำไรเฉลี่ย/ชม. · โหมดล่า tail ปลาเทพ) ปล่อยให้สลับเหยื่อ = ตีกัน
    //   v6.132: ต้องล้าง verdict ด้วย — ไม่งั้นคำตัดสินยาเก่าค้างหลายชั่วโมงถูกใช้ gate ยาหลักหลังออกจากโหมด
    if (testRunning || mythicActive()) { advisorPotionVerdict = null; return; }
    const adv = advisorDecide();
    lastAdvice = adv;
    if (isOn('advisorAuto')) {
      // คำตัดสินยาแยกราย 🐋/🍀 → คุม gate ใน buyPotions (แทนเกณฑ์ potionMinCph คงที่)
      advisorPotionVerdict = { weight: adv.pot.weight, luck: adv.pot.luck };
      // สลับเหยื่อเอง (มี cooldown · ด่วน (ขาดทุน) ข้าม cooldown ได้)
      // 🔬 v6.207: ระหว่างสำรวจห้ามแตะ cfg.baitTier — ไม่งั้น Advisor จะดึงกลับทันทีจนเก็บตัวอย่างไม่ครบ
      if (!exploreTier && adv.bestTier !== cfg.baitTier && !busy && !orchestrating &&
          (adv.urgent || now() - lastAutoSwitchAt > ADV.COOLDOWN)) {
        // v6.121: ขาขึ้น (ขั้นแพงกว่า) ต้องมีเงินซื้อจริงอย่างน้อย 1 แพ็ค — ไม่งั้นวน "สลับขึ้น → ซื้อไม่ไหว → พัก autoBuy → เหยื่อหมด"
        if (adv.bestTier > cfg.baitTier) {
          const coins = coinsNow();
          if (coins !== null && coins < baitUnit(adv.bestTier) * PACK_SIZE) return;
        }
        lastAutoSwitchAt = now();
        const from = cfg.baitTier;
        cfg.baitTier = adv.bestTier; saveCfg(); syncPanel();
        if (adv.bestTier < from) sessionOff.delete('autoBuy');   // ลงขั้นถูก = เงินพอแล้ว — ปลุก autoBuy ที่เคยพักเพราะเงินไม่พอ
        say(`🧠 Advisor เปลี่ยนเหยื่อ ขั้น ${from} → ${adv.bestTier} — ${adv.why}`);
        if (isOn('tgOn')) void tgSend(`🧠 <b>Advisor เปลี่ยนเหยื่อ</b> ขั้น ${from} → ${adv.bestTier}\n${esc(adv.why)}`);
      }
    } else advisorPotionVerdict = null;
    // แจ้งเมื่อ "คำแนะนำเปลี่ยน" เท่านั้น (ไม่สแปมทุก 5 นาที) · โหมดแนะนำส่ง TG ไม่ถี่กว่า 30 นาที
    const key = `${adv.bestTier}|${adv.pot.weight}|${adv.pot.luck}|${adv.urgent}`;
    if (key !== lastAdviceKey || force) {
      lastAdviceKey = key;
      say(adv.lines.slice(1).join(' · ').slice(0, 200));
      if (!isOn('advisorAuto') && isOn('tgOn') && (force || now() - lastAdviceTgAt > 1800000)) {
        lastAdviceTgAt = now();
        void tgSend(esc(adv.lines.join('\n')));
      }
    }
    return adv;
  }

  // ===== ✉️ เก็บจดหมายอัตโนมัติ (ของขวัญจากผู้พัฒนา/รางวัลบอส — ไม่กดรับ = ค้างในกล่องเฉยๆ) =====
  let lastMailCheck = 0;
  function pressEsc() {
    const opts = { key: 'Escape', code: 'Escape', keyCode: 27, which: 27, bubbles: true, cancelable: true };
    W.dispatchEvent(new KeyboardEvent('keydown', opts));
    W.dispatchEvent(new KeyboardEvent('keyup', opts));
  }
  async function claimMail() {
    if (busy) return;
    busy = true;
    let opened = false;   // Esc เฉพาะตอนแผงเปิดจริง (Esc เป็น global — เผลอปิดหน้าต่างที่ผู้ใช้เปิดเองได้)
    try {
      await ensureMenuOpen();   // v6.104: เมนูถูกย่อ = ปุ่มจดหมายหายจาก DOM
      const orb = qBtn('จดหมาย');
      if (!orb) return;
      fireClick(orb);
      opened = await waitFor(() => /จดหมายจากผู้พัฒนา|กำลังโหลดจดหมาย|ยังไม่มีจดหมายเข้า/.test(document.body.innerText), 4000);
      if (!opened) return;
      await sleep(600);   // รอรายการโหลดจบ
      const claimBtns = () => [...document.querySelectorAll('button')].filter((x) => x.textContent.trim() === 'รับของ' && !x.disabled);
      let claimed = 0;
      for (let i = 0; i < 10; i++) {
        const btns = claimBtns();
        if (!btns.length) break;
        const before = btns.length;
        fireClick(btns[0]);
        await waitFor(() => !/กำลังรับ\.\.\./.test(document.body.innerText), 6000);
        await sleep(300);
        if (claimBtns().length < before) claimed++;   // ปุ่มหายจริง = รับสำเร็จ
        else break;                                    // ไม่ลด = เซิร์ฟเวอร์ไม่ให้/ค้าง — เลิก กันวนกดปุ่มเดิมซ้ำ
      }
      if (claimed > 0) {
        say(`✉️ เก็บจดหมาย ${claimed} ฉบับ 🎁`);
        if (cfg.tgWarn && isOn('tgOn')) void tgSend(`✉️ <b>เก็บของขวัญจากจดหมาย</b> ${claimed} ฉบับ 🎁`);
      }
    } catch (e) {
      logErr('เก็บจดหมายล้มเหลว', e);
    } finally {
      if (opened) { pressEsc(); await sleep(300); }
      busy = false; pendingCast = 0; lastCast = now();
    }
  }

  // ---- เช็คอุปกรณ์ทั้งหมด: เบ็ดที่มี / เหยื่อคงเหลือ / ของสวมใส่ ----
  async function gearReport() {
    if (busy) return;
    busy = true;
    try {
      const bait = currentBait();
      const rod = currentRod();
      if (!await openShop()) { say('เปิดร้านไม่สำเร็จ'); return; }

      await shopTab('🎣 เบ็ด');
      const rods = shopRows().filter((r) => r.tier).map((r) => ({
        ขั้น: r.tier,
        ชื่อ: ROD_NAMES[r.tier] || '?',
        สถานะ: r.owned ? '✅ มีแล้ว' : r.lockedLv ? `🔒 ต้อง Lv.${r.lockedLv}` : r.addBtn ? '🛒 ซื้อได้' : '⛔ ต้องมีขั้นก่อนหน้า',
      }));
      rods.unshift({ ขั้น: 1, ชื่อ: ROD_NAMES[1], สถานะ: '✅ มีแล้ว (เริ่มต้น)' });

      await shopTab('🪱 เหยื่อ');
      const baitRows = shopRows();
      { const eq = baitRows.find((r) => r.equipped && r.tier); if (eq) lastKnownBaitTier = eq.tier; }   // ซิงก์ขั้นที่ใส่จริง
      const baits = baitRows.filter((r) => r.tier && r.stock !== null).map((r) => ({
        ขั้น: r.tier,
        ชื่อ: BAIT_TIERS[r.tier - 1]?.name ?? '?',
        คงเหลือ: r.stock,
        'ราคา/แพ็ค': (BAIT_TIERS[r.tier - 1]?.unit ?? 0) * PACK_SIZE,
        สถานะ: r.lockedLv ? `🔒 ต้อง Lv.${r.lockedLv}` : r.full ? 'สต๊อกเต็ม' : '🛒 ซื้อได้',
        ใช้อยู่: r.tier === bait?.tier ? '👈' : '',
      }));

      // เกมล่าสุด: ไม่มีแท็บ "🎒 อื่นๆ" แล้ว (ขยายกระเป๋าย้ายไปอยู่ในกระเป๋าเอง) — โชว์ทุ่นแทน
      await shopTab('🛟 ทุ่น');
      const gear = shopRows().filter((r) => r.tier).map((r) => ({
        ของ: (r.text.split('\n')[0] || '').trim(),
        สถานะ: r.equipped ? '🛟 ใช้อยู่' : r.lockedLv ? `🔒 ต้อง Lv.${r.lockedLv}` : r.addBtn ? '🛒 ซื้อได้' : '📦 มีแล้ว/ต้องมีขั้นก่อนหน้า',
      }));
      const slots = '?';   // ขนาดกระเป๋าอ่านจากร้านไม่ได้แล้ว (ปุ่ม "ขยาย +10" อยู่ในกระเป๋า)

      await closeShop();

      const worn = ['tokpla-hat', 'tokpla-glasses', 'tokpla-accessory', 'tokpla-outfit']
        .map((k) => `${k.replace('tokpla-', '')}: ${W.localStorage.getItem(k) || '—'}`).join(' · ');

      say(`🎣 เบ็ดที่ใช้: ขั้น ${rod ?? '?'} (${ROD_NAMES[rod] ?? '?'}) · 🪱 เหยื่อที่ใช้: ${bait?.tier ? BAIT_TIERS[bait.tier - 1].name : 'ไม่มี'} เหลือ ${bait?.stock ?? 0} · 🎒 ${slots} ช่อง — ตารางเต็มอยู่ใน Console`);
      console.log('%c[Tokpla Bot] เบ็ด', 'font-weight:bold'); console.table(rods);
      console.log('%c[Tokpla Bot] เหยื่อ', 'font-weight:bold'); console.table(baits);
      console.log('%c[Tokpla Bot] ทุ่น', 'font-weight:bold'); console.table(gear);
      console.log('[Tokpla Bot] สวมอยู่ (localStorage):', worn);
    } catch (e) {
      logErr('เช็คอุปกรณ์ล้มเหลว', e);
      say('เช็คอุปกรณ์ไม่สำเร็จ — ดู Console');
      await closeShop();
    } finally {
      busy = false;
      pendingCast = 0;
      lastCast = now();
    }
  }

  // ---- เหยื่อขั้นที่ใช้อยู่หมด: เกมไม่สลับให้เอง (sv คืน null ทันที) ต้องกดปุ่มสลับเอง ----
  // ปุ่ม "เลือกเหยื่อ" ของเกมจะวนหาขั้นแรกที่ยังมีของให้ จึงกดครั้งเดียวพอ
  async function handleNoBait() {
    if (busy) return;
    busy = true;
    try {
      const picker = qBtn('เลือกเหยื่อ');
      if (picker && !picker.disabled) {
        fireClick(picker);
        await sleep(220);
        const c = currentBait();
        if (c && c.tier !== null && c.stock > 0) {
          say(`เหยื่อขั้นเดิมหมด — สลับไป ${BAIT_TIERS[c.tier - 1].name} (เหลือ ${c.stock})`);
          return;
        }
      }
      // ไม่เหลือเหยื่อสักขั้น
      if (isOn('autoBuy')) {
        needBuy = true;      // ธงนี้ข้ามคูลดาวน์ซื้อให้เอง (ดูเงื่อนไขใน tick)
        say('เหยื่อหมดทุกขั้น — กำลังไปซื้อ');
      } else if (cfg.autoBuy && cfg.baitTier > 1 && !isOn('forceBait') && !testRunning) {   // 🛡️ v6.179 (audit): กฎเหล็ก #4 — ระหว่างเทสต์ห้ามแตะ baitTier (เทสต์มีทาง "ข้ามรอบ" ของมันเอง)
        // v6.97: autoBuy ถูก "พักเพราะเงินไม่พอ" (ไม่ใช่ผู้ใช้ปิด) + ยังตั้งเหยื่อขั้นแพงอยู่
        //   → ลงขั้น 1 (ถูกสุด 5🪙/ชิ้น) แล้วปลุกระบบซื้อลองใหม่ แทนการหยุดบอท
        //   กันเคส: ตั้ง baitTier ขั้นแพง (เช่น 7=250🪙) + เงินร่อยหรอ → ซื้อไม่ไหว → เหยื่อหมด → บอทตายทั้งที่ขั้น 1 ยังซื้อไหว+ทำกำไร
        cfg.baitTier = 1; saveCfg(); syncPanel();
        sessionOff.delete('autoBuy'); needBuy = true;
        lastAutoSwitchAt = now();   // v6.121: นับ cooldown ของ Advisor ด้วย — กันมันสลับกลับขั้นแพงทันทีทั้งที่เงินเพิ่งหมด
        say('เหยื่อหมด + เงินไม่พอซื้อขั้นเดิม — ลงขั้น 1 (ถูกสุด 5🪙) แล้วลองซื้อใหม่ (บอทตกต่อ)');
        if (isOn('tgOn')) void tgSend('🪱 เหยื่อหมด + เงินไม่พอซื้อขั้นเดิม → ลงเหยื่อขั้น 1 (ถูกสุด) เพื่อตกต่อ · Advisor จะปรับขึ้นเองเมื่อเงินพอ');
      } else {
        stopBot(cfg.autoBuy
          ? 'เหยื่อหมด + เงินไม่พอแม้แต่เหยื่อขั้น 1 (5🪙) — เงินหมดจริง ขายปลา/เติมเงินแล้วเปิดใหม่ 🏪'
          : 'เหยื่อหมดทุกขั้น — เปิดระบบซื้ออัตโนมัติ หรือไปซื้อเอง 🏪');
      }
    } finally {
      busy = false;
      pendingCast = 0;
      lastCast = now();
    }
  }

  // ---- สั่งงานจากปุ่มในแผง: ต้องรอให้จบรอบตกปลาก่อน ----
  // เดิมกดปุ่มตอนปลากำลังฮุบ บอทจะเปิดหน้าร้าน/กระเป๋าทับ = ปลาหลุดทันที
  async function runWhenIdle(label, fn) {
    if (busy) { say('บอทกำลังทำงานอื่นอยู่ รอสักครู่'); return; }
    if (gameState() !== 'idle') {
      say(`⏳ รอจบรอบตกปลาก่อน แล้วจะ${label}`);
      const ok = await waitFor(() => {
        const st = gameState();
        if (st === 'result') fireClick(btnByText('ตกต่อ!'));   // ปิด popup ให้ ไม่งั้นรอเก้อ
        return st === 'idle';
      }, 30000, 200);
      if (!ok) { say(`รอนานเกินไป — ยกเลิก${label}`); return; }
      await sleep(300);
    }
    await fn();
  }

  // ---- บังคับใช้เบ็ด/เหยื่อตามที่ตั้งไว้ ก่อนเริ่มเหวี่ยง ----
  async function ensureGear() {
    if (busy) return;
    busy = true;
    try {
      if (isOn('forceRod') && currentRod() !== null && currentRod() !== cfg.rodTier) {
        const ok = await cycleTo('เลือกเบ็ด', cfg.rodTier, currentRod);
        if (!ok) disableForSession('forceRod', `สลับไปเบ็ดขั้น ${cfg.rodTier} ไม่ได้ (ยังไม่มีเบ็ดขั้นนั้น?) — พักการบังคับเบ็ด`);
      }
      const b = currentBait();
      if (enforceBait() && !baitTargetBlocked() && b && b.tier !== null && b.tier !== targetBait()) {
        // ปุ่มสลับเหยื่อจะข้ามขั้นที่ของหมด ถ้าวนครบแล้วยังไม่ได้ = ขั้นนั้นไม่มีของ (targetBait รวม override โหมดล่าปลาเทพ)
        const ok = await cycleTo('เลือกเหยื่อ', targetBait(), () => currentBait()?.tier);
        if (!ok) {
          // 🪱 v6.193: โหมดไล่สต๊อก — สลับไปขั้นที่ไล่ไม่ได้ (ของหมด) → ทิ้งกองนี้ สแกนใหม่ (อย่าซื้อมาเติม)
          if (isOn('useBaitStock') && drainTier && targetBait() === drainTier) {
            say(`🪱 สต๊อกเหยื่อขั้น ${drainTier} หมดแล้ว — หากองถัดไป/กลับโหมดปกติ`);
            drainTier = 0; void scanDrainTier();
          } else if (autoBuyEff()) {
            needBuy = true;   // ให้ไปซื้อขั้นนี้มาก่อน แล้วค่อยสลับใหม่รอบหน้า
            say(`ไม่มีเหยื่อขั้น ${targetBait()} เหลืออยู่ — จะแวะซื้อให้`);
          } else if (isOn('forceBait')) {
            disableForSession('forceBait', `ไม่มีเหยื่อขั้น ${targetBait()} เหลืออยู่ — พักการบังคับเหยื่อ`);
          } else {
            // 🪱 v6.198: Advisor บังคับขั้นที่ "ของหมด + ปิดซื้ออัตโนมัติ" → เดิมวน cycleTo ไม่จบ = สลับเหยื่อรัว ไม่ตกปลา
            //   แก้: เลิกบังคับขั้นนั้นชั่วคราว (3 นาที) แล้วตกด้วยเหยื่อที่มีอยู่จริง (ขั้นที่ cycleTo วนไปหยุด)
            const eq = currentBait();
            baitBlockTier = targetBait(); baitBlockUntil = now() + 180000;
            if (eq && eq.tier != null && (eq.stock == null || eq.stock > 0)) {
              say(`🪱 ไม่มีเหยื่อขั้น ${targetBait()} + ปิดซื้ออัตโนมัติ → ตกด้วยขั้น ${eq.tier} (${BAIT_TIERS[eq.tier - 1]?.name ?? '?'})${eq.stock != null ? ` เหลือ ${eq.stock}` : ''} ที่มีอยู่แทน · เปิดซื้อ/ตั้งเหยื่อเอง (ปิด Advisor ลงมือเอง) ถ้าต้องการขั้นอื่น`);
              if (isOn('tgOn') && isOn('tgWarn')) void tgSend(`🪱 เหยื่อขั้น ${targetBait()} หมด + ปิดซื้ออัตโนมัติ → ตกด้วยขั้น ${eq.tier} ที่มีอยู่แทน (เลิกบังคับ 3 นาที)`);
            }
          }
        }
      }
    } finally {
      busy = false;
      lastCast = now();
    }
  }

  // ================= 🧪 ระบบทดสอบเหยื่อ =================
  // ทดสอบทุกขั้นเหยื่อ (แม้ขั้นที่ตั้งห้ามไว้) × 2 รอบ (ไม่ใช้ยา / ใช้ยาทั้ง 2 ตัว 🐋🍀) รอบละ N ครั้ง
  // เก็บข้อมูลทุกครั้ง (ปลา/ราคา/ขยะ) แล้วสรุปว่าแบบไหนกำไร/ครั้งดีสุด → แจ้ง Telegram
  // ทดสอบ "รอบใช้ยา" = เปิดยาทั้ง 2 ตัว (🐋 ปลาตัวใหญ่ 2,000 + 🍀 โชคปลาแรร์ 2,500) พร้อมกัน
  const POTION_W_PRICE = 2000, POTION_L_PRICE = 2500, POTION_BOTH = POTION_W_PRICE + POTION_L_PRICE;
  // ซื้อ consumable 1 ตัวจากแท็บ 👕 ชุด (ใช้ตอนทดสอบ — ไม่มี ROI gate)
  // คืนค่า: 'free' = ใช้ขวดค้างในกระเป๋า (ไม่เสียเงิน — ผู้เรียกห้ามบวกต้นทุน) · 'bought' = ซื้อ+ใช้สำเร็จ · false = ไม่ได้บัฟ
  async function buyTestPotion(nameRe) {
    if (busy) return false;
    busy = true; let ok = false;
    try {
      // v6.121: ใช้ยาค้างในกระเป๋าก่อน (แบบเดียวกับ buyPotions/กาแฟ) — กันซื้อขวดใหม่ทั้งที่มีของ
      if (await useConsumable(nameRe)) return 'free';
      if (!await openShop()) return false;
      await shopTab('🧪 ยา'); await sleep(350);   // ยาย้ายมาแท็บของตัวเอง (เดิม 👕 ชุด)
      const row = [...document.querySelectorAll('div[class*="tk-inner"]')].find((r) => nameRe.test(r.textContent || ''));
      const add = row && [...row.querySelectorAll('button')].find((b) => /ใส่ตะกร้า/.test(b.textContent) && !b.disabled);
      if (!add) { await closeShop(); return false; }
      fireClick(add); await sleep(300);
      const buy = btnByText('ซื้อเลย!') || btnByText('เหรียญไม่พอ');
      if (!buy || buy.disabled || /เหรียญไม่พอ/.test(buy.textContent)) { await closeShop(); return false; }
      fireClick(buy);
      const done = await waitFor(() => { const t = document.body.innerText; if (t.includes('✅ ซื้อสำเร็จ!')) return 'ok'; if (t.includes('❌')) return 'fail'; return null; }, 8000);
      await sleep(400); await closeShop();
      // เกมล่าสุด: ซื้อแล้วต้อง "กดใช้" จากกระเป๋าถึงได้บัฟ
      ok = done === 'ok' ? await useConsumable(nameRe) : false;
      return ok ? 'bought' : false;
    } catch (e) { await closeShop(); return false; }
    finally { busy = false; pendingCast = 0; lastCast = now(); }
  }
  // สถิติจาก recs ของขั้น t เฉพาะรอบที่ต้องการ — buff=มียาทั้งคู่ (bw&&bl) · plain=ไม่มียาเลย (!bw&&!bl) · N ล่าสุด · หักค่ายา
  // sinceTs = time-fence: นับเฉพาะ record ตั้งแต่เริ่มทดสอบ (กันปนกับรอบทดสอบก่อน/การฟาร์มปกติที่ค้างใน ring buffer)
  // md = 'b'/'g' กรองเฉพาะโหมด (v6.90 ทดสอบ 2 โหมด) · null = ไม่กรองโหมด
  function recBuffStat(t, wantBuff, N, potionCost, sinceTs = 0, md = null) {
    let list = (profit.recs[t] || []).filter((c) => (c.at || 0) >= sinceTs
      && (wantBuff ? (c.bw && c.bl) : (!c.bw && !c.bl))
      && (!md || c.md === md));
    if (list.length > N) list = list.slice(-N);
    if (!list.length) return null;
    const casts = list.length, revenue = list.reduce((a, c) => a + (c.price || 0), 0);
    const junk = list.filter((c) => c.junk).length;
    const rare = list.filter((c) => ['rare', 'epic', 'legendary', 'mythic'].includes(c.rarity)).length;
    const pf = revenue - casts * baitUnit(t) - (potionCost || 0);
    return { tier: t, phase: wantBuff ? 'buff' : 'plain', md, casts, pfCast: pf / casts, junkPct: junk / casts * 100, rarePct: rare / casts * 100 };
  }
  const potionKey = () => `${test.mode || 'bot'}-${test.tier}`;   // แยกต้นทุนยาต่อ (โหมด+ขั้น) — v6.90 รองรับทดสอบ 2 โหมด
  async function ensureTestBuff(want) {
    if (want) {   // รอบใช้ยา: เปิดยาทั้ง 2 ตัว (ซื้อเฉพาะตัวที่ยังไม่ทำงาน)
      // ⚡ v6.101: เคารพเกณฑ์ "ห้ามใช้ยาเมื่อพลังต่ำ" ในโหมดทดสอบด้วย — พลังต่ำแล้วเปิดยา = บัฟทิ้งเปล่ากลางรอบ
      //   ลองเติมพลังก่อน (กาแฟกระเป๋า/ร้าน — buyCoffee เช็คกระเป๋าก่อนอยู่แล้ว v6.93) · ยังต่ำ = ข้ามรอบแบบ retry ได้ ("ทำต่อ")
      if (cfg.potionMinEnergy > 0) {
        let eT = energyPct();
        if (eT != null && eT < cfg.potionMinEnergy && isOn('buyCoffee') && now() > coffeeFailUntil) {
          say(`🧪 พลัง ${Math.round(eT)}% < เกณฑ์ใช้ยา ${cfg.potionMinEnergy}% — เติมกาแฟก่อนเปิดยา ☕`);
          await waitFor(() => !busy && !orchestrating, 20000);
          await buyCoffee();
          eT = energyPct();
        }
        if (eT != null && eT < cfg.potionMinEnergy) {
          say(`🧪 พลัง ${Math.round(eT)}% < เกณฑ์ใช้ยา ${cfg.potionMinEnergy}% — ข้ามรอบยา (ลองใหม่ได้ด้วย "ทำต่อ" เมื่อพลังฟื้น)`);
          return false;
        }
      }
      const pk = potionKey();
      for (let i = 0; i < 4 && testRunning; i++) {
        const b = readBuffs();
        if (b.weight && b.luck) return true;                      // ครบทั้งคู่แล้ว
        await waitFor(() => !busy && !orchestrating, 20000);      // รอคิวว่างก่อนซื้อ (buyTestPotion เด้งเงียบถ้า busy)
        if (!b.weight) {
          say('🧪 ซื้อยา 🐋 ปลาตัวใหญ่...');
          const rw = await buyTestPotion(/ยาปลาตัวใหญ่/);
          // 'free' = ใช้ขวดในกระเป๋า ไม่เสียเงิน → ไม่บวกต้นทุน (บวกเฉพาะ 'bought')
          if (rw) { if (rw === 'bought') { test.potionByTier[pk] = (test.potionByTier[pk] || 0) + POTION_W_PRICE; profit.life.potionCost = (profit.life.potionCost || 0) + POTION_W_PRICE; saveProfit(); } await sleep(600); }
          else { await sleep(4000); }
        }
        if (!testRunning) break;
        if (!readBuffs().luck) {
          say('🧪 ซื้อยา 🍀 โชคปลาแรร์...');
          const rl = await buyTestPotion(/ยาโชคปลาแรร์/);
          if (rl) { if (rl === 'bought') { test.potionByTier[pk] = (test.potionByTier[pk] || 0) + POTION_L_PRICE; profit.life.potionCost = (profit.life.potionCost || 0) + POTION_L_PRICE; saveProfit(); } await sleep(600); }
          else { await sleep(4000); }
        }
      }
      const b = readBuffs();
      if (!(b.weight && b.luck)) say(`⚠️ เปิดยาไม่ครบ (🐋${b.weight ? '✓' : '✗'} 🍀${b.luck ? '✓' : '✗'}) — ข้ามรอบยาขั้นนี้`);
      return b.weight && b.luck;
    }
    // รอบไม่ใช้ยา: รอให้ยา "ทั้งคู่" หมดก่อน (โพลทุก 30 วิ · เพดาน 35 นาที — ต้องเกินอายุยา 30 นาที ไม่งั้นรอไม่ทันแล้วข้ามผิดๆ)
    let waited = 0;
    while (buffActive() && testRunning && waited < 70) {
      if (waited === 0) say('🧪 รอยาหมดก่อนเริ่มรอบไม่ใช้ยา (โพลทุก 30 วิ)...');
      if (waited > 0 && waited % 6 === 0) { const b = readBuffs(); say(`🧪 รอยาหมด... (${waited * 30} วิ · ยังมี ${b.weight ? '🐋' : ''}${b.luck ? '🍀' : ''})`); }
      await sleep(30000); waited++;
    }
    if (buffActive()) say('⚠️ ยายังไม่หมด — ข้ามรอบไม่ใช้ยาขั้นนี้');
    return !buffActive();
  }
  // สลับไปเหยื่อขั้นนี้จาก "ที่มีในกระเป๋า" ก่อน (ไม่ซื้อ) — ใช้ cycleTo ตรงๆ (ไม่ผ่าน ensureGear ที่มี side-effect เปลี่ยน cfg.baitTier)
  // 🎣 v6.183 (แก้ต้นตอของบั๊กเงินหาย v6.182): เกมสลับเหยื่อได้ "เฉพาะตอนอยู่ใกล้น้ำ"
  //   ถ้าบอทยืนไกลบ่อ → สลับล้มเหลวเงียบๆ → ระบบทดสอบเข้าใจว่า "ไม่มีเหยื่อขั้นนี้" → ซื้อซ้ำ (และรอบทดสอบถูกข้าม)
  //   ก่อนสลับจึงต้องยืนยันว่า "ตกปลาได้" (ปุ่มตกปลากดได้ = อยู่ในระยะบ่อ) · ถ้าไม่ได้ ให้เดินไปโซนตกปลาก่อน
  async function ensureNearWater(maxMs = 15000) {
    const ok = () => { const b = qBtn('ตกปลา (F)'); return !!b && !b.disabled; };
    if (ok()) return true;
    const fz = bossFishingZone();
    if (fz) {
      logInfo('🎣 ยืนไกลบ่อ — เดินเข้าโซนตกปลาก่อนสลับเหยื่อ');
      try { getPhaserScene().autoWalker.navigate({ x: fz.x, y: fz.y + 120, mapId: bossMapId() }); } catch {}
      return !!await waitFor(ok, maxMs, 400);
    }
    return ok();
  }
  async function equipTestBait(tier) {
    if (currentBait()?.tier === tier) return currentBait();
    await waitFor(() => !busy && !orchestrating, 15000);
    if (!(await ensureNearWater())) logWarn('🎣 เดินเข้าใกล้บ่อไม่สำเร็จ — การสลับเหยื่ออาจล้มเหลว (จะไม่ซื้อซ้ำ: มีเกราะสต๊อกกันไว้)');
    busy = true;
    try { await cycleTo('เลือกเหยื่อ', tier, () => currentBait()?.tier); }
    finally { busy = false; lastCast = now(); }
    return currentBait();
  }
  // เตรียมเหยื่อขั้นที่จะทดสอบ: มีในกระเป๋า→ใส่เลย(ไม่ซื้อ) · หมดเกลี้ยง/ไม่มีขั้นนี้→ค่อยซื้อ 1 แพ็ค
  // 🛑 v6.182 (บั๊กเงินหาย): เดิมวน "สลับ→ซื้อ" ได้ **4 รอบ** และตัดสินจาก "สลับสำเร็จไหม" ไม่ใช่ "มีเหยื่อไหม"
  //   → ถ้าสลับไม่ได้ (เกมสลับเหยื่อได้เฉพาะ "ตอนใกล้น้ำ" — ตอนนั้นบอทยืนไกลบ่อ) จะซื้อซ้ำ 4 แพ็ค/ขั้น
  //   ใหม่: ① ถามสต๊อกจริงจากร้านก่อนเสมอ ② มีของ = ไม่ซื้อเด็ดขาด ③ ซื้อได้ **ไม่เกิน 1 ครั้ง/ขั้น**
  async function ensureTestBait(tier) {
    cfg.baitTier = tier; saveCfg(); syncPanel();
    const b0 = await equipTestBait(tier);
    if (b0 && b0.tier === tier && b0.stock > 0) return true;      // ใส่ได้+มีของ → จบ ไม่ซื้อ
    // สลับไม่สำเร็จ ≠ ไม่มีของ — ต้องเช็คสต๊อกจริงก่อนตัดสินใจซื้อ
    const stock = await baitStockOf(tier);
    if (stock === null) logWarn(`🧪 อ่านสต๊อกเหยื่อขั้น ${tier} ไม่ได้ — จะไม่ซื้อ (กันซื้อซ้ำ)`);
    if (stock !== null && stock > 0) {
      say(`🧪 มีเหยื่อขั้น ${tier} อยู่แล้ว ${stock} ชิ้น — ไม่ซื้อ (สลับไม่สำเร็จ อาจต้องยืนใกล้น้ำ)`);
    } else if (stock === 0) {
      await waitFor(() => !busy && !orchestrating, 20000);
      await sellThenBuy(true);   // ซื้อได้ครั้งเดียวเท่านั้น (เบรกเกอร์ v6.182 คุมอีกชั้น)
      needBuy = false;
      await sleep(500);
    }
    await equipTestBait(tier);   // สลับครั้งสุดท้ายเผื่อเพิ่งซื้อมา
    return currentBait()?.tier === tier && (currentBait()?.stock || 0) > 0;
  }
  // อ่าน "สต๊อกจริง" ของเหยื่อขั้นที่ระบุจากแถวในร้าน — null = อ่านไม่ได้ (ถือว่า "มี" ไว้ก่อน กันซื้อซ้ำ)
  async function baitStockOf(tier) {
    if (busy || orchestrating) return null;
    busy = true;
    try {
      if (!await openShop()) return null;
      await shopTab('🪱 เหยื่อ');
      const row = shopRows().find((r) => r.tier === tier);
      return row && row.stock !== null ? row.stock : null;
    } catch { return null; }
    finally { await closeShop(); busy = false; }
  }
  // ---------- 🪱 v6.193: ไล่ใช้สต๊อกเหยื่อขั้นคุ้มก่อนซื้อใหม่ ----------
  //   รายได้/ครั้ง แบบตัดฟลุ๊ค (ใช้ advTrimStat เดิม — ตัด legendary/mythic กันขั้น 5 ถูกปลาเทพลากขึ้นเกินจริง)
  const baitRevCast = (tier) => { try { const s = advTrimStat(tier, 0); return s ? s.revCast : null; } catch { return null; } };
  let drainTier = 0, lastDrainScan = -1e9;
  // 🪱 v6.198: กัน "วนสลับเหยื่อไม่จบ" เมื่อ Advisor/บังคับ สั่งขั้นที่ "ของหมด + ซื้อไม่ได้ (autoBuy ปิด)"
  //   → เลิกบังคับขั้นนั้นชั่วคราว แล้วตกด้วยเหยื่อที่มีอยู่ · ลองใหม่หลัง cooldown (เผื่อของกลับมา/เปิดซื้อ)
  let baitBlockTier = 0, baitBlockUntil = 0;
  const baitTargetBlocked = () => baitBlockTier === targetBait() && now() < baitBlockUntil;
  // เปิดร้านครั้งเดียว อ่านสต๊อกทุกขั้น แล้วเลือก "ขั้นกองใหญ่ที่รายได้/ครั้งสูงสุด และไม่แย่กว่าขั้นที่ Advisor จะเลือก"
  async function scanDrainTier() {
    if (busy || orchestrating || testRunning || mythicActive()) return;
    lastDrainScan = now();
    busy = true;
    try {
      if (!await openShop()) return;
      await shopTab('🪱 เหยื่อ'); await sleep(200);
      const rows = shopRows().filter((r) => r.tier && r.stock !== null);
      // baseTier = ขั้นที่จะฟาร์มถ้าไม่ไล่สต๊อก (Advisor เลือก หรือ cfg) — ห้ามไล่ขั้นที่รายได้ต่ำกว่านี้
      let baseTier = cfg.baitTier || 1;
      try { const a = advisorDecide(); if (a && a.bestTier) baseTier = a.bestTier; } catch {}
      const baseRev = baitRevCast(baseTier) ?? 0;
      const cands = rows
        .filter((r) => r.stock >= (cfg.baitStockMin || 200) && r.tier !== baseTier)
        .map((r) => ({ tier: r.tier, stock: r.stock, rev: baitRevCast(r.tier) }))
        .filter((c) => c.rev != null && c.rev >= baseRev)      // ไม่ไล่ขั้นที่ตกได้น้อยกว่าฐาน (เสียโอกาส/ครั้ง)
        .sort((a, b) => b.rev - a.rev);
      const prev = drainTier;
      drainTier = cands.length ? cands[0].tier : 0;
      if (drainTier && drainTier !== prev)
        say(`🪱 ไล่ใช้สต๊อกเหยื่อขั้น ${drainTier} ก่อน (มี ${cands[0].stock} · รายได้/ครั้ง ~${Math.round(cands[0].rev)} ≥ ฐานขั้น ${baseTier} ~${Math.round(baseRev)}) — ใช้ของที่ซื้อไว้แล้วให้คุ้ม ไม่ซื้อใหม่จนกว่าจะหมด`);
      else if (!drainTier && prev)
        say('🪱 ไล่สต๊อกเหยื่อขั้นคุ้มหมดแล้ว — กลับไปโหมดปกติ (Advisor เลือกขั้น + ซื้อตามเดิม)');
    } catch (e) { logErr('สแกนสต๊อกเหยื่อล้มเหลว', e); }
    finally { await closeShop(); busy = false; }
  }
  // ระงับการซื้อเฉพาะตอนกำลังไล่สต๊อก (ไม่งั้นซื้อขั้นที่กำลังไล่มาเติม = ไล่ไม่มีวันหมด)
  const autoBuyEff = () => isOn('autoBuy') && !(isOn('useBaitStock') && drainTier);

  // ---------- 🔬 v6.207: สำรวจขั้นเหยื่อเป็นระยะ (explore) ----------
  //   ปัญหา: Advisor เป็น exploit ล้วน — ยึดขั้นที่ดีที่สุด "ตามข้อมูลที่มี" แล้วตกขั้นนั้นตลอด
  //   → ขั้นอื่นไม่มีข้อมูลใหม่เข้าเลย · เกมปรับสมดุล (% แรร์ / ราคาปลา / โต๊ะดรอป) เมื่อไร บอทไม่มีทางรู้
  //   วิธี: เป็นระยะ สลับไปตกขั้นที่ "ข้อมูลเก่าสุด" สั้นๆ (N ครั้ง) เพื่อรีเฟรชสถิติ แล้วกลับขั้นเดิม
  //   ⚖️ คุมต้นทุน: ประเมิน (กำไร/ครั้งของขั้นดีสุด − ของขั้นที่จะลอง) × จำนวนครั้ง · เกินงบ = ข้ามขั้นนั้น
  let exploreTier = 0, exploreLeft = 0, lastExploreAt = NEVER, exploreMismatch = 0;
  try { const t = +W.localStorage.getItem('tokpla_bait_explore') || 0; if (t) lastExploreAt = now() - Math.min(Date.now() - t, 24 * 3600000); } catch {}
  // 🔬 v6.212 (ผู้ใช้ขอ): เก็บ "ความคืบหน้าการสำรวจ" ข้ามรีโหลด — เดิมอยู่ใน memory ล้วน
  //   → รีโหลด (Tampermonkey อัปเดต/RDP หลุด/เกมค้าง) กลางสำรวจ = หาย เก็บได้ไม่ครบ N (ผู้ใช้เจอ: ขั้น5=26 · ขั้น7=22 แทน 100)
  const EXPLORE_PROG_KEY = 'tokpla_bait_explore_prog';
  const saveExploreProg = () => { try { if (exploreTier) W.localStorage.setItem(EXPLORE_PROG_KEY, JSON.stringify({ tier: exploreTier, left: exploreLeft, at: Date.now() })); else W.localStorage.removeItem(EXPLORE_PROG_KEY); } catch {} };
  try {   // กู้คืนตอนโหลด — ถ้าค้างไม่เกิน 12 ชม. (นานกว่านั้นถือว่าเก่าเกิน สภาพเกมอาจเปลี่ยน)
    const d = JSON.parse(W.localStorage.getItem(EXPLORE_PROG_KEY) || 'null');
    if (d && d.tier && d.left > 0 && Date.now() - (d.at || 0) < 12 * 3600000) {
      exploreTier = d.tier; exploreLeft = d.left;
      exploreEvent(`🔄 กู้คืนหลังรีโหลด — สำรวจขั้น ${exploreTier} ต่อ (เหลือ ${exploreLeft} ครั้ง)`);
    }
  } catch {}
  // เวลาที่ "เก็บข้อมูลขั้นนี้ล่าสุด" (แมพปัจจุบัน) — ไม่มีข้อมูลเลย = เก่าสุด (ควรลองก่อน)
  function baitLastSeen(tier) {
    const list = profit.recs[tier] || [];
    for (let i = list.length - 1; i >= 0; i--) { const c = list[i]; if (!curMap || c.map === curMap) return c.at || 0; }
    return 0;
  }
  // กำไร/ครั้ง แบบตัดฟลุ๊ค (ใช้ประเมินต้นทุนการสำรวจ) — ไม่มีข้อมูล = ถือว่าเท่าขั้นฐาน (ไม่กีดกันขั้นที่ยังไม่เคยลอง)
  const baitNetEst = (tier, baseNet) => { const s = advTrimStat(tier, cfg.statWin || 200); return s ? s.score : baseNet; };
  function pickExploreTier() {
    let baseTier = cfg.baitTier || 1;
    try { const a = advisorDecide(); if (a && a.bestTier) baseTier = a.bestTier; } catch {}
    const baseNet = baitNetEst(baseTier, 0);
    const casts = clamp(cfg.advExploreCasts || 30, 5, 300);
    const budget = Math.max(0, cfg.advExploreMaxCost || 0);
    const cands = [];
    for (let t = 1; t <= (baitCeil || 8); t++) {
      if (t === baseTier) continue;
      if (!advTierOk(t)) continue;                       // เคารพ "ห้าม Advisor ใช้ขั้นนี้" ของผู้ใช้
      const cost = Math.max(0, baseNet - baitNetEst(t, baseNet)) * casts;
      if (budget && cost > budget) continue;                 // แพงเกินงบ → ไม่ลองขั้นนี้
      cands.push({ tier: t, at: baitLastSeen(t), cost });
    }
    if (!cands.length) return null;
    cands.sort((a, b) => a.at - b.at);                       // ข้อมูลเก่าสุดก่อน
    return { ...cands[0], casts, baseTier };
  }
  function startExplore() {
    const p = pickExploreTier();
    lastExploreAt = now();
    try { W.localStorage.setItem('tokpla_bait_explore', String(Date.now())); } catch {}
    if (!p) { logInfo('🔬 ยังไม่มีขั้นเหยื่อที่คุ้มจะสำรวจรอบนี้ (ติดงบ/ถูกห้าม) — ข้าม'); exploreEvent('⏭️ ข้ามรอบสำรวจ — ไม่มีขั้นที่คุ้ม (ติดงบ/ถูกห้าม)'); return; }
    exploreTier = p.tier; exploreLeft = p.casts; exploreMismatch = 0; saveExploreProg();
    const age = p.at ? `${Math.round((Date.now() - p.at) / 3600000)} ชม.ก่อน` : 'ไม่เคยเก็บในแมพนี้';
    exploreEvent(`🔬 เริ่มสำรวจขั้น ${p.tier} × ${p.casts} ครั้ง (ข้อมูลเก่า ${age} · ต้นทุน ~${Math.round(p.cost).toLocaleString()} 🪙 · จะกลับขั้น ${p.baseTier})`);
    say(`🔬 สำรวจขั้นเหยื่อ ${p.tier} จำนวน ${p.casts} ครั้ง (ข้อมูลล่าสุด: ${age} · ประเมินต้นทุน ~${Math.round(p.cost).toLocaleString()} 🪙) — เช็คว่าเกมเปลี่ยนค่าไหม แล้วจะกลับขั้น ${p.baseTier}`);
    if (isOn('tgOn')) void tgSend(`🔬 <b>สำรวจขั้นเหยื่อ</b> ขั้น ${p.tier} × ${p.casts} ครั้ง (ข้อมูลเก่า: ${esc(age)}) · กลับขั้น ${p.baseTier} เมื่อครบ`);
  }
  // จบการสำรวจ (ครบ N หรือยกเลิก) — เริ่มนับรอบถัดไป "ตอนจบ" (v6.208) การันตีได้ฟาร์มเต็มช่วง
  function exploreEnd(tier, completed) {
    exploreTier = 0; exploreLeft = 0; exploreMismatch = 0; saveExploreProg();
    lastExploreAt = now();
    try { W.localStorage.setItem('tokpla_bait_explore', String(Date.now())); } catch {}
    if (completed) {
      const s = advTrimStat(tier, cfg.advExploreCasts || 30);
      const res = s ? `กำไร/ครั้งล่าสุด ${Math.round(s.score)} 🪙 (จาก ${s.n} ตัวอย่าง)` : 'เก็บตัวอย่างไม่พอ';
      say(`🔬 สำรวจขั้น ${tier} ครบแล้ว — ${res} · ให้ Advisor ตัดสินต่อ`);
      exploreEvent(`✅ สำรวจขั้น ${tier} ครบ ${cfg.advExploreCasts || 30} ครั้ง — ${res}`);
    } else {
      exploreEvent(`⛔ ยกเลิกสำรวจขั้น ${tier} (ใส่เหยื่อขั้นนี้ไม่ได้/ของหมด)`);
    }
    try { advisorTick(true); } catch {}   // ให้ Advisor คิดใหม่ทันทีด้วยข้อมูลสด
  }
  // เรียกทุกครั้งที่เหวี่ยงจริง — v6.212: นับเฉพาะครั้งที่ "ตกด้วยขั้นสำรวจจริง" (ตกด้วยขั้นอื่น = ไม่นับ)
  function exploreTick(firedTier) {
    if (!exploreTier) return;
    // ตกด้วยขั้นอื่น (ขั้นสำรวจใส่ไม่ได้/ของหมด/ถูกบล็อก) — ไม่นับ · ผิดขั้นติดกันนานพอ = ใส่ไม่ได้จริง → ยกเลิก
    if (firedTier != null && firedTier !== exploreTier) {
      if (++exploreMismatch >= 15) {
        say(`🔬 ยกเลิกสำรวจขั้น ${exploreTier} — ใส่เหยื่อขั้นนี้ไม่ได้ (ของหมด/ถูกบล็อก ${exploreMismatch} ครั้ง) · จะไปขั้นอื่นรอบหน้า`);
        exploreEnd(exploreTier, false);
      }
      return;
    }
    exploreMismatch = 0;
    exploreLeft -= 1;
    saveExploreProg();
    if (exploreLeft <= 0) exploreEnd(exploreTier, true);
  }

  // ============================================================================
  // 🎁 v6.216: ระบบเก็บหีบสมบัติ — เดินไปเปิดหีบที่โผล่ในแมพเป็นระยะ (opt-in grabChest)
  //   ยืนยันสดกับ Phaser scene (อ่านผ่าน getPhaserScene เหมือน player/raidBoss):
  //     • scene.chests = [{id:"mapId:window:idx", x, y, obj}] — รายการหีบในแมพปัจจุบัน
  //     • scene.nearChestId = id ของหีบที่ "ยืนใกล้พอจะเปิด" (เกมตั้งเองจากระยะ) · null = ไม่ใกล้ใบไหน
  //     • scene.openedChests = Set(id) หีบที่เปิดไปแล้ว (persist ข้าม window) → ตัดออกไม่เดินซ้ำ
  //     • scene.chestDailyComplete = true เมื่อเปิดครบลิมิตวันนี้ → หยุดทั้งระบบ
  //   เปิด: เดินเข้าใกล้ (autoWalker) จน nearChestId===id แล้วกด E (เกมผูก "เปิดหีบ (E)") · เผื่อคลิกปุ่ม DOM
  // ============================================================================
  const CHEST_EV_KEY = 'tokpla_chest_ev';
  const chestEvent = (m) => pushEvent(CHEST_EV_KEY, m, 60);
  const chestEventsText = () => eventsText(CHEST_EV_KEY, '(ยังไม่มีเหตุการณ์หีบสมบัติ)');
  let lastChestCheckAt = NEVER, lastChestRunAt = NEVER;
  const chestSkip = new Map();   // id → เวลาที่ลองเปิดแล้วไม่สำเร็จ (กันวนใบเดิม 5 นาที)
  const chestShort = (id) => String(id || '').split(':').pop();
  const chestDailyDone = () => { try { return !!getPhaserScene()?.chestDailyComplete; } catch { return false; } };
  const nearChestId = () => { try { return getPhaserScene()?.nearChestId || null; } catch { return null; } };
  const chestOpened = (id) => { try { const o = getPhaserScene()?.openedChests; return o instanceof Set ? o.has(id) : false; } catch { return false; } };
  const chestOpenBtn = () => { try { return [...document.querySelectorAll('button')].find((b) => !isBotUI(b) && b.offsetParent && /เปิดหีบ/.test(b.textContent || '')) || null; } catch { return null; } };
  // 🐛 v6.217: หน้าต่างหีบ (รางวัล/คูลดาวน์/ผิดพลาด) มีปุ่ม "ปิด" แบบเต็มความกว้าง (rounded-2xl) และ **ไม่ปิดเอง**
  //   บั๊ก v6.216: เปิดหีบแล้วหน้าต่างค้างบังจอ → ตกปลาต่อไม่ได้ (isFishing=false ค้าง) · ต้องปิดให้ได้เสมอ
  const chestCloseBtn = () => { try { return [...document.querySelectorAll('button')].find((b) => !isBotUI(b) && b.offsetParent && (b.textContent || '').trim() === 'ปิด' && /rounded-2xl/.test(b.className || '')) || null; } catch { return null; } };
  function closeChestDialog() { const b = chestCloseBtn(); if (b) { fireClick(b); return true; } return false; }
  // อ่านข้อความ "ของเกม" เท่านั้น (คูลดาวน์/หมดอายุ/ลิมิต) — 🐛 v6.221: ตัด UI บอทออก
  //   เดิมอ่านทั้ง body.innerText → log panel ของบอทมีคำ "หายไปแล้ว/คูลดาวน์/เปิดหีบ" (จาก event เก่า) → match ตัวเอง = จำแนกผิด
  const chestMsg = () => {
    try {
      let t = '';
      for (const el of document.querySelectorAll('body *')) {
        if (el.children.length || el.closest('[data-tkbot]')) continue;   // เอาเฉพาะ leaf ที่ไม่ใช่ UI บอท
        const s = el.textContent; if (s && s.trim()) t += s + '\n';
      }
      return t;
    } catch { try { return document.body.innerText || ''; } catch { return ''; } }
  };
  // หีบที่ "ยังเปิดได้" ในแมพนี้ (ตัดที่เปิดแล้ว/เพิ่งลองไม่สำเร็จ) · ครบลิมิตวัน = ว่างเสมอ
  function findChests() {
    try {
      const s = getPhaserScene(); if (!s || !Array.isArray(s.chests) || s.chestDailyComplete) return [];
      const opened = s.openedChests instanceof Set ? s.openedChests : null;
      const out = [];
      for (const ch of s.chests) {
        if (!ch || typeof ch.x !== 'number' || typeof ch.y !== 'number' || !ch.id) continue;
        if (opened && opened.has(ch.id)) continue;
        const sk = chestSkip.get(ch.id); if (sk && now() - sk < 300000) continue;
        out.push({ id: ch.id, x: Math.round(ch.x), y: Math.round(ch.y) });
      }
      return out;
    } catch { return []; }
  }
  // ถึงรอบเช็คหีบไหม (ลำดับต่ำ — หลังบอส/เมือง/ล่าปลาเทพ) · self-throttle chestCheckMin นาที
  function chestGrabDue() {
    if (!isOn('grabChest')) return false;
    if (orchestrating || busy || bossPhase !== 'idle' || mythicActive() || testRunning || energyResting || paused) return false;
    if (now() - lastChestCheckAt < clamp(cfg.chestCheckMin || 3, 1, 120) * 60000) return false;
    lastChestCheckAt = now();
    if (chestDailyDone()) return false;
    // ใกล้เวลาบอส = อย่าเดินไกลไปเก็บหีบ (บอสสำคัญกว่า) — เว้นระยะ lead + 5 นาที
    if (isOn('bossHunt')) { const bt = bossTimerMin(); if (bt != null && bt <= clamp(cfg.bossLeadMin, 1, 60) + 5) return false; }
    return findChests().length > 0;
  }
  // เดินไปเปิดหีบใบเดียว — คืน 'opened' | 'blocked' (หมดอายุ/ลิมิต) | 'cooldown' | 'unreachable' | 'fail'
  //   ⚠️ v6.217: ปิดหน้าต่างหีบ "ทุกครั้ง" ก่อน return (รางวัล/คูลดาวน์ค้าง = บังจอ ตกปลาต่อไม่ได้)
  async function grabOneChest(c, mapId) {
    chestEvent(`🚶 เดินไปหีบ #${chestShort(c.id)} ที่ (${c.x},${c.y})`);
    const aw = gameWalker();
    const t0 = now(), maxMs = 30000; let lastNav = 0;
    while (enabled && isOn('grabChest') && now() - t0 < maxMs) {
      if (bossMapId() !== mapId) { chestEvent('↩️ แมพเปลี่ยนระหว่างเดินไปหีบ — ยกเลิกใบนี้'); return 'unreachable'; }
      if (nearChestId() === c.id) break;                       // เกมยืนยัน "ใกล้หีบ" แล้ว
      if (aw && !aw.walking && now() - lastNav > 2500) { lastNav = now(); try { aw.navigate({ x: c.x, y: c.y, mapId }); } catch {} }
      await sleep(350);
    }
    // เข้าใกล้พิกัดแล้วแต่เกมยังไม่จับ "ใกล้หีบ" → ขยับชิดอีกนิดด้วย WASD
    if (nearChestId() !== c.id && bossMapId() === mapId) await bossWalkTo(c.x, c.y, { thresh: 14, maxMs: 8000, anyMode: true });
    if (nearChestId() !== c.id) { chestEvent(`⚠️ เข้าใกล้หีบ #${chestShort(c.id)} ไม่ได้ (เกมไม่ขึ้น "ใกล้หีบ")`); return 'unreachable'; }
    // เปิด: กด E (เกมผูก E กับ "เปิดหีบ") + เผื่อคลิกปุ่ม DOM · ยืนยันจาก openedChests
    //   เกมบังคับ "คูลดาวน์ระหว่างเปิดหีบ" (เพิ่งเปิดไป รอสักครู่) → รอแล้วลองใหม่ ไม่ทิ้งใบนี้ทันที
    let result = 'fail';
    for (let k = 0; k < 5 && !chestOpened(c.id); k++) {
      gameHotkey('KeyE', 69);
      await sleep(400);
      const btn = chestOpenBtn(); if (btn && !chestOpened(c.id)) fireClick(btn);
      if (await waitFor(() => chestOpened(c.id), 1800, 200)) break;
      const msg = chestMsg();
      if (/เพิ่งเปิดหีบ|รอสักครู่|คูลดาวน์/.test(msg)) {           // คูลดาวน์ระหว่างใบ — ปิดกล่อง รอ แล้วลองใหม่
        closeChestDialog(); result = 'cooldown';
        if (k < 4) { if (k === 0) chestEvent('⏳ คูลดาวน์ระหว่างเปิดหีบ — รอแล้วลองใหม่'); await sleep(5000); }
        continue;
      }
      // 🐛 v6.220: อย่าเช็ค "เปิดหีบวันนี้ x/y" (นั่นคือ HUD ตัวนับรายวัน โชว์ค้างตลอด ไม่ใช่ error!) →
      //   เดิม false-block ทุกใบ (log: "เปิดไม่ได้ 🎁 หีบเงิน" ทั้งที่เปิดได้ → เสียเที่ยวเดินซ้ำ) · ลิมิตวันใช้ chestDailyComplete พอ
      const blk = /หายไปแล้ว|เปิดไปแล้ว|คนละแมพ/.exec(msg);
      if (blk) {   // error จริง (หมดอายุ/เปิดแล้ว/คนละแมพ) — ปิดกล่อง เลิกใบนี้
        closeChestDialog();
        chestEvent(`ℹ️ เปิดไม่ได้: ${blk[0].replace(/\s+/g, ' ').trim().slice(0, 40)}`); result = 'blocked'; break;
      }
    }
    closeChestDialog();   // 🛡️ ปิดหน้าต่างรางวัล/ค้างเสมอ (กันบังจอ — บั๊ก v6.216)
    if (chestOpened(c.id)) { chestEvent(`✅ เปิดหีบ #${chestShort(c.id)} สำเร็จ`); if (isOn('tgOn')) void tgSend('🎁 เปิดหีบสมบัติสำเร็จ'); return 'opened'; }
    return result;
  }
  // orchestrator เก็บหีบ — เก็บทุกใบที่เปิดได้ในแมพนี้แล้วปล่อยให้ตกปลาต่อ (ครอบ orchestrating หยุดฟาร์มชั่วคราว)
  async function runChestGrab() {
    if (orchestrating || busy) return;
    lastChestRunAt = now();
    if (chestDailyDone() || !findChests().length) return;
    orchestrating = true;
    const home = bossMapId();
    let opened = 0;
    try {
      for (let guard = 0; guard < 6 && enabled && isOn('grabChest'); guard++) {
        if (chestDailyDone()) { chestEvent('🎁 เปิดครบลิมิตวันนี้แล้ว — พักระบบหีบ'); break; }
        const chests = findChests(); if (!chests.length) break;
        const p = bossPlayerXY() || { x: 0, y: 0 };
        chests.sort((a, b) => Math.hypot(a.x - p.x, a.y - p.y) - Math.hypot(b.x - p.x, b.y - p.y));
        const c = chests[0];
        const r = await grabOneChest(c, home);
        if (r === 'opened') { opened++; continue; }
        // คูลดาวน์ยังไม่หายหลังรอ → เลิกทริปนี้ (รอบเช็คหน้ามาเก็บใบที่เหลือ) · พักใบนี้สั้นๆ
        if (r === 'cooldown') { chestSkip.set(c.id, now() - 240000); chestEvent('⏳ ยังติดคูลดาวน์ — กลับไปตกก่อน เดี๋ยวรอบหน้ามาเก็บใบที่เหลือ'); break; }
        chestSkip.set(c.id, now());   // unreachable/blocked/fail → พัก 5 นาที
      }
    } catch (e) { logErr('runChestGrab', e); }
    finally {
      bossReleaseAll();   // ปล่อยปุ่มทิศที่อาจกดค้างจาก bossWalkTo (กันตัวเดินเองต่อ)
      closeChestDialog();   // 🛡️ กันหน้าต่างหีบค้างบังจอเป็นครั้งสุดท้าย (บั๊ก v6.216 — ตกปลาต่อไม่ได้)
      // กลับจุดตกปลาเดิม เพื่อให้ระบบตกปลาปกติเหวี่ยงต่อได้ทันที (ไม่งั้นอาจไปยืนบนบก)
      try { const fz = bossFishingZone(); if (fz && bossMapId() === home && gameWalker()) gameWalker().navigate({ x: fz.x, y: fz.y + 120, mapId: home }); } catch {}
      if (opened) chestEvent(`🎁 จบทริป — เปิดได้ ${opened} ใบ กลับไปตกปลาต่อ`);
      lastChestRunAt = now();   // 🐛 v6.221: รีเซ็ตตอน "จบ" ด้วย — ทริปยาว (หลายใบ) จะได้ให้ safety-net ปิด dialog ค้าง 60 วิ นับจากจบจริง
      orchestrating = false; lastCast = now(); pendingCast = 0;
    }
  }

  // 🎣 v6.219: เดินกลับ "ริมบ่อ" ถ้าตัวละครไม่ได้อยู่ใกล้บ่อ (scene.nearPond=false)
  //   ที่มา (ผู้ใช้เจอ v6.218): รีโหลดหน้า/อัปเดตสคริปต์ → ตัวเกิดที่จุด spawn (ไกลบ่อ) → ไม่มี orb "ตกปลา (F)" → บอทยืนนิ่ง
  //   เดิมบอทถือว่า "อยู่ริมบ่อแล้วเสมอ" — พังทันทีถ้าตัวไปโผล่ที่อื่น (spawn/เก็บหีบ/กลับจากบอส) · ครอบทุกกรณีที่นี่จุดเดียว
  // 🐛 v6.221: คืน true/false เฉพาะเมื่อ nearPond เป็น boolean จริง — ถ้า field หาย/undefined (ช่วง transition/เกมเปลี่ยนชื่อ) = null
  //   เดิม !!s.nearPond ยุบ undefined→false → walkToPond ทำงานทุกเฟรมช่วงโหลด (แย่งงาน idle อื่น) · null = "ไม่รู้ อย่ายุ่ง"
  const sceneNearPond = () => { try { const v = getPhaserScene()?.nearPond; return typeof v === 'boolean' ? v : null; } catch { return null; } };
  let lastPondWalk = 0, lastPondSay = 0, pondWalkStart = 0;
  function walkToPondIfNeeded() {
    if (bossMapId() === BOSS_MAP || mythicActive()) { pondWalkStart = 0; return false; }   // ถ้ำบอสไม่มีบ่อ · ล่าปลาเทพคุมตำแหน่งเอง
    if (sceneNearPond() !== false) { pondWalkStart = 0; return false; }   // ถึงบ่อแล้ว/อ่านไม่ได้ = เลิก (แตะเฉพาะ "ไกลบ่อแน่ๆ")
    const fz = bossFishingZone(); const aw = gameWalker();
    if (!fz || !aw) return false;                                   // แมพนี้ไม่มีโซนตกปลา/ไม่มี pathfinder
    if (!pondWalkStart) pondWalkStart = now();
    // 🛡️ v6.220: เดินนานเกิน 45 วิ ยังไม่ถึงบ่อ (หา A* ไม่เจอ/ติดกำแพง) → ปล่อยตรรกะเดิม (เตือน→รีโหลด) จัดการ
    //   กัน "วนเดินไม่จบ" มาแทน safety-net รีโหลด (ถ้าค้าง early-return ตรงนี้ตลอด บอทจะไม่มีวันรีโหลดหลุด)
    if (now() - pondWalkStart > 45000) return false;
    if (now() - lastPondWalk < 4000) return true;                   // กำลังเดินอยู่ อย่าสั่ง navigate ซ้ำถี่
    lastPondWalk = now();
    try { aw.navigate({ x: fz.x, y: fz.y + 120, mapId: bossMapId() }); } catch {}
    if (now() - lastPondSay > 30000) { lastPondSay = now(); logInfo('🎣 ตัวละครไม่ได้อยู่ริมบ่อ (หลังรีโหลด/เก็บหีบ/กลับจากบอส) → เดินกลับบ่อเอง'); }
    return true;
  }

  // อ่าน "เพดานเหยื่อจริง" จากร้าน (ขั้นสูงสุดที่ปลดล็อกแล้ว) — กันทดสอบขั้นที่ยังล็อกอยู่ + แจ้งช่วงให้ตรง
  async function detectBaitCeil() {
    await waitFor(() => !busy && !orchestrating, 20000);   // รอคิวว่าง (เด้งเงียบ = เพดานผิดทั้งการทดสอบ)
    if (busy || orchestrating) return;
    busy = true;
    try {
      if (!await openShop()) return;
      await shopTab('🪱 เหยื่อ'); await sleep(350);
      const usable = shopRows().filter((r) => r.tier && !r.lockedLv).map((r) => r.tier);
      if (usable.length) baitCeil = Math.max(...usable);   // จำกัดที่ขั้นสูงสุดที่ใช้ได้จริง (เช่น 7)
      await closeShop();
    } catch (e) { await closeShop(); }
    finally { busy = false; pendingCast = 0; lastCast = now(); }
  }
  // เก็บความคืบหน้าทดสอบลง localStorage — รอดรีเฟรช/หลุดกลางคัน แล้ว "ทำต่อจากเดิม" ได้
  const TEST_KEY = 'tokpla_bot_test';
  function loadTestProgress() { try { const d = JSON.parse(W.localStorage.getItem(TEST_KEY) || 'null'); if (d && d.done) return d; } catch {} return null; }
  function saveTestProgress() { if (test) try { W.localStorage.setItem(TEST_KEY, JSON.stringify({ N: test.N, done: test.done, total: test.totalRounds, potionByTier: test.potionByTier, startAt: test.startAt, origBait: test.origBait, ts: Date.now() })); } catch {} }
  function clearTestProgress() { try { W.localStorage.removeItem(TEST_KEY); } catch {} }
  // % ความคืบหน้าทดสอบ = (รอบที่เสร็จ + เศษของรอบที่กำลังทำ) / รอบทั้งหมด
  function testPct() {
    if (!test || !test.totalRounds) return 0;
    const dN = Object.keys(test.done || {}).length;
    const frac = test.N ? (test.count || 0) / test.N : 0;
    return Math.min(100, Math.round((dN + (testRunning ? frac : 0)) / test.totalRounds * 100));
  }
  // ข้อความสถานะทดสอบ (อ่านง่าย + แถบความคืบหน้า) — ใช้ในปุ่มแผง/คำสั่ง Telegram/heartbeat
  function testStatus() {
    // ไม่มีการทดสอบในหน่วยความจำ (เพิ่งรีเฟรช) → ลองอ่านความคืบหน้าค้างจาก localStorage
    if (!test || !test.totalRounds) {
      const tp = loadTestProgress();
      if (!tp) {
        // v6.155: ไม่มีความคืบหน้าค้าง → โชว์ "ผลทดสอบล่าสุด" ถ้ามี (กันเข้าใจผิดว่า "ยังไม่เคยทดสอบ" ทั้งที่ทดสอบจบไปแล้ว/ข้อมูลเข้าสถิติแล้ว)
        let lr = null; try { lr = JSON.parse(W.localStorage.getItem('tokpla_bot_testresult') || 'null'); } catch {}
        if (lr && lr.best) {
          const m = Math.round((Date.now() - (lr.ts || 0)) / 60000), ago = m < 60 ? `${m} นาทีที่แล้ว` : `${Math.round(m / 60)} ชม.ที่แล้ว`;
          return `🧪 ผลทดสอบล่าสุด${lr.aborted ? ' (หยุดกลางคัน)' : ''}: 🏆 ${lr.best} — ${lr.pf >= 0 ? '+' : ''}${lr.pf} 🪙/ครั้ง · ${lr.N} ครั้ง/รอบ · ${ago}\n✅ ข้อมูลเข้าสถิติจริงแล้ว (บอทใช้ต่อได้) · กด "🔄 เริ่มใหม่ทั้งหมด" เพื่อทดสอบรอบใหม่`;
        }
        return '🧪 ยังไม่เคยทดสอบ — กด "🔄 เริ่มใหม่ทั้งหมด" หรือ /testbait';
      }
      const dN = Object.keys(tp.done || {}).length, tot = tp.total || 0;
      const p = tot ? Math.round(dN / tot * 100) : 0;
      return `🧪 มีทดสอบค้าง (หยุดอยู่) — เสร็จ ${dN}${tot ? '/' + tot : ''} รอบ${tot ? ` · ${p}%` : ''} · ${tp.N || '?'} ครั้ง/รอบ\nกด "▶️ ทำต่อจากเดิม" หรือ /testcont เพื่อไปต่อ`;
    }
    const tot = test.totalRounds, dN = Object.keys(test.done || {}).length, pct = testPct();
    const bar = (() => { const f = Math.round(pct / 10); return '▓'.repeat(f) + '░'.repeat(10 - f); })();
    const mLbl = test.mode === 'gameauto' ? '🎮ออโต้' : '🤖บอท', bLbl = test.buff ? '🐋🍀' : 'ไม่ใช้ยา';
    const cur = testRunning && test.tier
      ? `กำลังทดสอบ: ${mLbl} ขั้น ${test.tier} · ${bLbl} (${test.count || 0}/${test.N} ครั้ง)`
      : 'หยุดอยู่ — กด "▶️ ทำต่อจากเดิม" เพื่อไปต่อ';
    return `🧪 ทดสอบเหยื่อ ${pct}% [${bar}]\nเสร็จ ${dN}/${tot} รอบ · ${cur}`;
  }
  // resume=true → ทำต่อจากความคืบหน้าเดิม (ข้ามรอบที่เสร็จแล้ว) · resume=false → เริ่มใหม่ทั้งหมด
  async function runBaitTest(resume) {
    if (testRunning) { say('🧪 กำลังทดสอบอยู่แล้ว'); return; }
    if (!enabled) { say('🧪 เปิดบอทให้อัตโนมัติเพื่อเริ่มทดสอบ'); toggle(); }   // ยังไม่เปิด → เปิดให้เลย
    paused = false; pauseUntil = 0;                                            // เผื่อพักอยู่ — ปลุกให้ตกได้
    if (!enabled) { say('เปิดบอทไม่สำเร็จ — กด Alt+B เองแล้วลองใหม่'); return; }
    const prev = resume ? loadTestProgress() : null;
    if (prev && Date.now() - (prev.ts || 0) > 24 * 3600000) say('⚠️ ความคืบหน้าเดิมเก่ามาก (>24 ชม.) — แนะนำ "เริ่มใหม่ทั้งหมด" ถ้าสภาพเกมเปลี่ยน (เลเวล/แมพ/อุปกรณ์)');
    if (!resume) clearTestProgress();
    testRunning = true;
    // v6.89: จำเหยื่อเดิมไว้คืนหลังจบ (ensureTestBait เปลี่ยน cfg.baitTier ทุกขั้น — ไม่คืน = ฟาร์มขั้นแพงค้าง)
    // v6.121: รีเฟรชกลางทดสอบ cfg.baitTier ค้างเป็นขั้นที่ทดสอบอยู่ → resume ต้องใช้ origBait ที่ persist ไว้ ไม่ใช่ค่าปัจจุบัน
    const origBait = (prev && prev.origBait) || cfg.baitTier;
    let testDone = false;            // v6.96: จบครบทุกรอบจริงไหม (ต่างจากหลุดกลางคัน) → ใช้ตัดสินใจ testDoneAction
    const N = prev ? prev.N : clamp(cfg.testCasts || 100, 10, 500);   // ทำต่อ = ใช้ N เดิม (กันข้อมูลไม่เท่ากัน)
    // startAt = time-fence ของสถิติ: รายงานนับเฉพาะ record ที่ at ≥ startAt (กันปนข้อมูลรอบก่อน/การฟาร์มปกติ)
    test = { tier: null, mode: null, buff: false, phase: null, count: 0, N, tiers: [], potionByTier: (prev && prev.potionByTier) || {}, done: (prev && prev.done) || {},
             startAt: (prev && prev.startAt) || Date.now(), origBait };
    const doneN = Object.keys(test.done).length;
    say(resume && doneN ? `🧪 ทำต่อจากเดิม (เสร็จแล้ว ${doneN} รอบ) — เช็คขั้นเหยื่อ...` : '🧪 เริ่มทดสอบใหม่ — เช็คขั้นเหยื่อที่ปลดล็อก...');
    await waitFor(() => !busy && !orchestrating, 30000);   // รอให้งานค้าง (ขาย/เควส/กาแฟ) จบก่อน — กัน detectBaitCeil โดน busy เด้ง
    await detectBaitCeil();          // อ่านเพดานจริงก่อน (ไม่ทดสอบขั้นที่ยังล็อก)
    if (!testRunning || !enabled) { testRunning = false; return; }   // ถูกหยุดระหว่างเช็ค
    // v6.100: ข้ามขั้นที่ผู้ใช้ระบุ (testNoTiers เช่น "6,7,8" — ไม่อยากเสียเงินทดสอบขั้นแพง/ขาดทุน)
    const skipTiers = new Set((cfg.testNoTiers || '').split(',').map((s) => parseInt(s.trim(), 10)).filter((n) => n >= 1 && n <= 8));
    // v6.186: ข้ามขั้นที่ "ข้อมูลจริงพิสูจน์แล้วว่าขาดทุน" — Advisor ห้ามแตะเหยื่อระหว่างเทสต์ (กฎเหล็ก #4)
    //   → เทสต์จึงบังคับให้ฟาร์มขั้นขาดทุนเต็ม N ครั้งโดยไม่มีใครห้ามได้ (เคสจริง: ขั้น 8 = -366/ครั้ง)
    const autoSkip = [];
    const tiers = [];
    for (let t = 1; t <= (baitCeil || 8); t++) {
      if (skipTiers.has(t)) continue;
      const loss = isOn('testSkipLosing') ? provenLossTier(t) : null;
      if (loss) { autoSkip.push(loss); continue; }
      tiers.push(t);
    }
    if (!tiers.length) { say(`🧪 ไม่มีขั้นเหยื่อให้ทดสอบ — ถูกข้ามหมดทุกขั้นที่ปลดล็อก${autoSkip.length ? ' (บางขั้นข้ามอัตโนมัติเพราะขาดทุน — ปิดได้ที่ "ข้ามขั้นที่ขาดทุน")' : ' ("ข้ามขั้น" ครอบทุกขั้น)'} · แก้แล้วลองใหม่`); testRunning = false; return; }
    if (skipTiers.size) say(`🧪 ข้ามขั้น ${[...skipTiers].filter((t) => t <= (baitCeil || 8)).sort().join(',')} (ตามที่ตั้ง) — ทดสอบขั้น ${tiers.join(',')}`);
    test.tiers = tiers;
    // มิติทดสอบ: โหมด (bot / gameauto) × ยา (buff / plain) × ขั้นเหยื่อ
    //   ลำดับ: โหมด → ยา(buff ก่อน · หมดพอดีตอนเข้ารอบ plain) → ขั้น
    const modes = testModesArr();
    // รอบยา 3 ทาง (v6.101): both = ยาก่อนแล้วค่อยไม่ใช้ยา (ยาหมดพอดีตอนเข้ารอบ plain — เหตุผลเดิม v6.53)
    const buffOpts = cfg.testBuffMode === 'both' ? [true, false] : cfg.testBuffMode === 'buff' ? [true] : [false];
    // ประกาศให้ชัดว่าข้ามอะไรไปบ้าง + ประหยัดไปเท่าไร (ห้ามตัดเงียบ — ผู้ใช้ต้องรู้ว่ารายงานไม่ครอบขั้นไหน)
    if (autoSkip.length) {
      const saved = autoSkip.reduce((a, s) => a + Math.round(-s.net) * N * modes.length * buffOpts.length, 0);
      const detail = autoSkip.map((s) => `ขั้น${s.t} (${Math.round(s.net)}/ครั้ง · ${s.n} ตัวอย่าง)`).join(' · ');
      say(`🧪📉 ข้ามอัตโนมัติ ${autoSkip.length} ขั้นที่ข้อมูลพิสูจน์แล้วว่าขาดทุน: ${detail} — ประหยัด ~${saved.toLocaleString()} 🪙 · รายงานจะไม่ครอบขั้นเหล่านี้ (ปิดสวิตช์นี้ได้ถ้าอยากทดสอบซ้ำ)`);
      if (isOn('tgOn')) void tgSend(`🧪📉 <b>ข้ามขั้นที่ขาดทุน</b>\n${esc(detail)}\nประหยัด ~${saved.toLocaleString()} 🪙`);
    }
    const rounds = [];
    for (const mode of modes) for (const buff of buffOpts) for (const t of tiers) rounds.push({ t, mode, buff });
    test.totalRounds = rounds.length;   // เก็บไว้คำนวณ % ความคืบหน้า (testStatus/testPct)
    test.modes = modes;                 // เก็บโหมดที่ทดสอบจริง ไว้ใช้ตอนรายงาน (กัน cfg.testMode เปลี่ยนกลางคัน)
    test.buffs = buffOpts;              // เก็บรอบยาที่ทดสอบจริง (v6.101 — gate บล็อก "ยาคุ้มไหม" ต้องมีทั้ง 2 รอบ)
    const estCost = tiers.reduce((a, t) => a + baitUnit(t) * N * modes.length * buffOpts.length, 0) + (buffOpts.includes(true) ? tiers.length * modes.length * POTION_BOTH : 0);
    const modeLbl = modes.map((m) => m === 'bot' ? '🤖บอท' : '🎮ออโต้').join('+');
    say(`🧪 เริ่มทดสอบเหยื่อ ${tiers.length} ขั้น × ${modes.length} โหมด × ${buffOpts.length} รอบยา × ${N} ครั้ง = ${rounds.length} รอบ`);
    if (isOn('human') && (cfg.hBreak || cfg.hSession)) say('🧪 ปิดพักย่อย/พักใหญ่/จบเซสชันชั่วคราวระหว่างทดสอบ (คืนค่าให้เองเมื่อจบ) — กันรอบถูกข้ามเพราะพักยาว');
    if (isOn('tgOn')) void tgSend(`🧪 <b>เริ่มทดสอบเหยื่อ</b>\nขั้น 1-${baitCeil} × โหมด ${modeLbl} × ${buffOpts.map((b) => b ? 'ใช้ยา🐋🍀' : 'ไม่ใช้ยา').join('+')} × ${N} ครั้ง\n= ${rounds.length} รอบ · ประเมินต้นทุน ~${estCost.toLocaleString()} 🪙 · ใช้เวลานาน (แนะนำเปิดกาแฟ ☕)\nกด B ปิดบอท = หยุดทดสอบ`);
    try {
      for (const rd of rounds) {
        if (!testRunning || !enabled) throw new Error('stop');
        const t = rd.t, mLbl = rd.mode === 'bot' ? '🤖' : '🎮', bLbl = rd.buff ? 'ใช้ยา 🐋🍀' : 'ไม่ใช้ยา';
        const kk = `${rd.mode}-${t}-${rd.buff ? 'buff' : 'plain'}`;
        if (test.done[kk]) { continue; }   // รอบนี้เสร็จแล้ว (จากรอบก่อน) — ข้าม
        test.tier = t; test.mode = rd.mode; test.buff = rd.buff; test.phase = rd.buff ? 'buff' : 'plain'; test.count = 0;
        const buffReady = await ensureTestBuff(rd.buff);
        if (!testRunning || !enabled) throw new Error('stop');
        // ข้ามแบบ "ไม่จำว่าเสร็จ" — รอบที่พลาด (ยาไม่ตรง/เหยื่อไม่ได้) จะถูกลองใหม่ตอนกด "ทำต่อ" (ไม่หายถาวร)
        if (!buffReady) { say(`🧪 ${mLbl} ข้ามขั้น ${t} · ${bLbl} — สถานะยาไม่ตรงเงื่อนไข (ลองใหม่ได้ด้วย "ทำต่อ")`); continue; }
        if (!await ensureTestBait(t)) { say(`🧪 ${mLbl} ขั้น ${t} เอาเหยื่อมาไม่ได้ (ล็อก/เงินไม่พอ) — ข้าม (ลองใหม่ได้ด้วย "ทำต่อ")`); continue; }
        say(`🧪 ${testPct()}% · ทดสอบ ${mLbl} ขั้น ${t} · ${bLbl} (0/${N})`);
        let lastSay = 0, lastProg = test.count, lastProgAt = now(), lastBaitChk = 0;
        while (testRunning && enabled && test.count < N) {
          // เหยื่อหมด/หลุดขั้นกลางรอบ → เติม/สลับกลับ · เช็คทุก ~12 วิ (กันเปิดร้านรัวในโหมด auto ที่อ่าน currentBait ไม่นิ่ง)
          if (!busy && !orchestrating && now() - lastBaitChk > 12000) {
            lastBaitChk = now();
            const cb = currentBait();
            // gameauto: currentBait อ่านไม่นิ่งตอน auto → เติมเฉพาะเมื่ออ่านได้ว่าผิดขั้น/หมด · bot: อ่านนิ่ง → null=เติมได้
            if (cb ? (cb.tier !== t || (cb.stock || 0) <= 0) : rd.mode === 'bot') await ensureTestBait(t);
          }
          // รอบยา: ต่ออายุถ้าตัวใดตัวหนึ่งหมดกลางรอบ (ต้องมีครบทั้งคู่)
          if (rd.buff && !busy && !orchestrating) { const b = readBuffs(); if (!(b.weight && b.luck)) await ensureTestBuff(true); }
          if (test.count - lastSay >= 20) { lastSay = test.count; say(`🧪 ${testPct()}% · ${mLbl} ขั้น ${t} ${rd.buff ? '🐋🍀' : '–'} (${test.count}/${N})`); }
          // กันค้าง: ถ้าไม่มีความคืบหน้าเลย 8 นาที (เหยื่อหลุด/พลังหมดไม่มีกาแฟ/พักโหมดมนุษย์ยาว/เกมค้าง) → ข้ามรอบนี้ ไม่แฮงก์
          if (test.count > lastProg) { lastProg = test.count; lastProgAt = now(); }
          else if (now() - lastProgAt > 480000) { say(`🧪 ${mLbl} ขั้น ${t} ${bLbl} ค้าง (ไม่คืบหน้า 8 นาที ได้ ${test.count}/${N}) — ข้าม`); break; }
          await sleep(2500);
        }
        if (!testRunning || !enabled) throw new Error('stop');
        test.done[kk] = true; saveTestProgress();   // ครบ N หรือข้ามเพราะค้าง — จำไว้ (ไม่วนซ้ำ)
      }
      say(`✅ ทดสอบครบทุกรอบแล้ว (${test.totalRounds} รอบ) — หยุดทดสอบ · กำลังสรุปผล...`);
      sendTestReport(false);
      clearTestProgress();   // เสร็จครบทุกรอบ → ล้างความคืบหน้า (ครั้งหน้าเริ่มสด)
      testDone = true;       // จบครบจริง → ค่อยทำตาม testDoneAction ใน finally
    } catch (e) { sendTestReport(true); saveTestProgress(); }   // หลุดกลางคัน → เก็บไว้ให้ "ทำต่อ"
    finally {
      testRunning = false; test.tier = null; test.phase = null;
      // คืนเหยื่อเดิม (ถ้ายังเป็นค่าที่ ensureTestBait ตั้งค้างไว้) — กันฟาร์มต่อด้วยเหยื่อขั้นแพงที่เพิ่งทดสอบ
      // v6.186: "คืนค่าเดิม" ต้องไม่คืนไปสู่ขั้นที่ขาดทุน — เคสจริง origBait=8 (-366/ครั้ง) ทำให้จบเทสต์แล้วฟาร์มขาดทุนต่อ
      //   จนกว่า Advisor จะตื่นรอบถัดไป (ทุก 5 นาที) · ถ้า Advisor ปิดอยู่ = ขาดทุนยาวจนกว่าผู้ใช้จะเห็นเอง
      let back = origBait, why = '(ก่อนทดสอบ)';
      const lossBack = provenLossTier(origBait), bestBack = lossBack ? bestLandingTier() : null;
      if (lossBack && bestBack && bestBack !== origBait) {
        back = bestBack;
        why = `— ขั้น ${origBait} (ก่อนทดสอบ) ขาดทุน ${Math.round(lossBack.net)}/ครั้ง จึงคืนเป็นขั้นที่ Advisor แนะนำแทน`;
      } else if (lossBack) why = `(ก่อนทดสอบ · ขาดทุน ${Math.round(lossBack.net)}/ครั้ง ⚠️ Advisor ยังไม่มีขั้นอื่นแนะนำ — รอบหน้าจะแก้ให้เอง)`;
      if (cfg.baitTier !== back) {
        cfg.baitTier = back; saveCfg(); syncPanel?.();
        say(`🧪 คืนค่าเหยื่อเป็นขั้น ${back} ${why}`);
        if (lossBack && isOn('tgOn')) void tgSend(`🪱 <b>เลี่ยงเหยื่อขาดทุนหลังจบทดสอบ</b>\n${esc(`ขั้น ${origBait} → ${back} ${why}`)}`);
      }
      // v6.96: จบครบทุกรอบ → ทำตามที่ผู้ใช้ตั้ง (หยุด / ตกต่อโหมดบอท / ตกต่อโหมดออโต้เกม)
      //   หลุดกลางคัน (testDone=false เช่นกด B / เกมค้าง) ไม่แตะ — ให้ "ทำต่อจากเดิม" ได้
      if (testDone) applyTestDoneAction();
    }
  }
  // จบทดสอบครบแล้วทำอะไรต่อ (ตาม cfg.testDoneAction)
  function applyTestDoneAction() {
    const act = cfg.testDoneAction || 'stop';
    if (act === 'stop') { stopBot('🧪 ทดสอบเหยื่อครบทุกรอบแล้ว — หยุดบอทตามที่ตั้งไว้ (Alt+B เปิดใหม่เพื่อฟาร์มต่อ)'); return; }
    // ตกต่อ: ตั้งโหมดตกตามที่เลือก แล้วปล่อยให้ tick ทำงานปกติ
    cfg.fishMode = act; saveCfg(); syncPanel?.(); updateBadge?.();
    if (act !== 'gameauto' && gameAutoRunning()) stopGameAuto();   // เลิกใช้ auto เกมถ้าไม่ได้เลือกโหมดนั้น
    say(act === 'gameauto' ? '🧪 ทดสอบครบ — ตกต่อโหมด 🎮 ออโต้ของเกม' : '🧪 ทดสอบครบ — ตกต่อโหมด 🤖 บอทตกเอง');
    if (isOn('tgOn')) void tgSend(`🧪 <b>ทดสอบครบทุกรอบ</b> — ${act === 'gameauto' ? 'ตกต่อโหมด 🎮 ออโต้ของเกม' : 'ตกต่อโหมด 🤖 บอทตกเอง'}`);
  }
  // 🧪 v6.172: byBoss = หยุดเพราะบอสใกล้มา (ไม่ใช่ผู้ใช้สั่ง) → จำไว้ให้ "ทำต่อเอง" หลังล่าบอสจบ
  //   บั๊กที่ทำให้ทดสอบเหยื่อ "ไม่เคยจบสักครั้ง": v6.148 สั่ง stopTest() ทุกครั้งที่บอสใกล้ (ทุก ~3 ชม.)
  //   แต่ไม่มีใครสั่งทำต่อ → เทสต์ค้างถาวร (ผลที่ได้จึงเป็น aborted:true เสมอ = สรุปเหยื่อที่ดีสุดไม่ได้)
  let testPausedByBoss = false;
  function stopTest(byBoss) {
    if (!testRunning) return;
    testRunning = false; saveTestProgress();
    testPausedByBoss = !!byBoss;
    say(byBoss ? '🧪 พักทดสอบชั่วคราว (บอสใกล้มา) — จะทำต่อเองหลังล่าบอสเสร็จ' : '🧪 หยุดทดสอบ (กด "ทำต่อจากเดิม" เพื่อไปต่อได้)');
  }
  // เรียกท้าย runBossHunt/bossFightHere — กลับมาทำเทสต์ต่อถ้าถูกพักเพราะบอส
  function resumeTestAfterBoss() {
    if (!testPausedByBoss || testRunning || !enabled) return;
    testPausedByBoss = false;
    say('🧪 ล่าบอสจบแล้ว — กลับไปทดสอบเหยื่อต่อจากเดิม');
    setTimeout(() => void runBaitTest(true), 4000);   // เว้นให้ระบบกลับบ้าน/ขายจบก่อน
  }
  function sendTestReport(aborted) {
    const rows = [];   // คำนวณจาก recs จริง (N ล่าสุด/ โหมด×ขั้น×สถานะยา = ครั้งที่เพิ่งทดสอบ)
    const testedModes = (test.modes || ['bot']).map((m) => m === 'gameauto' ? 'g' : 'b');
    const modeName = (md) => md === 'g' ? '🎮ออโต้' : '🤖บอท';
    for (const md of testedModes) {
      for (const t of test.tiers) {
        for (const wantBuff of [false, true]) {
          const r = recBuffStat(t, wantBuff, test.N, wantBuff ? (test.potionByTier[`${md === 'g' ? 'gameauto' : 'bot'}-${t}`] || 0) : 0, test.startAt || 0, md);
          if (r) rows.push(r);
        }
      }
    }
    if (!rows.length) { if (isOn('tgOn')) void tgSend('🧪 ทดสอบจบ — ไม่มีข้อมูล'); say('🧪 ไม่มีข้อมูลทดสอบ'); return; }
    rows.sort((a, b) => b.pfCast - a.pfCast);
    const best = rows[0];
    const lbl = (r) => `${modeName(r.md)} ขั้น ${r.tier} ${r.phase === 'buff' ? '🐋🍀' : ''}`.trim();
    try { W.localStorage.setItem('tokpla_bot_testresult', JSON.stringify({ best: lbl(best), pf: Math.round(best.pfCast), N: test.N, aborted: !!aborted, ts: Date.now() })); } catch {}   // v6.155: เก็บผลล่าสุดไว้โชว์ในสถานะ (กัน "ยังไม่เคยทดสอบ" หลังเทสต์จบ)
    let msg = `🧪 <b>ผลทดสอบเหยื่อ${aborted ? ' (หยุดกลางคัน)' : ''}</b> · ${test.N} ครั้ง/รอบ\n`;
    msg += `🏆 ดีสุด: <b>${lbl(best)}</b> — ${signed(best.pfCast)} 🪙/ครั้ง\n\nเรียงกำไร/ครั้ง (สุทธิ หักเหยื่อ+ยา):\n`;
    msg += rows.map((r, i) => `${i + 1}. ${lbl(r)} — ${signed(r.pfCast)}/ครั้ง · ขยะ ${r.junkPct.toFixed(0)}% · แรร์+ ${r.rarePct.toFixed(0)}% [${r.casts}]`).join('\n');
    // 🐋 ยาคุ้มไหม (เทียบ buff vs plain ในโหมด/ขั้นเดียวกัน — ต้องทดสอบทั้ง 2 รอบถึงเทียบได้)
    if ((test.buffs || []).includes(true) && (test.buffs || []).includes(false)) {
      const cmp = [];
      for (const md of testedModes) for (const t of test.tiers) {
        const p = rows.find((r) => r.tier === t && r.md === md && r.phase === 'plain');
        const b = rows.find((r) => r.tier === t && r.md === md && r.phase === 'buff');
        if (p && b) { const d = Math.round(b.pfCast - p.pfCast); cmp.push(`${modeName(md)} ขั้น ${t}: ยา ${d >= 0 ? 'คุ้ม +' + d : 'ไม่คุ้ม ' + d}/ครั้ง`); }
      }
      if (cmp.length) msg += `\n\n🐋 ยา 🐋🍀 คุ้มไหม:\n${cmp.join('\n')}`;
    }
    // 🤖vs🎮 เทียบโหมดในขั้น/สถานะยาเดียวกัน (เฉพาะเมื่อทดสอบทั้ง 2 โหมด)
    if (testedModes.includes('b') && testedModes.includes('g')) {
      const mc = [];
      for (const t of test.tiers) for (const wantBuff of [false, true]) {
        const rb = rows.find((r) => r.tier === t && r.md === 'b' && r.phase === (wantBuff ? 'buff' : 'plain'));
        const rg = rows.find((r) => r.tier === t && r.md === 'g' && r.phase === (wantBuff ? 'buff' : 'plain'));
        if (rb && rg) { const d = Math.round(rb.pfCast - rg.pfCast); mc.push(`ขั้น ${t}${wantBuff ? '🐋🍀' : ''}: บอท${d >= 0 ? ' ดีกว่า +' + d : ' แย่กว่า ' + d}/ครั้ง (บอท ${signed(rb.pfCast)} vs ออโต้ ${signed(rg.pfCast)} · แรร์+ ${rb.rarePct.toFixed(0)}%vs${rg.rarePct.toFixed(0)}%)`); }
      }
      if (mc.length) msg += `\n\n🤖 บอท vs 🎮 ออโต้ (ขั้นเดียวกัน):\n${mc.join('\n')}`;
    }
    msg += `\n\n✅ ข้อมูลทดสอบเก็บเข้าสถิติจริงแล้ว — บอทใช้ต่อได้เลย`;
    say(`🧪 ทดสอบจบ — ดีสุด ${lbl(best)} ${signed(best.pfCast)}/ครั้ง (ดู Telegram/Console)`);
    console.log('[Tokpla Bot] ผลทดสอบเหยื่อ\n' + msg.replace(/<\/?b>/g, ''));
    if (isOn('tgOn')) void tgSend(msg);
  }

  // ================= ระบบขายอัตโนมัติ =================

  // ตัดสินว่าชนิดไหนขายได้บ้าง โดยดู 3 ชั้น: ระดับความหายาก -> ปลา ✨ -> รายชื่อที่ระบุ
  function pickSpecies(cards) {
    const list = cfg.speciesList.split(',').map((s) => s.trim()).filter(Boolean);

    // เกมมีระบบล็อกของผู้เล่นเอง: ตัวที่ล็อกไว้ขายไม่ได้ (ทั้งปุ่ม "ขายทั้งหมด" และเลือกขาย เกมข้ามให้อัตโนมัติ)
    // กลุ่มที่ล็อกครบทุกตัว (ขายได้ 0) จึงตัดออกจากรายการที่บอทพิจารณาไปเลย — บอทไปยุ่งกับของที่ผู้เล่นล็อกไม่ได้
    const sellableOf = new Map();
    for (const c of cards) sellableOf.set(c.species, (sellableOf.get(c.species) || 0) + (c.sellable ?? c.count));
    const all = [...new Set(cards.map((c) => c.species))].filter((s) => (sellableOf.get(s) || 0) > 0);

    // ปลาชนิดเดียวกันมีระดับเดียวเสมอ แต่ถ้าอ่านสีไม่ออกแม้แต่ใบเดียวให้ถือว่าไม่รู้
    const rarityOf = new Map();
    const shinySpecies = new Set();
    for (const c of cards) {
      if (c.shiny) shinySpecies.add(c.species);
      if (!rarityOf.has(c.species) || c.rarity === null) rarityOf.set(c.species, c.rarity);
    }

    const locked = new Map();   // ชนิด -> เหตุผลที่ไม่ขาย
    const keep = (s, why) => { if (!locked.has(s)) locked.set(s, why); };

    let want = all;
    if (cfg.speciesMode === 'only') {
      for (const s of all) if (!list.includes(s)) keep(s, 'ไม่อยู่ในรายชื่อที่ระบุ');
    } else if (cfg.speciesMode === 'except') {
      for (const s of all) if (list.includes(s)) keep(s, 'อยู่ในรายชื่อยกเว้น');
    }

    for (const s of all) {
      const r = rarityOf.get(s);
      if (r === null) keep(s, 'อ่านระดับความหายากไม่ออก');
      else if (cfg.lockRarities.includes(r)) keep(s, `ล็อกระดับ ${RARITY_LABEL[r]}`);
      // ขายรายชนิดจะขายตัว ✨ รวมไปด้วยเสมอ (เกมไม่ให้แยก) จึงต้องล็อกทั้งชนิด
      if (cfg.keepShiny && shinySpecies.has(s)) keep(s, 'มีตัว ✨ อยู่');
    }

    want = all.filter((s) => !locked.has(s));
    return { want, all, locked, rarityOf, shinySpecies };
  }

  // 🏷️ v6.201: รายงาน "บอทมองปลาแต่ละชนิดเป็นระดับอะไร + จะทำอะไรกับมัน" — ให้ผู้ใช้ตรวจเองได้ว่าจำถูกไหม
  //   อ่านจากกระเป๋าจริง (สีวงแหวน) + ระดับที่เคยบันทึกในสถิติ แล้วเทียบให้เห็นถ้าไม่ตรงกัน
  function fishRarityReport() {
    const cards = readBag();
    const stat = {};   // ระดับที่เคยบันทึกไว้ในสถิติ (จาก popup ผลตกปลา)
    try {
      for (const t of Object.keys(profit.recs || {}))
        for (const c of (profit.recs[t] || [])) if (c && c.fish && !c.junk && c.rarity) stat[c.fish] = c.rarity;
    } catch {}
    const stoOn = isOn('npcStorageOn'), stoMin = rarityRank(cfg.npcStorageRarity);
    const essOn = isOn('npcEssenceOn'), essMin = rarityRank(cfg.npcEssenceRarity);
    const rows = [];
    const seen = new Set();
    for (const c of cards) {
      if (seen.has(c.species)) continue;
      seen.add(c.species);
      const r = c.rarity, rk = r ? rarityRank(r) : 99;
      const st = stat[c.species];
      rows.push({
        ชนิด: c.species,
        ระดับ: r ? RARITY_LABEL[r] : '⚠️ อ่านไม่ออก',
        ตรงกับสถิติ: !st ? '(ยังไม่มีสถิติ)' : (st === r ? 'ตรง' : `⚠️ สถิติว่า ${RARITY_LABEL[st] || st}`),
        ขาย: !r ? '❌ ไม่ขาย (อ่านระดับไม่ออก)'
          : (cfg.lockRarities || []).includes(r) ? `❌ ล็อก (${RARITY_LABEL[r]})`
          : (cfg.keepShiny && c.shiny) ? '❌ ล็อก (มี ✨)' : '✅ ขาย',
        ฝากคลัง: stoOn && r && rk >= stoMin ? '✅ ฝาก' : '—',
        แลกแก่น: essOn && r && npcEssTake(rk, essMin, stoMin) ? '✅ แลก' : '—',
      });
    }
    if (!rows.length) return '🏷️ ไม่เห็นการ์ดปลาในกระเป๋า — เปิดกระเป๋า (แท็บ 🐟 ปลา) ก่อนแล้วกดใหม่';
    const pad = (s, w) => { s = String(s); return s + ' '.repeat(Math.max(0, w - [...s].length)); };
    const head = `${pad('ชนิดปลา', 20)} ${pad('ระดับที่บอทเห็น', 16)} ${pad('เทียบสถิติ', 18)} ${pad('ขาย', 22)} ${pad('ฝาก', 6)} แลกแก่น`;
    const body = rows.map((r) => `${pad(r.ชนิด, 20)} ${pad(r.ระดับ, 16)} ${pad(r.ตรงกับสถิติ, 18)} ${pad(r.ขาย, 22)} ${pad(r.ฝากคลัง, 6)} ${r.แลกแก่น}`);
    const conf = `ตั้งไว้: ล็อกไม่ขาย [${(cfg.lockRarities || []).map((k) => RARITY_LABEL[k] || k).join(', ') || '-'}]`
      + ` · ฝากคลัง ${stoOn ? '≥ ' + (RARITY_LABEL[cfg.npcStorageRarity] || cfg.npcStorageRarity) : 'ปิด'}`
      + ` · แลกแก่น ${essOn ? '≥ ' + (RARITY_LABEL[cfg.npcEssenceRarity] || cfg.npcEssenceRarity) : 'ปิด'}`;
    return `🏷️ ระดับปลาที่บอทเห็น (${rows.length} ชนิดในกระเป๋า)\n${conf}\n\n${head}\n${body.join('\n')}`;
  }

  async function closeMenu() {
    const x = qBtn('ปิดเมนู');
    if (x) fireClick(x);
    await sleep(300);
  }

  // force = กดจากปุ่ม "ขายเดี๋ยวนี้" ในแผงตั้งค่า (ข้ามเงื่อนไข)
  // ---- เก็บเควสรายวัน (รางวัลพลังงาน ⚡) ----
  // v7: แผงเควสโหลดข้อมูลแบบ async (ขึ้น "กำลังเช็คเควสกับเซิร์ฟเวอร์...") และเซิร์ฟเวอร์บล็อกการรับตอนพลังเต็ม
  //     ปุ่มรับยังเป็น "รับ +N⚡" · ตอนกดจะกลายเป็น "กำลังรับ..." แล้วเป็น "เคลมแล้ว ✓" ถ้าสำเร็จ
  //     ถ้าเต็ม/ยังไม่เสร็จ จะเด้งข้อความแถบแดงแล้วปุ่มกลับมาเป็น "รับ +N⚡" เหมือนเดิม
  const QUEST_PANEL = () => qBtn('ปิดแผงเควส')?.closest('div[class*="tk-card"]') || document;
  const questClaimBtns = () =>
    [...QUEST_PANEL().querySelectorAll('button')].filter((b) => /^รับ\s*\+\d+/.test(b.textContent.trim()));
  const questClaiming = () =>
    [...QUEST_PANEL().querySelectorAll('button')].some((b) => /กำลังรับ/.test(b.textContent));
  const questError = () => {
    const txt = QUEST_PANEL().textContent || '';
    // หมายเหตุ: "พลังเต็มแล้ว...ไม่เสียเปล่านะ" ไม่ใช่ error (ทดสอบสดแล้ว: พลัง 100% ยังรับได้ +เหรียญ) — ตัดออกจากรายการหยุด
    for (const re of [/เควสนี้รับรางวัลไปแล้ววันนี้/, /เควสยังไม่สำเร็จ[^]*?วันนี้\)/, /โหลดเควสไม่สำเร็จ[^]*?อีกทีนะ/]) {
      const m = re.exec(txt);
      if (m) return m[0].replace(/\s+/g, ' ').trim();
    }
    return null;
  };

  async function runQuests() {
    if (busy || orchestrating) return;
    busy = true;
    try {
      await ensureMenuOpen();   // v6.104: เมนูถูกย่อ = ปุ่มเควสหายจาก DOM
      const q = qBtn('เควสรายวัน');
      if (!q) return;
      fireClick(q);
      if (!await waitFor(() => qBtn('ปิดแผงเควส'), 3000)) { say('เปิดแผงเควสไม่สำเร็จ'); return; }

      // 1) รอให้เควสโหลดเสร็จจากเซิร์ฟเวอร์ (เลิกขึ้น "กำลังเช็ค..." แล้วมีปุ่มรับ/เคลมแล้ว/footer/โหลดไม่สำเร็จ)
      await waitFor(() => {
        const txt = QUEST_PANEL().textContent || '';
        if (/กำลังเช็คเควสกับเซิร์ฟเวอร์/.test(txt)) return false;
        return questClaimBtns().length > 0 || /เควสรีเซ็ตทุกเที่ยงคืน|เคลมแล้ว|โหลดเควสไม่สำเร็จ/.test(txt);
      }, 7000);

      // รางวัลเควสมี 2 ส่วน (ยืนยันจากเกมสด): "รับ +30⚡ +200🪙" — พลังงาน + เหรียญ
      const rewardOf = (b) => {
        const t = b.textContent || '';
        const e = +((/\+(\d+)\s*⚡/.exec(t) || /\+(\d+)/.exec(t) || [])[1] || 0);         // พลังงาน (ใช้เช็ค overflow)
        const c = +(((/\+([\d,]+)\s*🪙/.exec(t) || [])[1] || '0').replace(/,/g, ''));    // เหรียญ (ไม่มีเพดาน ไม่เคยเสีย)
        return { e, c };
      };
      // 2) เก็บ "ทีละอัน" ตามผลทดสอบจริง: เควสให้ ⚡+🪙 · เกมยอมรับแม้พลังเต็ม (เหรียญได้เสมอ พลังส่วนเกินตัดทิ้ง)
      //    (a) อันที่รับแล้วพลังไม่ล้น (≤100) → เก็บก่อน = ได้พลังเต็มเม็ด ไม่เสีย
      //    (b) เหลือแต่อันที่จะล้น: พลังยังไม่สูง (<85) → เก็บไว้ก่อน รอพลังลดจะได้พลังคุ้มกว่า
      //        · พลังสูงแล้ว (≥85 · ส่วนเกินแทบไม่มีค่าเพราะไม่ต้องพึ่งกาแฟ) → เก็บเลย เอาเหรียญ + กันหลุดเที่ยงคืน
      const QUEST_FORCE_E = 85;
      let claimed = 0, gotE = 0, gotC = 0, stopMsg = null, kept = 0;
      for (let i = 0; i < 8; i++) {
        const btns = questClaimBtns();
        if (!btns.length) break;                       // ไม่มีอะไรให้รับแล้ว
        const e = energyPct();                         // พลังปัจจุบัน (อ่านได้แม้เปิดแผงเควส — verified)
        let b = null, rw = null;
        for (const cand of btns) { const r = rewardOf(cand); if (e == null || r.e === 0 || e + r.e <= 100) { b = cand; rw = r; break; } }
        if (!b) {                                      // เหลือแต่อันที่จะล้นพลัง
          if (e != null && e < QUEST_FORCE_E) { kept = btns.length; stopMsg = `พลัง ${Math.round(e)}% — เก็บเควส ${kept} อันที่เหลือไว้รับตอนพลังลด (ได้พลังคุ้มกว่า · เหรียญไม่หายเพราะรับก่อนรีเซ็ตเที่ยงคืน)`; break; }
          b = btns[0]; rw = rewardOf(b);               // พลังสูง/อ่านไม่ได้ → เก็บเลย (เหรียญได้ชัวร์)
        }
        const before = btns.length;
        fireClick(b);
        // รอจน "กำลังรับ..." หาย (เซิร์ฟเวอร์ตอบกลับแล้ว)
        await waitFor(() => !questClaiming(), 6000);
        await sleep(200);
        const err = questError();
        if (err) { stopMsg = err; break; }             // ยังไม่เสร็จ/รับไปแล้ว/โหลดพลาด → หยุด (พลังเต็มไม่ใช่ error แล้ว — เกมรับได้)
        if (questClaimBtns().length < before) {         // ปุ่มหายจริง = เคลมสำเร็จ (ได้เหรียญแน่ แม้พลังล้น)
          claimed += 1; gotE += rw.e; gotC += rw.c;
        } else break;                                   // ไม่เปลี่ยน → กันลูปค้าง
        await sleep(300);
      }
      if (!kept) kept = questClaimBtns().length;        // เควสที่ยังรับได้แต่ยังไม่ได้เก็บ

      const close = qBtn('ปิดแผงเควส');
      if (close) fireClick(close);
      await sleep(200);

      if (claimed > 0) {
        const cn = gotC ? ` +${gotC.toLocaleString()}🪙` : '';
        say(`🎁 รับเควส ${claimed} อัน (+${gotE}⚡${cn})${kept ? ` · เหลือ ${kept} อันไว้รอบหน้า` : ''}`);
        if (cfg.tgWarn && isOn('tgOn')) void tgSend(`🎁 <b>รับเควสรายวัน</b> ${claimed} อัน (+${gotE}⚡${cn}${kept ? ` · เก็บ ${kept} ไว้ทยอยเก็บ` : ''} · ตกไปแล้ว ${casts} ครั้ง)`);
      } else if (stopMsg) {
        say(`เควส: ${stopMsg}`);
        // พลังเต็ม/ทยอยเก็บ = ปกติ ไม่ใช่ error — ไม่แจ้ง TG รัวๆ
      } else {
        say('เควส: ยังไม่มีอันไหนรับได้');
      }
    } catch (e) {
      logErr('รับเควสไม่สำเร็จ', e);
      say('รับเควสไม่สำเร็จ — ดู Console');
      const close = qBtn('ปิดแผงเควส');
      if (close) fireClick(close);
    } finally {
      busy = false; pendingCast = 0; lastCast = now();
    }
  }

  async function runSell(force) {
    if (busy) return;
    busy = true;
    try {
      await ensureMenuOpen();   // v6.104: เมนูถูกย่อ = ปุ่มกระเป๋าหายจาก DOM
      say('เปิดกระเป๋าเช็คของ...');
      if (!(await openBagUI())) { say('เปิดกระเป๋าไม่สำเร็จ (ทั้งปุ่มและคีย์ลัด B)'); return; }

      const ok = await waitFor(() => readBagCount());
      if (!ok) { say('เปิดกระเป๋าไม่สำเร็จ'); await closeMenu(); return; }
      await sleep(250);   // รอ React วาดการ์ดให้ครบ

      const bag = readBagCount();
      const total = readTotalCoins();
      const cards = readBag();

      // ---- เงื่อนไขว่าถึงเวลาขายหรือยัง (คิดจากปลาในกระเป๋า) ----
      // เกณฑ์ % คิดจาก bagSlots จริง เผื่อผู้เล่นอัปเกรดกระเป๋า (50 -> สูงสุด 200 ช่อง)
      const pctNow = bag.slots > 0 ? (bag.count / bag.slots) * 100 : 0;
      const byPct = cfg.sellAtPct > 0 && pctNow >= cfg.sellAtPct;
      const byCount = cfg.sellAtCount > 0 && bag.count >= cfg.sellAtCount;
      const byCoins = cfg.sellAtCoins > 0 && total >= cfg.sellAtCoins;
      const noCond = cfg.sellAtPct === 0 && cfg.sellAtCount === 0 && cfg.sellAtCoins === 0;
      // ขยะไม่มีล็อก—ถ้ามีขยะให้ขายอยู่ ก็ถือว่าถึงเกณฑ์ได้ (กันกรณีปลาว่างแต่ขยะเต็ม)
      // ================= ขายปลา (แท็บ 🐟) =================
      // 🗑️ v6.168: ครอบ "ทั้งช่วงขายปลา" ด้วย labeled block — ออกจากบล็อกนี้ทางไหนก็ตาม **ต้องไหลไปขายขยะเสมอ**
      //   เดิมมี 3 จุดที่ `return` ทิ้งกลางทาง = ขยะไม่ถูกขายเลย:
      //     (1) ยังไม่ถึงเกณฑ์ขาย — เกณฑ์คิดจาก "ปลา" อย่างเดียว → ปลาว่าง/ล็อกหมดแต่ขยะเต็ม = ไม่มีวันได้ขายขยะ
      //         (คอมเมนต์เดิมตั้งใจกันเคสนี้ไว้แล้ว แต่โค้ดไม่ได้ทำตาม)
      //     (2)(3) หาปุ่ม "☑️ เลือกขาย" / "ขายที่เลือก (" ไม่เจอ — ยิ่งกระเป๋าเต็ม UI ยิ่งเพี้ยน ยิ่งตกเส้นทางนี้
      //   ขยะไม่มีล็อก = ขายได้เสมอ → เป็น "ช่องว่างฟรี" ที่ต้องไม่พลาด โดยเฉพาะตอนปลาล็อกจนตกปลาต่อไม่ได้
      sellFish: {
      if (!force && !byPct && !byCount && !byCoins && !noCond) {
        say(`ยังไม่ถึงเกณฑ์ขายปลา (${bag.count}/${bag.slots} = ${pctNow.toFixed(0)}% · ${total.toLocaleString()} 🪙) — ข้ามไปเช็คขยะ`);
        break sellFish;
      }
      if (!cards.length) {
        say(`ไม่มีปลาในกระเป๋า (${bag.count}/${bag.slots})`);
      } else {
        const { want, all, locked } = pickSpecies(cards);
        if (!want.length) {
          say(`ไม่มีชนิดไหนขายได้ — ล็อกไว้ทั้ง ${locked.size} ชนิด`);
        } else if (want.length === all.length) {
          // ---- ขายปลาทั้งหมด: กด 2 ครั้ง (ครั้งที่สองคือยืนยัน) ----
          say(`ขายปลาทั้งหมด ${all.length} ชนิด (${total.toLocaleString()} 🪙)...`);
          await sellAllCurrentTab();
        } else {
          // ---- ขายเฉพาะบางชนิด: เข้าโหมดเลือก แล้วแตะการ์ด 1 ใบต่อ 1 ชนิด ----
          // (แตะทั้งใบธรรมดาและใบ ✨ ของชนิดเดียวกัน = toggle 2 ครั้ง = ยกเลิกการเลือก)
          say(`ขาย ${want.length} ชนิด: ${want.join(', ')}`);
          const pick = btnByText('☑️ เลือกขาย');
          if (!pick) { say('หาปุ่มเลือกขายไม่เจอ — ข้ามไปขายขยะแทน'); break sellFish; }
          fireClick(pick);
          await sleep(250);

          const fresh = readBag();
          const done = new Set();
          for (const s of want) {
            const card = fresh.find((c) => c.species === s && !done.has(s));
            if (!card) continue;
            done.add(s);
            fireClick(card.el);
            await sleep(80);
          }

          const sellBtn = await waitFor(() => btnByText('ขายที่เลือก ('), 2000);
          if (!sellBtn) { say('หาปุ่มขายที่เลือกไม่เจอ — ข้ามไปขายขยะแทน'); break sellFish; }
          fireClick(sellBtn);
          await readSellToast();
        }
      }
      }   // ← ปิด sellFish: ทุกเส้นทางด้านบนมาบรรจบที่นี่ แล้วไปขายขยะต่อเสมอ

      // ================= ขายขยะ (แท็บ 🗑️) =================
      // เกมแยกกระเป๋าเป็นแท็บ ปลา/ขยะ — ต้องสลับไปแท็บขยะแล้วกด "ขายขยะทั้งหมด" ต่างหาก
      if (cfg.sellJunk) {
        const jt = junkTabBtn();
        if (jt) {
          fireClick(jt);
          await sleep(350);                 // รอสลับแท็บ + React วาดปุ่มขายใหม่
          const jTotal = readTotalCoins();  // ตอนนี้ปุ่มขายทั้งหมด = "ขายขยะทั้งหมด N 🪙"
          // v6.167: เดิมเชื่อยอดเหรียญอย่างเดียว — ขยะบางชิ้นราคา 0/อ่านยอดไม่ออก = ข้ามทิ้งทั้งที่มีของกินช่องอยู่
          //   เพิ่มเงื่อนไข "ปุ่มขายทั้งหมดกดได้" = มีของให้ขายจริง (สำคัญมากตอนกระเป๋าเต็ม — ขยะคือช่องว่างที่ได้มาฟรี)
          const jBtn = sellAllBtn();
          if (jTotal > 0 || (jBtn && !jBtn.disabled)) {
            say(`ขายขยะทั้งหมด (${jTotal > 0 ? jTotal.toLocaleString() + ' 🪙' : 'อ่านยอดไม่ออก — ขายเพื่อเปิดช่อง'})...`);
            await sellAllCurrentTab();
          } else {
            say('ไม่มีขยะให้ขาย');
          }
          // ปิดกระเป๋าแล้วแผงจะ unmount → รอบหน้าเปิดใหม่กลับมาแท็บปลาเอง ไม่ต้องสลับกลับ
        }
      }

      await sleep(600);
      await closeMenu();
      updateBadge();
    } catch (e) {
      logErr('ขายไม่สำเร็จ', e);
      say('เกิดข้อผิดพลาดตอนขาย — ดู Console');
      await closeMenu();
    } finally {
      busy = false;
      pendingCast = 0;
      lastCast = now();   // อย่าเพิ่งเหวี่ยงทันทีหลังปิดกระเป๋า
    }
  }

  // ================= ลูปตกปลา =================

  function resetRound() {
    prevPos = null;
    armed = true;
    aimPx = null;
  }

  function findBar() {
    const zones = document.querySelectorAll('div[class*="from-[#8ed065]"]');
    for (const z of zones) {
      const bar = z.parentElement;
      if (!bar) continue;
      const marker = bar.querySelector('div[class*="bg-[#5b4632]"]');
      if (!marker) continue;
      const isReel = !!bar.querySelector('div[class*="from-[#f07568]"]');
      return { bar, zone: z, marker, isReel };
    }
    return null;
  }

  // ---- อ่านสถานะจริงของเกมจาก DOM ----
  // ก่อนหน้านี้บอทเดาว่า "ไม่มีแถบ ไม่มีปุ่มตวัด = ว่าง" ซึ่งผิด เพราะระหว่างรอปลากินเหยื่อ
  // และตอนโชว์ผลปลาที่ได้ ก็ไม่มีทั้งสองอย่างเหมือนกัน บอทเลยกดปุ่มตกปลาซ้ำจนเกมรวน
  let wheelCache = null, tugCache = null;   // cache ผลอ่านเฟสใหม่ของเฟรมนี้ (branch ใช้ต่อ ไม่ scan ซ้ำ)
  function gameState() {
    barCache = null; wheelCache = null; tugCache = null;   // ล้าง cache ทุกครั้ง — กันใช้ของเฟรมเก่า
    // ปลาฮุบ: กลไกใหม่ (v6.82) = ปุ่ม orb "ตกปลา (F)" เดิมขึ้น "❗" (พื้นแดง ~2วิ) · กลไกเก่า = ปุ่มแยก "ตวัดเบ็ด!"
    const orb = qBtn('ตกปลา (F)');
    const orbTxt = orb ? (orb.textContent || '').trim() : '';
    if (orbTxt.includes('❗') || qBtn('ตวัดเบ็ด!')) return 'bite';
    // เฟสกลไกใหม่ — orb emoji เป็น fast-path (❗ตวัด · 🔥สู้ · ✊ชักเย่อ) ลดการสแกน DOM ต่อเฟรม
    // ใช้ fishModeEff: ระหว่างทดสอบเหยื่อบังคับเป็น bot (v6.88 เทสต์เคย deadlock ถ้าตั้ง gameauto/off ไว้)
    if (fishModeEff() === 'bot') {
      if (orbTxt.includes('🔥') || fightActive()) return 'fight';   // ปลาสู้: กดรัว (เช็คก่อน tug — banner ทับ UI ชักเย่อ)
      // เกจวงล้อ: กดตอนเข็มเข้าโซนแดง/ดาว · v6.121: เฉพาะวง ≥140px (เกจตกปลา 180+) — "เกจบอส" 104px ต้องไม่ทำให้
      //   เอนจินตกปลาเข้า state 'gauge' (กดผิดจังหวะ + recordGaugePress ปนสถิติตกปลา) — เกจบอสเป็นหน้าที่ bossFight เท่านั้น
      if ((wheelCache = readGaugeWheel()) && wheelCache.w >= 140) return 'gauge';
      wheelCache = null;   // วงเล็ก (เกจบอส) = ไม่ใช่เฟสตกปลา — ล้างกันสาขา gauge ใช้ต่อ
      if (orbTxt.includes('✊')) {
        if ((tugCache = readTugState())) return 'tug';              // ชักเย่อ: กดค้างคุมกรอบคลุมปลา
        return 'waiting';                                           // ✊ แต่กรอบยังไม่ขึ้น (เฟรมเปลี่ยนฉาก) — อย่าตกไป idle เดี๋ยว maintenance แทรกกลางรอบ
      }
      if ((tugCache = readTugState())) return 'tug';                // เผื่อ orb ไม่ขึ้น ✊ แต่ UI ชักเย่อมาแล้ว
    }
    if ((barCache = findBar())) return 'minigame';                                     // เกจตวัด / ดึงปลา (กลไกเก่า — เผื่อเกมย้อนกลับ)
    // รวม "ตกต่อ!"/"เก็บปลา"/"เก็บเบ็ด" เป็น scan ปุ่มเดียว (เดิม 2 รอบ querySelectorAll('button')/เฟรม)
    for (const b of document.querySelectorAll('button')) {
      const t = b.textContent.trim();
      if (t.startsWith('ตกต่อ!') || t.startsWith('เก็บปลา')) return 'result';           // popup ปลาที่ได้ ต้องกดปิด (เกมใหม่มีปุ่ม "เก็บปลา" ด้วย)
      if (t.startsWith('เก็บเบ็ด')) return 'waiting';                                   // ทุ่นลอยอยู่ รอปลากิน
    }
    // กลไกใหม่: ตอนสายอยู่ในน้ำ orb ยัง enabled + ไม่มีปุ่ม "เก็บเบ็ด" → อ่านจาก Phaser scene.isFishing
    // (สำคัญมาก: ไม่งั้นบอทเห็นเป็น idle → เหวี่ยงซ้ำ = ยกเลิกสายตัวเอง — บั๊กที่เจอตอนทดสอบสด)
    if (fishModeEff() === 'bot' && sceneIsFishing() === true) return 'waiting';
    for (const d of document.querySelectorAll('div[class*="drop-shadow"]')) {
      if (d.textContent.includes('กำลังดึงขึ้น')) return 'reeling';                    // กำลังส่งผลไปเซิร์ฟเวอร์
    }
    return 'idle';
  }

  function scoreToOffset(score, isReel) {
    if (isReel) {
      if (score > 95) return 0;   // 96-99 ไม่มีอยู่จริงในเกม เล็งกลางไปเลย
      return clamp((100 - score) / REEL_DROP * REEL_SPAN, 0, REEL_SPAN);
    }
    if (score >= 100) return 0;
    return clamp((100 - score) / CAST_DROP * CAST_SPAN, 0, CAST_SPAN);
  }

  // สุ่มดีเลย์รีแอคแบบมนุษย์: สามเหลี่ยมเอนกลาง + หางช้าบ้าง (แต่ไม่เกิน 900ms กัน hook หลุด)
  function sampleReact() {
    const lo = Math.min(cfg.reactMinMs, cfg.reactMaxMs), hi = Math.max(cfg.reactMinMs, cfg.reactMaxMs);
    let ms = lo + ((Math.random() + Math.random()) / 2) * (hi - lo);
    if (Math.random() < 0.1) ms += Math.random() * (hi - lo) * 0.7;   // บางครั้งช้าเป็นพิเศษ
    return clamp(ms, lo, 900);
  }

  // สุ่มระยะพักก่อนเหวี่ยงตัวถัดไป — บางครั้ง "เหม่อ" นานกว่าปกติ
  function sampleCastGap() {
    if (turboEff()) return randInt(120, 260);   // ⚡ เร็วสุด (v6.135 บีบจาก 150-350): เหวี่ยงทันทีที่ตัวก่อนจบ (มี guard sceneIsFishing กันเหวี่ยงซ้ำ)
    if (!hOn('hCastGap')) return 900;
    if (Math.random() * 100 < cfg.distractChance) return randInt(cfg.distractMinMs, cfg.distractMaxMs);
    return randInt(cfg.castGapMinMs, cfg.castGapMaxMs);
  }

  function resetHumanTimers() {
    castArmed = false; gateStart = 0; castGate = 0;
    breakUntil = 0; breakLabel = '';
    biteAt = 0; biteReact = 0;
    nextMicroAt = Math.max(1, randInt(cfg.microEvery * 0.6, cfg.microEvery * 1.4));
    nextMacroAt = Math.max(1, randInt(cfg.macroEvery * 0.7, cfg.macroEvery * 1.3));
    sessionEndAt = now() + randInt(cfg.sessionMinMin, cfg.sessionMaxMin) * 60000;
  }

  function planAim(g) {
    const barRect = g.bar.getBoundingClientRect();
    const zRect = g.zone.getBoundingClientRect();
    const center = zRect.left + zRect.width / 2;

    const lo = g.isReel ? cfg.reelMin : cfg.castMin;
    const hi = g.isReel ? cfg.reelMax : cfg.castMax;
    // โหมดมนุษย์: บางครั้งกดพลาดจริง คะแนนต่ำ (แทนที่จะเป๊ะทุกครั้ง)
    const want = (hOn('hMiss') && Math.random() * 100 < cfg.missChance)
      ? (g.isReel ? rand(55, 78) : rand(40, 68))
      : lo + Math.random() * (hi - lo);

    const offPx = scoreToOffset(want, g.isReel) * barRect.width;
    if (offPx < 0.5) return center;

    const side = Math.random() < 0.5 ? -1 : 1;
    let aim = center + side * offPx;
    if (aim < barRect.left + 2 || aim > barRect.right - 2) aim = center - side * offPx;
    return clamp(aim, barRect.left + 2, barRect.right - 2);
  }

  const BREAK_END_KEY = 'tokpla_bot_break_end', BREAK_LABEL_KEY = 'tokpla_bot_break_label';
  const MAX_BREAK_MS = 60 * 60000;   // เพดานพัก 60 นาที (กันข้อมูลเสียทำให้พักไม่จบ)
  // ตั้งพักยาว + จำเป็นเวลาจริง (Date.now) ลง localStorage เพื่อให้พักต่อได้หลังรีโหลด
  function beginBreak(ms, label) {
    ms = clamp(ms, 0, MAX_BREAK_MS);
    breakUntil = now() + ms; breakLabel = label;
    try { W.localStorage.setItem(BREAK_END_KEY, String(Date.now() + ms)); W.localStorage.setItem(BREAK_LABEL_KEY, label); } catch {}
  }
  function clearPersistedBreak() {
    try { W.localStorage.removeItem(BREAK_END_KEY); W.localStorage.removeItem(BREAK_LABEL_KEY); } catch {}
  }

  // จำสถานะ "เปิดอยู่" + เวลาล่าสุด ลง localStorage — ให้บอทกลับมารันเองหลังเกมรีเฟรช/รีโหลด
  // freshness: ถ้าหน้าถูกปิดไว้นานเกิน (เปิดเกมเองวันหลัง) จะไม่สตาร์ทเอง กันบอทเผลอตกโดยไม่ตั้งใจ
  const ENABLED_KEY = 'tokpla_bot_enabled', ENABLED_AT_KEY = 'tokpla_bot_enabled_at';
  const RESUME_FRESH_MS = 12 * 3600000;   // v6.147: 12 ชม. (เดิม 5 นาที สั้นไป — RDP หลุด/browser ค้างนานกว่านั้นแล้วเปิดใหม่ = ไม่ resume) · เป็น fallback ของธง tokpla_bot_resume ที่คุมโดย persistEnabled
  function persistEnabled() {
    try {
      W.localStorage.setItem(ENABLED_KEY, enabled ? '1' : '0');
      if (enabled) {
        W.localStorage.setItem(ENABLED_AT_KEY, String(Date.now()));   // heartbeat เวลาล่าสุดที่ยังรันอยู่
        W.localStorage.setItem('tokpla_bot_resume', '1');             // 🔄 v6.147: ธง "ตั้งใจให้เปิด" — คงไว้ตลอดที่เปิด → reload/เปิดใหม่แบบไหนก็ auto-resume (แม้ browser ค้าง/ปิดนานเช่น RDP หลุด, crash, กด F5 เอง) · ไม่พึ่ง freshness 5 นาทีที่พังถ้าค้างนาน
      } else {
        W.localStorage.removeItem('tokpla_bot_resume');              // ปิดเอง (stopBot/กด B) เท่านั้น = ล้างธง → ไม่ auto-resume (เจตนาหยุด)
      }
    } catch {}
  }

  function stopBot(reason) {
    enabled = false;
    if (testRunning) { saveTestProgress(); testRunning = false; }   // v6.155: ปิดบอท = หยุดทดสอบ + เซฟความคืบหน้าก่อน (กันข้อมูลหาย → "ทำต่อจากเดิม" ได้)
    if (bossPhase !== 'idle') { bossReleaseAll(); bossPhase = 'idle'; clearBossState(); }   // 👹 ปิดบอท = ยกเลิกล่าบอส + ปล่อยปุ่มเดินค้าง
    persistEnabled();   // จำว่าหยุดแล้ว (ไม่ auto-resume หลังรีโหลด เพราะหยุดด้วยเหตุผล)
    pauseUntil = 0;
    pendingCast = 0;
    resetRound();
    resetFishEngine();   // ปล่อยปุ่มที่กดค้าง (ชักเย่อ) + ล้างสถานะเอนจินใหม่
    zoneKey = null;
    updateBadge(reason);
    if (cfg.tgStop) void tgSend(`🛑 <b>บอทหยุดแล้ว</b>
${esc(reason)}
เหวี่ยง ${casts} · ติดปลา ${sessCatches}${earned > 0 ? ` · ขายได้ ${earned.toLocaleString()} 🪙` : ''}
💵 รอบนี้: กำไร ${signed(sessNet())} 🪙 (ปลา ${sessRev.toLocaleString()} − เหยื่อ ${sessBait.toLocaleString()})
📈 กำไรสุทธิสะสม <b>${signed(lifeNet())}</b> 🪙 (หักต้นทุนครบ)`);
  }

  function tick() {
    // 🎣 โหมด gameauto: บอทเป็นคนคุมสวิตช์ auto ของเกม — ต้อง "หยุด" มันทันทีเมื่อบอทกำลังทำอย่างอื่น
    //   (busy=เปิดร้าน/ขาย · พักพลัง · พักชั่วคราว · ทดสอบ · ปิดบอท) เพื่อกันชนกัน แล้วค่อยเปิดใหม่ในสาขา idle
    // หยุด auto เกมเมื่อ: (ก) โหมดที่มีผลตอนนี้ไม่ใช่ gameauto (เช่น รอบทดสอบ bot) หรือ (ข) กำลังทำงานอื่น (busy/พัก/ปิดบอท)
    //   ใช้ fishModeEff เพราะระหว่างทดสอบ 2 โหมด รอบ gameauto ต้องปล่อยให้ auto รัน (ไม่ force-stop เพราะ testRunning)
    if (gameAutoRunning() &&
        (fishModeEff() !== 'gameauto' || busy || orchestrating || paused || energyResting || !enabled)) {
      stopGameAuto();
    }
    // 📊 โหมด gameauto เท่านั้น: อ่านผลตกจาก React state (เกม auto ไม่มี popup DOM) — poll ~100ms กันพลาดหน้าต่างผล ~1วิ
    //   ⚠️ v6.88: เดิมรันทุกโหมดยกเว้น off → โหมด bot บันทึกซ้ำ (pushCatch อ่าน popup + pollGameCatches อ่าน React = นับ 2 เท่า!)
    //   โหมด bot มี popup DOM (readCatch ได้คะแนนด้วย) จึงใช้ pushCatch อย่างเดียว · gameauto ไม่มี popup จึงใช้ poll นี้
    if (fishModeEff() === 'gameauto' && enabled && !busy && !orchestrating && now() - lastGameCatchPoll > 100) {
      lastGameCatchPoll = now();
      pollGameCatches();
    }
    // 👹 เฝ้าบันทึกบอส — v6.109: ทำงาน "แม้บอทปิด" (เป็นแค่การอ่านสถานะ ปลอดภัย · ไม่กระทำใดๆ)
    //   v6.111: ตอนมีบอส (context) จับถี่ 350ms (เกจหมุนเร็ว 1 วิพลาด) · แมพปกติ 1.2 วิ (ประหยัด)
    if (now() - lastBossObs > (bossObsHot ? 350 : 1200)) { lastBossObs = now(); bossObserve(); }
    if (enabled && !busy && !orchestrating) {
      // 👹 v6.138: เช็ค "ยึดถ้ำบอส" ก่อนคิดตกปลา — ถ้ำบอสมีบ่อตกปลาด้วย บอสโผล่มาบอทต้องตีทันที ไม่ใช่ตกปลาแทน
      //   บั๊ก: เดิมเช็คนี้อยู่ในสาขา idle (เข้าถึงเฉพาะตอนว่าง) → บอทตกปลารัวจนแทบไม่ได้ยิง = บอสมา 110 วิ ตกปลาเฉยๆ
      if (isOn('bossHunt') && bossPhase === 'idle' && now() - lastBossHereChk > 800) {
        lastBossHereChk = now();
        if (bossMapId() === BOSS_MAP && (raidBossState() || {}).present) { void bossFightHere(); return requestAnimationFrame(tick); }
      }
      const state = gameState();
      if (state !== 'bite') biteAt = 0;      // ออกจากจังหวะปลาฮุบ = ล้างตัวจับเวลารีแอค
      if (state !== 'idle') castArmed = false;   // กำลังตกอยู่ = ยังไม่ถึงจังหวะตั้งเวลาเหวี่ยง
      // ⏸ พักชั่วคราว — v6.192 แก้ "พักแล้วไม่หยุด" · v6.197 (ผู้ใช้เจอสด) ปรับ "แรงไป": เดิม return ทุก state
      //   รวมตอนกำลังดึงปลา → ทิ้งปลากลางคัน (เสียเหยื่อ+ปลา) · ที่ถูกคือ "ดึงตัวที่ค้างให้จบก่อน แล้วค่อยหยุด"
      //   หยุดจริงเฉพาะตอน "ว่าง/รอปลากิน (ยังไม่มีปลาติดเบ็ด)" — ตอนฮุบ/เกจ/ชักเย่อ/สู้/ผล ปล่อยให้ state machine จบเอง
      //   ไม่เหวี่ยงใหม่แน่นอน (สาขา idle บล็อก paused อยู่แล้ว) · หยุด auto เกมกันมันเหวี่ยงเอง
      if (paused) {
        if (gameAutoRunning()) stopGameAuto();
        if (state === 'idle' || state === 'waiting') {   // ว่าง/รอปลา = จุดหยุดที่ปลอดภัย (ไม่มีปลาให้ทิ้ง)
          if (orbHeld) orbUp(null);
          updateBadge();
          return requestAnimationFrame(tick);
        }
        // มิฉะนั้น: ปลาติดเบ็ด/มินิเกมกำลังเล่น → ตกให้จบ (ไม่ return) แล้วรอบถัดไปพอ idle ค่อยหยุด
      }

      // เกมขยับแล้ว = การกดตกปลาครั้งล่าสุดติด
      if (pendingCast && state !== 'idle') {
        pendingCast = 0;
        failedCasts = 0;
        bagFullTries = 0;   // เหวี่ยงติดแล้ว = กระเป๋าไม่เต็มแล้ว
        casts++;
        exploreTick(currentBait()?.tier ?? lastKnownBaitTier);   // 🔬 v6.207/6.212: นับเฉพาะครั้งที่ตกด้วยขั้นสำรวจจริง
        pushCastCost();     // คาสต์เข้าน้ำจริง = ใช้เหยื่อ 1 ชิ้น (คิดต้นทุนที่นี่ ไม่ใช่ตอนอ่านผล)
        lastProgressAt = now();
        clearPersistedBreak();   // ตกได้ = ไม่ได้พักอยู่ ล้างพักที่จำไว้
        try { W.localStorage.removeItem('tokpla_bot_reload_count'); } catch {}   // ตกได้ = หายค้างแล้ว
        updateBadge();
        if (cfg.tgEvery > 0 && casts % cfg.tgEvery === 0) {
          void tgSend(`📊 ตกไปแล้ว <b>${casts}</b> ครั้ง${earned > 0 ? ` · ขายได้ ${earned.toLocaleString()} 🪙` : ''} · กำไรสุทธิสะสม ${signed(lifeNet())} 🪙`);
        }
      }

      if (state !== 'tug' && orbHeld) orbUp(null);            // ออกจากชักเย่อ = ปล่อยปุ่มเสมอ (กันค้าง)
      if (state !== 'gauge' && state !== 'tug') { resetGaugeTracking(); tugPrevBox = null; }

      if (state === 'bite') {
        // ปลาฮุบ! โหมดปกติกดทันที (hook เต็ม) · โหมดมนุษย์หน่วงตามเวลารีแอคที่สุ่มไว้
        // ⚠️ เฉพาะโหมด 'bot' เท่านั้นที่บอทตอบสนองเอง — โหมด gameauto ปล่อยให้ระบบ auto ของเกมจัดการ (กันกดชนกัน)
        resetRound();
        zoneKey = null;
        if (fishModeEff() === 'bot') {
          traceHook();   // ปลากิน = เริ่มจับเวลาตวัด
          if (hOn('hReact') && !turboEff()) {   // ⚡ turbo = ตวัดทันที ไม่หน่วงรีแอค (ไม่เกี่ยวความแม่นเกจ)
            if (!biteAt) { biteAt = now(); biteReact = sampleReact(); }
            if (now() - biteAt >= biteReact) pressSpace();
          } else {
            pressSpace();
          }
        }
      } else if (state === 'gauge') {
        // 🎯 เกจวงล้อ: ดาวที่ 0° · เข็มเกิด ~2° กวาดขึ้น ~0.27°/ms · วน 1 รอบ ~1340ms (หมุนไม่รู้จบจนกว่าจะกด)
        // ⚡ v6.135 (ผู้ใช้สั่งตัด "รอครบรอบ"): กด "รอบแรก" ทุกครั้งที่เฟรมทัน — เข็มอยู่ในดาวแค่ ~22ms หลังเกิด
        //   (0.27°/ms × โซนดาว 8° — เร็วกว่า 1-2 เฟรม) → กดรอบแรกได้เฉพาะเฟรมที่จับทัน = โอกาสฟรี ประหยัด ~1.3 วิ
        //   จับไม่ทัน (ส่วนใหญ่) → รอเข็มวนกลับมาลงดาวเหมือนเดิม (fallback — ความแม่นไม่ลดทุกกรณี)
        resetRound(); zoneKey = null;
        const w2 = wheelCache || readGaugeWheel();
        traceHook();   // เผื่อ trace ยังไม่ได้เซ็ต hook (เข้าเกจแปลว่าตวัดติดแล้ว)
        if (!gaugeDone && w2 && w2.ang != null) {
          const ang = w2.ang, nowMs = now();
          if (!gaugeStartMs) {
            gaugeStartMs = nowMs;
            // โหมดมนุษย์ hMiss: บางครั้งจงใจ "พลาดดาว" (กดในแดงแต่เลยดาว) — คนจริงไม่โดนดาว 100%
            gaugeMiss = hOn('hMiss') && !turboEff() && Math.random() * 100 < cfg.missChance;   // ⚡ turbo = ไม่จงใจพลาดดาว (ความแม่นสูงสุด)
          }
          if (ang > 150 && ang < 350) gaugeSwept = true;   // เข็มผ่านครึ่งหลังของวง = กำลังจะครบรอบ (ผ่านจุดเกิดมาแล้ว)
          const rev = Math.floor((nowMs - gaugeStartMs) / 1340) + 1;   // รอบที่เท่าไร (ไว้ log)
          const inStar = ang >= 0 && ang <= GAUGE_STAR_DEG;            // 0..8° = ในแดงด้วย + ในดาวด้วย
          const inRed = ang >= w2.a0 && ang <= w2.a1;
          const bail = nowMs - gaugeStartMs > 4000;   // safety: รอเกิน ~3 รอบยังไม่ได้จังหวะ → กดตอนอยู่ในแดง กันเสียปลา
          // กดรอบแรก: เข็มยังในดาว + เพิ่งเกิด (<250ms กันเข้าใจผิดกับรอบท้ายๆ) — เฉพาะโหมดไม่จงใจพลาด
          const firstPassStar = !gaugeSwept && inStar && nowMs - gaugeStartMs < 250 && !gaugeMiss;
          const wantPress = firstPassStar || (gaugeSwept && (gaugeMiss ? (inRed && !inStar) : inStar));
          if (wantPress || (bail && inRed)) {
            const orbEl = qBtn('ตกปลา (F)');
            if (orbEl && !orbEl.disabled) { fireClick(orbEl); gaugeDone = true; recordGaugePress(ang, firstPassStar ? 0 : rev); }
          }
        }
      } else if (state === 'fight') {
        // 💪 ปลาสู้ (orb "🔥"): กดรัว — v6.135 เร่งเป็น ~35-60ms/กด (จาก 45-85) · เฟส "สู้" progress ผูกกับจำนวนกด
        //   → กดถี่ขึ้น = จบเฟสเร็วขึ้นตรงๆ (~0.5-0.8 วิ/ตัว) · ยังสุ่ม jitter ไม่ยิงทุกเฟรมเป๊ะ
        resetRound(); zoneKey = null;
        if (now() - lastFightTap > 35 + Math.random() * 25) {
          lastFightTap = now();
          const orbEl = qBtn('ตกปลา (F)');
          if (orbEl && !orbEl.disabled) { fireClick(orbEl); if (fishTrace) fishTrace.fightTaps++; }
        }
      } else if (state === 'tug') {
        // 🐟 ชักเย่อ: คุมกรอบให้คลุมปลา — กรอบมีแรงเฉื่อยสูง ใช้ PD: ทำนายตำแหน่งล่วงหน้าจากความเร็ว (จูนจากทดสอบสด)
        resetRound(); zoneKey = null;
        const tg = tugCache || readTugState();
        if (tg) {
          if (fishTrace) { if (fishTrace.tugStart == null) fishTrace.tugStart = now(); fishTrace.tugEnd = now(); const pg = (document.body.innerText.match(/ดึงขึ้นมาแล้ว\s*(\d+)/) || [])[1]; if (pg) fishTrace.tugProg = +pg; }
          const boxC = tg.boxB + tg.boxH / 2;
          const nowMs = now();
          if (tugPrevBox !== null && nowMs > tugPrevT) {
            const dt = (nowMs - tugPrevT) / 1000;
            tugVBox = 0.6 * tugVBox + 0.4 * ((boxC - tugPrevBox) / dt);        // EMA กัน noise
            tugVFish = 0.6 * tugVFish + 0.4 * ((tg.fishPct - tugPrevFish) / dt);
          }
          tugPrevBox = boxC; tugPrevFish = tg.fishPct; tugPrevT = nowMs;
          const predBox = boxC + tugVBox * 0.22;          // กรอบเฉื่อยสูง มองล่วงหน้า 220ms
          const predFish = tg.fishPct + tugVFish * 0.08;  // ปลาเปลี่ยนทิศบ่อย มองสั้น
          const orbEl = qBtn('ตกปลา (F)');
          if (predBox < predFish) orbDown(orbEl); else orbUp(orbEl);
        }
      } else if (state === 'minigame') {
        // ⚠️ เฉพาะโหมด 'bot' ที่บอทเล็ง/กดเกจเอง — โหมด gameauto ปล่อยให้เกมจัดการ (แต่ยังนับเป็น "กำลังตก" ไม่ตกไปสาขา idle)
        if (fishModeEff() !== 'bot') {
          resetRound(); zoneKey = null;
        } else {
        const g = barCache || findBar();   // ใช้ผลที่ gameState() หามาแล้วในเฟรมเดียวกัน
        const m = g.marker.getBoundingClientRect();
        const z = g.zone.getBoundingClientRect();
        const pos = m.left + m.width / 2;

        const key = Math.round(z.left * 10);
        if (key !== zoneKey) {
          zoneKey = key;
          resetRound();
          aimPx = planAim(g);
          roundAt = now();
        }

        // กันค้าง: ถ้ากดไปแล้วแต่ผ่าน 2.5 วิ เกมยังไม่ขึ้นรอบใหม่ แปลว่าการกดไม่ติด — ตั้งลำใหม่
        if (!armed && now() - roundAt > 2500) {
          resetRound();
          aimPx = planAim(g);
          roundAt = now();
        }

        if (armed && aimPx !== null && prevPos !== null) {
          const vel = pos - prevPos;
          if (Math.abs(vel) > MAX_JUMP_PX) {
            prevPos = pos;                      // เข็มถูกดีดกลับจุดเริ่ม — ข้ามเฟรมนี้
          } else {
            // เกมอ่านตำแหน่งเข็มจากเฟรมล่าสุด จึงเลือกกดในเฟรมที่ใกล้จุดเล็งที่สุด
            const distNow = Math.abs(aimPx - pos);
            const distNext = Math.abs(aimPx - (pos + vel));
            if (distNow <= distNext) {
              pressSpace();
              armed = false;
            }
            prevPos = pos;
          }
        } else {
          prevPos = pos;
        }
        }   // ปิด else (โหมด bot)
      } else if (state === 'result') {
        // popup โชว์ปลาที่ได้ — ต้องกด "ตกต่อ!" ไม่งั้นค้างตรงนี้ตลอดไป
        resetRound();
        zoneKey = null;

        // อ่านปลาที่ได้ก่อนปิด popup (ปิดแล้วข้อมูลหายทันที) — ไว้แจ้งเตือนปลาน่าสนใจ
        // สาขานี้ = popup ผลใน DOM (โหมด bot / กลไกเก่า) — โหมด gameauto เก็บสถิติผ่าน pollGameCatches() แล้ว
        // ⚠️ v6.88: โหมด gameauto ห้าม pushCatch ที่นี่ (กันนับซ้ำกับ pollGameCatches) — แค่ปิด popup ด้านล่างพอ
        if (!catchNotified && fishModeEff() !== 'gameauto') {
          catchNotified = true;
          const c = readCatch();
          if (c) {
            const rec = pushCatch(c);   // บันทึกสถิติ per-cast — คืนสถานะจริง (ขั้นเหยื่อ+ยา) ที่ใช้บันทึกตัวนี้
            if (testRunning) {
              // 🧪 นับเข้ารอบทดสอบ (รอบ bot) เฉพาะ "ตัวที่บันทึกจริง" + เหยื่อตรงขั้น + สถานะยาตรงรอบ (buff=มีทั้งคู่ · plain=ไม่มีเลย)
              // ใช้ค่าจาก rec (การอ่านครั้งเดียวกับตอนบันทึก) — รับประกันว่า "ตัวที่นับ = ตัวที่ติดแท็กตรงเงื่อนไข" เป๊ะ
              if (rec && test && test.mode === 'bot' && rec.tier === test.tier) {
                const both = rec.weight && rec.luck, none = !rec.weight && !rec.luck;
                if (test.buff ? both : none) test.count++;
              }
            } else if (isOn('tgOn')) {
              const why = catchWorthNotifying(c);
              if (why) {
                const unit = baitUnit(currentBait()?.tier || lastKnownBaitTier || cfg.baitTier);   // ราคาเหยื่อ/ชิ้นที่ใช้ตกตัวนี้
                const net = (c.price || 0) - unit;                            // กำไรสุทธิตัวนี้ (หักต้นทุนเหยื่อ)
                void tgSend(
                  `🎣 <b>${esc(c.name)}</b>
` +
                  `${why.join(' · ')}
` +
                  `น้ำหนัก ${c.weight} กก.${c.price ? ` · ขายได้ ${c.price.toLocaleString()} 🪙 · กำไรสุทธิ ${signed(net)} 🪙 (หักเหยื่อ ${unit})` : ''}
` +
                  `คะแนน ${c.score}/100 · ตกไปแล้ว ${casts} ครั้ง`
                );
              }
            }
          }
        }

        // ปิด popup: กลไกใหม่มีปุ่ม "เก็บปลา" · เก่าเป็น "ตกต่อ!" (ทำทุกโหมด เพื่อให้ gameauto เก็บสถิติจาก popup ได้ด้วย)
        const cont = btnByText('ตกต่อ!') || btnByText('เก็บปลา');
        if (cont && now() - lastCast > (turboEff() ? 180 : 300)) {   // v6.135: turbo ปิด popup ผลไวขึ้น (~0.12 วิ/ตัว)
          lastCast = now();
          fireClick(cont);
        }
      } else if (state === 'waiting' || state === 'reeling') {
        // ทุ่นลอยรอปลากิน / กำลังส่งผลไปเซิร์ฟเวอร์ — ห้ามแตะอะไรทั้งนั้น
        resetRound();
        zoneKey = null;
        catchNotified = false;   // รอบใหม่ พร้อมแจ้งปลาตัวถัดไป
        lastCast = now();     // เลื่อนคูลดาวน์ออกไป กันเผลอกดตกปลาซ้ำทันทีที่จบ
      } else {
        // ---- ว่างจริงๆ ----
        resetRound();
        zoneKey = null;

        // งานฝั่ง idle ไม่ต้องละเอียดระดับเฟรม (เหวี่ยงมี gate ≥900ms อยู่แล้ว) — เช็คทุก ~150ms พอ
        // ลด CPU มาก: ตัด querySelector หนักๆ (ปุ่ม/พลัง/เหยื่อ/กล่องเตือน) จาก 60 → ~7 รอบ/วิ
        if (now() - lastIdleWork < 150) return requestAnimationFrame(tick);
        lastIdleWork = now();

        // พักชั่วคราว (สั่งเอง/ผ่าน Telegram) — ยังเปิดบอทอยู่ แค่ไม่เหวี่ยงตัวใหม่
        if (paused) { updateBadge(); return requestAnimationFrame(tick); }

        // 🛡️ v6.218: ยามเฝ้าป๊อบอัพค้างทั่วไป — "ควรตกได้แต่ตกไม่ได้เพราะมี dialog ค้าง ≥3 วิ" → เคลียร์อัตโนมัติ
        //   จุดเดียวคุมทุกฟีเจอร์ (หีบ/รางวัล/error) แทนการไล่แก้ทีละป๊อบอัพ · ไม่แตะหน้าต่างรับรางวัล (auto-claim จัดการ)
        if (popupWatchdog()) return requestAnimationFrame(tick);

        // 👹 บอส = สำคัญกว่าตกปลา · ต้องเช็ค "ก่อน" สาขา "ปุ่มตกปลากดไม่ได้" ด้านล่าง
        //   บั๊ก v6.118 (bot.log): ในถ้ำบอสปุ่มตกปลาถูกปิดตลอด → โค้ดไป early-return ที่สาขานั้น →
        //   bossHuntDue/ตีบอส/หนีออกถ้ำ ไม่มีวันได้รัน = บอสโผล่ก็ไม่ตี (ตกปลาเปล่าๆ), บอสตายก็ค้างในถ้ำ
        if (bossHuntDue()) { void runBossHunt(); return requestAnimationFrame(tick); }
        // (👹 v6.138 ย้ายเช็ค "ตีบอสในถ้ำ" ขึ้นไปบนสุดของ tick แล้ว — ก่อนตกปลา ไม่งั้นถ้ำบอสมีบ่อ บอทตกปลาแทนตี)
        // ติดอยู่ในถ้ำบอส (ไม่มีบอส/ไม่ได้กำลังล่า) → เดินออกไปฟาร์มต่อ (กันตกไม่ได้+รีโหลดวน)
        if (now() > lastBossEscapeAt && now() - lastBossEscapeAt > 15000 && strandedInBossCave()) {
          lastBossEscapeAt = now(); void escapeBossCave(); return requestAnimationFrame(tick);
        }
        // 🏪 v6.150: ระบบ NPC เมืองประมง — ถึงเกณฑ์ปลา (ระดับ+จำนวน) → ไปฝากลุงคลัง/แลกยายแก่น แล้วกลับ (self-throttle เปิดกระเป๋านับทุก 2 นาที)
        void npcErrandCheck();

        // 🛡️ v6.217: กันหน้าต่างหีบ (รางวัล/คูลดาวน์) ค้างบังจอหลังจบทริป → ตกปลาต่อไม่ได้ (บั๊ก v6.216)
        //   จำกัดเฉพาะ ~60 วิ หลังเพิ่งไปเก็บหีบ (กันเผลอปิด dialog อื่นที่บังเอิญมีปุ่ม "ปิด" เหมือนกัน)
        if (isOn('grabChest') && !orchestrating && now() - lastChestRunAt < 60000 && chestCloseBtn()) { closeChestDialog(); return requestAnimationFrame(tick); }
        // 🎁 v6.216: เก็บหีบสมบัติที่โผล่ในแมพเป็นระยะ (opt-in) — ลำดับต่ำสุด (หลังบอส/เมือง) · self-throttle chestCheckMin นาที
        if (chestGrabDue()) { void runChestGrab(); return requestAnimationFrame(tick); }

        // 🎣 v6.219: ตัวละครไม่ได้อยู่ริมบ่อ (รีโหลด/เก็บหีบ/กลับจากบอส) → เดินกลับบ่อก่อน ไม่งั้นไม่มี orb ตกปลา = ยืนนิ่ง
        if (walkToPondIfNeeded()) { updateBadge(); return requestAnimationFrame(tick); }

        // 🌈 โหมดล่าปลาเทพ — no-loss gate + เรียนรู้ชื่อ↔id แมพ + ย้ายไปแมพสถิติดีสุด (บอสสำคัญกว่า จึงอยู่หลังเช็คบอส)
        if (mythicActive()) {
          if (!mythicStartAt) {
            mythicStartAt = now(); mythicNetPrev = null;
            say('🌈 เริ่มล่าปลาเทพ — เหยื่อถูกสุด + ตกถี่สุด + ยา + เลือกแมพจากสถิติจริง (ดู /mythic)');
            if (isOn('tgOn') && isOn('tgStart')) void tgSend('🌈 <b>เริ่มโหมดล่าปลาเทพ</b> — ตกถี่สุด + เลือกเหยื่อ/แมพจากสถิติจริง + กันขาดทุน (no-loss gate) · เช็ค /mythic');
          }
          learnMapName();
          mythicGateTick();
          const mv = mythicMoveDue();
          if (mv) { void runMythicMove(mv.id, mv.name); return requestAnimationFrame(tick); }
        } else if (mythicStartAt) { mythicStartAt = 0; mythicNetPrev = null; mythicStrikes = 0; mythicPotOff = false; }

        const castBtn = qBtn('ตกปลา (F)');

        // (4) ปุ่มตกปลาถูกปิดได้ 2 กรณี (เกมเขียนว่า disabled: !m || _)
        //     m = อยู่ใกล้บ่อไหม (มาจาก event near-pond) · _ = โหมดตกอัตโนมัติของเกมเปิดอยู่
        // เฉพาะโหมด 'bot' ที่ต้องมีปุ่มกดได้จริง (เหวี่ยงเอง) — โหมด gameauto/off ปุ่มถูกปิดเป็นเรื่องปกติ
        //   (gameauto: เกมกำลัง auto ตก · off: ไม่ตกอยู่แล้ว) จึงไม่ต้อง early-return ให้ไหลไปทำระบบรอบข้าง
        if (fishModeEff() === 'bot' && (!castBtn || castBtn.disabled)) {
          if (!awayAt) awayAt = now();
          else if (now() - awayAt > 5000) {
            awayAt = now();
            say(gameAutoRunning()
              ? 'โหมดตกอัตโนมัติของเกมเปิดอยู่ — ปิดก่อนนะ (โหมดบอทต้องเหวี่ยงเอง)'
              : 'ปุ่มตกปลากดไม่ได้ — เดินไปใกล้บ่อก่อน 🎣');
          }
          return requestAnimationFrame(tick);
        }
        if (fishModeEff() === 'bot') awayAt = 0;
        if (pauseUntil <= now()) pauseNotified = false;
        // (👹 เช็คบอส/ล่า/หนีถ้ำ ย้ายขึ้นไปก่อนสาขา "ปุ่มตกปลากดไม่ได้" แล้ว — ดู v6.119)

        // ☕ ซื้อกาแฟเติมพลังก่อนถึงจุดพัก (เพื่อตกต่อเนื่อง 24 ชม.) — เก็บเควสก่อน ไม่พอค่อยซื้อ
        // ทำก่อน energyManage: พอเติมแล้วพลังเด้งเกินจุดพัก → ไม่ต้องนั่งพักเลย
        // 🎒 v6.194: เปิดเมื่อ "ซื้อกาแฟ" หรือ "ใช้ของในกระเป๋า" อย่างใดอย่างหนึ่ง — ให้ใช้กาแฟฟรีได้แม้ปิดการซื้อ
        if ((isOn('buyCoffee') || isOn('useBagConsumables')) && !busy && !pendingCast && !energyResting && now() > coffeeFailUntil) {
          const ec = energyPct();
          if (ec !== null && ec <= cfg.coffeeAtEnergy) {
            void sustainEnergy();
            return requestAnimationFrame(tick);
          }
        }

        // 🧪 ต่ออายุยาบัฟเมื่อหมด (เช็คทุก 60 วิ · ซื้อเฉพาะตอนรายได้ถึงเกณฑ์คุ้ม/Advisor อนุมัติ)
        // 🌈 v6.129: แยกยาโหมดล่าปลาเทพ/ยาหลักขาดกัน — อยู่โหมด = ยึดสวิตช์โหมด (mythicWeight/Luck) เท่านั้น · ยาหลักต้อง isOn('buyPotion')
        //   v6.132: ตอน mythicPotOff (gate สั่งงดยา) = ไม่มียาเลย — เดิมตกไปสาขายาหลัก ยารั่วกลับมาทั้งที่สั่งงด
        const mytOn = mythicActive();
        // 🎒 v6.194: เปิดทางเมื่อ "ซื้อยา" หรือ "ใช้ของในกระเป๋า" — ให้ใช้ยาฟรีในกระเป๋าได้แม้ปิดการซื้อ
        const potGate = mytOn
          ? (!mythicPotOff && (isOn('mythicWeight') || isOn('mythicLuck')))
          : ((isOn('buyPotion') || isOn('useBagConsumables')) && (isOn('potionWeight') || isOn('potionLuck')));
        if (potGate && !testRunning && !busy && !pendingCast && !energyResting && now() > potionFailUntil && now() - lastPotionCheck > 60000) {
          lastPotionCheck = now();
          const b = readBuffs();
          const needW = (mytOn ? isOn('mythicWeight') : isOn('potionWeight')) && !b.weight;
          const needL = (mytOn ? isOn('mythicLuck')   : isOn('potionLuck'))   && !b.luck;
          if (needW || needL) {
            void buyPotions();
            return requestAnimationFrame(tick);
          }
        }

        // ✉️ เก็บจดหมายของขวัญ (ตามรอบที่ตั้ง)
        if (isOn('autoMail') && !busy && !pendingCast && !energyResting && now() - lastMailCheck > cfg.mailEvery * 60000) {
          lastMailCheck = now();
          void claimMail();
          return requestAnimationFrame(tick);
        }

        // 🧠 Advisor วิเคราะห์ทุก 5 นาที (แนะนำ/ลงมือตามโหมด · เว้นตอนทดสอบ)
        if (isOn('advisor') && !testRunning && !busy && !pendingCast && now() - lastAdvisorAt > 300000) {
          lastAdvisorAt = now();
          try { advisorTick(); } catch (e) { logErr('Advisor ล้มเหลว', e); }
        }

        // 🧪 กำลังใช้ยาบัฟอยู่ → ห้ามพัก/นั่งพัก (ยาอยู่แค่ 30 นาที ต้องตกให้คุ้ม) · พึ่งกาแฟเติมพลังแทน
        // เช็ค buffActive() (สแกน DOM) เฉพาะเมื่อมีระบบพัก/พักย่อยเปิดอยู่จริง (ไม่งั้นไม่ต้องเสียแรงสแกน)
        const restBlocked = (cfg.energyManage || hOn('hSession') || hOn('hBreak')) && isOn('noRestOnBuff') && buffActive();

        // จัดการพลังงานเชิงรุก (hysteresis): พักเมื่อถึงเกณฑ์ล่าง กลับมาตกเมื่อฟื้นถึงเกณฑ์บน
        // พลังฟื้นเองตอนไม่ตก (~100%/3ชม.) — แค่หยุดตกก็พอ · "นั่งพัก" เป็นท่าทางเสริม
        if (cfg.energyManage) {
          const e = energyPct();
          if (e !== null) {
            const sitBtn = () => qBtn('นั่งพัก');
            if (!energyResting && e <= cfg.energyRestAt && !restBlocked) {
              energyResting = true;
              if (cfg.energySit && !energySat) { const b = sitBtn(); if (b) { fireClick(b); energySat = true; } }
              say(`⚡ พลังเหลือ ${Math.round(e)}% — นั่งพักจนถึง ${cfg.energyResumeAt}%`);
              if (cfg.tgPause) void tgSend(`⚡ พลังเหลือ ${Math.round(e)}% — บอทพักรอถึง ${cfg.energyResumeAt}% (ตกไปแล้ว ${casts} ครั้ง)`);
            } else if (energyResting && e >= cfg.energyResumeAt) {
              energyResting = false;
              if (energySat) { const b = sitBtn(); if (b) fireClick(b); energySat = false; }   // ลุกขึ้น (ปุ่มเดียวสลับนั่ง/ลุก)
              say(`⚡ พลังฟื้นถึง ${Math.round(e)}% — ตกต่อ`);
              lastCast = now();   // รอ animation ลุกก่อนค่อยเหวี่ยง
            }
            if (energyResting) {
              // ระหว่างนั่งพัก (พลังต่ำ) เป็นจังหวะที่ดีที่สุดในการเก็บเควส — รางวัลพลังงานช่วยให้ฟื้นถึงเกณฑ์เร็วขึ้น
              // (บล็อกเควสปกติอยู่หลัง return นี้ จึงต้องเรียกตรงนี้ด้วย ไม่งั้นตอนพักจะไม่เก็บเควสเลย)
              if (cfg.autoQuest && !busy && now() - lastQuestCheck > cfg.questEvery * 60000) {
                lastQuestCheck = now();
                void runQuests();
              }
              // ☕ v6.209 (ผู้ใช้ส่งคลิป "เหมือนค้าง"): เดิมทางกาแฟถูก guard ด้วย `!energyResting`
              //   → พอเริ่มพักแล้ว **กาแฟถูกล็อกตายจนจบการพัก** · เคสจริง: พัก 6%→40% = ฟื้น ~0.55%/นาที ≈ **62 นาทีที่ไม่ได้ตกเลย**
              //   ทั้งที่กาแฟ +50 พลัง จบการพักได้ทันที (ราคา 1,500 🪙 เทียบเวลาที่เสีย ~26,000 🪙 = คุ้มมาก)
              //   ตอนนี้ระหว่างพักก็ลองกาแฟได้ (ใช้ของในกระเป๋าก่อนเสมอ · เคารพคูลดาวน์/ลิมิตวันเหมือนเดิม)
              if ((isOn('buyCoffee') || isOn('useBagConsumables')) && !busy && !pendingCast
                  && now() > coffeeFailUntil && now() - lastRestCoffeeAt > 60000) {
                lastRestCoffeeAt = now();
                void buyCoffee();
              }
              updateBadge();
              return requestAnimationFrame(tick);
            }
          }
        }

        // (1)(2)(3) เกมบอกเหตุผลไว้ในกล่องเตือนอยู่แล้ว — อ่านแล้วแก้ให้ตรงจุด
        const warn = warnText();
        if (warn && now() - warnAt > 4000) {
          if (/กระเป๋าเต็ม/.test(warn)) {
            warnAt = now();
            pendingCast = 0; failedCasts = 0;
            if (!isOn('sell')) {
              stopBot('กระเป๋าเต็ม 🎒 — เปิดระบบขายอัตโนมัติ หรือขายเอง');
            } else if (++bagFullTries > 2) {
              // 🏬 v6.165: ก่อนยอมแพ้ ลองระบายเข้า "คลังลุงคลัง/ยายแก่น" ก่อน — ปลาที่ล็อกไว้ขายไม่ได้ก็จริง แต่ฝาก/แลกได้
              //   เคสจริงที่ทำบอทตาย: เทสต์เหยื่อรันค้าง → testRunning บล็อก npcErrandCheck ตลอด → rare+ ไม่มีทางออก → เต็ม → หยุด
              //   (ยิ่งถ้าตั้ง "ล็อก rare+ ไม่ขาย" + ปิดยายแก่น + ฝากเฉพาะ legendary = rare/epic ไม่มีทางระบายเลย)
              // 🏬 v6.223: ถ้า "คลังเต็ม" (storageFullUntil) = การไปฝากจะไม่ช่วย → อย่าวนไปเมืองไม่จบ (อาการที่ผู้ใช้เจอ: ของเต็มแล้วบอทมีปัญหาทันที)
              const canEssence = isOn('npcEssenceOn');
              const canStorage = isOn('npcStorageOn') && now() >= storageFullUntil;
              if ((canEssence || canStorage) && !orchestrating && !busy) {
                bagFullTries = 0; lastNpcErrandAt = 0; lastNpcCheckAt = 0;   // ปลดคูลดาวน์ให้ไปเมืองได้ทันที
                say('🎒 กระเป๋าเต็ม (ปลาล็อกอยู่) — ไประบายเข้าคลัง/แลกแก่นที่เมืองประมงก่อน');
                // v6.169: เหตุการณ์ระดับ "เกือบหยุดบอท" ต้องแจ้ง TG (เดิมเงียบ — ผู้ใช้ไม่รู้ว่าเกือบตาย)
                if (isOn('tgOn') && isOn('tgWarn')) void tgSend('⚠️ <b>กระเป๋าเต็ม + ปลาถูกล็อกขายไม่ได้</b> — บอทกำลังไประบายเข้าคลังลุงคลัง/ยายแก่นเอง · ถ้าเกิดบ่อย ให้เช็คว่า "ระดับที่ฝาก/แลก" ครอบคลุมระดับที่ล็อกไม่ขายหรือยัง');
                void runTownErrands({ storage: canStorage, essence: canEssence });
              } else if (isOn('npcStorageOn') && now() < storageFullUntil && !canEssence) {
                // คลังเต็ม + ไม่มีทางระบายอื่น → หยุด + บอกให้ชัด (แทนวนไปเมืองฝากไม่ได้ไม่จบ)
                stopBot('กระเป๋าเต็ม + คลังลุงคลังเต็ม 🔒 ปลาที่เหลือขายไม่ได้ (ถูกล็อก) — แก้ได้ด้วย: ขยายคลัง / ปรับ "ระดับที่ฝาก" ให้แคบลง / เปิดแลกยายแก่น / หรือปลดล็อกปลาบางระดับให้ขายได้');
              } else {
                stopBot('กระเป๋าเต็มแต่ขายไม่ออก — ปลาในกระเป๋าถูกล็อกไว้หมด 🔒 (เปิดฝากลุงคลัง/แลกยายแก่น เพื่อให้บอทระบายเองได้)');
              }
            } else {
              lastCheck = casts;      // ถือว่าเช็ครอบนี้แล้ว
              void runSell(true);
            }
            return requestAnimationFrame(tick);
          }
          if (/ไม่มีเหยื่อ|เหยื่อหมด/.test(warn)) {
            warnAt = now();
            pendingCast = 0; failedCasts = 0;
            if (!testRunning) void handleNoBait();   // ทดสอบ = จัดการเหยื่อเอง (ไม่ให้ handleNoBait สลับไปขั้นอื่น)
            return requestAnimationFrame(tick);
          }
          if (/พลังหมด/.test(warn)) {
            warnAt = now();
            pendingCast = 0; failedCasts = 0;
            const epSec = hOn('hEnergy') ? randInt(cfg.energyPauseMinSec, cfg.energyPauseMaxSec) : 60;
            pauseUntil = now() + epSec * 1000;   // พลังฟื้นเองเรื่อยๆ — พักแล้วกลับมาลองใหม่
            updateBadge();
            say(`⚡ พลังหมด — พัก ${epSec} วิแล้วลองใหม่ (ตอนนี้ ${energyPct() ?? '?'}%)`);
            if (cfg.tgPause && !pauseNotified) {
              pauseNotified = true;   // พักซ้ำๆ ทุกนาที ไม่ต้องสแปมทุกครั้ง
              void tgSend(`⚡ พลังหมด — บอทพักรอพลังฟื้น (ตกไปแล้ว ${casts} ครั้ง)`);
            }
            return requestAnimationFrame(tick);
          }
        }

        // (2) กำลังพักรอพลัง — ยังเปิดบอทอยู่ แค่ไม่เหวี่ยง
        if (pauseUntil > now()) {
          updateBadge();
          return requestAnimationFrame(tick);
        }

        // โหมดมนุษย์: พักที่ค้างอยู่ต้องรอให้จบเสมอ (ไม่ว่าจะปิด feature ทีหลัง)
        if (breakUntil > now()) { updateBadge(); return requestAnimationFrame(tick); }
        // จำกัดเวลาต่อเซสชัน (ข้ามถ้ากำลังใช้ยา — ตกให้คุ้มก่อน)
        if (hOn('hSession') && sessionEndAt && now() >= sessionEndAt && !restBlocked) {
          if (cfg.sessionAction === 'stop') { stopBot('ครบเวลาเล่นต่อเซสชัน (โหมดมนุษย์)'); return requestAnimationFrame(tick); }
          const mins = randInt(cfg.sessionBreakMinMin, cfg.sessionBreakMaxMin);
          beginBreak(mins * 60000, 'พักยาว');
          sessionEndAt = breakUntil + randInt(cfg.sessionMinMin, cfg.sessionMaxMin) * 60000;
          say(`🛋️ พักยาวจบเซสชัน ${mins} นาที`);
          if (cfg.tgPause) void tgSend(`🛋️ พักยาว ${mins} นาที (จบเซสชัน) — ตกไปแล้ว ${casts} ครั้ง`);
          updateBadge(); return requestAnimationFrame(tick);
        }
        // พักใหญ่ / พักย่อย (ข้ามถ้ากำลังใช้ยา — เลื่อนจุดพักออกไปก่อน กันตกทิ้งช่วงยา)
        if (hOn('hBreak') && casts >= nextMacroAt && !restBlocked) {
          const mins = randInt(cfg.macroMinMin, cfg.macroMaxMin);
          beginBreak(mins * 60000, 'พักใหญ่');
          nextMacroAt = casts + Math.max(1, randInt(cfg.macroEvery * 0.7, cfg.macroEvery * 1.3));
          say(`☕ พักใหญ่ ${mins} นาที`);
          updateBadge(); return requestAnimationFrame(tick);
        }
        if (hOn('hBreak') && casts >= nextMicroAt && !restBlocked) {
          const sec = randInt(cfg.microMinSec, cfg.microMaxSec);
          breakUntil = now() + sec * 1000; breakLabel = 'พักย่อย';
          nextMicroAt = casts + Math.max(1, randInt(cfg.microEvery * 0.6, cfg.microEvery * 1.4));
          say(`😌 พักย่อย ${sec} วิ`);
          updateBadge(); return requestAnimationFrame(tick);
        }

        // กดตกปลาไปแล้วแต่เกมไม่ขยับเลย และไม่มีคำเตือนให้อ่าน = เหตุอื่น (เช่นเซสชันถูกแทนที่)
        if (pendingCast && now() - pendingCast > 2500) {
          pendingCast = 0;
          if (++failedCasts >= 3) {
            stopBot('กดตกปลาไม่ติด และเกมไม่บอกเหตุผล — ลองรีเฟรชหน้า');
            return requestAnimationFrame(tick);
          }
        }

        const bait = currentBait();
        // ระหว่างทดสอบ: ข้ามการจัดการเหยื่อ/เบ็ดของ tick ทั้งหมด — ระบบทดสอบคุมเหยื่อเอง (ไม่ให้เปลี่ยนขั้นมั่ว)
        if (!testRunning) {
          // 🪱 v6.193: โหมดไล่สต๊อก — ขั้นที่กำลังไล่หมดแล้ว → สแกนใหม่ (เลือกกองถัดไป/คืน Advisor) แทนที่จะซื้อมาเติม
          if (isOn('useBaitStock') && drainTier && bait && bait.tier === drainTier && (bait.stock === 0 || bait.stock == null)) {
            drainTier = 0; void scanDrainTier(); return requestAnimationFrame(tick);
          }
          // สแกนหากองใหญ่เมื่อยังไม่มีขั้นที่ไล่อยู่ (ทุก 5 นาที) — เปิดโหมดครั้งแรก/หลังไล่หมด · ตอนกำลังไล่ไม่ต้องรบกวน
          if (isOn('useBaitStock') && !drainTier && !mythicActive() && now() - lastDrainScan > 300000) { void scanDrainTier(); }
          // 🔬 v6.207: ถึงรอบสำรวจขั้นเหยื่อหรือยัง (ลำดับต่ำสุด — ไม่แย่งกับทดสอบ/ล่าปลาเทพ/ไล่สต๊อก)
          if (isOn('advExplore') && !exploreTier && !drainTier && !testRunning && !mythicActive()
              && now() - lastExploreAt > clamp(cfg.advExploreHours || 6, 1, 72) * 3600000) startExplore();
          // (3) เหยื่อขั้นที่ใช้อยู่หมดเกลี้ยง -> สลับไปขั้นที่ยังมีของก่อน ไม่ต้องรอให้กดพลาด
          if (bait && (bait.tier === null || bait.stock === 0) && !(needBuy && autoBuyEff())) {
            void handleNoBait();
            return requestAnimationFrame(tick);
          }
          // เหยื่อใกล้หมด -> แวะร้านซื้อ (needBuy = หมดเกลี้ยง ต้องข้ามคูลดาวน์ 20 วิ) · ระงับตอนไล่สต๊อก (autoBuyEff)
          if (autoBuyEff() && now() > baitBuyFailUntil && (needBuy || now() - lastBuyTry > 20000)) {
            const low = bait && bait.tier === targetBait() && bait.stock <= cfg.buyBelow;
            if (low || needBuy) {
              lastBuyTry = now();
              const forced = needBuy;
              needBuy = false;
              void sellThenBuy(forced);
              return requestAnimationFrame(tick);
            }
          }
          // ใช้เบ็ด/เหยื่อผิดขั้นอยู่ -> สลับให้ตรงก่อนเหวี่ยง (reuse bait ที่อ่านไว้แล้ว · อ่าน rod ครั้งเดียว)
          const rodNow = isOn('forceRod') ? currentRod() : null;
          // 🪱 v6.198: อย่าบังคับสลับไปขั้นที่เพิ่งพิสูจน์ว่า "ของหมด+ซื้อไม่ได้" (baitTargetBlocked) → ปล่อยตกด้วยขั้นที่มี
          if ((rodNow !== null && rodNow !== cfg.rodTier) ||
              (enforceBait() && !baitTargetBlocked() && bait?.tier != null && bait.tier !== targetBait())) {
            void ensureGear();
            return requestAnimationFrame(tick);
          }
        }

        // ถึงเวลาเก็บเควสรายวันไหม (รางวัลพลังงาน) — เฉพาะตอนพลังยังไม่ล้น
        if (cfg.autoQuest && now() - lastQuestCheck > cfg.questEvery * 60000) {
          const ep = energyPct();
          if (ep === null || ep < cfg.questMaxEnergy) {
            lastQuestCheck = now();
            void runQuests();
            return requestAnimationFrame(tick);
          }
        }

        // ถึงเวลาแวะเช็คกระเป๋าไหม (โหมด bot: อิงจำนวนครั้งที่ตก)
        if (isOn('sell') && casts > 0 && casts !== lastCheck && casts % Math.max(1, cfg.sellEvery) === 0) {
          lastCheck = casts;
          void runSell(false);
          return requestAnimationFrame(tick);
        }
        // โหมด gameauto/off: ตัวนับ casts ไม่ขยับ (เกมเป็นคนตก) → เช็คขายแบบอิงเวลาแทนทุก 90 วิ
        //   runSell(false) เช็คเกณฑ์ %/ชิ้น/มูลค่าในตัวเอง ไม่ถึงเกณฑ์ก็ปิดกระเป๋าเฉยๆ · กระเป๋าเต็มมี warn คุมอีกชั้น
        if (isOn('sell') && fishModeEff() !== 'bot' && now() - lastTimeSellAt > 90000) {
          lastTimeSellAt = now();
          void runSell(false);
          return requestAnimationFrame(tick);
        }

        // 🚫 โหมด off: ไม่ตกปลา — ทำแต่ระบบรอบข้าง (ขาย/ซื้อ/เควส/จดหมาย/พลังงาน) ที่ไหลผ่านมาแล้ว จบรอบ
        //   (fishModeEff: ระหว่างทดสอบเหยื่อบังคับ bot — สองบล็อกนี้ต้องไม่ return ไม่งั้นเทสต์ไม่ได้เหวี่ยง = deadlock v6.88)
        if (fishModeEff() === 'off') {
          if (gameAutoRunning()) stopGameAuto();   // กันเผลอเปิด auto เกมค้างไว้
          updateBadge();
          return requestAnimationFrame(tick);
        }

        // 🎮 โหมด gameauto: ให้ระบบ auto ของเกมเป็นคนตก (เกมย้ายกลไกไป canvas ที่บอทอ่านไม่ได้)
        //   บอทแค่คุมสวิตช์ให้ ON อยู่เสมอ แล้วปล่อยเกมทำงาน · ต่ออายุ lastProgressAt กัน recoveryWatch รีโหลดผิด
        if (fishModeEff() === 'gameauto') {
          if (gameAutoRunning()) {
            awayAt = 0;
            lastProgressAt = now();
          } else if (startGameAuto()) {
            awayAt = 0;
            lastProgressAt = now();
            if (now() - gameAutoSayAt > 600000) { gameAutoSayAt = now(); say('🎮 เปิดตกปลาอัตโนมัติของเกม'); }   // throttle 10 นาที (restart หลัง maintenance บ่อย)
          } else {
            // เปิด auto ไม่ได้ (ปุ่ม disabled) — น่าจะยังไม่อยู่ใกล้บ่อ → เตือนเป็นระยะ
            if (!awayAt) awayAt = now();
            else if (now() - awayAt > 8000) { awayAt = now(); say('เปิดตกปลาอัตโนมัติไม่ได้ — เดินไปใกล้บ่อก่อน 🎣'); }
          }
          updateBadge();
          return requestAnimationFrame(tick);
        }

        // ↓↓↓ โหมด 'bot' เท่านั้น: เหวี่ยง + เล่นมินิเกมเอง (แม่น เก็บสถิติละเอียด) ↓↓↓
        // ตั้งเวลาพักก่อนเหวี่ยงครั้งถัดไป (สุ่มต่อครั้งในโหมดมนุษย์ · โหมดปกติ = 900ms)
        if (!castArmed) { castArmed = true; gateStart = now(); castGate = sampleCastGap(); }

        if (!pendingCast && now() - gateStart >= castGate) {
          if (!testRunning && !cfg.loop && casts >= 1) {          // ทดสอบ = ตกต่อเนื่อง (ไม่หยุดตามลิมิต)
            stopBot('ครบ 1 ครั้ง');
          } else if (!testRunning && cfg.loop && cfg.limit > 0 && casts >= cfg.limit) {
            stopBot(`ครบ ${cfg.limit} ครั้งแล้ว`);
          } else if (sceneIsFishing() === null && now() - lastCast < 8000) {
            // Phaser อ่านไม่ได้ (degrade) → กลไกใหม่แยก "ว่าง" กับ "รอปลากิน" ไม่ออก
            // เว้นช่วงเหวี่ยงยาวขึ้น กันกดซ้ำไปยกเลิกสายที่ลอยอยู่ (บั๊กที่เจอตอนทดสอบสด)
          } else {
            lastCast = now();
            pendingCast = now();       // ยังไม่นับว่าสำเร็จ จนกว่าเกมจะเปลี่ยนสถานะ
            resetFishEngine(); traceCast();   // เริ่มบันทึกจังหวะของปลาตัวใหม่ + ล้างสถานะเอนจิน
            fireClick(castBtn);
          }
        }
      }
    }
    requestAnimationFrame(tick);
  }

  // ================= เฝ้าเหตุการณ์เกม -> แจ้ง Telegram =================
  // อ่านชิพบน HUD (tk-chip-dark) หา: เลเวลอัพ (chip ม่วง 4.2 วิ) · สภาพอากาศ ฝนตก/ปลาชุก
  // dedup: เลเวล = ตามเลข Lv · อากาศ = ตามชนิดที่เปลี่ยน
  let lastWeather = null, lastLevelUp = 0;
  function gameEventWatch() {
    if (!enabled) return;
    const chipEls = [...document.querySelectorAll('[class*="tk-chip-dark"]')];   // สแกนครั้งเดียว ใช้ทั้งแมพ+เลเวล+อากาศ
    const chips = chipEls.map((c) => c.textContent || '').join(' ¦ ');
    // 🗺️ แมพปัจจุบัน (อัปเดต curMap + แจ้งเมื่อเปลี่ยนแมพ)
    const mp = scanMap(chipEls);
    if (mp && mp !== curMap) {
      const prev = curMap; curMap = mp;
      if (prev) { say(`🗺️ เปลี่ยนแมพ → ${curMap}`); if (isOn('tgOn')) void tgSend(`🗺️ ย้ายแมพ: ${esc(prev)} → <b>${esc(curMap)}</b>`); }
      else say(`🗺️ แมพปัจจุบัน: ${curMap}`);
    }
    // เลเวลอัพ
    const m = /เลเวลอัพ[^]*?Lv\.\s*(\d+)/.exec(chips);
    if (m) {
      const lv = +m[1];
      if (lv > lastLevelUp) {
        lastLevelUp = lv;
        say(`🎉 เลเวลอัพ! Lv.${lv}`);
        if (isOn('tgOn') && isOn('tgLevel')) void tgSend(`🎉 <b>เลเวลอัพ! Lv.${lv}</b> — มีเบ็ด/เหยื่อขั้นใหม่ปลดล็อกที่ร้าน 🏪`);
      }
    }
    // สภาพอากาศ (ฝนตก/ปลาชุก = ปลากินไวขึ้น)
    const weather = /ฝนตก/.test(chips) ? 'rain' : /ปลาชุก/.test(chips) ? 'fever' : null;
    if (weather && weather !== lastWeather) {
      const msg = weather === 'rain' ? '🌧️ <b>ฝนตก</b> — ปลากินไวขึ้น! ช่วงนี้ตกได้ถี่' : '🔥 <b>ปลาชุก</b> — รีบตกเลย ปลากินไวสุด!';
      say(weather === 'rain' ? '🌧️ ฝนตก — ปลากินไวขึ้น' : '🔥 ปลาชุก!');
      if (isOn('tgOn') && isOn('tgWeather')) void tgSend(msg);
    }
    if (weather !== lastWeather) lastWeather = weather;   // อัปเดตทั้งตอนเริ่มและตอนหมด
  }

  // ================= UI =================

  function badgeText() {
    if (!enabled) return '🤖 บอท: ปิด (Alt+B)';
    if (paused) return `⏸ พักชั่วคราว — ตกไปแล้ว ${casts} (กด ⏸ หรือ /resume)`;
    if (pauseUntil > now()) {
      const sec = Math.ceil((pauseUntil - now()) / 1000);
      return `🤖 พักรอพลัง ⚡ ${sec} วิ — ตกไปแล้ว ${casts}`;
    }
    if (breakUntil > now()) {
      const ms = breakUntil - now();
      const disp = ms > 90000 ? `${Math.ceil(ms / 60000)} นาที` : `${Math.ceil(ms / 1000)} วิ`;
      return `🤖 ${breakLabel} ${disp} — ตกไปแล้ว ${casts}`;
    }
    if (energyResting) {
      const e = energyPct();
      return `🤖 นั่งพักรอพลัง ⚡ ${e != null ? Math.round(e) : '?'}% → ${cfg.energyResumeAt}% — ตกไปแล้ว ${casts}`;
    }
    const coin = earned > 0 ? ` · +${earned.toLocaleString()} 🪙` : '';
    // 🌈 ล่าปลาเทพอยู่ = บอกชัดบนป้ายหลัก (ผู้ใช้ต้องรู้ว่าโหมดไหนกำลังทำงาน — ไม่ใช่ฟาร์มปกติ)
    if (mythicActive()) return `🌈 ล่าปลาเทพ — ${casts} ตัว${coin}${mythicPotOff ? ' · งดยา(กำไรลบ)' : ''}`;
    // โหมด gameauto/off: ตัวนับ casts ของบอทไม่ขยับ (เกมเป็นคนตก/ไม่ตก) — แสดงสถานะโหมดแทน
    if (cfg.fishMode === 'off') return `🤖 บอท: เปิด (🚫 ไม่ตกปลา)${coin}`;
    if (cfg.fishMode === 'gameauto') {
      const n = casts > 0 ? ` · ${casts} ตัว` : '';
      return gameAutoRunning() ? `🤖 บอท: เปิด (🎮 เกมตกอัตโนมัติ${n})${coin}` : `🤖 บอท: เปิด (🎮 รอเปิด auto…)${coin}`;
    }
    const cap = cfg.loop ? (cfg.limit > 0 ? ` / ${cfg.limit}` : ' / ∞') : ' / 1';
    return `🤖 บอท: เปิด — ${casts}${cap}${coin}`;
  }

  let lastBadge = '';
  // 🌈 ปุ่มเริ่ม/หยุดล่าปลาเทพ — สร้างในแผง · refresh จาก updateBadge (จุดที่ถูกเรียกสม่ำเสมอ + มี guard ข้อความซ้ำ)
  let mythicBtn = null, lastMythicBtnTxt = '';
  function refreshMythicBtn() {
    if (!mythicBtn) return;
    const [txt, bg] = mythicActive()
      ? [`🌈 กำลังล่าปลาเทพ${mythicPotOff ? ' (งดยา — กำไรเพิ่งลบ)' : ''} — กดเพื่อหยุด`, '#3e7d24']
      : isOn('mythicHunt')
        ? ['🌈 เปิดไว้ · รอคิว (ทดสอบ/งานอื่นมาก่อน) — กดเพื่อหยุด', '#8a5a1e']
        : ['🌈 เริ่มล่าปลาเทพ', '#7d3ea0'];
    if (txt === lastMythicBtnTxt) return;
    lastMythicBtnTxt = txt;
    mythicBtn.textContent = txt;
    mythicBtn.style.background = bg;
  }
  // 👹 ปุ่มเริ่ม/หยุดล่าบอส — แยกจากปุ่มบอทตกปลาปกติ (v6.140) · สถานะสด: กำลังเดิน/สู้/รอเวลา/ปิด
  let bossBtn = null, lastBossBtnTxt = '';
  function refreshBossBtn() {
    if (!bossBtn) return;
    const [txt, bg] = bossPhase !== 'idle'
      ? [`👹 กำลังล่าบอส (${bossPhase === 'travel' ? 'เดินไปถ้ำ' : bossPhase === 'fight' ? 'สู้บอส' : 'กลับบ้าน'}) — กดหยุด`, '#3e7d24']
      : isOn('bossHunt')
        ? ['👹 โหมดล่าบอส เปิดอยู่ · รอเวลาบอส — กดเพื่อหยุด', '#8a5a1e']
        : ['👹 เริ่มล่าบอส', '#8a3030'];
    if (txt === lastBossBtnTxt) return;
    lastBossBtnTxt = txt;
    bossBtn.textContent = txt;
    bossBtn.style.background = bg;
  }
  function updateBadge(note) {
    refreshMythicBtn();
    refreshBossBtn();
    if (!btn) return;
    const text = note ? `🤖 หยุดแล้ว — ${note}` : badgeText();
    if (text === lastBadge) return;   // ตอนพักรอพลัง ฟังก์ชันนี้ถูกเรียกทุกเฟรม
    lastBadge = text;
    btn.textContent = text;
    btn.style.background = enabled ? ((paused || pauseUntil > now() || breakUntil > now() || energyResting) ? '#8a5a1e' : '#3e7d24') : '#b04a44';
  }

  function toggle() {
    enabled = !enabled;
    if (!enabled && testRunning) { saveTestProgress(); testRunning = false; }   // v6.155: ปิดบอท = หยุดทดสอบ + เซฟก่อน (กันข้อมูลหาย)
    if (!enabled && bossPhase !== 'idle') { bossReleaseAll(); bossPhase = 'idle'; clearBossState(); }   // 👹 ปิดบอท = ยกเลิกล่าบอส
    if (enabled) {
      casts = 0; lastCheck = 0; earned = 0; sessionOff.clear();
      sessRev = 0; sessBait = 0; sessCatches = 0;   // รีเซ็ตสถิติเซสชัน (ยอดสะสม life ไม่แตะ)
      sessionStart = now(); lastHeartbeat = now(); lastProgressAt = now();
      curMap = scanMap();   // 🗺️ สแกนแมพก่อนเริ่มตก
      const modeLabel = cfg.fishMode === 'gameauto' ? ' (🎮 ให้เกมตกอัตโนมัติ)' : cfg.fishMode === 'off' ? ' (🚫 ไม่ตกปลา)' : '';
      say((curMap ? `🗺️ แมพปัจจุบัน: ${curMap} — เริ่มตกปลา` : '▶️ เริ่มตกปลา (ยังอ่านชื่อแมพไม่ได้)') + modeLabel);
      if (cfg.tgStart) { const bt0 = targetBait(); void tgSend(`▶️ <b>บอทเริ่มทำงาน</b>${curMap ? ` @ ${esc(curMap)}` : ''} — เหยื่อขั้น ${bt0} (${BAIT_TIERS[bt0 - 1]?.name ?? '?'})${mythicActive() ? ' · 🌈 โหมดล่าปลาเทพ' : ''}`); }
    }
    paused = false;
    pendingCast = 0;
    failedCasts = 0;
    lastCast = 0;
    warnAt = 0;
    pauseUntil = 0;
    awayAt = 0;
    resetFishEngine();   // ล้างสถานะเอนจินกลไกใหม่ (ปล่อยปุ่มค้าง ฯลฯ)
    bagFullTries = 0;
    needBuy = false;
    catchNotified = false;
    pauseNotified = false;
    tgFails = 0;
    if (energySat) { const b = qBtn('นั่งพัก'); if (b) fireClick(b); }   // ลุกขึ้นก่อนรีเซ็ต
    energyResting = false; energySat = false;
    clearPersistedBreak();
    resetHumanTimers();
    resetRound();
    zoneKey = null;
    persistEnabled();   // จำสถานะเปิด/ปิด — กด B ปิดเอง = ไม่ auto-resume · เปิดอยู่ = รันต่อหลังรีเฟรช
    updateBadge();
  }

  function togglePause() {
    if (!enabled) { say('เปิดบอทก่อนถึงจะพักได้'); return; }
    paused = !paused;
    updateBadge();
    say(paused ? '⏸ พักชั่วคราว' : '▶️ เล่นต่อ');
  }

  function labeled(text, node) {
    const l = document.createElement('label');
    l.style.cssText = 'display:flex;align-items:center;gap:6px;font-size:12px;font-weight:700;';
    const s = document.createElement('span');
    s.textContent = text;
    l.append(s, node);
    return l;
  }

  function numInput(key, lo, hi, width = 58) {
    const i = document.createElement('input');
    i.type = 'number';
    i.min = String(lo); i.max = String(hi); i.step = '1';
    i.value = String(cfg[key]);
    i.dataset.key = key;
    i.style.cssText = `width:${width}px;padding:3px 6px;border-radius:6px;border:1px solid #bba;font:inherit;`;
    // เซฟ "สด" ทุกคีย์ที่พิมพ์ (กันหายถ้าเกม re-render/รีเฟรชก่อน blur) — ไม่ syncPanel ระหว่างพิมพ์ (จะเขียนทับช่อง)
    i.addEventListener('input', () => {
      // กฎเหล็ก #4: ระหว่างทดสอบเหยื่อ ห้ามแก้ baitTier จากแผง (ระบบทดสอบคุมเอง — เดี๋ยวซื้อผิดขั้น/สถิติปน)
      if (key === 'baitTier' && testRunning) { say('🧪 กำลังทดสอบเหยื่อ — แก้ขั้นเหยื่อไม่ได้ (หยุดทดสอบก่อน)'); syncPanel(); return; }
      const v = parseInt(i.value, 10); if (!isNaN(v)) { cfg[key] = clamp(v, lo, hi); saveCfg(); }
    });
    i.addEventListener('change', () => {
      cfg[key] = clamp(parseInt(i.value, 10) || lo, lo, hi);
      if (cfg.castMin > cfg.castMax) cfg.castMin = cfg.castMax;
      if (cfg.reelMin > cfg.reelMax) cfg.reelMin = cfg.reelMax;
      if (cfg.energyResumeAt <= cfg.energyRestAt) cfg.energyResumeAt = Math.min(100, cfg.energyRestAt + 5);
      saveCfg();
      syncPanel();
    });
    i.addEventListener('keydown', (e) => e.stopPropagation());
    return i;
  }

  function checkbox(key, onChange) {
    const c = document.createElement('input');
    c.type = 'checkbox';
    c.checked = !!cfg[key];
    c.dataset.key = key;
    c.addEventListener('change', () => {
      cfg[key] = c.checked;
      sessionOff.delete(key);   // ผู้ใช้กดเอง = ยกเลิกการพักชั่วคราว (อาจแก้ปัญหาแล้ว)
      saveCfg();
      syncPanel();
      onChange?.();
    });
    return c;
  }

  // dropdown เลือกค่า (opts = [[v, label], ...]) — เซฟ+syncPanel เมื่อเปลี่ยน · data-sel → syncPanel sync ให้เอง
  function selectInput(key, opts, onChange) {
    const s = document.createElement('select');
    s.dataset.sel = key;
    s.style.cssText = 'padding:3px 6px;border-radius:6px;border:1px solid #bba;font:inherit;font-size:12px;font-weight:700;cursor:pointer;';
    for (const [v, label] of opts) {
      const op = document.createElement('option');
      op.value = v; op.textContent = label; if (cfg[key] === v) op.selected = true;
      s.appendChild(op);
    }
    s.addEventListener('change', () => { cfg[key] = s.value; saveCfg(); syncPanel(); onChange?.(); });
    s.addEventListener('keydown', (e) => e.stopPropagation());
    return s;
  }

  // ช่องพิมพ์สั้น (CSV/สั้นๆ) — เซฟสด · data-text-key → syncPanel sync ให้เอง
  function smallTextInput(key, placeholder, width = 80) {
    const i = document.createElement('input');
    i.type = 'text';
    i.value = cfg[key] || '';
    i.placeholder = placeholder || '';
    i.dataset.textKey = key;
    i.style.cssText = `width:${width}px;padding:3px 6px;border-radius:6px;border:1px solid #bba;font:inherit;font-size:12px;`;
    const commit = () => { cfg[key] = i.value.trim(); saveCfg(); };
    i.addEventListener('input', commit);
    i.addEventListener('change', commit);
    i.addEventListener('keydown', (e) => e.stopPropagation());
    return i;
  }

  function textInput(key, placeholder, isSecret) {
    const i = document.createElement('input');
    i.type = isSecret ? 'password' : 'text';
    i.placeholder = placeholder;
    i.value = cfg[key] || '';
    i.dataset.textKey = key;
    i.style.cssText = 'flex:1;min-width:100%;padding:4px 7px;border-radius:6px;border:1px solid #bba;font:inherit;font-size:12px;';
    const commit = () => { cfg[key] = i.value.trim(); sessionOff.delete('tgOn'); saveCfg(); };
    i.addEventListener('input', commit);    // เซฟสดทุกคีย์ (กันหายถ้ารีเฟรชก่อน blur)
    i.addEventListener('change', commit);
    i.addEventListener('keydown', (e) => e.stopPropagation());
    return i;
  }

  function row(title, hint, ...kids) {
    const d = document.createElement('div');
    d.style.cssText = 'display:flex;flex-direction:column;gap:4px;padding:8px 0;border-top:1px solid rgba(0,0,0,.12);';
    const h = document.createElement('div');
    h.style.cssText = 'font-size:12.5px;font-weight:900;';
    h.textContent = title;
    d.appendChild(h);
    if (hint) {
      const p = document.createElement('div');
      p.style.cssText = 'font-size:10.5px;opacity:.65;line-height:1.35;';
      p.textContent = hint;
      d.appendChild(p);
    }
    const line = document.createElement('div');
    line.style.cssText = 'display:flex;align-items:center;gap:10px;flex-wrap:wrap;';
    line.append(...kids);
    d.appendChild(line);
    return d;
  }

  function syncPanel() {
    if (!panel) return;
    panel.querySelectorAll('input[data-key]').forEach((i) => {
      const k = i.dataset.key;
      if (i.type === 'checkbox') {
        i.checked = !!cfg[k];
        // พักชั่วคราว: ยังติ๊กอยู่แต่ทำงานไม่ได้ ทำให้เห็นชัดว่าไม่ได้ถูกปิดถาวร
        const paused = cfg[k] && sessionOff.has(k);
        i.indeterminate = !!paused;
        i.title = paused ? 'พักชั่วคราวเพราะติดปัญหา — กดติ๊กใหม่เพื่อลองอีกครั้ง' : '';
      } else if (i.type === 'number') i.value = String(cfg[k]);
    });
    panel.querySelectorAll('input[data-rarity]').forEach((i) => {
      i.checked = cfg.lockRarities.includes(i.dataset.rarity);
    });
    panel.querySelectorAll('input[data-notify]').forEach((i) => {
      i.checked = cfg.tgRarities.includes(i.dataset.notify);
    });
    panel.querySelectorAll('input[data-text-key]').forEach((i) => {
      i.value = cfg[i.dataset.textKey] || '';
    });
    panel.querySelectorAll('select[data-sel]').forEach((i) => {
      i.value = cfg[i.dataset.sel];
    });
  }

  // ---- Accordion: หัวข้อหมวดพับ/กางได้ (ใช้เป็น "ตัวคั่น" — ทุก element หลังหัวข้อจนถึงหัวข้อถัดไป = กลุ่มเดียวกัน) ----
  // ทำแบบนี้เพื่อไม่ต้องเปลี่ยน panel.appendChild(row(...)) ทุกจุด — แค่ใส่หัวข้อคั่นแล้ว wireCollapse() จับกลุ่มให้ตอนท้าย
  function sectionHead(title, opened = false) {
    const h = document.createElement('button');
    h.type = 'button'; h.dataset.sec = '1'; h.dataset.open = opened ? '1' : '0';
    h.style.cssText = 'width:100%;display:flex;justify-content:space-between;align-items:center;gap:6px;margin-top:6px;padding:9px 12px;font-size:13px;font-weight:900;background:rgba(0,0,0,.06);border:1px solid rgba(0,0,0,.14);border-radius:10px;color:inherit;cursor:pointer;text-align:left;';
    const l = document.createElement('span'); l.textContent = title;
    const a = document.createElement('span'); a.textContent = opened ? '▾' : '▸'; a.dataset.arrow = '1'; a.style.cssText = 'opacity:.55;font-size:11px;';
    h.append(l, a);
    panel.appendChild(h);
    return h;
  }
  // จับกลุ่ม sibling ระหว่างหัวข้อ แล้วผูกคลิกพับ/กาง (เก็บ display เดิมไว้คืนค่าให้ตรง — flex/block ไม่เพี้ยน)
  function wireCollapse() {
    const heads = [...panel.children].filter((e) => e.dataset && e.dataset.sec);
    for (const head of heads) {
      const group = [];
      let el = head.nextElementSibling;
      while (el && !(el.dataset && el.dataset.sec)) { el._disp = el.style.display; group.push(el); el = el.nextElementSibling; }
      const arrow = head.querySelector('[data-arrow]');
      const apply = (open) => {
        group.forEach((g) => { g.style.display = open ? (g._disp || '') : 'none'; });
        arrow.textContent = open ? '▾' : '▸'; head.dataset.open = open ? '1' : '0';
        if (open && head._onOpen) head._onOpen();
      };
      head.addEventListener('click', () => apply(head.dataset.open !== '1'));
      apply(head.dataset.open === '1');
    }
  }

  // ---- ตารางสถิติต่อขั้นเหยื่อ (เลื่อนแนวนอนได้ในแผงแคบ) ----
  function statsTableEl(rows) {
    const wrap = document.createElement('div');
    wrap.style.cssText = 'overflow-x:auto;margin:2px 0 4px;';
    const t = document.createElement('table');
    t.style.cssText = 'border-collapse:collapse;width:100%;font-size:10.5px;white-space:nowrap;';
    const cell = (tag, txt, css = '') => { const e = document.createElement(tag); e.textContent = txt; e.style.cssText = 'padding:3px 5px;border-bottom:1px solid rgba(0,0,0,.1);text-align:right;' + css; return e; };
    const hr = document.createElement('tr');
    [['เหยื่อ', 'text-align:left;'], ['n', ''], ['/ครั้ง', ''], ['/ชม.', ''], ['💙', ''], ['💜', ''], ['🏅', ''], ['🌈', '']]
      .forEach(([h, c]) => hr.appendChild(cell('th', h, 'font-weight:900;opacity:.75;' + c)));
    t.appendChild(hr);
    if (!rows.length) {
      const tr = document.createElement('tr'); const td = cell('td', 'ยังไม่มีข้อมูล', 'text-align:left;opacity:.6;'); td.colSpan = 8; tr.appendChild(td); t.appendChild(tr);
    }
    for (const r of rows) {
      const tr = document.createElement('tr');
      tr.appendChild(cell('td', `${r.tier}·${r.name}`, 'text-align:left;font-weight:700;'));
      tr.appendChild(cell('td', String(r.n)));
      tr.appendChild(cell('td', signed(r.pfCast), `font-weight:900;color:${r.pfCast >= 0 ? '#2f7d32' : '#b04a44'};`));
      tr.appendChild(cell('td', r.pfHr != null ? signed(r.pfHr) : '-'));
      tr.appendChild(cell('td', r.byR.rare.toFixed(0)));
      tr.appendChild(cell('td', r.byR.epic.toFixed(0)));
      tr.appendChild(cell('td', r.byR.legendary.toFixed(0)));
      tr.appendChild(cell('td', r.byR.mythic.toFixed(0)));
      t.appendChild(tr);
    }
    wrap.appendChild(t);
    return wrap;
  }

  // แถบสรุป 1 ค่า (session/lifetime) — ป้าย + ตัวเลข
  function statTile(label, value, color) {
    const d = document.createElement('div');
    d.style.cssText = 'flex:1;min-width:64px;background:rgba(0,0,0,.05);border-radius:8px;padding:5px 8px;';
    const l = document.createElement('div'); l.textContent = label; l.style.cssText = 'font-size:9.5px;opacity:.6;font-weight:700;';
    const v = document.createElement('div'); v.textContent = value; v.style.cssText = `font-size:13px;font-weight:900;${color ? `color:${color};` : ''}`;
    d.append(l, v); return d;
  }

  let statsBodyEl = null;
  function fmtDur(ms) {
    const s = Math.floor(ms / 1000), h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
    return h > 0 ? `${h}ชม ${m}น` : m > 0 ? `${m}น ${s % 60}ว` : `${s}ว`;
  }
  // สร้าง/รีเฟรชเนื้อหาแท็บสถิติทั้งหมด (session + สะสม + 3 ตาราง)
  function refreshStatsPanel() {
    if (!statsBodyEl) return;
    statsBodyEl.textContent = '';
    const l = profit.life;
    // 1) เซสชันนี้
    const sHead = document.createElement('div'); sHead.textContent = '⏱️ เซสชันนี้'; sHead.style.cssText = 'font-size:11.5px;font-weight:900;margin:6px 0 3px;';
    const sGrid = document.createElement('div'); sGrid.style.cssText = 'display:flex;gap:6px;flex-wrap:wrap;';
    const up = enabled && sessionStart ? now() - sessionStart : 0;
    sGrid.append(
      statTile('เวลารัน', enabled ? fmtDur(up) : 'ปิด'),
      statTile('เหวี่ยง', casts.toLocaleString()),
      statTile('ติดปลา', sessCatches.toLocaleString()),
      statTile('กำไรรอบนี้', signed(sessNet()) + ' 🪙', sessNet() >= 0 ? '#2f7d32' : '#b04a44'),
    );
    // 2) สะสม (lifetime)
    const lNet = lifeNet();
    const lHead = document.createElement('div'); lHead.textContent = '💰 กำไรสุทธิสะสม'; lHead.style.cssText = 'font-size:11.5px;font-weight:900;margin:8px 0 3px;';
    const lGrid = document.createElement('div'); lGrid.style.cssText = 'display:flex;gap:6px;flex-wrap:wrap;';
    lGrid.append(
      statTile('สุทธิ (หักครบ)', signed(lNet) + ' 🪙', lNet >= 0 ? '#2f7d32' : '#b04a44'),
      statTile('รายได้ปลา', l.revenue.toLocaleString()),
      statTile('เหวี่ยง/ติด', `${l.casts.toLocaleString()}/${(l.catches || 0).toLocaleString()}`),
    );
    const lCost = document.createElement('div');
    lCost.style.cssText = 'font-size:10px;opacity:.7;margin-top:3px;line-height:1.4;';
    lCost.textContent = `ต้นทุน: เหยื่อ -${l.baitCost.toLocaleString()}`
      + (l.coffeeCost ? ` · กาแฟ -${l.coffeeCost.toLocaleString()}` : '')
      + (l.potionCost ? ` · ยา -${l.potionCost.toLocaleString()}` : '')
      + (l.floatCost ? ` · ทุ่น -${l.floatCost.toLocaleString()}` : '');
    // 3) ตารางเทียบเหยื่อ (รวม / ใช้ยา / ไม่ใช้ยา)
    const filtNote = document.createElement('div');
    filtNote.style.cssText = 'font-size:9.5px;opacity:.55;margin:8px 0 2px;';
    const fparts = [`ใช้ ${cfg.statWin || 100} รายการล่าสุด`];
    if (cfg.adaptFilterMap && curMap) fparts.push(`แมพ:${curMap}`);
    if (cfg.excludeRarities?.length) fparts.push(`ตัด:${cfg.excludeRarities.join(',')}`);
    filtNote.textContent = 'ตัวกรอง — ' + fparts.join(' · ');
    const mk = (title, mode) => {
      const h = document.createElement('div'); h.textContent = title; h.style.cssText = 'font-size:11px;font-weight:900;margin:6px 0 1px;';
      return [h, statsTableEl(statRows(mode))];
    };
    statsBodyEl.append(sHead, sGrid, lHead, lGrid, lCost, filtNote,
      ...mk('🪱 เทียบเหยื่อ (รวม)', 'all'),
      ...mk('🧪 เมื่อใช้ยา 🐋🍀', 'buff'),
      ...mk('⚪ ไม่ใช้ยา', 'plain'),
    );
  }

  function buildPanel() {
    panel = document.createElement('div');
    panel.dataset.tkbot = '1';   // 🛡️ v6.105: ป้ายบอก "นี่ UI ของบอทเอง" — btnByText/qBtn ต้องข้าม (กันจับปุ่มตัวเอง)
    panel.style.cssText = [
      'position:fixed', 'top:52px', 'left:50%', 'transform:translateX(-50%)',
      'z-index:2147483647', 'width:300px', 'max-height:78vh', 'overflow-y:auto',
      'padding:10px 14px 12px', 'border-radius:14px', 'border:2px solid #fff',
      'background:#f7e7c5', 'color:#4a3222', 'box-shadow:0 6px 18px rgba(0,0,0,.35)',
      'font-family:inherit', 'display:none',
    ].join(';');
    panel.addEventListener('keydown', (e) => e.stopPropagation());
    panel.addEventListener('pointerdown', (e) => e.stopPropagation());

    const title = document.createElement('div');
    title.style.cssText = 'font-size:13px;font-weight:900;text-align:center;padding-bottom:6px;';
    title.textContent = '⚙️ ตั้งค่าบอท ';
    const verSpan = document.createElement('span');   // เวอร์ชัน — ไว้เช็คว่าอัปเดตล่าสุดแล้วหรือยัง (เทียบกับ @version บน GitHub)
    verSpan.textContent = 'v' + BOT_VER;
    verSpan.style.cssText = 'font-weight:700;opacity:.55;font-size:11px;';
    verSpan.title = 'เวอร์ชันบอทที่ติดตั้งอยู่ — เทียบกับล่าสุดบน GitHub (กด "ตรวจหาอัปเดต" ใน Tampermonkey)';
    title.appendChild(verSpan);
    panel.appendChild(title);

    // ---- ปุ่มลัด (โชว์ตลอด ไม่พับ) ----
    const mkActBtn = (txt, bg, fn) => {
      const b = document.createElement('button');
      b.textContent = txt;
      b.style.cssText = `flex:1;min-width:90px;padding:6px;border-radius:8px;border:none;background:${bg};color:#fff;font-weight:900;font-size:12px;cursor:pointer;`;
      b.addEventListener('click', fn);
      return b;
    };
    const quick = document.createElement('div');
    quick.style.cssText = 'display:flex;gap:6px;flex-wrap:wrap;';
    quick.append(
      mkActBtn('💰 ขายเดี๋ยวนี้', '#3e7d24', () => void runWhenIdle('ขาย', () => runSell(true))),
      mkActBtn('🪱 ซื้อเหยื่อ', '#8a5a1e', () => void runWhenIdle('ซื้อเหยื่อ', () => sellThenBuy(true))),
      mkActBtn('🎒 ดูกระเป๋า', '#4a3222', () => void runWhenIdle('เปิดกระเป๋า', peekBag)),
    );
    panel.appendChild(quick);

    statusEl = document.createElement('div');
    statusEl.style.cssText = 'font-size:10.5px;opacity:.75;padding:4px 2px 2px;line-height:1.4;min-height:14px;';
    panel.appendChild(statusEl);

    // ---------- 🧑 โหมดมนุษย์ ----------
    sectionHead('🧑 โหมดมนุษย์ (เลียนแบบการเล่นจริง)', false);

    panel.appendChild(row(
      'เปิดโหมดมนุษย์',
      'เปิด = หน่วงจังหวะ กดพลาดบ้าง พักเป็นระยะ (ดูสมจริง แต่ตกช้าลง) · ปิด = แม่นสุด/เร็วสุด · หมายเหตุ: ไม่มีทางทำให้ตรวจจับไม่ได้ 100% (ติดเพดาน isTrusted)',
      labeled('เปิดทั้งหมด', checkbox('human', () => resetHumanTimers())),
    ));

    panel.appendChild(row(
      '⏱️ หน่วงรีแอคตอนปลาฮุบ (ms)',
      'สุ่มดีเลย์ก่อนตวัด — ยิ่งช้า hook score ยิ่งลงมาอยู่ระดับมนุษย์ (~200-400ms)',
      labeled('เปิด', checkbox('hReact')),
      labeled('ต่ำ', numInput('reactMinMs', 50, 900, 64)), labeled('สูง', numInput('reactMaxMs', 50, 900, 64)),
    ));

    panel.appendChild(row(
      '🎯 กดพลาดบ้าง',
      '% ครั้งที่จงใจกดคะแนนต่ำ (มนุษย์ไม่เป๊ะทุกครั้ง)',
      labeled('เปิด', checkbox('hMiss')),
      labeled('พลาด %', numInput('missChance', 0, 50)),
    ));

    panel.appendChild(row(
      '🎣 จังหวะเหวี่ยงสุ่ม + เหม่อ (ms)',
      'เหวี่ยง = สุ่มเวลารอก่อนเหวี่ยงตัวถัดไป · เหม่อ = % ครั้งที่จะพักยาวกว่าปกติเหมือนวางมือแป๊บ',
      labeled('เปิด', checkbox('hCastGap')),
      labeled('เหวี่ยงต่ำ', numInput('castGapMinMs', 300, 20000, 72)),
      labeled('สูง', numInput('castGapMaxMs', 300, 20000, 72)),
      labeled('เหม่อ %', numInput('distractChance', 0, 50)),
      labeled('เหม่อต่ำ', numInput('distractMinMs', 1000, 120000, 76)),
      labeled('สูง', numInput('distractMaxMs', 1000, 120000, 80)),
    ));

    panel.appendChild(row(
      '☕ พักย่อย & พักใหญ่',
      'พักย่อย: ทุกๆ N ครั้ง หยุดไม่กี่วินาที · พักใหญ่: ทุกๆ N ครั้ง หยุดเป็นนาที (สุ่ม ± อัตโนมัติ)',
      labeled('เปิด', checkbox('hBreak')),
      labeled('ย่อยทุก', numInput('microEvery', 1, 999, 56)),
      labeled('วิ', numInput('microMinSec', 1, 600, 52)), labeled('ถึง', numInput('microMaxSec', 1, 600, 52)),
      labeled('ใหญ่ทุก', numInput('macroEvery', 1, 9999, 60)),
      labeled('นาที', numInput('macroMinMin', 1, 240, 52)), labeled('ถึง', numInput('macroMaxMin', 1, 240, 52)),
    ));

    const sessSel = document.createElement('select');
    for (const [v, t] of [['break', 'พักยาวแล้วเล่นต่อ'], ['stop', 'หยุดบอท']]) {
      const o = document.createElement('option'); o.value = v; o.textContent = t; sessSel.appendChild(o);
    }
    sessSel.value = cfg.sessionAction;
    sessSel.dataset.sel = 'sessionAction';
    sessSel.style.cssText = 'padding:4px 6px;border-radius:6px;border:1px solid #bba;font:inherit;font-size:12px;';
    sessSel.addEventListener('change', () => { cfg.sessionAction = sessSel.value; saveCfg(); });

    panel.appendChild(row(
      '🛋️ จำกัดเวลาต่อเซสชัน (นาที)',
      'เล่นครบช่วงนี้แล้วพักยาว/หยุด — เลี่ยงการเล่นต่อเนื่องไม่หยุดที่ดูเป็นบอทชัดสุด',
      labeled('เปิด', checkbox('hSession')),
      labeled('เล่น', numInput('sessionMinMin', 5, 600, 56)), labeled('ถึง', numInput('sessionMaxMin', 5, 600, 56)),
      sessSel,
      labeled('พักยาว', numInput('sessionBreakMinMin', 1, 240, 56)), labeled('ถึง', numInput('sessionBreakMaxMin', 1, 240, 56)),
    ));

    panel.appendChild(row(
      '⚡ พักรอพลังแบบสุ่ม (วินาที)',
      'แทนการพัก 60 วิเป๊ะ ให้สุ่มในช่วงนี้',
      labeled('เปิด', checkbox('hEnergy')),
      labeled('ต่ำ', numInput('energyPauseMinSec', 10, 600, 64)), labeled('สูง', numInput('energyPauseMaxSec', 10, 600, 64)),
    ));

    // ---------- 🎣 การตกปลา ----------
    sectionHead('🎣 การตกปลา & ความแม่น', true);

    const modeSel = document.createElement('select');
    for (const [v, t] of [
      ['bot', '🤖 บอทตกเอง (โบนัสตกเอง · แนะนำ)'],
      ['gameauto', '🎮 ให้เกมตกอัตโนมัติ (สำรอง)'],
      ['off', '🚫 ไม่ตกปลา (ทำแต่ระบบอื่น)'],
    ]) {
      const o = document.createElement('option'); o.value = v; o.textContent = t; modeSel.appendChild(o);
    }
    modeSel.value = cfg.fishMode;
    modeSel.dataset.sel = 'fishMode';
    modeSel.style.cssText = 'padding:4px 6px;border-radius:6px;border:1px solid #bba;font:inherit;font-size:12px;';
    modeSel.addEventListener('change', () => {
      cfg.fishMode = modeSel.value;
      saveCfg();
      if (cfg.fishMode !== 'gameauto' && gameAutoRunning()) stopGameAuto();   // เลิกใช้ auto เกม → ปิดทันที
      updateBadge();
    });

    panel.appendChild(row(
      '🎣 โหมดตกปลา',
      '⭐ "บอทตกเอง" (v6.84) เล่นมินิเกมใหม่ครบทุกเฟส: ตวัด❗ → เกจวงล้อ (กดโซนแดงใกล้ดาว) → ชักเย่อ (คุมกรอบตามปลาแบบทำนายล่วงหน้า) → กดรัวตอนปลาสู้ — ' +
      'ตกเองได้โบนัสโชค/คะแนนสูงกว่าระบบ auto ของเกม (ทดสอบสดได้ปลาจริงต่อเนื่อง) · ' +
      '"ให้เกมตกอัตโนมัติ" = สำรองเสถียร ถ้าเกมอัปเดตจนเอนจินบอทพังให้สลับมาก่อน · ' +
      '"ไม่ตกปลา" ปิดการเหวี่ยงแต่ยังทำ ขาย/ซื้อ/เควส/จดหมาย/พลังงาน ต่อ · ทุกโหมดเก็บสถิติต่อตัวจาก state เกมโดยตรง',
      modeSel,
    ));

    panel.appendChild(row(
      '⚡ โหมดเร็วสุด (ตกไวสุด · คงความแม่น)',
      'ตัดเวลาที่ไม่เกี่ยวความแม่นให้เหลือน้อยสุด: เหวี่ยงถัดไปเร็ว (~0.15-0.35วิ แทน 0.8-2.6วิ) · ตวัดทันทีไม่หน่วงรีแอค · ปิดพักย่อย/พักใหญ่/จบเซสชัน · ไม่จงใจพลาดดาว — ' +
      '⭐ เกจเล็งดาว/ชักเย่อ/ปลาสู้ ยังเหมือนเดิม (ความแม่นไม่ลด) · ⚠️ แลกกับความสมจริง = "ดูเป็นบอท" ชัดขึ้น (เสี่ยงถูกจับ) · เหมาะตอนอยากฟาร์มไวช่วงเฝ้าเอง',
      labeled('เปิด', checkbox('turbo')),
    ));

    // v6.98: ซ่อน 2 แถว "ช่วงคะแนน" ไว้ — กลไกเก่า (findBar/planAim/สถานะ minigame) เกมปัจจุบันไม่ใช้แล้ว
    //   (เกจวงล้อใหม่คุมด้วย timing เล็งดาวเอง · ตั้งช่วงคะแนนไม่มีผล) ทำให้ผู้ใช้สับสน
    //   เก็บ config + input ใน DOM (display:none) ตามกฎเหล็กข้อ 1 — ถ้าเกมย้อนกลับกลไกเก่า ลบ display:none ออกก็กลับมาใช้ได้
    const legacyGaugeRows = document.createElement('div');
    legacyGaugeRows.style.display = 'none';
    legacyGaugeRows.dataset.legacyGauge = '1';
    legacyGaugeRows.appendChild(row(
      '🎣 เกจเหวี่ยงเบ็ด — ช่วงคะแนน (สำรอง · กลไกเก่า)',
      'ใช้เฉพาะกลไกเก่า (เกมปัจจุบันเป็นเกจวงล้อ timing — ตั้งค่านี้ไม่มีผล) · สุ่มคะแนนในช่วงนี้ · ต่ำสุดโซนเขียว 60',
      labeled('ต่ำ', numInput('castMin', 60, 100)), labeled('สูง', numInput('castMax', 60, 100)),
    ));
    legacyGaugeRows.appendChild(row(
      '🐟 มินิเกมดึงปลา — ช่วงคะแนน (สำรอง · กลไกเก่า)',
      'ใช้เฉพาะกลไกเก่า (เกมปัจจุบันเป็นเกจวงล้อ+ชักเย่อ — ตั้งค่านี้ไม่มีผล) · เกมนี้ไม่มีคะแนน 96-99 · ต่ำสุดโซนเขียว 70',
      labeled('ต่ำ', numInput('reelMin', 70, 100)), labeled('สูง', numInput('reelMax', 70, 100)),
    ));
    panel.appendChild(legacyGaugeRows);

    panel.appendChild(row(
      '🔁 ตกต่อเนื่อง',
      'ใส่ 0 = ตกไม่จำกัด · ไม่ติ๊ก = ตกครั้งเดียวแล้วหยุด · ตัวนับรีเซ็ตทุกครั้งที่เปิดบอท',
      labeled('เปิด', checkbox('loop', updateBadge)), labeled('ครั้ง', numInput('limit', 0, 9999)),
    ));

    // ---------- ⚔️ ระบบตีบอส ----------
    sectionHead('⚔️ ระบบตีบอส (ถ้ำบ่อโบราณ)', false);

    // 👹 ปุ่มเริ่ม/หยุดล่าบอส — แยกจากปุ่มบอทตกปลาปกติ (v6.141) · กด = เปิดบอท+เปิดโหมดล่าบอสเต็มตัว
    bossBtn = document.createElement('button');
    bossBtn.style.cssText = 'width:100%;padding:8px;border-radius:8px;border:none;color:#fff;font-weight:900;font-size:12.5px;cursor:pointer;margin:2px 0 6px;';
    bossBtn.addEventListener('click', () => {
      if (isOn('bossHunt')) {
        cfg.bossHunt = false; saveCfg(); syncPanel();
        if (bossPhase !== 'idle') { bossReleaseAll(); bossPhase = 'idle'; clearBossState(); }   // ยกเลิกการล่าที่ค้างอยู่
        say('👹 หยุดโหมดล่าบอส — กลับฟาร์มปกติ');
      } else {
        cfg.bossHunt = true; sessionOff.delete('bossHunt'); saveCfg(); syncPanel();
        if (!enabled) toggle();   // ปุ่มนี้ = "เริ่มล่าบอสเต็มตัว" → เปิดบอทให้เลยถ้ายังปิด
        say('👹 เริ่มล่าบอสเต็มตัว! — ใกล้เวลาบอทจะเดินไปถ้ำ/ตีเอง · ถ้าอยู่ในถ้ำแล้วบอสมา = ตีทันที (เปิดแท็บเกมไว้หน้าสุด)');
        if (isOn('tgOn')) void tgSend('👹 <b>เริ่มโหมดล่าบอส</b> — บอทจะเดินไปถ้ำ/ตีบอสอัตโนมัติ');
      }
      refreshBossBtn();
    });
    refreshBossBtn();
    panel.appendChild(bossBtn);

    panel.appendChild(row(
      '👹 ล่า & ตีบอสอัตโนมัติ',
      'ใกล้เวลาบอสเกิด บอทจะ "หยุดฟาร์ม → เดินไปถ้ำบ่อโบราณ → รอ/ตีบอส → กลับแมพเดิมฟาร์มต่อ" อัตโนมัติ · อ่านเวลาจากป้าย HUD "บอสถัดไป" · เดินข้ามแมพเรียนรู้เส้นทางเอง · '
      + 'ตีบอส = เกจวงล้อ (กดตอนเข็มเข้าแถบแดง — ถอดรหัสเกจบอสจริงแล้ว v6.118) + กระโดดหลบตอน "บอสหมุน" · '
      + 'ถ้าคุณเดินเข้าถ้ำเอง/อยู่ในถ้ำอยู่แล้ว พอบอสโผล่บอทจะเข้าตีทันทีไม่ต้องรอ timer (v6.119) · '
      + '⚠️ ตอนบอทเดิน/ตี ต้องเปิดแท็บเกมไว้หน้าสุด (เกมไม่รับปุ่มตอนแท็บไม่โฟกัส — บอทจะยกเลิก+ฟาร์มต่อเองถ้าเดินไม่ได้)',
      labeled('เปิด', checkbox('bossHunt', refreshBossBtn)),
      labeled('ไปก่อน (นาที)', numInput('bossLeadMin', 1, 60, 48)),
      labeled('รอสูงสุด (นาที)', numInput('bossMaxWaitMin', 1, 30, 48)),
      labeled('บอสมาทุก (นาที)', numInput('bossIntervalMin', 10, 720, 52)),
    ));

    panel.appendChild(row(
      '🎯 เหยื่อจุดอ่อน & แมพบ้าน',
      '"เหยื่อจุดอ่อน" = สลับเป็นเหยื่อขั้นนี้ตอนตีบอส เพื่อดาเมจ x1.5 (จากวิดีโอจริง: มัดอ้วนขั้น 2 / กุ้งฝอยขั้น 4) · 0 = ไม่สลับ (ใช้เหยื่อเดิม) · '
      + '"แมพบ้าน" = แมพที่จะกลับไปฟาร์มต่อหลังตีเสร็จ (ว่าง = แมพที่อยู่ตอนเริ่มล่า) · '
      + 'ไม่ต้องกลัวตาย: โดนบอสตีแค่สลบชั่วคราวแล้ว respawn HP เต็ม (พิสูจน์จาก log จริง — จึงไม่มีตัวเลือกถอยหนี)',
      labeled('เหยื่อจุดอ่อน (ขั้น)', numInput('bossBaitTier', 0, 8, 44)),
      labeled('แมพบ้าน', smallTextInput('bossHomeMap', 'ว่าง=อัตโนมัติ', 96)),
    ));

    // 📊 v6.195: สถิติล่าบอส — เก็บ N ครั้งล่าสุด + ปุ่มดูสรุป
    {
      const statBtn = document.createElement('button');
      statBtn.setAttribute('data-tkbot', '1');
      statBtn.textContent = '📊 ตารางเทียบรายไฟต์';
      statBtn.style.cssText = 'padding:5px 10px;border-radius:7px;border:1px solid #4a5568;background:#2d3748;color:#e2e8f0;font-size:11px;cursor:pointer;margin:2px 3px 6px 0;';
      statBtn.addEventListener('click', () => { showBossStatsModal(); });   // ตารางรายไฟต์ในหน้าต่าง monospace
      panel.appendChild(row(
        '📊 สถิติล่าบอส (เก็บ N ครั้งล่าสุด)',
        'บันทึกทุกไฟต์อัตโนมัติ: ผล (ฆ่า/หมดเวลา/ไม่มา) · ดาเมจ+% · กดเกจ · หลบ AoE · ตาย · HP ต่ำสุด · เวลา/ไฟต์ · '
        + 'เก็บแบบ "วนทับ" เฉพาะ N ครั้งล่าสุดที่ตั้งไว้ (0 = ปิดการเก็บ) · กดปุ่ม "📊 ตารางเทียบรายไฟต์" ดูตารางแยกทีละไฟต์ (ไม่ใช่เฉลี่ย) · '
        + '/bossstats = ตาราง · /bossstats avg = ค่าเฉลี่ย · /bossstats clear = ล้าง (ทาง Telegram)',
        labeled('เก็บกี่ครั้ง', numInput('bossStatKeep', 0, 200, 52)),
      ));
      panel.appendChild(statBtn);
    }

    // 🎣 v6.174: สลับ "ชิ้นเบ็ด" ตอนตีบอส vs ฟาร์ม — เบ็ดชนิดเดียวกันหลายชิ้นที่อัปเกรดต่างกัน แยกด้วย instance UUID
    //   ให้ผู้ใช้ "ใส่เบ็ดที่ต้องการแล้วกดจำ" แทนการพิมพ์ UUID เอง (UUID ยาว จำ/พิมพ์เองไม่ไหว)
    {
      const mkRodBtn = (key, label, tip) => {
        const b = document.createElement('button');
        b.setAttribute('data-tkbot', '1');
        b.style.cssText = 'padding:5px 8px;border-radius:7px;border:1px solid #4a5568;background:#2d3748;color:#e2e8f0;font-size:11px;cursor:pointer;margin:2px 3px 2px 0;';
        const paint = () => { b.textContent = cfg[key] ? `${label} ✓` : label; b.title = tip + (cfg[key] ? `\nจำไว้แล้ว: ${cfg[key].slice(0, 8)}…` : '\n(ยังไม่ได้ตั้ง)'); };
        b.addEventListener('click', () => {
          const id = currentRodId();
          if (!id) { say('🎣 อ่านเบ็ดที่ใส่อยู่ไม่ได้ — ลองใส่เบ็ดในเกมก่อน'); return; }
          if (cfg[key] === id) { cfg[key] = ''; say(`🎣 ล้างค่า ${label} แล้ว`); }
          // v6.188: กด "จำ" = ผู้ใช้ยืนยันเจตนา → ล้างเครื่องหมาย "G เข้าไม่ถึง" ให้ลองใหม่ได้อีกครั้ง
          else { cfg[key] = id; rodClearUnreachable(id); say(`🎣 จำเบ็ดที่ใส่อยู่เป็น "${label}" แล้ว`); }
          saveCfg(); paint();
        });
        paint();
        return b;
      };
      panel.appendChild(row(
        '🎣 สลับชิ้นเบ็ด: ตีบอส vs ฟาร์ม',
        'เบ็ด "ชนิดเดียวกันแต่คนละชิ้น" อัปเกรดต่างกันได้ (เช่นชิ้นหนึ่งติดหินดาเมจบอสจากช่างหิน) — เกมแยกด้วยรหัสชิ้น (instance) ไม่ใช่ชื่อ · '
        + 'วิธีตั้ง: **ใส่เบ็ดที่ต้องการในเกมก่อน แล้วกดปุ่มจำ** (กดซ้ำ = ล้างค่า) · '
        + 'บอทจะสลับเป็น "เบ็ดบอส" ตอนเริ่มตีบอส แล้วสลับกลับ "เบ็ดฟาร์ม" หลังสู้จบอัตโนมัติ · '
        + '⛔ v6.189 ปิดไว้โดยปริยาย: วัดสดแล้วพบว่าปุ่ม G ของเกมสลับ "tier ของเบ็ด" ไม่ใช่ "ชิ้นเบ็ด" — แต่ละ tier เกมผูกชิ้นประจำไว้เอง '
        + 'เบ็ด tier เดียวกันชิ้นอื่นจึงเลือกด้วย G ไม่ได้ และพอหลุดออกมาแล้วกลับเข้าไม่ได้ (ต้องเลือกเองจากกระเป๋า) · '
        + 'เปิดใช้มีประโยชน์กรณีเดียวคือเบ็ดสองชิ้นอยู่คนละ tier กันจริงๆ · ไม่งั้นแนะนำใส่เบ็ดที่ต้องการค้างไว้เอง',
        labeled('เปิดใช้', checkbox('rodSwitchOn')),
        mkRodBtn('bossRodId', '👹 จำเป็นเบ็ดบอส', 'ใส่เบ็ดที่แรงกับบอส (เช่นติดหินดาเมจบอส) แล้วกดปุ่มนี้'),
        mkRodBtn('farmRodId', '🎣 จำเป็นเบ็ดฟาร์ม', 'ใส่เบ็ดที่ใช้ตกปลาปกติ แล้วกดปุ่มนี้'),
      ));
    }

    // ---------- 🏪 ระบบ NPC เมืองชาวประมง ----------
    sectionHead('🏪 NPC เมืองชาวประมง (ฝากของ/แลกแก่น)', false);
    const RAR_OPTS = RARITY.map((r) => [r.key, r.label]);
    // 🏷️ v6.201: ปุ่มตรวจ "บอทเห็นปลาแต่ละชนิดเป็นระดับอะไร + จะขาย/ฝาก/แลก" — ตรวจเองได้ว่าจำถูกไหม
    {
      const rb = document.createElement('button');
      rb.setAttribute('data-tkbot', '1');
      rb.textContent = '🏷️ ตรวจระดับปลา (บอทเห็นอะไร + จะทำอะไร)';
      rb.style.cssText = 'padding:5px 10px;border-radius:7px;border:1px solid #4a5568;background:#2d3748;color:#e2e8f0;font-size:11px;cursor:pointer;margin:2px 3px 6px 0;';
      rb.addEventListener('click', async () => {
        rb.disabled = true;
        try { await openBagUI(); await sleep(600); const ft = btnByText('🐟ปลา') || btnByText('🐟 ปลา'); if (ft) { fireClick(ft); await sleep(500); } } catch {}
        const t = fishRarityReport();
        try { console.log('[Tokpla Bot]\n' + t); } catch {}
        showTextModal('🏷️ ระดับปลาที่บอทเห็น', t);
        rb.disabled = false;
      });
      panel.appendChild(rb);
    }
    panel.appendChild(row(
      '🏬 ลุงคลัง — ฝากปลาเข้าคลัง',
      'พอในกระเป๋ามีปลา "ระดับที่เลือกขึ้นไป" ครบจำนวน → บอทเดินไปเมืองประมง (A* ในเกม) ฝากเข้าคลังลุงคลัง (ปลอดภัย+ไม่กินช่องกระเป๋า) แล้วกลับมาฟาร์มต่อ · ปลาที่ผู้เล่นล็อกไว้จะไม่ถูกฝาก',
      labeled('เปิด', checkbox('npcStorageOn')),
      labeled('ระดับขึ้นไป', selectInput('npcStorageRarity', RAR_OPTS)),
      labeled('เมื่อมี (ตัว)', numInput('npcStorageMin', 1, 300, 48)),
      labeled('🛡️ หรือกระเป๋าเต็ม %', numInput('npcStorageBagPct', 0, 100, 48)),
    ));
    panel.appendChild(row(
      '🧪 ยายแก่น — แลกปลาเป็นแก่นปลา',
      'พอในกระเป๋ามีปลา "ระดับที่เลือกขึ้นไป" ครบจำนวน → บอทเดินไปแลกกับยายแก่นเป็น 🧪 แก่นปลา (วัตถุดิบสุ่มหินออร์บ) แล้วกลับมาฟาร์มต่อ · แนะนำ 💙 หายาก (rare) · '
      + '🧠 ฉลาด: ถ้าเปิดลุงคลังด้วย + ตั้งระดับสูงกว่า → ยายแก่นจะ "แลกเฉพาะช่วงกลาง" ไม่แตะตัวสูงที่ลุงคลังเก็บ (เช่น แลก rare–epic, เก็บ legendary+ เข้าคลัง) กันแลก/ฝากทับกัน',
      labeled('เปิด', checkbox('npcEssenceOn')),
      labeled('ระดับขึ้นไป', selectInput('npcEssenceRarity', RAR_OPTS)),
      labeled('เมื่อมี (ตัว)', numInput('npcEssenceMin', 1, 300, 48)),
    ));
    // 🪨 v6.178: ตัด UI ช่างหินออก — ผู้ใช้แลก/ตีหินเอง (เหลือแค่ลุงคลัง + ยายแก่น)

    // ---------- 🌈 ล่าปลาเทพ ----------
    sectionHead('🌈 ล่าปลาเทพ & ปลาหนัก', false);

    // ปุ่มเริ่ม/หยุดล่า — สถานะชัดว่าตอนนี้ "ล่าปลาเทพ" หรือ "ฟาร์มปกติ" (สี+ข้อความอัปเดตสดผ่าน refreshMythicBtn)
    mythicBtn = document.createElement('button');
    mythicBtn.style.cssText = 'width:100%;padding:8px;border-radius:8px;border:none;color:#fff;font-weight:900;font-size:12.5px;cursor:pointer;margin:2px 0 4px;';
    mythicBtn.addEventListener('click', () => {
      if (isOn('mythicHunt')) {
        cfg.mythicHunt = false; saveCfg(); syncPanel();
        say('🌈 หยุดล่าปลาเทพ — กลับฟาร์มปกติ (ทุกค่ากลับเป็นที่ตั้งไว้)');
      } else {
        cfg.mythicHunt = true; sessionOff.delete('mythicHunt'); saveCfg(); syncPanel();
        if (!enabled) toggle();   // ยังไม่เปิดบอท → เปิดให้เลย (ปุ่มนี้คือ "เริ่มล่า" ไม่ใช่แค่ติ๊กตัวเลือก)
        say('🌈 เริ่มล่าปลาเทพ!');
      }
      refreshMythicBtn();
    });
    refreshMythicBtn();
    panel.appendChild(mythicBtn);

    panel.appendChild(row(
      '🌈 โหมดล่าปลาเทพ (legendary/mythic + ปลาหนัก · อัตโนมัติ · กันขาดทุน)',
      'ความจริงเกม: ความแรร์สุ่มต่อการตก 1 ครั้ง (เหยื่อแพงช่วยน้อยมาก — บอทเล็งดาวเต็มอยู่แล้ว) → โหมดนี้เพิ่ม "โอกาส/ชม." สูงสุดแทน: '
      + 'ตกถี่สุด (บังคับ turbo) + เหยื่อถูกสุด (ต้นทุนต่ำ) + ย้ายไปแมพที่สถิติ "มูลค่าปลาเทพ/ชม." ดีสุด (เรียนรู้จากปลาที่ตกจริง · ย้ายเมื่อดีกว่า >25%) + ยา 🍀โชค/🐋หนัก อัตโนมัติ · '
      + '🛡️ กันขาดทุน: วัดกำไรสุทธิจริง (รวมค่าเหยื่อ+ยา+กาแฟ) ทุก X นาที — ติดลบ 1 รอบ = งดยา · ติดลบ 2 รอบติด = พักโหมดกลับฟาร์มปกติ + แจ้งเตือน · '
      + 'ไม่แตะค่าที่ตั้งไว้เลย (override เฉพาะตอนโหมดเปิด — ปิดปุ๊บทุกอย่างกลับเป็นค่าเดิม) · Advisor พักอัตโนมัติระหว่างล่า · หลบให้ทดสอบเหยื่อ/ล่าบอสก่อนเสมอ · สถานะ: /mythic',
      labeled('เปิด', checkbox('mythicHunt', refreshMythicBtn)),
      labeled('เหยื่อขั้น (0=ออโต้ทดสอบเอง)', numInput('mythicBait', 0, 8, 40)),
      labeled('🍀 ยาโชค', checkbox('mythicLuck')),
      labeled('🐋 ยาหนัก', checkbox('mythicWeight')),
      labeled('เช็คกำไรทุก (นาที)', numInput('mythicCheckMin', 5, 120, 48)),
      labeled('แมพเป้า', selectInput('mythicMap', [['', '🤖 อัตโนมัติ (ตามสถิติ)'], ...MYTHIC_MAPS.map(([n]) => [n, n])])),
    ));

    // ---------- ⚡ พลังงาน & ของสิ้นเปลือง ----------
    sectionHead('⚡ พลังงาน & ของสิ้นเปลือง', false);

    panel.appendChild(row(
      '⚡ จัดการพลังงาน (พักแล้วกลับมาตกเอง)',
      'พลังเหลือ ≤ เกณฑ์ล่าง = นั่งพักหยุดตก · ฟื้นถึง ≥ เกณฑ์บน = ตกต่อ · พลังฟื้นเองตอนไม่ตก (~100%/3ชม.) · "นั่งพัก" เป็นแค่ท่าทาง ไม่ได้เร่งฟื้น',
      labeled('เปิด', checkbox('energyManage')),
      labeled('พักเมื่อ ≤%', numInput('energyRestAt', 1, 99, 52)),
      labeled('ตกต่อเมื่อ ≥%', numInput('energyResumeAt', 2, 100, 52)),
      labeled('นั่งพัก(ท่าทาง)', checkbox('energySit')),
      labeled('🧪 ใช้ยาอยู่ห้ามพัก', checkbox('noRestOnBuff')),
    ));

    panel.appendChild(row(
      '🎁 เก็บเควสรายวันอัตโนมัติ (ได้พลังงาน ⚡)',
      'เควส 3 อัน/วัน (ตก 10 ตัว +30⚡ · น้ำหนัก 20กก +40⚡ · เก็บขยะ 3 +30⚡ = รวม 100⚡/วัน) · รีเซ็ตเที่ยงคืน · รับเฉพาะตอนพลัง < X% กันพลังล้นเสียเปล่า (ตั้ง 100 = รับเสมอ)',
      labeled('เปิด', checkbox('autoQuest')),
      labeled('เช็คทุก (นาที)', numInput('questEvery', 1, 240, 56)),
      labeled('รับเมื่อพลัง <%', numInput('questMaxEnergy', 1, 100, 52)),
    ));

    panel.appendChild(row(
      '🎒 ใช้ของฟรีในกระเป๋าก่อน (กาแฟ/ยา)',
      'เปิดไว้ = บอทจะ "ใช้กาแฟ/ยาที่มีในกระเป๋าก่อนเสมอ" (จากจดหมาย/รางวัล ฟรี ไม่เสียเงิน) แม้จะปิดการซื้ออัตโนมัติไว้ · '
      + 'เดิมโค้ด "ใช้ของฟรี" ถูกล่ามกับสวิตช์ "ซื้อ" → ปิดซื้อ = ของฟรีในกระเป๋าค้างทิ้ง (v6.194 แยกออกจากกัน) · '
      + 'การซื้อ (เสียเงิน) ยังคุมด้วยสวิตช์ "ซื้อกาแฟ"/"ซื้อยา" ด้านล่างตามเดิม · เงื่อนไข "คุ้มใช้ไหม" (พลัง/ขั้นเหยื่อ) ยังบังคับกับของฟรีด้วย แต่เกณฑ์เรื่องเงิน (รายได้/ชม.) ไม่บังคับ (ของฟรีไม่มีต้นทุน)',
      labeled('เปิด', checkbox('useBagConsumables')),
    ));

    panel.appendChild(row(
      '☕ ซื้อกาแฟเติมพลัง (ตกต่อเนื่อง 24 ชม.)',
      'ของใหม่ในเกม! เมื่อพลัง ≤ เกณฑ์ บอทจะเก็บเควสก่อน (ฟรี) ถ้ายังไม่พอค่อยซื้อกาแฟ ☕ (พลัง +50 · 1,500 🪙) → ตกได้ไม่หยุด · ต้นทุนกาแฟหักออกจากกำไรสุทธิให้เห็นในสรุป · แนะนำเปิด "จัดการพลังงาน" ไว้เป็น fallback ถ้าเงินไม่พอ',
      labeled('เปิด', checkbox('buyCoffee')),
      labeled('ซื้อเมื่อพลัง ≤%', numInput('coffeeAtEnergy', 1, 94, 52)),
    ));

    panel.appendChild(row(
      '🧪 ซื้อยาบัฟอัตโนมัติ (เมื่อคุ้มเท่านั้น)',
      'ต่ออายุยาเมื่อบัฟหมด — ซื้อเฉพาะตอนรายได้ ≥ เกณฑ์ (ต่ำกว่านั้นยาไม่คุ้มต้นทุน) · 🐋 ปลาตัวใหญ่ +15% ราคาขาย (คุ้มเมื่อรายได้ >27k/ชม.) · 🍀 โชคปลาแรร์ +8% (คุ้มในแมพปลาแรร์แพง) · ต้นทุนยาหักจากกำไรสุทธิให้เห็น · '
      + '"ห้ามใช้เมื่อพลัง <%" = พลังต่ำกว่านี้ไม่เปิดยา (ยาอยู่ 30 นาที — เปิดตอนพลังใกล้หมด = พักกลางบัฟ ทิ้งยาเปล่า · 0 = ปิดเกณฑ์) ใช้ทั้งฟาร์มปกติและรอบยาของทดสอบเหยื่อ · '
      + '"ซื้อเมื่อรายได้ ≥/ชม." = พื้นแข็ง ใช้ทุกโหมด (Advisor ทำให้เข้มขึ้นได้ แต่ข้ามไม่ได้) · รายได้นี้ไม่นับปลาฟลุ๊ค legendary/mythic (ตัวเดียวเคยทำเกณฑ์เพี้ยน) · '
      + '"ต้องครบทั้งคู่" = ถ้าเปิดได้ไม่ครบ 🐋+🍀 จะไม่เปิดเลย (ปิด = เปิดตัวไหนคุ้มก็เปิดตัวนั้น · ยา 2 ตัวหมดอายุคนละเวลาอยู่แล้ว จึงมีช่วงเหลือตัวเดียวเป็นปกติ)',
      labeled('เปิด', checkbox('buyPotion')),
      labeled('🐋 หนัก', checkbox('potionWeight')),
      labeled('🍀 โชค', checkbox('potionLuck')),
      labeled('ต้องครบทั้งคู่', checkbox('potionRequireBoth')),
      labeled('ซื้อเมื่อรายได้ ≥/ชม.', numInput('potionMinCph', 0, 999999, 72)),
      labeled('ห้ามใช้เมื่อพลัง <%', numInput('potionMinEnergy', 0, 95, 48)),
    ));

    panel.appendChild(row(
      '🧪 อนุญาตใช้ยาเฉพาะเหยื่อขั้นเหล่านี้',
      'ใส่ขั้นเหยื่อที่ยอมให้ต่อยา คั่นด้วยจุลภาค เช่น "5,6,7" · ว่าง = ทุกขั้น · ถ้าใส่เหยื่อขั้น "นอกรายการ" บอทจะไม่ต่อยาให้ · '
      + 'ยกเว้น: ถ้ามีบัฟค้างอยู่แล้ว (เปิดตอนอยู่ขั้นที่อนุญาต) แล้วเหยื่อขั้นนั้นหมด สลับมาขั้นนอกรายการ → บัฟเดิมยังใช้ตกต่อได้จนหมด แต่พอหมดจะไม่ต่อยาใหม่บนขั้นนอกรายการ',
      labeled('ขั้นที่ใช้ยาได้', textInput('potionBaitTiers', 'เช่น 5,6,7 (ว่าง=ทุกขั้น)', false)),
    ));

    // (v6.137 ตัดแถว "🛟 อัพเกรดทุ่นอัตโนมัติ" ออกตามผู้ใช้ — ไม่ใช้ฟีเจอร์ซื้อทุ่นแล้ว)

    // ---------- 🔧 ระบบ & กันเด้ง ----------
    sectionHead('🔧 ระบบ & กันเด้ง', false);

    panel.appendChild(row(
      '✉️ เก็บจดหมายอัตโนมัติ',
      'ของขวัญจากผู้พัฒนา/รางวัลบอสส่งเข้ากล่องจดหมาย — ต้องกด "รับของ" เองไม่งั้นค้างเฉยๆ · บอทเปิดกล่องเก็บให้ตามรอบ',
      labeled('เปิด', checkbox('autoMail')),
      labeled('เช็คทุก (นาที)', numInput('mailEvery', 30, 1440, 56)),
    ));

    panel.appendChild(row(
      '🔄 กันเด้ง & กู้คืนเมื่อเด้งออก/ค้าง',
      'กันเด้ง: หลอกเกมว่าแท็บเปิดอยู่ตลอด (ไม่เด้ง "พักจอ 5 นาที") — ต้องรีเฟรชหน้า 1 ครั้งให้มีผล · กู้คืน: เด้งออก/ค้าง = รีโหลดกลับเข้าเกมเอง (session ค้างไว้ ไม่ต้องกรอกรหัส) · เด้งไปหน้า login = แจ้งให้ล็อกอินเอง',
      labeled('กันเด้ง', checkbox('keepAlive')),
      labeled('กู้คืนอัตโนมัติ', checkbox('autoRecover')),
      labeled('ค้างเกิน (นาที)', numInput('recoverStuckMin', 2, 60, 52)),
    ));

    // ---------- 🧠 Advisor ----------
    sectionHead('🧠 ผู้ช่วยเลือกเหยื่อ & ยา (Advisor)', false);

    panel.appendChild(row(
      'ผู้ช่วยอัจฉริยะ — วิเคราะห์ทุก 5 นาทีจากสถิติจริง',
      'เทียบขั้นเหยื่อด้วย "กำไร/ครั้งแบบตัดฟลุ๊ค" (ตัด legendary/mythic ที่เกิดเท่ากันทุกขั้น) เฉพาะแมพปัจจุบัน · กติกา: ลงขั้นถูกง่าย (ชนะ ≥5/ครั้ง) ขึ้นขั้นแพงยาก (ชนะ ≥15 + ข้อมูล ≥100) เว้น ≥30 นาที/สลับ · '
      + 'ยา: 🐋 คุ้มเมื่อรายได้ ≥ ~26,700/ชม. · 🍀 ประเมินจากราคาแรร์ในแมพ · เลื่อนถ้าพลังต่ำ+ไม่มีกาแฟ · '
      + '"เปิด" = แนะนำอย่างเดียว (แจ้งจอ+Telegram) · "ให้ลงมือเอง" = สลับเหยื่อ+คุมยาให้จริง (แนะนำเปิดดูคำแนะนำก่อนสัก 1-2 วัน)',
      labeled('เปิด (แนะนำ)', checkbox('advisor')),
      labeled('🤖 ให้ลงมือเอง', checkbox('advisorAuto')),
    ));

    panel.appendChild(row(
      '🚫 ห้าม Advisor เลือกขั้นเหยื่อเหล่านี้',
      'ใส่ขั้นที่ไม่อยากให้ Advisor เลือก คั่นด้วยจุลภาค เช่น "6,7,8" (กันมันไปลองขั้นแพงที่ขาดทุน) · ว่าง = เลือกได้ทุกขั้น · ถ้าเผลอห้ามครบทุกขั้น บอทจะยกเลิกการห้ามให้เอง (กันค้าง) · หมายเหตุ: จากสถิติจริง ขั้นถูก (1-3) มักกำไรดีสุด — ปกติไม่ต้องห้ามอะไร',
      labeled('ห้ามขั้น', textInput('advisorNoTiers', 'เช่น 6,7,8 (ว่าง=ทุกขั้น)', false)),
    ));

    const advBtn = document.createElement('button');
    advBtn.textContent = '🧠 ดูคำแนะนำตอนนี้';
    advBtn.style.cssText = 'width:100%;padding:6px;border-radius:8px;border:none;background:#5a4a8a;color:#fff;font-weight:900;font-size:12px;cursor:pointer;margin-top:4px;';
    advBtn.addEventListener('click', () => {
      try {
        const a = advisorDecide();
        const t = a.lines.join('\n');
        say(t); console.log('[Tokpla Bot] Advisor\n' + t); alert(t);
      } catch (e) { logErr('Advisor ล้มเหลว', e); say('Advisor ล้มเหลว — ดู log'); }
    });
    panel.appendChild(advBtn);

    // ---------- 🪱 เหยื่อ & อุปกรณ์ ----------
    sectionHead('🪱 เหยื่อ & อุปกรณ์', false);

    panel.appendChild(row(
      '🪱 ซื้อเหยื่ออัตโนมัติเมื่อใกล้หมด',
      `บอทเลือก "ขั้นเหยื่อ" ให้เองจากกำไร/ชม.จริง (ระบบ 🔄 ด้านล่าง) — ไม่ต้องระบุขั้นเอง · แพ็คละ ${PACK_SIZE} ชิ้น เพดานสต๊อก ${BAIT_CAP} · เหรียญไม่พอ/เลเวลไม่ถึง บอทจะปิดระบบนี้ให้เอง · อยากปักขั้นเองให้ปิด 🔄 แล้วใช้ "🎣 บังคับเหยื่อ" ด้านล่าง (หรือ /bait N)`,
      labeled('เปิด', checkbox('autoBuy')),
      labeled('เหลือต่ำกว่า', numInput('buyBelow', 0, 999)),
      labeled('ซื้อ (แพ็ค)', numInput('buyPacks', 1, 9, 44)),
    ));

    panel.appendChild(row(
      '💰 ขายปลา (ตัวเลือก)',
      'ขายปลาให้หมดก่อนช่วงต่อ (ตามกฎล็อก · ปลาที่ล็อกไม่ขาย) เพื่อรับรู้รายได้/เคลียร์กระเป๋าให้บัญชีชัด · '
      + '"ก่อนซื้อเหยื่อใหม่" = ก่อนเติมเหยื่อทุกครั้ง',
      labeled('ก่อนซื้อเหยื่อใหม่', checkbox('sellBeforeBuy')),
    ));

    panel.appendChild(row(
      '🪱 ไล่ใช้สต๊อกเหยื่อเก่าก่อนซื้อใหม่',
      'เหยื่อที่ซื้อไว้แล้ว = ต้นทุนจม (ใช้ฟรี) · เปิดแล้วบอทจะ "ไล่ใช้กองเหยื่อขั้นที่รายได้/ครั้งสูงสุด (ตัดฟลุ๊ค) ก่อน" แล้วค่อยกลับไปให้ Advisor เลือก+ซื้อตามเดิม · '
      + 'ไล่เฉพาะขั้นที่คุ้ม (รายได้/ครั้ง ≥ ขั้นที่ Advisor จะเลือก) — ขั้นรายได้ต่ำ (เช่น 7/8) ไม่ไล่ เพราะตกได้น้อยกว่าขั้นถูก แนะนำ "ขายคืน 50%" ในกระเป๋าแทน · '
      + 'ระหว่างไล่จะไม่ซื้อเหยื่อเพิ่ม (ไม่งั้นไล่ไม่มีวันหมด) · '
      + '"กองใหญ่" = มีเหยื่อขั้นนั้น ≥ จำนวนที่ตั้ง',
      labeled('เปิด', checkbox('useBaitStock')),
      labeled('กองใหญ่เมื่อ ≥', numInput('baitStockMin', 20, 1000, 56)),
    ));

    panel.appendChild(row(
      '🔬 สำรวจขั้นเหยื่อเป็นระยะ (กันสถิติค้างเมื่อเกมปรับค่า)',
      'Advisor ใช้ข้อมูลล่าสุด "เฉพาะขั้นที่ตกอยู่" → ขั้นอื่นค้างข้อมูลเก่าถาวร · ถ้าเกมปรับ % แรร์ / ราคาปลา / โต๊ะดรอป บอทจะไม่มีทางรู้เลย · '
      + 'เปิดแล้ว = ทุก N ชั่วโมง บอทจะสลับไปตก "ขั้นที่ข้อมูลเก่าสุด" สั้นๆ เพื่อรีเฟรชสถิติ แล้วกลับขั้นที่ Advisor เลือก (ให้ Advisor คิดใหม่ทันทีด้วยข้อมูลสด) · '
      + '⚖️ คุมต้นทุน: ประเมิน (กำไร/ครั้งของขั้นดีสุด − ของขั้นที่จะลอง) × จำนวนครั้ง — เกินงบที่ตั้ง = ข้ามขั้นนั้นไป (ขั้นที่แย่มากจะไม่ถูกสุ่มมาเผาเงิน) · '
      + 'เคารพ "ห้าม Advisor ใช้ขั้นนี้" ด้วย · ไม่ทำงานตอนทดสอบเหยื่อ/ล่าปลาเทพ/ไล่สต๊อก',
      labeled('เปิด', checkbox('advExplore')),
      labeled('ทุกกี่ชั่วโมง', numInput('advExploreHours', 1, 72, 48)),
      labeled('ครั้งละ', numInput('advExploreCasts', 5, 300, 48)),
      labeled('งบ/รอบ 🪙', numInput('advExploreMaxCost', 0, 999999, 64)),
    ));
    {
      const eb = document.createElement('button');
      eb.setAttribute('data-tkbot', '1');
      eb.textContent = '🔬 ดูไทม์ไลน์สำรวจเหยื่อ';
      eb.style.cssText = 'padding:5px 10px;border-radius:7px;border:1px solid #4a5568;background:#2d3748;color:#e2e8f0;font-size:11px;cursor:pointer;margin:2px 3px 6px 0;';
      eb.addEventListener('click', () => {
        const cur = exploreTier ? `🔬 กำลังสำรวจขั้น ${exploreTier} (เหลือ ${exploreLeft} ครั้ง)\n\n` : '';
        showTextModal('🔬 เหตุการณ์สำรวจเหยื่อ', cur + exploreEventsText());
      });
      panel.appendChild(eb);
    }

    panel.appendChild(row(
      '🎁 เก็บหีบสมบัติในแมพเป็นระยะ',
      'เกมมีหีบสมบัติวางในแมพ (หีบไม้/หีบเงิน/สมบัติโจรสลัด) เดินไปกด E เพื่อเปิด — มีลิมิตต่อวัน · '
      + 'เปิดแล้ว = ทุก N นาที บอทจะเช็คว่ามีหีบที่ยังไม่เปิดในแมพปัจจุบันไหม ถ้ามีจะเดินไปเปิดให้ครบ แล้วกลับมาตกต่อ · '
      + 'ลำดับต่ำสุด: บอส/ธุระเมือง/ล่าปลาเทพ/ทดสอบเหยื่อ สำคัญกว่าเสมอ · ใกล้เวลาบอสจะไม่ออกไปเก็บ · '
      + 'อ่านตำแหน่งหีบจากเกมจริง (scene.chests) + ข้ามใบที่เปิดแล้ว (openedChests) + หยุดเมื่อครบลิมิตวัน (chestDailyComplete)',
      labeled('เปิด', checkbox('grabChest')),
      labeled('เช็คทุกกี่นาที', numInput('chestCheckMin', 1, 120, 56)),
    ));
    {
      const cb = document.createElement('button');
      cb.setAttribute('data-tkbot', '1');
      cb.textContent = '🎁 ดูไทม์ไลน์เก็บหีบ';
      cb.style.cssText = 'padding:5px 10px;border-radius:7px;border:1px solid #4a5568;background:#2d3748;color:#e2e8f0;font-size:11px;cursor:pointer;margin:2px 3px 6px 0;';
      cb.addEventListener('click', () => {
        let cur = '';
        try {
          const s = getPhaserScene();
          if (s) {
            const open = findChests().length, done = !!s.chestDailyComplete;
            cur = `แมพ: ${bossMapId() || '?'} · หีบที่ยังเปิดได้ตอนนี้: ${open} ใบ${done ? ' · ⛔ ครบลิมิตวันนี้แล้ว' : ''}\n\n`;
          }
        } catch {}
        showTextModal('🎁 เหตุการณ์เก็บหีบสมบัติ', cur + chestEventsText());
      });
      panel.appendChild(cb);
    }

    panel.appendChild(row(
      '🧪 ทดสอบเหยื่อ (หาขั้น+ยา+โหมดที่คุ้มสุด)',
      'ทดสอบขั้นเหยื่อที่ปลดล็อก (แม้ขั้นที่ตั้งห้ามไว้) รอบละ N ครั้ง · เลือก "โหมด": 🤖บอทตกเอง / 🎮ออโต้ของเกม / ทั้งคู่(เทียบกัน) · "รอบยา": ไม่ใช้ยา / ใช้ยา 🐋🍀 / ทั้งคู่ (เทียบยาคุ้มไหม) — รอบยาเคารพเกณฑ์ "ห้ามใช้ยาเมื่อพลังต่ำ" (เติมกาแฟก่อน ยังต่ำ = ข้ามรอบแบบทำต่อได้) · '
      + '"ข้ามขั้น" ใส่ขั้นที่ไม่อยากทดสอบ (เช่น 6,7,8 = ไม่เสียเงินทดสอบเหยื่อขั้นแพง/ขาดทุน · ว่าง = ทดสอบทุกขั้น) · '
      + 'จำนวนรอบ = ขั้น × โหมด × สถานะยา (เลือกครบ = นานมาก · เปิด ☕ กาแฟกันพลังหมด · แนะนำปิดโหมดมนุษย์พัก hBreak/hSession ตอนทดสอบ) · เก็บทุกครั้งเข้าสถิติจริง · '
      + 'ครบทุกรอบ = สรุปผล (Telegram/📊 สถานะ) + คืนค่าเหยื่อเดิม แล้วทำตาม "เมื่อครบ": ⏹ หยุดบอท / 🤖 ตกต่อโหมดบอท / 🎮 ตกต่อโหมดออโต้เกม · '
      + 'หลุดกลางคัน/รีเฟรช → "▶️ ทำต่อจากเดิม" · "🔄 เริ่มใหม่ทั้งหมด" ล้างเริ่มใหม่',
      labeled('โหมด', selectInput('testMode', [
        ['bot', '🤖 บอทตกเอง'],
        ['gameauto', '🎮 ออโต้ของเกม'],
        ['both', '🤖+🎮 ทั้งคู่ (เทียบกัน)'],
      ])),
      labeled('ครั้ง/รอบ', numInput('testCasts', 10, 500, 52)),
      labeled('รอบยา', selectInput('testBuffMode', [
        ['plain', '🚫 ไม่ใช้ยา'],
        ['buff', '🐋🍀 ใช้ยา'],
        ['both', '🐋+🚫 ทั้งคู่ (เทียบยา)'],
      ])),
      labeled('ข้ามขั้น', smallTextInput('testNoTiers', 'เช่น 6,7,8', 72)),
      labeled('ข้ามขั้นที่ขาดทุน', checkbox('testSkipLosing')),
      labeled('เมื่อครบ', selectInput('testDoneAction', [
        ['stop', '⏹ หยุดบอท'],
        ['bot', '🤖 ตกต่อ (บอท)'],
        ['gameauto', '🎮 ตกต่อ (ออโต้เกม)'],
      ])),
    ));
    const testBtnRow = document.createElement('div');
    testBtnRow.style.cssText = 'display:flex;gap:6px;margin-top:4px;flex-wrap:wrap;';
    const testCont = document.createElement('button');
    testCont.textContent = '▶️ ทำต่อจากเดิม';
    testCont.title = 'ทำต่อจากความคืบหน้าเดิม (ข้ามรอบที่เสร็จแล้ว) — ใช้เมื่อทดสอบหลุดกลางคัน/รีเฟรช';
    testCont.style.cssText = 'flex:1;min-width:110px;padding:6px;border-radius:8px;border:none;background:#2e6a5a;color:#fff;font-weight:900;font-size:12px;cursor:pointer;';
    testCont.addEventListener('click', () => void runBaitTest(true));
    const testFresh = document.createElement('button');
    testFresh.textContent = '🔄 เริ่มใหม่ทั้งหมด';
    testFresh.title = 'ล้างความคืบหน้าเดิม ทดสอบใหม่ทุกขั้นตั้งแต่ต้น';
    testFresh.style.cssText = 'flex:1;min-width:110px;padding:6px;border-radius:8px;border:none;background:#7d3ea0;color:#fff;font-weight:900;font-size:12px;cursor:pointer;';
    testFresh.addEventListener('click', () => void runBaitTest(false));
    const testStop = document.createElement('button');
    testStop.textContent = '⏹ หยุด';
    testStop.style.cssText = 'flex:0 0 60px;padding:6px;border-radius:8px;border:none;background:#8a3030;color:#fff;font-weight:900;font-size:12px;cursor:pointer;';
    testStop.addEventListener('click', () => stopTest());
    const testProg = document.createElement('button');
    testProg.textContent = '📊 สถานะ';
    testProg.title = 'ดูว่าทดสอบไปถึงไหนแล้ว (กี่ % · ขั้นไหน · เสร็จกี่รอบ) — โชว์ที่แถบสถานะล่างแผง';
    testProg.style.cssText = 'flex:0 0 70px;padding:6px;border-radius:8px;border:none;background:#3a5a80;color:#fff;font-weight:900;font-size:12px;cursor:pointer;';
    testProg.addEventListener('click', () => { const s = testStatus(); say(s); if (isOn('tgOn')) void tgSend('🧪 <b>สถานะทดสอบ</b>\n' + esc(s)); });
    testBtnRow.append(testCont, testFresh, testStop, testProg);
    panel.appendChild(testBtnRow);

    panel.appendChild(row(
      '🎣 เบ็ด / เหยื่อ ขั้นที่ใช้ (ตั้งเอง — บอทไม่เลือกให้อัตโนมัติ)',
      'บอทใช้ "ขั้นเหยื่อ" ตามที่ตั้งตรงนี้เท่านั้น (ไม่มีระบบเลือกเหยื่ออัตโนมัติแล้ว) · "บังคับ" = ถ้าเผลอสลับเหยื่อในเกม บอทจะสลับกลับมาขั้นที่ตั้งให้ · เกมไม่มีเมนูเลือกตรงๆ บอทกดสลับวนจนได้ขั้นที่ตั้ง · เบ็ดต้องซื้อมาก่อน · เหยื่อต้องมีของเหลือ · อยากรู้ขั้นไหนคุ้มสุด → ใช้ 🧪 ทดสอบเหยื่อ ด้านบน',
      labeled('บังคับเบ็ดขั้น', checkbox('forceRod')), numInput('rodTier', 1, 8, 44),
      labeled('บังคับเหยื่อขั้น', checkbox('forceBait')), numInput('baitTier', 1, 8, 44),
    ));

    const gearBtn = document.createElement('button');
    gearBtn.textContent = '🧰 เช็คอุปกรณ์ทั้งหมด';
    gearBtn.style.cssText = 'width:100%;padding:6px;border-radius:8px;border:none;background:#8a5a1e;color:#fff;font-weight:900;font-size:12px;cursor:pointer;margin-top:4px;';
    gearBtn.addEventListener('click', () => void runWhenIdle('เช็คอุปกรณ์', gearReport));
    panel.appendChild(gearBtn);

    // ---------- 💰 ขายปลา ----------
    sectionHead('💰 ขายปลาอัตโนมัติ', false);

    panel.appendChild(row(
      'เปิดระบบขาย',
      'บอทจะเปิดกระเป๋าเช็คของทุกๆ N ครั้งที่เหวี่ยง แล้วปิดกลับมาตกต่อ · "ขายขยะ" = สลับไปแท็บ 🗑️ แล้วขายขยะทั้งหมดด้วยทุกครั้ง (ขยะไม่มีล็อก)',
      labeled('เปิด', checkbox('sell')), labeled('เช็คทุก (ครั้ง)', numInput('sellEvery', 1, 999)), labeled('ขายขยะ 🗑️', checkbox('sellJunk')),
    ));

    panel.appendChild(row(
      'ขายเมื่อไหร่',
      'เข้าเงื่อนไขข้อใดข้อหนึ่งก็ขาย · ใส่ 0 = ไม่ใช้เงื่อนไขนั้น · ใส่ 0 ทั้งหมด = ขายทุกครั้งที่เช็ค · % คิดจากจำนวนช่องจริง (อัปเกรดกระเป๋าแล้วไม่ต้องมาแก้เลข)',
      labeled('กระเป๋าเต็ม (%)', numInput('sellAtPct', 0, 100, 50)),
      labeled('หรือของถึง (ชิ้น)', numInput('sellAtCount', 0, 999)),
      labeled('หรือมูลค่าถึง (🪙)', numInput('sellAtCoins', 0, 999999, 76)),
    ));

    const sel = document.createElement('select');
    sel.style.cssText = 'padding:4px 6px;border-radius:6px;border:1px solid #bba;font:inherit;font-size:12px;';
    for (const [v, t] of [['all', 'ขายทุกชนิด'], ['only', 'ขายเฉพาะที่ระบุ'], ['except', 'ขายทุกชนิด ยกเว้นที่ระบุ']]) {
      const o = document.createElement('option');
      o.value = v; o.textContent = t;
      sel.appendChild(o);
    }
    sel.value = cfg.speciesMode;
    sel.addEventListener('change', () => { cfg.speciesMode = sel.value; saveCfg(); });

    const txt = document.createElement('input');
    txt.type = 'text';
    txt.placeholder = 'เช่น ปลานิล, รองเท้าบู๊ตเก่า';
    txt.value = cfg.speciesList;
    txt.style.cssText = 'flex:1;min-width:100%;padding:4px 7px;border-radius:6px;border:1px solid #bba;font:inherit;font-size:12px;';
    txt.addEventListener('change', () => { cfg.speciesList = txt.value; saveCfg(); });
    txt.addEventListener('keydown', (e) => e.stopPropagation());

    panel.appendChild(row(
      'ขายปลาชนิดไหน',
      'พิมพ์ชื่อปลาให้ตรงกับในเกม คั่นด้วยจุลภาค (,) · กด "ดูของในกระเป๋า" เพื่อคัดลอกชื่อที่ถูกต้อง',
      sel, txt,
    ));

    // ---- ล็อกตามระดับความหายาก ----
    const locks = document.createElement('div');
    locks.style.cssText = 'display:grid;grid-template-columns:1fr 1fr;gap:2px 8px;width:100%;';
    for (const r of RARITY) {
      const l = document.createElement('label');
      l.style.cssText = 'display:flex;align-items:center;gap:5px;font-size:11.5px;font-weight:700;';
      const c = document.createElement('input');
      c.type = 'checkbox';
      c.dataset.rarity = r.key;
      c.checked = cfg.lockRarities.includes(r.key);
      c.addEventListener('change', () => {
        const set = new Set(cfg.lockRarities);
        c.checked ? set.add(r.key) : set.delete(r.key);
        cfg.lockRarities = [...set];
        saveCfg();
      });
      const s = document.createElement('span');
      s.textContent = r.label;
      s.style.color = r.color;
      s.style.textShadow = '0 0 1px rgba(0,0,0,.35)';
      l.append(c, s);
      locks.appendChild(l);
    }

    const shinyLock = document.createElement('label');
    shinyLock.style.cssText = 'display:flex;align-items:center;gap:5px;font-size:11.5px;font-weight:700;grid-column:1/-1;';
    shinyLock.append(checkbox('keepShiny'), Object.assign(document.createElement('span'), { textContent: '✨ ปลาประกายแวววาว (ทั้งชนิด)' }));
    locks.appendChild(shinyLock);

    panel.appendChild(row(
      '🔒 ล็อกไม่ให้ขาย (ติ๊ก = เก็บไว้)',
      'อ่านระดับจากสีขอบการ์ดในกระเป๋า · ปลา ✨ แยกขายไม่ได้ เกมขายรวมทั้งชนิดเสมอ จึงต้องล็อกทั้งชนิด · ถ้าอ่านระดับไม่ออก บอทจะไม่ขายชนิดนั้น · ของที่กด 🔒 ล็อกไว้ในเกมเอง บอทจะไม่ขายให้อยู่แล้ว (ทั้งขายทั้งหมด/เลือกขาย)',
      locks,
    ));

    // ---------- 📊 สถิติ & กำไร ----------
    const pfHeadEl = sectionHead('📊 สถิติ & กำไร', true);
    pfHeadEl._onOpen = refreshStatsPanel;   // เปิดหมวด = รีเฟรชตัวเลขล่าสุด

    panel.appendChild(row(
      '⚙️ ตั้งค่าสถิติ',
      'เก็บ = จำนวน records สูงสุด/ขั้น (ring buffer) · แสดง = ใช้กี่รายการล่าสุด/ขั้นในการคำนวณค่าที่โชว์ (rolling window — สะท้อน "ตอนนี้" ไม่ใช่เฉลี่ยตั้งแต่วันแรก)',
      labeled('เก็บ/ขั้น', numInput('statKeep', 30, 2000, 60)),
      labeled('แสดง/ขั้น', numInput('statWin', 10, 2000, 60)),
    ));
    panel.appendChild(row(
      '🎛️ ตัวกรองสถิติ',
      '🗺️ แมพ = ใช้เฉพาะรายการที่ตกในแมพปัจจุบัน (มีผลกับ 3 ตารางด้วย) · 🧪 ยา = มีผลกับรายงานข้อความ (ปุ่ม 🏆 / /baitstats) เท่านั้น (3 ตารางแยกใช้ยา/ไม่ใช้ยาให้อยู่แล้ว)',
      labeled('🗺️ กรองตามแมพ', checkbox('adaptFilterMap', refreshStatsPanel)),
      labeled('🧪 กรองตามยา', checkbox('adaptFilterBuff', refreshStatsPanel)),
    ));

    const pfWrap = document.createElement('div');
    pfWrap.style.cssText = 'padding:6px 0;border-top:1px solid rgba(0,0,0,.12);';
    statsBodyEl = document.createElement('div');
    refreshStatsPanel();

    const mapBtn = document.createElement('button');
    mapBtn.textContent = '🗺️ เทียบกำไรตามแมพ';
    mapBtn.style.cssText = 'width:100%;padding:6px;border-radius:8px;border:none;background:#2e6a5a;color:#fff;font-weight:900;font-size:12px;cursor:pointer;margin-top:6px;';
    mapBtn.addEventListener('click', () => { const s = mapStatsLines().replace(/<\/?b>|<\/?i>/g, ''); say(s); alert(s); });

    const pfBtns = document.createElement('div');
    pfBtns.style.cssText = 'display:flex;gap:6px;margin-top:6px;';
    const pfNow = document.createElement('button');
    pfNow.textContent = '🔄 สรุป/ส่ง';
    pfNow.style.cssText = 'flex:1;padding:5px;border-radius:8px;border:none;background:#3e7d24;color:#fff;font-weight:900;font-size:11.5px;cursor:pointer;';
    pfNow.addEventListener('click', () => {
      refreshProfit();
      const t = profitLines();
      console.log('[Tokpla Bot] สรุปกำไร\n' + t);
      if (cfg.tgProfit) void tgSend('💵 <b>สรุปกำไร</b>\n' + t);
      say('สรุปกำไรแล้ว (ดูด้านบน / Console)');
    });
    const pfReset = document.createElement('button');
    pfReset.textContent = '♻️ รีเซ็ตตัวนับ';
    pfReset.style.cssText = 'flex:1;padding:5px;border-radius:8px;border:none;background:#8a5a1e;color:#fff;font-weight:900;font-size:11.5px;cursor:pointer;';
    pfReset.addEventListener('click', () => {
      profit = { life: newLife(), recs: {} };
      saveProfit(); refreshProfit(); say('รีเซ็ตตัวนับกำไรแล้ว');
    });
    const pfBait = document.createElement('button');
    pfBait.textContent = '🏆 สถิติเหยื่อ';
    pfBait.style.cssText = 'flex:1;padding:5px;border-radius:8px;border:none;background:#2f6f55;color:#fff;font-weight:900;font-size:11.5px;cursor:pointer;';
    pfBait.addEventListener('click', () => {
      const t = baitStatsLines('hour');   // default = กำไร/ชม. (ตัวชี้ขาดฟาร์มเงิน)
      console.log('[Tokpla Bot] สถิติกำไรต่อเหยื่อ\n' + t);
      if (cfg.tgProfit) void tgSend('🏆 <b>สถิติกำไรต่อเหยื่อ</b>\n' + t);
      say('สถิติเหยื่อ (ดู Console / Telegram):\n' + t);
    });
    pfBtns.append(pfNow, pfBait, pfReset);

    // แถวตั้ง exclude (rarity/species) — ไม่นับปลาระดับ/ชนิดที่ระบุในสถิติ
    const exWrap = document.createElement('div');
    exWrap.style.cssText = 'display:flex;flex-direction:column;gap:4px;margin-top:6px;font-size:11px;font-weight:700;';
    const exTitle = document.createElement('div');
    exTitle.textContent = '🚫 ไม่นับปลาในสถิติ (กัน bias จากปลาฟลุ๊คราคาสูง):';
    exWrap.appendChild(exTitle);
    const exRow = document.createElement('div');
    exRow.style.cssText = 'display:flex;gap:8px;flex-wrap:wrap;';
    for (const r of RARITY) {
      const l = document.createElement('label');
      l.style.cssText = 'display:flex;align-items:center;gap:4px;font-size:10.5px;';
      const c = document.createElement('input');
      c.type = 'checkbox';
      c.checked = (cfg.excludeRarities || []).includes(r.key);
      c.addEventListener('change', () => {
        const set = new Set(cfg.excludeRarities || []);
        c.checked ? set.add(r.key) : set.delete(r.key);
        cfg.excludeRarities = [...set];
        saveCfg(); refreshProfit();
      });
      l.append(c, Object.assign(document.createElement('span'), { textContent: r.label, style: `color:${r.color};text-shadow:0 0 1px rgba(0,0,0,.35);` }));
      exRow.appendChild(l);
    }
    exWrap.appendChild(exRow);
    exWrap.appendChild(Object.assign(document.createElement('span'), { textContent: 'หรือชนิดปลา (คั่นด้วย ,):', style: 'font-size:10.5px;margin-top:2px;' }));
    exWrap.appendChild(textInput('excludeSpecies', 'เช่น ปลานิยาย,ปลาแรร์X', false));

    pfWrap.append(statsBodyEl, pfBtns, mapBtn, exWrap);
    panel.appendChild(pfWrap);

    // ---------- 📣 Telegram ----------
    sectionHead('📣 Telegram (แจ้งเตือน · ควบคุม)', false);

    if (!hasGM) {
      const warn = document.createElement('div');
      warn.style.cssText = 'font-size:10.5px;color:#b04a44;font-weight:700;padding:6px 0;line-height:1.4;';
      warn.textContent = '⚠️ ใช้ไม่ได้ในโหมดวางโค้ดใน Console — CSP ของเว็บบล็อกการยิง API ต้องติดตั้งผ่าน Tampermonkey';
      panel.appendChild(warn);
    }

    panel.appendChild(row(
      'เชื่อมต่อบอท Telegram',
      'สร้างบอทกับ @BotFather เอา Token มาใส่ · จากนั้นทักบอทของคุณ 1 ข้อความ แล้วกด "ดึง chat_id" · "ควบคุมผ่านแชท" = สั่งบอทด้วยคำสั่ง /help ในแชท (ระวัง: ใครมี Token ก็สั่งได้ เก็บเป็นความลับ)',
      labeled('เปิด', checkbox('tgOn')),
      labeled('ควบคุมผ่านแชท', checkbox('tgControl')),
      textInput('tgToken', 'Bot Token (123456:ABC-DEF...)', true),
      textInput('tgChat', 'chat_id (ตัวเลข)', false),
    ));

    panel.appendChild(row(
      'ห้องควบคุมแยก (ไม่บังคับ)',
      'อยากให้คำสั่งควบคุมมาคนละบอท/ห้องกับแจ้งเตือน ใส่ที่นี่ · ว่าง = ใช้บอท/ห้องเดียวกับด้านบน · เหมาะกับคุมหลายบัญชีจากบอทควบคุมตัวเดียว',
      textInput('tgControlToken', 'Control Bot Token (ว่าง = ใช้ตัวเดียวกัน)', true),
      textInput('tgControlChat', 'Control chat_id (ว่าง = ใช้ห้องเดียวกัน)', false),
    ));

    panel.appendChild(row(
      '🌍 บริดจ์แชทโลก <-> Telegram',
      'ต้องเปิด "ควบคุมผ่านแชท" ก่อน · เปิดแล้ว: แชทโลกในเกมจะส่งเข้า Telegram และพิมพ์ข้อความใน Telegram (ไม่ต้องมี /) จะส่งเข้าแชทโลก · หรือสั่ง /chat, /w ในแชท · เกมจำกัดเว้น 5 วิ/ข้อความ 200 ตัวอักษร มีกรองคำหยาบ — ระวังโดนแบนถ้าสแปม · แนะนำเปิดบัญชีเดียวที่ใช้คุย',
      labeled('เปิดบริดจ์แชท', checkbox('chatBridge')),
    ));

    const tgActions = document.createElement('div');
    tgActions.style.cssText = 'display:flex;gap:6px;padding-top:4px;';
    const idBtn = document.createElement('button');
    idBtn.textContent = '🔑 ดึง chat_id';
    idBtn.style.cssText = 'flex:1;padding:5px;border-radius:8px;border:none;background:#4a3222;color:#fff;font-weight:900;font-size:11.5px;cursor:pointer;';
    idBtn.addEventListener('click', async () => {
      say('กำลังดึง chat_id... (ต้องทักบอทของคุณก่อนอย่างน้อย 1 ข้อความ)');
      const r = await tgApi('getUpdates', { limit: 5 });
      if (!r.ok) { say(`ดึงไม่สำเร็จ: ${r.description || r.error}`); return; }
      const chat = r.result?.map((u) => u.message?.chat || u.channel_post?.chat).filter(Boolean).pop();
      if (!chat) { say('ยังไม่เห็นข้อความ — เปิดแชทบอทแล้วพิมพ์ /start ก่อน แล้วกดใหม่'); return; }
      cfg.tgChat = String(chat.id);
      saveCfg();
      panel.querySelector('input[data-text-key="tgChat"]').value = cfg.tgChat;
      say(`ได้ chat_id: ${cfg.tgChat} (${chat.first_name || chat.title || 'chat'})`);
    });
    const testBtn = document.createElement('button');
    testBtn.textContent = '✉️ ทดสอบส่ง';
    testBtn.style.cssText = 'flex:1;padding:5px;border-radius:8px;border:none;background:#3e7d24;color:#fff;font-weight:900;font-size:11.5px;cursor:pointer;';
    testBtn.addEventListener('click', async () => {
      if (!cfg.tgChat) { say('ยังไม่มี chat_id'); return; }
      const r = await tgApi('sendMessage', { chat_id: cfg.tgChat, text: '🎣 Tokpla Bot เชื่อมต่อสำเร็จแล้ว!' });
      say(r.ok ? '✅ ส่งสำเร็จ เช็คใน Telegram ได้เลย' : `❌ ${r.description || r.error}`);
      if (r.ok) { tgFails = 0; sessionOff.delete('tgOn'); syncPanel(); }
    });
    tgActions.append(idBtn, testBtn);
    panel.appendChild(tgActions);

    // เลือกระดับปลาที่จะแจ้ง
    const tgLocks = document.createElement('div');
    tgLocks.style.cssText = 'display:grid;grid-template-columns:1fr 1fr;gap:2px 8px;width:100%;';
    for (const r of RARITY) {
      const l = document.createElement('label');
      l.style.cssText = 'display:flex;align-items:center;gap:5px;font-size:11.5px;font-weight:700;';
      const c = document.createElement('input');
      c.type = 'checkbox';
      c.dataset.notify = r.key;
      c.checked = cfg.tgRarities.includes(r.key);
      c.addEventListener('change', () => {
        const set = new Set(cfg.tgRarities);
        c.checked ? set.add(r.key) : set.delete(r.key);
        cfg.tgRarities = [...set];
        saveCfg();
      });
      const sp = document.createElement('span');
      sp.textContent = r.label;
      sp.style.color = r.color;
      sp.style.textShadow = '0 0 1px rgba(0,0,0,.35)';
      l.append(c, sp);
      tgLocks.appendChild(l);
    }
    panel.appendChild(row('แจ้งเมื่อได้ปลาระดับ', 'ขยะไม่แจ้งเสมอ', tgLocks));

    panel.appendChild(row(
      'แจ้งเหตุการณ์อื่น',
      'สรุปทุกๆ (ครั้ง): ใส่ 0=ปิด · รายงานสถานะทุกๆ (นาที): ส่งสรุปว่าบอทยังรันอยู่+ผลงาน เหมาะกับรันทิ้งไว้บน VPS (0=ปิด)',
      labeled('▶️ บอทเริ่ม', checkbox('tgStart')),
      labeled('🛑 บอทหยุด', checkbox('tgStop')),
      labeled('⚠️ เหตุต้องดูแล', checkbox('tgWarn')),
      labeled('⚡ พักพลัง', checkbox('tgPause')),
      labeled('✨ SHINY', checkbox('tgShiny')),
      labeled('📖 ปลาใหม่', checkbox('tgNew')),
      labeled('🏆 สถิติใหม่', checkbox('tgRecord')),
      labeled('💰 ขาย/ซื้อ', checkbox('tgTrade')),
      labeled('💵 สรุปกำไร', checkbox('tgProfit')),
      labeled('🎉 เลเวลอัพ', checkbox('tgLevel')),
      labeled('🌧️ สภาพอากาศ', checkbox('tgWeather')),
      labeled('📊 สรุปทุกๆ (ครั้ง)', numInput('tgEvery', 0, 9999)),
      labeled('📡 รายงานทุกๆ (นาที)', numInput('tgHeartbeat', 0, 1440, 60)),
    ));

    const hbBtn = document.createElement('button');
    hbBtn.textContent = '📊 ส่งสถานะตอนนี้';
    hbBtn.style.cssText = 'width:100%;padding:5px;border-radius:8px;border:none;background:#4a3222;color:#fff;font-weight:900;font-size:11.5px;cursor:pointer;margin-top:4px;';
    hbBtn.addEventListener('click', () => { if (!cfg.tgChat) { say('ยังไม่ได้ตั้ง Telegram'); return; } void tgSend(heartbeatMsg()); say('ส่งสถานะแล้ว'); });
    panel.appendChild(hbBtn);

    // ---------- 📝 Log & รายงานปัญหา ----------
    sectionHead('📝 Log & รายงานปัญหา', false);

    const logHint = document.createElement('div');
    logHint.style.cssText = 'font-size:10.5px;opacity:.65;line-height:1.35;padding:4px 0;';
    logHint.textContent = 'บอทเก็บ log ล่าสุด 300 บรรทัด (คงอยู่แม้รีเฟรช) · เจอปัญหา → กด "📋 คัดลอกรายงานปัญหา" (อยู่ในหมวด 💾 สำรอง/กู้คืน) แล้วส่งข้อความให้ AI/ผู้พัฒนาได้เลย';
    panel.appendChild(logHint);

    logViewEl = document.createElement('textarea');
    logViewEl.readOnly = true;
    logViewEl.style.cssText = 'width:100%;height:130px;box-sizing:border-box;padding:5px;border-radius:6px;border:1px solid #bba;font-family:ui-monospace,monospace;font-size:9.5px;line-height:1.4;resize:vertical;background:#fbf3df;';
    refreshLogView();
    panel.appendChild(logViewEl);

    const logBtns = document.createElement('div');
    logBtns.style.cssText = 'display:flex;gap:6px;margin-top:4px;';
    const logRefresh = document.createElement('button');
    logRefresh.textContent = '🔄 รีเฟรช';
    logRefresh.style.cssText = 'flex:1;padding:5px;border-radius:8px;border:none;background:#2e6a5a;color:#fff;font-weight:900;font-size:11.5px;cursor:pointer;';
    logRefresh.addEventListener('click', () => refreshLogView());
    const logCopy = document.createElement('button');
    logCopy.textContent = '📋 คัดลอก log';
    logCopy.style.cssText = 'flex:1;padding:5px;border-radius:8px;border:none;background:#3e7d24;color:#fff;font-weight:900;font-size:11.5px;cursor:pointer;';
    logCopy.addEventListener('click', () => { logViewEl.focus(); logViewEl.select(); try { navigator.clipboard && navigator.clipboard.writeText(logViewEl.value); } catch {} say('คัดลอก log แล้ว (หรือกด Ctrl+C)'); });
    const logClear = document.createElement('button');
    logClear.textContent = '🗑️ ล้าง';
    logClear.style.cssText = 'flex:0 0 56px;padding:5px;border-radius:8px;border:none;background:#8a3030;color:#fff;font-weight:900;font-size:11.5px;cursor:pointer;';
    logClear.addEventListener('click', () => { logRing.length = 0; saveLog(true); refreshLogView(); say('ล้าง log แล้ว'); });
    logBtns.append(logRefresh, logCopy, logClear);
    panel.appendChild(logBtns);

    // ---------- 💾 สำรอง / กู้คืน ----------
    sectionHead('💾 สำรอง / กู้คืน (ย้าย VPS)', false);

    const bkHint = document.createElement('div');
    bkHint.style.cssText = 'font-size:10.5px;opacity:.65;line-height:1.35;padding:4px 0;';
    bkHint.textContent = 'ย้าย VPS: กด "สร้างข้อมูลสำรอง" ที่เครื่องเก่า → คัดลอกข้อความในช่อง → วางในช่องที่เครื่องใหม่ → กด "กู้คืน" · เก็บทั้งการตั้งค่า+กำไร (ข้อมูลเกมอยู่ที่บัญชี ไม่ต้องย้าย)';
    panel.appendChild(bkHint);

    const bkTa = document.createElement('textarea');
    bkTa.placeholder = 'ข้อมูลสำรองจะขึ้นตรงนี้ (หรือวางข้อมูลที่จะกู้คืน)';
    bkTa.style.cssText = 'width:100%;height:54px;box-sizing:border-box;padding:5px;border-radius:6px;border:1px solid #bba;font:inherit;font-size:10px;resize:vertical;';
    bkTa.addEventListener('keydown', (e) => e.stopPropagation());
    panel.appendChild(bkTa);

    const bkBtns = document.createElement('div');
    bkBtns.style.cssText = 'display:flex;gap:6px;margin-top:4px;';
    const bkExport = document.createElement('button');
    bkExport.textContent = '📤 สร้างข้อมูลสำรอง';
    bkExport.style.cssText = 'flex:1;padding:6px;border-radius:8px;border:none;background:#3e7d24;color:#fff;font-weight:900;font-size:11.5px;cursor:pointer;';
    // 📤 backup "ย้าย VPS" = เก็บครบทุกอย่างรวม Telegram token (ผู้ใช้สั่ง v6.126) — ต่างจาก 📋 ส่งวิเคราะห์ที่ยังตัด token
    //   ⚠️ ไฟล์นี้คุมบอทได้ (มี token) → ห้ามส่งให้ใคร · เก็บ key เรียนรู้ทั้งหมดใน extra เพื่อย้ายครบไม่ต้องเรียนรู้ใหม่
    function buildBackupJson() {
      const readLS = (k) => { try { return JSON.parse(W.localStorage.getItem(k) || 'null'); } catch { return null; } };
      return JSON.stringify({
        app: 'tokpla-bot', v: BOT_VER, ts: Date.now(), full: true,
        cfg,   // ครบทั้งก้อนรวม token
        profit: { v: PROFIT_V, life: profit.life, recs: profit.recs },
        extra: {
          mythicBait: readLS(MYTHIC_BAIT_KEY),   // เรียนรู้เหยื่อล่าปลาเทพ
          bossGraph: readLS(BOSS_GRAPH_KEY),      // กราฟเส้นทางแมพ
          mapNames: readLS(MAP_NAME_KEY),         // ชื่อแมพ↔id
          modeStats: readLS(MODESTATS_KEY),       // สถิติเทียบโหมด
        },
      });
    }
    // กู้คืนจากข้อความ backup — โยน Error พร้อมเหตุผลถ้าข้อมูลใช้ไม่ได้ (ผู้เรียกโชว์ให้ผู้ใช้)
    function applyBackupJson(txt) {
      const d = JSON.parse(txt);
      if (!d || !d.cfg) throw new Error('ไม่พบการตั้งค่าในข้อมูล (ไฟล์ไม่ใช่ backup ของบอท?)');
      // backup เก่า (ก่อน v6.126) ไม่มี token → คง token/chat เดิมของเครื่องไว้ · backup ใหม่ (full) มี token ครบ ใช้ตามนั้น
      for (const k of ['tgToken', 'tgControlToken', 'tgChat', 'tgControlChat']) if (d.cfg[k] == null && cfg[k]) d.cfg[k] = cfg[k];
      W.localStorage.setItem(CFG_KEY, JSON.stringify(d.cfg));
      if (d.profit) W.localStorage.setItem(PROFIT_KEY, JSON.stringify(d.profit));
      // กู้คืน key เรียนรู้ทั้งหมด (ย้าย VPS ครบไม่ต้องเรียนรู้ใหม่) — เขียนเฉพาะที่มีในไฟล์ (ไม่ทับของเครื่องด้วย null)
      if (d.extra) {
        const setLS = (k, val) => { if (val != null) try { W.localStorage.setItem(k, JSON.stringify(val)); } catch {} };
        setLS(MYTHIC_BAIT_KEY, d.extra.mythicBait);
        setLS(BOSS_GRAPH_KEY, d.extra.bossGraph);
        setLS(MAP_NAME_KEY, d.extra.mapNames);
        setLS(MODESTATS_KEY, d.extra.modeStats);
      }
      // 🛑 ตรึง localStorage จนกว่าจะรีโหลด — บั๊ก v6.128: beforeunload flush เคยเอาค่าว่างในหน่วยความจำทับข้อมูลที่เพิ่งกู้
      restoring = true;
      // ตรวจกลับจริงจาก localStorage (ไม่เชื่อว่าเขียนติด) + สรุปให้ผู้ใช้เห็นว่าได้อะไรมา
      const wCfg = JSON.parse(W.localStorage.getItem(CFG_KEY) || '{}');
      const wProfit = JSON.parse(W.localStorage.getItem(PROFIT_KEY) || '{}');
      const nRecs = Object.values(wProfit.recs || {}).reduce((a, l) => a + (l?.length || 0), 0);
      if (!Object.keys(wCfg).length) { restoring = false; throw new Error('เขียนข้อมูลลงเครื่องไม่ติด (localStorage เต็ม/ถูกบล็อก?)'); }
      d._summary = `ตั้งค่า ${Object.keys(wCfg).length} ค่า · สถิติปลา ${nRecs.toLocaleString()} รายการ · กำไรสะสม ${(wProfit.life?.revenue || 0).toLocaleString()}🪙${wCfg.tgToken ? ' · Telegram ✓' : ''}`;
      return d;
    }
    bkExport.addEventListener('click', () => {
      bkTa.value = buildBackupJson();
      bkTa.focus(); bkTa.select();
      say('📤 สร้าง backup ครบทุกอย่างแล้ว (รวม Telegram token + การเรียนรู้ทั้งหมด) — ⚠️ ห้ามส่งให้ใคร · แนะนำใช้ "💾 สำรองเป็นไฟล์" แทนคัดลอก (clipboard ผ่าน RDP ตัดข้อความยาวได้!)');
    });
    const bkImport = document.createElement('button');
    bkImport.textContent = '📥 กู้คืน + รีโหลด';
    bkImport.style.cssText = 'flex:1;padding:6px;border-radius:8px;border:none;background:#8a5a1e;color:#fff;font-weight:900;font-size:11.5px;cursor:pointer;';
    bkImport.addEventListener('click', () => {
      try {
        const d = applyBackupJson(bkTa.value.trim());
        say(`✅ กู้คืนแล้ว: ${d._summary} — กำลังรีโหลดหน้า...`);
        setTimeout(() => W.location.reload(), 1600);
      } catch (e) {
        say(`กู้คืนไม่สำเร็จ: ${e.message}`);
      }
    });
    bkBtns.append(bkExport, bkImport);
    panel.appendChild(bkBtns);

    // 💾/📂 สำรอง-นำเข้าเป็น "ไฟล์ .txt" (v6.127) — ทางหลักสำหรับย้าย VPS: กันปัญหา clipboard ผ่าน RDP ตัดข้อความยาว
    //   (backup มี recs หลายพันรายการ ยาวมาก — คัดลอกข้ามเครื่องแล้วขาด = กู้คืนไม่ติด/ได้ไม่ครบ โดยไม่รู้ตัว)
    const bkFileBtns = document.createElement('div');
    bkFileBtns.style.cssText = 'display:flex;gap:6px;margin-top:4px;';
    const bkSaveFile = document.createElement('button');
    bkSaveFile.textContent = '💾 สำรองเป็นไฟล์ (.txt)';
    bkSaveFile.style.cssText = 'flex:1;padding:6px;border-radius:8px;border:none;background:#2d5f8a;color:#fff;font-weight:900;font-size:11.5px;cursor:pointer;';
    bkSaveFile.addEventListener('click', () => {
      try {
        const json = buildBackupJson();
        const d = new Date();
        const pad = (n) => String(n).padStart(2, '0');
        const name = `tokpla-backup-${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}.txt`;
        const url = URL.createObjectURL(new Blob([json], { type: 'text/plain' }));
        const a = document.createElement('a');
        a.href = url; a.download = name; a.click();
        setTimeout(() => URL.revokeObjectURL(url), 5000);
        say(`💾 บันทึกไฟล์ ${name} แล้ว (${(json.length / 1024).toFixed(0)} KB) — ก็อปไฟล์นี้ไป VPS ใหม่แล้วกด "📂 นำเข้าจากไฟล์" · ⚠️ มี token ห้ามส่งให้ใคร`);
      } catch (e) { say(`สำรองเป็นไฟล์ไม่สำเร็จ: ${e.message}`); }
    });
    const bkLoadFile = document.createElement('button');
    bkLoadFile.textContent = '📂 นำเข้าจากไฟล์ + รีโหลด';
    bkLoadFile.style.cssText = 'flex:1;padding:6px;border-radius:8px;border:none;background:#6a4a8a;color:#fff;font-weight:900;font-size:11.5px;cursor:pointer;';
    const bkFilePick = document.createElement('input');
    bkFilePick.type = 'file'; bkFilePick.accept = '.txt,.json'; bkFilePick.style.display = 'none';
    bkFilePick.addEventListener('change', () => {
      const f = bkFilePick.files && bkFilePick.files[0];
      bkFilePick.value = '';   // เลือกไฟล์เดิมซ้ำได้ (change ยิงอีกครั้ง)
      if (!f) return;
      const rd = new FileReader();
      rd.onload = () => {
        try {
          const d = applyBackupJson(String(rd.result || '').trim());
          say(`✅ นำเข้าจากไฟล์แล้ว: ${d._summary} — กำลังรีโหลดหน้า...`);
          setTimeout(() => W.location.reload(), 1600);
        } catch (e) { say(`นำเข้าไม่สำเร็จ: ${e.message}`); }
      };
      rd.onerror = () => say('อ่านไฟล์ไม่สำเร็จ — ลองใหม่');
      rd.readAsText(f);
    });
    bkLoadFile.addEventListener('click', () => bkFilePick.click());
    bkFileBtns.append(bkSaveFile, bkLoadFile, bkFilePick);
    panel.appendChild(bkFileBtns);

    const bkWarn = document.createElement('div');
    bkWarn.textContent = '⚠️ backup มี Telegram token + การเรียนรู้ครบ (ไว้ย้าย VPS) — ห้ามส่งให้ใคร · ย้ายเครื่องใช้ "💾 ไฟล์" เป็นหลัก (คัดลอกผ่าน RDP ข้อความยาวขาดได้) · จะส่งให้วิเคราะห์ ใช้ "📋 เฉพาะการตั้งค่า" (ตัด token ให้)';
    bkWarn.style.cssText = 'font-size:10.5px;opacity:.75;margin:3px 2px 0;line-height:1.4;';
    panel.appendChild(bkWarn);

    // ส่งออก "เฉพาะการตั้งค่า" (ไม่มีข้อมูลกำไร/สถิติ) — เล็ก อ่านง่าย เหมาะส่งให้วิเคราะห์ว่าตั้งถูกไหม
    const cfgExport = document.createElement('button');
    cfgExport.textContent = '📋 ส่งออกเฉพาะการตั้งค่า (ไว้ส่งให้วิเคราะห์)';
    cfgExport.style.cssText = 'width:100%;padding:6px;border-radius:8px;border:none;background:#2e6a5a;color:#fff;font-weight:900;font-size:11.5px;cursor:pointer;margin-top:4px;';
    cfgExport.addEventListener('click', () => {
      // ตัดข้อมูลลับออกก่อนส่งออก (token/chat id ของ Telegram) — ไฟล์นี้ไว้ "ส่งให้คนอื่นวิเคราะห์" ห้ามมีของลับ
      const { tgToken, tgControlToken, tgChat, tgControlChat, ...safeCfg } = cfg;
      const out = JSON.stringify({ app: 'tokpla-bot-cfg', v: BOT_VER, ts: Date.now(), cfg: safeCfg }, null, 1);
      bkTa.value = out;
      bkTa.focus(); bkTa.select();
      try { navigator.clipboard && navigator.clipboard.writeText(out); } catch {}
      say('📋 ส่งออกการตั้งค่าแล้ว (เฉพาะ cfg ไม่มีข้อมูลกำไร) — คัดลอกในช่อง (Ctrl+C) แล้วส่งให้วิเคราะห์ได้เลย');
    });
    panel.appendChild(cfgExport);

    const diagBtn = document.createElement('button');
    diagBtn.textContent = '📋 คัดลอกรายงานปัญหา (ส่งให้ AI/ผู้พัฒนา)';
    diagBtn.style.cssText = 'width:100%;padding:6px;border-radius:8px;border:none;background:#8a3030;color:#fff;font-weight:900;font-size:11.5px;cursor:pointer;margin-top:4px;';
    diagBtn.addEventListener('click', () => {
      const rep = diagReport();   // สถานะ + config(ตัด token) + สรุป + log 80 บรรทัดล่าสุด
      bkTa.value = rep; bkTa.focus(); bkTa.select();
      try { navigator.clipboard && navigator.clipboard.writeText(rep); } catch {}
      say('📋 สร้างรายงานปัญหาแล้ว — คัดลอกในช่องด้านบน (Ctrl+C) แล้วส่งให้ AI/ผู้พัฒนาได้เลย');
    });
    panel.appendChild(diagBtn);

    // 📊 ส่งออกสถิติ (ปลอดภัย — ตัด token) ไว้ส่งให้ AI วิเคราะห์ · 2 แบบ: สรุป (เล็ก) / +ข้อมูลดิบ (ครบ)
    const statsBtns = document.createElement('div');
    statsBtns.style.cssText = 'display:flex;gap:6px;margin-top:4px;';
    const stExpSum = document.createElement('button');
    stExpSum.textContent = '📊 ส่งออกสถิติ (สรุป)';
    stExpSum.title = 'สรุปกำไรต่อขั้นเหยื่อ+แมพ+ยอดสะสม (ไม่มีข้อมูลดิบ) — เล็ก เหมาะวางในแชท';
    stExpSum.style.cssText = 'flex:1;padding:6px;border-radius:8px;border:none;background:#2f6f55;color:#fff;font-weight:900;font-size:11px;cursor:pointer;';
    stExpSum.addEventListener('click', () => {
      const s = statsExport(false);
      bkTa.value = s; bkTa.focus(); bkTa.select();
      try { navigator.clipboard && navigator.clipboard.writeText(s); } catch {}
      say('📊 ส่งออกสถิติ (สรุป) แล้ว — คัดลอกในช่อง (Ctrl+C) ส่งให้ AI วิเคราะห์ได้เลย');
    });
    const stExpFull = document.createElement('button');
    stExpFull.textContent = '📊 + ข้อมูลดิบ';
    stExpFull.title = 'สรุป + records ดิบทุกการตก (วิเคราะห์ลึก) — อาจใหญ่ ถ้าวางในแชทไม่ไหวให้เซฟเป็นไฟล์ .json';
    stExpFull.style.cssText = 'flex:1;padding:6px;border-radius:8px;border:none;background:#2e6a5a;color:#fff;font-weight:900;font-size:11px;cursor:pointer;';
    stExpFull.addEventListener('click', () => {
      const s = statsExport(true);
      bkTa.value = s; bkTa.focus(); bkTa.select();
      try { navigator.clipboard && navigator.clipboard.writeText(s); } catch {}
      say(`📊 ส่งออกสถิติ + ข้อมูลดิบแล้ว (${(s.length / 1024).toFixed(0)} KB) — คัดลอกในช่องส่งให้ AI · ถ้าใหญ่ไปให้เซฟเป็นไฟล์`);
    });
    statsBtns.append(stExpSum, stExpFull);
    panel.appendChild(statsBtns);

    // 🔬 เทียบโหมด บอทตกเอง vs เกมออโต้ (พลังงาน/ความเร็ว/rarity)
    const cmpBtns = document.createElement('div');
    cmpBtns.style.cssText = 'display:flex;gap:6px;margin-top:4px;';
    const cmpBtn = document.createElement('button');
    cmpBtn.textContent = '🔬 เทียบโหมด (บอท vs เกมออโต้)';
    cmpBtn.title = 'เทียบ ตกได้กี่ตัว/ชม · พลังงานลดกี่%/ตัว · ปลาแรร์กี่% ของแต่ละโหมด — ตกโหมดบอทสักพัก สลับเป็นเกมออโต้สักพัก แล้วกดดู';
    cmpBtn.style.cssText = 'flex:3;padding:6px;border-radius:8px;border:none;background:#3a5f8a;color:#fff;font-weight:900;font-size:11px;cursor:pointer;';
    cmpBtn.addEventListener('click', () => {
      const s = modeCompareText();
      bkTa.value = s; bkTa.focus(); bkTa.select();
      try { navigator.clipboard && navigator.clipboard.writeText(s); } catch {}
      say('🔬 เทียบโหมดแล้ว — ดูผลในช่องด้านบน (คัดลอกส่งให้ AI ได้)');
    });
    const cmpReset = document.createElement('button');
    cmpReset.textContent = '♻️';
    cmpReset.title = 'ล้างข้อมูลเทียบโหมด เริ่มนับใหม่';
    cmpReset.style.cssText = 'flex:1;padding:6px;border-radius:8px;border:none;background:#7a4d4d;color:#fff;font-weight:900;font-size:11px;cursor:pointer;';
    cmpReset.addEventListener('click', () => { resetModeCmp(); say('♻️ ล้างข้อมูลเทียบโหมดแล้ว เริ่มนับใหม่'); });
    cmpBtns.append(cmpBtn, cmpReset);
    panel.appendChild(cmpBtns);

    const note = document.createElement('div');
    note.style.cssText = 'font-size:10px;opacity:.55;padding-top:6px;border-top:1px solid rgba(0,0,0,.12);line-height:1.4;';
    note.textContent = 'บอทกดปุ่มในเกมเหมือนคนเล่นจริง ไม่ได้ยิง API ตรง · ตอนเปิดกระเป๋าจะหยุดตกชั่วคราว';
    panel.appendChild(note);

    wireCollapse();   // จับกลุ่ม element ระหว่างหัวข้อ แล้วผูกพับ/กาง + ตั้งสถานะเริ่มต้น
    document.body.appendChild(panel);
  }

  // ---- เปิดกระเป๋าอ่านรายชื่อของ แล้วปิด (ไม่ขาย) ----
  async function peekBag() {
    if (busy) return;
    busy = true;
    try {
      await ensureMenuOpen();   // v6.104: เมนูถูกย่อ = ปุ่มกระเป๋าหายจาก DOM
      if (!(await openBagUI())) { say('หาปุ่มกระเป๋าไม่เจอ (คีย์ลัด B ก็ไม่ผ่าน)'); return; }
      if (!await waitFor(() => readBagCount())) { say('เปิดกระเป๋าไม่สำเร็จ'); await closeMenu(); return; }
      await sleep(250);

      const bag = readBagCount();
      const total = readTotalCoins();
      const cards = readBag();
      const { want, locked, rarityOf } = pickSpecies(cards);

      say(`🎒 ${bag.count}/${bag.slots} · ${total.toLocaleString()} 🪙 · จะขาย ${want.length} ชนิด · ล็อกไว้ ${locked.size} ชนิด (ดูรายละเอียดใน Console)`);
      console.table(cards.map((c) => ({
        ชนิด: c.species,
        ระดับ: c.rarity ? RARITY_LABEL[c.rarity] : '?',
        ชิ้น: c.count,
        '✨': c.shiny ? '✨' : '',
        ผล: locked.has(c.species) ? `🔒 ${locked.get(c.species)}` : '💰 ขาย',
      })));
      console.log('[Tokpla Bot] จะขาย:', want.length ? want.join(', ') : '(ไม่มี)');
      console.log('[Tokpla Bot] ล็อกไว้:', [...locked].map(([s, why]) => `${s} (${why})`).join(', ') || '(ไม่มี)');
      await closeMenu();
    } finally {
      busy = false;
      lastCast = now();
    }
  }

  function mountUI() {
    if (!panel || !panel.isConnected) buildPanel();
    if (btn && btn.isConnected) return;

    const bar = document.createElement('div');
    bar.dataset.tkbot = '1';   // 🛡️ v6.105: UI ของบอทเอง — กัน query ชน
    bar.style.cssText = 'position:fixed;top:8px;left:50%;transform:translateX(-50%);z-index:2147483647;display:flex;gap:6px;';

    btn = document.createElement('button');
    btn.style.cssText = [
      'padding:8px 16px', 'border-radius:999px', 'border:2px solid #fff',
      'font-weight:900', 'font-size:14px', 'background:#b04a44', 'color:#fff',
      'cursor:pointer', 'box-shadow:0 3px 0 rgba(0,0,0,.3)', 'font-family:inherit',
    ].join(';');
    btn.addEventListener('click', (e) => { e.stopPropagation(); toggle(); });

    const pauseBtn = document.createElement('button');
    pauseBtn.textContent = '⏸';
    pauseBtn.title = 'พักชั่วคราว / เล่นต่อ (P)';
    pauseBtn.style.cssText = [
      'width:38px', 'border-radius:999px', 'border:2px solid #fff',
      'font-size:15px', 'background:#8a5a1e', 'color:#fff', 'cursor:pointer',
      'box-shadow:0 3px 0 rgba(0,0,0,.3)',
    ].join(';');
    pauseBtn.addEventListener('click', (e) => { e.stopPropagation(); togglePause(); });

    const gear = document.createElement('button');
    gear.textContent = '⚙️';
    gear.title = 'ตั้งค่าบอท';
    gear.style.cssText = [
      'width:38px', 'border-radius:999px', 'border:2px solid #fff',
      'font-size:15px', 'background:#4a3222', 'color:#fff', 'cursor:pointer',
      'box-shadow:0 3px 0 rgba(0,0,0,.3)',
    ].join(';');
    gear.addEventListener('click', (e) => {
      e.stopPropagation();
      panel.style.display = panel.style.display === 'none' ? 'block' : 'none';
    });

    bar.append(btn, pauseBtn, gear);
    (document.body || document.documentElement).appendChild(bar);
    updateBadge();
  }

  // ================= กู้คืนเมื่อเด้งออก/ค้าง =================
  // เกม persist session ไว้ (Supabase) → รีโหลดหน้า = กลับเข้าเกมได้เลย ไม่ต้องกรอกรหัส
  function doReload(reason) {
    let last = 0, cnt = 0;
    try { last = +(W.localStorage.getItem('tokpla_bot_reload_at') || 0); cnt = +(W.localStorage.getItem('tokpla_bot_reload_count') || 0); } catch {}
    if (Date.now() - last < 120000) return;   // กันรีโหลดรัว (ไม่เกิน 1 ครั้ง/2 นาที)
    if (cnt >= 3) {   // รีโหลดหลายรอบแล้วยังไม่หาย = ยอมแพ้ ไม่วนรีโหลดไม่จบ
      if (enabled) stopBot(`${reason} — รีโหลดหลายครั้งแล้วยังไม่หาย ต้องเช็คเอง`);
      return;
    }
    try {
      W.localStorage.setItem('tokpla_bot_reload_at', String(Date.now()));
      W.localStorage.setItem('tokpla_bot_reload_count', String(cnt + 1));
      if (enabled) W.localStorage.setItem('tokpla_bot_resume', '1');   // ให้เปิดบอทต่อหลังรีโหลด
    } catch {}
    if (cfg.tgWarn && isOn('tgOn')) void tgSend(`🔄 <b>${esc(reason)}</b> — รีโหลดกลับเข้าเกม (ตกไปแล้ว ${casts} ครั้ง)`);
    say(`🔄 ${reason} — รีโหลด...`);
    setTimeout(() => W.location.reload(), 1200);
  }

  function recoveryWatch() {
    if (!cfg.autoRecover) return;
    // 1) เด้งไปหน้า login = session หมด — ล็อกอินเองไม่ได้ (กรอกรหัส/OAuth) แจ้งให้ทำเอง
    if (/\/login/i.test(W.location.pathname)) {
      if (!loginAlerted) {
        loginAlerted = true;
        if (enabled) stopBot('โดนเด้งไปหน้า login — ต้องล็อกอินเอง (บอทกรอกรหัสให้ไม่ได้)');
        if (isOn('tgOn')) void tgSend('🔴 <b>โดนเด้งไปหน้า login</b> — session หมด ต้องล็อกอินเข้าเกมเอง');
      }
      return;
    }
    loginAlerted = false;
    // 2) modal "พักจอนาน 5 นาที" (ปุ่ม ▶ กลับเข้าเกม) = เด้งออก → รีโหลดกลับเข้า
    if (btnByText('▶ กลับเข้าเกม') || btnByText('กลับเข้าเกม')) { doReload('เด้งออกจากเกม (พักจอ)'); return; }
    // 👹 v6.112: อยู่ในถ้ำบอส = แมพตกปกติไม่ได้ → "ไม่คืบหน้า/ไม่พร้อม" เป็นเรื่องปกติ ไม่ใช่ค้าง
    //   ห้ามรีโหลด (respawn ถ้ำเดิม = วนเปล่า อย่างที่ผู้ใช้เจอ) — ให้ escapeBossCave เดินออกแทน
    if (bossMapId() === BOSS_MAP) { notReadySince = 0; return; }
    // (safeGuard) เกมไม่พร้อม/โหลดค้าง/หน้าไม่ใช่สนามตก นานเกิน 60 วิ → รีโหลด (เร็วกว่ารอ stuck)
    if (enabled && !busy && !orchestrating && !detectGameReady()) {
      if (!notReadySince) notReadySince = now();
      else if (now() - notReadySince > 15000 && now() - notReadySince < 17000) {
        gameEscape();   // ⎋ v6.165: ลอง "ปิดหน้าต่างทั้งหมด" ก่อน — ส่วนใหญ่ "ไม่พร้อม" คือมี modal บังสนามตก (ถูกกว่ารีโหลด 60 วิ)
        logInfo('⎋ เกมไม่พร้อม 15 วิ — กด Esc ปิดหน้าต่างที่บังก่อนตัดสินใจรีโหลด');
      } else if (now() - notReadySince > 60000) { notReadySince = 0; doReload('เกมไม่พร้อม/โหลดค้าง'); }
      return;
    }
    notReadySince = 0;
    // 3) เกมค้าง: บอทเปิดอยู่ ไม่ได้พักตั้งใจ (รวมพักชั่วคราวเอง) แต่ไม่มีความคืบหน้านาน
    const held = busy || orchestrating || energyResting || paused ||
      pauseUntil > now() || breakUntil > now();
    if (enabled && !held && lastProgressAt && now() - lastProgressAt > cfg.recoverStuckMin * 60000) {
      doReload('เกมค้าง (ไม่มีความคืบหน้านาน)');
    }
  }

  // กลับเข้าเกมหลังรีโหลด: เปิดบอทต่อเมื่อเกมพร้อม
  // resume ได้ 2 ทาง: (1) flag จากบอทสั่งรีโหลดเอง · (2) เกมรีเฟรชเอง แต่บอทยังเปิดอยู่เมื่อกี้ (สด < 5 นาที)
  function autoResumeAfterReload() {
    let resume = false;
    try {
      if (W.localStorage.getItem('tokpla_bot_resume') === '1') resume = true;
      else if (W.localStorage.getItem(ENABLED_KEY) === '1') {
        const at = +(W.localStorage.getItem(ENABLED_AT_KEY) || 0);
        if (Date.now() - at < RESUME_FRESH_MS) resume = true;   // เพิ่งรันอยู่ = รีเฟรชกลางคัน → รันต่อ
      }
    } catch {}
    if (!resume) return;
    // 🔄 v6.147: ไม่ล้างธงที่นี่แล้ว — persistEnabled คุมธงตามสถานะเปิด/ปิด (ล้างเฉพาะตอนปิดเอง) · ถ้า resume นี้ไม่สำเร็จ (เกมไม่พร้อม) = รอบหน้าลองใหม่
    let tries = 0;
    // 🐛 v6.221: "โลกเกมพร้อม" แม้ไม่ได้อยู่ริมบ่อ (player+แมพโหลดแล้ว ไม่ transition) — กันเคส spawn ไกลบ่อหลังรีโหลด
    //   เดิมรอเฉพาะ orb "ตกปลา (F)" (โผล่เมื่อใกล้บ่อ) → spawn ไกล = orb ไม่มา = resume ไม่ติด → บอทค้าง disabled + เตือน "ต้องล็อกอิน" ผิดๆ
    const worldReady = () => { try { const s = getPhaserScene(); return !!(s && s.player && bossMapId() && !s.transitioning && bossPlayerXY()); } catch { return false; } };
    const iv = setInterval(() => {
      tries++;
      if (qBtn('ตกปลา (F)') || (tries >= 3 && worldReady())) {   // ให้ orb (near-pond) มาก่อน 3 วิ ไม่งั้น resume จากโลกพร้อม แล้วให้ walkToPond เดินเข้าบ่อเอง
        clearInterval(iv);
        // อ่านค่าพักที่จำไว้ "ก่อน" toggle (toggle จะล้างทิ้ง) — ใช้เวลาจริง Date.now
        let savedEnd = 0, savedLabel = 'พักยาว';
        try { savedEnd = +(W.localStorage.getItem(BREAK_END_KEY) || 0); savedLabel = W.localStorage.getItem(BREAK_LABEL_KEY) || 'พักยาว'; } catch {}
        if (!enabled) toggle();
        const remain = clamp(savedEnd - Date.now(), 0, MAX_BREAK_MS);
        if (remain > 3000) {
          beginBreak(remain, savedLabel);   // ตั้ง breakUntil/breakLabel + persist ใหม่ (เผื่อรีโหลดอีก)
          sessionEndAt = breakUntil + randInt(cfg.sessionMinMin, cfg.sessionMaxMin) * 60000;
          say(`🔄 กลับเข้าเกม — พัก ${savedLabel} ต่ออีก ${Math.ceil(remain / 60000)} นาที`);
        } else { say('🔄 กลับเข้าเกมแล้ว — ตกต่อ'); }
        // 🧪 ถ้ารีเฟรชกลางการทดสอบ (ความคืบหน้าสดอยู่ < 15 นาที) → ทำต่อเองเลย (ไม่งั้นบอทฟาร์มขั้นที่การทดสอบตั้งค้างไว้)
        try {
          const tp = loadTestProgress();
          if (tp && Date.now() - (tp.ts || 0) < 15 * 60000) { say('🧪 พบการทดสอบค้างอยู่ — ทำต่อจากเดิมอัตโนมัติ'); setTimeout(() => void runBaitTest(true), 3000); }
        } catch {}
        // 👹 ถ้ารีโหลดกลางการล่าบอส (ค้างอยู่แมพอื่น) → เดินกลับบ้านให้ (ไม่งั้นฟาร์มค้างในถ้ำ/แมพผิด)
        try {
          const bs = JSON.parse(W.localStorage.getItem(BOSS_STATE_KEY) || 'null');
          if (bs && bs.phase && bs.phase !== 'idle' && bs.home && Date.now() - (bs.ts || 0) < 30 * 60000) {
            say(`👹 พบการล่าบอสค้าง (${bs.phase}) — เดินกลับ ${bs.home}`);
            setTimeout(() => { if (isOn('bossHunt')) void runBossHunt(bs.home); else clearBossState(); }, 4000);
          } else if (bs) clearBossState();
        } catch {}
      } else if (tries > 90) {   // 90 วิ ยังไม่พร้อม = อาจติดหน้า login
        clearInterval(iv);
        if (isOn('tgOn')) void tgSend('⚠️ รีโหลดแล้วเกมยังไม่พร้อม (อาจต้องล็อกอิน) — เช็คด้วย');
      }
    }, 1000);
  }

  mountUI();
  setInterval(mountUI, 2000);
  setInterval(maybeHeartbeat, 30000);   // เช็คส่งรายงานสถานะทุก 30 วิ
  setInterval(recoveryWatch, 5000);     // เฝ้าเด้งออก/ค้าง ทุก 5 วิ
  // 🧹 v6.154: กัน popup ผลตกปลา "ตกต่อ!" ค้างบังจอ (ตอนหยุดบอท/เดินทาง/ทำ NPC — ลูปตกปลาไม่ได้ปิดให้ = บัง input เดิน/คลิก)
  //   หยุด(!enabled)/orchestrate/busy → ปิดทันที · ระหว่างตกปกติ → ปิดเฉพาะถ้าค้าง >1.5วิ (เผื่อลูปหลักปิดเอง + กันชนการอ่านผลปลา readGameCatchArr)
  let catchPopupSince = 0;
  setInterval(() => {
    try {
      const cont = [...document.querySelectorAll('button')].find((b) => /^ตกต่อ/.test((b.textContent || '').trim()) && b.offsetParent !== null);
      if (!cont) { catchPopupSince = 0; return; }
      if (!catchPopupSince) catchPopupSince = now();
      if (!enabled || orchestrating || busy || now() - catchPopupSince > 1500) fireClick(cont);
    } catch {}
  }, 600);
  // 📬 v6.158: เฝ้ารับรางวัลบอสจากจดหมายอัตโนมัติ (ดู claimBossMail) — เช็คทุก 2 วิ เฉพาะตอนเปิดบอท+ไม่พัก · guard busy/minigame อยู่ในฟังก์ชัน
  setInterval(() => { try { if (enabled && !paused) void claimBossMail(); } catch {} }, 2000);
  setInterval(tgPoll, 4000);            // รับคำสั่งควบคุมผ่าน Telegram ทุก 4 วิ
  setInterval(ensureChatObserver, 3000); // ผูก/ต่อ observer แชทโลก (เมื่อเปิดโหมดบริดจ์)
  setInterval(gameEventWatch, 3000);     // เฝ้าเหตุการณ์เกม (เลเวลอัพ/สภาพอากาศ) -> แจ้ง TG
  setInterval(() => { if (enabled) persistEnabled(); }, 30000);   // heartbeat: ต่ออายุ "ยังรันอยู่" ทุก 30 วิ (ให้ freshness check ผ่านหลังรีเฟรช)
  // Flush profit + สถานะเปิด ก่อนปิด/รีโหลด (กัน catches ที่ยังไม่ throttle-save หาย + จำสถานะรันล่าสุด)
  W.addEventListener('beforeunload', () => { try { saveCfg(); saveProfit(); saveModeStats(); persistEnabled(); saveLog(true); saveTestProgress(); } catch {} });   // v6.155: เซฟ test progress ตอนรีเฟรช/ปิด (กันเทสต์หาย)
  W.addEventListener('pagehide', () => { try { saveCfg(); saveProfit(); saveModeStats(); persistEnabled(); saveLog(true); saveTestProgress(); } catch {} });
  // ดักจับ error/promise reject ที่หลุด → ลง log ring (ไว้ดูย้อนหลังเวลาบอทพังเงียบๆ)
  W.addEventListener('error', (e) => { try { logErr('JS error', e?.error?.stack || e?.message || e); } catch {} });
  W.addEventListener('unhandledrejection', (e) => { try { logErr('Promise reject', e?.reason?.stack || e?.reason); } catch {} });
  autoResumeAfterReload();

  // ⌨️ v6.164: เกมอัปเดต UI แล้ว "ยึด" ปุ่มลัดเปล่าไปหมด — B=กระเป๋า · P=ร้านค้า · C=ตัวละคร · Q=เควส · R=อันดับ · F=ตกปลา
  //   เดิมบอทใช้ B/P เปล่า → กด 1 ที "เปิด/ปิดบอท + กระเป๋าเด้ง" พร้อมกัน (เกมฟังที่ document, บอทที่ window — คนกดจริงโดนทั้งคู่)
  //   แก้: บอทเปลี่ยนเป็น Alt+B / Alt+P และ "คืนปุ่มเปล่าให้เกม" (ไม่มี Alt = ไม่ทำอะไร) · กันชนถาวรแม้เกมเพิ่มปุ่มลัดอีก
  W.addEventListener('keydown', (e) => {
    if (e.repeat || !e.altKey || e.ctrlKey || e.metaKey) return;   // ต้องกด Alt ร่วมเท่านั้น
    if (e.code !== 'KeyB' && e.code !== 'KeyP') return;
    const t = document.activeElement;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
    e.preventDefault();   // กันเบราว์เซอร์/เกมเอา Alt+B ไปใช้ต่อ
    if (e.code === 'KeyB') toggle(); else togglePause();
  });

  requestAnimationFrame(tick);
  console.log('[Tokpla Bot] v6.92 พร้อมใช้งาน — ปุ่ม 🤖 เปิด/ปิด (คีย์ B), ปุ่ม ⚙️ ตั้งค่า + 🎣โหมดตกปลา 3 แบบ (เกมauto/บอท/ปิด) + ขายอัตโนมัติ (กระเป๋าแท็บ + ขายขยะ 🗑️ + เคารพล็อกในเกม 🔒 + เก็บเควส ⚡ + สถิติเหยื่อ 🏆 ⏱️กำไร/ชม. + เลือกเหยื่อจากกำไร/ชม.จริง 🎯 + ☕ซื้อกาแฟตก 24 ชม. + 🧪ซื้อยาบัฟ + 🛟ทุ่น + ✉️จดหมาย + 🗺️สถิติแยกตามแมพ + บริดจ์แชทโลก🌍↔Telegram)');
})();
