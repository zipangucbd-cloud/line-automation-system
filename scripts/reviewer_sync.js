#!/usr/bin/env node
// ギフティング管理スプレッドシート → Notion「レビュアー実績マスター」への週次集約同期 v3
// xlsx直読み(日付の年を正確に取得)。ヘッダを信用せず値の中身で列の意味を判定する。
// 主データ=「ギフ回数」シート(1人=1行、1〜5回目ブロック) / 補完=「ギフティング」シート(3種別ブロック)
// launchd (com.user.line.reviewersync) が毎週月曜8:00に実行。キー=X ID。
require('dotenv').config();
const AdmZip = require('adm-zip');
const SHEET_ID = '1jDujnujP2dzaFNubqdUYc9DnYgP3ctM3srlQsmWJ8jc';
const XLSX_URL = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/export?format=xlsx`;
const TOKEN = process.env.NOTION_TOKEN;
const DB_ID = process.env.NOTION_REVIEWERS_DB_ID || '6fd68dd55c8f43fbaff2fddf6c324b7e';
if (!TOKEN) { console.log('NOTION_TOKEN not set; skipping'); process.exit(0); }

const H = { 'Authorization': `Bearer ${TOKEN}`, 'Notion-Version': '2022-06-28', 'Content-Type': 'application/json' };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function api(path, opts = {}, retry = 2) {
  const r = await fetch('https://api.notion.com/v1' + path, { ...opts, headers: H });
  if (r.status === 429 && retry > 0) { await sleep(1500); return api(path, opts, retry - 1); }
  const j = await r.json();
  if (!r.ok) throw new Error(`${r.status} ${JSON.stringify(j).slice(0, 200)}`);
  return j;
}

// ---- 最小xlsxパーサ ----
const unesc = (s) => s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&#10;/g, '\n');
function parseXlsx(buf) {
  const zip = new AdmZip(buf);
  const read = (p) => { const e = zip.getEntry(p); return e ? zip.readAsText(e) : null; };
  const rels = read('xl/_rels/workbook.xml.rels') || '';
  const relmap = {};
  for (const m of rels.matchAll(/Id="(rId\d+)"[^>]*Target="(worksheets\/sheet\d+\.xml)"/g)) relmap[m[1]] = 'xl/' + m[2];
  const wb = read('xl/workbook.xml') || '';
  const sheets = {};
  for (const m of wb.matchAll(/<sheet[^>]*name="([^"]+)"[^>]*r:id="(rId\d+)"[^>]*\/>/g)) if (relmap[m[2]]) sheets[unesc(m[1])] = relmap[m[2]];
  let shared = [];
  const ss = read('xl/sharedStrings.xml');
  if (ss) shared = [...ss.matchAll(/<si>([\s\S]*?)<\/si>/g)].map((m) => unesc([...m[1].matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((t) => t[1]).join('')));
  // indexOfベースの逐次スキャン(正規表現のバックトラック爆発を回避)
  function rows(name) {
    const xml = read(sheets[name]);
    if (!xml) throw new Error('sheet not found: ' + name);
    const out = [];
    let pos = 0;
    while (true) {
      const rs = xml.indexOf('<row', pos);
      if (rs === -1) break;
      const rTagEnd = xml.indexOf('>', rs);
      if (rTagEnd === -1) break;
      if (xml[rTagEnd - 1] === '/') { pos = rTagEnd + 1; continue; }
      const re = xml.indexOf('</row>', rTagEnd);
      if (re === -1) break;
      const body = xml.slice(rTagEnd + 1, re);
      pos = re + 6;
      const cells = [];
      let i = 0;
      while (true) {
        const cs = body.indexOf('<c ', i);
        if (cs === -1) break;
        const tagEnd = body.indexOf('>', cs);
        if (tagEnd === -1) break;
        const selfClose = body[tagEnd - 1] === '/';
        const attrs = body.slice(cs + 3, selfClose ? tagEnd - 1 : tagEnd);
        let inner = '';
        if (selfClose) { i = tagEnd + 1; }
        else {
          const ce = body.indexOf('</c>', tagEnd);
          if (ce === -1) { i = tagEnd + 1; continue; }
          inner = body.slice(tagEnd + 1, ce);
          i = ce + 4;
        }
        const rm2 = attrs.match(/r="([A-Z]+)\d+"/);
        if (!rm2) continue;
        let ci = 0; for (const ch of rm2[1]) ci = ci * 26 + ch.charCodeAt(0) - 64; ci--;
        let val = '';
        if (inner) {
          const vs = inner.indexOf('<v>');
          if (/t="s"/.test(attrs) && vs !== -1) {
            val = shared[parseInt(inner.slice(vs + 3, inner.indexOf('</v>', vs)), 10)] || '';
          } else if (/t="inlineStr"/.test(attrs)) {
            val = unesc([...inner.matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((t) => t[1]).join(''));
          } else if (vs !== -1) {
            val = unesc(inner.slice(vs + 3, inner.indexOf('</v>', vs)));
          }
        }
        if (val !== '') cells[ci] = val;
      }
      if (cells.length) out.push(cells);
    }
    return out;
  }
  return { rows };
}
function serialToISO(v) {
  const f = parseFloat(v);
  if (!isNaN(f) && String(v).match(/^\d+(\.\d+)?$/) && f >= 40000 && f <= 50000) {
    return new Date(Date.UTC(1899, 11, 30) + Math.round(f) * 86400000).toISOString().slice(0, 10);
  }
  const m = String(v).match(/(\d{4})[\/\-](\d{1,2})[\/\-](\d{1,2})/);
  if (m) return `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;
  return null;
}

