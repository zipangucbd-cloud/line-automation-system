require('dotenv').config();
const express = require('express');
const { setupLineWebhook, sendReply } = require('./line/webhook');
const dbModule = require('./db/init');
const { initTelegram } = require('./telegram/bot');
const approvalFlow = require('./telegram/approval');
const logger = require('./utils/logger');
async function main() {
  logger.info('=== LINE Bot Server Starting ===');
  dbModule.initDb();
  await initTelegram();
  approvalFlow.setup({
    sendLineReply: sendReply,
    saveConversation: dbModule.saveConversation,
    saveApproval: dbModule.saveApproval,
    updateApproval: dbModule.updateApproval,
    getCustomer: dbModule.getCustomer,
    upsertCustomer: dbModule.upsertCustomer,
    getRecentConversations: dbModule.getRecentConversations,
    findWinnerByXid: dbModule.findWinnerByXid,
    findWinnerByLineUser: dbModule.findWinnerByLineUser,
    linkWinnerToLine: dbModule.linkWinnerToLine,
  });
  const app = express();
  setupLineWebhook(app);
  app.get('/', (req, res) => res.send('LINE Bot Server is running'));
  app.get('/health', (req, res) => res.json({ status: 'ok', timestamp: new Date().toISOString() }));
  const port = process.env.PORT || 3000;
  app.listen(port, () => { logger.info(`Server on port ${port}`); logger.info('Ready'); });
}
main().catch(err => { logger.error('Fatal:', err.message); process.exit(1); });
