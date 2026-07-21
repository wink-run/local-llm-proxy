# Mac App Store 上架指南

本指南详细说明如何将 Token Bank 应用上架到 Mac App Store。

## 一、准备工作

### 1. Apple Developer 账号

- 注册费用: $99/年
- 注册地址: https://developer.apple.com/programs/
- 类型选择: 
  - **个人账号**: 审核较快,以个人身份发布
  - **组织账号**: 需要企业认证,以公司名义发布

### 2. 在 Apple Developer Portal 创建必要资源

#### 2.1 创建 App ID

1. 登录 https://developer.apple.com/account/
2. 进入 **Certificates, Identifiers & Profiles**
3. 选择 **Identifiers** → 点击 **+** 创建新的 App ID
4. 填写信息:
   - **Description**: Token Bank
   - **Bundle ID**: `com.tokenbank.app` (必须与 package.json 中的 appId 一致)
   - **Capabilities**: 根据应用需求勾选:
     - ✅ Network Extensions (如果需要)
     - ✅ Outgoing Connections (允许)
     - ✅ App Sandbox

#### 2.2 创建证书

需要创建两个证书（**注意：不能用 Developer ID，那是站外分发用的**）：

**Apple Distribution**（或旧名 3rd Party Mac Developer Application）:
1. Certificates → 点击 **+**
2. 选择 **Apple Distribution**（Mac App Store 与 iOS 共用）
3. 按照提示上传 CSR 文件（使用 Keychain Access 生成）
4. 下载并双击安装到钥匙串

**Mac Installer Distribution**（或旧名 3rd Party Mac Developer Installer）:
1. Certificates → 点击 **+**
2. 选择 **Mac Installer Distribution**
3. 按照提示操作并安装

验证本机是否已有正确证书：

```bash
security find-identity -v -p codesigning
# MAS 构建需要看到类似：
# "Apple Distribution: Your Name (TEAMID)"
# 仅有 "Developer ID Application" 或 "Apple Development" 不够
```

### 2.2.1 下载 Electron 失败（`dial tcp 127.0.0.1:443`）

若本机代理把 `github.com` Fake-IP 到 `127.0.0.1`，`electron-builder` 会下载失败。
`npm run build:mas` / `scripts/build-mas.sh` 已默认使用 npmmirror：

```bash
export ELECTRON_MIRROR=https://cdn.npmmirror.com/binaries/electron/
export ELECTRON_BUILDER_BINARIES_MIRROR=https://npmmirror.com/mirrors/electron-builder-binaries/
```

也可手动指定后重试。

#### 2.3 创建 Provisioning Profile

1. Profiles → 点击 **+**
2. 选择 **Mac App Store** 下的 **Mac**
3. 选择刚才创建的 App ID: `com.tokenbank.app`
4. 选择 Mac App Distribution 证书
5. 命名为 `Token Bank Mac App Store`
6. 下载 Provisioning Profile 文件

将下载的 `.provisionprofile` 文件重命名为 `embedded.provisionprofile`,放在项目根目录或 `client/` 目录下。

## 二、项目配置

### 1. package.json 配置

已经在 `package.json` 中添加了 `mas` 配置段:

```json
"mas": {
  "type": "distribution",
  "category": "public.app-category.utilities",
  "hardenedRuntime": false,
  "entitlements": "electron/entitlements.mas.plist",
  "entitlementsInherit": "electron/entitlements.mas.inherit.plist",
  "provisioningProfile": "embedded.provisionprofile"
}
```

### 2. Entitlements 文件

已创建两个必需的权限文件:

- `electron/entitlements.mas.plist` - 主应用权限
- `electron/entitlements.mas.inherit.plist` - 子进程继承权限

**重要**: Mac App Store 应用必须启用沙箱(`com.apple.security.app-sandbox`)。

### 3. 调整应用代码以适配沙箱

Mac App Store 的沙箱限制较严格,需要确保:

#### 3.1 文件访问
- 默认只能访问应用自己的容器目录
- 访问用户文件需要通过文件选择对话框
- 如果需要访问特定目录(如 `~/.tokenbank/`),需要在 entitlements 中添加临时例外

#### 3.2 网络访问
- 已在 entitlements 中启用网络客户端和服务器权限
- 确保使用标准网络 API

