#!/usr/bin/env node
// 🔴 ตัวตรวจ "ใช้ตัวแปรก่อนบรรทัดที่ประกาศ" (TDZ) — ต้องรันทุกครั้งหลังแก้โค้ด
//
// ทำไมต้องมี: `node --check` จับไม่ได้ เพราะไวยากรณ์ **ถูกต้อง** — JS โยน error ตอนรันเท่านั้น
//   ("Cannot access 'x' before initialization") และเฉพาะตอนที่โค้ดเดินมาถึงบรรทัดนั้นจริง ๆ
//
// เคสจริงที่ทำให้ต้องเขียนตัวนี้ (v6.355 → พังยาวถึง v6.360, เจอตอนผู้ใช้แจ้งสด):
//   v6.355 แทรก `if (snapBossName || hudMeta.name) recordBossRota(...)` ไว้ **เหนือ**
//   บรรทัด `let snapWeak = [], …, snapBossName = null, …` ในฟังก์ชัน `bossFight`
//   ⇒ ทุกครั้งที่เข้าถ้ำแล้วเจอบอส: throw → ตัวเรียกจับ error → retry → **วนไม่จบ ไม่ได้ตีบอสทั้งรอบ**
//   อาการที่ผู้ใช้เห็น: "บอทไม่ตีบอส เปลี่ยนเหยื่อและเบ็ดไม่หยุด"
//
// วิธีตรวจ: หาฟังก์ชันระดับบนสุด → ดูตัวแปรที่ประกาศด้วย let/const ที่ระดับตัวฟังก์ชัน →
//   ถ้ามีการอ้างชื่อนั้น **ก่อน** บรรทัดประกาศ และการอ้างนั้น **ไม่ได้อยู่ใน closure** = ฟ้อง
//   (อยู่ใน closure ไม่นับ เพราะ closure ถูก "เรียก" ทีหลัง ตอนนั้นตัวแปรพร้อมแล้ว)
//
// ใช้: node tools/check-order.js [ไฟล์]      · exit 1 = เจอปัญหา

const fs = require('fs');
const path = process.argv[2] || require('path').join(__dirname, '..', 'tokpla-autofish.user.js');
const SRC = fs.readFileSync(path, 'utf8');

// ① ลบคอมเมนต์ + สตริง (แทนที่ด้วยช่องว่าง คงเลขบรรทัด/ตำแหน่งเดิมไว้ทุกตัวอักษร)
//    จำเป็น เพราะชื่อตัวแปรที่โผล่ในคอมเมนต์/ข้อความ ไม่ใช่การใช้งานจริง
// 🔴 บทเรียน 4 ส.ค. 2026 — **ตัวตรวจนี้ตาบอดได้เงียบ ๆ**
//   โค้ดจริงมีบรรทัด `/ตารางบอส|Today's boss rounds/.test(...)` — เครื่องหมาย ' อยู่ใน **regex literal**
//   แต่ตัวลอกสตริงเดิมไม่รู้จัก regex → นับ ' นั้นเป็น "จุดเริ่มสตริง" แล้วกลืนโค้ดที่เหลือทั้งไฟล์
//   ⇒ จำนวนฟังก์ชันที่สแกนได้ร่วงจาก **406 → 145** แต่ยังพิมพ์ "✅ ไม่พบ..." เหมือนเดิม
//   ⇒ เครื่องมือที่มีไว้ "ตรวจอีกรอบ" กลายเป็นตัวให้ความมั่นใจปลอม ซึ่งอันตรายกว่าไม่มีเครื่องมือเลย
//   แก้ 2 ชั้น: (1) รู้จัก regex literal (2) เตือนเมื่อจำนวนฟังก์ชันร่วงผิดปกติ (ดูท้ายไฟล์)
function stripNoise(s) {
  let out = '', i = 0;
  const n = s.length;
  // regex literal เริ่มได้เฉพาะตำแหน่งที่ "คาดว่าเป็นค่า" — ดูตัวอักษรที่ไม่ใช่ช่องว่างตัวก่อนหน้า
  //   `a / b` = หาร (ตัวก่อนหน้าเป็นตัวแปร/วงเล็บปิด) · `(/re/)` `=/re/` `,/re/` `!/re/` = regex
  const prevMeaning = (k) => { let j = k - 1; while (j >= 0 && /\s/.test(s[j])) j--; return j >= 0 ? s[j] : ''; };
  // ⚠️ ต้อง **แคบไว้ก่อน**: ถ้าเผลอมองตัวหารเป็น regex จะกลืนโค้ดจริงทิ้ง (วัดแล้ว: ชุดกว้างไป 408→376 ฟังก์ชัน)
  //   เอาเฉพาะตำแหน่งที่ "เป็นค่าแน่ ๆ" — หลัง ( , = : ! & | ? ; เท่านั้น
  const REGEX_OK_AFTER = '(,=:!&|?;';
  while (i < n) {
    const c = s[i], c2 = s[i + 1];
    if (c === '/' && c2 === '/') { while (i < n && s[i] !== '\n') { out += ' '; i++; } continue; }
    if (c === '/' && c2 === '*') {
      out += '  '; i += 2;
      while (i < n && !(s[i] === '*' && s[i + 1] === '/')) { out += (s[i] === '\n' ? '\n' : ' '); i++; }
      out += '  '; i += 2; continue;
    }
    if (c === '/' && REGEX_OK_AFTER.includes(prevMeaning(i))) {
      let j = i + 1, cls = false, closed = false;
      for (; j < n; j++) {
        const d = s[j];
        if (d === '\\') { j++; continue; }
        if (d === '\n') break;                 // regex ข้ามบรรทัดไม่ได้ = ไม่ใช่ regex จริง
        if (cls) { if (d === ']') cls = false; continue; }
        if (d === '[') { cls = true; continue; }
        if (d === '/') { closed = true; break; }
      }
      if (closed) { out += ' '.repeat(j - i + 1); i = j + 1; continue; }
      // ปิดไม่ลง = ไม่ใช่ regex (เช่นตัวหาร) → ปล่อยให้ไหลไปเป็นตัวอักษรธรรมดา
    }
    if (c === '"' || c === "'" || c === '`') {
      const q = c; out += ' '; i++;
      while (i < n && s[i] !== q) {
        if (s[i] === '\\') { out += '  '; i += 2; continue; }
        out += (s[i] === '\n' ? '\n' : ' '); i++;
      }
      out += ' '; i++; continue;
    }
    out += c; i++;
  }
  return out;
}