// ---- 集約 ----
const POS = new Set(['良い', '非常に良い', 'ポジより']);
const EVALS = new Set(['良い', '非常に良い', 'ポジより', '良くない']);
const GENRES = new Set(['エロ強', 'エロ弱', '一般人', 'インフルエンサー']);
const SPEEDS = new Set(['2週間', '1か月', '2か月', '3か月以上']);
const BURIS = new Set(['〇', '✖', '凍結', '投稿削除', '？']);
const cell = (r, i) => ((i != null && r[i] != null ? r[i] : '') + '').trim();
const validId = (x) => /^[a-z0-9_]{1,15}$/.test(x);
function products(note) {
  const out = new Set(); const n = (note || '').toLowerCase();
  if (/cream|クリーム/.test(n)) out.add('CREAM');
  if (/ゴールド|gold/.test(n)) out.add('GOLD');
  if (/ライト|light/.test(n)) out.add('Light');
  if (/オリジナル|original/.test(n)) out.add('ORIGINAL');
  if (/drop|ドロップ/.test(n)) out.add('DROP');
  if (/アクメ|acme/.test(n)) out.add('ACME');
  if (/セット/.test(n)) out.add('セット');
  return [...out];
}
// 値の中身で意味を判定(ヘッダのズレ・転用に対応)
function classify(p, v) {
  if (!v) return null;
  if (/以下|以上|万垢/.test(v)) { p.fol = v.replace(/\s/g, ''); return 'fol'; }
  if (v === '〇' || /なってない/.test(v)) { p.sb = '健全'; return 'sb'; }
  if (v === '✖' || /なってる/.test(v) || v === 'シャドバン') { p.sb = 'シャドバン'; return 'sb'; }
  if (GENRES.has(v)) { p.genre = v; return 'genre'; }
  return null;
}

// ネットワークの一時的な失敗で週次ジョブが落ちないようにリトライする
async function fetchRetry(url, opts = {}, tries = 4) {
  let lastErr;
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url, opts);
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r;
    } catch (e) {
      lastErr = e;
      console.error(`fetch retry ${i + 1}/${tries}: ${e.message}`);
      await sleep(5000 * (i + 1));
    }
  }
  throw lastErr;
}

