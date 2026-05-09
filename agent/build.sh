#!/usr/bin/env bash
# 打包 llm-agent 为单文件可执行二进制（需在目标平台上运行）
# 默认复制到 ../server/static/downloads/ 供落地页下载；设 LLM_AGENT_NO_DEPLOY_COPY=1 可只保留 dist/
set -e

cd "$(dirname "$0")"

case "$(uname -s)-$(uname -m)" in
  Linux-x86_64)   AGENT_SUFFIX="linux-amd64" ;;
  Linux-aarch64)  AGENT_SUFFIX="linux-arm64" ;;
  Darwin-arm64)   AGENT_SUFFIX="darwin-arm64" ;;
  Darwin-x86_64)  AGENT_SUFFIX="darwin-amd64" ;;
  *)              AGENT_SUFFIX="$(uname -s | tr '[:upper:]' '[:lower:]')-$(uname -m)" ;;
esac
OUT_NAME="llm-agent-${AGENT_SUFFIX}"
DOWNLOADS_DIR="../server/static/downloads"

pip install -r requirements.txt pyinstaller --quiet

pyinstaller \
  --onefile \
  --name llm-agent \
  --clean \
  agent.py

echo ""
echo "打包完成: dist/llm-agent"
echo "用法: ./dist/llm-agent register --help"

if [ "${LLM_AGENT_NO_DEPLOY_COPY:-}" = 1 ]; then
  echo ""
  echo "已跳过复制到落地页目录（LLM_AGENT_NO_DEPLOY_COPY=1）"
  echo "需要时: mkdir -p $DOWNLOADS_DIR && cp dist/llm-agent $DOWNLOADS_DIR/$OUT_NAME"
else
  mkdir -p "$DOWNLOADS_DIR"
  cp "dist/llm-agent" "$DOWNLOADS_DIR/$OUT_NAME"
  echo ""
  echo "已生成落地页下载: $DOWNLOADS_DIR/$OUT_NAME（部署代理后刷新首页即可）"
fi
