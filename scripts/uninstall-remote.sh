#!/bin/bash
# 停用 Orchard 远程模式：停止并删除两个 launchd 服务，删除远程模式的程序和登录记录。
# 桌面版 Orchard 和已经给过的系统授权不受影响。
#   ./scripts/uninstall-remote.sh            停用并删除本机文件，保留 Cloudflare 上的隧道和 DNS 记录
#   ./scripts/uninstall-remote.sh --tunnel   同时删除 Cloudflare 上的 orchard 隧道
set -euo pipefail

ORCHARD_HOME="${ORCHARD_HOME:-$HOME/Library/Application Support/Orchard}"
REMOTE_DIR="$ORCHARD_HOME/remote"
AGENT_DIR="$HOME/Library/LaunchAgents"
TUNNEL_NAME="${ORCHARD_TUNNEL_NAME:-orchard}"
UID_NUM="$(id -u)"

for label in app.orchard.tunnel app.orchard.remote; do
  launchctl bootout "gui/$UID_NUM/$label" >/dev/null 2>&1 || true
  rm -f "$AGENT_DIR/$label.plist"
done
echo "已停止并删除 launchd 服务。"

if [ "${1:-}" = "--tunnel" ]; then
  CLOUDFLARED="$(command -v cloudflared || echo "$ORCHARD_HOME/bin/cloudflared")"
  if [ -x "$CLOUDFLARED" ]; then
    "$CLOUDFLARED" tunnel cleanup "$TUNNEL_NAME" >/dev/null 2>&1 || true
    "$CLOUDFLARED" tunnel delete "$TUNNEL_NAME" && echo "已删除 Cloudflare 隧道 $TUNNEL_NAME。指向它的 DNS 记录请在 Cloudflare 面板里手动删除。"
  fi
fi

rm -rf "$REMOTE_DIR"
security delete-generic-password -s "Orchard remote passphrase" >/dev/null 2>&1 || true
echo "已删除远程模式的程序、口令和登录记录。claude.ai 里的 Orchard 连接器可以在 设置 > 连接器 里移除。"
