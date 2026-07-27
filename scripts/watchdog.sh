#!/bin/bash
# LINE Bot watchdog: healthチェックに失敗したらBotを自動再起動しTelegramに通知する
# launchd (com.user.line.watchdog) から5分毎に実行される
PROJECT_DIR="/Users/akiramacmini/projects/line-automation-system"
ENV_FILE="$PROJECT_DIR/.env"
TG_TOKEN=$(grep '^TELEGRAM_BOT_TOKEN=' "$ENV_FILE" | cut -d= -f2- | tr -d '"' | tr -d "'")
TG_CHAT=$(grep '^TELEGRAM_APPROVAL_CHAT_ID=' "$ENV_FILE" | cut -d= -f2- | tr -d '"' | tr -d "'")

notify() {
  if [ -n "$TG_TOKEN" ] && [ -n "$TG_CHAT" ]; then
    curl -s -m 10 "https://api.telegram.org/bot${TG_TOKEN}/sendMessage" \
      --data-urlencode "chat_id=${TG_CHAT}" \
      --data-urlencode "text=$1" > /dev/null
  fi
}

if curl -s -m 10 http://localhost:3000/health | grep -q '"status":"ok"'; then
  exit 0
fi

# 1回目の失敗 → 10秒待って再確認(再起動直後の一瞬を誤検知しないため)
sleep 10
if curl -s -m 10 http://localhost:3000/health | grep -q '"status":"ok"'; then
  exit 0
fi

echo "$(date '+%Y-%m-%d %H:%M:%S') health check failed, restarting bot" >> /tmp/line_watchdog.log
launchctl kickstart -k gui/501/com.user.line.bot
sleep 8
if curl -s -m 10 http://localhost:3000/health | grep -q '"status":"ok"'; then
  notify "🔧 watchdog: Botが応答しなかったため自動再起動しました(復旧済み)。直近の未読はchat.line.bizで確認してください。"
else
  notify "🚨 watchdog: Botが応答せず、自動再起動でも復旧しませんでした。手動確認が必要です。当面はchat.line.bizで手動対応してください。"
fi
