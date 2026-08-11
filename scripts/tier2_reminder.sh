#!/bin/sh
# Tier 2実装のリマインダー(毎週土曜10:00に大塚さんへDM)。Tier 2完了後にlaunchdごと削除する
cd "$(dirname "$0")/.." || exit 1
TOK=$(grep '^TELEGRAM_BOT_TOKEN=' .env | cut -d= -f2)
CHAT=$(grep '^TELEGRAM_OWNER_CHAT_ID=' .env | cut -d= -f2)
curl -s -m 30 -X POST -H 'content-type: application/json' \
  -d "{\"chat_id\":\"${CHAT}\",\"text\":\"⏰ リマインダー: 今週末はSentinel Tier 2(コード編集をDM承認で実行できる機能)の実装予定日です。\n司令塔セッション(MacBookのClaude)を開いて「Tier 2やろう」と伝えてください。\n※Tier 2実装が完了したらこのリマインダーは自動で止まります\"}" \
  "http://127.0.0.1:8081/bot${TOK}/sendMessage" > /tmp/tier2_reminder.log 2>&1
