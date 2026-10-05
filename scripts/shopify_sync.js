#!/usr/bin/env node
// Shopify巡回: 当選者の注文と発送を検知して自動記帳し、必要なら発送通知の承認カードを立てる。
//
// 【2026-10-05 照合方式を全面見直し】
// 旧実装は姓名トリック(配送先の「名」=X ID)だけで照合していたが、実際の注文では
// 当選者も本名で入力しており、直近14日の注文50件中の一致は0件だった(=ほぼ発火せず)。
// → お客様が報告してくれる「注文番号」で照合する方式に変更。Shopifyの注文番号は
//    #11803 / 11803 / 0W75INGUT(確認番号)の3通りの見え方があり、お客様はどれを
//    報告してくるか分からないため、3通りすべてを索引にして正規化して突き合わせる。
//    姓名トリックと配送先氏名も補助として残す。
//
// 記帳は常に行い、通知カードは「まだ伝えていない場合」だけ立てる(二重連絡の防止)。
require('dotenv').config();
// この回線ではShopifyのIPv4アドレスが遮断されており(curlは通るがnodeのfetchはETIMEDOUT)、
// 名前解決の順番次第で成功したり失敗したりする。IPv6は安定して通るので優先順を固定する。
// ※Telegramは逆にIPv4のみ疎通するため、あちらはローカルのHTTP/2プロキシ経由にしている
require('dns').setDefaultResultOrder('ipv6first');
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const SHOP = process.env.SHOPIFY_SHOP;
const CID = process.env.SHOPIFY_CLIENT_ID;
const SEC = process.env.SHOPIFY_CLIENT_SECRET;
const TG_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TG_CHAT = process.env.TELEGRAM_APPROVAL_CHAT_ID;
const DRY = process.argv.includes('--dry');
const SINCE_DAYS = Number(((process.argv.find((a) => a.startsWith('--since-days=')) || '').split('=')[1]) || 21);
if (!SHOP || !CID || !SEC) { console.error('Shopify credentials missing'); process.exit(1); }

const STATE = path.join(__dirname, '../data/shopify_seen.json');
let seen = { fulfillments: [], orders: [] };
try { seen = JSON.parse(fs.readFileSync(STATE, 'utf-8')); } catch (e) {}

const db = new Database(path.join(__dirname, '../data/customers.db'));
const wcols = db.prepare('PRAGMA table_info(winners)').all().map((c) => c.name);
for (const [n, t] of [['order_number', 'TEXT'], ['order_date', 'DATETIME'], ['tracking_number', 'TEXT'], ['carrier', 'TEXT'], ['full_name', 'TEXT'], ['plan', 'TEXT']]) {
  if (!wcols.includes(n)) db.exec(`ALTER TABLE winners ADD COLUMN ${n} ${t}`);
}

const log = (...a) => console.log(new Date().toISOString(), ...a);

// 一時的な名前解決・接続の失敗で巡回ごと落ちないように再試行する
async function fetchRetry(url, opts = {}, tries = 3) {
  let last;
  for (let i = 1; i <= tries; i++) {
    try {
      return await fetch(url, { ...opts, signal: AbortSignal.timeout(30000) });
    } catch (e) {
      last = e;
      log(`接続に失敗(${i}/${tries}): ${e.cause?.code || e.message}`);
      if (i < tries) await new Promise((r) => setTimeout(r, i * 3000));
    }
  }
  throw last;
}
const norm = (s) => String(s || '').trim().replace(/^#/, '').toUpperCase();
const validId = (s) => /^[a-z0-9_]{1,15}$/.test(String(s || '').toLowerCase());

async function tg(text) {
  if (DRY) { log('[dry] TG:', text.replace(/\n/g, ' ').slice(0, 100)); return; }
  try {
    await fetch(`${process.env.TG_API_BASE || 'http://127.0.0.1:8081'}/bot${TG_TOKEN}/sendMessage`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: TG_CHAT, text }), signal: AbortSignal.timeout(20000),
    });
  } catch (e) { log('TG送信に失敗:', e.message); }
}

