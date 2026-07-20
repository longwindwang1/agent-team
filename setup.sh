#!/usr/bin/env bash
# Agent Team 一键安装/启动（macOS / Linux）
# 用法:  ./setup.sh                 安装依赖并启动（自动开浏览器）
#        ./setup.sh --install-only  只安装不启动（CI/脚本用）
#        ./setup.sh --no-browser    启动但不开浏览器
set -euo pipefail
cd "$(dirname "$0")"

INSTALL_ONLY=0
NO_BROWSER=0
for arg in "$@"; do
  case "$arg" in
    --install-only) INSTALL_ONLY=1 ;;
    --no-browser) NO_BROWSER=1 ;;
  esac
done

ok()   { printf '\033[32m[OK]\033[0m %s\n' "$1"; }
warn() { printf '\033[33m[!]\033[0m %s\n' "$1"; }
fail() { printf '\033[31m[X]\033[0m %s\n' "$1"; exit 1; }

# 1. Node >= 20
command -v node >/dev/null 2>&1 || fail "未找到 Node.js。请安装 Node 20+（https://nodejs.org 或 nvm install 22）"
NODE_VER="$(node -v | sed 's/^v//')"
NODE_MAJOR="${NODE_VER%%.*}"
[ "$NODE_MAJOR" -ge 20 ] || fail "Node 版本过低（$NODE_VER），需要 >= 20"
ok "Node $NODE_VER"

# 2. git
command -v git >/dev/null 2>&1 || fail "未找到 git"
ok "$(git --version | sed 's/git version //')"

# 3. 模型凭据（三选一即可，仅提示不阻断）
if command -v claude >/dev/null 2>&1; then
  ok "Claude Code CLI 已安装（用它的登录态跑官方模型）"
elif [ -n "${ANTHROPIC_API_KEY:-}" ]; then
  ok "检测到 ANTHROPIC_API_KEY 环境变量"
else
  warn "未检测到 Claude Code CLI 或 ANTHROPIC_API_KEY。三种方式任选其一："
  warn "  a) 安装并登录 Claude Code：npm i -g @anthropic-ai/claude-code && claude"
  warn "  b) 设置环境变量 ANTHROPIC_API_KEY"
  warn "  c) 启动后在 设置→模型提供商 里配 DeepSeek/GLM/Kimi 等第三方端点"
fi

# 4. 安装依赖（root workspaces 一次装齐 server+web）
printf '\n\033[36m>> npm install（首次约 1-2 分钟）...\033[0m\n'
npm install
ok "依赖安装完成"

if [ "$INSTALL_ONLY" = "1" ]; then ok "install-only 模式：跳过启动。手动启动：npm run start（开发热重载用 npm run dev）"; exit 0; fi

# 5. 启动（server:3100 + web:5174），浏览器延迟自动打开
#    用 start（server 不带 watch）：tsx watch 在无 TTY 环境会挂死，start 在任何环境都稳；开发热重载请手动 npm run dev
if [ "$NO_BROWSER" = "0" ]; then
  ( sleep 6; command -v open >/dev/null 2>&1 && open 'http://localhost:5174' || xdg-open 'http://localhost:5174' 2>/dev/null || true ) &
fi
printf '\n\033[36m>> 启动中：后端 http://127.0.0.1:3100 · 前端 http://localhost:5174（Ctrl+C 停止）\033[0m\n\n'
exec npm run start
