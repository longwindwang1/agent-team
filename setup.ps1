# Agent Team 一键安装/启动（Windows PowerShell 5.1+）
# 用法:  .\setup.ps1                安装依赖并启动（自动开浏览器）
#        .\setup.ps1 -InstallOnly   只安装不启动（CI/脚本用）
#        .\setup.ps1 -NoBrowser     启动但不开浏览器
param(
  [switch]$InstallOnly,
  [switch]$NoBrowser
)
$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot

function Fail($msg) { Write-Host "[X] $msg" -ForegroundColor Red; exit 1 }
function Ok($msg) { Write-Host "[OK] $msg" -ForegroundColor Green }
function Warn($msg) { Write-Host "[!] $msg" -ForegroundColor Yellow }

# 1. Node >= 20
$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) { Fail "未找到 Node.js。请安装 Node 20+：winget install OpenJS.NodeJS.LTS 或 https://nodejs.org" }
$nodeVer = (node -v) -replace '^v', ''
$major = [int]($nodeVer.Split('.')[0])
if ($major -lt 20) { Fail "Node 版本过低（$nodeVer），需要 >= 20。升级：winget upgrade OpenJS.NodeJS.LTS" }
Ok "Node $nodeVer"

# 2. git
if (-not (Get-Command git -ErrorAction SilentlyContinue)) { Fail "未找到 git。安装：winget install Git.Git" }
Ok "git $((git --version) -replace 'git version ', '')"

# 3. 模型凭据（三选一即可，仅提示不阻断）
$claude = Get-Command claude -ErrorAction SilentlyContinue
if ($claude) { Ok "Claude Code CLI 已安装（用它的登录态跑官方模型）" }
elseif ($env:ANTHROPIC_API_KEY) { Ok "检测到 ANTHROPIC_API_KEY 环境变量" }
else {
  Warn "未检测到 Claude Code CLI 或 ANTHROPIC_API_KEY。三种方式任选其一："
  Warn "  a) 安装并登录 Claude Code：npm i -g @anthropic-ai/claude-code && claude"
  Warn "  b) 设置环境变量 ANTHROPIC_API_KEY"
  Warn "  c) 启动后在 设置→模型提供商 里配 DeepSeek/GLM/Kimi 等第三方端点"
}

# 4. 安装依赖（root workspaces 一次装齐 server+web）
Write-Host "`n>> npm install（首次约 1-2 分钟）..." -ForegroundColor Cyan
npm install
if ($LASTEXITCODE -ne 0) { Fail "npm install 失败，检查网络或代理后重试" }
Ok "依赖安装完成"

if ($InstallOnly) { Ok "InstallOnly 模式：跳过启动。手动启动：npm run dev"; exit 0 }

# 5. 启动（server:3100 + web:5174），浏览器延迟自动打开
if (-not $NoBrowser) {
  Start-Job -ScriptBlock { Start-Sleep -Seconds 6; Start-Process 'http://localhost:5174' } | Out-Null
}
Write-Host "`n>> 启动中：后端 http://127.0.0.1:3100 · 前端 http://localhost:5174（Ctrl+C 停止）`n" -ForegroundColor Cyan
npm run dev
