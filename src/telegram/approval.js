const fs = require('fs');
const path = require('path');
const { getBot } = require('./bot');
const { generateReply, parseWinners, parseEvaluationNote } = require('../claude/client');
const { buildWinnerContext } = require('../utils/winner_match');
const config = require('../config');
const logger = require('../utils/logger');
const pendingApprovals = new Map();
const tgMsgToApproval = new Map();
const lastFeedback = new Map();       // 承認ID -> 直近の修正指示(承認後に知識化を提案するため)
const rejectFeedbackWait = new Map(); // 却下理由を尋ねたメッセージID -> 対象
const evalNoteWait = new Map();       // 評価の補足を尋ねたメッセージID -> winnerId
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

  let reply, stage = null, events = {};
  try { ({ reply, stage, events } = await generateReply({ userName, messageText, conversationHistory: history, customerData: customer, winnerInfo, images })); }
  catch (err) {
    logger.error('Reply generation failed:', err.message);
    const bot = getBot();
    if (bot && config.telegram.approvalChatId) {
      const trunc = messageText.length > 200 ? messageText.substring(0, 200) + '...' : messageText;
      // クレジット切れは全生成が止まる重大事象なので、通常の失敗と区別して知らせる
      const isCredit = /credit balance/i.test(err.message);
      const body = isCredit
        ? `🚨 Anthropic APIのクレジット残高が切れています\n\nチャージされるまでBotの返信生成はすべて停止します。\nconsole.anthropic.com → Plans & Billing でチャージしてください(Auto-reloadの有効化を推奨)。\n\nお客様からのメッセージは記録されており、chat.line.bizから手動対応できます。\n\n👤 ${userName}様:\n${trunc}`
        : `⚠️ 返信生成に失敗しました。chat.line.bizで手動対応してください。\n\n👤 ${userName}様:\n${trunc}\n\nエラー: ${err.message}`;
      try { await bot.sendMessage(config.telegram.approvalChatId, body); } catch (e2) {}
    }
    return;
  }
  if (stage) {
    try {
      deps.upsertCustomer({ userId, stage });
      logger.info(`Stage -> ${stage}`);
      // 完了ステージに達したら当選者を自動でdoneにし、対応中リストから外す
      if (/^(完了|S9_キャッシュバック済|S9_連鎖案内済)$/.test(stage) && deps.autoCompleteWinners) {
        const n = deps.autoCompleteWinners();
        if (n) logger.info(`Auto-completed ${n} winners`);
      }
    } catch (err) { logger.error('Stage save failed:', err.message); }
  }
  // 会話から確定した進捗(発送・到着・レビュー完了・予定日・商品選択)を当選者レコードに記録する
  let eventNote = '';
  try {
    const r = deps.applyWinnerEvents && deps.applyWinnerEvents({ lineUserId: userId, events });
    if (r) { eventNote = `\n📌 進捗を記録: ${r.applied.join(' / ')} (@${r.xId})`; logger.info(`Winner events: ${r.applied.join(',')}`); }
    // レビュー完了を記録したら、投稿の評価をこの場で聞く(スプレッドシートに手入力していた分析項目の代替)
    if (r && r.applied.includes('レビュー完了')) askEvaluation(userId, r.xId).catch((e) => logger.error('Ask eval failed:', e.message));
  } catch (err) { logger.error('Event apply failed:', err.message); }
  const id = Date.now().toString();
  const p = { userId, userName, reply, stage, eventNote, messageText, customerData: customer, history, winnerInfo, images, tgMsgId: null };
  pendingApprovals.set(id, p);
  deps.saveApproval({ approvalId: id, userId, generatedReply: reply, status: 'pending' });
  recordGaps({ userId, reply, approvalId: id });
  await sendApproval(id, p, false);
}

// 「覚えて」「覚えて:」「/覚えて」+ 改行やスペース区切りのいずれでも知識追加として受け付ける
const LEARN_RE = /^\s*(?:覚えて|おぼえて|学習|記憶|remember)\s*[:：]?\s*([\s\S]+)$/;

