#!/usr/bin/env node
// 時限フォローアップ(launchd: com.user.line.followup が毎朝10時に実行)
//
// 【2026-09-16 全面改修】以前は winners.shipped_at を起点にしていたが、この値は
// 「LINEで発送を伝えた会話」か Shopify照合でしか埋まらず、実際は111人中1人しか
// 入っていなかった。そのため毎日 matched=0 で空回りし、38人が最長39日放置されていた。
// → 判定の起点を「customers.stage + 最後のやり取りからの経過日数」に変更する。
// ステージはBotが返信のたびに更新しているので、こちらは確実に溜まっている。
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const { runRaw } = require('../src/claude/client');

const db = new Database(process.env.DB_PATH || './data/customers.db');
const DRY = process.argv.includes('--dry');
const limitArg = process.argv.find((a) => a.startsWith('--limit='));
const LIMIT = limitArg ? Number(limitArg.split('=')[1]) : 8; // 1回の提案数の上限(グループが溢れないように)
const now = Date.now();
const day = 86400000;
const utc = (s) => (s ? new Date(String(s).replace(' ', 'T') + 'Z').getTime() : null);

// 連打防止のため、顧客ごとの最終フォロー日時を持つ
if (!db.prepare('PRAGMA table_info(customers)').all().some((c) => c.name === 'last_followup_at')) {
  db.exec('ALTER TABLE customers ADD COLUMN last_followup_at DATETIME');
}

// ステージごとの「何日放置されたら声をかけるか」と、声かけの狙い
const RULES = [
  [/^S1_/, 3, '問診(アンケート)の回答をやさしく促す'],
  [/^S2_/, 3, '本人確認のためのXプロフィールのスクリーンショット送付を促す'],
  [/^S3_/, 3, '事前確認(パートナーの有無・2ヶ月以内にレビュー可能か・配送先のフルネーム)の回答を促す'],
  [/^S4_/, 3, 'ご提供プランの選択や、Amazonのカート画面のスクリーンショットなど、次の一手の進捗を確認する'],
  [/^S5_/, 3, 'ご注文番号のご連絡、または発送済みであれば商品の到着確認をする'],
  [/^S6_/, 3, '商品の到着確認、または使用前の説明事項へのご返答を促す'],
  [/^S7_/, 5, 'レビュー投稿前の下書きのご提出を促す'],
  [/^S8_/, 5, 'ECサイトへのレビュー投稿と完了のご報告を促す'],
  [/^S9_/, 7, 'キャッシュバックの手続き、または次の商品のご案内へのご返答を伺う'],
  [/^対応保留/, 7, '保留となっている件について、その後の状況を伺う'],
];
function ruleFor(stage) {
  for (const [re, d, aim] of RULES) if (re.test(stage)) return { days: d, aim };
  return { days: 5, aim: 'その後の状況を伺う' };
}

async function tg(text) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chat = process.env.TELEGRAM_APPROVAL_CHAT_ID;
  if (!token || !chat || DRY) { if (DRY) console.log('[dry] TG:', text.slice(0, 120)); return; }
  try {
    await fetch(`${process.env.TG_API_BASE || 'http://127.0.0.1:8081'}/bot${token}/sendMessage`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: chat, text }), signal: AbortSignal.timeout(20000),
    });
  } catch (e) { console.error('tg failed:', e.message); }
}

// 送信枠が尽きていると承認しても送れないため、提案を作らずに知らせるだけにする
async function lineQuotaLeft() {
  const t = process.env.LINE_CHANNEL_ACCESS_TOKEN;
  if (!t) return null;
  try {
    const h = { Authorization: `Bearer ${t}` };
    const q = await fetch('https://api.line.me/v2/bot/message/quota', { headers: h, signal: AbortSignal.timeout(15000) }).then((r) => r.json());
    const c = await fetch('https://api.line.me/v2/bot/message/quota/consumption', { headers: h, signal: AbortSignal.timeout(15000) }).then((r) => r.json());
    if (q && q.type === 'none') return Infinity; // 無制限プラン
    if (typeof q?.value === 'number' && typeof c?.totalUsage === 'number') return q.value - c.totalUsage;
  } catch (e) { console.error('quota check failed:', e.message); }
  return null;
}

