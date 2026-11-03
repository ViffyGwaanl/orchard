#!/bin/bash
# Orchard 远程模式一键安装（macOS）
#
# 让 claude.ai 网页版、手机 App 和云端会话通过自定义连接器使用这台 Mac 上的 Orchard。
# 它会做这些事情：
#   1. 编译 Orchard，并安装到 ~/Library/Application Support/Orchard/remote/app
#   2. 生成访问口令（只保存哈希，明文放进钥匙串）
#   3. 安装 cloudflared，建立名为 orchard 的 Cloudflare Tunnel，并把你的域名指向它
#   4. 把 Orchard 服务和隧道注册成登录后自动启动的 launchd 服务
#
# 用法（在 orchard 源码目录里运行）：
#   ./scripts/install-remote.sh                       按提示一步步来
#   ./scripts/install-remote.sh --host orchard.example.com
#   ./scripts/install-remote.sh --reset-passphrase    换一个新口令，所有已连接的客户端需要重新登录
#
# 其中两步需要你自己操作，脚本会停下来提示：在浏览器里登录 Cloudflare，以及在 claude.ai 添加连接器。

set -euo pipefail

REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
ORCHARD_HOME="${ORCHARD_HOME:-$HOME/Library/Application Support/Orchard}"
REMOTE_DIR="$ORCHARD_HOME/remote"
APP_DIR="$REMOTE_DIR/app"
BIN_DIR="$ORCHARD_HOME/bin"
LOG_DIR="$HOME/Library/Logs/Orchard"
AGENT_DIR="$HOME/Library/LaunchAgents"
SERVER_LABEL="app.orchard.remote"
TUNNEL_LABEL="app.orchard.tunnel"
KEYCHAIN_SERVICE="Orchard remote passphrase"
TUNNEL_NAME="${ORCHARD_TUNNEL_NAME:-orchard}"
PORT="${ORCHARD_PORT:-8787}"
HOST=""
RESET=0

while [ $# -gt 0 ]; do
  case "$1" in
    --host) HOST="${2:-}"; shift 2 ;;
    --host=*) HOST="${1#--host=}"; shift ;;
    --port) PORT="${2:-}"; shift 2 ;;
    --tunnel-name) TUNNEL_NAME="${2:-}"; shift 2 ;;
    --reset-passphrase) RESET=1; shift ;;
    -h|--help) sed -n '2,17p' "$0"; exit 0 ;;
    *) echo "不认识的参数 $1，用 --help 查看用法" >&2; exit 2 ;;
  esac
done

bold() { printf '\033[1m%s\033[0m\n' "$*"; }
step() { printf '\n\033[1;32m==>\033[0m \033[1m%s\033[0m\n' "$*"; }
warn() { printf '\033[1;33m注意\033[0m %s\n' "$*"; }
die() { printf '\033[1;31m出错了\033[0m %s\n' "$*" >&2; exit 1; }
ask_yes() { # ask_yes "问题" 默认(y/n)
  local def="$2" ans
  if [ "$def" = "y" ]; then read -r -p "$1 [Y/n] " ans || true; ans="${ans:-y}"; else read -r -p "$1 [y/N] " ans || true; ans="${ans:-n}"; fi
  case "$ans" in [Yy]*) return 0 ;; *) return 1 ;; esac
}
pause() { read -r -p "$1" _ || true; }