#### 3.3 子进程
- 如果应用启动子进程,确保子进程也符合沙箱要求
- 不能执行任意外部程序

## 三、构建和打包

### 1. 设置环境变量

在终端中设置证书信息:

```bash
# 设置开发者 ID
export APPLE_ID="your-apple-id@example.com"
export APPLE_ID_PASSWORD="app-specific-password"
export APPLE_TEAM_ID="your-team-id"

# 或者设置证书名称
export CSC_LINK="path/to/certificate.p12"  # 可选
export CSC_KEY_PASSWORD="certificate-password"  # 可选
```

**获取 App-Specific Password:**
1. 访问 https://appleid.apple.com/
2. 登录后进入"安全"部分
3. 在"App 专用密码"中生成新密码

### 2. 构建 Mac App Store 版本

```bash
cd client

# 首次务必先安装依赖（否则 gen-icons 会报 Cannot find module 'pngjs'）
npm install

# 仅构建 Mac App Store 版本（必须在 macOS 上签名）
npm run build:mas

# 或同时构建多个版本
npm run build -- --mac mas dmg

# 输出目录: client/dist-app/
```

> **注意**: `electron-builder --mac mas` 的代码签名仅在 macOS 上执行。Linux/Windows 会跳过签名，不会生成可上传的 `.pkg`。

构建后会生成:
- `Token-Bank-0.5.0.pkg` - 可上传到 App Store 的安装包
- `Token-Bank-0.5.0-mac.zip` - 可用于本地测试

### 3. 验证构建结果

```bash
# 检查签名
pkgutil --check-signature "dist-app/Token-Bank-0.5.0.pkg"

# 检查应用签名
codesign -dv --verbose=4 "dist-app/mac-mas/Token Bank.app"

# 检查权限配置
codesign -d --entitlements - "dist-app/mac-mas/Token Bank.app"
```

## 四、用 Xcode / Transporter 上传

Electron 项目**不是** `.xcodeproj`，不要试图用 Xcode 打开仓库源码来 Archive。  
正确做法：**先打出签名好的 `.pkg`，再用 Transporter（或 Xcode Organizer）上传到 App Store Connect**。

### 1. 在 Xcode 里登录开发者账号（证书）

