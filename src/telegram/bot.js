const tgb = require('node-telegram-bot-api');
const TelegramBot = tgb.default || tgb.TelegramBot || tgb;
const config = require('../config');
const logger = require('../utils/logger');
let bot = null;
async function initTelegram() {
  if (!config.telegram.botToken) { logger.warn('Telegram bot token not set'); return null; }
  bot = new TelegramBot(config.telegram.botToken, {
    polling: { autoStart: true, params: { timeout: 30 } },
    request: { agentOptions: { keepAlive: true, family: 4 } }
  });
  bot.on('polling_error', (err) => logger.error('Telegram polling error:', err.message));
  bot.onText(/\/start/, (msg) => bot.sendMessage(msg.chat.id, 'Bot is ready.\nChat ID: ' + msg.chat.id));
  bot.onText(/\/chatid/, (msg) => bot.sendMessage(msg.chat.id, 'Chat ID: ' + msg.chat.id));
  logger.info('Telegram bot connected');
  return bot;
}
function getBot() { return bot; }
module.exports = { initTelegram, getBot };
