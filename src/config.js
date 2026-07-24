require('dotenv').config();
module.exports = {
  line: {
    channelId: process.env.LINE_CHANNEL_ID,
    channelSecret: process.env.LINE_CHANNEL_SECRET,
    channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
  },
  claude: {
    apiKey: process.env.ANTHROPIC_API_KEY,
    model: process.env.CLAUDE_MODEL || 'claude-sonnet-4-5-20250929',
  },
  telegram: {
    botToken: process.env.TELEGRAM_BOT_TOKEN,
    approvalChatId: process.env.TELEGRAM_APPROVAL_CHAT_ID,
    ownerChatId: process.env.TELEGRAM_OWNER_CHAT_ID,
  },
  db: { path: process.env.DB_PATH || './data/customers.db' },
  server: { port: process.env.PORT || 3000 },
};
