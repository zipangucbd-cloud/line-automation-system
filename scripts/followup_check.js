#!/usr/bin/env node
// 時限フォローアップチェッカー(launchd: com.user.line.followup が毎朝10時に実行)
// アクティブ当選者を走査し、条件該当者への文面案をBot本体(/internal/propose)へ投げる。
// 本体がTelegramに承認ボタン付きで提案し、承認するとLINEへ送信される。
require('dotenv').config();
const Database = require('better-sqlite3');
const db = new Database(process.env.DB_PATH || './data/customers.db');

const now = Date.now();
const days = (n) => n * 24 * 60 * 60 * 1000;
const utc = (s) => (s ? new Date(s.replace(' ', 'T') + 'Z').getTime() : null);

const winners = db.prepare(`SELECT * FROM winners WHERE status NOT IN ('done','cancelled') AND line_user_id IS NOT NULL`).all();
const proposals = [];
for (const w of winners) {
  if (w.reviewed_at) continue;
  const shipped = utc(w.shipped_at);
  if (!shipped) continue;
  const lastFu = utc(w.last_followup_at) || 0;
  if (now - lastFu < days(3)) continue; // 3日以内にフォロー済みならスキップ(連打防止)
  const due = w.review_due ? new Date(w.review_due + 'T00:00:00+09:00').getTime() : null;
  let label = null, text = null;
  if (now >= shipped + days(60)) {
    label = '2ヶ月経過・最終催促';
    text = 'お世話になっております。\n商品の方はお試しいただけましたでしょうか？🙌\nもしレビュー投稿が難しい場合は、大変恐縮ではございますが商品代金をご負担いただく形とさせていただきたく存じます。\nご理解いただけますと幸いです。\nご返信をお待ちしております。';
  } else if (due && now > due + days(1)) {
    label = 'レビュー予定日超過・催促';
    text = 'お世話になっております。\nレビューご投稿のご予定日を過ぎておりましたので、状況をお伺いできればと思いご連絡差し上げました🙌\nもしご都合が変わられた場合は、改めてご予定をお聞かせくださいませ。\n引き続き宜しくお願いいたします。';
  } else if (!w.arrived_at && !due && now >= shipped + days(3)) {
    label = '発送3日後・到着確認';
    text = 'お世話になっております。\n先日発送させていただいた商品は、お手元に届いておりますでしょうか？\nクール便でのお届けのため、気温により商品が溶けてしまう恐れがございます。恐れ入りますが、置き配はご利用にならず、対面でのお受け取りをお願いいたします🙏\nご不在等でお受け取りいただけていない場合は、再配達のお手配をお願いできますと幸いです。\nお手数をおかけしますが、ご確認のほど宜しくお願いいたします。';
  } else if (!due && now >= shipped + days(30)) {
    label = '発送1ヶ月・進捗確認';
    text = 'お世話になっております。\nSEXTASY®︎運営チームです。\n以前レビュアー企画で商品をご提供させていただきましたが、その後いかがでしょうか？\nお手数ですが進捗や状況についてお知らせいただけますと幸いです。\nご返信をお待ちしております。';
  }
  if (label) proposals.push({ w, label, text });
}

(async () => {
  let sent = 0;
  for (const p of proposals) {
    try {
      const res = await fetch('http://localhost:3000/internal/propose', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId: p.w.line_user_id, userName: '@' + p.w.x_id, text: p.text, label: `${p.label}(${p.w.campaign})` }),
      });
      const j = await res.json();
      if (j.ok) {
        db.prepare('UPDATE winners SET last_followup_at=CURRENT_TIMESTAMP, updated_at=CURRENT_TIMESTAMP WHERE id=?').run(p.w.id);
        sent++;
      }
    } catch (e) { console.error('propose failed for @' + p.w.x_id + ':', e.message); }
  }
  console.log(`followup check done: active=${winners.length}, matched=${proposals.length}, proposed=${sent}`);
})();
