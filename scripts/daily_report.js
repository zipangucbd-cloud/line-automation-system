#!/usr/bin/env node
// 日次ヘルスレポート: 直近24時間の稼働数字をTelegramに送る
// launchd (com.user.line.dailyreport) から毎朝9時に実行される
require('dotenv').config();
const Database = require('better-sqlite3');
const dbPath = process.env.DB_PATH || './data/customers.db';
const db = new Database(dbPath, { readonly: true });

const s = db.prepare(`SELECT
  (SELECT COUNT(*) FROM conversations WHERE direction='incoming' AND timestamp >= datetime('now','-1 day')) AS incoming,
  (SELECT COUNT(*) FROM conversations WHERE direction='outgoing' AND timestamp >= datetime('now','-1 day')) AS outgoing,
  (SELECT COUNT(*) FROM approvals WHERE created_at >= datetime('now','-1 day')) AS approvals_new,
  (SELECT COUNT(*) FROM approvals WHERE created_at >= datetime('now','-1 day') AND status='approved') AS approved,
  (SELECT COUNT(*) FROM approvals WHERE created_at >= datetime('now','-1 day') AND status='rejected') AS rejected,
  (SELECT COUNT(*) FROM approvals WHERE created_at >= datetime('now','-1 day') AND status='revised') AS revised,
  (SELECT COUNT(*) FROM approvals WHERE status='pending') AS pending_total,
  (SELECT COUNT(*) FROM winners WHERE status NOT IN ('done','cancelled')) AS active_winners
`).get();

const lines = [
  '📊 LINE Bot 日次レポート(直近24時間)',
  `受信: ${s.incoming}件 / 送信: ${s.outgoing}件`,
  `承認依頼: ${s.approvals_new}件(承認${s.approved} / 却下${s.rejected} / 修正${s.revised})`,
  `未処理の承認待ち: ${s.pending_total}件`,
  `アクティブ当選者: ${s.active_winners}人`,
];
if (s.incoming === 0) lines.push('※受信0件。chat.line.bizの未読と食い違っていないか確認を。');
if (s.pending_total > 0) lines.push('※承認待ちが残っています。Telegramを遡って処理してください。');

const token = process.env.TELEGRAM_BOT_TOKEN;
const chatId = process.env.TELEGRAM_APPROVAL_CHAT_ID;
if (!token || !chatId) { console.error('Telegram credentials missing'); process.exit(1); }

fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ chat_id: chatId, text: lines.join('\n') }),
}).then(r => r.json()).then(r => {
  if (!r.ok) { console.error('Telegram send failed:', JSON.stringify(r)); process.exit(1); }
  console.log('Daily report sent');
}).catch(e => { console.error('Daily report error:', e.message); process.exit(1); });
