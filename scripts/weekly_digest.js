#!/usr/bin/env node
// 週次改善ダイジェスト: 1週間の承認実績を集計し、修正・却下の傾向をClaudeに分析させてTelegramへ送る
// launchd (com.user.line.weeklydigest) から毎週月曜9時30分に実行される
require('dotenv').config();
const Database = require('better-sqlite3');
const { runRaw } = require('../src/claude/client');
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
  const text = await runRaw({
    prompt: `あなたはLINE応対Botの運用改善アドバイザーです。以下は今週このBotが人間に修正・却下された記録です。\n`
      + `繰り返し起きている問題を最大3つ挙げ、それぞれに「Botに覚えさせるべき具体的な一文」を提案してください。\n`
      + `提案する一文は、そのまま /覚えて に貼れる形にしてください。\n`
      + `該当がなければ「特筆すべき傾向はありません」とだけ答えてください。前置きや締めの挨拶は不要です。\n\n${material}`,
    maxTokens: 900,
    label: 'weeklyDigest',
  });
  return text.trim();
}

// 1週間分の生ログをAIに読ませ、一貫性・フロー・ルール違反・機械的異常を監査する(週1回のみ)
async function auditWeek() {
  const convo = db.prepare(`SELECT id, substr(user_id,-6) u, direction d, content, timestamp ts FROM conversations WHERE timestamp >= ${W} ORDER BY id`).all();
  if (!convo.length) return null;
  const rows = convo.slice(-600).map((r) => `${r.id}|${r.u}|${r.d === 'incoming' ? '客' : 'Bot'}|${r.ts}|${(r.content || '').replace(/\n/g, ' ').slice(0, 200)}`);
  let rules = '';
  try { rules = fs.readFileSync(path.join(__dirname, '../src/knowledge/learned.md'), 'utf-8').slice(0, 4000); } catch (e) {}
  const winners = db.prepare(`SELECT x_id, campaign, offer, status, chosen_product, line_user_id FROM winners WHERE status NOT IN ('done','cancelled')`).all()
    .map((w) => `@${w.x_id}|${w.campaign}|${w.offer}|選択:${w.chosen_product || '-'}|LINE:${w.line_user_id ? String(w.line_user_id).slice(-6) : '未紐付け'}`);
  const prompt = `あなたはLINE応対Botの運用監査役です。以下は直近7日間の全会話ログ(id|顧客ID下6桁|発言者|時刻|本文先頭200字)、当選者リスト、運営ルールです。

【正しいフロー順(これに沿っているものは問題ではない)】
友だち追加→問診(健康確認)→SNS IDのテキスト申告→当選者照合→本人確認スクショ→事前確認(パートナーか1人か/2ヶ月以内レビュー可否/配送先氏名/セットなら商品選択)→提供プラン2択(送料負担 or Amazonキャッシュバック)→Amazon資格確認→LP案内→カートスクショ→注文→発送→到着→レビュー
※「事前確認がプラン提示より先」が正しい順序です。

【判定の注意】
- 運営ルールには [日付] が付いています。各会話行の時刻とルールの日付を必ず比較し、ルールの日付より前の会話には適用しないでください(日付前の違反として指摘するのは誤りです)。
- 本人確認スクリーンショットの依頼は、SNS IDのテキスト申告とは別の必須ゲートです。ID申告済みの相手へのスクショ依頼を「重複確認」として指摘しないでください。
- 友だち追加(再追加含む)の直後に問診が自動送信される仕様のため、再追加による問診の再送は異常ではありません。
- 確信が持てない指摘・推測に基づく指摘は書かないでください。

次の4種類の問題「だけ」を探して列挙してください:
1. 一貫性のない案内(似た状況の顧客に異なる説明・条件を出している)
2. フロー逸脱(本人確認・当選者照合が済む前に提供内容・商品選択・購入の案内に進んでいる)
3. 運営ルール違反(下記ルールに反する送信文)
4. 機械的な異常(同文の重複送信、客のメッセージへの応答漏れ、不自然な放置)

出力形式: 1件につき「[種別] 会話id◯◯: 根拠(1行) → 推奨対応(1行)」。確信が持てないものは書かない。問題がなければ「問題なし」とだけ。前置き・締めの文は不要。

【当選者リスト】
${winners.join('\n') || '(なし)'}

【運営ルール(抜粋)】
${rules}

【会話ログ】
${rows.join('\n')}`;
  const out = await runRaw({ prompt, maxTokens: 1200, label: 'weeklyAudit' });
  return out ? out.trim() : null;
}

(async () => {
  try {
    const insight = await analyze();
    if (insight && !/特筆すべき傾向はありません/.test(insight)) {
      lines.push('', '━━━━━━━━━━', '💡 今週の傾向と改善案', '', insight);
    }
  } catch (e) { console.error('Analysis failed:', e.message); }
  try {
    const audit = await auditWeek();
    if (audit && !/^問題なし/.test(audit)) {
      lines.push('', '━━━━━━━━━━', '🔍 AI監査(会話ログの異常確認)', '', audit);
    } else if (audit) {
      lines.push('', '🔍 AI監査: 問題なし ✅');
    }
  } catch (e) { console.error('Audit failed:', e.message); }

  const text = lines.join('\n');
  if (process.argv.includes('--dry')) { console.log(text); return; }
  // この回線はTelegram宛のHTTP/1.1系TLSがDPI遮断されるため、HTTP/2クライアント(リトライ内蔵)で送る
  const { tgCallRetry } = require('./tg_h2');
  await tgCallRetry(token, 'sendMessage', { chat_id: chatId, text }, 4);
  console.log(new Date().toISOString(), 'weekly digest sent');
})().catch((e) => { console.error('Weekly digest error:', e.message); process.exit(1); });
