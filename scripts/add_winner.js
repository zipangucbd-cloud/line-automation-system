#!/usr/bin/env node
// 当選者登録CLI
// 使い方: node scripts/add_winner.js <x_id> <企画名> <提供内容> [tier] [メモ]
//   例:   node scripts/add_winner.js @abc "7月グミクリーム選択企画" choice normal "フォロワー1.2万"
//   tier: normal(一般) | strong(強アカ・提携アフィ=無料オファー対象)
//   提供内容の例: original_2粒 / drop / cream / choice(グミorクリーム選択) / free(完全無料)
require('dotenv').config();
const Database = require('better-sqlite3');
const dbPath = process.env.DB_PATH || './data/customers.db';
const [, , xIdRaw, campaign, offer, tier = 'normal', notes = null] = process.argv;
if (!xIdRaw || !campaign || !offer) {
  console.log('Usage: node scripts/add_winner.js <x_id> <campaign> <offer> [tier=normal|strong] [notes]');
  process.exit(1);
}
const db = new Database(dbPath);
const xId = xIdRaw.replace(/^@/, '').trim();
const dup = db.prepare("SELECT id, campaign, status FROM winners WHERE lower(x_id) = lower(?) AND status NOT IN ('done','cancelled')").get(xId);
if (dup) console.log(`⚠️ 既存のアクティブな登録あり: #${dup.id} (${dup.campaign} / ${dup.status}) — 重ねて登録します`);
const r = db.prepare('INSERT INTO winners (x_id, campaign, offer, tier, notes) VALUES (?, ?, ?, ?, ?)').run(xId, campaign, offer, tier, notes);
console.log(`✅ 登録完了 #${r.lastInsertRowid}: @${xId} | ${campaign} | ${offer} | ${tier}${notes ? ' | ' + notes : ''}`);