1. 打开 **Xcode**
2. 菜单 **Xcode → Settings…（设置）→ Accounts**
3. 点左下角 **+**，登录 Apple ID（团队 `8D9KVXVWQ5` / lee wink）
4. 选中团队 → **Manage Certificates…**
5. 点左下角 **+**，创建：
   - **Apple Distribution**（MAS 应用签名，必需）
   - 若列表里没有 Installer，到 [Certificates 网页](https://developer.apple.com/account/resources/certificates/list) 创建 **Mac Installer Distribution**，下载双击装入钥匙串

验证：

```bash
security find-identity -v -p codesigning | grep -E 'Apple Distribution|Mac Developer'
```

应能看到 `Apple Distribution: … (8D9KVXVWQ5)`。

### 2. 准备 Provisioning Profile

1. [Profiles](https://developer.apple.com/account/resources/profiles/list) → **+**
2. 选 **Mac** → **App Store Connect**
3. App ID 选 `com.tokenbank.app`
4. 选刚建的 Distribution 证书 → 下载
5. 重命名为 `embedded.provisionprofile`，放到 `client/` 目录

也可双击 profile 装入 Xcode，再在终端复制：

```bash
# 常见位置（文件名因机器而异，用 ls 确认）
ls ~/Library/MobileDevice/Provisioning\ Profiles/
cp "~/Library/MobileDevice/Provisioning Profiles/某UUID.provisionprofile" \
  client/embedded.provisionprofile
```

### 3. 构建可上传的 pkg

```bash
cd client
npm install
npm run build:mas
# 成功后应有：dist-app/Token-Bank-*.pkg
```

若只有 `dist-app/mas-arm64/Token Bank.app` 而没有 `.pkg`，说明签名未完成（缺 Distribution 证书或 profile）。

### 4. 用 Transporter 上传（推荐，可从 Xcode 打开）

**打开方式任选其一：**

- App Store 搜索安装 **Transporter**
- 或 Xcode 菜单：**Xcode → Open Developer Tool → Transporter**（部分 Xcode 版本有此入口）

**上传步骤：**

1. 用构建同一 Apple ID 登录 Transporter  
2. 把 `client/dist-app/Token-Bank-0.5.0.pkg` **拖进** Transporter  
3. 点 **交付（Deliver）**  
4. 等待校验 + 上传完成（通常几分钟）

### 5. 用 Xcode Organizer 上传（备选）

若你已有 `.xcarchive`（原生项目 Archive 产物）：

1. Xcode → **Window → Organizer**
2. 选 **Archives** → 选中该 archive
3. **Distribute App** → **App Store Connect** → **Upload**

Electron + electron-builder 默认产出的是 **`.pkg`，不是 `.xcarchive`**，因此日常请用 **Transporter**，不必强行走 Organizer。

### 6. 在 App Store Connect 选构建并提交

1. 打开 [App Store Connect](https://appstoreconnect.apple.com/) → 我的 App → Token Bank  
2. 创建/编辑 macOS 版本  
3. **构建版本** 里刷新，选中刚上传的 build（处理约 5–15 分钟）  
4. 填截图、描述、隐私后 → **提交以供审核**

### 常见卡点

| 现象 | 处理 |
|------|------|
| Transporter 校验失败：缺少签名 | 先装好 Apple Distribution + Installer，再 `npm run build:mas` |
| 没有 `.pkg` 只有 `.app` | 同上，签名阶段被跳过 |
| Organizer 里看不到包 | Electron 不会自动进 Organizer，改用 Transporter 拖 `.pkg` |
| 构建版本一直不出现 | 等邮件/通知里的处理结果；检查 Bundle ID 是否为 `com.tokenbank.app` |

---

## 五、提交到 App Store Connect（元数据）

### 1. 创建应用记录

1. 登录 https://appstoreconnect.apple.com/
2. 选择 **我的 App** → 点击 **+** → **新建 App**
3. 填写信息:
   - **平台**: macOS
   - **名称**: Token Bank
   - **主要语言**: 简体中文
   - **Bundle ID**: 选择 `com.tokenbank.app`
   - **SKU**: 自定义唯一标识,如 `tokenbank-mac-001`
   - **用户访问权限**: 完全访问权限

### 2. 填写应用信息

在应用详情页填写:

- **应用信息**:
  - App 名称: Token Bank
  - 副标题: 个人AI中枢 · Token 管家
  - 分类: 效率工具
  
- **定价与销售范围**:
  - 价格: 免费(或设定价格)
  - 销售范围: 选择国家/地区

- **App 隐私**:
  - 隐私政策 URL
  - 数据收集说明

- **App 信息**:
  - 应用描述(参考 README.zh-CN.md)
  - 关键词
  - 支持 URL: https://github.com/wink-run/local-llm-proxy
  - 营销 URL(可选)

- **截图**:
  - 需要提供 1280x800 或 1440x900 的应用截图
  - 至少 1 张,最多 10 张

### 3. 使用 Transporter 上传

**方法一: 使用 Transporter App**
1. 从 Mac App Store 下载 Transporter
2. 登录 Apple ID
3. 添加 `Token-Bank-0.5.0.pkg` 文件
4. 点击"交付"上传

**方法二: 使用 altool 命令行**
```bash
xcrun altool --upload-app \
  --type macos \
  --file "dist-app/Token-Bank-0.5.0.pkg" \
  --username "your-apple-id@example.com" \
  --password "app-specific-password"
```

**方法三: 使用 electron-builder 自动上传**
```bash
# 在 package.json 中配置好 publish 后
npm run build -- --mac mas --publish always
```

### 4. 选择构建版本

上传成功后(通常 5-15 分钟处理):
1. 在 App Store Connect 中刷新页面
2. 进入应用 → 选择版本
3. 在"构建版本"中点击"选择"
4. 选择刚才上传的构建版本

### 5. 提交审核

1. 确认所有信息已填写完整
2. 回答出口合规性问题
3. 回答内容版权问题
4. 点击"提交以供审核"

## 五、审核注意事项

### 1. 常见拒审原因

- **功能问题**:
  - 应用功能不完整或崩溃
  - 主要功能无法正常使用
  
- **隐私问题**:
  - 未说明数据收集用途
  - 缺少隐私政策
  
- **元数据问题**:
  - 截图与实际功能不符
  - 描述中包含其他平台信息
  
- **沙箱问题**:
  - 未正确配置沙箱权限
  - 尝试访问沙箱外的文件

### 2. 针对 Token Bank 的注意点

- **网络功能说明**: 清楚说明为何需要本地服务器(端口 11430/11431)
- **数据安全**: 强调 API Key 本地存储,不上传服务器
- **开发者工具定位**: 明确这是面向开发者的工具
- **功能演示**: 准备完整的测试账号和使用说明

### 3. 审核时间

- 首次提交: 通常 1-3 天
- 更新版本: 通常 1-2 天
- 如被拒: 修改后重新提交,1-2 天

## 六、版本更新

### 1. 修改版本号

在 `client/package.json` 中更新:
```json
{
  "version": "0.5.1"
}
```

### 2. 生成更新日志

```bash
cd client
npm run changelog
```

### 3. 构建新版本

```bash
npm run build -- --mac mas
```

### 4. 上传新版本

1. 在 App Store Connect 创建新版本
2. 使用 Transporter 上传新的 `.pkg` 文件
3. 选择构建版本
4. 填写"此版本的新增内容"
5. 提交审核

## 七、测试

### 1. TestFlight 测试(可选)

Mac App Store 也支持 TestFlight:
1. 在 App Store Connect 添加测试员
2. 测试员会收到邀请邮件
3. 通过 TestFlight 安装测试版本

### 2. 本地测试 MAS 构建

```bash
# 安装构建的 pkg
sudo installer -pkg "dist-app/Token-Bank-0.5.0.pkg" -target /

# 运行应用
open "/Applications/Token Bank.app"

# 检查沙箱限制
# 在系统日志中查看沙箱相关信息
log stream --predicate 'process == "Token Bank"' --level debug
```

## 八、常见问题

### Q1: 构建时提示找不到证书
**A**: 确保已正确安装证书到钥匙串,可以在终端运行:
```bash
security find-identity -v -p codesigning
```

### Q2: 上传时提示 Bundle ID 不匹配
**A**: 确保 App ID、package.json 中的 appId 和 Provisioning Profile 三者的 Bundle ID 完全一致。

### Q3: 应用在 MAS 版本无法访问文件
**A**: Mac App Store 应用受沙箱限制,需要:
- 使用文件选择对话框让用户授权
- 或在 entitlements.mas.plist 中添加临时例外

### Q4: 审核被拒,原因是使用了私有 API
**A**: 检查是否使用了不允许的 Electron 特性,某些 Node.js 模块可能不兼容 MAS。

### Q5: 如何处理应用内更新?
**A**: Mac App Store 版本不能使用 electron-updater 等自动更新机制,只能通过 App Store 更新。建议:
- 在代码中检测是否为 MAS 构建
- MAS 版本禁用自动更新功能

```javascript
// 在 main.js 中
const isMAS = process.mas || process.platform === 'darwin' && process.execPath.includes('App Store');

if (!isMAS) {
  // 初始化 electron-updater
  autoUpdater.checkForUpdates();
}
```

## 九、参考资源

- [Electron Mac App Store 指南](https://www.electronjs.org/docs/latest/tutorial/mac-app-store-submission-guide)
- [Apple 提交指南](https://developer.apple.com/app-store/submitting/)
- [App Store 审核指南](https://developer.apple.com/app-store/review/guidelines/)
- [electron-builder MAS 配置](https://www.electron.build/configuration/mas)

## 十、自动化脚本

创建一个便捷的构建脚本 `scripts/build-mas.sh`:

```bash
#!/bin/bash
# Token Bank Mac App Store 构建脚本

set -e

echo "🚀 开始构建 Mac App Store 版本..."

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
echo "✅ 验证签名..."
PKG_FILE=$(ls dist-app/*.pkg | head -1)
pkgutil --check-signature "$PKG_FILE"

echo "✅ 构建完成!"
echo "📦 输出文件: $PKG_FILE"
echo ""
echo "下一步:"
echo "1. 使用 Transporter 上传到 App Store Connect"
echo "2. 在 App Store Connect 中选择构建版本"
echo "3. 提交审核"
```

使用方法:
```bash
cd client
chmod +x scripts/build-mas.sh
./scripts/build-mas.sh
```

---

**祝您上架顺利! 🎉**

如有问题,欢迎在 GitHub 提 Issue: https://github.com/wink-run/local-llm-proxy/issues
