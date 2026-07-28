#!/usr/bin/env node
// winners → Notion「SEXTASY 当選者管理(Bot連携)」への片方向同期
// launchd (com.user.line.notionsync) から毎朝9:05に実行される
// マスターはSQLite側。Notion側の手動編集は次回同期で上書きされる。
require('dotenv').config();
const Database = require('better-sqlite3');
const db = new Database(process.env.DB_PATH || './data/customers.db', { readonly: true });
const TOKEN = process.env.NOTION_TOKEN;
const DB_ID = process.env.NOTION_WINNERS_DB_ID || '1c740e80c3d24e62a8665cf2409210fa';
if (!TOKEN) { console.log('NOTION_TOKEN not set; skipping sync'); process.exit(0); }

const H = { 'Authorization': `Bearer ${TOKEN}`, 'Notion-Version': '2022-06-28', 'Content-Type': 'application/json' };
async function api(path, opts = {}) {
  const r = await fetch('https://api.notion.com/v1' + path, { ...opts, headers: H });
  const j = await r.json();
  if (!r.ok) throw new Error(`${r.status} ${JSON.stringify(j).slice(0, 300)}`);
  return j;
}
const d = (s) => (s ? { date: { start: String(s).slice(0, 10) } } : null);
const sel = (s) => (s ? { select: { name: String(s).slice(0, 90) } } : null);
function props(w) {
  const p = {
    'X ID': { title: [{ text: { content: '@' + w.x_id } }] },
    'DBID': { number: w.id },
    'LINE紐付け': { checkbox: !!w.line_user_id },
  };
  const map = {
    '企画': sel(w.campaign), '提供内容': sel(w.offer), '区分': sel(w.tier),
    'ステータス': sel(w.status), '選択商品': sel(w.chosen_product),
    '発送日': d(w.shipped_at), '到着確認': d(w.arrived_at), 'レビュー予定日': d(w.review_due),
    'レビュー完了': d(w.reviewed_at), '最終フォロー': d(w.last_followup_at),
  };
  for (const [k, v] of Object.entries(map)) if (v) p[k] = v;
  if (w.notes) p['メモ'] = { rich_text: [{ text: { content: String(w.notes).slice(0, 1900) } }] };
  return p;
}
(async () => {
  const existing = new Map();
  let cursor;
  do {
    const body = cursor ? { start_cursor: cursor, page_size: 100 } : { page_size: 100 };
    const res = await api(`/databases/${DB_ID}/query`, { method: 'POST', body: JSON.stringify(body) });
    for (const pg of res.results) {
      const dbid = pg.properties && pg.properties.DBID && pg.properties.DBID.number;
      if (dbid != null) existing.set(dbid, pg.id);
    }
    cursor = res.has_more ? res.next_cursor : undefined;
  } while (cursor);
  const winners = db.prepare('SELECT * FROM winners').all();
  let created = 0, updated = 0;
  for (const w of winners) {
    if (existing.has(w.id)) {
      await api(`/pages/${existing.get(w.id)}`, { method: 'PATCH', body: JSON.stringify({ properties: props(w) }) });
      updated++;
    } else {
      await api('/pages', { method: 'POST', body: JSON.stringify({ parent: { database_id: DB_ID }, properties: props(w) }) });
      created++;
    }
  }
  console.log(`${new Date().toISOString()} notion sync done: total=${winners.length}, created=${created}, updated=${updated}`);
})().catch((e) => { console.error('notion sync failed:', e.message); process.exit(1); });
