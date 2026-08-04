const fs = require('fs');
const path = require('path');
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
  recordGaps({ userId, reply, approvalId: id });
  await sendApproval(id, p, false);
}

// 「覚えて」「覚えて:」「/覚えて」+ 改行やスペース区切りのいずれでも知識追加として受け付ける
const LEARN_RE = /^\s*(?:覚えて|おぼえて|学習|記憶|remember)\s*[:：]?\s*([\s\S]+)$/;

// 運営がTelegramで教えた知識を learned.md に追記する(生成のたびに読み直されて反映される)
const LEARNED_PATH = path.join(__dirname, '../knowledge/learned.md');
function saveLearned(text) {
  try {
    const body = String(text).replace(/\n+/g, ' ').trim();
    if (!body) return false;
    // 同一内容が既にある場合は追記しない(ハンドラの重複発火などによる二重登録を防ぐ)
    if (fs.existsSync(LEARNED_PATH)) {
      const existing = fs.readFileSync(LEARNED_PATH, 'utf-8');
      if (existing.split('\n').some((l) => l.replace(/^-\s*\[[^\]]*\]\s*/, '').trim() === body)) {
        logger.info('Learned (duplicate, skipped)');
        return true;
      }
    }
    const stamp = new Date().toISOString().slice(0, 10);
    fs.appendFileSync(LEARNED_PATH, `- [${stamp}] ${body}\n`, 'utf-8');
    logger.info(`Learned: ${body.substring(0, 80)}`);
    return true;
  } catch (e) { logger.error('Save learned failed:', e.message); return false; }
}
function listLearned() {
  try {
    if (!fs.existsSync(LEARNED_PATH)) return [];
    return fs.readFileSync(LEARNED_PATH, 'utf-8').split('\n').filter((l) => l.trim().startsWith('- ['));
  } catch (e) { return []; }
}
function removeLearned(index) {
  try {
    const lines = fs.readFileSync(LEARNED_PATH, 'utf-8').split('\n');
    const idxs = lines.map((l, i) => (l.trim().startsWith('- [') ? i : -1)).filter((i) => i >= 0);
    if (index < 1 || index > idxs.length) return null;
    const removed = lines[idxs[index - 1]];
    lines.splice(idxs[index - 1], 1);
    fs.writeFileSync(LEARNED_PATH, lines.join('\n'), 'utf-8');
    return removed;
  } catch (e) { logger.error('Remove learned failed:', e.message); return null; }
}

