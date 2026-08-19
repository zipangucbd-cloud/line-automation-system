#!/bin/sh
# クール便→メール便の季節切替リマインダー(9/12に大塚さんへDM)。切替完了後にlaunchdごと削除する
cd "$(dirname "$0")/.." || exit 1
TOK=$(grep '^TELEGRAM_BOT_TOKEN=' .env | cut -d= -f2)
CHAT=$(grep '^TELEGRAM_OWNER_CHAT_ID=' .env | cut -d= -f2)
curl -s -m 30 -X POST -H 'content-type: application/json' \
  -d "{\"chat_id\":\"${CHAT}\",\"text\":\"⏰ リマインダー: クール便→メール便の切替時期です(9月中旬予定)。\n司令塔セッションを開いて「クール便切替やろう」と伝えてください。\n対象: 発送報告テンプレ・system_promptのクール便/夏季送料の記述・発送専用URLの案内。\n※切替完了後このリマインダーは解除されます\"}" \
  "http://127.0.0.1:8081/bot${TOK}/sendMessage" > /tmp/cool_reminder.log 2>&1
