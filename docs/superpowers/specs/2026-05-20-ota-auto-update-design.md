# OTA 自动更新设计文档

> 状态：已批准，待实现
> 日期：2026-05-20

---

## 1. 目标

为 Token Bank Electron 应用（macOS + Windows）添加 OTA 自动更新能力：
- 启动后静默检查 GitHub Releases 上的新版本
- 后台自动下载更新包
- 下载完成后在应用内弹出提示，用户选择立即重启安装或下次启动时安装

## 2. 范围

- 平台：macOS（DMG，需 Apple Developer 签名）、Windows（NSIS）
- 分发渠道：GitHub Releases
- 不包含 Linux（AppImage 对自动更新支持有限）

## 3. 依赖变更

### 新增 dependency

```json
"electron-updater": "^6.x"
```

### `package.json` build 段新增 publish 配置

```json
"publish": {
  "provider": "github",
  "owner": "<github-owner>",
  "repo": "local-llm-proxy"
}
```

发布命令：`GH_TOKEN=<token> electron-builder --publish always`
- `GH_TOKEN` 只需 `repo` 权限
- `electron-builder` 自动生成并上传 `latest-mac.yml` / `latest.yml` 及安装包

## 4. 架构

```
GitHub Releases
    ├── latest-mac.yml
    ├── latest.yml
    ├── Token.Bank-x.y.z.dmg
    └── Token.Bank.Setup.x.y.z.exe

Electron main.js
    └── setupAutoUpdater()
           │
           ├── app ready + 5s 延迟 → checkForUpdates()
           ├── update-available    → 自动下载 (autoDownload: true)
           ├── download-progress   → 转发进度到 renderer
           ├── update-downloaded   → 通知 renderer 弹提示
           └── update-error        → 仅打 log，不弹错误弹窗

IPC 层
    ├── main → renderer (webContents.send)
    │     ├── update:available   { version, releaseNotes }
    │     ├── update:progress    { percent }
    │     └── update:downloaded  { version }
    └── renderer → main (ipcMain.handle)
          └── update:install     → autoUpdater.quitAndInstall()

preload.js
    └── electronAPI.updater
          ├── onAvailable(cb)
          ├── onProgress(cb)
          ├── onDownloaded(cb)
          └── install()

Renderer
    └── UpdateNotification.jsx
          ├── 监听 update:downloaded → 显示底部 Banner
          ├── 可选：监听 update:progress → 显示进度条
          ├── 「立即重启」→ electronAPI.updater.install()
          └── 「稍后」    → 隐藏 Banner（下次启动自动安装）
```

## 5. 详细实现

### 5.1 `main.js` — `setupAutoUpdater()`

```js
const { autoUpdater } = require('electron-updater');

function setupAutoUpdater() {
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;

  autoUpdater.on('update-available', (info) => {
    mainWindow?.webContents.send('update:available', {
      version: info.version,
      releaseNotes: info.releaseNotes,
    });
  });

  autoUpdater.on('download-progress', (progress) => {
    mainWindow?.webContents.send('update:progress', { percent: progress.percent });
  });

  autoUpdater.on('update-downloaded', (info) => {
    mainWindow?.webContents.send('update:downloaded', { version: info.version });
  });

  autoUpdater.on('error', (err) => {
    console.error('[updater] error:', err.message);
  });

  // 延迟 5s，避免影响启动性能
  setTimeout(() => autoUpdater.checkForUpdates(), 5000);
}
```

调用位置：在 `app.whenReady().then()` 内，`registerIPC()` 之后，仅 `!isDev` 时执行。

### 5.2 IPC 指令注册（加入 `registerIPC()`）

```js
ipcMain.handle('update:install', () => {
  autoUpdater.quitAndInstall();
});
```

### 5.3 `preload.js` — 暴露 updater API

```js
updater: {
  onAvailable:  (cb) => { const h = (_e, d) => cb(d); ipcRenderer.on('update:available',  h); return () => ipcRenderer.removeListener('update:available',  h); },
  onProgress:   (cb) => { const h = (_e, d) => cb(d); ipcRenderer.on('update:progress',   h); return () => ipcRenderer.removeListener('update:progress',   h); },
  onDownloaded: (cb) => { const h = (_e, d) => cb(d); ipcRenderer.on('update:downloaded', h); return () => ipcRenderer.removeListener('update:downloaded', h); },
  install:      () => ipcRenderer.invoke('update:install'),
},
```

### 5.4 `UpdateNotification.jsx`

- 挂载在 `App.jsx` 根部，独立于路由
- 状态机：`idle` → `downloading`（可选展示）→ `ready`（弹 Banner）→ `dismissed`
- Banner 样式：底部固定，Tailwind，与现有 UI 风格一致
- `ready` 状态展示版本号，两个按钮：立即重启 / 稍后

## 6. 错误处理

| 场景 | 处理方式 |
|------|----------|
| 网络不通 / GitHub 不可达 | `update-error` 静默 log，不影响用户 |
| 下载中断 | `electron-updater` 内置断点续传 |
| macOS 未签名 | 开发环境 `isDev` 跳过更新检查，不影响本地开发 |
| 用户拒绝安装 | `autoInstallOnAppQuit: true`，退出时自动安装 |

## 7. 发布流程

1. 更新 `package.json` 中的 `version`
2. `git tag vx.y.z && git push --tags`
3. `GH_TOKEN=<token> npm run build -- --publish always`
4. electron-builder 自动创建 GitHub Release 并上传安装包 + `latest.yml`

## 8. 不在范围内

- 强制更新（不允许用户跳过）
- 灰度发布 / 分阶段推送
- 更新日志富文本展示
- Linux 平台
