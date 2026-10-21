#!/bin/sh
# 司令塔セッション(Mac mini常駐)。Remote Control付きで起動し、claude.ai/code や
# スマホのClaudeアプリから、どの端末からでも同じセッションを操作できるようにする。
# tmuxの中で動かすのは、対話セッションに必要な擬似端末を確保し、SSHを切っても
# 生き続けるようにするため。launchdから5分ごとに呼ばれ、落ちていれば立て直す。
export PATH=/opt/homebrew/bin:/Users/akiramacmini/.nvm/versions/node/v22.23.1/bin:$PATH
PROJ=/Users/akiramacmini/projects/line-automation-system
cd "$PROJ" || exit 1

tmux has-session -t shireito 2>/dev/null && exit 0

TOK=$(grep '^CLAUDE_CODE_OAUTH_TOKEN=' "$PROJ/.env" | cut -d= -f2)
[ -z "$TOK" ] && { echo "$(date -u +%FT%TZ) トークンが見つからない"; exit 1; }

echo "$(date -u +%FT%TZ) 司令塔セッションを起動します"
# パイプを挟むと対話用の端末が外れて起動しないため、そのまま実行する。
# 終了してもpaneを残して原因を追えるようにする
tmux new-session -d -s shireito -c "$PROJ" \
  "CLAUDE_CODE_OAUTH_TOKEN='$TOK' claude --remote-control 'SEXTASY司令塔(Mac mini)'; echo '[終了しました]'; sleep 600"
tmux pipe-pane -t shireito -o 'cat >> /tmp/claude_shireito.log'
