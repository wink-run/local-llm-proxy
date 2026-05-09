#!/usr/bin/env bash
# 打包 llm-agent 为单文件可执行二进制（需在目标平台上运行）
set -e

cd "$(dirname "$0")"

pip install -r requirements.txt pyinstaller --quiet

pyinstaller \
  --onefile \
  --name llm-agent \
  --clean \
  agent.py

echo ""
echo "打包完成: dist/llm-agent"
echo "用法: ./dist/llm-agent register --help"
# 供落地页 /api/agent-downloads 列出；按平台命名后复制到服务端 static/downloads/
case "$(uname -s)-$(uname -m)" in
  Linux-x86_64)   AGENT_SUFFIX="linux-amd64" ;;
  Linux-aarch64)  AGENT_SUFFIX="linux-arm64" ;;
  Darwin-arm64)   AGENT_SUFFIX="darwin-arm64" ;;
  Darwin-x86_64)  AGENT_SUFFIX="darwin-amd64" ;;
  *)              AGENT_SUFFIX="$(uname -s | tr '[:upper:]' '[:lower:]')-$(uname -m)" ;;
esac
echo ""
echo "可选 — 放到代理服务落地页下载目录（与本脚本同级 ../server）："
echo "  mkdir -p ../server/static/downloads"
echo "  cp dist/llm-agent ../server/static/downloads/llm-agent-${AGENT_SUFFIX}"
echo "  # 重启或刷新首页即可出现下载按钮"
