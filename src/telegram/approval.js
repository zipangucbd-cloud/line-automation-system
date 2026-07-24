const { getBot } = require('./bot');
const { generateReply } = require('../claude/client');
const config = require('../config');
const logger = require('../utils/logger');
const pendingApprovals = new Map();
let deps = {};
function setup(d) { deps = d; setupCallbacks(); }
async function handleMessage({ userId, userName, messageText }) {
  logger.info(`Processing message from ${userName}`);
  deps.saveConversation({ userId, direction: 'incoming', content: messageText });
  const customer = deps.getCustomer(userId);
  const history = deps.getRecentConversations(userId, 6).reverse().map(c => ({ role: c.direction === 'incoming' ? 'user' : 'assistant', content: c.content }));
  let reply;
  try { reply = await generateReply({ userName, messageText, conversationHistory: history, customerData: customer }); }
  catch (err) { logger.error('Reply generation failed:', err.message); return; }
  const id = Date.now().toString();
  pendingApprovals.set(id, { userId, userName, reply });
  deps.saveApproval({ approvalId: id, userId, generatedReply: reply, status: 'pending' });
  await sendApproval(id, userName, messageText, reply);
}
async function sendApproval(id, name, orig, reply) {
  const bot = getBot();
  if (!bot || !config.telegram.approvalChatId) return;
  const trunc = orig.length > 500 ? orig.substring(0, 500) + '...' : orig;
  const text = `🤖 承認依頼 #${id}\n\n👤 ${name}様：\n${trunc}\n\n━━━━━━━━━━\n\n📝 AI返答：\n${reply}`;
  const opts = { reply_markup: { inline_keyboard: [[{ text: '✅ 承認', callback_data: `a:${id}` }, { text: '❌ 却下', callback_data: `r:${id}` }]] } };
  try { await bot.sendMessage(config.telegram.approvalChatId, text, opts); }
  catch (err) { logger.error('Telegram send failed:', err.message); }
}
function setupCallbacks() {
  const bot = getBot(); if (!bot) return;
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
    } else if (action === 'r') {
      deps.updateApproval({ approvalId: id, status: 'rejected', finalReply: null });
      await bot.answerCallbackQuery(q.id, { text: '❌ 却下' });
      try { await bot.editMessageText(`❌ 却下\n\n${q.message.text}`, { chat_id: q.message.chat.id, message_id: q.message.message_id }); } catch (e) {}
      pendingApprovals.delete(id);
    }
  });
}
module.exports = { setup, handleMessage };
