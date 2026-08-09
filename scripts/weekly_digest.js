#!/usr/bin/env node
// 週次改善ダイジェスト: 1週間の承認実績を集計し、修正・却下の傾向をClaudeに分析させてTelegramへ送る
// launchd (com.user.line.weeklydigest) から毎週月曜9時30分に実行される
require('dotenv').config();
const Database = require('better-sqlite3');
const Anthropic = require('@anthropic-ai/sdk');
const fs = require('fs');
const path = require('path');

const db = new Database(process.env.DB_PATH || './data/customers.db', { readonly: true });
const token = process.env.TELEGRAM_BOT_TOKEN;
const chatId = process.env.TELEGRAM_APPROVAL_CHAT_ID;
if (!token || !chatId) { console.error('Telegram credentials missing'); process.exit(1); }

const W = "datetime('now','-7 days')";
const s = db.prepare(`SELECT
  (SELECT COUNT(*) FROM approvals WHERE created_at >= ${W}) AS total,
  (SELECT COUNT(*) FROM approvals WHERE created_at >= ${W} AND status='approved') AS approved,
  (SELECT COUNT(*) FROM approvals WHERE created_at >= ${W} AND status='rejected') AS rejected,
  (SELECT COUNT(*) FROM approvals WHERE created_at >= ${W} AND status='revised') AS revised,
  (SELECT COUNT(*) FROM approvals WHERE status='pending') AS pending,
  (SELECT COUNT(*) FROM conversations WHERE direction='incoming' AND timestamp >= ${W}) AS incoming,
  (SELECT COUNT(DISTINCT user_id) FROM conversations WHERE timestamp >= ${W}) AS people,
  (SELECT COUNT(*) FROM winners WHERE status NOT IN ('done','cancelled')) AS active_winners,
  (SELECT COUNT(*) FROM winners WHERE status='done' AND updated_at >= ${W}) AS completed
`).get();

// 修正・却下の記録(改善のネタになる生の声)
let gaps = [];
try {
  gaps = db.prepare(`SELECT gap, created_at FROM knowledge_gaps WHERE created_at >= ${W} ORDER BY created_at DESC`).all();
} catch (e) { /* テーブル未作成なら無視 */ }
const rejectReasons = gaps.filter((g) => g.gap.startsWith('却下理由'));
const missingKnowledge = gaps.filter((g) => !g.gap.startsWith('却下理由'));

// 覚えた知識の増分
let learnedCount = 0;
try {
  const p = path.join(__dirname, '../src/knowledge/learned.md');
  if (fs.existsSync(p)) learnedCount = fs.readFileSync(p, 'utf-8').split('\n').filter((l) => l.trim().startsWith('- [')).length;
} catch (e) {}

// 修正を経た返信(revised)の元文面 — 何を直させられたかの手がかり
const revisedSamples = db.prepare(`SELECT generated_reply FROM approvals WHERE created_at >= ${W} AND status='revised' ORDER BY created_at DESC LIMIT 15`).all();

const rate = s.total ? Math.round((s.approved / s.total) * 100) : 0;
const lines = [
  '📊 LINE Bot 週次ダイジェスト(直近7日間)',
  '',
  `対応した方: ${s.people}名 / 受信: ${s.incoming}件`,
  `返信案: ${s.total}件`,
  `　✅ そのまま承認: ${s.approved}件${s.total ? ` (${rate}%)` : ''}`,
  `　✏️ 修正して送信: ${s.revised}件`,
  `　❌ 却下: ${s.rejected}件`,
  s.pending ? `　⏳ 未処理: ${s.pending}件` : null,
  '',
  `当選者: 対応中 ${s.active_winners}名 / 今週完了 ${s.completed}名`,
  `覚えている知識: ${learnedCount}件`,
].filter(Boolean);

if (s.total === 0) {
  lines.push('', '今週は返信案がありませんでした。');
} else {
  lines.push('', rate >= 70 ? '👍 承認率が高く、実用レベルで回っています。'
    : rate >= 40 ? '📈 まだ修正が多めです。よくある修正は🧠ボタンで覚えさせると減っていきます。'
    : '⚠️ 修正・却下が多い状態です。下の傾向を見て知識を追加してください。');
}

if (missingKnowledge.length) {
  lines.push('', `🚨 知識不足として記録された項目: ${missingKnowledge.length}件`);
  for (const g of missingKnowledge.slice(0, 8)) lines.push(`・${g.gap}`);
  lines.push('→ /覚えて で教えると解消されます');
}
if (rejectReasons.length) {
  lines.push('', `❌ 却下の理由: ${rejectReasons.length}件`);
  for (const g of rejectReasons.slice(0, 8)) lines.push(`・${g.gap.replace(/^却下理由/, '')}`);
}

// 傾向分析(材料がある時だけClaudeに要約させる)
async function analyze() {
  const material = [
    rejectReasons.length ? `【却下の理由】\n${rejectReasons.map((g) => g.gap).join('\n')}` : '',
    missingKnowledge.length ? `【不足していた知識】\n${missingKnowledge.map((g) => g.gap).join('\n')}` : '',
    revisedSamples.length ? `【修正された返信案(抜粋)】\n${revisedSamples.map((r) => (r.generated_reply || '').slice(0, 200)).join('\n---\n')}` : '',
  ].filter(Boolean).join('\n\n');
  if (!material) return null;
  const anth = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY, maxRetries: 3 });
  const res = await anth.messages.create({
    model: process.env.CLAUDE_MODEL || 'claude-sonnet-4-5-20250929',
    max_tokens: 900,
    messages: [{
      role: 'user',
      content: `あなたはLINE応対Botの運用改善アドバイザーです。以下は今週このBotが人間に修正・却下された記録です。\n`
        + `繰り返し起きている問題を最大3つ挙げ、それぞれに「Botに覚えさせるべき具体的な一文」を提案してください。\n`
        + `提案する一文は、そのまま /覚えて に貼れる形にしてください。\n`
        + `該当がなければ「特筆すべき傾向はありません」とだけ答えてください。前置きや締めの挨拶は不要です。\n\n${material}`,
    }],
  });
  return res.content[0].text.trim();
}

(async () => {
  try {
    const insight = await analyze();
    if (insight && !/特筆すべき傾向はありません/.test(insight)) {
      lines.push('', '━━━━━━━━━━', '💡 今週の傾向と改善案', '', insight);
    }
  } catch (e) { console.error('Analysis failed:', e.message); }

  const text = lines.join('\n');
  // この回線はTelegram宛のHTTP/1.1系TLSがDPI遮断されるため、HTTP/2クライアント(リトライ内蔵)で送る
  const { tgCallRetry } = require('./tg_h2');
  await tgCallRetry(token, 'sendMessage', { chat_id: chatId, text }, 4);
  console.log(new Date().toISOString(), 'weekly digest sent');
})().catch((e) => { console.error('Weekly digest error:', e.message); process.exit(1); });
