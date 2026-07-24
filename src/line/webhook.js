const line = require('@line/bot-sdk');
const config = require('../config');
const approvalFlow = require('../telegram/approval');
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

function setupLineWebhook(app) {
  app.post('/webhook', line.middleware(lineConfig), async (req, res) => {
    try {
      const events = req.body.events || [];
      for (const event of events) {
        if (event.type === 'message' && event.message.type === 'text') await handleMessage(event);
      }
      res.status(200).send('OK');
    } catch (err) { logger.error('Webhook error:', err.message); res.status(500).send('Error'); }
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
