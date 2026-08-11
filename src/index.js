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
    listPendingApprovals: dbModule.listPendingApprovals,
    listUnansweredUsers: dbModule.listUnansweredUsers,
    getLastIncoming: dbModule.getLastIncoming,
    listRecentCustomers: dbModule.listRecentCustomers,
    getCustomer: dbModule.getCustomer,
    upsertCustomer: dbModule.upsertCustomer,
    saveKnowledgeGap: dbModule.saveKnowledgeGap,
    addWinner: dbModule.addWinner,
    applyWinnerEvents: dbModule.applyWinnerEvents,
    saveWinnerEvaluation: dbModule.saveWinnerEvaluation,
    getWinnerByLineUser: dbModule.getWinnerByLineUser,
    listReviewedWinners: dbModule.listReviewedWinners,
    winnerDashboard: dbModule.winnerDashboard,
    autoCompleteWinners: dbModule.autoCompleteWinners,
    completeWinnerByXid: dbModule.completeWinnerByXid,
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
  // 整合性チェック: 「あるべき状態」(pendingカードのボタン生存・受信への応答)と実際を
  // 5分ごとに照合し、ズレていれば自動修復する。イベント発火を信用しない設計。
  setTimeout(() => approvalFlow.reconcile().catch((e) => logger.error('Reconcile error:', e.message)), 5000);
  setInterval(() => approvalFlow.reconcile().catch((e) => logger.error('Reconcile error:', e.message)), 5 * 60000);
}
main().catch(err => { logger.error('Fatal:', err.message); process.exit(1); });
