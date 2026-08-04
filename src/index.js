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
    saveKnowledgeGap: dbModule.saveKnowledgeGap,
    addWinner: dbModule.addWinner,
    listActiveWinners: dbModule.listActiveWinners,
    linkTelegramMessage: dbModule.linkTelegramMessage,
    findApprovalByTgMsg: dbModule.findApprovalByTgMsg,
    getLastIncoming: dbModule.getLastIncoming,
    resolveKnowledgeGaps: dbModule.resolveKnowledgeGaps,
    getRecentConversations: dbModule.getRecentConversations,
    findWinnerByXid: dbModule.findWinnerByXid,
    findWinnerByLineUser: dbModule.findWinnerByLineUser,
    linkWinnerToLine: dbModule.linkWinnerToLine,
  });
  const app = express();
  setupLineWebhook(app);
  app.get('/', (req, res) => res.send('LINE Bot Server is running'));
  app.get('/health', (req, res) => res.json({ status: 'ok', timestamp: new Date().toISOString() }));
  // フォローアップ提案の内部エンドポイント(localhost限定。followup_check.jsから呼ばれる)
  app.post('/internal/propose', express.json(), async (req, res) => {
    const ip = req.socket.remoteAddress;
    if (ip !== '127.0.0.1' && ip !== '::1' && ip !== '::ffff:127.0.0.1') return res.status(403).send('Forbidden');
    const { userId, userName, text, label } = req.body || {};
    if (!userId || !text) return res.status(400).json({ ok: false, error: 'userId and text required' });
    const ok = await approvalFlow.proposeFollowup({ userId, userName, text, label: label || 'フォローアップ' });
    res.json({ ok });
  });
  const port = process.env.PORT || 3000;
  app.listen(port, () => { logger.info(`Server on port ${port}`); logger.info('Ready'); });
}
main().catch(err => { logger.error('Fatal:', err.message); process.exit(1); });
