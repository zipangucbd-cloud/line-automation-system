// メッセージ/顧客情報からSNS ID(X / Instagram)を特定し、当選者リスト(winners)と照合する
// 戻り値: Claudeへ渡す【当選者照合】コンテキスト文字列 or null(照合材料なし)

const PLACEHOLDER = /^[_＿\-ー―—\s]*$/;

const { negativeInfo } = require('./negative_list');
// 過去に「良くない」評価がある人なら、照合コンテキストに警告を足す
function negNote(xId) {
  const n = negativeInfo(xId);
  if (!n) return '';
  return `\n🚨【要注意】@${xId} は過去に「良くない」評価が${n.negCount}回あります(${n.history.slice(-2).join(' / ')})。再選出ミスの可能性があるため、提供の案内に進む前に運営の確認が必要です。返信案の冒頭に[要人間判断]を付けてください。`;
}

// 問診テンプレの回答欄から各SNSのIDを取り出す。
// テンプレは「X：____ / Instagram：____」の形なので、記入されていない欄は除外する。
function extractSnsIds(text) {
  const out = { x: null, instagram: null };
  if (!text) return out;
  const mx = text.match(/(?:X|Ｘ|Twitter|ツイッター)\s*[:：]\s*@?([A-Za-z0-9_.]{1,30})/i);
  if (mx && !PLACEHOLDER.test(mx[1])) out.x = mx[1].replace(/[.]+$/, '');
  const mi = text.match(/(?:Instagram|instagram|インスタ(?:グラム)?|IG)\s*[:：]\s*@?([A-Za-z0-9_.]{1,30})/i);
  if (mi && !PLACEHOLDER.test(mi[1])) out.instagram = mi[1].replace(/[.]+$/, '');
  // 「X：」等のラベルが無く @xxx とだけ送られた場合はXのIDとみなす(運用上ほぼXのため)
  if (!out.x && !out.instagram) {
    const m = text.match(/@([A-Za-z0-9_.]{1,30})/);
    if (m && !PLACEHOLDER.test(m[1])) out.x = m[1].replace(/[.]+$/, '');
  }
  return out;
}

// 後方互換のため残す(X IDのみを返す)
function extractXId(text) {
  return extractSnsIds(text).x;
}

// この人が「何の当選者/再提供」で「今どの商品を提供中か」(セットなら次に何が控えるか)を1行にまとめる。
// 承認カードの常時表示と、Claudeへの生成コンテキストの両方で使う。
function offerStatusLine(w) {
  const isReoffer = /再提供|再オファー/.test(`${w.campaign || ''}`);
  const isSet = /セット|順次/.test(`${w.offer || ''}`);
  const cur = w.chosen_product || (isSet ? '未選択(まずグミかクリームどちらから始めるか選んでもらう)' : w.offer);
  let s = isReoffer
    ? `【区分】再提供(当選企画ではない) / 提供中の商品: ${cur}`
    : `【区分】${w.campaign}の当選者 / 提供内容: ${w.offer} / 提供中の商品: ${cur}`;
  if (isSet && w.chosen_product) {
    const next = /cream|クリーム/i.test(w.chosen_product) ? 'ORIGINAL(グミ)' : 'CREAM(クリーム)';
    s += ` / この商品のレビュー完了後に${next}を案内する(同時案内・同時購入は絶対禁止)`;
  }
  // 進行プラン(送料負担=Shopify / Amazonキャッシュバック)。plan列が空なら注文番号の形式から推定する
  let plan = w.plan;
  if (!plan && w.order_number) {
    if (/^#/.test(w.order_number)) plan = 'shipping';
    else if (/^\d{3}-\d{7}-\d{7}$/.test(w.order_number)) plan = 'amazon';
  }
  if (plan === 'shipping') {
    s += `\n💳 進行プラン: 送料負担(Shopify${w.order_number ? ' 注文' + w.order_number : ''}) — 発送は自動検知され、追跡番号入りの発送報告カードが自動で立ちます`;
  } else if (plan === 'amazon') {
    s += `\n💳 進行プラン: Amazonキャッシュバック${w.order_number ? '(注文' + w.order_number + ')' : ''} — 発送・配達通知はAmazonが行うため、こちらからの追跡番号連絡は不要です`;
  } else {
    s += `\n💳 進行プラン: 未確定(まだプラン選択前か、記録漏れ)`;
  }
  return s;
}

function buildWinnerContext({ deps, messageText, customer, userId }) {
  // 既にLINEユーザーへ紐付け済みの当選者がいれば最優先
  const linked = deps.findWinnerByLineUser(userId);
  if (linked) {
    return `照合OK(紐付け済み): @${linked.x_id} は「${linked.campaign}」の当選者です。提供内容: ${linked.offer} / 区分: ${linked.tier} / 状態: ${linked.status}${linked.chosen_product ? ' / 選択商品: ' + linked.chosen_product : ''}。この企画・提供内容に沿ってフローを進めてください。\n${offerStatusLine(linked)}${negNote(linked.x_id)}`;
  }

  const ids = extractSnsIds(messageText);
  const candidates = [ids.x, ids.instagram, customer && customer.x_handle].filter(Boolean);
  if (!candidates.length) return null;

  // X・Instagramのどちらの申告でも当選者リストと突き合わせる
  for (const claimed of candidates) {
    const winner = deps.findWinnerByXid(claimed);
    if (winner) {
      deps.linkWinnerToLine({ winnerId: winner.id, lineUserId: userId });
      deps.upsertCustomer({ userId, xHandle: claimed });
      return `照合OK: 申告ID @${claimed} は「${winner.campaign}」の当選者リストに登録されています。提供内容: ${winner.offer} / 区分: ${winner.tier}。本人確認(プロフィールのスクリーンショット)が未完了ならS2を先に行い、完了後にこの提供内容でフローを進めてください。\n${offerStatusLine(winner)}${negNote(winner.x_id)}`;
    }
  }

  const shown = [ids.x ? `X: @${ids.x}` : null, ids.instagram ? `Instagram: @${ids.instagram}` : null]
    .filter(Boolean).join(' / ') || `@${candidates[0]}`;
  return `照合NG: 申告されたID(${shown})は当選者リストに未登録です。提供案内には進まず、返信案の冒頭に「[要人間判断] 当選者リスト未登録のID申告」を付けて保留してください。`;
}

module.exports = { extractXId, extractSnsIds, buildWinnerContext, offerStatusLine };
