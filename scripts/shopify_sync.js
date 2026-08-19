#!/usr/bin/env node
// Shopify巡回: 発送(フルフィルメント)を検知して当選者と自動照合し、
// 注文番号・注文日・追跡番号・実名をwinnersに自動記帳。発送済みになったら
// 「発送報告」の承認カードを自動起票する(✅でLINE送信される、通常の承認フロー)。
// 当選者の特定は姓名トリック(注文の「名」=X ID)を使う。一般のお客様の注文は無視。
// launchd (com.user.line.shopifysync) が15分ごとに実行。--dry で書き込み・通知なし
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const SHOP = process.env.SHOPIFY_SHOP;
const CID = process.env.SHOPIFY_CLIENT_ID;
const SEC = process.env.SHOPIFY_CLIENT_SECRET;
const TG_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TG_CHAT = process.env.TELEGRAM_APPROVAL_CHAT_ID;
const DRY = process.argv.includes('--dry');
if (!SHOP || !CID || !SEC) { console.error('Shopify credentials missing'); process.exit(1); }

const STATE = path.join(__dirname, '../data/shopify_seen.json');
let seen = { fulfillments: [], orders: [] };
try { seen = JSON.parse(fs.readFileSync(STATE, 'utf-8')); } catch (e) {}

const db = new Database(path.join(__dirname, '../data/customers.db'));
// 列が無ければ足す(Bot本体のinitDbにも同じ定義を置くが、単独プロセスとしても自衛する)
const wcols = db.prepare('PRAGMA table_info(winners)').all().map((c) => c.name);
for (const [name, type] of [['order_number', 'TEXT'], ['order_date', 'DATETIME'], ['tracking_number', 'TEXT'], ['carrier', 'TEXT'], ['full_name', 'TEXT']]) {
  if (!wcols.includes(name)) db.exec(`ALTER TABLE winners ADD COLUMN ${name} ${type}`);
}

const log = (...a) => console.log(new Date().toISOString(), ...a);

async function tgSend(text) {
  if (DRY) { log('[dry] TG:', text.replace(/\n/g, ' ').slice(0, 90)); return; }
  try {
    await fetch(`http://127.0.0.1:8081/bot${TG_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: TG_CHAT, text }),
      signal: AbortSignal.timeout(20000),
    });
  } catch (e) { log('TG send failed:', e.message); }
}

const normId = (s) => String(s || '').replace(/^@/, '').trim().toLowerCase();
const validId = (s) => /^[a-z0-9_]{1,15}$/.test(s);

(async () => {
  // トークンは実行のたびに発行する(client_credentials・24時間有効。保存しない方が単純で安全)
  const tr = await fetch(`https://${SHOP}/admin/oauth/access_token`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ grant_type: 'client_credentials', client_id: CID, client_secret: SEC }),
    signal: AbortSignal.timeout(20000),
  }).then((r) => r.json());
  if (!tr.access_token) { console.error('token grant failed:', JSON.stringify(tr).slice(0, 150)); process.exit(1); }
  const H = { 'X-Shopify-Access-Token': tr.access_token };

  const since = new Date(Date.now() - 72 * 3600000).toISOString();
  const res = await fetch(`https://${SHOP}/admin/api/2026-07/orders.json?status=any&updated_at_min=${encodeURIComponent(since)}&limit=100&fields=id,name,created_at,shipping_address,fulfillments`, {
    headers: H,
    signal: AbortSignal.timeout(30000),
  }).then((r) => r.json());
  const orders = res.orders || [];
  log(`orders in 72h window: ${orders.length}`);

  const findWinner = db.prepare(`SELECT * FROM winners WHERE lower(x_id) = ? AND status NOT IN ('done','cancelled') ORDER BY (shipped_at IS NULL) DESC, id DESC LIMIT 1`);
  let matched = 0;
  let shipped = 0;

  for (const o of orders) {
    const sa = o.shipping_address || {};
    const xid = normId(sa.first_name);
    if (!validId(xid)) continue; // 姓名トリックの形でない = 一般のお客様の注文
    const w = findWinner.get(xid);
    if (!w) continue;
    matched++;
    const fullName = (sa.last_name || '').trim() || null;

    // 注文の記帳(初回検知時のみ)。既存値は上書きしない
    if (!seen.orders.includes(o.id)) {
      seen.orders.push(o.id);
      if (!DRY) {
        db.prepare(`UPDATE winners SET order_number = COALESCE(order_number, ?), order_date = COALESCE(order_date, ?), full_name = COALESCE(full_name, ?), updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
          .run(o.name, o.created_at, fullName, w.id);
      }
      await tgSend(`🛒 Shopify注文を検知: ${fullName || ''}様(@${w.x_id} / ${w.campaign})\n注文 ${o.name} / ${String(o.created_at).slice(0, 10)} — winnersに自動記帳しました`);
      log(`order matched: ${o.name} -> @${w.x_id}`);
    }

    // 発送(追跡番号つきフルフィルメント)の記帳+発送報告カードの自動起票
    for (const f of (o.fulfillments || [])) {
      const tn = String(f.tracking_number || (f.tracking_numbers || [])[0] || '').trim();
      if (!tn || seen.fulfillments.includes(f.id)) continue;
      seen.fulfillments.push(f.id);
      shipped++;
      const carrier = f.tracking_company || 'ヤマト運輸';
      if (!DRY) {
        db.prepare(`UPDATE winners SET tracking_number = ?, carrier = ?, shipped_at = COALESCE(shipped_at, ?), status = CASE WHEN status IN ('pending','contacted') THEN 'shipped' ELSE status END, updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
          .run(tn, carrier, f.created_at, w.id);
      }
      log(`fulfillment: ${o.name} ${tn} -> @${w.x_id}`);

      if (w.line_user_id) {
        const msg = `お世話になっております。\n\n本日、商品を発送いたしました🙏\n${carrier}(クール便)にてお届けいたします。\n\n追跡番号: ${tn}\n\nクール便のため、対面でのお受け取りをお願いいたします(置き配はご利用いただけません)。\nお受け取りになりましたら、こちらのLINEにご一報くださいませ。\n\n引き続き宜しくお願いいたします。`;
        if (!DRY) {
          try {
            const pr = await fetch('http://localhost:3000/internal/propose', {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ userId: w.line_user_id, userName: fullName || w.x_id, text: msg, label: `発送報告(${o.name} / 追跡 ${tn})` }),
              signal: AbortSignal.timeout(20000),
            }).then((r) => r.json());
            log('propose:', JSON.stringify(pr));
            if (!pr.ok) await tgSend(`⚠️ 発送報告カードの起票に失敗しました(@${w.x_id} ${o.name})。chat.line.bizで手動対応してください。`);
          } catch (e) {
            log('propose failed:', e.message);
            await tgSend(`⚠️ 発送報告カードの起票に失敗しました(@${w.x_id} ${o.name})。Botが停止している可能性があります。`);
          }
        } else log('[dry] propose 発送報告 for', w.x_id);
      } else {
        await tgSend(`📦 発送検知: @${w.x_id}(${w.campaign})/${o.name}/追跡 ${tn}\n※この方はまだLINE未連携のため発送報告は自動起票できません。LINEが繋がったら手動で案内してください。`);
      }
    }
  }

  seen.orders = seen.orders.slice(-500);
  seen.fulfillments = seen.fulfillments.slice(-500);
  if (!DRY) fs.writeFileSync(STATE, JSON.stringify(seen));
  log(`done. winner-orders matched: ${matched}, new shipments: ${shipped}`);
})().catch((e) => { console.error('shopify_sync error:', e.message); process.exit(1); });
