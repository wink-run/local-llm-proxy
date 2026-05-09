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
