const Anthropic = require('@anthropic-ai/sdk');
const fs = require('fs');
const path = require('path');
const config = require('../config');
const logger = require('../utils/logger');

// ── 生成ルートは二段構え ─────────────────────────────────────
// 1) Maxプラン(Claude Agent SDK + CLAUDE_CODE_OAUTH_TOKEN) … 定額枠内。通常はこちら(追加課金なし)
// 2) Anthropic API直叩き(ANTHROPIC_API_KEY / 従量課金)      … Max枠超過・障害時の保険
const OAUTH_TOKEN = (process.env.CLAUDE_CODE_OAUTH_TOKEN || '').trim();
const apiClient = config.claude.apiKey ? new Anthropic({ apiKey: config.claude.apiKey }) : null;

// Agent SDKはESM配布のため動的importで読む(初回呼び出し時に1度だけ)
let agentQueryPromise = null;
function getAgentQuery() {
  if (!OAUTH_TOKEN) return Promise.resolve(null);
  if (!agentQueryPromise) {
    agentQueryPromise = import('@anthropic-ai/claude-agent-sdk')
      .then((m) => m.query)
      .catch((e) => {
        logger.error('claude-agent-sdk の読み込みに失敗(API直叩きで続行):', e.message);
        return null;
      });
  }
  return agentQueryPromise;
}

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
【出力形式の指示 — 必ずこの構造で出力すること】

(承認者に伝えたいことがあれば、まずここに書く: 画像の分析結果、判断の理由、迷った点など。
 この部分はお客様には送信されず、承認カードに「Botメモ」として表示される。無ければ省略してよい)
<<REPLY>>
お客様に送信する本文だけをここに書く
<<END>>
<<STAGE:ステージID>>

【絶対規則】
- <<REPLY>>〜<<END>>の中には、お客様への本文以外を一切入れない(分析・説明・社内向けの文章は必ずブロックの外)
- 本文の中で「運営指示」「学習済みの知識」「[日付]の指示に従い」など社内情報への言及は絶対に禁止
- <<STAGE:ステージID>>の行は<<END>>の後に付ける(顧客には送信されない)

ステージIDは次から選びます:
S1_問診回答待ち / S1_問診不足追撃 / S2_本人確認待ち / S3_事前確認待ち / S4_オファー提示済 / S4_Amazon資格確認 / S4_LP案内済 / S4_カートスクショ待ち / S5_注文番号待ち / S5_発送済 / S6_到着連絡待ち / S6_撮影説明済 / S6_読了確認待ち / S7_レビュー下書き待ち / S7_下書き確認済 / S8_EC投稿待ち / S8_完了報告待ち / S9_キャッシュバック済 / S9_連鎖案内済 / 完了 / 対応保留

さらに、今回のやり取りで**進捗上の出来事が確定した場合のみ**、STAGE行の下に該当する行を追加してください(該当しなければ何も書かない):
<<EVENT:shipped>>   … 発送手続きが完了した/発送した旨を伝えた
<<EVENT:arrived>>   … 商品が届いたと相手から連絡があった
<<EVENT:reviewed>>  … レビュー投稿が完了したと確認できた
<<EVENT:review_due=YYYY-MM-DD>> … 相手がレビュー投稿の予定日を答えた(「来週末」等の曖昧な表現は書かない。日付が特定できる場合のみ)
<<EVENT:product=gummy>> または <<EVENT:product=cream>> … グミかクリームかの選択が確定した
<<EVENT:order=注文番号>> … お客様がAmazon等の注文番号を報告し、注文完了画面のスクリーンショット等から妥当と確認できた(番号のみを記載。例: <<EVENT:order=250-1234567-1234567>>)
<<EVENT:plan=shipping>> または <<EVENT:plan=amazon>> … 提供プランが確定した(送料負担プラン=shipping / Amazonキャッシュバックプラン=amazon)。過去の会話で既に確定しているのに【当選者照合】の進行プランが「未確定」と表示されている場合も記載してよい

