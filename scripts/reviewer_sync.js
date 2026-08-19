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
// Notion API: レート制限だけでなくネットワークの一時的な失敗でも再試行する
async function api(path, opts = {}, tries = 5) {
  let lastErr;
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch('https://api.notion.com/v1' + path, { ...opts, headers: H });
      if (r.status === 429 || r.status >= 500) { await sleep(2000 * (i + 1)); continue; }
      const j = await r.json();
      if (!r.ok) throw new Error(`${r.status} ${JSON.stringify(j).slice(0, 200)}`);
      return j;
    } catch (e) {
      lastErr = e;
      // 4xx等のAPIエラーは再試行しても無駄なので即座に投げる(ネットワーク系のみ再試行)
      if (!/fetch failed|network|ECONN|ETIMEDOUT|socket/i.test(e.message)) throw e;
      await sleep(3000 * (i + 1));
    }
  }
  throw lastErr;
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
const EVALS = new Set(['良い', '非常に良い', 'ポジより', '良くない', '#無し投稿']);
const GENRES = new Set(['エロ強', 'エロ弱', '一般人', 'インフルエンサー']);
const SPEEDS = new Set(['2週間', '1か月', '2か月', '3か月以上']);
const BURIS = new Set(['〇', '✖', '凍結', '投稿削除', '？']);
const cell = (r, i) => ((i != null && r[i] != null ? r[i] : '') + '').trim();
const validId = (x) => /^[a-z0-9_]{1,15}$/.test(x);
const looksLikeOrderNo = (x) => /^\d{3}-\d{7}-\d{7}$/.test(x) || /^\d{6,}$/.test(String(x).replace(/-/g, ''));
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
    if (!people.has(xid)) people.set(xid, { name: '', fullname: '', note: '', channel: '', evals: [], history: [], blockDates: [], giftDates: [], given: 0, reviewed: 0, fol: '', sb: '', face: '', speed: '', tokki: '', genre: '', buri: '', sai: '', caution: false, cautionWhy: [], fromKaisu: false, reviewedInGift: false, posInGift: false, evalBlank: false, postTrace: false, shippedLongAgo: false, prods: new Set(), rounds: [] });
    return people.get(xid);
  };
  const chFromNote = (p, note) => {
    if (p.channel) return;
    if (/公式LINE|公式ライン|LINE/i.test(note)) p.channel = '公式LINE';
    else if (/DM/i.test(note)) p.channel = 'X DM';
  };

  // ===== ギフ回数(主) =====
  const RB = [
    { note: 5, order: 9, track: 10, ship: 12, shipdate: 13, arrive: 14, review: 15, speed: 16, imp: 17, a: 18, b: 19, face: 20, ev: 21, tokki: 22 },
    { note: 23, order: 28, track: 29, ship: 31, shipdate: 32, arrive: 33, review: 34, speed: 35, imp: 36, a: 37, b: 38, face: 39, ev: 40 },
    { note: 43, order: 48, track: 49, ship: 51, shipdate: 52, arrive: 53, review: 54, speed: 55, imp: 56, a: 57, b: 58, face: 59, ev: 60 },
    { note: 62, order: 67, track: 68, ship: 70, shipdate: 71, arrive: 72, review: 73, speed: 74, imp: 75, a: 76, b: 77, face: 78, ev: 79 },
    { note: 81, order: 86, track: 87, ship: 89, shipdate: 90, arrive: 91, review: 92, speed: 93, imp: 94, a: 95, b: 96, face: 97, ev: 98 },
  ];
  for (let i = 1; i < K.length; i++) {
    const r = K[i];
    const xid = cell(r, 3).replace(/^@/, '').toLowerCase();
    if (!validId(xid)) continue;
    const p = get(xid);
    p.fromKaisu = true;
    if (!p.name) p.name = cell(r, 2);
    if (!p.fullname) { const fn = cell(r, 4).split(/[\/,]/)[0]; if (fn && !looksLikeOrderNo(fn)) p.fullname = fn; }
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
      // 発送日セルが未記入の回は、到着日を提供日の代替として使う(記入漏れ行の救済)
      else { const isoA = serialToISO(cell(r, b.arrive)); if (isoA) p.blockDates[bi] = isoA; }
      const prods = products(note);
      if (shipped || ev) {
        const dStr = iso ? ` ${iso.slice(0, 10).replace(/-/g, '/')}` : '';
        p.history.push(`${bi + 1}回目:${prods.join('+') || '?'}${ev ? '(' + ev + ')' : reviewDone ? '(済)' : shipped ? '(レビュー未)' : ''}${dStr}`);
      }
      if (shipped || ev) {
        p.rounds.push({ key: `k${bi + 1}`, n: bi + 1, prods: prods.length ? prods : ['不明'], date: p.blockDates[bi] || null, review: reviewDone, ev: ev || null, src: 'ギフ回数' });
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
      // インプ欄に数値以外が書かれている場合はスタッフの注記(例:「#無し投稿」)として特記へ回収する
      else if (imp && !/^[\d,.\s]+([万kK千件回])?$/.test(imp) && !p.tokki.includes(imp)) {
        p.tokki = p.tokki ? p.tokki + ' / ' + imp : imp;
      }
      if (/BAD|破棄/i.test(note)) { p.caution = true; p.cautionWhy.push(note.slice(0, 12)); }
      if (shipped && !reviewDone && iso && now - new Date(iso + 'T00:00:00+09:00').getTime() > 60 * 86400000) { p.caution = true; p.cautionWhy.push(`${bi + 1}回目レビュー未のまま60日+`); }
    }
  }

  // ===== ギフティング(補完) =====
  const GB = [
    { id: 2, name: 1, fullname: 3, note: 4, ship: 11, shipdate: 12, arrive: 14, review: 15, ev: 22, buri: 18, sai: 19, genre: 21, imp: 17, speed: 16 },
    { id: 26, name: 25, fullname: 27, note: 28, ship: 35, shipdate: 36, arrive: 38, review: 39, ev: 46, buri: 42, sai: 43, genre: 45, imp: 41, speed: 40 },
    { id: 50, name: 49, fullname: 51, note: 52, ship: 58, shipdate: 59, review: 61, ev: 68, buri: 64, sai: 65, genre: 67, imp: 63, speed: 62 },
  ];
  for (let i = 2; i < G.length; i++) {
    const r = G[i];
    for (const b of GB) {
      const xid = cell(r, b.id).replace(/^@/, '').toLowerCase();
      if (!validId(xid)) continue;
      const p = get(xid);
      if (!p.name) p.name = cell(r, b.name);
      if (!p.fullname) { const fn = cell(r, b.fullname).split(/[\/,]/)[0]; if (fn && !looksLikeOrderNo(fn)) p.fullname = fn; }
      const g = cell(r, b.genre); if (GENRES.has(g)) p.genre = g;
      const note = cell(r, b.note);
      if (note) chFromNote(p, note);
      let iso = serialToISO(cell(r, b.shipdate));
      if (!iso && b.arrive) iso = serialToISO(cell(r, b.arrive)); // 発送日未記入なら到着日で代替
      if (iso) p.giftDates.push(iso);
      const bu = cell(r, b.buri); if (BURIS.has(bu) && !p.buri) p.buri = bu;
      const sa = cell(r, b.sai); if (sa === '済') p.sai = '済'; else if (sa === '未' && p.sai !== '済') p.sai = '未';
      if (bu === '✖' || bu === '投稿削除') { p.caution = true; p.cautionWhy.push('ブリ' + bu); }
      const impG = cell(r, b.imp);
      if (impG && !/^[\d,.\s]+([万kK千件回])?$/.test(impG) && !/凍結/.test(impG) && !p.tokki.includes(impG)) {
        p.tokki = p.tokki ? p.tokki + ' / ' + impG : impG;
      }
      if (p.fromKaisu) {
        let evG = cell(r, b.ev);
        if (evG && !EVALS.has(evG)) { classify(p, evG); evG = ''; }
        if (evG && !POS.has(evG)) {
          p.evals.push(evG);
          const dStrG = iso ? ` ${iso.slice(0, 10).replace(/-/g, '/')}` : '';
          p.history.push(`台帳:(${evG})${dStrG}`);
        }
      }
      if (!p.fromKaisu) {
        // ギフ回数シートに載っていない = 一度もレビュー投稿していない人(大塚さん確認済みのシート定義)
        const shipped = cell(r, b.ship) === '済' || !!cell(r, b.shipdate);
        let ev = cell(r, b.ev);
        if (ev && !EVALS.has(ev)) { classify(p, ev); ev = ''; }
        if (shipped) p.given++;
        if (cell(r, b.review) === '済') {
          p.reviewed++;
          p.reviewedInGift = true;
          if (ev && POS.has(ev)) p.posInGift = true; // ポジ評価なのにギフ回数に不在 → 転記漏れ疑い
          // レビュー済だが評価未記入 → 判断不能。投稿の痕跡(インプ/投稿スピード)があれば予備軍として残す
          if (!ev) { p.evalBlank = true; if (cell(r, b.imp) || cell(r, b.speed)) p.postTrace = true; }
        }
        if (ev) p.evals.push(ev);
        if (shipped || ev) {
          const rp = products(note);
          p.rounds.push({ key: `g${rn}_${b.id}`, n: 0, prods: rp.length ? rp : ['不明'], date: iso || null, review: cell(r, b.review) === '済', ev: ev || null, src: '台帳' });
        }
        products(note).forEach((x) => p.prods.add(x));
        if (note && !p.note) p.note = note;
        if (/凍結/.test(note)) { p.caution = true; p.cautionWhy.push('凍結'); }
        // 発送済み × レビュー実績なし × 提供から60日超(レビュー期限2ヶ月を過ぎている) → 要注意
        if (shipped && iso && now - new Date(iso + 'T00:00:00+09:00').getTime() > 60 * 86400000) p.shippedLongAgo = true;
        // 発送済みなのに日付が未記入の行 → 期限判定ができないため、レビュー実績が無ければ同様に要注意へ
        if (shipped && !iso) p.shippedNoDate = true;
      }
    }
  }

  // チャネル未確定でギフ経路情報が全く無い人 → X DM とみなす(公式LINE誘導に乗った人は備考に記録される運用のため)
  for (const p of people.values()) {
    if (!p.channel) p.channel = 'X DM';
    // ポジ実績 = ギフ回数シートに在籍(このシートはポジティブレビューをくれた人だけを載せる運用)
    p.posRecord = p.fromKaisu;
    // 転記漏れ疑い = ギフ回数に不在だが、ギフティング側でレビュー済かつ評価がポジティブ
    p.transferMiss = !p.fromKaisu && !!p.posInGift;
    // 要注意 = 提供済みなのにレビュー記録が一切なく、提供から60日(レビュー期限2ヶ月)を過ぎている
    if (!p.fromKaisu && !p.reviewedInGift && (p.shippedLongAgo || p.shippedNoDate)) { p.caution = true; p.cautionWhy.unshift(p.shippedLongAgo ? 'レビュー実績なし(提供済)' : 'レビュー実績なし(提供済・日付不明)'); }
    // 評価未記入でギフ回数にも不在 = 品質不明。将来の掘り起こし予備軍として印を残す
    if (!p.fromKaisu && p.evalBlank && !p.posInGift) p.cautionWhy.push(p.postTrace ? '評価未記入(投稿痕跡あり)' : '評価未記入');
  }

  console.log(`parsed: ${people.size} unique people`);
  const stats = { fol: 0, sb: 0, ch: 0, dates: 0 };
  for (const p of people.values()) { if (p.fol) stats.fol++; if (p.sb) stats.sb++; if (p.channel) stats.ch++; if (p.blockDates.filter(Boolean).length || p.giftDates.length) stats.dates++; }
  console.log(`coverage: channel=${stats.ch}, shadowban=${stats.sb}, follower=${stats.fol}, dates=${stats.dates}`);

  // ===== ネガレビュー歴リスト(当選者の再選出ミス警告用) =====
  // 「良くない」評価が1回でもある人を data/negative_reviewers.json に常備する。
  // add_winner.js / Telegramの当選者登録・LINE照合がこれと突き合わせて警告を出す
  {
    const fs = require('fs');
    const path = require('path');
    const negatives = {};
    for (const [xid, p] of people) {
      if (p.evals.includes('良くない')) {
        negatives[xid] = {
          name: p.name || '',
          negCount: p.evals.filter((e) => e === '良くない').length,
          history: p.history.length ? p.history : p.evals.map((e) => '(' + e + ')'),
          flags: [...new Set(p.cautionWhy)].slice(0, 5),
        };
      }
    }
    fs.writeFileSync(path.join(__dirname, '../data/negative_reviewers.json'),
      JSON.stringify({ updatedAt: new Date().toISOString(), count: Object.keys(negatives).length, negatives }, null, 1));
    console.log(`negative reviewers: ${Object.keys(negatives).length} -> data/negative_reviewers.json`);
    // スプシ台帳ベースの提供履歴マップ(当選者登録時の「被り選出」警告用)
    const provisions = {};
    for (const [xid, p] of people) {
      const dates = [...p.blockDates.filter(Boolean), ...p.giftDates].sort();
      if (p.given > 0 || dates.length) provisions[xid] = { name: p.name || '', count: p.given, last: dates[dates.length - 1] || null };
    }
    fs.writeFileSync(path.join(__dirname, '../data/sheet_provisions.json'),
      JSON.stringify({ updatedAt: new Date().toISOString(), count: Object.keys(provisions).length, people: provisions }));
    console.log(`provisions map: ${Object.keys(provisions).length} -> data/sheet_provisions.json`);
    if (process.argv.includes('--negatives-only')) { console.log('negatives-only: Notion同期はスキップ'); process.exit(0); }
  }

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
  const txtAlways = (v) => ({ rich_text: v ? [{ text: { content: String(v).slice(0, 1900) } }] : [] });
  let created = 0, updated = 0, failed = 0;
  for (const [xid, p] of people) {
    let pos = p.evals.filter((e) => POS.has(e)).length;
    // ギフ回数シートは「ポジ投稿した人だけ」が載る運用のため、在籍していれば評価セル未記入でもポジ1回以上とみなす
    if (p.fromKaisu && pos === 0) pos = 1;
    const neg = p.evals.length - pos;
    const props = {
      'X ID': { title: [{ text: { content: '@' + xid } }] },
      '提供回数': { number: p.given },
      'レビュー済回数': { number: p.reviewed },
      'ポジ回数': { number: pos },
      'ネガ回数': { number: neg },
      'オールポジ': { checkbox: (p.fromKaisu || p.evals.length > 0) && neg === 0 },
      'ポジ実績': { checkbox: !!p.posRecord },
      '転記漏れ疑い': { checkbox: !!p.transferMiss },
      '要注意': { checkbox: p.caution },
    };
    if (p.prods.size) props['提供商品'] = { multi_select: [...p.prods].map((n) => ({ name: n })) };
    // 初回/最終提供日は両シートの発送日を統合して決める。
    // 発送管理シート(ギフティング)は発送のたびに記入されるため、ギフ回数に未転記の
    // 最新の発送が載っていることがある(実測: 統合で82人の日付が修正された)。
    const allDates = [...p.blockDates.filter((d) => d), ...p.giftDates].sort();
    if (allDates.length) {
      props['初回提供日'] = { date: { start: allDates[0] } };
      props['最終提供日'] = { date: { start: allDates[allDates.length - 1] } };
    }
    const tokki = [p.tokki, ...new Set(p.cautionWhy)].filter(Boolean).join(' / ');
    const opt = {
      'アカウント名': txt(p.name), '評価履歴': txt(p.history.join(' → ') || p.evals.join('→')),
      '氏名': txt(p.fullname), '備考': txt(p.note), '特記': txtAlways(tokki),
      'チャネル': sel(p.channel), 'フォロワー帯': sel(/以下|以上|万垢/.test(p.fol) ? p.fol : ''),
      'シャドバン': sel(p.sb), '顔出し': sel(p.face), 'ジャンル': sel(p.genre),
      '再提供': sel(p.sai), '投稿スピード': sel(p.speed),
    };
    for (const [k, v] of Object.entries(opt)) if (v) props[k] = v;
    try {
      if (existing.has(xid)) { await api(`/pages/${existing.get(xid)}`, { method: 'PATCH', body: JSON.stringify({ properties: props }) }); updated++; }
      else { const cRes = await api('/pages', { method: 'POST', body: JSON.stringify({ parent: { database_id: DB_ID }, properties: props }) }); if (cRes && cRes.id) existing.set(xid, cRes.id); created++; }
    } catch (e) { failed++; if (failed <= 5) console.error(`fail @${xid}:`, e.message); }
    await sleep(310);
  }
  // ===== 提供履歴(1行=1回の提供)の同期 =====
  // ギフ回数の横伸びブロックと台帳の発送行を縦に展開し、実績マスターとリレーションで繋ぐ。
  // ローカルキャッシュ(内容ハッシュ)で変更行だけを書き、週次の負荷を抑える。
  {
    const fsP = require('fs');
    const pathP = require('path');
    const PROV_DB_ID = process.env.NOTION_PROVISIONS_DB_ID || '2ad2daf8c94243909b12c3317c3f4038';
    const cacheFile = pathP.join(__dirname, '../data/prov_synced.json');
    let cache = {};
    try { cache = JSON.parse(fsP.readFileSync(cacheFile, 'utf-8')); } catch (e) {}
    let provDbEmpty = false;
    try {
      const q0 = await api(`/databases/${PROV_DB_ID}/query`, { method: 'POST', body: JSON.stringify({ page_size: 1 }) });
      provDbEmpty = !(q0.results || []).length;
    } catch (e) {}
    let pCreated = 0; let pUpdated = 0; let pSkipped = 0; let pFailed = 0;
    for (const [xid, p] of people) {
      const pageId = existing.get(xid);
      if (!pageId || !p.rounds.length) continue;
      const kaisuMax = Math.max(0, ...p.rounds.filter((r) => r.src === 'ギフ回数').map((r) => r.n));
      let gi = 0;
      for (const r of p.rounds.slice().sort((a, b) => String(a.date || '9999').localeCompare(String(b.date || '9999')))) {
        if (!r.n) r.n = kaisuMax + (++gi);
      }
      for (const r of p.rounds) {
        const skey = `${xid}#${r.key}`;
        const hash = [r.n, (r.prods || []).join('+'), r.date || '', r.review ? '済' : '未', r.ev || ''].join('|');
        if (cache[skey] === hash) { pSkipped++; continue; }
        const props = {
          '提供': { title: [{ text: { content: `@${xid} ${r.n}回目` } }] },
          'レビュアー': { relation: [{ id: pageId }] },
          '商品': { multi_select: (r.prods || ['不明']).map((name) => ({ name })) },
          '回数': { number: r.n },
          'レビュー': { select: { name: r.review ? '済' : '未' } },
          '出典': { select: { name: r.src } },
          'SyncKey': { rich_text: [{ text: { content: skey } }] },
        };
        if (r.date) props['提供日'] = { date: { start: String(r.date).slice(0, 10) } };
        if (r.ev) props['評価'] = { select: { name: r.ev } };
        try {
          let pgId = cache['id:' + skey];
          if (!pgId && !provDbEmpty) {
            const q = await api(`/databases/${PROV_DB_ID}/query`, { method: 'POST', body: JSON.stringify({ page_size: 1, filter: { property: 'SyncKey', rich_text: { equals: skey } } }) });
            pgId = q.results && q.results[0] && q.results[0].id;
          }
          if (pgId) { await api(`/pages/${pgId}`, { method: 'PATCH', body: JSON.stringify({ properties: props }) }); pUpdated++; }
          else { const cr = await api('/pages', { method: 'POST', body: JSON.stringify({ parent: { database_id: PROV_DB_ID }, properties: props }) }); pgId = cr && cr.id; pCreated++; }
          cache[skey] = hash;
          if (pgId) cache['id:' + skey] = pgId;
        } catch (e) { pFailed++; if (pFailed <= 5) console.error('prov upsert failed:', skey, e.message); }
      }
    }
    fsP.writeFileSync(cacheFile, JSON.stringify(cache));
    console.log(`provision rows: created=${pCreated}, updated=${pUpdated}, skipped=${pSkipped}, failed=${pFailed}`);
  }

  console.log(`${new Date().toISOString()} reviewer sync done: ${people.size} people, created=${created}, updated=${updated}, failed=${failed}`);
})().catch((e) => { console.error('reviewer sync failed:', e.message); process.exit(1); });