// ② ตำแหน่งไหนอยู่ "ใน closure" บ้าง — เดินทีละตัวอักษร เก็บ stack ของบล็อก
//    บล็อกไหนที่ `{` ตัวเปิดมาจากฟังก์ชัน (`=> {` หรือ `function …(…) {`) ถือเป็น closure
function closureDepthMap(body) {
  const depth = new Int16Array(body.length);
  const stack = [];
  let fnCount = 0;
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (c === '{') {
      let j = i - 1;
      while (j >= 0 && /\s/.test(body[j])) j--;
      let isFn = body[j] === '>' && body[j - 1] === '=';        // arrow: `=> {`
      if (!isFn && body[j] === ')') {                            // อาจเป็น `function name(args) {`
        let d = 0, k = j;
        for (; k >= 0; k--) { if (body[k] === ')') d++; else if (body[k] === '(') { d--; if (!d) break; } }
        const head = body.slice(Math.max(0, k - 40), k);
        isFn = /\bfunction\b[\w\s$]*$/.test(head);
      }
      stack.push(isFn);
      if (isFn) fnCount++;
    }
    depth[i] = fnCount;
    if (c === '}') { const was = stack.pop(); if (was) fnCount--; }
  }
  return depth;
}

const CLEAN = stripNoise(SRC);
const lineOf = (idx) => SRC.slice(0, idx).split('\n').length;