これらは社内の進捗記録に使われ、顧客には送信されません。推測では書かず、会話から明確に確定した場合のみ記載してください。`;

// Maxプラン経由。Claude Codeの実行エンジンを子プロセス起動するため数秒のオーバーヘッドがある
async function callViaMax(system, userContent) {
  const agentQuery = await getAgentQuery();
  if (!agentQuery) throw new Error('Agent SDKが利用できません(トークン未設定または読み込み失敗)');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 240000);
  try {
    const env = { ...process.env, CLAUDE_CODE_OAUTH_TOKEN: OAUTH_TOKEN };
    delete env.ANTHROPIC_API_KEY; // 残っているとMaxではなく従量課金キーが優先されてしまう
    async function* input() {
      yield { type: 'user', message: { role: 'user', content: userContent }, parent_tool_use_id: null, session_id: 'linebot' };
    }
    const q = agentQuery({
      prompt: input(),
      options: {
        model: config.claude.model,
        systemPrompt: system,
        customSystemPrompt: system, // 旧版SDKでの同義キー(有効な方が使われる)
        allowedTools: [],
        maxTurns: 3, // 1だと稀にツール呼び出しを試みた時点で打ち切られる(error_max_turns)
        settingSources: [],
        cwd: path.join(__dirname, '../..'),
        env,
        abortController: controller,
      },
    });
    let text = null;
    for await (const msg of q) {
      if (msg.type === 'result') {
        if (msg.subtype === 'success') text = msg.result;
        else throw new Error(`生成が完了しませんでした(${msg.subtype})`);
      }
    }
    if (!text) throw new Error('Agent SDKから結果が返りませんでした');
    return text;
  } finally {
    clearTimeout(timer);
  }
}

// Anthropic API直叩き(従量課金)。Max障害時の保険
async function callViaApi(system, userContent, maxTokens) {
  if (!apiClient) throw new Error('ANTHROPIC_API_KEYが未設定です');
  const response = await apiClient.messages.create({
    model: config.claude.model,
    max_tokens: maxTokens,
    ...(system ? { system } : {}),
    messages: [{ role: 'user', content: userContent }],
  });
  return response.content[0].text;
}

// Max優先で呼び、失敗したらAPI(従量課金)で1回だけ再試行する
async function runClaude({ system, userContent, maxTokens = 2048, label = 'claude' }) {
  if (OAUTH_TOKEN) {
    try {
      const text = await callViaMax(system, userContent);
      logger.info(`[claude:${label}] route=max`);
      return text;
    } catch (err) {
      logger.error(`[claude:${label}] Maxルート失敗: ${err.message}`);
      if (!apiClient) throw err;
      logger.info(`[claude:${label}] API(従量課金)ルートで再試行します`);
    }
  }
  const text = await callViaApi(system, userContent, maxTokens);
  logger.info(`[claude:${label}] route=api`);
  return text;
}

async function generateReply({ userName, messageText, conversationHistory = [], customerData = null, winnerInfo = null, images = [], previousReply = null, feedback = null }) {
  try {
    let contextInfo = '';
    if (customerData) {
      const { user_id, created_at, updated_at, ...shown } = customerData;
      contextInfo += `\n\n【顧客カルテ】\n${JSON.stringify(shown, null, 2)}\n`;
      if (customerData.stage) contextInfo += `\n※この方の現在のステージは「${customerData.stage}」です。ここから自然に次へ進めてください。\n`;
    }
    if (winnerInfo) contextInfo += `\n\n【当選者照合】\n${winnerInfo}\n`;

    // 会話履歴はテキストに畳んで1メッセージで渡す(Max/APIどちらのルートでも同じ挙動にするため)
    let historyText = '';
    if (conversationHistory.length) {
      const lines = conversationHistory.map((m) => (m.role === 'user' ? `お客様: ${m.content}` : `あなた(過去の返信): ${m.content}`));
      historyText = `【これまでの会話履歴(古い順)】\n${lines.join('\n----\n')}\n\n`;
    }

    // 承認者からの修正指示による再生成
    let revisionText = '';
    if (previousReply && feedback) {
      revisionText = `\n\n【直前のあなたの返信案】\n${previousReply}\n\n【運営(承認者)からの修正指示 — これは${userName}様からのメッセージではありません】\n直前の返信案を次の指示に従って書き直し、修正後の返信文のみを出力してください:\n${feedback}`;
    }

    let userContent;
    if (images && images.length) {
      // 画像は全枚数をまとめて渡し、返信は必ず1つだけ作らせる
      // (Amazonキャッシュバックでは検索結果画面とカート画面の2枚が続けて届く)
      const content = images.map((img) => ({
        type: 'image',
        source: { type: 'base64', media_type: img.mediaType, data: img.base64 },
      }));
      const many = images.length > 1;
      content.push({
        type: 'text',
        text: historyText
          + `【${userName}様から画像が${images.length}枚届きました】${messageText ? `\n(同時に届いたメッセージ: ${messageText})` : ''}\n`
          + `${many ? 'これらの画像は一連のものです。**全ての画像を確認したうえで、返信は1通だけ**作成してください。画像ごとに分けて返信しないこと。\n' : ''}`
          + `各画像が何のスクリーンショットかを判断し(Xのプロフィール画面／Amazonの検索結果画面／Amazonのカート画面／レビュー投稿の下書き／商品の到着写真／その他)、フロー上の適切な次の一手を返信案にしてください。\n`
          + `${many ? '例えば「Amazonの検索結果画面」と「カート画面」の2枚が揃っていれば、カート追加まで完了しているので購入手続きの案内に進みます。片方しか無い場合は不足している方を依頼してください。\n' : ''}`
          + `判断に迷う場合や、求めていたものと違う画像の場合は、返信案の冒頭に「[要人間判断]」を付けてください。${contextInfo}${revisionText}`,
      });
      userContent = content;
    } else {
      userContent = `${historyText}【${userName}様からのメッセージ】\n${messageText}${contextInfo}${revisionText}`;
    }

    const raw = await runClaude({
      system: buildSystemPrompt() + STAGE_INSTRUCTION,
      userContent,
      maxTokens: 2048,
      label: 'reply',
    });

    // ステージ申告を抽出し、顧客に送る本文からは取り除く
    const m = raw.match(/<<STAGE:([^>]+)>>/);
    const stage = m ? m[1].trim() : null;
    // 進捗イベント(発送・到着・レビュー完了・予定日・商品選択)を抽出する
    const events = {};
    for (const em of raw.matchAll(/<<EVENT:([^>]+)>>/g)) {
      const [key, value] = em[1].split('=').map((x) => x.trim());
      events[key] = value || true;
    }
    // 社内向けの制御行は顧客に送る本文から必ず取り除く
    // <<REPLY>>ブロック内だけを顧客向け本文とする。ブロック外は承認者向けメモ(送信されない)。
    // これにより、モデルが分析や説明を先に書いても顧客に漏れない(2026-08-19の送信事故対策)
    const rm = raw.match(/<<REPLY>>([\s\S]*?)<<END>>/);
    let body = raw;
    let internalNote = null;
    if (rm) {
      body = rm[1];
      internalNote = raw.replace(rm[0], '').replace(/<<(?:STAGE|EVENT):[^>]*>>/g, '').replace(/\n{3,}/g, '\n\n').trim() || null;
    }
    const reply = body.replace(/<<(?:STAGE|EVENT):[^>]*>>/g, '').replace(/<<(?:REPLY|END)>>/g, '').replace(/\n{3,}/g, '\n\n').trim();
    return { reply, stage, events, internalNote };
  } catch (err) {
    logger.error('Claude API error:', err.message);
    throw err;
  }
}

const EXTRACT_SYSTEM = 'あなたはデータ抽出アシスタントです。指示された形式のJSONのみを出力し、説明文は書きません。';

// スタッフがTelegramに貼った当選者リストを解釈して構造化する
// 書式を覚えてもらう必要がないよう、自由な書き方を許容する
async function parseWinners(text) {
  const prompt = `次のテキストは、SEXTASYのレビュアー企画の当選者リストです。1人ずつ構造化してJSONで返してください。

