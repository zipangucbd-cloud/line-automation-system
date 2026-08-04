const Anthropic = require('@anthropic-ai/sdk');
const fs = require('fs');
const path = require('path');
const config = require('../config');
const logger = require('../utils/logger');
const client = new Anthropic({ apiKey: config.claude.apiKey });
const systemPromptPath = path.join(__dirname, '../knowledge/system_prompt.md');
const learnedPath = path.join(__dirname, '../knowledge/learned.md');

// 運営がTelegramで教えた知識を即座に反映するため、生成のたびにファイルを読み直す
function buildSystemPrompt() {
  const base = fs.existsSync(systemPromptPath)
    ? fs.readFileSync(systemPromptPath, 'utf-8')
    : 'あなたはSEXTASY VIP ROOMの応対AIです。丁寧なフォーマル敬語で応対してください。';
  let learned = '';
  if (fs.existsSync(learnedPath)) {
    const txt = fs.readFileSync(learnedPath, 'utf-8').trim();
    if (txt) {
      learned = `\n\n---\n# 【最優先】運営から直接教わった知識\n`
        + `以下は運営がTelegram経由で追加した情報です。上記の一般的な記述と食い違う場合は、**必ずこちらを優先**してください。\n\n${txt}\n`;
    }
  }
  return base + learned;
}

// 返信案とあわせて現在ステージを申告させる。ステージ行は送信文から取り除いてDBに保存する。
const STAGE_INSTRUCTION = `

---
【出力形式の指示】
返信文の最後に、改行してから次の1行を必ず付けてください(この行は顧客には送信されず、社内の進捗管理にのみ使われます):
<<STAGE:ステージID>>

ステージIDは次から選びます:
S1_問診回答待ち / S1_問診不足追撃 / S2_本人確認待ち / S3_事前確認待ち / S4_オファー提示済 / S4_Amazon資格確認 / S4_LP案内済 / S4_カートスクショ待ち / S5_注文番号待ち / S5_発送済 / S6_到着連絡待ち / S6_撮影説明済 / S6_読了確認待ち / S7_レビュー下書き待ち / S7_下書き確認済 / S8_EC投稿待ち / S8_完了報告待ち / S9_キャッシュバック済 / S9_連鎖案内済 / 完了 / 対応保留`;

async function generateReply({ userName, messageText, conversationHistory = [], customerData = null, winnerInfo = null, images = [], previousReply = null, feedback = null }) {
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

    // 画像が届いた場合は全枚数をまとめて渡し、返信は必ず1つだけ作らせる
    // (Amazonキャッシュバックでは検索結果画面とカート画面の2枚が続けて届く)
    if (images && images.length) {
      const content = images.map((img) => ({
        type: 'image',
        source: { type: 'base64', media_type: img.mediaType, data: img.base64 },
      }));
      const many = images.length > 1;
      content.push({
        type: 'text',
        text: `【${userName}様から画像が${images.length}枚届きました】${messageText ? `\n(同時に届いたメッセージ: ${messageText})` : ''}\n`
          + `${many ? 'これらの画像は一連のものです。**全ての画像を確認したうえで、返信は1通だけ**作成してください。画像ごとに分けて返信しないこと。\n' : ''}`
          + `各画像が何のスクリーンショットかを判断し(Xのプロフィール画面／Amazonの検索結果画面／Amazonのカート画面／レビュー投稿の下書き／商品の到着写真／その他)、フロー上の適切な次の一手を返信案にしてください。\n`
          + `${many ? '例えば「Amazonの検索結果画面」と「カート画面」の2枚が揃っていれば、カート追加まで完了しているので購入手続きの案内に進みます。片方しか無い場合は不足している方を依頼してください。\n' : ''}`
          + `判断に迷う場合や、求めていたものと違う画像の場合は、返信案の冒頭に「[要人間判断]」を付けてください。${contextInfo}`,
      });
      messages.push({ role: 'user', content });
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
      system: buildSystemPrompt() + STAGE_INSTRUCTION,
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
