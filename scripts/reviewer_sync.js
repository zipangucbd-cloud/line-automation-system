#!/usr/bin/env node
// ギフティング管理スプレッドシート → Notion「レビュアー実績マスター」への週次集約同期
// 主データ=「ギフ回数」シート(1人=1行、1〜5回目の提供ブロック横伸び、フォロワー帯/シャドバン/顔出し/評価つき)
// 補完データ=「ギフティング」シート(ジャンル/ブリ/再提供、ギフ回数に載っていない人)
// launchd (com.user.line.reviewersync) が毎週月曜8:00に実行。キー=X ID。
require('dotenv').config();
const SHEET_ID = '1jDujnujP2dzaFNubqdUYc9DnYgP3ctM3srlQsmWJ8jc';
const URL_KAISU = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/gviz/tq?tqx=out:csv&sheet=${encodeURIComponent('ギフ回数')}`;
const URL_GIFT = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/export?format=csv`;
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
function parseCSV(text) {
  const rows = []; let row = [], field = '', inQ = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQ) {
      if (ch === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else inQ = false; }
      else field += ch;
    } else {
      if (ch === '"') inQ = true;
      else if (ch === ',') { row.push(field); field = ''; }
      else if (ch === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
      else if (ch !== '\r') field += ch;
    }
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows;
}
const POS = new Set(['良い', '非常に良い', 'ポジより']);
const cell = (r, i) => ((r[i] || '') + '').trim();
const validId = (x) => /^[a-z0-9_]{1,15}$/.test(x);
function products(note) {
  const out = new Set();
  const n = (note || '').toLowerCase();
  if (/cream|クリーム/.test(n)) out.add('CREAM');
  if (/ゴールド|gold/.test(n)) out.add('GOLD');
  if (/ライト|light/.test(n)) out.add('Light');
  if (/オリジナル|original/.test(n)) out.add('ORIGINAL');
  if (/drop|ドロップ/.test(n)) out.add('DROP');
  if (/アクメ|acme/.test(n)) out.add('ACME');
  if (/セット/.test(n)) out.add('セット');
  return [...out];
}
function parseDate(s) {
  if (!s) return null;
  const m = String(s).match(/(\d{4})[\/\-](\d{1,2})[\/\-](\d{1,2})/);
  if (!m) return null;
  return new Date(`${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}T00:00:00+09:00`);
}
const DAYS60 = 60 * 24 * 60 * 60 * 1000;