【抽出ルール】
- x_id: XのユーザーID(@は除く)。半角英数字とアンダースコアのみ
- campaign: 企画名や弾数(例「35弾」「7月グミクリーム選択企画」)。全員共通の記述が先頭行にあればそれを全員に適用する
- offer: 提供内容を次のいずれかに正規化する
    original_2粒 … グミ / オリジナル / ORIGINAL
    cream … クリーム / CREAM
    drop … ドロップ / DROP
    choice … グミかクリームを本人に選ばせる場合(「選択」「どちらか」等)
    free … 送料も無料の完全無料提供
  判断できない場合は unknown
- tier: 「強」「強アカ」「フォロワー◯万」「提携」「アフィ」等の記述があれば strong、なければ normal
- notes: フォロワー数など補足があれば入れる(なければ空文字)

【出力形式】
JSONのみを出力してください。説明文は不要です。
{"winners":[{"x_id":"abc123","campaign":"35弾","offer":"cream","tier":"normal","notes":""}],"warnings":["曖昧だった点があれば日本語で"]}

【入力】
${text}`;
  const raw = await runClaude({ system: EXTRACT_SYSTEM, userContent: prompt, maxTokens: 4096, label: 'parseWinners' });
  const m = raw.match(/\{[\s\S]*\}/);
  if (!m) throw new Error('解析結果を読み取れませんでした');
  return JSON.parse(m[0]);
}

// レビュー完了時にスタッフが自由に書いた補足(例「4200 エロ強 顔出しあり」)を項目に振り分ける
async function parseEvaluationNote(text) {
  const prompt = `次はSNS投稿レビューを確認したスタッフのメモです。該当する項目だけをJSONで返してください。

【項目】
- impressions: インプレッション数。「4200」「1.5万」「12k」等の表記はそのまま文字列で
- genre: エロ強 / エロ弱 / 一般人 / インフルエンサー のいずれか
- face: 顔出しの有無。「顔出しあり」→"あり"、「顔なし」→"なし"
- shadowban: 「シャドバン」「規制されてる」→"シャドバン"、「健全」「なってない」→"健全"
- followers: フォロワー数の記述。「499以下」「1000以上」「万垢」等
- eval_note: 上のどれにも当てはまらない補足(投稿が上手い、写真が良い等)

【出力】
JSONのみ。該当しない項目はキーごと省略。説明文は不要。
例: {"impressions":"4200","genre":"エロ強","face":"あり"}

【入力】
${text}`;
  const raw = await runClaude({ system: EXTRACT_SYSTEM, userContent: prompt, maxTokens: 500, label: 'parseEval' });
  const m = raw.match(/\{[\s\S]*\}/);
  return m ? JSON.parse(m[0]) : {};
}

// 分析ジョブ(週次ダイジェスト等)用の汎用呼び出し。Max優先+API保険はrunClaudeに準ずる
async function runRaw({ system = null, prompt, maxTokens = 1500, label = 'raw' }) {
  return runClaude({ system, userContent: prompt, maxTokens, label });
}

module.exports = { generateReply, parseWinners, parseEvaluationNote, runRaw };
