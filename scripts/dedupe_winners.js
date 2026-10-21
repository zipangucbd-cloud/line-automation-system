#!/usr/bin/env node
// 当選者レコードの重複を1行に寄せる。
// 同じ企画の当選者リストを2回投入すると同じ人が複数行になり(2026-10-21時点で9人)、
// クエリによって空の行を引いてしまい「発送済みなのに未着手に見える」状態が起きる。
// データは消さず、情報の多い行へまとめてから余りを cancelled にする。
// 使い方: node scripts/dedupe_winners.js [--apply]   (既定は確認のみ)
require('dotenv').config();
const Database = require('better-sqlite3');
const db = new Database(process.env.DB_PATH || './data/customers.db');
const APPLY = process.argv.includes('--apply');

// 情報の多さを測る対象(埋まっているほど「本物の行」とみなす)
const FIELDS = ['line_user_id', 'order_number', 'order_date', 'tracking_number', 'carrier',
  'shipped_at', 'arrived_at', 'review_due', 'reviewed_at', 'chosen_product', 'plan', 'full_name',
  'eval', 'impressions', 'genre', 'face', 'shadowban', 'followers', 'eval_note', 'notes'];

const rows = db.prepare("SELECT * FROM winners WHERE status NOT IN ('cancelled')").all();
const groups = new Map();
for (const r of rows) {
  const k = String(r.x_id || '').toLowerCase();
  if (!k) continue;
  if (!groups.has(k)) groups.set(k, []);
  groups.get(k).push(r);
}

const score = (r) => FIELDS.reduce((n, f) => n + (r[f] != null && r[f] !== '' ? 1 : 0), 0);
// 企画名の正規化(「(企画名なし)」は企画の指定漏れとみなし、他と同じ束に入れる)
const campKey = (r) => {
  const c = String(r.campaign || '').trim();
  return (!c || c === '(企画名なし)') ? '' : c;
};

let merged = 0, cancelled = 0;
const crossCampaign = [];

for (const [xid, all] of groups) {
  if (all.length < 2) continue;
  // 企画ごとに束ねる。別企画は「2回当選」の可能性があるので混ぜない
  const buckets = new Map();
  for (const r of all) {
    const k = campKey(r);
    if (!buckets.has(k)) buckets.set(k, []);
    buckets.get(k).push(r);
  }
  const namedCamps = [...buckets.keys()].filter(Boolean);
  // 企画名が未記入の行は、その人の企画が1つしか無いときだけそこへ寄せる
  if (buckets.has('') && namedCamps.length === 1) {
    buckets.get(namedCamps[0]).push(...buckets.get(''));
    buckets.delete('');
  }
  if (namedCamps.length > 1) {
    crossCampaign.push({ xid, camps: namedCamps, rows: all.map((r) => `#${r.id} ${r.campaign}[${r.status}]`) });
  }
  for (const [camp, list] of buckets) {
    if (list.length < 2) continue;
    mergeGroup(xid, camp, list);
  }
}

function mergeGroup(xid, camp, list) {
  const keeper = list.slice().sort((a, b) => score(b) - score(a) || b.id - a.id)[0];
  const others = list.filter((r) => r.id !== keeper.id);
  // 余りの行にしか無い情報を keeper へ移してから、余りを取り下げる
  const fill = {};
  for (const f of FIELDS) {
    if (keeper[f] != null && keeper[f] !== '') continue;
    for (const o of others) if (o[f] != null && o[f] !== '') { fill[f] = o[f]; break; }
  }
  // 進行状況は一番進んでいるものを採用する
  const RANK = ['pending', 'contacted', 'shipped', 'arrived', 'reviewed', 'done'];
  const best = list.map((r) => r.status).sort((a, b) => RANK.indexOf(b) - RANK.indexOf(a))[0];
  const keys = Object.keys(fill);
  console.log(`■ @${xid} (${list.length}行) → #${keeper.id} に集約`);
  for (const o of others) console.log(`   取り下げ: #${o.id} ${o.campaign}[${o.status}] ${score(o) ? '(情報' + score(o) + '件は移送)' : '(空)'}`);
  if (keys.length) console.log(`   補完する項目: ${keys.join(', ')}`);
  if (best !== keeper.status) console.log(`   状態: ${keeper.status} → ${best}`);
  if (APPLY) {
    if (keys.length || best !== keeper.status) {
      const sets = keys.map((k) => `${k} = ?`).concat('status = ?', 'updated_at = CURRENT_TIMESTAMP');
      db.prepare(`UPDATE winners SET ${sets.join(', ')} WHERE id = ?`).run(...keys.map((k) => fill[k]), best, keeper.id);
    }
    for (const o of others) {
      db.prepare("UPDATE winners SET status = 'cancelled', notes = COALESCE(notes || ' / ', '') || ? , updated_at = CURRENT_TIMESTAMP WHERE id = ?")
        .run(`重複のため#${keeper.id}へ集約(2026-10-21)`, o.id);
      cancelled++;
    }
  } else cancelled += others.length;
  merged++;
}


if (crossCampaign.length) {
  console.log('\n▲ 複数の企画に登録がある方(企画ごとに別々に扱っています。2回当選でなければ要確認)');
  for (const c of crossCampaign) console.log(`   @${c.xid}: ${c.rows.join(' / ')}`);
}
console.log(`\n${APPLY ? '適用しました' : '確認のみ(--apply で実行)'}: ${merged}人を集約 / ${cancelled}行を取り下げ`);
