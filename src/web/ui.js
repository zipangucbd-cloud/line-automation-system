// 承認画面(LINE風UI): スタッフが公式LINEを開かずに文脈確認→承認まで完結するための画面。
// 既存のTelegram承認と同じ状態(pendingApprovals)を共有するので、どちらで処理しても整合する。
// 認証はPIN+署名クッキー。PIN未設定(APPROVAL_UI_PIN)のときは画面ごと無効になる。
const crypto = require('crypto');
const logger = require('../utils/logger');

const PIN = (process.env.APPROVAL_UI_PIN || '').trim();
const SECRET = (process.env.LINE_CHANNEL_SECRET || 'fallback') + '|ui';
const COOKIE = 'sxapp';
const DAY = 86400000;

function sign(exp) {
  return exp + '.' + crypto.createHmac('sha256', SECRET).update(String(exp)).digest('hex').slice(0, 32);
}
function valid(token) {
  if (!token) return false;
  const [exp, sig] = String(token).split('.');
  if (!exp || !sig || Number(exp) < Date.now()) return false;
  const expected = sign(Number(exp));
  return crypto.timingSafeEqual(Buffer.from(token), Buffer.from(expected));
}
function authed(req) {
  const raw = req.headers.cookie || '';
  const m = raw.match(new RegExp(COOKIE + '=([^;]+)'));
  try { return m ? valid(decodeURIComponent(m[1])) : false; } catch (e) { return false; }
}
const esc = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// 「2026-08-19 12:31:05」→「8/19 12:31」。DBはUTC保存なのでJSTに直す
function jst(ts) {
  if (!ts) return '';
  const d = new Date(String(ts).replace(' ', 'T') + 'Z');
  if (isNaN(d)) return String(ts).slice(5, 16);
  const j = new Date(d.getTime() + 9 * 3600000);
  return `${j.getUTCMonth() + 1}/${j.getUTCDate()} ${String(j.getUTCHours()).padStart(2, '0')}:${String(j.getUTCMinutes()).padStart(2, '0')}`;
}

const CSS = `
:root{--bg:#8CABD8;--card:#fff;--me:#8DE055;--ink:#111;--sub:#6b7280;--line:#e5e7eb;--accent:#06C755}
*{box-sizing:border-box;-webkit-tap-highlight-color:transparent}
body{margin:0;font-family:-apple-system,BlinkMacSystemFont,"Hiragino Sans","Noto Sans JP",sans-serif;background:#f3f4f6;color:var(--ink)}
header{position:sticky;top:0;z-index:10;background:#fff;border-bottom:1px solid var(--line);padding:10px 14px;display:flex;align-items:center;gap:10px}
header .t{font-weight:700;font-size:15px;flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
header a{color:var(--sub);text-decoration:none;font-size:22px;line-height:1}
.sub{font-size:11px;color:var(--sub);font-weight:400}
.list{padding:8px}
.row{display:block;background:#fff;border:1px solid var(--line);border-radius:12px;padding:12px 14px;margin-bottom:8px;text-decoration:none;color:inherit}
.row.p{border-color:var(--accent);border-width:2px;background:#f0fff6}
.row .n{font-weight:700;font-size:14px;display:flex;align-items:center;gap:6px}
.row .m{font-size:12px;color:var(--sub);margin-top:4px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.badge{background:var(--accent);color:#fff;font-size:10px;padding:2px 7px;border-radius:10px;font-weight:700}
.badge.g{background:#6b7280}
.chat{background:var(--bg);padding:12px 10px 20px;min-height:60vh}
.prov{background:#fffbe6;border:1px solid #fde68a;border-radius:10px;padding:8px 10px;font-size:11px;line-height:1.6;margin-bottom:10px;white-space:pre-wrap}
.msg{display:flex;margin-bottom:10px;align-items:flex-end;gap:6px}
.msg.out{flex-direction:row-reverse}
.bub{max-width:76%;padding:9px 12px;border-radius:16px;font-size:14px;line-height:1.55;white-space:pre-wrap;word-break:break-word;background:var(--card)}
.msg.out .bub{background:var(--me)}
.tm{font-size:10px;color:#4b5563;margin-bottom:2px;white-space:nowrap}
.pend{background:#fff;border-top:3px solid var(--accent);padding:14px;position:sticky;bottom:0;box-shadow:0 -4px 18px rgba(0,0,0,.12)}
.pend h3{margin:0 0 8px;font-size:12px;color:var(--accent)}
.draft{background:#f9fafb;border:1px dashed #9ca3af;border-radius:12px;padding:12px;font-size:14px;line-height:1.6;white-space:pre-wrap;max-height:38vh;overflow:auto}
.note{margin-top:8px;background:#eef2ff;border-radius:8px;padding:8px 10px;font-size:11px;color:#3730a3;white-space:pre-wrap}
.btns{display:flex;gap:8px;margin-top:10px}
button{flex:1;padding:14px 8px;border:0;border-radius:12px;font-size:15px;font-weight:700;color:#fff;background:var(--accent)}
button.s{background:#3b82f6}button.d{background:#9ca3af}button:disabled{opacity:.5}
textarea{width:100%;border:1px solid var(--line);border-radius:10px;padding:10px;font-size:14px;font-family:inherit;margin-top:8px}
.empty{padding:40px 20px;text-align:center;color:var(--sub);font-size:13px}
.login{max-width:320px;margin:80px auto;background:#fff;padding:24px;border-radius:16px;text-align:center}
.login input{width:100%;padding:14px;font-size:20px;text-align:center;border:1px solid var(--line);border-radius:10px;letter-spacing:6px}
.login button{margin-top:12px}
.ok{position:fixed;left:50%;transform:translateX(-50%);bottom:100px;background:#111;color:#fff;padding:10px 18px;border-radius:20px;font-size:13px;opacity:0;transition:.2s;z-index:50}
.ok.on{opacity:.92}
`;

