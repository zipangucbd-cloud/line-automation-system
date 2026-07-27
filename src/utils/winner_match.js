// メッセージ/顧客情報からX IDを特定し、当選者リスト(winners)と照合する
// 戻り値: Claudeへ渡す【当選者照合】コンテキスト文字列 or null(照合材料なし)

function extractXId(text) {
  if (!text) return null;
  // 問診テンプレの回答欄「X：xxx」「X: xxx」形式を最優先
  let m = text.match(/(?:X|Ｘ|Twitter)\s*[:：]\s*@?([A-Za-z0-9_]{1,15})/i);
  if (m && !/^_+$/.test(m[1])) return m[1];
  // 「@xxx」形式のフォールバック
  m = text.match(/@([A-Za-z0-9_]{1,15})/);
  if (m && !/^_+$/.test(m[1])) return m[1];
  return null;
}

function buildWinnerContext({ deps, messageText, customer, userId }) {
  // 既にLINEユーザーへ紐付け済みの当選者がいれば最優先
  const linked = deps.findWinnerByLineUser(userId);
  if (linked) {
    return `照合OK(紐付け済み): @${linked.x_id} は「${linked.campaign}」の当選者です。提供内容: ${linked.offer} / 区分: ${linked.tier} / 状態: ${linked.status}${linked.chosen_product ? ' / 選択商品: ' + linked.chosen_product : ''}。この企画・提供内容に沿ってフローを進めてください。`;
  }
  // 未紐付け: メッセージ中のID申告 or 顧客カルテのx_handleで照合
  const claimed = extractXId(messageText) || (customer && customer.x_handle);
  if (!claimed) return null;
  const winner = deps.findWinnerByXid(claimed);
  if (winner) {
    deps.linkWinnerToLine({ winnerId: winner.id, lineUserId: userId });
    deps.upsertCustomer({ userId, xHandle: claimed });
    return `照合OK: 申告ID @${claimed} は「${winner.campaign}」の当選者リストに登録されています。提供内容: ${winner.offer} / 区分: ${winner.tier}。本人確認(Xプロフィールスクショ)が未完了ならS2を先に行い、完了後にこの提供内容でフローを進めてください。`;
  }
  return `照合NG: 申告されたID「@${claimed}」は当選者リストに未登録です。提供案内には進まず、返信案の冒頭に「[要人間判断] 当選者リスト未登録のID申告」を付けて保留してください。`;
}

module.exports = { extractXId, buildWinnerContext };