// 運営がTelegramで教えた知識を learned.md に追記する(生成のたびに読み直されて反映される)
const LEARNED_PATH = path.join(__dirname, '../knowledge/learned.md');
function saveLearned(text, who) {
  try {
    const body = String(text).replace(/\n+/g, ' ').trim() + (who ? ` (登録: ${who})` : '');
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

// レビュー完了時に投稿の評価を尋ねる。スプレッドシートに手入力していた分析項目を
// 判断した瞬間に受け取り、実績マスターへ引き継ぐための入口。
const EVAL_CHOICES = [['非常に良い', 'vg'], ['良い', 'g'], ['ポジより', 'p'], ['良くない', 'n']];
const EVAL_BY_CODE = Object.fromEntries(EVAL_CHOICES.map(([label, code]) => [code, label]));
async function askEvaluation(lineUserId, xId) {
  const bot = getBot();
  if (!bot || !config.telegram.approvalChatId) return;
  const w = deps.getWinnerByLineUser && deps.getWinnerByLineUser(lineUserId);
  if (!w) return;
  // 発送からレビューまでの日数は自動で出せるので聞かない
  let speed = '';
  if (w.shipped_at && w.reviewed_at) {
    const d = Math.round((new Date(w.reviewed_at + 'Z') - new Date(w.shipped_at + 'Z')) / 86400000);
    if (Number.isFinite(d) && d >= 0) speed = `\n(発送からレビューまで ${d}日)`;
  }
  await bot.sendMessage(config.telegram.approvalChatId,
    `📝 @${xId} のレビュー投稿を確認しました${speed}\n\n投稿の評価を選んでください(実績マスターに蓄積されます)`,
    { reply_markup: { inline_keyboard: [EVAL_CHOICES.map(([label, code]) => ({ text: label, callback_data: `ev:${w.id}:${code}` }))] } });
}

// 社内向けの目印。顧客に送る文面には絶対に含めてはならない。
const MARKER_RE = /[[［]\s*(要人間判断|知識不足|要確認)\s*[:：]?[^\]］]*[\]］]\s*/g;
function extractMarkers(text) {
  return [...String(text).matchAll(MARKER_RE)].map((m) => m[0].replace(/^\s*[[［]|[\]］]\s*$/g, '').trim());
}
// 送信直前に必ず通す。マーカーを取り除き、先頭に残った空行も整える。
function sanitizeForCustomer(text) {
  return String(text).replace(MARKER_RE, '').replace(/^\s+/, '').replace(/\n{3,}/g, '\n\n').trim();
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
  const markers = extractMarkers(p.reply);
  const alert = markers.length
    ? `\n\n🚨 Botが判断できていません — 内容を確認してください:\n${markers.map((g) => `・${g}`).join('\n')}\n(✏️返信で情報を伝えると作り直します。この目印は送信時に自動で取り除かれます)`
    : '';
  // 修正で作り直した場合は、その指示を今後も反映するか(=永続知識にするか)をこの場で選べるようにする
  const fb = lastFeedback.get(id);
  const learnNote = isRevision && fb
    ? `\n\n💡 この修正「${fb}」を今後も反映しますか?\n　→ 下の🧠を押すとBotが覚えます(押さなければ今回だけ)`
    : '';
  const text = `${head}${alert}${p.eventNote || ''}\n\n👤 ${p.userName}様：\n${trunc}\n\n━━━━━━━━━━\n\n📝 AI返答：\n${p.reply}${learnNote}\n\n━━━━━━━━━━\n✏️ さらに修正：このメッセージに「返信」で指示を送ると再生成します`;
  const rows = [[{ text: '✅ 承認', callback_data: `a:${id}` }, { text: '❌ 却下', callback_data: `r:${id}` }]];
  if (isRevision && fb) rows.push([{ text: '🧠 この修正を今後も反映する', callback_data: `k:${id}` }]);
  const opts = { reply_markup: { inline_keyboard: rows } };
  try {
    const sent = await bot.sendMessage(config.telegram.approvalChatId, text, opts);
    if (sent && sent.message_id) { p.tgMsgId = sent.message_id; tgMsgToApproval.set(sent.message_id, id); try { deps.linkTelegramMessage && deps.linkTelegramMessage({ approvalId: id, tgMsgId: sent.message_id }); } catch (e) {} }
  } catch (err) { logger.error('Telegram send failed:', err.message); }
}
// 承認依頼メッセージへのTelegram返信 = 修正指示 → Claude再生成 → 修正版の承認依頼を発行
async function handleRevisionRequest(msg) {
  const bot = getBot();
  const replyToId = msg.reply_to_message.message_id;
  let approvalId = tgMsgToApproval.get(replyToId);
  let p = approvalId ? pendingApprovals.get(approvalId) : null;

  // Bot再起動でメモリ上の対応表が消えている場合はDBから復元する
  if (!p) {
    const rec = deps.findApprovalByTgMsg && deps.findApprovalByTgMsg(replyToId);
    if (!rec) {
      try { await bot.sendMessage(msg.chat.id, '⚠️ この承認依頼は既に処理済み、または対象が見つかりませんでした。\n(お客様が新しくメッセージを送ると、新しい承認依頼が作成されます)'); } catch (e) {}
      return;
    }
    approvalId = rec.approval_id;
    const customer = deps.getCustomer(rec.user_id);
    const lastIn = deps.getLastIncoming ? deps.getLastIncoming(rec.user_id) : null;
    const history = deps.getRecentConversations(rec.user_id, 30).reverse()
      .map((c) => ({ role: c.direction === 'incoming' ? 'user' : 'assistant', content: c.content }));
    p = {
      userId: rec.user_id,
      userName: (customer && customer.display_name) || 'お客様',
      reply: rec.generated_reply,
      stage: customer && customer.stage,
      messageText: (lastIn && lastIn.content) || '(直近のメッセージ)',
      customerData: customer,
      history,
      winnerInfo: null,
      images: [],   // 画像は保存していないため復元できない
      tgMsgId: replyToId,
    };
    pendingApprovals.set(approvalId, p);
    tgMsgToApproval.set(replyToId, approvalId);
    logger.info(`Restored approval #${approvalId} from DB`);
  }
  let feedback = msg.text;

  // 「覚えて」で始まる返信は永続知識として保存し、以後すべての生成に反映する
  const learnMatch = feedback.match(LEARN_RE);
  if (learnMatch) {
    const knowledge = learnMatch[1].trim();
    const who = msg.from ? (msg.from.first_name || msg.from.username || '担当者') : '担当者';
    const saved = saveLearned(knowledge, who);
    if (saved) {
      try { await bot.sendMessage(msg.chat.id, `🧠 覚えました:\n${knowledge}\n\n(以後すべての返信に反映されます。この内容を踏まえて返信案を作り直します)`); } catch (e) {}
      try { deps.resolveKnowledgeGaps && deps.resolveKnowledgeGaps(p.userId); } catch (e) {}
    } else {
      try { await bot.sendMessage(msg.chat.id, '⚠️ 知識の保存に失敗しました'); } catch (e) {}
    }
    feedback = `運営から次の知識が追加されました。これを踏まえて返信案を作り直してください:\n${knowledge}`;
  }

  logger.info(`Revision requested for #${approvalId}: ${feedback.substring(0, 80)}`);
  let newReply, newStage = null, newEvents = {};
  try {
    ({ reply: newReply, stage: newStage, events: newEvents } = await generateReply({ userName: p.userName, messageText: p.messageText, conversationHistory: p.history, customerData: p.customerData, winnerInfo: p.winnerInfo, images: p.images, previousReply: p.reply, feedback }));
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
  try { deps.applyWinnerEvents && deps.applyWinnerEvents({ lineUserId: p.userId, events: newEvents }); } catch (e) {}
  // 「今後もこうする」の提案に使うため、修正指示を新しい承認IDに引き継ぐ
  if (!learnMatch) lastFeedback.set(newId, feedback.replace(/\n+/g, ' ').trim().slice(0, 200));
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
    if (sent && sent.message_id) { p.tgMsgId = sent.message_id; tgMsgToApproval.set(sent.message_id, id); try { deps.linkTelegramMessage && deps.linkTelegramMessage({ approvalId: id, tgMsgId: sent.message_id }); } catch (e) {} }
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

      // 投稿評価の補足(インプ数・ジャンル等)の受け取り
      if (msg.reply_to_message && evalNoteWait.has(msg.reply_to_message.message_id)) {
        const winnerId = evalNoteWait.get(msg.reply_to_message.message_id);
        evalNoteWait.delete(msg.reply_to_message.message_id);
        let fields = {};
        try { fields = await parseEvaluationNote(msg.text); }
        catch (e) { logger.error('Parse eval note failed:', e.message); fields = { eval_note: msg.text }; }
        try {
          const w = deps.saveWinnerEvaluation({ winnerId, fields });
          const shown = Object.entries(fields).map(([k, v]) => `${{ impressions: 'インプ', genre: 'ジャンル', face: '顔出し', shadowban: 'シャドバン', followers: 'フォロワー', eval_note: '備考' }[k] || k}: ${v}`).join(' / ');
          await bot.sendMessage(msg.chat.id, shown ? `📊 記録しました — ${shown}${w ? `\n(@${w.x_id})` : ''}` : '⚠️ 項目を読み取れませんでした');
        } catch (e) { logger.error('Save eval note failed:', e.message); }
        return;
      }

      // 却下理由の受け取り(Botが尋ねたメッセージへの返信)
      if (msg.reply_to_message && rejectFeedbackWait.has(msg.reply_to_message.message_id)) {
        const ctx = rejectFeedbackWait.get(msg.reply_to_message.message_id);
        rejectFeedbackWait.delete(msg.reply_to_message.message_id);
        const who = msg.from ? (msg.from.first_name || msg.from.username || '担当者') : '担当者';
        try { deps.saveKnowledgeGap({ userId: ctx.userId, gap: `却下理由(${who}): ${msg.text}`, approvalId: ctx.approvalId }); } catch (e) {}
        logger.warn(`Reject reason: ${msg.text.substring(0, 100)}`);
        await bot.sendMessage(msg.chat.id,
          `📝 記録しました。ありがとうございます。\n\nこの内容を今後の返信に反映させますか?`,
          { reply_markup: { inline_keyboard: [[{ text: '🧠 今後もこうする(覚えさせる)', callback_data: `k:${ctx.approvalId}` }, { text: '記録だけでOK', callback_data: `x:${ctx.approvalId}` }]] } });
        lastFeedback.set(ctx.approvalId, msg.text.replace(/\n+/g, ' ').trim().slice(0, 200));
        return;
      }

      // 承認依頼への返信でなくても、「覚えて」単独で知識を追加できる(コロン・改行どちらでも可)
      // ※グループではTelegramのプライバシーモードにより届かない場合があるため /覚えて も用意している
      if (!msg.reply_to_message) {
        const m = msg.text.match(LEARN_RE);
        if (m) {
          const who = msg.from ? (msg.from.first_name || msg.from.username || '担当者') : '担当者';
          const ok = saveLearned(m[1].trim(), who);
          await bot.sendMessage(msg.chat.id, ok ? `🧠 覚えました:\n${m[1].trim()}\n\n(以後すべての返信に反映されます)` : '⚠️ 保存に失敗しました');
        }
        return;
      }
      if (msg.text.startsWith('/')) return;
      await handleRevisionRequest(msg);
    } catch (err) { logger.error('Revision handler error:', err.message); }
  });

  // スタッフ向けの使い方ガイド(グループにピン留めしておく想定)
  // 当選者リストの登録: スタッフが自由な書き方で貼ったものをClaudeが解釈して登録する
  const OFFER_LABEL = { original_2粒: 'グミ(ORIGINAL)', cream: 'クリーム(CREAM)', drop: 'DROP', choice: 'グミorクリーム選択', free: '完全無料', unknown: '要確認' };
  bot.onText(/^\/(当選者?|winners?)(?:@\S+)?(?:\s|\n)([\s\S]+)$/, async (msg, match) => {
    if (String(msg.chat.id) !== String(config.telegram.approvalChatId)) return;
    const who = msg.from ? (msg.from.first_name || msg.from.username || '担当者') : '担当者';
    let parsed;
    try {
      await bot.sendMessage(msg.chat.id, '📋 当選者リストを読み取っています…');
      parsed = await parseWinners(match[2]);
    } catch (e) {
      logger.error('Winner parse failed:', e.message);
      await bot.sendMessage(msg.chat.id, `⚠️ 読み取りに失敗しました: ${e.message}\n\n書き方の例:\n/当選者 35弾\n@abc123 グミ\n@def456 クリーム\n@ghi789 選択 強アカ`);
      return;
    }
    const list = (parsed && parsed.winners) || [];
    if (!list.length) {
      await bot.sendMessage(msg.chat.id, '⚠️ 当選者を読み取れませんでした。@IDと提供内容が含まれているか確認してください。');
      return;
    }
    const lines = []; const dups = []; let ng = 0;
    for (const w of list) {
      if (!w.x_id || !/^[A-Za-z0-9_]{1,15}$/.test(w.x_id)) { ng++; continue; }
      try {
        const r = deps.addWinner({ xId: w.x_id, campaign: w.campaign || '(企画名なし)', offer: w.offer || 'unknown', tier: w.tier === 'strong' ? 'strong' : 'normal', notes: w.notes || null });
        lines.push(`・@${w.x_id} — ${OFFER_LABEL[w.offer] || w.offer}${w.tier === 'strong' ? ' 🔶強' : ''}`);
        if (r.duplicate) dups.push(`@${w.x_id}(既存:「${r.duplicate.campaign}」が未完了)`);
      } catch (e) { logger.error('addWinner failed:', e.message); ng++; }
    }
    const parts = [`✅ ${lines.length}名を当選者リストに登録しました (登録: ${who})`, '', `企画: ${list[0].campaign || '(企画名なし)'}`, ...lines];
    if (dups.length) parts.push('', '⚠️ 同じIDで未完了の案件があります(重ねて登録しました):', ...dups.map((d) => `・${d}`));
    if (parsed.warnings && parsed.warnings.length) parts.push('', '📌 確認してください:', ...parsed.warnings.map((w) => `・${w}`));
    if (ng) parts.push('', `⚠️ ${ng}件は読み取れず登録できませんでした`);
    parts.push('', 'この方たちがLINEでXのIDを名乗ると、自動で照合されて企画に沿った案内が始まります。');
    await bot.sendMessage(msg.chat.id, parts.join('\n'));
  });

  // 当選者の進捗確認。人数が増えても読めるよう、生の一覧ではなく状況別サマリを出す。
  // 企画名を付ければその企画だけを詳細表示できる。例: /当選者一覧 35弾
  bot.onText(/^\/(当選者一覧|winnerlist)(?:@\S+)?(?:\s+([\s\S]+))?$/, async (msg, match) => {
    if (String(msg.chat.id) !== String(config.telegram.approvalChatId)) return;
    const filter = (match[2] || '').trim() || null;
    try { const n = deps.autoCompleteWinners ? deps.autoCompleteWinners() : 0; if (n) logger.info(`Auto-completed ${n} winners`); } catch (e) {}
    const d = deps.winnerDashboard({ campaign: filter });
    if (!d.total) {
      await bot.sendMessage(msg.chat.id, filter ? `「${filter}」に該当する対応中の当選者はいません。` : '対応中の当選者はいません。\n/当選者 で登録できます。');
      return;
    }
    const parts = [`📋 対応中の当選者: ${d.total}名${filter ? ` (${filter})` : ''}`, ''];

    // 企画が複数ある場合はまず企画別の内訳を見せる
    const camps = Object.entries(d.campaigns).sort((a, b) => b[1] - a[1]);
    if (!filter && camps.length > 1) {
      parts.push('【企画別】', ...camps.map(([c, n]) => `・${c}: ${n}名`), '');
    }
    parts.push('【状況別】');
    for (const [stage, arr] of Object.entries(d.groups).sort((a, b) => b[1].length - a[1].length)) {
      parts.push(`・${stage}: ${arr.length}名`);
    }
    if (d.stalled.length) {
      parts.push('', `⚠️ 7日以上動きがない方: ${d.stalled.length}名`);
      for (const r of d.stalled.slice(0, 10)) {
        parts.push(`・@${r.x_id} — ${r.campaign} / ${r.line_user_id ? (r.stage || 'ステージ未判定') : 'LINE未接続'} / ${r.idle_days}日`);
      }
      if (d.stalled.length > 10) parts.push(`　…他${d.stalled.length - 10}名`);
    }
    // 特定の企画に絞った場合のみ全員を列挙する
    if (filter) {
      parts.push('', '【全員】');
      for (const r of d.rows.slice(0, 40)) {
        parts.push(`・@${r.x_id} — ${OFFER_LABEL[r.offer] || r.offer}${r.tier === 'strong' ? ' 🔶' : ''} / ${r.line_user_id ? (r.stage || '接続済') : 'LINE未接続'}`);
      }
      if (d.rows.length > 40) parts.push(`　…他${d.rows.length - 40}名`);
    } else if (camps.length) {
      parts.push('', `企画ごとの詳細: /当選者一覧 ${camps[0][0]}`);
    }
    parts.push('', '完了した方は自動で一覧から外れます。手動なら /完了 @ID');
    await bot.sendMessage(msg.chat.id, parts.join('\n'));
  });

  // 手動で完了にする(レビューまで終わった方を一覧から外す)
  bot.onText(/^\/(完了|done)(?:@\S+)?\s+@?(\S+)$/, async (msg, match) => {
    if (String(msg.chat.id) !== String(config.telegram.approvalChatId)) return;
    const n = deps.completeWinnerByXid ? deps.completeWinnerByXid(match[2]) : 0;
    await bot.sendMessage(msg.chat.id, n ? `✅ @${match[2].replace(/^@/, '')} を完了にしました(一覧から外れます)` : `⚠️ @${match[2].replace(/^@/, '')} は対応中の当選者に見つかりませんでした`);
  });

  bot.onText(/^\/(ヘルプ|help|使い方)(?:@\S+)?$/, async (msg) => {
    if (String(msg.chat.id) !== String(config.telegram.approvalChatId)) return;
    await bot.sendMessage(msg.chat.id, [
      '📖 LINE Bot 承認チーム 使い方',
      '',
      '【返信案が届いたら】',
      '✅ 承認 … そのままLINEに送信されます',
      '✏️ 修正 … このメッセージに「返信」で指示を書くと作り直します',
      '　　例:「もっと短く」「リンクはこれ https://…」「結びは1つに」',
      '❌ 却下 … 送りません。理由を聞かれるので答えてもらえると改善に繋がります',
      '',
      '【修正がそのままBotの学習になります】',
      '修正を出すと作り直した案が届き、そこに',
      '　🧠 この修正を今後も反映する',
      'というボタンが付きます。',
      '押せばBotが覚えて以後ずっと反映されます。押さなければ今回だけ。',
      '',
      '【当選者を登録する】',
      '当選者が決まったら、そのまま貼り付けてください。',
      '/当選者 35弾',
      '@abc123 グミ',
      '@def456 クリーム',
      '@ghi789 選択 強アカ',
      '',
      '書き方は自由です(AIが読み取ります)。',
      '登録するとLINEでIDを名乗った時に自動照合され、',
      'その方の企画に沿った案内が始まります。',
      '/当選者一覧 … 登録済みの確認',
      '',
      '【先に知識だけ教えたいとき】',
      '/覚えて 内容',
      '　例: /覚えて 8月から送料が1800円に変わりました',
      '　→ 以後すべての返信に反映されます(再起動不要)',
      '',
      '【知識の管理】',
      '/知識 … 覚えている内容の一覧',
      '/忘れて 番号 … 間違った知識を取り消す',
      '',
      '【困ったとき】',
      '🚨「このまま送らないでください」と出たら、Botがその情報を知りません。',
      '　/覚えて で教えるか、返信で「覚えて ○○」と伝えてください。',
      '',
      '⚠️ Botの案が不安なときは、遠慮なく❌却下して手動で対応してください。',
      '　却下の理由を教えてもらえると、同じ失敗をしなくなります。',
    ].join('\n'));
  });

  // グループではプライバシーモードにより通常メッセージが届かないため、コマンド形式も用意する
  bot.onText(/^\/(覚えて|remember)(?:@\S+)?(?:\s|\n)([\s\S]+)$/, async (msg, match) => {
    if (String(msg.chat.id) !== String(config.telegram.approvalChatId)) return;
    const knowledge = match[2].trim();
    const who = msg.from ? (msg.from.first_name || msg.from.username || '担当者') : '担当者';
    const ok = saveLearned(knowledge, who);
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
    const who = q.from ? (q.from.first_name || q.from.username || '担当者') : '担当者';

    // 「今後もこうする」= 直前の修正指示を永続知識にする(ワンタップ学習)
    // 投稿評価のボタン(ev:winnerId:code)
    if (action === 'ev') {
      const [, winnerId, code] = q.data.split(':');
      const label = EVAL_BY_CODE[code];
      if (!label) { await bot.answerCallbackQuery(q.id, { text: '不明な評価' }); return; }
      try { deps.saveWinnerEvaluation({ winnerId: Number(winnerId), fields: { eval: label } }); }
      catch (e) { logger.error('Save eval failed:', e.message); }
      await bot.answerCallbackQuery(q.id, { text: `評価「${label}」を記録しました` });
      try { await bot.editMessageText(`${q.message.text}\n\n✅ 評価: ${label} (${who})`, { chat_id: q.message.chat.id, message_id: q.message.message_id }); } catch (e) {}
      try {
        const sent = await bot.sendMessage(q.message.chat.id,
          `インプ数や補足があれば、このメッセージに返信で教えてください\n(例: 4200 エロ強 顔出しあり シャドバンなし)\n\n不要ならスルーでOKです`);
        if (sent && sent.message_id) evalNoteWait.set(sent.message_id, Number(winnerId));
      } catch (e) {}
      return;
    }
    if (action === 'k') {
      const fb = lastFeedback.get(id);
      if (!fb) { await bot.answerCallbackQuery(q.id, { text: '対象が見つかりません' }); return; }
      const ok = saveLearned(fb, who);
      await bot.answerCallbackQuery(q.id, { text: ok ? '🧠 覚えました。以後の返信に反映されます' : '保存に失敗' });
      if (!ok) return;
      lastFeedback.delete(id);
      // 承認ボタンは残したまま、学習済みであることだけを本文に追記する
      const stillPending = pendingApprovals.has(id);
      try {
        await bot.editMessageText(
          `${q.message.text}\n\n🧠 覚えました(${who}さん登録): 「${fb}」`,
          {
            chat_id: q.message.chat.id,
            message_id: q.message.message_id,
            reply_markup: stillPending
              ? { inline_keyboard: [[{ text: '✅ 承認', callback_data: `a:${id}` }, { text: '❌ 却下', callback_data: `r:${id}` }]] }
              : undefined,
          });
      } catch (e) {}
      return;
    }

    const p = pendingApprovals.get(id);
    if (!p) { await bot.answerCallbackQuery(q.id, { text: '期限切れ' }); return; }
    if (action === 'a') {
      // 社内向けマーカーを取り除いてから送信する(顧客に内部メモが届く事故の防止)
      const outgoing = sanitizeForCustomer(p.reply);
      if (!outgoing) {
        await bot.answerCallbackQuery(q.id, { text: '⚠️ 送信できる本文がありません' });
        return;
      }
      const ok = await deps.sendLineReply(p.userId, outgoing);
      if (ok) { deps.saveConversation({ userId: p.userId, direction: 'outgoing', content: outgoing }); deps.updateApproval({ approvalId: id, status: 'approved', finalReply: outgoing }); }
      await bot.answerCallbackQuery(q.id, { text: ok ? '✅ 送信完了' : '❌ 失敗' });
      try { await bot.editMessageText(`✅ 承認・送信済 (${who})\n\n${q.message.text}`, { chat_id: q.message.chat.id, message_id: q.message.message_id }); } catch (e) {}

      pendingApprovals.delete(id);
      if (p.tgMsgId) tgMsgToApproval.delete(p.tgMsgId);
    } else if (action === 'r') {
      deps.updateApproval({ approvalId: id, status: 'rejected', finalReply: null });
      await bot.answerCallbackQuery(q.id, { text: '❌ 却下' });
      try { await bot.editMessageText(`❌ 却下 (${who})\n\n${q.message.text}`, { chat_id: q.message.chat.id, message_id: q.message.message_id }); } catch (e) {}
      // 却下は「Botの案が使えなかった」という最も重要な学習信号。理由を拾う
      try {
        const sent = await bot.sendMessage(q.message.chat.id,
          `❓ 却下の理由を教えてください(このメッセージに返信)\n\n・何がダメだったか\n・実際にLINEで何と返信したか\n\nどちらでも構いません。今後の改善に使います。\n(不要ならスルーでOK)`);
        if (sent && sent.message_id) rejectFeedbackWait.set(sent.message_id, { approvalId: id, userId: p.userId });
      } catch (e) {}
      pendingApprovals.delete(id);
      if (p.tgMsgId) tgMsgToApproval.delete(p.tgMsgId);
    } else if (action === 'x') {
      lastFeedback.delete(id);
      await bot.answerCallbackQuery(q.id, { text: '了解しました' });
      try { await bot.editMessageText('✔️ 今回だけの指示として処理しました', { chat_id: q.message.chat.id, message_id: q.message.message_id }); } catch (e) {}
    }
  });
}
module.exports = { setup, handleMessage, proposeFollowup };
