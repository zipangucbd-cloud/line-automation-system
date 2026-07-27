const { getBot } = require('./bot');
const { generateReply } = require('../claude/client');
const { buildWinnerContext } = require('../utils/winner_match');
const config = require('../config');
const logger = require('../utils/logger');
const pendingApprovals = new Map();
const tgMsgToApproval = new Map();
let deps = {};
function setup(d) { deps = d; setupCallbacks(); }
async function handleMessage({ userId, userName, messageText }) {
  logger.info(`Processing message from ${userName}`);
  deps.saveConversation({ userId, direction: 'incoming', content: messageText });
  const customer = deps.getCustomer(userId);
  let winnerInfo = null;
  try { winnerInfo = buildWinnerContext({ deps, messageText, customer, userId }); if (winnerInfo) logger.info(`Winner match: ${winnerInfo.substring(0, 60)}`); }
  catch (e) { logger.error('Winner match error:', e.message); }
  const history = deps.getRecentConversations(userId, 6).reverse().map(c => ({ role: c.direction === 'incoming' ? 'user' : 'assistant', content: c.content }));
  let reply;
  try { reply = await generateReply({ userName, messageText, conversationHistory: history, customerData: customer, winnerInfo }); }
  catch (err) { logger.error('Reply generation failed:', err.message); return; }
  const id = Date.now().toString();
  const p = { userId, userName, reply, messageText, customerData: customer, history, winnerInfo, tgMsgId: null };
  pendingApprovals.set(id, p);
  deps.saveApproval({ approvalId: id, userId, generatedReply: reply, status: 'pending' });
  await sendApproval(id, p, false);
}
async function sendApproval(id, p, isRevision) {
  const bot = getBot();
  if (!bot || !config.telegram.approvalChatId) return;
  const trunc = p.messageText.length > 500 ? p.messageText.substring(0, 500) + '...' : p.messageText;
  const head = isRevision ? `🔄 修正版 承認依頼 #${id}` : `🤖 承認依頼 #${id}`;
  const text = `${head}\n\n👤 ${p.userName}様：\n${trunc}\n\n━━━━━━━━━━\n\n📝 AI返答：\n${p.reply}\n\n━━━━━━━━━━\n✏️ 修正したい場合：このメッセージに「返信」で指示を送ると再生成します`;
  const opts = { reply_markup: { inline_keyboard: [[{ text: '✅ 承認', callback_data: `a:${id}` }, { text: '❌ 却下', callback_data: `r:${id}` }]] } };
  try {
    const sent = await bot.sendMessage(config.telegram.approvalChatId, text, opts);
    if (sent && sent.message_id) { p.tgMsgId = sent.message_id; tgMsgToApproval.set(sent.message_id, id); }
  } catch (err) { logger.error('Telegram send failed:', err.message); }
}
// 承認依頼メッセージへのTelegram返信 = 修正指示 → Claude再生成 → 修正版の承認依頼を発行
async function handleRevisionRequest(msg) {
  const bot = getBot();
  const replyToId = msg.reply_to_message.message_id;
  const approvalId = tgMsgToApproval.get(replyToId);
  if (!approvalId) return;
  const p = pendingApprovals.get(approvalId);
  if (!p) {
    try { await bot.sendMessage(msg.chat.id, '⚠️ この承認依頼は既に処理済みです'); } catch (e) {}
    return;
  }
  const feedback = msg.text;
  logger.info(`Revision requested for #${approvalId}: ${feedback.substring(0, 80)}`);
  let newReply;
  try {
    newReply = await generateReply({ userName: p.userName, messageText: p.messageText, conversationHistory: p.history, customerData: p.customerData, winnerInfo: p.winnerInfo, previousReply: p.reply, feedback });
  } catch (err) {
    logger.error('Revision generation failed:', err.message);
    try { await bot.sendMessage(msg.chat.id, `❌ 再生成に失敗しました: ${err.message}`); } catch (e) {}
    return;
  }
  const newId = Date.now().toString();
  deps.updateApproval({ approvalId, status: 'revised', finalReply: null });
  pendingApprovals.delete(approvalId);
  tgMsgToApproval.delete(replyToId);
  if (p.tgMsgId) {
    try { await bot.editMessageText(`✏️ 修正指示を反映 → 🔄 #${newId}\n\n指示: ${feedback}`, { chat_id: msg.chat.id, message_id: p.tgMsgId }); } catch (e) {}
  }
  const np = { userId: p.userId, userName: p.userName, reply: newReply, messageText: p.messageText, customerData: p.customerData, history: p.history, winnerInfo: p.winnerInfo, tgMsgId: null };
  pendingApprovals.set(newId, np);
  deps.saveApproval({ approvalId: newId, userId: p.userId, generatedReply: newReply, status: 'pending' });
  await sendApproval(newId, np, true);
}
function setupCallbacks() {
  const bot = getBot(); if (!bot) return;
  bot.on('message', async (msg) => {
    try {
      if (!msg.text || msg.text.startsWith('/')) return;
      if (!config.telegram.approvalChatId || String(msg.chat.id) !== String(config.telegram.approvalChatId)) return;
      if (!msg.reply_to_message) return;
      await handleRevisionRequest(msg);
    } catch (err) { logger.error('Revision handler error:', err.message); }
  });
  bot.on('callback_query', async (q) => {
    const [action, id] = q.data.split(':');
    const p = pendingApprovals.get(id);
    if (!p) { await bot.answerCallbackQuery(q.id, { text: '期限切れ' }); return; }
    if (action === 'a') {
      const ok = await deps.sendLineReply(p.userId, p.reply);
      if (ok) { deps.saveConversation({ userId: p.userId, direction: 'outgoing', content: p.reply }); deps.updateApproval({ approvalId: id, status: 'approved', finalReply: p.reply }); }
      await bot.answerCallbackQuery(q.id, { text: ok ? '✅ 送信完了' : '❌ 失敗' });
      try { await bot.editMessageText(`✅ 承認・送信済\n\n${q.message.text}`, { chat_id: q.message.chat.id, message_id: q.message.message_id }); } catch (e) {}
      pendingApprovals.delete(id);
      if (p.tgMsgId) tgMsgToApproval.delete(p.tgMsgId);
    } else if (action === 'r') {
      deps.updateApproval({ approvalId: id, status: 'rejected', finalReply: null });
      await bot.answerCallbackQuery(q.id, { text: '❌ 却下' });
      try { await bot.editMessageText(`❌ 却下\n\n${q.message.text}`, { chat_id: q.message.chat.id, message_id: q.message.message_id }); } catch (e) {}
      pendingApprovals.delete(id);
      if (p.tgMsgId) tgMsgToApproval.delete(p.tgMsgId);
    }
  });
}
module.exports = { setup, handleMessage };