// ③ ฟังก์ชันระดับบนสุดของ IIFE (ย่อหน้า 2 ช่อง)
//    ⚠️ ต้องหาจุดจบด้วย **การนับวงเล็บปีกกาจริง** ห้ามใช้ indexOf('\n  }\n')
//    (เวอร์ชันแรกของไฟล์นี้ใช้ indexOf แล้ว "จับบั๊กที่มีอยู่จริงไม่ได้" เพราะตัวฟังก์ชันยาว ๆ
//     เจอ `\n  }\n` ของโครงสร้างข้างในก่อน → ตัดตัวฟังก์ชันสั้นกว่าจริง → บรรทัดประกาศหลุดออกนอกขอบเขต)
const fns = [];
{
  const re = /^  (?:async )?function (\w+)\s*\(/gm;
  let m;
  while ((m = re.exec(CLEAN))) {
    const start = m.index;
    const open = CLEAN.indexOf('{', re.lastIndex);
    if (open < 0) continue;
    let d = 0, end = -1;
    for (let i = open; i < CLEAN.length; i++) {
      if (CLEAN[i] === '{') d++;
      else if (CLEAN[i] === '}') { d--; if (!d) { end = i; break; } }
    }
    // ⚠️ ตัดจาก **หลัง** `{` ของตัวฟังก์ชันเอง — ไม่งั้นปีกกาตัวนั้นถูกนับเป็น closure ชั้นหนึ่ง
    //    ทำให้ทุกบรรทัดในฟังก์ชันมี depth ≥ 1 = ถูกมองว่า "อยู่ใน closure" แล้วข้ามหมด (ตัวตรวจเงียบสนิท)
    if (end > open) fns.push({ name: m[1], start: open + 1, body: CLEAN.slice(open + 1, end) });
  }
}

// แยกรายการประกาศด้วยลูกน้ำ "ระดับบนสุด" เท่านั้น — ห้ามตัดลูกน้ำที่อยู่ใน {} [] ()
//   (ไม่งั้น `const rec = { fish, rarity, price }` จะถูกอ่านว่าประกาศ 3 ตัวชื่อ fish/rarity/price)
function topLevelNames(decl) {
  const parts = [];
  let d = 0, cur = '';
  for (const ch of decl) {
    if ('([{'.includes(ch)) d++;
    else if (')]}'.includes(ch)) d--;
    if (ch === ',' && d === 0) { parts.push(cur); cur = ''; continue; }
    cur += ch;
  }
  parts.push(cur);
  return parts.map((s) => {
    let d2 = 0;
    for (let i = 0; i < s.length; i++) {                          // ตัดที่ '=' ระดับบนสุด
      const ch = s[i];
      if ('([{'.includes(ch)) d2++;
      else if (')]}'.includes(ch)) d2--;
      else if (ch === '=' && !d2) return s.slice(0, i).trim();
    }
    return s.trim();
  }).filter((s) => /^[A-Za-z_$][\w$]*$/.test(s));
}

const bad = [];
for (const f of fns) {
  const depth = closureDepthMap(f.body);
  // ประกาศที่ระดับตัวฟังก์ชันพอดี (ย่อหน้า 4 ช่อง) — ที่ลึกกว่านั้นเป็นขอบเขตย่อย ไม่เทียบ
  const re = /^ {4}(?:let|const) ([^\n;=]*(?:=[^\n;]*)?);?$/gm;
  let m;
  while ((m = re.exec(f.body))) {
    const declAt = m.index;
    if (depth[declAt]) continue;                                 // ตัวประกาศเองอยู่ใน closure = คนละขอบเขต
    for (const nm of topLevelNames(m[1])) {
      // ชื่อเดียวกันถูกประกาศหลายที่ในฟังก์ชัน = มีขอบเขตย่อยบังกันอยู่ (เช่น `const out` ในสอง if คนละอัน)
      //   แยกไม่ออกด้วยการอ่านตัวอักษร → ไม่เดา ข้ามไป (ยอมพลาดดีกว่าส่งเสียงหลอกจนคนเลิกเชื่อเครื่องมือ)
      const declCount = (f.body.match(new RegExp('\\b(?:let|const|var)\\s[^\\n;]*\\b' + nm + '\\b', 'g')) || []).length;
      if (declCount > 1) continue;
      const use = new RegExp('\\b' + nm + '\\b', 'g');
      let u;
      while ((u = use.exec(f.body)) && u.index < declAt) {
        if (depth[u.index]) continue;                            // ใช้ใน closure = ถูกเรียกทีหลัง ปลอดภัย
        if (f.body[u.index - 1] === '.') continue;               // `z.cx` = property ไม่ใช่ตัวแปร
        const after = f.body.slice(u.index + nm.length).match(/^\s*:/);
        if (after) continue;                                     // `{ cx: … }` = คีย์ของ object
        bad.push({ fn: f.name, name: nm, useLine: lineOf(f.start + u.index), declLine: lineOf(f.start + declAt) });
        break;
      }
    }
  }
}

// 🛡️ ชั้นที่ 2 ของบทเรียน 4/8/2026: **เตือนเมื่อจำนวนฟังก์ชันร่วงผิดปกติ**
//   ถ้าตัวลอกสตริงเสียหายอีก (เจอไวยากรณ์ที่ยังไม่รู้จัก) จำนวนจะร่วงฮวบ — ต้องดังพอให้คนเห็น
//   เก็บค่าสูงสุดที่เคยสแกนได้ไว้ข้าง ๆ ตัวเอง (ไม่ hardcode ตัวเลข = ไม่เน่าเมื่อไฟล์โตขึ้น)
{
  const memo = require('path').join(__dirname, '.check-order-count');
  let prev = 0;
  try { prev = parseInt(fs.readFileSync(memo, 'utf8').trim(), 10) || 0; } catch {}
  if (prev && fns.length < prev * 0.8) {
    console.error(`🔴 สแกนได้แค่ ${fns.length} ฟังก์ชัน (เคยได้ ${prev}) — ตัวลอกสตริง/คอมเมนต์น่าจะหลุด`);
    console.error('   ⇒ ผลตรวจรอบนี้ "เชื่อไม่ได้" · หาไวยากรณ์แปลก ๆ ที่เพิ่งเพิ่ม (regex ที่มี \' หรือ backtick ฯลฯ)');
    process.exit(2);
  }
  if (fns.length > prev) { try { fs.writeFileSync(memo, String(fns.length)); } catch {} }
}

if (!bad.length) {
  console.log(`✅ ไม่พบการใช้ตัวแปรก่อนประกาศ (สแกน ${fns.length} ฟังก์ชัน)`);
  process.exit(0);
}
console.log(`❌ พบ ${bad.length} จุดที่ใช้ตัวแปรก่อนบรรทัดที่ประกาศ (จะพังตอนรันจริง):`);
for (const b of bad) console.log(`   ${b.fn}(): ใช้ '${b.name}' ที่บรรทัด ${b.useLine} แต่ประกาศที่บรรทัด ${b.declLine}`);
process.exit(1);
