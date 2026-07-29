#!/bin/bash
# Token Bank Mac App Store 构建脚本

set -e

echo "🚀 开始构建 Mac App Store 版本..."
echo ""

# 检查是否在 client 目录
if [ ! -f "package.json" ]; then
  echo "❌ 错误: 请在 client 目录下运行此脚本"
  exit 1
fi

# 依赖未安装时自动 npm install（避免 pngjs 等 MODULE_NOT_FOUND）
if [ ! -d "node_modules/pngjs" ] || [ ! -d "node_modules/electron-builder" ]; then
  echo "📥 检测到依赖未安装，正在执行 npm install..."
  npm install
  echo ""
fi

# MAS 签名 / 上传只能在 macOS 完成；Linux 仅能打出未签名的 .app
if [ "$(uname -s)" != "Darwin" ]; then
  echo "⚠️  当前系统不是 macOS ($(uname -s))"
  echo "   electron-builder 会跳过代码签名，无法生成可上传的 .pkg"
  echo "   请在 Mac 上完成最终签名与 Transporter 上传"
  echo ""
fi

# 检查 embedded.provisionprofile 是否存在
if [ ! -f "embedded.provisionprofile" ]; then
  echo "⚠️  警告: 未找到 embedded.provisionprofile"
  echo "   请从 Apple Developer Portal 下载 Provisioning Profile"
  echo "   并重命名为 embedded.provisionprofile 放在 client 目录"
  echo ""
  # 非交互环境（CI / 云端）直接继续；本机交互则询问
  if [ -t 0 ]; then
    read -p "是否继续构建? (y/N) " -n 1 -r
    echo
    if [[ ! $REPLY =~ ^[Yy]$ ]]; then
      exit 1
    fi
  else
    echo "   （非交互环境，继续构建）"
  fi
fi

# GitHub 在国内常被本地代理 Fake-IP 解析到 127.0.0.1，导致 app-builder 下载失败
# 使用 npmmirror 镜像拉取 electron mas 产物（可用环境变量覆盖）
export ELECTRON_MIRROR="${ELECTRON_MIRROR:-https://cdn.npmmirror.com/binaries/electron/}"
export ELECTRON_BUILDER_BINARIES_MIRROR="${ELECTRON_BUILDER_BINARIES_MIRROR:-https://npmmirror.com/mirrors/electron-builder-binaries/}"
echo "🌐 Electron 镜像: $ELECTRON_MIRROR"

# 1. 清理旧构建
echo "📦 清理旧构建..."
rm -rf dist-app

# 2. 生成图标和更新日志
echo "🎨 生成资源..."
npm run gen-icons
npm run changelog

# 3. 构建
echo "🔨 构建应用..."
npm run build -- --mac mas

# 4. 验证
echo ""
echo "✅ 验证签名..."
PKG_FILE=$(ls dist-app/*.pkg 2>/dev/null | head -1)

if [ -z "$PKG_FILE" ]; then
  echo "❌ 构建失败: 未找到 .pkg 文件"
  exit 1
fi

echo "检查安装包签名..."
pkgutil --check-signature "$PKG_FILE"

APP_FILE=$(ls -d dist-app/mac-mas/*.app 2>/dev/null | head -1)
if [ -n "$APP_FILE" ]; then
  echo ""
  echo "检查应用签名..."
  codesign -dv --verbose=4 "$APP_FILE"
  
  echo ""
  echo "检查应用权限..."
  codesign -d --entitlements - "$APP_FILE"
fi

echo ""
echo "✅ 构建完成!"
echo "📦 输出文件: $PKG_FILE"
echo "📊 文件大小: $(du -h "$PKG_FILE" | cut -f1)"
echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "📋 下一步操作:"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""
echo "1️⃣  上传到 App Store Connect:"
echo "   方法 A: 使用 Transporter App (推荐)"
echo "   - 从 Mac App Store 下载 Transporter"
echo "   - 拖拽 $PKG_FILE 上传"
echo ""
echo "   方法 B: 使用命令行"
echo "   xcrun altool --upload-app \\"
echo "     --type macos \\"
echo "     --file \"$PKG_FILE\" \\"
echo "     --username \"your-apple-id@example.com\" \\"
echo "     --password \"app-specific-password\""
echo ""
echo "2️⃣  在 App Store Connect 中:"
echo "   - 等待构建版本处理完成 (5-15分钟)"
echo "   - 选择构建版本"
echo "   - 填写版本信息"
echo "   - App Review Information 粘贴 network.server 说明（若曾因该权限被自动拒审）"
echo "   - 提交审核"
echo ""
echo "📚 完整文档: docs/MAC_APP_STORE_GUIDE.md"
echo "📚 network.server 审核回复稿: docs/APP_REVIEW_NETWORK_SERVER.md"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
