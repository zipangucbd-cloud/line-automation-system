// Telegram送信用のHTTP/2クライアント。
// このオフィス回線はTelegram宛のHTTP/1.1系TLS(node fetch / requestライブラリ)をDPIで遮断する
// (2026-08-09判明: ALPN=http/1.1のClientHelloはタイムアウト、ALPN=h2は素通り。curlが通るのも同じ理由)。
// そのためnode標準のhttp2モジュールで送る。
const http2 = require('http2');

function tgCall(token, method, payload, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const client = http2.connect('https://api.telegram.org');
    let settled = false;
    const bail = (e) => {
      if (settled) return;
      settled = true;
      try { client.close(); } catch (_) {}
      reject(e);
    };
    client.setTimeout(timeoutMs, () => bail(new Error('h2接続タイムアウト')));
    client.on('error', bail);
    const body = JSON.stringify(payload || {});
    const req = client.request({
      ':method': 'POST',
      ':path': `/bot${token}/${method}`,
      'content-type': 'application/json',
      'content-length': Buffer.byteLength(body),
    });
    let data = '';
    req.setEncoding('utf8');
    req.setTimeout(timeoutMs, () => bail(new Error('h2リクエストタイムアウト')));
    req.on('data', (c) => { data += c; });
    req.on('end', () => {
      if (settled) return;
      settled = true;
      client.close();
      try {
        const j = JSON.parse(data);
        if (j.ok) resolve(j.result);
        else reject(new Error(`Telegram APIエラー: ${data}`));
      } catch (e) {
        reject(new Error(`Telegram応答の解析失敗: ${String(data).slice(0, 200)}`));
      }
    });
    req.on('error', bail);
    req.end(body);
  });
}

// 瞬断にも耐えるようリトライつき
async function tgCallRetry(token, method, payload, tries = 3) {
  let last;
  for (let i = 1; i <= tries; i++) {
    try {
      return await tgCall(token, method, payload);
    } catch (e) {
      last = e;
      if (i < tries) await new Promise((r) => setTimeout(r, i * 5000));
    }
  }
  throw last;
}

module.exports = { tgCall, tgCallRetry };
