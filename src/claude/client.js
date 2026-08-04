const Anthropic = require('@anthropic-ai/sdk');
const fs = require('fs');
const path = require('path');
const config = require('../config');
const logger = require('../utils/logger');
const client = new Anthropic({ apiKey: config.claude.apiKey });
const systemPromptPath = path.join(__dirname, '../knowledge/system_prompt.md');
const systemPrompt = fs.existsSync(systemPromptPath) ? fs.readFileSync(systemPromptPath, 'utf-8') : 'あなたはSEXTASY VIP ROOMの応対AIです。丁寧なフォーマル敬語で応対してください。';

// 返信案とあわせて現在ステージを申告させる。ステージ行は送信文から取り除いてDBに保存する。
const STAGE_INSTRUCTION = `

---
【出力形式の指示】
返信文の最後に、改行してから次の1行を必ず付けてください(この行は顧客には送信されず、社内の進捗管理にのみ使われます):
<<STAGE:ステージID>>

ステージIDは次から選びます:
S1_問診回答待ち / S1_問診不足追撃 / S2_本人確認待ち / S3_事前確認待ち / S4_オファー提示済 / S4_Amazon資格確認 / S4_LP案内済 / S4_カートスクショ待ち / S5_注文番号待ち / S5_発送済 / S6_到着連絡待ち / S6_撮影説明済 / S6_読了確認待ち / S7_レビュー下書き待ち / S7_下書き確認済 / S8_EC投稿待ち / S8_完了報告待ち / S9_キャッシュバック済 / S9_連鎖案内済 / 完了 / 対応保留`;

async function generateReply({ userName, messageText, conversationHistory = [], customerData = null, winnerInfo = null, image = null, previousReply = null, feedback = null }) {
  try {
    let contextInfo = '';
    if (customerData) {
      const { user_id, created_at, updated_at, ...shown } = customerData;
      contextInfo += `\n\n【顧客カルテ】\n${JSON.stringify(shown, null, 2)}\n`;
      if (customerData.stage) contextInfo += `\n※この方の現在のステージは「${customerData.stage}」です。ここから自然に次へ進めてください。\n`;
    }
    if (winnerInfo) contextInfo += `\n\n【当選者照合】\n${winnerInfo}\n`;

    const messages = [];
    for (const msg of conversationHistory) messages.push({ role: msg.role, content: msg.content });

    // 画像が届いた場合は、何のスクリーンショットかを判定させたうえで返信を作らせる
    if (image) {
      messages.push({
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: image.mediaType, data: image.base64 } },
          { type: 'text', text: `【${userName}様から画像が届きました】\nこの画像が何のスクリーンショットかを判断し(Xのプロフィール画面／Amazonの検索結果画面／Amazonのカート画面／レビュー投稿の下書き／商品の到着写真／その他)、フロー上の適切な次の一手を返信案にしてください。\n判断に迷う場合や、求めていたものと違う画像の場合は、返信案の冒頭に「[要人間判断]」を付けてください。${contextInfo}` },
        ],
      });
    } else {
      messages.push({ role: 'user', content: `【${userName}様からのメッセージ】\n${messageText}${contextInfo}` });
    }

    // 承認者からの修正指示による再生成: 前回案をassistantとして積み、指示を明示的に運営発として渡す
    if (previousReply && feedback) {
      messages.push({ role: 'assistant', content: previousReply });
      messages.push({ role: 'user', content: `【運営(承認者)からの修正指示 — これは${userName}様からのメッセージではありません】\n直前のあなたの返信案を、次の指示に従って書き直してください。修正後の返信文のみを出力してください。\n\n${feedback}` });
    }

    const response = await client.messages.create({
      model: config.claude.model,
      max_tokens: 2048,
      system: systemPrompt + STAGE_INSTRUCTION,
      messages,
    });
    const raw = response.content[0].text;
    // ステージ申告を抽出し、顧客に送る本文からは取り除く
    const m = raw.match(/<<STAGE:([^>]+)>>/);
    const stage = m ? m[1].trim() : null;
    const reply = raw.replace(/\n*<<STAGE:[^>]+>>\s*$/, '').trim();
    return { reply, stage };
  } catch (err) {
    logger.error('Claude API error:', err.message);
    throw err;
  }
}
module.exports = { generateReply };