# 终端里的 PATH 不一定包含 Homebrew 或 nvm 装的 node，这里把常见位置都找一遍。
# Claude 桌面应用自带的 node 只给它自己用，这里用不了。
find_node() {
  local c
  c="$(command -v node 2>/dev/null || true)"
  if [ -n "$c" ]; then echo "$c"; return; fi
  for c in /opt/homebrew/bin/node /usr/local/bin/node "$HOME"/.nvm/versions/node/*/bin/node "$HOME"/.volta/bin/node "$HOME"/.local/share/fnm/aliases/default/bin/node; do
    if [ -x "$c" ]; then echo "$c"; return; fi
  done
}
node_help() {
  echo
  echo "Orchard 远程模式需要 Node.js 20.3 或更新版本。安装方法如下，装好后重新运行本脚本："
  if command -v brew >/dev/null 2>&1 || [ -x /opt/homebrew/bin/brew ] || [ -x /usr/local/bin/brew ]; then
    echo "  在终端运行 brew install node"
  else
    echo "  这台 Mac 没有 Homebrew。最简单的办法是打开 https://nodejs.org 下载 LTS 版的 macOS 安装包，双击安装。"
  fi
  echo "  装好后关掉这个终端窗口，重新打开一个，再运行 node -v 确认能看到版本号。"
}

UID_NUM="$(id -u)"
load_agent() { # load_agent label plist
  launchctl bootout "gui/$UID_NUM/$1" >/dev/null 2>&1 || true
  launchctl bootstrap "gui/$UID_NUM" "$2"
  launchctl enable "gui/$UID_NUM/$1" >/dev/null 2>&1 || true
}

[ "$(uname -s)" = "Darwin" ] || die "这个脚本只能在 macOS 上运行。"

# ---------- 只换口令 ----------
if [ "$RESET" = "1" ]; then
  [ -f "$APP_DIR/dist/index.js" ] || die "还没有安装远程模式，请先不带参数运行一次。"
  NODE_BIN="$(find_node)"; [ -n "$NODE_BIN" ] || { node_help; die "没有找到 node。"; }
  # 先停掉服务，避免它在重置过程中把旧的登录记录写回去
  launchctl bootout "gui/$UID_NUM/$SERVER_LABEL" >/dev/null 2>&1 || true
  PASS="$("$NODE_BIN" "$APP_DIR/dist/index.js" remote-reset)"
  security add-generic-password -U -a "$(id -un)" -s "$KEYCHAIN_SERVICE" -w "$PASS" >/dev/null
  if [ -f "$AGENT_DIR/$SERVER_LABEL.plist" ]; then load_agent "$SERVER_LABEL" "$AGENT_DIR/$SERVER_LABEL.plist"; fi
  bold "新口令：$PASS"
  echo "已存进钥匙串（名称 ${KEYCHAIN_SERVICE}）。所有已连接的 Claude 需要在连接器里重新登录一次。"
  exit 0
fi

bold "Orchard 远程模式安装"
cat <<'EOF'
装好以后，claude.ai 网页版、手机 App 和云端会话都能通过一个 HTTPS 地址使用这台 Mac 上的
提醒事项、日历、备忘录、邮件、信息和通讯录。开始之前请确认两件事：

  1. 你有一个 Cloudflare 账号，并且账号里已经托管了一个域名（比如 example.com）。
     Orchard 会用它的一个子域名，比如 orchard.example.com。
  2. 这台 Mac 已经在 Claude 桌面应用里装过 Orchard 并完成了权限设置。
     远程模式和桌面版共用同一个小助手，已经给过的授权会直接沿用。

这个地址能读写你的邮件和日历，所以它始终要求登录，登录时需要输入安装时生成的口令。
EOF

# ---------- 1. 检查 Node ----------
step "检查 Node.js"
NODE_BIN="$(find_node)"
if [ -z "$NODE_BIN" ]; then
  node_help
  die "没有找到 node。"
fi
NODE_BIN="$(cd "$(dirname "$NODE_BIN")" && pwd -P)/$(basename "$NODE_BIN")"
NODE_DIR="$(dirname "$NODE_BIN")"
export PATH="$NODE_DIR:$PATH"
if ! "$NODE_BIN" -e 'const [a,b]=process.versions.node.split(".").map(Number); process.exit(a>20||(a===20&&b>=3)?0:1)'; then
  node_help
  die "这台 Mac 上的 Node.js 版本太旧（$("$NODE_BIN" -v)），需要 20.3 或更新。"
fi
command -v npm >/dev/null || die "找到了 node，但没有找到 npm。请用上面提到的方式重新安装 Node.js。"
echo "使用 ${NODE_BIN}（$("$NODE_BIN" -v)）"

# ---------- 2. 域名和选项 ----------
step "选择公开地址"
OLD_URL=""
if [ -f "$REMOTE_DIR/config.json" ]; then
  OLD_URL="$("$NODE_BIN" -e 'try{console.log(require(process.argv[1]).publicUrl)}catch{}' "$REMOTE_DIR/config.json")"
fi
if [ -z "$HOST" ] && [ -n "$OLD_URL" ]; then
  HOST="$(printf '%s' "$OLD_URL" | sed -E 's#^https://([^/]+)/.*#\1#')"
  echo "沿用上次的地址 $OLD_URL"
fi
while [ -z "$HOST" ]; do
  read -r -p "要用哪个域名访问 Orchard？（例如 orchard.example.com）: " HOST || true
done
HOST="$(printf '%s' "$HOST" | tr '[:upper:]' '[:lower:]' | sed -E 's#^https?://##; s#/.*$##')"
printf '%s' "$HOST" | grep -Eq '^([a-z0-9]([a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$' || die "\"$HOST\" 看起来不是一个有效的域名。"
PUBLIC_URL="https://$HOST/mcp"
echo "连接器地址将是 $PUBLIC_URL"

ALLOW_SEND=1
if ! ask_yes "允许 Claude 通过这个连接器发送 iMessage 和邮件吗？（发送前它仍会先给你确认；选否则只能放进草稿）" y; then ALLOW_SEND=0; fi
KEEP_AWAKE=1
if ! ask_yes "Orchard 运行期间阻止 Mac 自动睡眠吗？（推荐，否则睡眠时连接器会断开）" y; then KEEP_AWAKE=0; fi

# ---------- 3. 编译并安装 ----------
step "编译 Orchard"
cd "$REPO_DIR"
npm ci --no-audit --no-fund
npm run build
mkdir -p "$APP_DIR/dist" "$APP_DIR/swift" "$LOG_DIR" "$AGENT_DIR" "$BIN_DIR"
chmod 700 "$REMOTE_DIR"
cp dist/index.js "$APP_DIR/dist/index.js"
cp swift/OrchardHelper.swift swift/Info.plist "$APP_DIR/swift/"
cp package.json "$APP_DIR/package.json"
echo "已安装到 $APP_DIR"

# ---------- 4. 口令 ----------
step "设置访问口令"
PASS="$("$NODE_BIN" "$APP_DIR/dist/index.js" remote-init --public-url "$PUBLIC_URL" --port "$PORT")"
NEW_PASS=0
if [ -n "$PASS" ]; then
  security add-generic-password -U -a "$(id -un)" -s "$KEYCHAIN_SERVICE" -w "$PASS" >/dev/null
  NEW_PASS=1
  echo "已生成新口令并存进钥匙串（名称 ${KEYCHAIN_SERVICE}），安装结束时会显示。"
else
  echo "沿用已有的口令。忘记的话可以运行 security find-generic-password -s \"$KEYCHAIN_SERVICE\" -w 查看。"
fi

# ---------- 5. cloudflared ----------
step "安装 cloudflared"
CLOUDFLARED="$(command -v cloudflared || true)"
if [ -z "$CLOUDFLARED" ]; then
  if command -v brew >/dev/null; then
    brew install cloudflared
    CLOUDFLARED="$(command -v cloudflared)"
  else
    ARCH="$(uname -m)"; [ "$ARCH" = "arm64" ] || ARCH="amd64"
    TMP="$(mktemp -d)"
    echo "没有 Homebrew，从 Cloudflare 的 GitHub 发布页下载 cloudflared（${ARCH}）"
    curl -fsSL "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-darwin-$ARCH.tgz" -o "$TMP/cloudflared.tgz"
    tar -xzf "$TMP/cloudflared.tgz" -C "$TMP"
    install -m 755 "$TMP/cloudflared" "$BIN_DIR/cloudflared"
    rm -rf "$TMP"
    CLOUDFLARED="$BIN_DIR/cloudflared"
  fi
fi
CLOUDFLARED="$(cd "$(dirname "$CLOUDFLARED")" && pwd -P)/$(basename "$CLOUDFLARED")"
echo "使用 ${CLOUDFLARED}（$("$CLOUDFLARED" --version 2>&1 | head -1)）"

# ---------- 6. 登录 Cloudflare（你来操作） ----------
step "登录 Cloudflare"
if [ -f "$HOME/.cloudflared/cert.pem" ]; then
  echo "这台 Mac 已经登录过 Cloudflare，跳过。"
else
  cat <<EOF
接下来会打开浏览器，请你自己完成这一步：
  1. 登录你的 Cloudflare 账号
  2. 在列表里点选 ${HOST#*.} 这个域名（$HOST 所在的那个）
  3. 点 Authorize，看到成功提示后回到这个终端窗口
EOF
  pause "准备好了就按回车键打开浏览器……"
  "$CLOUDFLARED" tunnel login
  [ -f "$HOME/.cloudflared/cert.pem" ] || die "没有完成 Cloudflare 登录，请重新运行本脚本。"
fi

# ---------- 7. 建立隧道 ----------
step "建立 Cloudflare Tunnel：$TUNNEL_NAME"
# cloudflared 的 JSON 里，没删除的隧道 deleted_at 是 0001-01-01T00:00:00Z，不是空值。
tunnel_id() {
  "$CLOUDFLARED" tunnel list --name "$TUNNEL_NAME" --output json 2>/dev/null \
    | "$NODE_BIN" -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const a=JSON.parse(s)||[];const live=(x)=>!x.deleted_at||String(x.deleted_at).startsWith("0001-");const t=a.find(x=>x&&x.name===process.argv[1]&&live(x));if(t&&t.id)console.log(t.id)}catch{}})' "$TUNNEL_NAME"
}
UUID_RE='[0-9a-f]\{8\}-[0-9a-f]\{4\}-[0-9a-f]\{4\}-[0-9a-f]\{4\}-[0-9a-f]\{12\}'
TUNNEL_ID="$(tunnel_id)"
if [ -n "$TUNNEL_ID" ]; then
  echo "这个账号里已经有名为 $TUNNEL_NAME 的隧道，直接沿用。"
else
  CREATE_OUT="$("$CLOUDFLARED" tunnel create "$TUNNEL_NAME" 2>&1)" || { echo "$CREATE_OUT"; die "cloudflared 没能建立隧道 ${TUNNEL_NAME}，上面是它给出的原因。"; }
  echo "$CREATE_OUT"
  # 先从 create 的输出里取 id，取不到再查一次列表
  TUNNEL_ID="$(printf '%s\n' "$CREATE_OUT" | grep -i 'created tunnel' | grep -o "$UUID_RE" | head -1 || true)"
  [ -n "$TUNNEL_ID" ] || TUNNEL_ID="$(tunnel_id)"
fi
[ -n "$TUNNEL_ID" ] || die "隧道 ${TUNNEL_NAME} 建好了，但没能读到它的 ID。请运行 cloudflared tunnel list 看一下，再把结果发给我。"
CRED_FILE="$HOME/.cloudflared/$TUNNEL_ID.json"
[ -f "$CRED_FILE" ] || die "隧道 $TUNNEL_NAME 已经存在，但这台 Mac 上没有它的凭证文件 ${CRED_FILE}。请换个名字重新运行：./scripts/install-remote.sh --tunnel-name orchard-mac"
echo "隧道 ID $TUNNEL_ID"

if ! "$CLOUDFLARED" tunnel route dns "$TUNNEL_ID" "$HOST"; then
  warn "没能把 $HOST 指向隧道。如果这个域名已经有别的 DNS 记录，请先在 Cloudflare 面板里删掉它，或者换一个子域名，然后重新运行本脚本。"
  exit 1
fi

CF_CONFIG="$REMOTE_DIR/cloudflared.yml"
cat > "$CF_CONFIG" <<EOF
# 由 install-remote.sh 生成
tunnel: $TUNNEL_ID
credentials-file: "$CRED_FILE"
no-autoupdate: true
ingress:
  - hostname: $HOST
    service: http://127.0.0.1:$PORT
  - service: http_status:404
EOF
chmod 600 "$CF_CONFIG"

# ---------- 8. launchd 服务 ----------
step "注册开机自动运行的服务"
xml_escape() { printf '%s' "$1" | sed -e 's/&/\&amp;/g' -e 's/</\&lt;/g' -e 's/>/\&gt;/g'; }
SERVER_PLIST="$AGENT_DIR/$SERVER_LABEL.plist"
TUNNEL_PLIST="$AGENT_DIR/$TUNNEL_LABEL.plist"

cat > "$SERVER_PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$SERVER_LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>$(xml_escape "$NODE_BIN")</string>
    <string>$(xml_escape "$APP_DIR/dist/index.js")</string>
    <string>serve-http</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>$(xml_escape "$NODE_DIR"):/usr/bin:/bin:/usr/sbin:/sbin</string>
    <key>ORCHARD_HOME</key><string>$(xml_escape "$ORCHARD_HOME")</string>
    <key>ORCHARD_ALLOW_SEND</key><string>$ALLOW_SEND</string>
    <key>ORCHARD_KEEP_AWAKE</key><string>$KEEP_AWAKE</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>ProcessType</key><string>Interactive</string>
  <key>StandardOutPath</key><string>$(xml_escape "$LOG_DIR/server.log")</string>
  <key>StandardErrorPath</key><string>$(xml_escape "$LOG_DIR/server.log")</string>
</dict>
</plist>
EOF

cat > "$TUNNEL_PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$TUNNEL_LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>$(xml_escape "$CLOUDFLARED")</string>
    <string>tunnel</string>
    <string>--config</string>
    <string>$(xml_escape "$CF_CONFIG")</string>
    <string>run</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>StandardOutPath</key><string>$(xml_escape "$LOG_DIR/tunnel.log")</string>
  <key>StandardErrorPath</key><string>$(xml_escape "$LOG_DIR/tunnel.log")</string>
</dict>
</plist>
EOF
plutil -lint "$SERVER_PLIST" "$TUNNEL_PLIST" >/dev/null
load_agent "$SERVER_LABEL" "$SERVER_PLIST"
load_agent "$TUNNEL_LABEL" "$TUNNEL_PLIST"
echo "已注册 $SERVER_LABEL 和 ${TUNNEL_LABEL}，登录这台 Mac 后会自动启动，意外退出也会自动重启。"

# ---------- 9. 自检 ----------
step "检查服务"
ok=0
for _ in $(seq 1 30); do
  if curl -fsS "http://127.0.0.1:$PORT/healthz" >/dev/null 2>&1; then ok=1; break; fi
  sleep 1
done
[ "$ok" = "1" ] || die "本机服务没有启动，请查看日志：tail -50 \"$LOG_DIR/server.log\""
echo "本机服务正常"
ok=0
for _ in $(seq 1 45); do
  code="$(curl -s -o /dev/null -w '%{http_code}' "$PUBLIC_URL" || true)"
  if [ "$code" = "401" ]; then ok=1; break; fi
  sleep 2
done
if [ "$ok" = "1" ]; then
  echo "公网地址正常，未登录的请求会被拒绝（401），这是预期的"
else
  warn "暂时还连不上 ${PUBLIC_URL}。新建的 DNS 记录有时要几分钟才生效，稍后可以运行下面的命令再看："
  echo "  \"$NODE_BIN\" \"$APP_DIR/dist/index.js\" remote-status"
  echo "  日志：tail -50 \"$LOG_DIR/tunnel.log\""
fi

# ---------- 10. 在 claude.ai 添加连接器（你来操作） ----------
step "最后一步：在 claude.ai 添加连接器"
cat <<EOF
请你自己在浏览器里完成：
  1. 打开 claude.ai，进入 设置 > 连接器（Customize > Connectors）
  2. 点 添加自定义连接器（Add custom connector）
  3. 名称填 Orchard，地址填 $PUBLIC_URL
     如果对话框问用哪种 OAuth 客户端，选自动注册（Register automatically），不用填 Client ID
  4. 点 添加，再点 连接，会打开 Orchard 的授权页面
  5. 在授权页面输入下面的口令，点 允许
EOF
echo
if [ "$NEW_PASS" = "1" ]; then
  bold "你的访问口令：$PASS"
  echo "（已存进钥匙串，名称 ${KEYCHAIN_SERVICE}。以后可以用 security find-generic-password -s \"$KEYCHAIN_SERVICE\" -w 查看）"
else
  echo "口令沿用之前的，查看方法：security find-generic-password -s \"$KEYCHAIN_SERVICE\" -w"
fi
cat <<EOF

装好以后，网页版、手机 App 和云端会话里的 Claude 都能用 Orchard。请记得：
  这台 Mac 要保持开机、登录、联网。合上笔记本盖子会睡眠，连接器也会断开。
  想停用，运行 ./scripts/uninstall-remote.sh；想换口令，运行 ./scripts/install-remote.sh --reset-passphrase。
EOF
