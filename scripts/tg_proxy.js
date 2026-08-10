#!/usr/bin/env node
// Telegram APIへのローカル中継プロキシ(curlトランスポート版)。
// この回線のDPIはTelegram宛のTLSを「ClientHelloの指紋」で選別遮断しており、
// nodeからのTLS(fetch/request/http2、cipher偽装も含む)は全て落とされるが、
// macOSのcurlの指紋は素通りする(2026-08-10確認)。
// そのためBot(node-telegram-bot-api)は本プロキシ(127.0.0.1:8081)にHTTP/1.1で話し、
// ここから1リクエスト=1curlでapi.telegram.orgへ中継する。
// 有効化: .env に TG_API_BASE=http://127.0.0.1:8081 / launchd: com.user.line.tgproxy
const http = require('http');
const { execFile } = require('child_process');
const PORT = 8081;
const MAX_BUF = 64 * 1024 * 1024; // 画像ダウンロード(getFile)も通るように余裕を持つ

function viaCurl(method, path, contentType, body, cb) {
  const args = [
    '-s', '--http2', '-m', '110',
    '-X', method,
    '-w', '%{stderr}%{http_code}',
    'https://api.telegram.org' + path,
  ];
  if (contentType) args.push('-H', 'Content-Type: ' + contentType);
  if (body && body.length) args.push('--data-binary', '@-');
  const child = execFile('/usr/bin/curl', args, { encoding: 'buffer', maxBuffer: MAX_BUF }, (err, stdout, stderr) => {
    // -w で最後にステータスコードだけをstderrへ出している(本文はstdoutに分離)
    const m = String(stderr).match(/(\d{3})\s*$/);
    const status = m ? Number(m[1]) : 0;
    if (err || !status) return cb(err || new Error('curl failed: ' + String(stderr).slice(0, 120)));
    cb(null, status, stdout);
  });
  if (body && body.length) child.stdin.end(body); else child.stdin.end();
}

const server = http.createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const body = Buffer.concat(chunks);
    const attempt = (n) => {
      viaCurl(req.method, req.url, req.headers['content-type'], body, (err, status, out) => {
        if (err) {
          if (n < 3) return setTimeout(() => attempt(n + 1), n * 1000);
          res.writeHead(502, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error_code: 502, description: 'proxy: ' + err.message.slice(0, 150) }));
          return;
        }
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(out);
      });
    };
    attempt(1);
  });
});

server.listen(PORT, '127.0.0.1', () => console.log(new Date().toISOString(), 'tg curl-proxy on 127.0.0.1:' + PORT));
