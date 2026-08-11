#!/bin/sh
# Tier 2適用スクリプト: オーナーの✅承認後に実行される。
# 流れ: mainへマージ → 変更jsの構文チェック → push → 対象サービス再起動 → ヘルス確認。
# 問題があれば git revert(履歴を残す安全な取り消し)で戻して報告する。強制pushは使わない。
cd /Users/akiramacmini/projects/line-automation-system || exit 1
BRANCH="$1"
NODE=/Users/akiramacmini/.nvm/versions/node/v22.23.1/bin/node
TOK=$(grep '^TELEGRAM_BOT_TOKEN=' .env | cut -d= -f2)
OWNER=$(grep '^TELEGRAM_OWNER_CHAT_ID=' .env | cut -d= -f2)
WT=/Users/akiramacmini/projects/t2work

say() {
  J=$(printf '%s' "$1" | $NODE -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>process.stdout.write(JSON.stringify(s)))')
  curl -s -m 30 -X POST -H 'content-type: application/json' \
    -d "{\"chat_id\":\"${OWNER}\",\"text\":${J}}" \
    "http://127.0.0.1:8081/bot${TOK}/sendMessage" > /dev/null 2>&1
}

[ -z "$BRANCH" ] && exit 1
PREV=$(git rev-parse HEAD)

if ! git merge --no-ff --no-edit "$BRANCH" > /tmp/t2_apply.log 2>&1; then
  git merge --abort > /dev/null 2>&1
  say "❌ Tier2適用失敗: マージできませんでした。ブランチ ${BRANCH} は残してあります。司令塔に相談してください。"
  exit 1
fi
MERGED=$(git rev-parse HEAD)

undo() {
  git revert --no-edit -m 1 "$MERGED" >> /tmp/t2_apply.log 2>&1
  git push origin main >> /tmp/t2_apply.log 2>&1
}

# 変更された.jsの構文チェック
FAIL=""
for f in $(git diff --name-only "$PREV" "$MERGED" | grep '\.js$'); do
  if [ -f "$f" ]; then
    $NODE --check "$f" >> /tmp/t2_apply.log 2>&1 || FAIL="$f"
  fi
done
if [ -n "$FAIL" ]; then
  undo
  say "❌ Tier2適用失敗: 構文チェックNG(${FAIL})。変更は取り消しました(revert)。"
  exit 1
fi

git push origin main >> /tmp/t2_apply.log 2>&1

CHANGED=$(git diff --name-only "$PREV" "$MERGED")
NEED_BOT=$(echo "$CHANGED" | grep -c '^src/')
if [ "$NEED_BOT" -gt 0 ]; then
  launchctl kickstart -k gui/501/com.user.line.bot
  sleep 15
  H=$(curl -s -m 8 http://localhost:3000/health 2>/dev/null | grep -c '"ok"')
  if [ "$H" -lt 1 ]; then
    undo
    launchctl kickstart -k gui/501/com.user.line.bot
    sleep 12
    H2=$(curl -s -m 8 http://localhost:3000/health 2>/dev/null | grep -c '"ok"')
    if [ "$H2" -ge 1 ]; then R="復旧OK"; else R="要確認(司令塔へ)"; fi
    say "🔴 Tier2適用後のヘルスチェックに失敗したため、変更を取り消して(revert)再起動しました(${R})。ブランチ ${BRANCH} は残してあります。詳細: /tmp/t2_apply.log"
    exit 1
  fi
fi

git worktree remove --force "$WT" > /dev/null 2>&1
git branch -D "$BRANCH" > /dev/null 2>&1

if [ "$NEED_BOT" -gt 0 ]; then HB="Botヘルス正常"; else HB="Bot再起動は不要な変更"; fi
say "✅ Tier2適用完了 / ${HB} / GitHubへpush済み"

# Sentinel自身が変更対象なら最後に再起動(このスクリプトは独立プロセスなので巻き込まれない)
echo "$CHANGED" | grep -q 'scripts/sentinel.js' && launchctl kickstart -k gui/501/com.user.line.sentinel
exit 0
