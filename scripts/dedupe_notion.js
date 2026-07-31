#!/usr/bin/env node
// Notion「レビュアー実績マスター」の重複ページを掃除する
// 同期プロセスの並走で同じX IDのページが複数作られたため、各IDで1ページだけ残して他をアーカイブする
// 残す基準: 最も情報量が多いページ(埋まっているプロパティ数が最大、同数なら作成が新しい方)
require('dotenv').config();
const TOKEN = process.env.NOTION_TOKEN;
const DB_ID = process.env.NOTION_REVIEWERS_DB_ID || '6fd68dd55c8f43fbaff2fddf6c324b7e';
const DRY = process.argv.includes('--dry');
if (!TOKEN) { console.error('NOTION_TOKEN not set'); process.exit(1); }
const H = { 'Authorization': `Bearer ${TOKEN}`, 'Notion-Version': '2022-06-28', 'Content-Type': 'application/json' };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function api(path, opts = {}, tries = 4) {
  let last;
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch('https://api.notion.com/v1' + path, { ...opts, headers: H });
      if (r.status === 429) { await sleep(2000); continue; }
      const j = await r.json();
      if (!r.ok) throw new Error(`${r.status} ${JSON.stringify(j).slice(0, 150)}`);
      return j;
    } catch (e) { last = e; await sleep(3000 * (i + 1)); }
  }
  throw last;
}
function filled(pg) {
  let n = 0;
  for (const [k, v] of Object.entries(pg.properties || {})) {
    if (!v) continue;
    if (v.type === 'select' && v.select) n++;
    else if (v.type === 'multi_select' && v.multi_select?.length) n++;
    else if (v.type === 'date' && v.date) n++;
    else if (v.type === 'rich_text' && v.rich_text?.length) n++;
    else if (v.type === 'number' && v.number != null) n++;
    else if (v.type === 'checkbox' && v.checkbox) n++;
  }
  return n;
}
(async () => {
  const groups = new Map();
  let cursor, total = 0;
  do {
    const body = cursor ? { start_cursor: cursor, page_size: 100 } : { page_size: 100 };
    const q = await api(`/databases/${DB_ID}/query`, { method: 'POST', body: JSON.stringify(body) });
    for (const pg of q.results) {
      total++;
      const t = (pg.properties?.['X ID']?.title || []).map((x) => x.plain_text).join('').replace(/^@/, '').toLowerCase();
      if (!t) continue;
      if (!groups.has(t)) groups.set(t, []);
      groups.get(t).push({ id: pg.id, score: filled(pg), created: pg.created_time });
    }
    cursor = q.has_more ? q.next_cursor : undefined;
  } while (cursor);
  const dupGroups = [...groups.entries()].filter(([, v]) => v.length > 1);
  const toArchive = [];
  for (const [, pages] of dupGroups) {
    pages.sort((a, b) => (b.score - a.score) || (new Date(b.created) - new Date(a.created)));
    toArchive.push(...pages.slice(1).map((p) => p.id));
  }
  console.log(`総ページ数: ${total} / ユニークID: ${groups.size} / 重複グループ: ${dupGroups.length} / アーカイブ対象: ${toArchive.length}`);
  if (DRY) { console.log('(dry run — 実行しません)'); return; }
  let done = 0, failed = 0;
  for (const id of toArchive) {
    try { await api(`/pages/${id}`, { method: 'PATCH', body: JSON.stringify({ archived: true }) }); done++; }
    catch (e) { failed++; if (failed <= 3) console.error('archive fail:', e.message); }
    if (done % 100 === 0 && done) console.log(`  archived ${done}/${toArchive.length}`);
    await sleep(310);
  }
  console.log(`完了: アーカイブ ${done}件 / 失敗 ${failed}件 / 残 ${groups.size}ページ`);
})().catch((e) => { console.error('dedupe failed:', e.message); process.exit(1); });