// 返信案に含まれる [知識不足: ...] を拾ってDBに残す。運営が知識を足して再生成するための記録。
function recordGaps({ userId, reply, approvalId }) {
  try {
    const found = [...String(reply).matchAll(/\[知識不足:\s*([^\]]+)\]/g)].map((m) => m[1].trim());
    for (const gap of found) {
      deps.saveKnowledgeGap({ userId, gap, approvalId });
      logger.warn(`Knowledge gap: ${gap}`);
    }
    return found;
  } catch (e) { logger.error('Gap record failed:', e.message); return []; }
}
async function sendApproval(id, p, isRevision) {
  const bot = getBot();
  if (!bot || !config.telegram.approvalChatId) return;
  const trunc = p.messageText.length > 500 ? p.messageText.substring(0, 500) + '...' : p.messageText;
  const head = (isRevision ? `🔄 修正版 承認依頼 #${id}` : `🤖 承認依頼 #${id}`) + (p.stage ? `  [${p.stage}]` : '');
  const gaps = [...String(p.reply).matchAll(/\[知識不足:\s*([^\]]+)\]/g)].map((m) => m[1].trim());
  const alert = gaps.length
    ? `\n\n🚨 このまま送らないでください — Botに以下の知識がありません:\n${gaps.map((g) => `・${g}`).join('\n')}\n(Claudeに教えて知識を追加してから、✏️返信で再生成してください)`
    : '';
  const text = `${head}${alert}\n\n👤 ${p.userName}様：\n${trunc}\n\n━━━━━━━━━━\n\n📝 AI返答：\n${p.reply}\n\n━━━━━━━━━━\n✏️ 修正したい場合：このメッセージに「返信」で指示を送ると再生成します`;
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
  let feedback = msg.text;

  // 「覚えて」で始まる返信は永続知識として保存し、以後すべての生成に反映する
  const learnMatch = feedback.match(LEARN_RE);
  if (learnMatch) {
    const knowledge = learnMatch[1].trim();
    const saved = saveLearned(knowledge);
    if (saved) {
      try { await bot.sendMessage(msg.chat.id, `🧠 覚えました:\n${knowledge}\n\n(以後すべての返信に反映されます。この内容を踏まえて返信案を作り直します)`); } catch (e) {}
      try { deps.resolveKnowledgeGaps && deps.resolveKnowledgeGaps(p.userId); } catch (e) {}
    } else {
      try { await bot.sendMessage(msg.chat.id, '⚠️ 知識の保存に失敗しました'); } catch (e) {}
    }
    feedback = `運営から次の知識が追加されました。これを踏まえて返信案を作り直してください:\n${knowledge}`;
  }

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
      if (!msg.text) return;
      if (!config.telegram.approvalChatId || String(msg.chat.id) !== String(config.telegram.approvalChatId)) return;
      // /で始まるものは専用のコマンドハンドラが処理するため、ここでは扱わない(二重処理の防止)
      if (/^\s*\//.test(msg.text)) return;

      // 承認依頼への返信でなくても、「覚えて」単独で知識を追加できる(コロン・改行どちらでも可)
      // ※グループではTelegramのプライバシーモードにより届かない場合があるため /覚えて も用意している
      if (!msg.reply_to_message) {
        const m = msg.text.match(LEARN_RE);
        if (m) {
          const ok = saveLearned(m[1].trim());
          await bot.sendMessage(msg.chat.id, ok ? `🧠 覚えました:\n${m[1].trim()}\n\n(以後すべての返信に反映されます)` : '⚠️ 保存に失敗しました');
        }
        return;
      }
      if (msg.text.startsWith('/')) return;
      await handleRevisionRequest(msg);
    } catch (err) { logger.error('Revision handler error:', err.message); }
  });

  // グループではプライバシーモードにより通常メッセージが届かないため、コマンド形式も用意する
  bot.onText(/^\/(覚えて|remember)(?:@\S+)?(?:\s|\n)([\s\S]+)$/, async (msg, match) => {
    if (String(msg.chat.id) !== String(config.telegram.approvalChatId)) return;
    const knowledge = match[2].trim();
    const ok = saveLearned(knowledge);
    await bot.sendMessage(msg.chat.id, ok ? `🧠 覚えました:\n${knowledge}\n\n(以後すべての返信に反映されます)` : '⚠️ 保存に失敗しました');
  });

  // 覚えた知識の一覧と取り消し
  bot.onText(/^\/(知識|learned)(?:@\S+)?$/, async (msg) => {
    if (String(msg.chat.id) !== String(config.telegram.approvalChatId)) return;
    const items = listLearned();
    const body = items.length
      ? items.map((l, i) => `${i + 1}. ${l.replace(/^-\s*/, '')}`).join('\n')
      : '(まだ何も覚えていません)';
    await bot.sendMessage(msg.chat.id, `🧠 覚えている知識 (${items.length}件)\n\n${body}\n\n取り消す場合: /忘れて 番号`);
  });
  bot.onText(/^\/(忘れて|forget)(?:@\S+)?\s+(\d+)$/, async (msg, match) => {
    if (String(msg.chat.id) !== String(config.telegram.approvalChatId)) return;
    const removed = removeLearned(parseInt(match[2], 10));
    await bot.sendMessage(msg.chat.id, removed ? `🗑 忘れました:\n${removed}` : '⚠️ その番号の知識は見つかりませんでした');
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