(async () => {
  const [csvK, csvG] = await Promise.all([
    fetch(URL_KAISU, { redirect: 'follow' }).then((r) => r.text()),
    fetch(URL_GIFT, { redirect: 'follow' }).then((r) => r.text()),
  ]);
  const K = parseCSV(csvK); // ギフ回数(1行目ヘッダ)
  const G = parseCSV(csvG); // ギフティング(2行ヘッダ)
  const now = Date.now();
  const people = new Map();
  const get = (xid) => {
    if (!people.has(xid)) people.set(xid, { name: '', fullname: '', note: '', channel: '', evals: [], history: [], dates: [], given: 0, reviewed: 0, fol: '', sb: '', face: '', speed: '', tokki: '', genre: '', buri: '', sai: '', caution: false, cautionWhy: [], fromKaisu: false });
    return people.get(xid);
  };

  // ===== ギフ回数(主) =====
  const RB = [
    { note: 5, order: 9, track: 10, ship: 12, shipdate: 13, review: 15, speed: 16, imp: 17, fol: 18, sb: 19, face: 20, ev: 21, tokki: 22 },
    { note: 23, order: 28, track: 29, ship: 31, shipdate: 32, review: 34, speed: 35, imp: 36, fol: 37, sb: 38, face: 39, ev: 40 },
    { note: 43, order: 48, track: 49, ship: 51, shipdate: 52, review: 54, speed: 55, imp: 56, fol: 57, sb: 58, face: 59, ev: 60 },
    { note: 62, order: 67, track: 68, ship: 70, shipdate: 71, review: 73, speed: 74, imp: 75, buri: 76, sb: 77, face: 78, ev: 79 },
    { note: 81, order: 86, track: 87, ship: 89, shipdate: 90, review: 92, speed: 93, imp: 94, buri: 95, sb: 96, face: 97, ev: 98 },
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
      const ev = cell(r, b.ev);
      const reviewDone = cell(r, b.review) === '済';
      if (!shipped && !ev && !note) continue;
      if (shipped) p.given++;
      if (reviewDone) p.reviewed++;
      if (ev) p.evals.push(ev);
      const sd = parseDate(cell(r, b.shipdate));
      if (sd) p.dates.push(sd.getTime());
      const sdStr = sd ? `${sd.getFullYear()}/${sd.getMonth() + 1}/${sd.getDate()}` : '';
      const prods = products(note);
      if (shipped || ev) p.history.push(`${bi + 1}回目:${prods.join('+') || '?'}${ev ? '(' + ev + ')' : reviewDone ? '(済)' : shipped ? '(レビュー未)' : ''}${sdStr ? ' ' + sdStr : ''}`);
      prods.forEach((x) => (p.prods = p.prods || new Set()) && p.prods.add(x));
      if (note) p.note = note;
      const fol = cell(r, b.fol); if (fol) p.fol = fol;
      const sb = cell(r, b.sb);
      if (sb) p.sb = /なってない|〇/.test(sb) ? '健全' : 'シャドバン';
      const face = cell(r, b.face); if (face === 'あり' || face === 'なし') p.face = face;
      const sp = cell(r, b.speed); if (sp) p.speed = sp;
      if (b.tokki) { const t = cell(r, b.tokki); if (t) p.tokki = t; }
      if (b.buri) { const bu = cell(r, b.buri); if (bu) p.buri = bu; }
      const imp = cell(r, b.imp);
      if (/凍結/.test(imp) || /凍結/.test(note)) { p.caution = true; p.cautionWhy.push('凍結'); }
      if (/BAD|破棄/i.test(note)) { p.caution = true; p.cautionWhy.push(note.slice(0, 12)); }
      if (shipped && !reviewDone && sd && now - sd.getTime() > DAYS60) { p.caution = true; p.cautionWhy.push(`${bi + 1}回目レビュー未のまま60日+`); }
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
      const g = cell(r, b.genre); if (g) p.genre = g;
      const gsd = parseDate(cell(r, b.shipdate));
      if (gsd) p.dates.push(gsd.getTime());
      const bu = cell(r, b.buri); if (bu && !p.buri) p.buri = bu;
      const sa = cell(r, b.sai); if (sa === '済') p.sai = '済'; else if (sa === '未' && p.sai !== '済') p.sai = '未';
      if (bu === '✖' || bu === '投稿削除') { p.caution = true; p.cautionWhy.push('ブリ' + bu); }
      if (!p.fromKaisu) {
        const note = cell(r, b.note);
        const shipped = cell(r, b.ship) === '済' || !!cell(r, b.shipdate);
        const ev = cell(r, b.ev);
        if (shipped) p.given++;
        if (cell(r, b.review) === '済') p.reviewed++;
        if (ev) p.evals.push(ev);
        const prods = products(note);
        prods.forEach((x) => (p.prods = p.prods || new Set()) && p.prods.add(x));
        if (note && !p.note) p.note = note;
        if (/凍結/.test(note)) { p.caution = true; p.cautionWhy.push('凍結'); }
        const sd = parseDate(cell(r, b.shipdate));
        if (shipped && cell(r, b.review) !== '済' && sd && now - sd.getTime() > DAYS60) { p.caution = true; p.cautionWhy.push('レビュー未60日+'); }
      }
    }
  }

  console.log(`parsed: ${people.size} unique people`);

  // ===== Notion upsert =====
  const existing = new Map();
  let cursor;
  do {
    const body = cursor ? { start_cursor: cursor, page_size: 100 } : { page_size: 100 };
    const res = await api(`/databases/${DB_ID}/query`, { method: 'POST', body: JSON.stringify(body) });
    for (const pg of res.results) {
      const t = pg.properties?.['X ID']?.title?.map((x) => x.plain_text).join('') || '';
      if (t) existing.set(t.replace(/^@/, '').toLowerCase(), pg.id);
    }
    cursor = res.has_more ? res.next_cursor : undefined;
  } while (cursor);
  console.log(`existing notion pages: ${existing.size}`);

  const sel = (v) => (v ? { select: { name: v } } : undefined);
  const txt = (v) => (v ? { rich_text: [{ text: { content: String(v).slice(0, 1900) } }] } : undefined);
  const GENRES = new Set(['エロ強', 'エロ弱', '一般人', 'インフルエンサー']);
  const BURIS = new Set(['〇', '✖', '凍結', '投稿削除', '？']);
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
    if (p.prods && p.prods.size) props['提供商品'] = { multi_select: [...p.prods].map((n) => ({ name: n })) };
    if (p.dates.length) {
      const fmt = (t) => new Date(t + 9 * 3600 * 1000).toISOString().slice(0, 10);
      props['初回提供日'] = { date: { start: fmt(Math.min(...p.dates)) } };
      props['最終提供日'] = { date: { start: fmt(Math.max(...p.dates)) } };
    }
    const tokki = [p.tokki, ...new Set(p.cautionWhy)].filter(Boolean).join(' / ');
    const opt = {
      'アカウント名': txt(p.name), '評価履歴': txt(p.history.join(' → ') || p.evals.join('→')),
      '氏名': txt(p.fullname), '備考': txt(p.note), '特記': txt(tokki),
      'チャネル': sel(p.channel), 'フォロワー帯': sel(p.fol), 'シャドバン': sel(p.sb || (p.fromKaisu ? '' : '')),
      '顔出し': sel(p.face), 'ジャンル': sel(GENRES.has(p.genre) ? p.genre : ''),
      'ブリ': sel(BURIS.has(p.buri) ? p.buri : ''), '再提供': sel(p.sai),
      '投稿スピード': sel(['2週間', '1か月', '2か月', '3か月以上'].includes(p.speed) ? p.speed : ''),
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
