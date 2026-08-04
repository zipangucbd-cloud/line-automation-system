const line = require('@line/bot-sdk');
const fs = require('fs');
const path = require('path');
const config = require('../config');
const approvalFlow = require('../telegram/approval');
const { getBot } = require('../telegram/bot');
const dbModule = require('../db/init');
const logger = require('../utils/logger');

const lineConfig = {
  channelAccessToken: config.line.channelAccessToken,
  channelSecret: config.line.channelSecret,
};

// Use new API (v9+)
const client = new line.messagingApi.MessagingApiClient({
  channelAccessToken: lineConfig.channelAccessToken,
});

const blobClient = new line.messagingApi.MessagingApiBlobClient({
  channelAccessToken: lineConfig.channelAccessToken,
});

const greetingStep1 = fs.readFileSync(path.join(__dirname, '../knowledge/greeting_step1.txt'), 'utf8');
const greetingStep2 = fs.readFileSync(path.join(__dirname, '../knowledge/greeting_step2.txt'), 'utf8');

function setupLineWebhook(app) {
  // LINEのタイムアウト切断を防ぐため、即200を返して処理は非同期で行う
  app.post('/webhook',
    (req, res, next) => { logger.info(`Webhook hit (len=${req.headers['content-length'] || '?'})`); next(); },
    line.middleware(lineConfig),
    (req, res) => {
      const events = req.body.events || [];
      logger.info(`Webhook events: ${events.length}`);
      res.status(200).send('OK');
      for (const event of events) {
        (async () => {
          try {
            if (event.type === 'message' && event.message.type === 'text') await handleMessage(event);
            else if (event.type === 'message' && event.message.type === 'image') await handleImage(event);
            else if (event.type === 'message') await handleOtherMedia(event);
            else if (event.type === 'follow') await handleFollow(event);
          } catch (err) { logger.error('Webhook event error:', err.message); }
        })();
      }
    });
  app.use('/webhook', (err, req, res, next) => {
    logger.error(`Webhook middleware error: ${err.name}: ${err.message}`);
    res.status(400).send('Bad Request');
  });
}

async function getUserName(userId) {
  try {
    const profile = await client.getProfile(userId);
    return profile.displayName;
  } catch (e) { logger.warn('Could not get profile:', e.message); return 'Unknown'; }
}

async function handleMessage(event) {
  const userId = event.source.userId;
  const messageText = event.message.text;
  logger.info(`Received: ${messageText.substring(0, 100)}`);
  const userName = await getUserName(userId);
  await approvalFlow.handleMessage({ userId, userName, messageText });
}

// 画像(スクショ)受信: 本人確認・Amazonカート・レビュー下書きなど、フローの関門はすべて画像で届く
async function handleImage(event) {
  const userId = event.source.userId;
  const userName = await getUserName(userId);
  logger.info(`Received image from ${userName}`);
  let imageBase64 = null, mediaType = 'image/jpeg';
  try {
    const stream = await blobClient.getMessageContent(event.message.id);
    const chunks = [];
    for await (const chunk of stream) chunks.push(chunk);
    const buf = Buffer.concat(chunks);
    // Claude APIの画像サイズ上限に配慮(5MB超はスキップして通知のみ)
    if (buf.length <= 4.5 * 1024 * 1024) {
      imageBase64 = buf.toString('base64');
      if (buf[0] === 0x89 && buf[1] === 0x50) mediaType = 'image/png';
    } else {
      logger.warn(`Image too large (${buf.length} bytes), skipping analysis`);
    }
  } catch (e) { logger.error('Image download failed:', e.message); }
  await approvalFlow.handleMessage({
    userId, userName,
    messageText: '[画像を受信しました]',
    image: imageBase64 ? { base64: imageBase64, mediaType } : null,
  });
}

// 画像以外のメディア(動画・スタンプ・ファイル等)は内容を読まず、受信した事実だけを扱う
async function handleOtherMedia(event) {
  const userId = event.source.userId;
  const userName = await getUserName(userId);
  const kind = { video: '動画', audio: '音声', file: 'ファイル', sticker: 'スタンプ', location: '位置情報' }[event.message.type] || event.message.type;
  logger.info(`Received ${kind} from ${userName}`);
  await approvalFlow.handleMessage({ userId, userName, messageText: `[${kind}を受信しました]` });
}

// 友だち追加(follow)で問診2通を自動送信(本番のあいさつメッセージ相当)
async function handleFollow(event) {
  const userId = event.source.userId;
  let userName = '';
  try {
    const profile = await client.getProfile(userId);
    userName = profile.displayName;
  } catch (e) { logger.warn('Could not get profile:', e.message); }
  const step1 = userName
    ? greetingStep1.replace('{Nickname}', userName)
    : greetingStep1.replace(/^\{Nickname\}様\n/, '');
  const messages = [
    { type: 'text', text: step1 },
    { type: 'text', text: greetingStep2 },
  ];
  try {
    await client.replyMessage({ replyToken: event.replyToken, messages });
  } catch (err) {
    logger.error('Greeting reply failed, fallback to push:', err.message);
    try { await client.pushMessage({ to: userId, messages }); }
    catch (e2) { logger.error('Greeting push failed:', e2.message); return; }
  }
  dbModule.saveConversation({ userId, direction: 'outgoing', content: step1 });
  dbModule.saveConversation({ userId, direction: 'outgoing', content: greetingStep2 });
  dbModule.upsertCustomer({ userId, displayName: userName, stage: 'S1_問診回答待ち' });
  logger.info(`Greeting sent to new follower: ${userName || userId}`);
  const bot = getBot();
  if (bot && config.telegram.approvalChatId) {
    try { await bot.sendMessage(config.telegram.approvalChatId, `👋 新規友だち追加: ${userName || userId}\n問診(2通)を自動送信しました`); }
    catch (e) { logger.error('Telegram notify failed:', e.message); }
  }
}

async function sendReply(userId, message) {
  try {
    await client.pushMessage({
      to: userId,
      messages: [{ type: 'text', text: message }],
    });
    return true;
  } catch (err) { logger.error('LINE send failed:', err.message); return false; }
}

module.exports = { setupLineWebhook, sendReply };