(async () => {
  const left = await lineQuotaLeft();
  if (left !== null && left !== Infinity) console.log(`LINE送信の残り: ${left}通`);
  if (left !== null && left <= 0 && !DRY) {
    console.log('送信枠が尽きているため提案は作らない');
    await tg('📛 LINEの送信枠を使い切っているため、本日のフォローアップ(到着確認・投稿催促)は見送りました。\nプラン変更が反映されると自動で再開します。');
    return;
  }

  if (DRY && left !== null && left <= 0) console.log('※送信枠は尽きているが、--dryのため対象の確認だけ続行する');
  const rows = db.prepare(`
    SELECT c.user_id, c.display_name, c.stage, c.last_followup_at,
           (SELECT MAX(timestamp) FROM conversations v WHERE v.user_id = c.user_id) last_at,
           (SELECT direction FROM conversations v WHERE v.user_id = c.user_id ORDER BY v.id DESC LIMIT 1) last_dir
    FROM customers c
    WHERE c.stage IS NOT NULL AND c.stage NOT IN ('完了')`).all();

  const targets = [];   // こちらが最後に話していて、相手が沈黙している人(=声をかける)
  const waitingUs = []; // 相手が最後に話していて、こちらの返信が止まっている人(=声をかけない)
  for (const r of rows) {
    if (!r.last_at) continue;
    const idle = Math.floor((now - utc(r.last_at)) / day);
    const { days, aim } = ruleFor(r.stage);
    if (idle < days) continue;
    if (r.last_dir === 'incoming') { waitingUs.push({ ...r, idle }); continue; }
    if (utc(r.last_followup_at) && now - utc(r.last_followup_at) < 3 * day) continue; // 連打防止
    // 未処理の承認カードが残っている人には重ねて提案しない
    const pend = db.prepare("SELECT 1 FROM approvals WHERE user_id = ? AND status = 'pending' LIMIT 1").get(r.user_id);
    if (pend) continue;
    // 経過が長い場合は催促の段階を上げる
    let aimFinal = aim;
    let label = `${r.stage} ${idle}日停滞`;
    if (idle >= 60) { aimFinal = 'レビュー期限(商品到着後2ヶ月)を過ぎているため、最終のご連絡として、レビュー投稿が難しい場合は商品代金のご負担をお願いする旨を丁寧に伝える'; label = `2ヶ月超・最終催促(${idle}日)`; }
    else if (idle >= 30) { aimFinal = '1ヶ月以上ご連絡がないため、その後の状況を伺い、必要なら再度ご案内する'; label = `1ヶ月超・進捗確認(${idle}日)`; }
    targets.push({ ...r, idle, aim: aimFinal, label });
  }
  targets.sort((a, b) => b.idle - a.idle);

  let sys = '';
  try {
    sys = fs.readFileSync(path.join(__dirname, '../src/knowledge/system_prompt.md'), 'utf-8');
    const learned = fs.readFileSync(path.join(__dirname, '../src/knowledge/learned.md'), 'utf-8').trim();
    if (learned) sys += `\n\n---\n# 【最優先】運営から直接教わった知識\n${learned}\n`;
  } catch (e) {}

  let sent = 0;
  for (const t of targets.slice(0, LIMIT)) {
    const hist = db.prepare('SELECT direction, content, timestamp FROM conversations WHERE user_id = ? ORDER BY id DESC LIMIT 12').all(t.user_id).reverse()
      .map((m) => `${m.direction === 'incoming' ? 'お客様' : '運営'}: ${String(m.content).slice(0, 300)}`).join('\n----\n');
    const prompt = `【状況】${t.display_name || 'お客様'}様は「${t.stage}」の段階で、こちらの最後のご連絡から${t.idle}日間お返事がありません。
【今回の目的】${t.aim}
【これまでの会話(古い順)】
${hist}

上の会話の続きとして、お客様へ送る催促のメッセージを1通だけ作成してください。
・責める口調は絶対に避け、あくまで気遣いとして声をかける
・話を最初から蒸し返さず、会話の続きとして自然につなげる
・お客様に何をしてほしいかが1つだけ明確に伝わるようにする
・返信本文だけを出力し、<<...>>のような記号や社内向けの説明は書かない`;
    let text;
    try {
      text = (await runRaw({ system: sys, prompt, maxTokens: 900, label: 'followup' })).trim();
    } catch (e) { console.error(`生成失敗 ${t.display_name}:`, e.message); continue; }
    if (!text) continue;
    if (DRY) { console.log(`--- [dry] ${t.display_name} (${t.label})\n${text.slice(0, 200)}\n`); sent++; continue; }
    try {
      const j = await fetch('http://localhost:3000/internal/propose', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId: t.user_id, userName: t.display_name || 'お客様', text, label: t.label }),
        signal: AbortSignal.timeout(30000),
      }).then((r) => r.json());
      if (j.ok) {
        db.prepare('UPDATE customers SET last_followup_at = CURRENT_TIMESTAMP WHERE user_id = ?').run(t.user_id);
        sent++;
      }
    } catch (e) { console.error(`propose失敗 ${t.display_name}:`, e.message); }
  }

  // こちらの返信が止まっている人は、催促ではなく運営への警告として出す
  if (waitingUs.length) {
    const list = waitingUs.sort((a, b) => b.idle - a.idle).slice(0, 10)
      .map((w) => `・${w.display_name || '?'}(${w.stage} / ${w.idle}日)`).join('\n');
    await tg(`🚨 お客様からのメッセージに返信できていない方が${waitingUs.length}名います\n\n${list}\n\nこの方たちには催促を送らず、先に返信の対応をお願いします(承認画面からも対応できます)。`);
  }
  const rest = Math.max(0, targets.length - LIMIT);
  if (sent) await tg(`📮 フォローアップの提案を${sent}件お送りしました(${rest ? `残り${rest}件は明日以降に順次` : '対象は本日分で全て'})。\n内容を確認して、問題なければ承認してください。`);
  console.log(`followup check done: 対象=${targets.length}, 提案=${sent}, 返信待ち=${waitingUs.length}, 残枠=${left}`);
})();
