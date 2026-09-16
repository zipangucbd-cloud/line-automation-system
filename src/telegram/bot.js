const tgb = require('node-telegram-bot-api');
const TelegramBot = tgb.default || tgb.TelegramBot || tgb;
const config = require('../config');
const logger = require('../utils/logger');
let bot = null;
let pollErrCount = 0;      // 最後に更新を受け取ってからの連続ポーリングエラー数
let lastPollErrAt = 0;
let lastPollErrLogAt = 0;
let lastUpdateAt = Date.now();
async function initTelegram() {
  if (!config.telegram.botToken) { logger.warn('Telegram bot token not set'); return null; }
  bot = new TelegramBot(config.telegram.botToken, {
    polling: { autoStart: true, params: { timeout: 30 } },
    request: { agentOptions: { keepAlive: true, family: 4 } },
    // TG_API_BASE(.env)があればローカルHTTP/2プロキシ経由で通信する。
    // この回線はTelegram宛のHTTP/1.1系TLSがDPI遮断されるため(scripts/tg_proxy.js参照)
    ...(process.env.TG_API_BASE ? { baseApiUrl: process.env.TG_API_BASE } : {}),
  });
  // ポーリングの健全性は「受動的に」観測する。外からgetUpdatesを叩いて確認する方式は
  // Bot自身のlong pollを叩き落とし、二重ポーリング(409の殴り合い)を誘発したため廃止した
  // (2026-09-15の二次障害。1日で1万件超の409が出た)
  bot.on('polling_error', (err) => {
    pollErrCount++;
    lastPollErrAt = Date.now();
    // 毎秒出続けることがあるのでログは1分に1回へ間引く(件数は保持する)
    if (Date.now() - lastPollErrLogAt > 60000) {
      lastPollErrLogAt = Date.now();
      logger.error(`Telegram polling error: ${err.message}${pollErrCount > 1 ? ` (直近の連続エラー ${pollErrCount}件)` : ''}`);
    }
  });
  // 更新を1件でも受け取れていれば受信は健全とみなし、連続エラーの数え上げをリセットする
  const seen = () => { pollErrCount = 0; lastUpdateAt = Date.now(); };
  bot.on('message', seen);
  bot.on('callback_query', seen);
  bot.onText(/\/start/, (msg) => bot.sendMessage(msg.chat.id, 'Bot is ready.\nChat ID: ' + msg.chat.id));
  bot.onText(/\/chatid/, (msg) => bot.sendMessage(msg.chat.id, 'Chat ID: ' + msg.chat.id));
  logger.info('Telegram bot connected');
  return bot;
}
function getBot() { return bot; }
// 受信の健全性(死活監視用)。polling=ライブラリが実際にポーリング中か
function pollingHealth() {
  return {
    polling: bot ? bot.isPolling() : false,
    errCount: pollErrCount,
    lastErrAt: lastPollErrAt,
    lastUpdateAt,
  };
}
module.exports = { initTelegram, getBot, pollingHealth };
