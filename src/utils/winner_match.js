// メッセージ/顧客情報からSNS ID(X / Instagram)を特定し、当選者リスト(winners)と照合する
// 戻り値: Claudeへ渡す【当選者照合】コンテキスト文字列 or null(照合材料なし)

const PLACEHOLDER = /^[_＿\-ー―—\s]*$/;

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

function buildWinnerContext({ deps, messageText, customer, userId }) {
  // 既にLINEユーザーへ紐付け済みの当選者がいれば最優先
  const linked = deps.findWinnerByLineUser(userId);
  if (linked) {
    return `照合OK(紐付け済み): @${linked.x_id} は「${linked.campaign}」の当選者です。提供内容: ${linked.offer} / 区分: ${linked.tier} / 状態: ${linked.status}${linked.chosen_product ? ' / 選択商品: ' + linked.chosen_product : ''}。この企画・提供内容に沿ってフローを進めてください。`;
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
      return `照合OK: 申告ID @${claimed} は「${winner.campaign}」の当選者リストに登録されています。提供内容: ${winner.offer} / 区分: ${winner.tier}。本人確認(プロフィールのスクリーンショット)が未完了ならS2を先に行い、完了後にこの提供内容でフローを進めてください。`;
    }
  }

  const shown = [ids.x ? `X: @${ids.x}` : null, ids.instagram ? `Instagram: @${ids.instagram}` : null]
    .filter(Boolean).join(' / ') || `@${candidates[0]}`;
  return `照合NG: 申告されたID(${shown})は当選者リストに未登録です。提供案内には進まず、返信案の冒頭に「[要人間判断] 当選者リスト未登録のID申告」を付けて保留してください。`;
}

module.exports = { extractXId, extractSnsIds, buildWinnerContext };
