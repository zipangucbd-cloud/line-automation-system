const Anthropic = require('@anthropic-ai/sdk');
const fs = require('fs');
const path = require('path');
const config = require('../config');
const logger = require('../utils/logger');
const client = new Anthropic({ apiKey: config.claude.apiKey });
const systemPromptPath = path.join(__dirname, '../knowledge/system_prompt.md');
const systemPrompt = fs.existsSync(systemPromptPath) ? fs.readFileSync(systemPromptPath, 'utf-8') : 'あなたはSEXTASY VIP ROOMの応対AIです。丁寧なフォーマル敬語で応対してください。';
async function generateReply({ userName, messageText, conversationHistory = [], customerData = null }) {
  try {
    let contextInfo = '';
    if (customerData) contextInfo = `\n\n【顧客カルテ】\n${JSON.stringify(customerData, null, 2)}\n`;
    const messages = [];
    for (const msg of conversationHistory) messages.push({ role: msg.role, content: msg.content });
    messages.push({ role: 'user', content: `【${userName}様からのメッセージ】\n${messageText}${contextInfo}` });
    const response = await client.messages.create({ model: config.claude.model, max_tokens: 2048, system: systemPrompt, messages });
    return response.content[0].text;
  } catch (err) {
    logger.error('Claude API error:', err.message);
    throw err;
  }
}
module.exports = { generateReply };
