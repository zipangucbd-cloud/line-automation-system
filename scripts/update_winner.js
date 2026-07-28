#!/usr/bin/env node
// 当選者の状態更新CLI
// 使い方:
//   node scripts/update_winner.js @xid shipped            # 発送済み(発送日=今、status=shipped)
//   node scripts/update_winner.js @xid arrived            # 到着確認(=今)
//   node scripts/update_winner.js @xid due 2026-08-15     # レビュー予定日を設定
//   node scripts/update_winner.js @xid reviewed           # レビュー完了(=今、status=reviewed)
//   node scripts/update_winner.js @xid chosen gummy       # 選択商品(gummy/cream)
//   node scripts/update_winner.js @xid status done        # status変更(done/cancelled等)
require('dotenv').config();
const Database = require('better-sqlite3');
const db = new Database(process.env.DB_PATH || './data/customers.db');
const [, , xIdRaw, field, value] = process.argv;
if (!xIdRaw || !field) { console.log('Usage: update_winner.js <x_id> <shipped|arrived|due|reviewed|chosen|status> [value]'); process.exit(1); }
const xId = xIdRaw.replace(/^@/, '');
const w = db.prepare("SELECT * FROM winners WHERE lower(x_id)=lower(?) AND status NOT IN ('done','cancelled') ORDER BY created_at DESC LIMIT 1").get(xId);
if (!w) { console.log('アクティブな当選者が見つかりません: @' + xId); process.exit(1); }
const map = {
  shipped: "UPDATE winners SET shipped_at=CURRENT_TIMESTAMP, status='shipped', updated_at=CURRENT_TIMESTAMP WHERE id=?",
  arrived: "UPDATE winners SET arrived_at=CURRENT_TIMESTAMP, updated_at=CURRENT_TIMESTAMP WHERE id=?",
  reviewed: "UPDATE winners SET reviewed_at=CURRENT_TIMESTAMP, status='reviewed', updated_at=CURRENT_TIMESTAMP WHERE id=?",
};
if (map[field]) db.prepare(map[field]).run(w.id);
else if (field === 'due') {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) { console.log('due には日付(YYYY-MM-DD)が必要です'); process.exit(1); }
  db.prepare('UPDATE winners SET review_due=?, updated_at=CURRENT_TIMESTAMP WHERE id=?').run(value, w.id);
}
else if (field === 'chosen') { db.prepare('UPDATE winners SET chosen_product=?, updated_at=CURRENT_TIMESTAMP WHERE id=?').run(value, w.id); }
else if (field === 'status') { db.prepare('UPDATE winners SET status=?, updated_at=CURRENT_TIMESTAMP WHERE id=?').run(value, w.id); }
else { console.log('不明なフィールド: ' + field); process.exit(1); }
const a = db.prepare('SELECT * FROM winners WHERE id=?').get(w.id);
console.log(`✅ #${a.id} @${a.x_id} | ${a.campaign} | status:${a.status} | shipped:${a.shipped_at || '-'} | arrived:${a.arrived_at || '-'} | due:${a.review_due || '-'} | reviewed:${a.reviewed_at || '-'}`);