(async () => {
  const tr = await fetchRetry(`https://${SHOP}/admin/oauth/access_token`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ grant_type: 'client_credentials', client_id: CID, client_secret: SEC }),
  }).then((r) => r.json());
  if (!tr.access_token) { console.error('token grant failed'); process.exit(1); }
  const H = { 'X-Shopify-Access-Token': tr.access_token };

  // 注文を取得(ページングは3ページまで)
  const since = new Date(Date.now() - SINCE_DAYS * 86400000).toISOString();
  let url = `https://${SHOP}/admin/api/2026-07/orders.json?status=any&created_at_min=${encodeURIComponent(since)}&limit=250&fields=id,name,order_number,confirmation_number,created_at,shipping_address,fulfillments`;
  const orders = [];
  for (let page = 0; page < 3 && url; page++) {
    const res = await fetchRetry(url, { headers: H });
    const j = await res.json();
    orders.push(...(j.orders || []));
    const link = res.headers.get('link') || '';
    const m = link.match(/<([^>]+)>;\s*rel="next"/);
    url = m ? m[1] : null;
  }
  log(`直近${SINCE_DAYS}日の注文: ${orders.length}件`);

  // お客様が報告してくる可能性のある表記をすべて索引にする
  const byKey = new Map();
  const byTrick = new Map();
  const byName = new Map();
  for (const o of orders) {
    for (const k of [o.name, String(o.order_number), o.confirmation_number]) if (k) byKey.set(norm(k), o);
    const sa = o.shipping_address || {};
    const fn = String(sa.first_name || '').trim();
    if (validId(fn)) byTrick.set(fn.toLowerCase(), o);
    const full = `${sa.last_name || ''}${sa.first_name || ''}`.replace(/\s|　/g, '');
    if (full.length >= 3) byName.set(full, o);
  }

  const winners = db.prepare("SELECT * FROM winners WHERE status NOT IN ('done','cancelled')").all();
  let matched = 0, recorded = 0, proposed = 0, skipped = 0;

  for (const w of winners) {
    let o = w.order_number ? byKey.get(norm(w.order_number)) : null;
    let via = o ? '注文番号' : null;
    if (!o) { o = byTrick.get(String(w.x_id).toLowerCase()); via = o ? '姓名トリック' : null; }
    if (!o && w.full_name) { o = byName.get(String(w.full_name).replace(/\s|　/g, '')); via = o ? '配送先氏名' : null; }
    if (!o) continue;
    matched++;

    const sa = o.shipping_address || {};
    const fullName = `${sa.last_name || ''} ${sa.first_name || ''}`.trim() || null;
    // 注文の記帳(正式な注文番号に正規化して保存し、次回以降の照合を確実にする)
    if (!DRY) {
      db.prepare(`UPDATE winners SET order_number = ?, order_date = COALESCE(order_date, ?), full_name = COALESCE(full_name, ?), plan = COALESCE(plan, 'shipping'), updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
        .run(o.name, o.created_at, validId(sa.first_name) ? null : fullName, w.id);
    }
    if (!seen.orders.includes(o.id)) { seen.orders.push(o.id); recorded++; log(`注文を記帳: @${w.x_id} = ${o.name} (${via}で照合)`); }

    for (const f of (o.fulfillments || [])) {
      const tn = String(f.tracking_number || (f.tracking_numbers || [])[0] || '').trim();
      if (!tn || seen.fulfillments.includes(f.id)) continue;
      seen.fulfillments.push(f.id);
      const carrier = f.tracking_company || 'ヤマト運輸';
      if (!DRY) {
        db.prepare(`UPDATE winners SET tracking_number = ?, carrier = ?, shipped_at = COALESCE(shipped_at, ?), status = CASE WHEN status IN ('pending','contacted') THEN 'shipped' ELSE status END, updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
          .run(tn, carrier, f.created_at, w.id);
      }
      log(`発送を記帳: @${w.x_id} ${o.name} 追跡${tn}`);

      if (!w.line_user_id) {
        await tg(`📦 発送を検知: @${w.x_id}(${w.campaign})/ ${o.name} / 追跡 ${tn}\n※まだLINEでやり取りが始まっていないため、通知は作成していません。`);
        continue;
      }
      // すでに伝えている場合は通知を作らない(二重連絡の防止)
      const conv = (db.prepare('SELECT group_concat(content, char(10)) t FROM (SELECT content FROM conversations WHERE user_id = ? ORDER BY id DESC LIMIT 20)').get(w.line_user_id) || {}).t || '';
      const stage = (db.prepare('SELECT stage FROM customers WHERE user_id = ?').get(w.line_user_id) || {}).stage || '';
      const told = conv.includes(tn) || conv.includes(tn.slice(0, 8));
      const past = /^S[6-9]_/.test(stage); // すでに到着・レビュー段階に進んでいる
      const old = Date.now() - new Date(f.created_at).getTime() > 7 * 86400000;
      if (told || past || old) {
        skipped++;
        log(`  通知は見送り(${told ? 'すでに追跡番号を伝達済み' : past ? `すでに${stage}まで進行` : '発送から7日以上経過'})`);
        continue;
      }
      const msg = `お世話になっております。\n\n本日、商品を発送いたしました🙏\n${carrier}(クール便)にてお届けいたします。\n\n追跡番号: ${tn}\n\nクール便のため、対面でのお受け取りをお願いいたします(置き配はご利用いただけません)。\nお受け取りになりましたら、こちらのLINEにご一報くださいませ。\n\n引き続き宜しくお願いいたします。`;
      if (DRY) { log(`  [dry] 発送通知カードを作成: @${w.x_id}`); proposed++; continue; }
      try {
        const pr = await fetch('http://127.0.0.1:3000/internal/propose', {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ userId: w.line_user_id, userName: `@${w.x_id}`, text: msg, label: `発送通知(${o.name} / 追跡 ${tn})` }),
          signal: AbortSignal.timeout(20000),
        }).then((r) => r.json());
        if (pr.ok) proposed++;
        else await tg(`⚠️ 発送通知カードの作成に失敗しました(@${w.x_id} ${o.name})。chat.line.bizで手動対応してください。`);
      } catch (e) {
        await tg(`⚠️ 発送通知カードの作成に失敗しました(@${w.x_id} ${o.name})。Botが停止している可能性があります。`);
      }
    }
  }

  seen.orders = seen.orders.slice(-800);
  seen.fulfillments = seen.fulfillments.slice(-800);
  if (!DRY) fs.writeFileSync(STATE, JSON.stringify(seen));
  log(`done. 照合=${matched}人 / 新規記帳=${recorded}件 / 通知作成=${proposed}件 / 通知見送り=${skipped}件`);
})().catch((e) => { console.error('shopify_sync error:', e.message); process.exit(1); });
