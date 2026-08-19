#!/usr/bin/env node
// 日次ヘルスレポート: 直近24時間の稼働数字+ルールベースの異常検知(トークン消費ゼロ)をTelegramに送る
// launchd (com.user.line.dailyreport) から毎朝9時に実行される。--dry で送信せず標準出力のみ
require('dotenv').config();
const fs = require('fs');
const path = require('path');
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

// ===== ルールベース異常検知(SQL+ログのみ、トークン消費ゼロ) =====
const alerts = [];

// 1) 同文の連続送信 = 二重送信の再発検知
try {
  const dups = db.prepare(`
    SELECT substr(a.user_id,-6) u, replace(substr(a.content,1,30), char(10), ' ') t, a.timestamp ts
    FROM conversations a JOIN conversations b
      ON a.user_id = b.user_id AND a.id < b.id
      AND a.direction='outgoing' AND b.direction='outgoing'
      AND substr(a.content,1,80) = substr(b.content,1,80)
      AND (julianday(b.timestamp) - julianday(a.timestamp)) * 86400 <= 120
    WHERE a.timestamp >= datetime('now','-1 day')`).all();
  for (const d of dups) alerts.push(`二重送信の疑い: [${d.u}] ${d.ts}「${d.t}…」`);
} catch (e) { alerts.push('二重送信チェック失敗: ' + e.message); }

// 2) 承認レコードと対応しない送信(友だち追加時の問診自動送信は除外)
try {
  let g1 = '';
  try {
    // 1通目の問診は先頭が{Nickname}置換で変わるため、2行目以降の固定文で判定する
    g1 = fs.readFileSync(path.join(__dirname, '../src/knowledge/greeting_step1.txt'), 'utf-8')
      .split('\n').slice(1).join('\n').trim().slice(0, 25);
  } catch (_) {}
  const rows = db.prepare(`
    SELECT substr(user_id,-6) u, replace(substr(content,1,30), char(10), ' ') t, content, timestamp ts
    FROM conversations c
    WHERE direction='outgoing' AND timestamp >= datetime('now','-1 day')
      AND NOT EXISTS (SELECT 1 FROM approvals ap WHERE ap.final_reply = c.content)`).all()
    .filter((r) => !(g1 && r.content.includes(g1)) && !r.content.includes('※このメッセージは自動応答です'));
  for (const r of rows) alerts.push(`承認記録の無い送信: [${r.u}] ${r.ts}「${r.t}…」`);
} catch (e) { alerts.push('未承認送信チェック失敗: ' + e.message); }

// 3) 当選者と紐付かないままS3以降(提供フェーズ)に進んでいる人
try {
  const rows = db.prepare(`
    SELECT substr(user_id,-6) u, stage FROM customers
    WHERE stage IS NOT NULL AND substr(stage,1,2) IN ('S3','S4','S5','S6','S7','S8','S9')
      AND user_id NOT IN (SELECT line_user_id FROM winners WHERE line_user_id IS NOT NULL)`).all();
  for (const r of rows) alerts.push(`照合未完了でS3以降: [${r.u}] ${r.stage}(当選者と未紐付け)`);
} catch (e) {}

// 4) ログ由来: 生成失敗 / 従量課金ルートの使用(=Max枠枯渇の兆候) / ポーリングエラー多発
try {
  const day = 86400000;
  const f = (d) => path.join(__dirname, '../data/logs/app-' + d.toISOString().slice(0, 10) + '.log');
  let text = '';
  for (const d of [new Date(Date.now() - day), new Date()]) {
    try { text += fs.readFileSync(f(d), 'utf-8'); } catch (_) {}
  }
  const cnt = (re) => (text.match(re) || []).length;
  const genFail = cnt(/Reply generation failed/g);
  const apiRoute = cnt(/route=api/g);
  const maxFail = cnt(/Maxルート失敗/g);
  const poll = cnt(/polling error/gi);
  if (genFail) alerts.push(`返信生成の失敗: ${genFail}件(ログ確認を)`);
  if (apiRoute) alerts.push(`従量課金ルート(route=api)の使用: ${apiRoute}件 — Max枠が詰まった可能性`);
  else if (maxFail) alerts.push(`Maxルート失敗(APIで復旧済み含む): ${maxFail}件`);
  if (poll > 60) alerts.push(`Telegramポーリングエラー多発: ${poll}件(直近ログ)`);
  // Shopify巡回のヘルス(15分毎にログが動いているか)
  try {
    const st = fs.statSync('/tmp/line_shopifysync.log');
    const ageMin = Math.floor((Date.now() - st.mtimeMs) / 60000);
    const stxt = fs.readFileSync('/tmp/line_shopifysync.log', 'utf-8');
    const sfails = (stxt.match(/token grant failed|shopify_sync error/g) || []).length;
    if (ageMin > 120) alerts.push(`Shopify巡回が${Math.floor(ageMin / 60)}時間動いていません(launchd停止の可能性。/直して で相談を)`);
    if (sfails) alerts.push(`Shopify巡回のエラー: ${sfails}件(/tmp/line_shopifysync.log)`);
  } catch (e) { alerts.push('Shopify巡回のログが見つかりません(再起動直後でなければ未稼働の可能性)'); }
  const reissued = cnt(/Reissued approval/g);
  const regen = cnt(/未応答を検出/g);
  if (reissued || regen) alerts.push(`自動修復の実績: カード再発行${reissued}件 / 生成やり直し${regen}件(整合性チェックが正常に働いた記録)`);
} catch (e) {}

if (alerts.length) {
  lines.push('', '🚨 異常検知(ルールベース):');
  for (const a of alerts.slice(0, 12)) lines.push('・' + a);
  if (alerts.length > 12) lines.push(`…他${alerts.length - 12}件`);
} else {
  lines.push('', '異常検知: なし ✅');
}

const token = process.env.TELEGRAM_BOT_TOKEN;
const chatId = process.env.TELEGRAM_APPROVAL_CHAT_ID;
if (!token || !chatId) { console.error('Telegram credentials missing'); process.exit(1); }

if (process.argv.includes('--dry')) {
  console.log(lines.join('\n'));
  process.exit(0);
}

const { tgCallRetry } = require('./tg_h2');
tgCallRetry(token, 'sendMessage', { chat_id: chatId, text: lines.join('\n') }, 4)
  .then(() => console.log('Daily report sent'))
  .catch((e) => { console.error('Daily report error:', e.message); process.exit(1); });
