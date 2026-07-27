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

async function handleMessage(event) {
  const userId = event.source.userId;
  const messageText = event.message.text;
  logger.info(`Received: ${messageText.substring(0, 100)}`);
  let userName = 'Unknown';
  try {
    const profile = await client.getProfile(userId);
    userName = profile.displayName;
  } catch (e) { logger.warn('Could not get profile:', e.message); }
  await approvalFlow.handleMessage({ userId, userName, messageText });
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