(async () => {
  const res = await fetchRetry(XLSX_URL, { redirect: 'follow' });
  const buf = Buffer.from(await res.arrayBuffer());
  const book = parseXlsx(buf);
  const K = book.rows('ギフ回数');
  const G = book.rows('ギフティング');
  const now = Date.now();
  const people = new Map();
  const get = (xid) => {
    if (!people.has(xid)) people.set(xid, { name: '', fullname: '', note: '', channel: '', evals: [], history: [], blockDates: [], giftDates: [], given: 0, reviewed: 0, fol: '', sb: '', face: '', speed: '', tokki: '', genre: '', buri: '', sai: '', caution: false, cautionWhy: [], fromKaisu: false, prods: new Set() });
    return people.get(xid);
  };
  const chFromNote = (p, note) => {
    if (p.channel) return;
    if (/公式LINE|公式ライン|LINE/i.test(note)) p.channel = '公式LINE';
    else if (/DM/i.test(note)) p.channel = 'X DM';
  };

  // ===== ギフ回数(主) =====
  const RB = [
    { note: 5, order: 9, track: 10, ship: 12, shipdate: 13, review: 15, speed: 16, imp: 17, a: 18, b: 19, face: 20, ev: 21, tokki: 22 },
    { note: 23, order: 28, track: 29, ship: 31, shipdate: 32, review: 34, speed: 35, imp: 36, a: 37, b: 38, face: 39, ev: 40 },
    { note: 43, order: 48, track: 49, ship: 51, shipdate: 52, review: 54, speed: 55, imp: 56, a: 57, b: 58, face: 59, ev: 60 },
    { note: 62, order: 67, track: 68, ship: 70, shipdate: 71, review: 73, speed: 74, imp: 75, a: 76, b: 77, face: 78, ev: 79 },
    { note: 81, order: 86, track: 87, ship: 89, shipdate: 90, review: 92, speed: 93, imp: 94, a: 95, b: 96, face: 97, ev: 98 },
  ];
  for (let i = 1; i < K.length; i++) {
    const r = K[i];
    const xid = cell(r, 3).replace(/^@/, '').toLowerCase();
    if (!validId(xid)) continue;
    const p = get(xid);
    p.fromKaisu = true;
    if (!p.name) p.name = cell(r, 2);
    if (!p.fullname) p.fullname = cell(r, 4).split(/[\/,]/)[0];
    const ch = cell(r, 0);
    if (ch === '公') p.channel = '公式LINE'; else if (ch.toUpperCase() === 'X') p.channel = 'X DM';
    for (let bi = 0; bi < RB.length; bi++) {
      const b = RB[bi];
      const note = cell(r, b.note);
      const shipped = cell(r, b.ship) === '済' || !!cell(r, b.shipdate) || !!cell(r, b.order) || !!cell(r, b.track);
      const reviewDone = cell(r, b.review) === '済';
      let ev = cell(r, b.ev);
      if (!shipped && !ev && !note) continue;
      if (ev && !EVALS.has(ev)) { classify(p, ev); ev = ''; }
      if (shipped) p.given++;
      if (reviewDone) p.reviewed++;
      if (ev) p.evals.push(ev);
      const iso = serialToISO(cell(r, b.shipdate));
      // 初回=1回目の発送日、最終=一番右の回の発送日。回次(ブロック順)で保持する(時系列順ではない)
      if (iso) p.blockDates[bi] = iso;
      const prods = products(note);
      if (shipped || ev) {
        const dStr = iso ? ` ${iso.slice(0, 10).replace(/-/g, '/')}` : '';
        p.history.push(`${bi + 1}回目:${prods.join('+') || '?'}${ev ? '(' + ev + ')' : reviewDone ? '(済)' : shipped ? '(レビュー未)' : ''}${dStr}`);
      }
      prods.forEach((x) => p.prods.add(x));
      if (note) { p.note = note; chFromNote(p, note); }
      classify(p, cell(r, b.a));
      classify(p, cell(r, b.b));
      const face = cell(r, b.face); if (face === 'あり' || face === 'なし') p.face = face;
      const sp = cell(r, b.speed); if (SPEEDS.has(sp)) p.speed = sp;
      if (b.tokki) { const t = cell(r, b.tokki); if (t && !GENRES.has(t)) p.tokki = t; else if (GENRES.has(t)) p.genre = t; }
      const imp = cell(r, b.imp);
      if (/凍結/.test(imp) || /凍結/.test(note)) { p.caution = true; p.cautionWhy.push('凍結'); }
      if (/BAD|破棄/i.test(note)) { p.caution = true; p.cautionWhy.push(note.slice(0, 12)); }
      if (shipped && !reviewDone && iso && now - new Date(iso + 'T00:00:00+09:00').getTime() > 60 * 86400000) { p.caution = true; p.cautionWhy.push(`${bi + 1}回目レビュー未のまま60日+`); }
    }
  }

  // ===== ギフティング(補完) =====
  const GB = [
    { id: 2, name: 1, fullname: 3, note: 4, ship: 11, shipdate: 12, review: 15, ev: 22, buri: 18, sai: 19, genre: 21 },
    { id: 26, name: 25, fullname: 27, note: 28, ship: 35, shipdate: 36, review: 39, ev: 46, buri: 42, sai: 43, genre: 45 },
    { id: 50, name: 49, fullname: 51, note: 52, ship: 58, shipdate: 59, review: 61, ev: 68, buri: 64, sai: 65, genre: 67 },
  ];
  for (let i = 2; i < G.length; i++) {
    const r = G[i];
    for (const b of GB) {
      const xid = cell(r, b.id).replace(/^@/, '').toLowerCase();
      if (!validId(xid)) continue;
      const p = get(xid);
      if (!p.name) p.name = cell(r, b.name);
      if (!p.fullname) p.fullname = cell(r, b.fullname).split(/[\/,]/)[0];
      const g = cell(r, b.genre); if (GENRES.has(g)) p.genre = g;
      const note = cell(r, b.note);
      if (note) chFromNote(p, note);
      const iso = serialToISO(cell(r, b.shipdate));
      if (iso) p.giftDates.push(iso);
      const bu = cell(r, b.buri); if (BURIS.has(bu) && !p.buri) p.buri = bu;
      const sa = cell(r, b.sai); if (sa === '済') p.sai = '済'; else if (sa === '未' && p.sai !== '済') p.sai = '未';
      if (bu === '✖' || bu === '投稿削除') { p.caution = true; p.cautionWhy.push('ブリ' + bu); }
      if (!p.fromKaisu) {
        const shipped = cell(r, b.ship) === '済' || !!cell(r, b.shipdate);
        let ev = cell(r, b.ev);
        if (ev && !EVALS.has(ev)) { classify(p, ev); ev = ''; }
        if (shipped) p.given++;
        if (cell(r, b.review) === '済') p.reviewed++;
        if (ev) p.evals.push(ev);
        products(note).forEach((x) => p.prods.add(x));
        if (note && !p.note) p.note = note;
        if (/凍結/.test(note)) { p.caution = true; p.cautionWhy.push('凍結'); }
        if (shipped && cell(r, b.review) !== '済' && iso && now - new Date(iso + 'T00:00:00+09:00').getTime() > 60 * 86400000) { p.caution = true; p.cautionWhy.push('レビュー未60日+'); }
      }
    }
  }

  // チャネル未確定でギフ経路情報が全く無い人 → X DM とみなす(公式LINE誘導に乗った人は備考に記録される運用のため)
  for (const p of people.values()) if (!p.channel) p.channel = 'X DM';

  console.log(`parsed: ${people.size} unique people`);
  const stats = { fol: 0, sb: 0, ch: 0, dates: 0 };
  for (const p of people.values()) { if (p.fol) stats.fol++; if (p.sb) stats.sb++; if (p.channel) stats.ch++; if (p.blockDates.filter(Boolean).length || p.giftDates.length) stats.dates++; }
  console.log(`coverage: channel=${stats.ch}, shadowban=${stats.sb}, follower=${stats.fol}, dates=${stats.dates}`);

  // ===== Notion upsert =====
  const existing = new Map();
  let cursor;
  do {
    const body = cursor ? { start_cursor: cursor, page_size: 100 } : { page_size: 100 };
    const q = await api(`/databases/${DB_ID}/query`, { method: 'POST', body: JSON.stringify(body) });
    for (const pg of q.results) {
      const t = pg.properties?.['X ID']?.title?.map((x) => x.plain_text).join('') || '';
      if (t) existing.set(t.replace(/^@/, '').toLowerCase(), pg.id);
    }
    cursor = q.has_more ? q.next_cursor : undefined;
  } while (cursor);
  console.log(`existing notion pages: ${existing.size}`);

  const sel = (v) => (v ? { select: { name: v } } : undefined);
  const txt = (v) => (v ? { rich_text: [{ text: { content: String(v).slice(0, 1900) } }] } : undefined);
  let created = 0, updated = 0, failed = 0;
  for (const [xid, p] of people) {
    const pos = p.evals.filter((e) => POS.has(e)).length;
    const neg = p.evals.length - pos;
    const props = {
      'X ID': { title: [{ text: { content: '@' + xid } }] },
      '提供回数': { number: p.given },
      'レビュー済回数': { number: p.reviewed },
      'ポジ回数': { number: pos },
      'ネガ回数': { number: neg },
      'オールポジ': { checkbox: p.evals.length > 0 && neg === 0 },
      '要注意': { checkbox: p.caution },
    };
    if (p.prods.size) props['提供商品'] = { multi_select: [...p.prods].map((n) => ({ name: n })) };
    // 初回=1回目ブロックの発送日、最終=値のある一番右のブロックの発送日(ギフ回数優先)
    const bd = p.blockDates.filter((d) => d);
    if (bd.length) {
      props['初回提供日'] = { date: { start: bd[0] } };
      props['最終提供日'] = { date: { start: bd[bd.length - 1] } };
    } else if (p.giftDates.length) {
      const sorted = [...p.giftDates].sort();
      props['初回提供日'] = { date: { start: sorted[0] } };
      props['最終提供日'] = { date: { start: sorted[sorted.length - 1] } };
    }
    const tokki = [p.tokki, ...new Set(p.cautionWhy)].filter(Boolean).join(' / ');
    const opt = {
      'アカウント名': txt(p.name), '評価履歴': txt(p.history.join(' → ') || p.evals.join('→')),
      '氏名': txt(p.fullname), '備考': txt(p.note), '特記': txt(tokki),
      'チャネル': sel(p.channel), 'フォロワー帯': sel(/以下|以上|万垢/.test(p.fol) ? p.fol : ''),
      'シャドバン': sel(p.sb), '顔出し': sel(p.face), 'ジャンル': sel(p.genre),
      'ブリ': sel(p.buri), '再提供': sel(p.sai), '投稿スピード': sel(p.speed),
    };
    for (const [k, v] of Object.entries(opt)) if (v) props[k] = v;
    try {
      if (existing.has(xid)) { await api(`/pages/${existing.get(xid)}`, { method: 'PATCH', body: JSON.stringify({ properties: props }) }); updated++; }
      else { await api('/pages', { method: 'POST', body: JSON.stringify({ parent: { database_id: DB_ID }, properties: props }) }); created++; }
    } catch (e) { failed++; if (failed <= 5) console.error(`fail @${xid}:`, e.message); }
    await sleep(310);
  }
  console.log(`${new Date().toISOString()} reviewer sync done: ${people.size} people, created=${created}, updated=${updated}, failed=${failed}`);
})().catch((e) => { console.error('reviewer sync failed:', e.message); process.exit(1); });
