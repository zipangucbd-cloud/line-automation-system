#!/usr/bin/env node
// Telegram APIへのローカルHTTP/2プロキシ。
// この回線はTelegram宛のHTTP/1.1系TLS(ALPN=http/1.1のClientHello)をDPIで遮断するため(2026-08-09判明)、
// Bot(node-telegram-bot-api)は本プロキシ(127.0.0.1:8081)にHTTP/1.1で話し、ここからapi.telegram.orgへHTTP/2で中継する。
// 有効化: .env に TG_API_BASE=http://127.0.0.1:8081 / launchd: com.user.line.tgproxy
const http = require('http');
const http2 = require('http2');
const PORT = 8081;

let session = null;
function getSession() {
  if (session && !session.closed && !session.destroyed) return session;
  session = http2.connect('https://api.telegram.org');
  session.on('error', () => { session = null; });
  session.on('close', () => { session = null; });
  return session;
}

const server = http.createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const body = Buffer.concat(chunks);
    // セッション確立直後の瞬断に備え、失敗したら新しいセッションで1回だけやり直す
    const forward = (attempt) => {
      let s;
      try {
        s = getSession();
      } catch (e) {
        res.writeHead(502); res.end('proxy connect error: ' + e.message); return;
      }
      const headers = { ':method': req.method, ':path': req.url };
      if (req.headers['content-type']) headers['content-type'] = req.headers['content-type'];
      if (body.length) headers['content-length'] = body.length;
      const p = s.request(headers);
      // getUpdatesのロングポーリング(30s)を跨げるよう余裕を持たせる
      p.setTimeout(120000, () => { try { p.close(); } catch (_) {} });
      p.on('response', (h) => {
        const status = h[':status'] || 502;
        const out = {};
        for (const [k, v] of Object.entries(h)) {
          if (!k.startsWith(':') && k !== 'content-length') out[k] = v;
        }
        res.writeHead(status, out);
        p.pipe(res);
      });
      p.on('error', (e) => {
        session = null;
        if (attempt < 4 && !res.headersSent) { setTimeout(() => forward(attempt + 1), attempt * 1000); return; }
        if (!res.headersSent) res.writeHead(502);
        res.end('proxy error: ' + e.message);
      });
      if (body.length) p.end(body); else p.end();
    };
    forward(1);
  });
});

server.listen(PORT, '127.0.0.1', () => console.log(new Date().toISOString(), 'tg h2 proxy on 127.0.0.1:' + PORT));
