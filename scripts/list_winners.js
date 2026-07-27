#!/usr/bin/env node
// 当選者リスト一覧CLI: node scripts/list_winners.js [--all]
require('dotenv').config();
const Database = require('better-sqlite3');
const dbPath = process.env.DB_PATH || './data/customers.db';
const db = new Database(dbPath);
const showAll = process.argv.includes('--all');
const where = showAll ? '' : "WHERE status NOT IN ('done','cancelled')";
const rows = db.prepare(`SELECT id, x_id, campaign, offer, tier, status, chosen_product, line_user_id, notes, created_at FROM winners ${where} ORDER BY created_at DESC LIMIT 100`).all();
if (!rows.length) { console.log(showAll ? '当選者リストは空です' : 'アクティブな当選者はいません(--all で全件表示)'); process.exit(0); }
console.log(`${rows.length}件:`);
for (const r of rows) {
  console.log(`#${r.id} @${r.x_id} | ${r.campaign} | ${r.offer} | ${r.tier} | ${r.status}${r.chosen_product ? ' | 選択:' + r.chosen_product : ''}${r.line_user_id ? ' | LINE✓' : ''}${r.notes ? ' | ' + r.notes : ''} | ${r.created_at}`);
}
