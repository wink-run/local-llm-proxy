#!/usr/bin/env bash
# 本地一键跑 client + server 回归测试
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"

echo "==> Client tests"
(cd "$ROOT/client" && npm test)

echo "==> Server tests"
(cd "$ROOT/server" && python3 -m unittest discover -s . -p 'test_*.py' -v)

echo "==> All tests passed"
