const fs = require('fs');
const path = require('path');
const { getBot } = require('./bot');
const { generateReply, parseWinners, parseEvaluationNote, runRaw } = require('../claude/client');
const { buildWinnerContext, offerStatusLine } = require('../utils/winner_match');
const { negativeInfo } = require('../utils/negative_list');
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

  const e = inbox.get(userId) || { userName, texts: [], times: [], images: [], firstAt: Date.now(), timer: null };
  e.userName = userName;
  if (image) { if (e.images.length < MAX_IMAGES) e.images.push(image); }
  else if (messageText) { e.texts.push(messageText); (e.times = e.times || []).push(Date.now()); }

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

  const { userName, texts } = e;
  let images = e.images;
  const imgNote = images.length ? `[画像${images.length}枚を受信]` : '';
  // 各メッセージに受信時刻を付ける(承認カードで「いつ届いたか」が分かるように。
  // 追い越し統合で古い未返信分と新着が混ざるときに特に重要)
  const fmtTime = (ms) => { const d = new Date(ms); return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; };
  const stamped = texts.map((t, i) => `[${fmtTime((e.times || [])[i] || Date.now())}] ${t}`);
  let messageText = [stamped.join('\n'), imgNote ? `[${fmtTime(Date.now())}] ${imgNote}` : ''].filter(Boolean).join('\n') || '[メッセージを受信]';
  logger.info(`Processing from ${userName}: text${texts.length}件 / image${images.length}枚`);

  // 同じ相手の未処理カードが残っていたら無効化し、未返信分を全部まとめて1つの返信案に作り直す
  // (時差で追加メッセージが届くと、旧カードと新カードから別々の返信が送られてしまう事故の防止)
  try {
    let old = null;
    for (const [pid, pp] of pendingApprovals) {
      if (pp.userId === userId) { old = { id: pid, p: pp }; break; }
    }
    if (old) {
      pendingApprovals.delete(old.id);
      if (old.p.tgMsgId) tgMsgToApproval.delete(old.p.tgMsgId);
      try { deps.updateApproval({ approvalId: old.id, status: 'superseded', finalReply: null }); } catch (e2) {}
      const bot = getBot();
      if (bot && old.p.tgMsgId && config.telegram.approvalChatId) {
        try {
          await bot.editMessageText(
            `⏩ ${cardName(userId, userName)}様から追加のメッセージが届いたため、このカードは無効になりました。\n直後に届く新しいカード1枚で、全メッセージ分をまとめて対応してください。`,
            { chat_id: config.telegram.approvalChatId, message_id: old.p.tgMsgId });
        } catch (e2) {}
      }
      // 旧カードが対象にしていた受信内容を引き継ぐ(フォローアップ提案カードは提案文のため引き継がない)
      if (!String(old.id).startsWith('fu')) {
        if (old.p.messageText && !messageText.includes(old.p.messageText)) {
          messageText = `${old.p.messageText}\n${messageText}`;
        }
        if (old.p.images && old.p.images.length) {
          images = [...old.p.images, ...images].slice(0, 5);
        }
      }
      logger.info(`Superseded pending approval #${old.id} for ${userName}`);
    }
  } catch (err) { logger.error('Supersede failed:', err.message); }

  const customer = deps.getCustomer(userId);
  let winnerInfo = null;
  try { winnerInfo = buildWinnerContext({ deps, messageText, customer, userId }); if (winnerInfo) logger.info(`Winner match: ${winnerInfo.substring(0, 60)}`); }
  catch (err) { logger.error('Winner match error:', err.message); }
  const history = deps.getRecentConversations(userId, 30).reverse().map(c => ({ role: c.direction === 'incoming' ? 'user' : 'assistant', content: c.content }));

  let reply, stage = null, events = {}, internalNote = null;
  // 照合材料が無い場合もその事実を明示し、S3以降へ進ませない(スクショだけでID申告された事故の再発防止)
  if (!winnerInfo) winnerInfo = '照合未完了: この方はまだ当選者リスト・再提供リストと照合できていません。SNS IDのテキスト申告を受けて照合が取れるまで、S3以降(事前確認・提供プラン提示・商品選択・LP案内)には進まないでください。必要ならIDのテキスト申告を丁寧に依頼してください。';
  try { ({ reply, stage, events, internalNote } = await generateReply({ userName, messageText, conversationHistory: history, customerData: customer, winnerInfo, images })); }
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
  const p = { userId, userName, reply, stage, eventNote, messageText, customerData: customer, history, winnerInfo, images, tgMsgId: null, lastMsgAt: (e.times && e.times.length ? Math.max(...e.times) : e.firstAt), internalNote };
  pendingApprovals.set(id, p);
  deps.saveApproval({ approvalId: id, userId, generatedReply: reply, status: 'pending' });
  recordGaps({ userId, reply, approvalId: id });
  await sendApproval(id, p, false);
  await supersedeOlderCards(id, p);
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
const MARKER_RE = /[[［]\s*(要人間判断|要判断|知識不足|要確認|リスク該当)\s*[:：]?[^\]］]*[\]］]\s*/g;
// マーカーの重要度レベル定義
const MARKER_LEVELS = {
  '要人間判断': { emoji: '🚨', level: 'critical', label: '要人間判断' },
  '要判断': { emoji: '🚨', level: 'critical', label: '要判断' },
  'リスク該当': { emoji: '⚠️', level: 'warning', label: 'リスク該当' },
  '知識不足': { emoji: '⚠️', level: 'warning', label: '知識不足' },
  '要確認': { emoji: '💡', level: 'info', label: '要確認' },
};
function extractMarkers(text) {
  const matches = [...String(text).matchAll(MARKER_RE)];
  return matches.map((m) => {
    const full = m[0];
    const inner = full.replace(/^\s*[[［]|[\]］]\s*$/g, '').trim();
    // マーカー種別を判定
    let type = '要確認';
    for (const key of Object.keys(MARKER_LEVELS)) {
      if (inner.includes(key)) { type = key; break; }
    }
    return { type, text: inner, full };
  });
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
// 当選者と紐付いている場合はX IDを併記する(スタッフが「Xの名前+ID」で個体識別する運用に合わせ、
// chat.line.bizでの手動リネームなしでも誰か分かるようにする)。Telegram表示専用 — 生成プロンプトには使わない
function cardName(userId, userName) {
  try {
    const w = deps.findWinnerByLineUser && deps.findWinnerByLineUser(userId);
    if (w && w.x_id) return `${userName}(@${w.x_id})`;
  } catch (e) {}
  return userName;
}

async function sendApproval(id, p, isRevision) {
  const bot = getBot();
  if (!bot || !config.telegram.approvalChatId) return;
  const trunc = p.messageText.length > 500 ? p.messageText.substring(0, 500) + '...' : p.messageText;
  const head = (isRevision ? `🔄 修正版 承認依頼 #${id}` : `🤖 承認依頼 #${id}`) + (p.stage ? `  [${p.stage}]` : '');
  const markers = extractMarkers(p.reply);

  // マーカーをDBに記録
  if (markers.length && deps.saveInternalMarker) {
    for (const m of markers) {
      try {
        deps.saveInternalMarker({
          approvalId: id,
          userId: p.userId,
          markerType: m.type,
          markerText: m.text,
          generatedReply: p.reply.substring(0, 1000), // 全文は長すぎるので冒頭のみ
        });
      } catch (e) { logger.error('Marker record failed:', e.message); }
    }
  }

  // マーカーの重要度別に警告を構成
  let alert = '';
  if (markers.length) {
    const critical = markers.filter((m) => MARKER_LEVELS[m.type]?.level === 'critical');
    const warning = markers.filter((m) => MARKER_LEVELS[m.type]?.level === 'warning');
    const info = markers.filter((m) => MARKER_LEVELS[m.type]?.level === 'info');

    alert = '\n\n';
    if (critical.length) {
      alert += `🚨🚨🚨 このまま送信しないでください 🚨🚨🚨\n`;
      alert += `Botが判断できていません:\n${critical.map((m) => `${MARKER_LEVELS[m.type].emoji} ${m.text}`).join('\n')}\n`;
    }
    if (warning.length) {
      alert += (critical.length ? '\n' : '') + `⚠️ 警告 — 内容を確認してください:\n${warning.map((m) => `${MARKER_LEVELS[m.type].emoji} ${m.text}`).join('\n')}\n`;
    }
    if (info.length) {
      alert += (critical.length || warning.length ? '\n' : '') + `💡 確認事項:\n${info.map((m) => `${MARKER_LEVELS[m.type].emoji} ${m.text}`).join('\n')}\n`;
    }
    alert += `\n✏️ 返信で情報を伝えると作り直します\n💡 この目印は送信時に自動で取り除かれます`;
  }
  // 修正で作り直した場合は、その指示を今後も反映するか(=永続知識にするか)をこの場で選べるようにする
  const fb = lastFeedback.get(id);
  const learnNote = isRevision && fb
    ? `\n\n💡 この修正「${fb}」を今後も反映しますか?\n　→ 下の🧠を押すとBotが覚えます(押さなければ今回だけ)`
    : '';
  // 何の当選者/再提供で、今どの商品を提供中か(セットなら次)を常時表示する
  let provLine = '';
  try { const w = deps.findWinnerByLineUser(p.userId); if (w) provLine = `\n📦 ${offerStatusLine(w)}`; } catch (e) {}
  // 承認カードには顧客に送信される文章そのまま(マーカー除去後)を表示し、マーカー情報は警告部分に集約する
  const cleanReply = sanitizeForCustomer(p.reply);
  const text = `${head}${provLine}${alert}${p.eventNote || ''}\n\n👤 ${cardName(p.userId, p.userName)}様：\n${trunc}\n\n📝 お客様に送信される文(⬇️の線に挟まれた部分だけ)：\n━━━━━━━━━━\n${cleanReply}\n━━━━━━━━━━\n⬆️ ここまでが送信されます。ここから下は社内向け(送信されません)${learnNote}${p.internalNote ? `\n\n🗒 Botメモ：\n${String(p.internalNote).slice(0, 500)}` : ''}\n\n✏️ さらに修正：このメッセージに「返信」で指示を送ると再生成します`;
  const rows = [[{ text: '✅ 承認', callback_data: `a:${id}` }, { text: '❌ 却下', callback_data: `r:${id}` }]];
  if (isRevision && fb) rows.push([{ text: '🧠 この修正を今後も反映する', callback_data: `k:${id}` }]);
  const opts = { reply_markup: { inline_keyboard: rows } };
  try {
    const sent = await bot.sendMessage(config.telegram.approvalChatId, text, opts);
    if (sent && sent.message_id) { p.tgMsgId = sent.message_id; tgMsgToApproval.set(sent.message_id, id); try { deps.linkTelegramMessage && deps.linkTelegramMessage({ approvalId: id, tgMsgId: sent.message_id }); } catch (e) {} }
    // 受信画像(本人確認スクショ等)をカードに添付し、承認者が目視で真偽確認できるようにする
    if (p.images && p.images.length) {
      for (let i = 0; i < p.images.length; i++) {
        try {
          await bot.sendPhoto(config.telegram.approvalChatId, Buffer.from(p.images[i].base64, 'base64'), {
            caption: `📎 ${cardName(p.userId, p.userName)}様からの受信画像 ${i + 1}/${p.images.length}(#${id} の判断材料)`,
            ...(sent && sent.message_id ? { reply_to_message_id: sent.message_id } : {}),
          }, { filename: `image_${i + 1}.jpg`, contentType: p.images[i].mediaType || 'image/jpeg' });
        } catch (e) { logger.error('カードへの画像添付に失敗:', e.message); }
      }
    }
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
  let newReply, newStage = null, newEvents = {}, newInternalNote = null;
  try {
    ({ reply: newReply, stage: newStage, events: newEvents, internalNote: newInternalNote } = await generateReply({ userName: p.userName, messageText: p.messageText, conversationHistory: p.history, customerData: p.customerData, winnerInfo: p.winnerInfo, images: p.images, previousReply: p.reply, feedback }));
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
  const np = { userId: p.userId, userName: p.userName, reply: newReply, stage: newStage, messageText: p.messageText, customerData: p.customerData, history: p.history, winnerInfo: p.winnerInfo, images: p.images, tgMsgId: null, lastMsgAt: p.lastMsgAt, kind: p.kind, internalNote: newInternalNote };
  pendingApprovals.set(newId, np);
  deps.saveApproval({ approvalId: newId, userId: p.userId, generatedReply: newReply, status: 'pending' });
  await sendApproval(newId, np, true);
}
// フォローアップ提案(followup_check.js等の外部トリガーから): 承認ボタン付きでTelegramに提示し、承認でLINE送信
let fuCounter = 0;
async function proposeFollowup({ userId, userName, text, label }) {
  const id = `fu${Date.now()}${fuCounter++}`;
  const p = { userId, userName: userName || '(不明)', reply: text, messageText: `(フォローアップ提案: ${label})`, customerData: null, history: [], winnerInfo: null, tgMsgId: null, kind: 'followup' };
  pendingApprovals.set(id, p);
  deps.saveApproval({ approvalId: id, userId, generatedReply: text, status: 'pending' });
  const bot = getBot();
  if (!bot || !config.telegram.approvalChatId) return false;
  const msg = `📋 フォローアップ提案 #${id}\n\n👤 ${cardName(p.userId, p.userName)} — ${label}\n\n📝 送信文面:\n${text}\n\n━━━━━━━━━━\n✅で送信 / ✏️修正はこのメッセージに返信で指示`;
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
    const lines = []; const dups = []; const negs = []; let ng = 0;
    for (const w of list) {
      if (!w.x_id || !/^[A-Za-z0-9_]{1,15}$/.test(w.x_id)) { ng++; continue; }
      try {
        const r = deps.addWinner({ xId: w.x_id, campaign: w.campaign || '(企画名なし)', offer: w.offer || 'unknown', tier: w.tier === 'strong' ? 'strong' : 'normal', notes: w.notes || null });
        lines.push(`・@${w.x_id} — ${OFFER_LABEL[w.offer] || w.offer}${w.tier === 'strong' ? ' 🔶強' : ''}`);
        if (r.duplicate) dups.push(`@${w.x_id}(既存:「${r.duplicate.campaign}」が未完了)`);
        const neg = negativeInfo(w.x_id);
        if (neg) negs.push(`・@${w.x_id}${neg.name ? '(' + neg.name + ')' : ''} — 「良くない」評価${neg.negCount}回: ${neg.history.slice(-2).join(' / ')}`);
      } catch (e) { logger.error('addWinner failed:', e.message); ng++; }
    }
    const parts = [`✅ ${lines.length}名を当選者リストに登録しました (登録: ${who})`, '', `企画: ${list[0].campaign || '(企画名なし)'}`, ...lines];
    if (dups.length) parts.push('', '⚠️ 同じIDで未完了の案件があります(重ねて登録しました):', ...dups.map((d) => `・${d}`));
    if (negs.length) parts.push('', '🚨【警告】過去にネガティブレビュー(「良くない」評価)の人が含まれています!', ...negs, '選出ミスの可能性があります。取り消す場合は大塚さん(司令塔)に伝えてください。');
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

  // 自然文での軽い修復指示: 「/直して ○○さんへの返信が来てない」等をClaudeが解釈して安全な操作に変換する。
  // 実行できるのは実証済みの安全操作のみ(生成やり直し/カード再発行/点検/再起動の確認ボタン)。それ以外は司令塔行きと案内する
  bot.onText(/^\/(直して|なおして|fix)(?:@\S+)?(?:\s|\n)([\s\S]+)$/, async (msg, match) => {
    if (String(msg.chat.id) !== String(config.telegram.approvalChatId)) return;
    const req = match[2].trim();
    try { await bot.sendMessage(msg.chat.id, '🔧 内容を確認しています…'); } catch (e) {}
    let intent = null;
    try {
      const cust = (deps.listRecentCustomers ? deps.listRecentCustomers(14) : [])
        .map((c) => `${c.display_name || '(名前不明)'} | ${String(c.user_id).slice(-6)}`).join('\n');
      const raw = await runRaw({
        system: 'あなたはLINE Bot運用の修復依頼を解釈する分類器です。JSONのみを出力します。',
        prompt: `スタッフの依頼文を読み、該当アクションをJSONで返してください。\n\nアクション:\n- regen: 特定のお客様への返信が生成されていない/届いていない → 作り直す。targetに名前の手がかり、下の顧客一覧に該当があればuser_id_tail(ID下6桁)も入れる\n- reissue: 承認カードが消えた/ボタンが押せない → 再発行\n- restart: Botの再起動を求めている\n- check: 全体の点検・状態確認\n- none: 上記以外(コード修正・新機能・複雑な調査など)\n\n【最近の顧客一覧(表示名 | ID下6桁)】\n${cust || '(なし)'}\n\n【依頼文】\n${req}\n\n出力例: {"action":"regen","target":"Hiroko","user_id_tail":"997f11"}\n該当顧客が特定できなければ user_id_tail は null。JSONのみ。`,
        maxTokens: 300,
        label: 'repairIntent',
      });
      const m = raw.match(/\{[\s\S]*\}/);
      intent = m ? JSON.parse(m[0]) : null;
    } catch (e) { logger.error('Repair intent parse failed:', e.message); }
    if (!intent || !intent.action) {
      try { await bot.sendMessage(msg.chat.id, '⚠️ 依頼を読み取れませんでした。念のため全体点検を実行します。'); } catch (e) {}
      try { await reconcile(); } catch (e) {}
      return;
    }
    if (intent.action === 'regen') {
      let target = null;
      if (intent.user_id_tail) {
        const cands = (deps.listRecentCustomers ? deps.listRecentCustomers(14) : []).filter((c) => String(c.user_id).endsWith(String(intent.user_id_tail)));
        if (cands.length === 1) target = cands[0];
      }
      if (!target) {
        try { await bot.sendMessage(msg.chat.id, `⚠️ どのお客様か特定できませんでした${intent.target ? `(「${intent.target}」に該当なし)` : ''}。LINEの表示名を入れて「/直して ○○さんへの返信が来てない」の形でお願いします。`); } catch (e) {}
        return;
      }
      const userName = target.display_name || 'お客様';
      const last = deps.getLastIncoming ? deps.getLastIncoming(target.user_id) : null;
      // 未処理カードが残っていても、追い越し統合が自動で1枚にまとめてくれる
      inbox.set(target.user_id, {
        userName,
        texts: [(last && last.content) || '(直前のメッセージはchat.line.bizを確認)'],
        images: [],
        firstAt: Date.now(),
        timer: setTimeout(() => { flushInbox(target.user_id).catch((err) => logger.error('Flush error:', err.message)); }, 1500),
      });
      try { await bot.sendMessage(msg.chat.id, `🔁 ${userName}様への返信を作り直しています。まもなく新しい承認カードが届きます。`); } catch (e) {}
      return;
    }
    if (intent.action === 'reissue') {
      try { await reissuePendingApprovals(); } catch (e) {}
      try { await bot.sendMessage(msg.chat.id, '♻️ カードの再発行チェックを実行しました(該当があれば直前に届いています)。'); } catch (e) {}
      return;
    }
    if (intent.action === 'restart') {
      try { await bot.sendMessage(msg.chat.id, 'Botを再起動しますか?', { reply_markup: { inline_keyboard: [[{ text: '🔄 再起動する(安全・約20秒)', callback_data: 'sys:restart' }]] } }); } catch (e) {}
      return;
    }
    if (intent.action === 'check') {
      try { await reconcile(); } catch (e) {}
      try { await bot.sendMessage(msg.chat.id, '✅ 全体点検を実行しました。状態の詳細は /システム で確認できます。'); } catch (e) {}
      return;
    }
    try { await bot.sendMessage(msg.chat.id, `📋 これは現地の安全操作では対応できない内容です。大塚さんの司令塔(Claude)に次のように伝えてください:\n「${req}」`); } catch (e) {}
  });

  // Botの自己点検: スタッフが「カードが来ない」等と感じた時にまず押す安全な復旧コマンド。
  // 整合性チェックを即時実行し(消えたカードの再発行・未応答の生成やり直し)、状態サマリと安全な再起動ボタンを返す
  bot.onText(/^\/(システム|system|点検)(?:@\S+)?$/, async (msg) => {
    if (String(msg.chat.id) !== String(config.telegram.approvalChatId)) return;
    let note = '';
    try { await reconcile(); note = '✅ 整合性チェック実行済み(消えたカードや未応答があれば、直前に自動で再発行・再生成されています)'; }
    catch (e) { note = '⚠️ 整合性チェックでエラー: ' + e.message; }
    let errToday = 0;
    try {
      const f = path.join(__dirname, '../../data/logs/app-' + new Date().toISOString().slice(0, 10) + '.log');
      errToday = (fs.readFileSync(f, 'utf-8').match(/\[ERROR\]/g) || []).length;
    } catch (e) {}
    const up = Math.floor(process.uptime() / 60);
    const lines = [
      '🔧 システム自己点検',
      `稼働時間: ${Math.floor(up / 60)}時間${up % 60}分 / 本日のエラーログ: ${errToday}件`,
      `承認待ちカード: ${pendingApprovals.size}件(ボタン生存)`,
      note,
      '',
      'これで直らない場合は下の再起動を試すか、大塚さんに連絡してください。',
    ];
    try {
      await bot.sendMessage(msg.chat.id, lines.join('\n'), {
        reply_markup: { inline_keyboard: [[{ text: '🔄 Botを再起動する(安全・約20秒)', callback_data: 'sys:restart' }]] },
      });
    } catch (e) {}
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
      '【調子がおかしいと思ったら】',
      '/システム … Botの自己点検。「返信カードが来ない」等の時にまず実行',
      '(消えたカードの再発行・未応答の生成やり直しが自動で走ります)',
      '/直して(困りごと) … 例: /直して Hirokoさんへの返信が来てない',
      '(日本語を理解して、作り直し・再発行など安全な操作だけ自動でやります)',
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
    if (action === 'sys') {
      const sub = q.data.split(':')[1];
      if (sub === 'restart') {
        await bot.answerCallbackQuery(q.id, { text: '再起動します' });
        try { await bot.sendMessage(q.message.chat.id, `🔄 ${who}さんの操作でBotを再起動します。約20秒後に自動で戻り、未処理のカードは再発行されます。`); } catch (e) {}
        const { spawn } = require('child_process');
        spawn('/bin/sh', ['-c', 'sleep 1; launchctl kickstart -k gui/501/com.user.line.bot'], { detached: true, stdio: 'ignore' }).unref();
      }
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
      // 送信前に消し込む: ボタンの二度押し・コールバック二重配送による二重送信を防ぐ(失敗時は戻す)
      pendingApprovals.delete(id);
      const ok = await deps.sendLineReply(p.userId, outgoing);
      if (ok) {
        deps.saveConversation({ userId: p.userId, direction: 'outgoing', content: outgoing });
        deps.updateApproval({ approvalId: id, status: 'approved', finalReply: outgoing });
        // マーカーのステータスを更新
        try { if (deps.updateMarkerStatus) deps.updateMarkerStatus({ approvalId: id, status: 'approved' }); } catch (e) {}
      }
      else { pendingApprovals.set(id, p); }
      await bot.answerCallbackQuery(q.id, { text: ok ? '✅ 送信完了' : '❌ 送信失敗(もう一度押してください)' });
      if (ok) { try { await bot.editMessageText(`✅ 承認・送信済 (${who})\n\n${q.message.text}`, { chat_id: q.message.chat.id, message_id: q.message.message_id }); } catch (e) {} }

      if (ok && p.tgMsgId) tgMsgToApproval.delete(p.tgMsgId);
    } else if (action === 'r') {
      deps.updateApproval({ approvalId: id, status: 'rejected', finalReply: null });
      // マーカーのステータスを更新
      try { if (deps.updateMarkerStatus) deps.updateMarkerStatus({ approvalId: id, status: 'rejected' }); } catch (e) {}
      await bot.answerCallbackQuery(q.id, { text: '❌ 却下' });
      try { await bot.editMessageText(`❌ 却下 (${who})\n\n${q.message.text}`, { chat_id: q.message.chat.id, message_id: q.message.message_id }); } catch (e) {}
      // 却下は「Botの案が使えなかった」という最も重要な学習信号。理由を拾う
      try {
        const sent = await bot.sendMessage(q.message.chat.id,
          `❓ 却下の理由を教えてください(このメッセージに返信)\n\n・何がダメだったか\n・実際にLINEで何と返信したか\n\nどちらでも構いません。今後の改善に使います。\n(不要ならスルーでOK)`,
          { reply_to_message_id: q.message.message_id });
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
// 同一ユーザーのpendingカードを1枚に保つ。カード作成「後」に呼ぶことで、
// 生成中(20〜40秒)に次のメッセージが届いて両方のカードが生き残るレースを塞ぐ。
// メッセージ受信時刻(lastMsgAt)が新しい方を残す。フォローアップ提案カードは対象外。
async function supersedeOlderCards(newId, np) {
  const bot = getBot();
  for (const [oid, op] of [...pendingApprovals.entries()]) {
    if (oid === newId || op.userId !== np.userId || op.kind === 'followup' || np.kind === 'followup') continue;
    const keepNew = (np.lastMsgAt || 0) >= (op.lastMsgAt || 0);
    const dropId = keepNew ? oid : newId;
    const dropP = keepNew ? op : np;
    const keepId = keepNew ? newId : oid;
    pendingApprovals.delete(dropId);
    try { deps.updateApproval({ approvalId: dropId, status: 'superseded', finalReply: null }); } catch (e) {}
    if (bot && dropP.tgMsgId) {
      try { await bot.editMessageText(`⏩ このカードは新しいカード(#${keepId})に統合されました。新しい方で対応してください。`, { chat_id: config.telegram.approvalChatId, message_id: dropP.tgMsgId }); } catch (e) {}
    }
    logger.info(`Card merged: #${dropId} -> #${keepId}`);
    if (!keepNew) return; // 自分の方が古かった(自分を破棄した)
  }
}

// Bot再起動で承認ボタンが失われた(メモリ喪失)pendingカードを、保存済みの返信案のまま自動で再発行する。
// 相手はこちらの返信を待っている側なので、「次のメッセージが来たら置き換わる」だけでは対応が止まってしまう。
async function reissuePendingApprovals() {
  const bot = getBot();
  if (!bot || !deps.listPendingApprovals) return;
  let rows = [];
  try { rows = deps.listPendingApprovals(3) || []; } catch (e) { logger.error('Reissue list failed:', e.message); return; }
  let n = 0;
  for (const r of rows) {
    if (pendingApprovals.has(r.approval_id)) continue; // ボタン生存中(正常)
    const age = Date.now() - new Date(String(r.created_at).replace(' ', 'T') + 'Z').getTime();
    if (age < 3 * 60000) continue; // 発行直後のカードを二重発行しない
    n++;
    try {
      deps.updateApproval({ approvalId: r.approval_id, status: 'superseded', finalReply: null });
      // 古いカードの見た目も無効化する(ボタンだけ死んで生きて見えるのを防ぐ)
      if (r.tg_msg_id) {
        try { await bot.editMessageText(`♻️ このカードは再発行されました。新しいカードで対応してください。`, { chat_id: config.telegram.approvalChatId, message_id: Number(r.tg_msg_id) }); } catch (e2) {}
      }
      const customer = deps.getCustomer(r.user_id);
      const userName = (customer && customer.display_name) || 'お客様';
      const history = (deps.getRecentConversations(r.user_id, 30) || []).reverse().map((c) => ({ role: c.direction === 'incoming' ? 'user' : 'assistant', content: c.content }));
      const lastIncoming = [...history].reverse().find((m) => m.role === 'user');
      const messageText = lastIncoming ? lastIncoming.content : '(受信内容はchat.line.bizで確認してください)';
      let winnerInfo = null;
      try { winnerInfo = buildWinnerContext({ deps, messageText, customer, userId: r.user_id }); } catch (e2) {}
      const id = `${Date.now()}${n}`;
      const p = { userId: r.user_id, userName, reply: r.generated_reply, stage: customer && customer.stage, eventNote: '\n♻️ Bot再起動のため再発行(返信案は元の生成のまま。受信画像があった場合はchat.line.bizで確認)', messageText, customerData: customer, history, winnerInfo, images: [], tgMsgId: null };
      pendingApprovals.set(id, p);
      deps.saveApproval({ approvalId: id, userId: r.user_id, generatedReply: r.generated_reply, status: 'pending' });
      p.lastMsgAt = new Date(String(r.created_at).replace(' ', 'T') + 'Z').getTime();
      await sendApproval(id, p, false);
      await supersedeOlderCards(id, p);
      logger.info(`Reissued approval ${r.approval_id} -> #${id}`);
    } catch (e) { logger.error(`Reissue failed (${r.approval_id}):`, e.message); }
  }
  if (n) logger.info(`Reissue done: ${n}件`);
}

// ── 整合性チェック(5分ごと) ─────────────────────────────
// 「仕組みが動いたはず」を信用せず、あるべき状態と実際を照合して自動修復する。
// 1) DB上pendingなのにボタンが生きていないカード → 再発行
// 2) 受信から20分〜3時間、返信もカードも無い相手 → 会話履歴から生成をやり直す(最大2回、以後は🚨警告)
const regenAttempts = new Map(); // userId -> 試行回数
async function reconcile() {
  try { await reissuePendingApprovals(); } catch (e) { logger.error('Reconcile(reissue) failed:', e.message); }
  try {
    if (!deps.listUnansweredUsers) return;
    const bot = getBot();
    for (const r of deps.listUnansweredUsers() || []) {
      const ageMs = Date.now() - new Date(String(r.last_in_at).replace(' ', 'T') + 'Z').getTime();
      if (ageMs < 20 * 60000 || ageMs > 3 * 3600000) continue; // 手動対応済みの古い会話には触らない
      let hasCard = false;
      for (const pp of pendingApprovals.values()) if (pp.userId === r.user_id) { hasCard = true; break; }
      if (hasCard || inbox.has(r.user_id)) continue;
      const tries = regenAttempts.get(r.user_id) || 0;
      if (tries >= 2) {
        if (tries === 2) {
          regenAttempts.set(r.user_id, 3);
          if (bot && config.telegram.approvalChatId) {
            try { await bot.sendMessage(config.telegram.approvalChatId, `🚨 整合性チェック: お客様(ID末尾${String(r.user_id).slice(-6)})への返信を自動復旧できませんでした。chat.line.bizで手動対応してください。`); } catch (e2) {}
          }
        }
        continue;
      }
      regenAttempts.set(r.user_id, tries + 1);
      const customer = deps.getCustomer(r.user_id);
      const userName = (customer && customer.display_name) || 'お客様';
      const last = deps.getLastIncoming ? deps.getLastIncoming(r.user_id) : null;
      logger.info(`Reconcile: 未応答を検出、生成をやり直します (${userName})`);
      // 受信は保存済みなので再保存せず、バッファに直接積んで正規の生成経路に乗せる
      inbox.set(r.user_id, {
        userName,
        texts: [(last && last.content) || '(直前のメッセージはchat.line.bizを確認)'],
        images: [],
        firstAt: Date.now(),
        timer: setTimeout(() => { flushInbox(r.user_id).catch((err) => logger.error('Flush error:', err.message)); }, 1500),
      });
    }
  } catch (e) { logger.error('Reconcile(unanswered) failed:', e.message); }
}

// Sentinel(駐在エージェント)からの安全操作要求を実行する(localhostの/internal/repair経由)
async function execRepair({ action, tail }) {
  if (action === 'check') { await reconcile(); return { ok: true, note: '整合性チェックを実行しました' }; }
  if (action === 'reissue') { await reissuePendingApprovals(); return { ok: true, note: 'カード再発行チェックを実行しました' }; }
  if (action === 'regen') {
    if (!tail) return { ok: false, error: '対象IDがありません' };
    const cands = (deps.listRecentCustomers ? deps.listRecentCustomers(14) : []).filter((c) => String(c.user_id).endsWith(String(tail)));
    if (cands.length !== 1) return { ok: false, error: '対象顧客を特定できません(ID下6桁: ' + tail + ')' };
    const t = cands[0];
    const userName = t.display_name || 'お客様';
    const last = deps.getLastIncoming ? deps.getLastIncoming(t.user_id) : null;
    inbox.set(t.user_id, {
      userName,
      texts: [(last && last.content) || '(直前のメッセージはchat.line.bizを確認)'],
      images: [],
      firstAt: Date.now(),
      timer: setTimeout(() => { flushInbox(t.user_id).catch((err) => logger.error('Flush error:', err.message)); }, 1500),
    });
    return { ok: true, note: userName + '様への返信を再生成中(まもなく承認カードが届きます)' };
  }
  return { ok: false, error: '不明なアクション: ' + action };
}

module.exports = { setup, handleMessage, proposeFollowup, reissuePendingApprovals, reconcile, execRepair };
