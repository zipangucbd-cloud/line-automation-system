#!/usr/bin/env node
// Tier 2起草: 依頼文を受け取り、隔離されたgit worktree上でコーディングエージェント(Max枠)に
// 修正案を作らせる。mainには一切触れない。エージェントに与えるのはファイルの読み書きだけで、
// シェル実行権限は与えない。構文チェックと差分抽出はこのラッパー側で行う。
// 使い方: node scripts/t2_draft.js "<依頼文>"
// 出力: 最終行にJSON {ok, branch, summary, diffFile, files} / {ok:false, error}
require('dotenv').config();
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const REPO = path.join(__dirname, '..');
const WT = '/Users/akiramacmini/projects/t2work';
const NODEBIN = process.execPath;

function sh(cmd, cwd = REPO) {
  return execSync(cmd, { cwd, encoding: 'utf-8', shell: '/bin/sh' });
}

(async () => {
  const req = (process.argv[2] || '').trim();
  if (!req) { console.log(JSON.stringify({ ok: false, error: '依頼文がありません' })); process.exit(1); }
  const branch = 't2/' + Date.now();
  try {
    try { sh(`git worktree remove --force ${WT} 2>/dev/null || true`); } catch (e) {}
    sh(`git worktree add -b ${branch} ${WT}`);

    let knowledge = '';
    try { knowledge = fs.readFileSync(path.join(REPO, 'data/sentinel_knowledge.md'), 'utf-8').slice(0, 20000); } catch (e) {}

    const { query } = await import('@anthropic-ai/claude-agent-sdk');
    const env = { ...process.env };
    delete env.ANTHROPIC_API_KEY; // Max(OAuth)で動かす

    const prompt = `あなたはSEXTASYのLINE自動化システム(このリポジトリ)の改修担当エンジニアです。次の依頼を最小限の差分で実装してください。

【依頼】
${req}

【厳守事項】
- 変更は必要最小限。無関係なリファクタ・整形をしない
- このリポジトリ(カレントディレクトリ)配下のファイルだけを読み書きする
- Telegramへの通信は必ずローカルプロキシ(http://127.0.0.1:8081)経由。api.telegram.orgへ直接接続するコードは書かない(この回線ではDPIで遮断される)
- 新規の依存パッケージを前提にしない(package.jsonを変更しない)
- .env と data/ 配下(DB・知識ファイル)は変更しない
- 実装が不可能・危険・依頼が曖昧すぎると判断したら、何も変更せず理由だけを説明して終了する

【システム知識(司令塔から同期)】
${knowledge}

作業が終わったら、最後に「何をどう変えたか」を3行以内の日本語で要約してください。`;

    const controller = new AbortController();
    const killer = setTimeout(() => controller.abort(), 12 * 60000);
    const q = query({
      prompt,
      options: {
        model: process.env.CLAUDE_MODEL || 'claude-sonnet-4-5-20250929',
        allowedTools: ['Read', 'Edit', 'Write', 'Grep', 'Glob'],
        permissionMode: 'acceptEdits',
        maxTurns: 60,
        settingSources: [],
        cwd: WT,
        env,
        abortController: controller,
      },
    });
    let summary = '';
    try {
      for await (const m of q) {
        if (m.type === 'result') summary = m.subtype === 'success' ? (m.result || '') : ('エージェント異常終了: ' + m.subtype);
      }
    } finally { clearTimeout(killer); }

    // 安全検証1: main側の作業ツリーが無傷であること(worktree外への書き込み検知)
    const mainDirty = sh('git status --porcelain -- src scripts package.json').trim();
    if (mainDirty) {
      console.log(JSON.stringify({ ok: false, error: 'main側に予期しない変更を検知したため中止しました: ' + mainDirty.slice(0, 200) }));
      process.exit(1);
    }

    sh('git add -A', WT);
    const files = sh('git diff --cached --name-only', WT).trim();
    if (!files) {
      try { sh(`git worktree remove --force ${WT}`); sh(`git branch -D ${branch}`); } catch (e) {}
      console.log(JSON.stringify({ ok: false, error: '変更なし', summary: summary.slice(0, 1500) }));
      return;
    }

    // 安全検証2: 変更された.jsの構文チェック(エージェント任せにしない)
    for (const f of files.split('\n').filter((x) => x.endsWith('.js'))) {
      try { sh(`${NODEBIN} --check "${WT}/${f}"`); }
      catch (e) {
        console.log(JSON.stringify({ ok: false, error: `構文エラー: ${f}`, summary: summary.slice(0, 800) }));
        process.exit(1);
      }
    }

    const diff = sh('git diff --cached', WT);
    const diffFile = `/tmp/t2_diff_${branch.replace('/', '_')}.patch`;
    fs.writeFileSync(diffFile, diff);

    // 自動監査: 起草した本人ではない別のClaudeに、差分が依頼の範囲内かを検査させる
    // (起草エージェントが隣接行を壊しつつ「変更していない」と主張する事故が実際に起きたため)
    let verify = '';
    try {
      const { runRaw } = require('../src/claude/client');
      verify = (await runRaw({
        system: 'あなたはコードレビューの監査担当です。簡潔な日本語で答えます。',
        prompt: `次の「依頼」に対して「差分」が過不足なく対応しているかを監査してください。\n- 依頼と無関係な行の変更・削除・文字の欠落(単語が短くなっている等)がないか、差分を1行ずつ確認\n- 問題がなければ「問題なし」とだけ出力\n- 問題があれば「⚠️」で始めて、各問題を1行ずつ列挙\n\n【依頼】\n${req}\n\n【差分】\n${diff.slice(0, 12000)}`,
        maxTokens: 500,
        label: 't2verify',
      })).trim();
    } catch (e) { verify = '(自動監査に失敗: ' + String(e.message).slice(0, 120) + ')'; }
    sh(`git commit -q -m "Tier2: ${req.replace(/["\n]/g, ' ').slice(0, 60)}"`, WT);
    console.log(JSON.stringify({ ok: true, branch, summary: summary.slice(0, 1500), diffFile, files: files.split('\n'), verify }));
  } catch (e) {
    try { sh(`git worktree remove --force ${WT} 2>/dev/null || true`); } catch (e2) {}
    console.log(JSON.stringify({ ok: false, error: String(e.message || e).slice(0, 300) }));
    process.exit(1);
  }
})();
