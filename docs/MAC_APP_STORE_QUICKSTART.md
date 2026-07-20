# Mac App Store 快速开始

本文档提供 Token Bank 上架 Mac App Store 的快速入门步骤。

## 前置要求

✅ Apple Developer Program 账号 ($99/年)  
✅ Mac 电脑(用于构建和签名)  
✅ Xcode 和命令行工具已安装  

## 五步上架

### 第 1 步: 创建 App ID

1. 访问 [Apple Developer Portal](https://developer.apple.com/account/)
2. 进入 **Certificates, Identifiers & Profiles**
3. 创建 App ID:
   - Bundle ID: `com.tokenbank.app`
   - 启用 App Sandbox

### 第 2 步: 创建证书

需要两个证书:
- ✅ Mac App Distribution
- ✅ Mac Installer Distribution

在 Keychain Access 中生成 CSR,然后在开发者门户创建并下载安装。

### 第 3 步: 创建 Provisioning Profile

1. 在开发者门户创建 Mac App Store Provisioning Profile
2. 关联 App ID: `com.tokenbank.app`
3. 下载后重命名为 `embedded.provisionprofile`
4. 放在 `client/` 目录下

### 第 4 步: 构建应用

```bash
cd client

# 方法 A: 使用脚本(推荐)
chmod +x scripts/build-mas.sh
./scripts/build-mas.sh

# 方法 B: 使用 npm 命令
npm run build:mas

# 输出: dist-app/Token-Bank-0.5.0.pkg
```

### 第 5 步: 上传和提交

1. **上传构建**:
   - 下载 Transporter App
   - 拖拽 `.pkg` 文件上传

2. **在 App Store Connect**:
   - 创建新 App (如果还未创建)
   - 选择构建版本
   - 填写应用信息和截图
   - 提交审核

## 检查清单

上传前请确认:

- [ ] Bundle ID 匹配: `com.tokenbank.app`
- [ ] 版本号已更新
- [ ] 已放置 `embedded.provisionprofile`
- [ ] 证书已正确安装
- [ ] 构建成功且签名验证通过
- [ ] 准备好应用截图(至少 1 张,1280x800 或更高)
- [ ] 准备好应用描述和关键词
- [ ] 准备好隐私政策 URL

## 常见命令

```bash
# 查看已安装的签名证书
security find-identity -v -p codesigning

# 验证应用签名
codesign -dv --verbose=4 "dist-app/mac-mas/Token Bank.app"

# 验证安装包签名
pkgutil --check-signature "dist-app/Token-Bank-0.5.0.pkg"

# 上传到 App Store (命令行方式)
xcrun altool --upload-app \
  --type macos \
  --file "dist-app/Token-Bank-0.5.0.pkg" \
  --username "your-apple-id@example.com" \
  --password "your-app-specific-password"
```

## 环境变量(可选)

如果使用命令行上传,可以设置:

```bash
export APPLE_ID="your-apple-id@example.com"
export APPLE_ID_PASSWORD="app-specific-password"
export APPLE_TEAM_ID="your-team-id"
```

## MAS 版本特殊说明

Mac App Store 版本与直接分发版本有以下区别:

| 特性 | 直接分发 (dmg) | Mac App Store |
|------|---------------|---------------|
| 沙箱 | 可选 | 必须启用 |
| 自动更新 | 支持 | 不支持(通过 App Store) |
| 文件访问 | 较宽松 | 受限,需用户授权 |
| 证书 | Developer ID | App Distribution |

## 下一步

- 📚 阅读完整文档: [MAC_APP_STORE_GUIDE.md](./MAC_APP_STORE_GUIDE.md)
- 🐛 遇到问题? 查看[常见问题](./MAC_APP_STORE_GUIDE.md#八常见问题)
- 💬 需要帮助? 在 [GitHub Issues](https://github.com/wink-run/local-llm-proxy/issues) 提问

---

**预计时间**: 首次完整流程约 2-4 小时 (不含审核等待时间)
