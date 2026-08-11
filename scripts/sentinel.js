#!/usr/bin/env node
// Sentinel: Telegram駐在の運用エージェント(Stage 1)
// - 承認グループでは観測係: スタッフの発言を運用日誌に記録し、@メンション or /相談 の時だけ応答する
// - DMでは自由に相談できる(承認グループのメンバー+オーナーのみ)
// - 実行できるのは安全操作のみ(LINE Bot本体の /internal/repair 経由)。コード修正等は「司令塔案件」として案内する
// - 頭脳はMaxプラン(runRaw経由)。知識= data/sentinel_knowledge.md(司令塔のメモリを同期)+ ops_journal.md
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const { runRaw } = require('../src/claude/client');

// Telegram通信は全てローカルのHTTP/2プロキシ(127.0.0.1:8081)経由。
// h2直叩きはDPIの気まぐれで不安定なため使わない(Bot本体と同じ実証済み経路に統一)
async function tgCall(_token, method, payload, timeoutMs = 30000) {
  const res = await fetch(`http://127.0.0.1:8081/bot${TOKEN}/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload || {}),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const j = await res.json();
  if (!j.ok) throw new Error('TG API error: ' + JSON.stringify(j).slice(0, 180));
  return j.result;
}

const TOKEN = (process.env.TELEGRAM_SENTINEL_TOKEN || '').trim();
const APPROVAL_CHAT = String(process.env.TELEGRAM_APPROVAL_CHAT_ID || '');
const OWNER = String(process.env.TELEGRAM_OWNER_CHAT_ID || '');
const BOT_USERNAME = 'line_gifting_sentinel_bot';
if (!TOKEN) { console.error('TELEGRAM_SENTINEL_TOKEN not set'); process.exit(1); }

const STATE_FILE = path.join(__dirname, '../data/sentinel_state.json');
const JOURNAL = path.join(__dirname, '../data/ops_journal.md');
const KNOWLEDGE = path.join(__dirname, '../data/sentinel_knowledge.md');
const LEARNED = path.join(__dirname, '../data/sentinel_learned.md');

let state = { offset: 0 };
try { state = JSON.parse(fs.readFileSync(STATE_FILE, 'utf-8')); } catch (e) {}
const histories = new Map();   // chatId -> [{role, content}]
const memberCache = new Map(); // userId -> {ok, at}

const log = (...a) => console.log(new Date().toISOString(), ...a);
function journal(line) {
  try { fs.appendFileSync(JOURNAL, `- [${new Date().toISOString()}] ${line}\n`); } catch (e) {}
}

// DMを許可するのは承認グループのメンバーとオーナーだけ(部外者対策)
async function isAllowed(userId) {
  if (String(userId) === OWNER) return true;
  const c = memberCache.get(userId);
  if (c && Date.now() - c.at < 3600000) return c.ok;
  let ok = false;
  try {
    const m = await tgCall(TOKEN, 'getChatMember', { chat_id: APPROVAL_CHAT, user_id: userId });
    ok = ['creator', 'administrator', 'member'].includes(m.status);
  } catch (e) {}
  memberCache.set(userId, { ok, at: Date.now() });
  return ok;
}

// 会話のたびに実データを注入する(嘘の状態報告を防ぐ)
function statusSnapshot() {
  const out = [];
  try {
    const db = new Database(path.join(__dirname, '../data/customers.db'), { readonly: true });
    const p = db.prepare("select count(*) c from approvals where status='pending'").get().c;
    const t = db.prepare("select sum(case when direction='incoming' then 1 else 0 end) i, sum(case when direction='outgoing' then 1 else 0 end) o from conversations where timestamp >= datetime('now','-1 day')").get();
    const w = db.prepare("select count(*) c from winners where status not in ('done','cancelled')").get().c;
    const recent = db.prepare("select substr(user_id,-6) u, direction d, replace(substr(content,1,60),char(10),' ') t, timestamp ts from conversations order by id desc limit 8").all().reverse();
    out.push(`承認待ちカード: ${p}件 / 直近24h: 受信${t.i || 0}件・送信${t.o || 0}件 / アクティブ当選者: ${w}人`);
    out.push('直近のLINEやり取り(新しい順逆):');
    for (const r of recent) out.push(`  [${r.u}] ${r.d === 'incoming' ? '客' : 'Bot'} ${r.ts}「${r.t}」`);
    db.close();
  } catch (e) { out.push('DB読取エラー: ' + e.message); }
  try {
    const f = path.join(__dirname, '../data/logs/app-' + new Date().toISOString().slice(0, 10) + '.log');
    const lines = fs.readFileSync(f, 'utf-8').trim().split('\n');
    const errs = lines.filter((l) => l.includes('[ERROR]'));
    out.push(`本日のログ: ${lines.length}行 / エラー${errs.length}件`);
    if (errs.length) out.push('直近のエラー:\n' + errs.slice(-4).join('\n'));
  } catch (e) { out.push('(本日のログファイルなし)'); }
  try {
    const j = fs.readFileSync(JOURNAL, 'utf-8').trim().split('\n');
    out.push('運用日誌(直近):\n' + j.slice(-10).join('\n'));
  } catch (e) {}
  return out.join('\n');
}

function buildSystem() {
  let knowledge = '';
  try { knowledge = fs.readFileSync(KNOWLEDGE, 'utf-8').slice(0, 30000); } catch (e) {}
  let learned = '';
  try { learned = fs.readFileSync(LEARNED, 'utf-8').trim(); } catch (e) {}
  return `あなたは「Sentinel」— SEXTASYのLINE自動化システムのTelegram駐在エンジニアです。承認チームのスタッフと大塚さん(オーナー)の相談相手として、状態把握・トラブルの一次対応・軽い修復を担当します。

【文体】簡潔で頼れる技術者。丁寧だが堅すぎない日本語。結論から先に。絵文字は最小限。長文を避け、要点だけ。

【できること — 必要と判断した場合のみ、返答本文の最後に該当行を付ける(1つまで)】
<<ACTION:check>> … 整合性チェック(消えたカードの再発行+未応答の生成やり直し+全体点検)
<<ACTION:reissue>> … 承認カードの再発行のみ
<<ACTION:regen:ID下6桁>> … 特定のお客様への返信を作り直す(状態情報の顧客ID下6桁で特定できた場合のみ)
<<ACTION:restart>> … LINE Botの再起動(確認ボタンが出て、人間がタップしたときだけ実行される)
<<ACTION:t2:依頼内容の要約>> … コードの修正・機能追加・動作変更の依頼を受けたとき。この行を出すと隔離環境で修正案の作成が始まる(本番のコードには触れない)。適用は必ずオーナーの✅承認が必要。返答本文には「修正案を作成します。数分後にオーナーのDMへ承認依頼が届きます」という趣旨を書く

【できないこと】LINEへの直接送信・顧客データやDB・.envの書き換え・npmパッケージの追加。コードの修正や機能追加は t2 アクションで「修正案の作成→オーナー承認→適用」の形なら可能。t2でも扱えない大きな設計変更は「司令塔案件」として大塚さんのClaude(司令塔)に貼れる依頼文を整形して返す。

【鉄則】わからないことは正直に「わからない」と言う。憶測で断定しない。状態は下の【現在のシステム状態】の実データに基づいて答える。危険と感じたら何も実行せず人間に委ねる。

【運用知識(司令塔から同期)】
${knowledge}
${learned ? '\n【Sentinelが運用で学んだこと】\n' + learned : ''}`;
}

async function converse(chatId, name, text) {
  const h = histories.get(chatId) || [];
  h.push({ role: 'user', content: `${name}: ${text}` });
  while (h.length > 24) h.shift();
  const prompt = `【現在のシステム状態(たった今の実データ)】\n${statusSnapshot()}\n\n【会話】\n${h.map((m) => (m.role === 'user' ? m.content : `Sentinel: ${m.content}`)).join('\n----\n')}\n\n最後の発言にSentinelとして返答してください。返答本文のみを出力します(「Sentinel:」の接頭辞は不要)。`;
  let reply;
  try {
    reply = await runRaw({ system: buildSystem(), prompt, maxTokens: 1200, label: 'sentinel' });
  } catch (e) {
    reply = '⚠️ 頭脳(Claude)への接続に失敗しました: ' + e.message;
  }
  const actions = [...reply.matchAll(/<<ACTION:([^>]+)>>/g)].map((m) => m[1]);
  const clean = reply.replace(/<<ACTION:[^>]*>>/g, '').replace(/\n{3,}/g, '\n\n').trim();
  h.push({ role: 'assistant', content: clean });
  histories.set(chatId, h);
  if (clean) await tgCall(TOKEN, 'sendMessage', { chat_id: chatId, text: clean });

  for (const a of actions.slice(0, 1)) {
    const verb = a.split(':')[0].trim();
    const arg = a.indexOf(':') >= 0 ? a.slice(a.indexOf(':') + 1).trim() : '';
    journal(`Sentinel実行: ${a}(依頼: ${name})`);
    if (verb === 't2') {
      startT2Draft(arg || text, chatId, name).catch((e) => log('t2 start error', e.message));
      continue;
    }
    if (verb === 'restart') {
      await tgCall(TOKEN, 'sendMessage', {
        chat_id: chatId,
        text: 'LINE Botを再起動しますか?',
        reply_markup: { inline_keyboard: [[{ text: '🔄 再起動する(安全・約20秒)', callback_data: 'sn:restart' }]] },
      });
    } else if (['check', 'reissue', 'regen'].includes(verb)) {
      try {
        const res = await fetch('http://localhost:3000/internal/repair', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ action: verb, tail: arg || null }),
        });
        const j = await res.json();
        await tgCall(TOKEN, 'sendMessage', { chat_id: chatId, text: j.ok ? `✅ 実行しました — ${j.note || verb}` : `⚠️ 実行できませんでした: ${j.error || '不明'}` });
        journal(`実行結果: ${JSON.stringify(j)}`);
      } catch (e) {
        await tgCall(TOKEN, 'sendMessage', { chat_id: chatId, text: '⚠️ LINE Bot本体に接続できません(停止している可能性)。再起動が必要かもしれません。' });
      }
    }
  }
}

// ── Tier 2: コード修正の起草→オーナー承認→適用 ─────────────
// 起草は隔離worktreeで行い(t2_draft.js)、適用はオーナーの✅後に独立プロセス(t2_apply.sh)が行う。
let t2Busy = false;
async function startT2Draft(request, chatId, requester) {
  if (t2Busy) {
    await tgCall(TOKEN, 'sendMessage', { chat_id: chatId, text: '⏳ 別の修正案を作成中です。完了してからもう一度依頼してください。' });
    return;
  }
  t2Busy = true;
  journal(`Tier2起草開始: ${request}(依頼: ${requester})`);
  const { execFile } = require('child_process');
  execFile(process.execPath, [path.join(__dirname, 't2_draft.js'), request],
    { cwd: path.join(__dirname, '..'), timeout: 15 * 60000, maxBuffer: 10 * 1024 * 1024 },
    async (err, stdout) => {
      t2Busy = false;
      let res = null;
      try {
        const lines = String(stdout || '').trim().split('\n');
        res = JSON.parse(lines[lines.length - 1]);
      } catch (e) {}
      if (!res) res = { ok: false, error: (err && err.message) || '起草プロセスの出力を解釈できませんでした' };
      try {
        if (!res.ok) {
          journal(`Tier2起草失敗: ${res.error || ''}`);
          await tgCall(TOKEN, 'sendMessage', { chat_id: chatId, text: `⚠️ 修正案を作成できませんでした: ${res.error || '不明'}${res.summary ? '\n\n' + res.summary : ''}` });
          return;
        }
        journal(`Tier2起草完了: ${res.branch} files=${(res.files || []).join(',')}`);
        await tgCall(TOKEN, 'sendMessage', {
          chat_id: OWNER,
          text: `🛠 Tier2適用の承認依頼\n\n依頼: ${request}\n依頼者: ${requester}\n変更ファイル:\n${(res.files || []).map((f) => '・' + f).join('\n')}\n\n要約:\n${res.summary || '(なし)'}`,
          reply_markup: { inline_keyboard: [[
            { text: '✅ 適用する', callback_data: `t2:apply:${res.branch}` },
            { text: '❌ 破棄する', callback_data: `t2:discard:${res.branch}` },
          ]] },
        });
        await new Promise((resolve) => {
          execFile('/usr/bin/curl', ['-s', '-m', '60', '-F', `chat_id=${OWNER}`, '-F', `document=@${res.diffFile}`, '-F', 'caption=変更差分(patch)', `http://127.0.0.1:8081/bot${TOKEN}/sendDocument`], () => resolve());
        });
        if (String(chatId) !== String(OWNER)) {
          await tgCall(TOKEN, 'sendMessage', { chat_id: chatId, text: '📨 修正案ができました。オーナーのDMに承認依頼を送りました。' });
        }
      } catch (e) { log('t2 packet error', e.message); }
    });
}

