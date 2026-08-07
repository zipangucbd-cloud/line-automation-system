// Maxプラン(CLAUDE_CODE_OAUTH_TOKEN)でAgent SDKが動くかの疎通テスト
import { query } from '@anthropic-ai/claude-agent-sdk';
import fs from 'fs';

const env = { ...process.env };
for (const line of fs.readFileSync('.env', 'utf-8').split('\n')) {
  const m = line.match(/^([A-Z_0-9]+)=(.*)$/);
  if (m) env[m[1]] = m[2].trim();
}
delete env.ANTHROPIC_API_KEY; // 従量課金キーを外し、OAuthトークンだけで認証させる

if (!env.CLAUDE_CODE_OAUTH_TOKEN) {
  console.log(JSON.stringify({ ok: false, err: 'token not in .env' }));
  process.exit(1);
}

const q = query({
  prompt: '1+1の答えを数字1文字だけで返してください',
  options: {
    model: env.CLAUDE_MODEL || 'claude-sonnet-4-5-20250929',
    allowedTools: [],
    maxTurns: 1,
    settingSources: [],
    env,
  },
});

let done = false;
for await (const m of q) {
  if (m.type === 'result') {
    done = true;
    console.log(JSON.stringify({
      ok: m.subtype === 'success',
      subtype: m.subtype,
      result: m.result ?? null,
      cost_usd: m.total_cost_usd ?? null,
    }));
  }
}
if (!done) { console.log(JSON.stringify({ ok: false, err: 'no result message' })); process.exit(1); }
