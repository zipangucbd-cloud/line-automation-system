const { getBot } = require('./bot');
const { generateReply } = require('../claude/client');
const { buildWinnerContext } = require('../utils/winner_match');
const config = require('../config');
const logger = require('../utils/logger');
const pendingApprovals = new Map();
const tgMsgToApproval = new Map();
let deps = {};
function setup(d) { deps = d; setupCallbacks(); }
// 受信バッファ: 連続して届いたメッセージ・画像をまとめて1つの返信案にする
// (Amazonキャッシュバックでは検索結果とカート画面の2枚を続けて送ってくるため)
const inbox = new Map();
const BATCH_MS = 10000;   // 最後の受信からこの時間待って確定
const MAX_WAIT_MS = 60000; // 連投が続いても最初の受信からこの時間で強制確定
const MAX_IMAGES = 5;

async function handleMessage({ userId, userName, messageText, image = null }) {
  logger.info(`Buffering message from ${userName}${image ? ' (image)' : ''}`);
  deps.saveConversation({ userId, direction: 'incoming', content: messageText });
  deps.upsertCustomer({ userId, displayName: userName });

  const e = inbox.get(userId) || { userName, texts: [], images: [], firstAt: Date.now(), timer: null };
  e.userName = userName;
  if (image) { if (e.images.length < MAX_IMAGES) e.images.push(image); }
  else if (messageText) e.texts.push(messageText);

  if (e.timer) clearTimeout(e.timer);
  const remain = MAX_WAIT_MS - (Date.now() - e.firstAt);
  e.timer = setTimeout(() => { flushInbox(userId).catch((err) => logger.error('Flush error:', err.message)); },
                       Math.max(1000, Math.min(BATCH_MS, remain)));
  inbox.set(userId, e);
}

// バッファを確定して、まとめて1回だけ返信案を生成する
async function flushInbox(userId) {
  const e = inbox.get(userId);
  if (!e) return;
  inbox.delete(userId);
  if (e.timer) clearTimeout(e.timer);

  const { userName, texts, images } = e;
  const imgNote = images.length ? `[画像${images.length}枚を受信]` : '';
  const messageText = [texts.join('\n'), imgNote].filter(Boolean).join('\n') || '[メッセージを受信]';
  logger.info(`Processing from ${userName}: text${texts.length}件 / image${images.length}枚`);

  const customer = deps.getCustomer(userId);
  let winnerInfo = null;
  try { winnerInfo = buildWinnerContext({ deps, messageText, customer, userId }); if (winnerInfo) logger.info(`Winner match: ${winnerInfo.substring(0, 60)}`); }
  catch (err) { logger.error('Winner match error:', err.message); }
  const history = deps.getRecentConversations(userId, 30).reverse().map(c => ({ role: c.direction === 'incoming' ? 'user' : 'assistant', content: c.content }));

  let reply, stage = null;
  try { ({ reply, stage } = await generateReply({ userName, messageText, conversationHistory: history, customerData: customer, winnerInfo, images })); }
  catch (err) {
    logger.error('Reply generation failed:', err.message);
    const bot = getBot();
    if (bot && config.telegram.approvalChatId) {
      const trunc = messageText.length > 200 ? messageText.substring(0, 200) + '...' : messageText;
      try { await bot.sendMessage(config.telegram.approvalChatId, `⚠️ 返信生成に失敗しました。chat.line.bizで手動対応してください。\n\n👤 ${userName}様:\n${trunc}\n\nエラー: ${err.message}`); } catch (e2) {}
    }
    return;
  }
  if (stage) { try { deps.upsertCustomer({ userId, stage }); logger.info(`Stage -> ${stage}`); } catch (err) { logger.error('Stage save failed:', err.message); } }
  const id = Date.now().toString();
  const p = { userId, userName, reply, stage, messageText, customerData: customer, history, winnerInfo, images, tgMsgId: null };
  pendingApprovals.set(id, p);
  deps.saveApproval({ approvalId: id, userId, generatedReply: reply, status: 'pending' });
  await sendApproval(id, p, false);
}
async function sendApproval(id, p, isRevision) {
  const bot = getBot();
  if (!bot || !config.telegram.approvalChatId) return;
  const trunc = p.messageText.length > 500 ? p.messageText.substring(0, 500) + '...' : p.messageText;
  const head = (isRevision ? `🔄 修正版 承認依頼 #${id}` : `🤖 承認依頼 #${id}`) + (p.stage ? `  [${p.stage}]` : '');
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
  let newReply, newStage = null;
  try {
    ({ reply: newReply, stage: newStage } = await generateReply({ userName: p.userName, messageText: p.messageText, conversationHistory: p.history, customerData: p.customerData, winnerInfo: p.winnerInfo, images: p.images, previousReply: p.reply, feedback }));
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
  if (newStage) { try { deps.upsertCustomer({ userId: p.userId, stage: newStage }); } catch (e) {} }
  const np = { userId: p.userId, userName: p.userName, reply: newReply, stage: newStage, messageText: p.messageText, customerData: p.customerData, history: p.history, winnerInfo: p.winnerInfo, images: p.images, tgMsgId: null };
  pendingApprovals.set(newId, np);
  deps.saveApproval({ approvalId: newId, userId: p.userId, generatedReply: newReply, status: 'pending' });
  await sendApproval(newId, np, true);
}
// フォローアップ提案(followup_check.js等の外部トリガーから): 承認ボタン付きでTelegramに提示し、承認でLINE送信
let fuCounter = 0;
async function proposeFollowup({ userId, userName, text, label }) {
  const id = `fu${Date.now()}${fuCounter++}`;
  const p = { userId, userName: userName || '(不明)', reply: text, messageText: `(フォローアップ提案: ${label})`, customerData: null, history: [], winnerInfo: null, tgMsgId: null };
  pendingApprovals.set(id, p);
  deps.saveApproval({ approvalId: id, userId, generatedReply: text, status: 'pending' });
  const bot = getBot();
  if (!bot || !config.telegram.approvalChatId) return false;
  const msg = `📋 フォローアップ提案 #${id}\n\n👤 ${p.userName} — ${label}\n\n📝 送信文面:\n${text}\n\n━━━━━━━━━━\n✅で送信 / ✏️修正はこのメッセージに返信で指示`;
  const opts = { reply_markup: { inline_keyboard: [[{ text: '✅ 承認して送信', callback_data: `a:${id}` }, { text: '❌ 見送り', callback_data: `r:${id}` }]] } };
  try {
    const sent = await bot.sendMessage(config.telegram.approvalChatId, msg, opts);
    if (sent && sent.message_id) { p.tgMsgId = sent.message_id; tgMsgToApproval.set(sent.message_id, id); }
    return true;
  } catch (e) { logger.error('Followup propose failed:', e.message); return false; }
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
module.exports = { setup, handleMessage, proposeFollowup };