async function handleUpdate(u) {
  if (u.callback_query) {
    const q = u.callback_query;
    if (q.data && q.data.startsWith('t2:')) {
      const parts = q.data.split(':');
      const act = parts[1];
      const branch = parts.slice(2).join(':');
      if (String(q.from.id) !== String(OWNER)) {
        await tgCall(TOKEN, 'answerCallbackQuery', { callback_query_id: q.id, text: 'オーナーのみ承認できます' });
        return;
      }
      if (act === 'apply') {
        await tgCall(TOKEN, 'answerCallbackQuery', { callback_query_id: q.id, text: '適用を開始します' });
        await tgCall(TOKEN, 'sendMessage', { chat_id: OWNER, text: `🔧 適用を開始しました(${branch})。結果はこのDMに届きます。` });
        journal(`Tier2適用承認: ${branch}`);
        const { spawn } = require('child_process');
        spawn('/bin/sh', [path.join(__dirname, 't2_apply.sh'), branch], { detached: true, stdio: 'ignore' }).unref();
      } else if (act === 'discard') {
        await tgCall(TOKEN, 'answerCallbackQuery', { callback_query_id: q.id, text: '破棄しました' });
        journal(`Tier2破棄: ${branch}`);
        try {
          const { execSync } = require('child_process');
          execSync(`git worktree remove --force /Users/akiramacmini/projects/t2work 2>/dev/null; git branch -D "${branch}" 2>/dev/null || true`, { cwd: path.join(__dirname, '..'), shell: '/bin/sh' });
        } catch (e) {}
        await tgCall(TOKEN, 'sendMessage', { chat_id: OWNER, text: `🗑 修正案(${branch})を破棄しました。` });
      }
      return;
    }
    if (q.data === 'sn:restart') {
      if (!(await isAllowed(q.from.id))) { await tgCall(TOKEN, 'answerCallbackQuery', { callback_query_id: q.id, text: '権限がありません' }); return; }
      await tgCall(TOKEN, 'answerCallbackQuery', { callback_query_id: q.id, text: '再起動します' });
      const who = q.from.first_name || q.from.username || 'スタッフ';
      await tgCall(TOKEN, 'sendMessage', { chat_id: q.message.chat.id, text: `🔄 ${who}さんの操作でLINE Botを再起動します。約20秒後に自動で戻り、未処理カードは再発行されます。` });
      journal(`Bot再起動(Sentinel経由、操作: ${who})`);
      const { spawn } = require('child_process');
      spawn('/bin/sh', ['-c', 'sleep 1; launchctl kickstart -k gui/501/com.user.line.bot'], { detached: true, stdio: 'ignore' }).unref();
    }
    return;
  }
  const msg = u.message;
  if (!msg) return;
  const chatId = msg.chat.id;
  const from = msg.from || {};
  const name = from.first_name || from.username || String(from.id || '不明');
  const text = (msg.text || '').trim();

  if (String(chatId) === APPROVAL_CHAT) {
    // 観測係: 人間の発言を日誌に記録(文脈用)。応答は呼ばれた時だけ
    if (text) journal(`[承認G] ${name}: ${text.slice(0, 200)}`);
    else if (msg.photo) journal(`[承認G] ${name}: (画像)`);
    if (!text) return;
    const re = new RegExp('@' + BOT_USERNAME, 'i');
    const mentioned = re.test(text) || /^\/相談/.test(text);
    if (!mentioned) return;
    const cleanText = text.replace(new RegExp('@' + BOT_USERNAME, 'ig'), '').replace(/^\/相談\s*/, '').trim() || '(呼びかけ)';
    await converse(chatId, name, cleanText);
    return;
  }

  if (msg.chat.type === 'private') {
    if (!(await isAllowed(from.id))) {
      await tgCall(TOKEN, 'sendMessage', { chat_id: chatId, text: 'このBotはSEXTASY運用チーム専用です。' });
      return;
    }
    if (!text) return;
    journal(`[DM] ${name}: ${text.slice(0, 200)}`);
    if (/^\/start/.test(text)) {
      await tgCall(TOKEN, 'sendMessage', { chat_id: chatId, text: 'Sentinelです。システムの状態確認やトラブットの相談はここでどうぞ。\n例:「今の状態教えて」「カードが来てないみたい」「昨日エラーあった?」' });
      return;
    }
    await converse(chatId, name, text);
  }
}

(async () => {
  log('Sentinel starting');
  try { const me = await tgCall(TOKEN, 'getMe', {}); log('getMe OK @' + me.username); } catch (e) { log('getMe failed:', e.message); }
  journal('Sentinel起動');
  while (true) {
    try {
      const updates = await tgCall(TOKEN, 'getUpdates', { offset: state.offset + 1, timeout: 15, allowed_updates: ['message', 'callback_query'] }, 30000);
      for (const u of updates || []) {
        state.offset = Math.max(state.offset, u.update_id);
        try { await handleUpdate(u); } catch (e) { log('handleUpdate error:', e.message); }
      }
      try { fs.writeFileSync(STATE_FILE, JSON.stringify(state)); } catch (e) {}
    } catch (e) {
      log('poll error:', e.message);
      await new Promise((r) => setTimeout(r, 5000));
    }
  }
})();