const page = (title, body, extra = '') => `<!doctype html><html lang="ja"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="apple-mobile-web-app-capable" content="yes"><title>${esc(title)}</title>
<style>${CSS}</style></head><body>${body}<div class="ok" id="ok"></div>${extra}</body></html>`;

function setup(app, approvalFlow) {
  if (!PIN) { logger.info('承認画面: APPROVAL_UI_PIN 未設定のため無効'); return; }
  const ui = approvalFlow.ui;

  app.get('/ui/login', (req, res) => res.type('html').send(page('承認画面', `
    <form class="login" method="post" action="/ui/login">
      <div style="font-weight:700;margin-bottom:6px">SEXTASY 承認画面</div>
      <div class="sub" style="margin-bottom:14px">暗証番号を入力してください</div>
      <input name="pin" type="password" inputmode="numeric" autocomplete="current-password" autofocus>
      <button type="submit">開く</button>
    </form>`)));

  const attempts = new Map();
  app.post('/ui/login', express_urlencoded, (req, res) => {
    const ip = req.ip || 'x';
    const a = attempts.get(ip) || { n: 0, at: Date.now() };
    if (Date.now() - a.at > 600000) { a.n = 0; a.at = Date.now(); }
    if (a.n >= 8) return res.status(429).type('html').send(page('', '<div class="empty">試行回数が多すぎます。10分後にお試しください。</div>'));
    if (String((req.body && req.body.pin) || '') !== PIN) {
      a.n++; attempts.set(ip, a);
      return res.type('html').send(page('', '<div class="empty">暗証番号が違います<br><br><a href="/ui/login">戻る</a></div>'));
    }
    attempts.delete(ip);
    const token = sign(Date.now() + 30 * DAY);
    res.setHeader('Set-Cookie', `${COOKIE}=${encodeURIComponent(token)}; Path=/ui; Max-Age=${30 * 24 * 3600}; HttpOnly; Secure; SameSite=Lax`);
    res.redirect('/ui');
  });

  const guard = (req, res, next) => (authed(req) ? next() : res.redirect('/ui/login'));
  const guardApi = (req, res, next) => (authed(req) ? next() : res.status(401).json({ ok: false, error: '再ログインしてください' }));

  // 一覧: 対応待ちが上、それ以外は新しい順
  app.get('/ui', guard, (req, res) => {
    const rows = ui.inbox();
    const n = rows.filter((r) => r.pending).length;
    const body = `<header><div class="t">承認待ち ${n}件<div class="sub">タップで会話を開く</div></div><a href="/ui" title="更新">↻</a></header>
    <div class="list">${rows.length ? rows.map((r) => `<a class="row ${r.pending ? 'p' : ''}" href="/ui/t/${encodeURIComponent(r.userId)}">
      <div class="n">${esc(r.name)}${r.pending ? `<span class="badge">${r.kind === 'followup' ? '提案' : '要対応'}</span>` : ''}${r.stage ? `<span class="badge g">${esc(r.stage)}</span>` : ''}</div>
      <div class="m">${r.lastDir === 'incoming' ? '' : '↩ '}${esc(r.lastText)}${r.lastAt ? ` ・ ${jst(r.lastAt)}` : ''}</div></a>`).join('') : '<div class="empty">まだ会話がありません</div>'}</div>`;
    res.type('html').send(page('承認画面', body, '<script>setTimeout(()=>location.reload(),20000)</script>'));
  });

  // 会話画面: LINEと同じ見え方で全履歴+送信待ちの返信案
  app.get('/ui/t/:userId', guard, (req, res) => {
    const t = ui.thread(req.params.userId);
    const msgs = t.msgs.map((m) => `<div class="msg ${m.dir === 'incoming' ? 'in' : 'out'}"><div class="bub">${esc(m.text)}</div><div class="tm">${jst(m.at)}</div></div>`).join('');
    const pend = t.pending ? `<div class="pend" id="pend" data-id="${esc(t.pending.id)}">
      <h3>📝 送信待ちの返信案(まだ送っていません)</h3>
      <div class="draft" id="draft">${esc(t.pending.reply)}</div>
      ${t.pending.internalNote ? `<div class="note">🗒 Botメモ(送信されません): ${esc(t.pending.internalNote)}</div>` : ''}
      <div class="btns"><button id="ok-btn" onclick="act('approve')">✅ 承認して送信</button><button class="s" onclick="toggle()">✏️ 修正</button><button class="d" onclick="act('reject')">❌ 却下</button></div>
      <div id="fb" style="display:none"><textarea id="fbt" rows="2" placeholder="例: もっと短く / URLはこれ https://… / 選択させずクリームで確定"></textarea>
      <div class="btns"><button class="s" onclick="act('revise')">この指示で作り直す</button></div></div>
    </div>` : '<div class="pend"><div class="sub" style="text-align:center">送信待ちの返信案はありません(すべて対応済み)</div></div>';
    const body = `<header><a href="/ui">‹</a><div class="t">${esc(t.name)}<div class="sub">${esc(t.stage || '')}</div></div></header>
    <div class="chat">${t.prov ? `<div class="prov">${esc(t.prov)}</div>` : ''}${msgs || '<div class="empty">履歴なし</div>'}</div>${pend}`;
    const js = `<script>
      const ok=document.getElementById('ok');
      function toast(t){ok.textContent=t;ok.classList.add('on');setTimeout(()=>ok.classList.remove('on'),2200)}
      function toggle(){const f=document.getElementById('fb');f.style.display=f.style.display==='none'?'block':'none';if(f.style.display==='block')document.getElementById('fbt').focus()}
      let busy=false;
      async function act(action){
        if(busy)return; const p=document.getElementById('pend'); if(!p)return;
        let text='';
        if(action==='revise'){text=document.getElementById('fbt').value.trim();if(!text){toast('修正指示を入力してください');return}}
        if(action==='reject'){text=prompt('却下の理由(任意・改善に使います)')||''}
        if(action==='approve'&&!confirm('この文をお客様に送信します。よろしいですか?'))return;
        busy=true;document.querySelectorAll('button').forEach(b=>b.disabled=true);
        toast(action==='revise'?'作り直しています…(30秒ほど)':'処理中…');
        try{
          const r=await fetch('/ui/api/act',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({action,id:p.dataset.id,text})}).then(x=>x.json());
          if(r.ok){toast(action==='approve'?'✅ 送信しました':action==='revise'?'🔄 作り直しました':'❌ 却下しました');setTimeout(()=>location.reload(),700)}
          else{toast('⚠️ '+(r.error||'失敗しました'));busy=false;document.querySelectorAll('button').forEach(b=>b.disabled=false)}
        }catch(e){toast('⚠️ 通信に失敗しました');busy=false;document.querySelectorAll('button').forEach(b=>b.disabled=false)}
      }
      setInterval(()=>{if(!busy&&document.getElementById('fb')&&document.getElementById('fb').style.display==='none')location.reload()},30000);
      window.scrollTo(0,document.body.scrollHeight);
    </script>`;
    res.type('html').send(page(t.name, body, js));
  });

  app.post('/ui/api/act', guardApi, express_json, async (req, res) => {
    const { action, id, text } = req.body || {};
    const who = 'スタッフ';
    try {
      if (action === 'approve') return res.json(await ui.approve(id, who));
      if (action === 'reject') return res.json(await ui.reject(id, who, text));
      if (action === 'revise') return res.json(await ui.revise(id, text, who));
      return res.json({ ok: false, error: '不明な操作です' });
    } catch (e) {
      logger.error('UI act failed:', e.message);
      return res.json({ ok: false, error: e.message });
    }
  });

  logger.info('承認画面: /ui で有効');
}

// express本体はindex.js側から渡されるものを使う(依存の二重読み込みを避ける)
let express_json = (req, res, next) => next();
let express_urlencoded = (req, res, next) => next();
function useParsers(json, urlencoded) { express_json = json; express_urlencoded = urlencoded; }

module.exports = { setup, useParsers };
