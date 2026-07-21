#!/bin/bash
# 用 Xcode 自带的 altool / iTMSTransporter 上传 MAS pkg（无需安装 Transporter App）
set -euo pipefail

cd "$(dirname "$0")/.."

PKG="${1:-}"
if [ -z "$PKG" ]; then
  PKG=$(ls -t dist-app/mas-arm64/*.pkg dist-app/*.pkg 2>/dev/null | head -1 || true)
fi

if [ -z "$PKG" ] || [ ! -f "$PKG" ]; then
  echo "❌ 未找到 .pkg，请先 npm run build:mas"
  echo "   或指定路径: $0 path/to/Token-Bank.pkg"
  exit 1
fi

APPLE_ID="${APPLE_ID:-${APPLE_ID_USER:-}}"
# App 专用密码：https://appleid.apple.com → 登录与安全性 → App 专用密码
PASS="${APPLE_ID_PASSWORD:-${APP_SPECIFIC_PASSWORD:-${APPLE_APP_SPECIFIC_PASSWORD:-}}}"

if [ -z "$APPLE_ID" ] || [ -z "$PASS" ]; then
  echo "请先设置环境变量后再上传："
  echo "  export APPLE_ID='你的AppleID@email.com'"
  echo "  export APPLE_ID_PASSWORD='xxxx-xxxx-xxxx-xxxx'  # App 专用密码，非登录密码"
  echo ""
  echo "生成 App 专用密码: https://appleid.apple.com → 登录与安全性 → App 专用密码"
  echo ""
  echo "将上传文件: $PKG"
  exit 1
fi

echo "📦 上传: $PKG"
echo "👤 Apple ID: $APPLE_ID"
echo ""

# 优先 altool（Xcode 自带）
if xcrun --find altool >/dev/null 2>&1; then
  xcrun altool --upload-app \
    --type macos \
    --file "$PKG" \
    --username "$APPLE_ID" \
    --password "$PASS"
else
  xcrun iTMSTransporter -m upload \
    -assetFile "$PKG" \
    -u "$APPLE_ID" \
    -p "$PASS"
fi

echo ""
echo "✅ 上传命令已完成。请到 App Store Connect 等待构建处理（约 5–15 分钟）后选择构建版本。"
