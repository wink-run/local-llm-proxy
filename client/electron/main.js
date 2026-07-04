const { app, BrowserWindow, Tray, Menu, ipcMain, nativeImage, shell, clipboard, dialog, nativeTheme } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const http = require('http');
const https = require('https');
const { autoUpdater } = require('electron-updater');
const {
  findLatestReleaseTag,
  feedUrlForTag,
  isRemoteNewer,
} = require('./updater-release');
const agent = require('./agent-worker');
const gateway = require('./local-gateway');
const localStats = require('./local-stats');
const sessionImport = require('./session-import');
const sessionBrowser = require('./session-browser');
const { STATS_DIR, computeImportSkip } = require('../shared/telemetry');
const { defaultServerUrlFromEnv } = require('../shared/default-server-url');
const deviceIdentity = require('../shared/device-identity');
const detectTools = require('./detect-tools');
const agentLinker = require('./agent-linker');
const cursorHooks = require('./cursor-hooks');
const { syncSessionTelemetry } = require('./session-telemetry-sync');

/** 会话补录节流：用量页频繁打开时不重复全量扫描 */
let _lastSessionTelemetrySync = 0;
const SESSION_TELEMETRY_SYNC_MS = 20_000;
function maybeSyncSessionTelemetry(localStats) {
  const now = Date.now();
  if (now - _lastSessionTelemetrySync < SESSION_TELEMETRY_SYNC_MS) return;
  _lastSessionTelemetrySync = now;
  try { syncSessionTelemetry(localStats); } catch {}
}
// device-reporter is used by the CLI only; desktop registration is handled
// by useDeviceReporter in the renderer (which has access to the JWT).

const isDev = !app.isPackaged;
const VITE_URL = 'http://localhost:5173';
// macOS 菜单栏显示名（dev 下系统设置里通常显示 Electron）
if (process.platform === 'darwin') app.setName('Token Bank');
const AGENT_CONFIG_PATH = path.join(os.homedir(), '.llm-agent', 'config.json');
const TB_YAML = path.join(os.homedir(), '.tokenbank', 'tokenbank.yaml');
// Claude Desktop 3p 配置目录（按平台）：
//   Windows → %LOCALAPPDATA%\Claude-3p\configLibrary
//   macOS   → ~/Library/Application Support/Claude-3p/configLibrary
//   Linux   → ~/.config/Claude-3p/configLibrary
const CLAUDE_3P_CONFIG_DIR = (() => {
  const home = os.homedir();
  if (process.platform === 'win32')  return path.join(home, 'AppData', 'Local', 'Claude-3p', 'configLibrary');
  if (process.platform === 'darwin') return path.join(home, 'Library', 'Application Support', 'Claude-3p', 'configLibrary');
  return path.join(home, '.config', 'Claude-3p', 'configLibrary');
})();

// Claude Desktop 数据目录（原生 1P + 3P 各一份 claude_desktop_config.json）
function claudeDesktopDataDirs() {
  const home = os.homedir();
  if (process.platform === 'win32') {
    const base = path.join(home, 'AppData', 'Local');
    return [path.join(base, 'Claude'), path.join(base, 'Claude-3p')];
  }
  if (process.platform === 'darwin') {
    const base = path.join(home, 'Library', 'Application Support');
    return [path.join(base, 'Claude'), path.join(base, 'Claude-3p')];
  }
  const base = path.join(home, '.config');
  return [path.join(base, 'Claude'), path.join(base, 'Claude-3p')];
}

// 还原 Claude Desktop 到官方 1P：除 configLibrary 外还需清 deploymentMode=3p、修补破损 _meta
function revertClaudeDesktopOfficialExtras() {
  for (const dir of claudeDesktopDataDirs()) {
    const cfg = path.join(dir, 'claude_desktop_config.json');
    try {
      if (!fs.existsSync(cfg)) continue;
      const obj = JSON.parse(fs.readFileSync(cfg, 'utf8'));
      if (obj.deploymentMode !== '3p') continue;
      delete obj.deploymentMode;
      fs.writeFileSync(cfg, JSON.stringify(obj, null, 2), 'utf8');
    } catch (e) { console.warn('[claude] clear deploymentMode', cfg, e.message); }
  }
  try {
    if (!fs.existsSync(CLAUDE_3P_CONFIG_DIR)) return;
    // 删除/还原仍残留的 gateway 配置
    for (const f of fs.readdirSync(CLAUDE_3P_CONFIG_DIR)) {
      if (!f.endsWith('.json') || f === '_meta.json') continue;
      const p = path.join(CLAUDE_3P_CONFIG_DIR, f);
      try {
        const c = JSON.parse(fs.readFileSync(p, 'utf8'));
        // 只回退 tokenbank 自己写入的配置；用户/Claude 自建的 gateway 配置绝不动，
        // 否则会清空 configLibrary，导致开发者模式被误判为「未启用」、纳管按钮回弹。
        if (c._configManagedBy !== 'tokenbank') continue;
        const bak = p + '.tokenbank-bak';
        if (fs.existsSync(bak)) fs.copyFileSync(bak, p);
        else fs.unlinkSync(p);
      } catch {}
    }
    // _meta.appliedId 指向已删文件时 Claude 会卡在 3P 半残状态
    const metaPath = path.join(CLAUDE_3P_CONFIG_DIR, '_meta.json');
    if (!fs.existsSync(metaPath)) return;
    const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
    const entries = (meta.entries || []).filter(e => fs.existsSync(path.join(CLAUDE_3P_CONFIG_DIR, e.id + '.json')));
    if (!entries.length) {
      try { fs.unlinkSync(metaPath); } catch {}
    } else {
      meta.entries = entries;
      if (!entries.some(e => e.id === meta.appliedId)) meta.appliedId = entries[0].id;
      fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2), 'utf8');
    }
  } catch (e) { console.warn('[claude] revert configLibrary extras', e.message); }
}

function isClaude3pConfigLibraryFile(file) {
  if (!file || typeof file !== 'string') return false;
  try {
    const base = path.basename(file);
    return path.resolve(file).startsWith(path.resolve(CLAUDE_3P_CONFIG_DIR) + path.sep)
      && base.endsWith('.json') && base !== '_meta.json';
  } catch { return false; }
}

// 纳管写入前解析目标路径；configLibrary 无既有配置时生成新 UUID 文件
function resolveClaude3pWriteTarget(file) {
  fs.mkdirSync(CLAUDE_3P_CONFIG_DIR, { recursive: true });
  if (isClaude3pConfigLibraryFile(file)) {
    return { file, configId: path.basename(file, '.json') };
  }
  const configId = require('crypto').randomUUID();
  return { file: path.join(CLAUDE_3P_CONFIG_DIR, configId + '.json'), configId };
}

// Claude 只读 _meta.appliedId 指向的配置；写入后必须确保 _meta 存在且 appliedId 对齐
function ensureClaude3pMeta(configId, name = 'Token Bank') {
  if (!configId || configId === '_meta') return;
  fs.mkdirSync(CLAUDE_3P_CONFIG_DIR, { recursive: true });
  const metaPath = path.join(CLAUDE_3P_CONFIG_DIR, '_meta.json');
  let meta = { appliedId: configId, entries: [{ id: configId, name }] };
  try {
    if (fs.existsSync(metaPath)) {
      const existing = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
      const entries = Array.isArray(existing.entries) ? existing.entries.filter(e => e && e.id) : [];
      const idx = entries.findIndex(e => e.id === configId);
      if (idx >= 0) entries[idx] = { ...entries[idx], name: entries[idx].name || name };
      else entries.push({ id: configId, name });
      meta = { ...existing, appliedId: configId, entries };
    }
  } catch {}
  fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2), 'utf8');
}

function isClaudeDesktopApp(app_id) {
  if (String(app_id || '').includes('claude-desktop')) return true;
  try {
    const app = (readLocalConfig()?.apps || []).find(a => a.id === app_id);
    return app?.preset_id === 'claude-desktop';
  } catch { return false; }
}

function isCodexDesktopApp(app_id) {
  if (String(app_id || '').includes('codex-desktop')) return true;
  try {
    const app = (readLocalConfig()?.apps || []).find(a => a.id === app_id);
    return app?.preset_id === 'codex-desktop';
  } catch { return false; }
}

function isTraeApp(app_id) {
  const { isTraeWorkEntity } = require('./app-handlers');
  if (isTraeWorkEntity(app_id)) return true;
  if (String(app_id || '').toLowerCase().includes('trae')) return true;
  try {
    const app = (readLocalConfig()?.apps || []).find(a => a.id === app_id);
    return isTraeWorkEntity(app?.preset_id) || isTraeWorkEntity(app?.agent_id);
  } catch { return false; }
}

/** 还原 config-file 应用配置（与 apps:revertConfigFile IPC 共用） */
function revertAppConfigFile(app_id, config_file) {
  if (isClaudeDesktopApp(app_id)) runClaude3pSync('revert');
  const cl = require('./config-loader');
  let file = cl.expandHome(cl.resolvePlaceholders(String(config_file || ''), {}));
  // Codex Desktop：精确删除我们写的段(保留 config.toml 其他更新)+ 删 catalog，不动 auth.json
  if (isCodexDesktopApp(app_id) && file) {
    const codexCfg = require('./codex-config');
    codexCfg.revertCodexProvider(file);
    codexCfg.removeCodexCatalog(path.dirname(file));
    // 会话归一回 openai：threads(Desktop 列表) + rollout 一并归一，直连态也看到全部
    try { codexCfg.syncCodexSessionProvider(path.dirname(file), 'openai'); } catch {}
    return;
  }
  if (isTraeApp(app_id) && file) {
    require('./trae-config').revertTraeModels(file);
    return;
  }
  if (file) {
    const bak = file + '.tokenbank-bak';
    if (fs.existsSync(bak)) {
      try { fs.copyFileSync(bak, file); } catch {}
    } else {
      // 无备份：只删 tokenbank 自己写入的配置。Claude Desktop 的 configLibrary 里可能是
      // 用户/Claude 自建的配置（纳管前 config_file 就指向它），删了会清空 configLibrary、
      // 让开发者模式被误判为未启用——所以未标记 _configManagedBy:tokenbank 的一律不动。
      try {
        let managed = true;
        if (isClaudeDesktopApp(app_id) && fs.existsSync(file)) {
          try { managed = JSON.parse(fs.readFileSync(file, 'utf8'))._configManagedBy === 'tokenbank'; }
          catch { managed = false; }
        }
        if (managed && fs.existsSync(file)) fs.unlinkSync(file);
      } catch {}
    }
  }
  if (isClaudeDesktopApp(app_id)) revertClaudeDesktopOfficialExtras();
}

function shouldUseClaude3pConfigWrite({ app_id, config_file, file }) {
  if (isClaudeDesktopApp(app_id)) return true;
  if (isClaude3pConfigLibraryFile(file)) return true;
  const cf = String(config_file || '');
  return cf.includes('CLAUDE_3P') || cf.includes('Claude-3p/configLibrary');
}

// 已有 gateway 配置但缺 _meta 时补齐（如历史写入未命中 app_id 判断）
function repairClaude3pMetaIfNeeded() {
  try {
    if (!fs.existsSync(CLAUDE_3P_CONFIG_DIR)) return;
    const configs = fs.readdirSync(CLAUDE_3P_CONFIG_DIR)
      .filter(f => f.endsWith('.json') && f !== '_meta.json');
    if (!configs.length) return;
    const metaPath = path.join(CLAUDE_3P_CONFIG_DIR, '_meta.json');
    if (fs.existsSync(metaPath)) {
      const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
      const id = meta.appliedId || (meta.entries && meta.entries[0] && meta.entries[0].id);
      if (id && fs.existsSync(path.join(CLAUDE_3P_CONFIG_DIR, id + '.json'))) return;
    }
    for (const f of configs) {
      try {
        const c = JSON.parse(fs.readFileSync(path.join(CLAUDE_3P_CONFIG_DIR, f), 'utf8'));
        if (c.inferenceProvider === 'gateway' || c._configManagedBy === 'tokenbank') {
          ensureClaude3pMeta(path.basename(f, '.json'));
          console.log('[claude] repaired _meta.json for', f);
          return;
        }
      } catch {}
    }
    ensureClaude3pMeta(path.basename(configs[0], '.json'));
    console.log('[claude] repaired _meta.json for', configs[0]);
  } catch (e) { console.warn('[claude] repair _meta', e.message); }
}

// Claude Desktop 开发者模式状态：configLibrary 目录是否存在。
// Claude 在启用 Developer Mode（Help → Troubleshooting → Enable Developer Mode）时创建该目录。
// 只看「目录在不在」而非「里面有没有 .json」——内容可能为空（Claude 会清掉空的 Default、
// 「回官方」也会清空内容），但目录仍在即代表开发者模式开过；写配置时缺文件会自动新建。
// Token Bank 自己只在写配置（纳管动作，此前提为 dev_mode_ready）时才 mkdir，不会凭空创建该目录。
function claudeDevModeReady() {
  try { return fs.existsSync(CLAUDE_3P_CONFIG_DIR); }
  catch { return false; }
}

// 获取 Claude Desktop 当前【激活】的 3p 配置文件路径。
// Claude 读取 _meta.json.appliedId 指向的那个配置；必须写进它，否则改了不生效。
// 若 configLibrary 为空（开发者模式未启用）→ 返回 null（由调用方提示用户先启用）。
function getClaudeCloudConfig() {
  try {
    if (!claudeDevModeReady()) return null;

    // 1) 优先用 _meta.json.appliedId 指向的激活配置（Claude 真正读取的那个）
    const metaPath = path.join(CLAUDE_3P_CONFIG_DIR, '_meta.json');
    let appliedId = null;
    try {
      const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
      appliedId = meta.appliedId || (meta.entries && meta.entries[0] && meta.entries[0].id) || null;
    } catch {}
    if (appliedId) {
      return path.join(CLAUDE_3P_CONFIG_DIR, appliedId + '.json');
    }

    // 2) 回退：已有 gateway 配置 → 用它
    const files = fs.readdirSync(CLAUDE_3P_CONFIG_DIR).filter(f => f.endsWith('.json') && f !== '_meta.json');
    for (const f of files) {
      try {
        const c = JSON.parse(fs.readFileSync(path.join(CLAUDE_3P_CONFIG_DIR, f), 'utf8'));
        if (c.inferenceProvider === 'gateway') return path.join(CLAUDE_3P_CONFIG_DIR, f);
      } catch {}
    }
    // 3) 再回退：第一个配置文件
    if (files.length) return path.join(CLAUDE_3P_CONFIG_DIR, files[0]);
    return null;
  } catch (e) {
    console.error('[main] getClaudeCloudConfig failed:', e.message);
    return null;
  }
}

let mainWindow = null;
let tray = null;

// ── 单实例锁 ──────────────────────────────────────────────────────────────────
// 只允许一个桌面实例：第二个实例拿不到锁就直接退出（避免 11430/5173 端口冲突、
// 重复托盘/网关/会话同步），并把已有实例的窗口拉到前台。必须在 app.whenReady/建窗/
// 起网关之前完成——放在这里即先于文件底部的 whenReady 执行。
// 注：仅约束 Electron 桌面 app；无头 CLI（cli/gateway.js）是另一入口，不受此锁影响。
if (!app.requestSingleInstanceLock()) {
  app.quit();
  process.exit(0);
}
app.on('second-instance', () => {
  try {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      if (!mainWindow.isVisible()) mainWindow.show();
      mainWindow.focus();
    }
  } catch {}
});
/** 菜单栏是否显示 ↑↓Token 两行文字（仅 macOS）。持久化在 localConfig.tray_show_tokens，默认开 */
let showTrayTokens = true;
/** macOS 点关闭仅隐藏窗口；托盘/Cmd+Q 退出时设为 true，避免 close 拦截 quit */
let isQuitting = false;
/** 菜单栏语言（由渲染层通过 tray:lang IPC 同步，默认 zh） */
let _trayLang = 'zh';
/** 用户是否已登录（由渲染层通过 tray:auth IPC 同步，初始从 cloud_config.token 推断） */
let _trayUserLoggedIn = false;

const TRAY_LABELS = {
  zh: {
    gatewayRunning:   (port) => `网关运行中 :${port}`,
    gatewayStopped:   '网关已停止',
    todayToken:       (l1, l2, n) => `今日 Token  ${l1}  ${l2}  (${n}次)`,
    agentRunning:     '贡献 Agent 运行中',
    agentStopped:     '贡献 Agent 已停止',
    showWindow:       '显示主窗口',
    showTokens:       '菜单栏显示 Token 上下行',
    startAgent:       '开启贡献 Agent',
    stopAgent:        '停止贡献 Agent',
    notLoggedIn:      '（需登录后使用）',
    quit:             '退出',
  },
  en: {
    gatewayRunning:   (port) => `Gateway running :${port}`,
    gatewayStopped:   'Gateway stopped',
    todayToken:       (l1, l2, n) => `Today  ${l1}  ${l2}  (${n} calls)`,
    agentRunning:     'Contribute Agent running',
    agentStopped:     'Contribute Agent stopped',
    showWindow:       'Show main window',
    showTokens:       'Show token usage in menu bar',
    startAgent:       'Start Contribute Agent',
    stopAgent:        'Stop Contribute Agent',
    notLoggedIn:      '(login required)',
    quit:             'Quit',
  },
};

// ── Icons ──────────────────────────────────────────────────────────────────────

/** 内置托盘图标（assets/ 未生成时的兜底） */
const TRAY_ICON_B64 = {
  running: 'iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAe0lEQVR4AbXBSREDMQxFwfcNRTTEReDMRTRMRZmDD1OpWeNKN39nGcUFccAyihPDu9gRXyyjuDG8i0nsWEbx0PAuNmKyjOKl4V2NRY1FYmMZxY/EZBnFS8O7Gosai8SOZRQPDe9iI75YRnFjeBeTOGAZxYnhXbxhGcWFDxeUJt5X+1QaAAAAAElFTkSuQmCC',
  stopped: 'iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAd0lEQVR4AbXBuxHDMAxEwXdsFxkquAqYsV5YAQONxvqZ413+LtLFBfFFpIsTo1vsiINIFzdGt5jETqSLh0a32Igp0sVLo1uNRY1FYhPp4kdiinTx0uhWY1FjkdiJdPHQ6BYbcRDp4sboFpP4ItLFidEt3oh0ceEDwVknJpkY6XgAAAAASUVORK5CYII=',
};


function getTrayIcon(state) {
  // macOS：黑白 Template 图标（tray-mac.png + @2x）。Template 模式下系统自动适配深/浅菜单栏。
  if (process.platform === 'darwin') {
    const macIcon = path.join(__dirname, '..', 'assets', 'tray-mac.png');
    if (fs.existsSync(macIcon)) {
      const img = nativeImage.createFromPath(macIcon);
      img.setTemplateImage(true);
      if (!img.isEmpty()) return img;
    }
    return nativeImage.createFromBuffer(Buffer.from(TRAY_ICON_B64.stopped, 'base64'));
  }
  const running = state === 'running';
  const name = running ? 'tray-green.png' : 'tray-gray.png';
  const iconPath = path.join(__dirname, '..', 'assets', name);
  let img;
  if (fs.existsSync(iconPath)) {
    img = nativeImage.createFromPath(iconPath);
  } else {
    img = nativeImage.createFromBuffer(Buffer.from(TRAY_ICON_B64[running ? 'running' : 'stopped'], 'base64'));
  }
  if (img.isEmpty()) {
    img = nativeImage.createFromBuffer(Buffer.from(TRAY_ICON_B64.stopped, 'base64'));
  }
  return img;
}

// ── Window ────────────────────────────────────────────────────────────────────

// 用系统默认浏览器打开外链；失败（如 Linux 缺 xdg-open）则复制链接 + 提示手动访问
function openExternalSafe(url) {
  Promise.resolve(shell.openExternal(url)).catch(() => {
    try { clipboard.writeText(url); } catch {}
    dialog.showMessageBox(mainWindow, {
      type: 'warning',
      message: '无法打开系统浏览器',
      detail: `链接已复制到剪贴板，请手动在浏览器中访问：\n${url}`,
      buttons: ['好的'],
    });
  });
}

function createWindow() {
  // 屏蔽默认应用菜单栏（File / Edit / View / Window / Help）
  Menu.setApplicationMenu(null);
  mainWindow = new BrowserWindow({
    width: 860,
    height: 600,
    minWidth: 860,
    minHeight: 600,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    // macOS 毛玻璃质感：窗口背景用系统材质，侧栏在 CSS 里透出（内容区保持实底）。
    ...(process.platform === 'darwin'
      ? { vibrancy: 'sidebar', visualEffectState: 'active', backgroundColor: '#00000000' }
      : {}),
    show: false,
  });

  // 外链（target="_blank" / window.open）走系统默认浏览器，不在 app 内开内置窗口
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) openExternalSafe(url);
    return { action: 'deny' };
  });
  // 防止 app 内直接导航到外部地址（保持单页应用本身可正常路由）
  mainWindow.webContents.on('will-navigate', (e, url) => {
    if (/^https?:\/\//i.test(url) && url !== VITE_URL && !url.startsWith(VITE_URL)) {
      e.preventDefault();
      openExternalSafe(url);
    }
  });

  if (isDev) {
    mainWindow.loadURL(VITE_URL);
  } else {
    mainWindow.loadFile(path.join(app.getAppPath(), 'dist', 'index.html'));
  }

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
    if (isDev) mainWindow.webContents.openDevTools({ mode: 'detach' });
    // 窗口可见后再自动启动贡献 Agent，避免拖慢应用启动
    try {
      const cfg = readAgentConfig();
      if (cfg?.auto_start && cfg?.worker_key) {
        setImmediate(() => startAgent());
      }
    } catch {}
  });

  // 关闭 / 最小化 → 隐藏到托盘（全平台；仅「退出」才真正结束进程）
  mainWindow.on('close', (e) => {
    if (!isQuitting) {
      e.preventDefault();
      mainWindow.hide();
    }
  });
  mainWindow.on('minimize', (e) => {
    if (!isQuitting) {
      e.preventDefault();
      mainWindow.hide();
    }
  });
}

// ── Tray ──────────────────────────────────────────────────────────────────────

let trayStatsTimer = null;

/** macOS 26 Tahoe：菜单栏白名单设置页（Allow in the Menu Bar） */
const MENU_BAR_SETTINGS_URL = 'x-apple.systempreferences:com.apple.MenuBarSettings';
const TAHOE_HINT_PATH = path.join(os.homedir(), '.tokenbank', 'tahoe-menu-bar-hint.json');
const TAHOE_HINT_INTERVAL_MS = 24 * 60 * 60 * 1000;

function getMacOSMajorVersion() {
  try {
    const { execSync } = require('child_process');
    return parseInt(execSync('sw_vers -productVersion', { encoding: 'utf8' }).trim().split('.')[0], 10);
  } catch { return 0; }
}

/** dev 模式在系统设置里叫 Electron，打包后叫 Token Bank */
function menuBarSettingsAppName() {
  return isDev ? 'Electron' : 'Token Bank';
}

function readTahoeHintState() {
  try {
    if (fs.existsSync(TAHOE_HINT_PATH)) return JSON.parse(fs.readFileSync(TAHOE_HINT_PATH, 'utf8'));
  } catch { /* ignore */ }
  return { lastShown: 0 };
}

function writeTahoeHintShown() {
  try {
    fs.mkdirSync(path.dirname(TAHOE_HINT_PATH), { recursive: true });
    fs.writeFileSync(TAHOE_HINT_PATH, JSON.stringify({ lastShown: Date.now() }));
  } catch { /* ignore */ }
}

/** macOS 26 可能拦截菜单栏图标，引导用户到系统设置开启 */
function showTahoeMenuBarGuidance(reason) {
  if (process.platform !== 'darwin' || getMacOSMajorVersion() < 26) return;
  const state = readTahoeHintState();
  if (Date.now() - (state.lastShown || 0) < TAHOE_HINT_INTERVAL_MS) return;

  const appName = menuBarSettingsAppName();
  writeTahoeHintShown();
  dialog.showMessageBox({
    type: 'warning',
    title: '菜单栏 Token 未显示',
    message: 'macOS Tahoe 没能在菜单栏给图标分配位置',
    detail: [
      '常见原因（按可能性排序）：',
      '1) 菜单栏图标太多——刘海屏放不下时，macOS 会直接丢弃放不下的项，',
      '   且没有溢出入口。请减少其它菜单栏图标，或安装 Ice / Bartender 做溢出收纳。',
      '2) 系统设置 → 菜单栏 → 允许在菜单栏中显示，确认已开启对应 App。',
      isDev ? '（开发模式下名字是 Electron）' : `（名字是「${appName}」）`,
      reason || '',
    ].filter(Boolean).join('\n'),
    buttons: ['打开菜单栏设置', '知道了'],
    defaultId: 0,
    cancelId: 1,
  }).then(({ response }) => {
    if (response === 0) shell.openExternal(MENU_BAR_SETTINGS_URL);
  }).catch(() => {});
}

/**
 * 检测托盘是否被系统隐藏/未真正落位。Tahoe 上有两种已知情况：
 *  1) y<0（26.5 已知 y=-17，被放到屏外）；
 *  2) 幻影项：状态项必然在屏幕右侧（刘海右侧的状态区），若 getBounds 报的 x
 *     落在屏幕左半区，说明系统没给它真正的菜单栏槽位（菜单栏已满放不下），
 *     此时图标其实没被画出来——但 y/宽高都正常，老逻辑会误判为"可见"。
 */
function isTrayLikelyHidden() {
  if (!tray || tray.isDestroyed?.()) return true;
  try {
    const bounds = tray.getBounds();
    console.log('[tray] getBounds=', bounds);
    if (!bounds || bounds.width <= 0 || bounds.height <= 0) return true;
    if (bounds.y < 0) return true;
    if (process.platform === 'darwin') {
      const disp = require('electron').screen.getPrimaryDisplay();
      // 状态项落在左半区 = 没拿到右侧真实槽位（幻影），视为隐藏
      if (bounds.x < disp.workArea.width / 2) return true;
    }
  } catch (e) {
    console.warn('[tray] getBounds failed:', e.message);
  }
  return false;
}

function checkTrayVisibilityAndHint() {
  if (process.platform !== 'darwin' || getMacOSMajorVersion() < 26) return;
  if (isTrayLikelyHidden()) {
    showTahoeMenuBarGuidance('菜单栏项位置异常或被系统隐藏');
  }
}

function destroyTray() {
  if (trayStatsTimer) { clearInterval(trayStatsTimer); trayStatsTimer = null; }
  if (tray && !tray.isDestroyed?.()) {
    tray.removeAllListeners();
    tray.destroy();
  }
  tray = null;
  if (trayRenderWin && !trayRenderWin.isDestroyed()) trayRenderWin.destroy();
  trayRenderWin = null; trayRenderReady = null;
}

/** 紧凑格式化 Token 数（托盘/状态栏共用） */
function fmtTrayTokens(n) {
  n = n || 0;
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}K`;
  return String(n);
}

function getTodayTokenSummary() {
  try { return localStats.queryTodaySummary(); }
  catch { return { inTok: 0, outTok: 0, calls: 0 }; }
}

function showMainWindow() {
  if (!mainWindow) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

/** 构建托盘右键菜单（每次弹出时现建，避免 setContextMenu 清掉 macOS 标题） */
function buildTrayContextMenu() {
  const running = agent.isRunning();
  const gw = gateway.getStatus?.() || {};
  const { inTok, outTok, calls } = getTodayTokenSummary();
  const L = TRAY_LABELS[_trayLang] || TRAY_LABELS.zh;
  return Menu.buildFromTemplate([
    { label: gw.running ? L.gatewayRunning(gw.port) : L.gatewayStopped, enabled: false },
    { label: L.todayToken(`↑${fmtTrayTokens(inTok)}`, `↓${fmtTrayTokens(outTok)}`, calls), enabled: false },
    { label: running ? L.agentRunning : L.agentStopped, enabled: false },
    { type: 'separator' },
    { label: L.showWindow, click: showMainWindow },
    ...(process.platform === 'darwin' ? [{
      label: L.showTokens,
      type: 'checkbox',
      checked: showTrayTokens,
      click: (mi) => {
        showTrayTokens = mi.checked;
        try { const c = readLocalConfig(); c.tray_show_tokens = mi.checked; writeLocalConfig(c); } catch {}
        refreshTray();
      },
    }] : []),
    { type: 'separator' },
    {
      label: L.startAgent,
      enabled: !running,
      click: () => {
        if (!_trayUserLoggedIn) {
          showMainWindow();
          mainWindow?.webContents?.send('app:navigate', '/login');
        } else {
          startAgent();
        }
      },
    },
    { label: L.stopAgent, enabled: running, click: stopAgent },
    { type: 'separator' },
    { label: L.quit, click: () => { isQuitting = true; app.quit(); } },
  ]);
}


// ── macOS 菜单栏：离屏 canvas 把「黑底白字 T 徽标 + 两行小字」画成彩色图 ──────────────
// setTitle 不能调字号，所以自己画成图。徽标固定黑底白 T；两行数字按系统深/浅色切换颜色
// （深色菜单栏白字、浅色黑字），两种菜单栏下都清楚。用隐藏窗口的 Chromium canvas 渲染，零额外依赖。
let trayRenderWin = null;
let trayRenderReady = null;
function ensureTrayRenderWin() {
  if (trayRenderWin && !trayRenderWin.isDestroyed()) return trayRenderReady;
  trayRenderWin = new BrowserWindow({ show: false, webPreferences: { offscreen: true } });
  trayRenderReady = trayRenderWin.webContents.loadURL('about:blank').then(() => trayRenderWin);
  return trayRenderReady;
}

/** 画出托盘彩色图：黑底白 T 徽标 +（showText 时）↑in / ↓out 两行小字。返回 nativeImage（@2x）。 */
async function renderTrayImage(line1, line2, showText, dark) {
  const win = await ensureTrayRenderWin();
  const js = `(() => {
    const S = 2;
    const H = 22 * S, padX = 1 * S, gap = 4 * S;
    const r = 9 * S, txtFs = 8.5 * S;
    const show = ${showText ? 'true' : 'false'};
    const fg = ${dark ? "'#fff'" : "'#000'"};
    const L1 = ${JSON.stringify(line1)}, L2 = ${JSON.stringify(line2)};
    let c = document.createElement('canvas'), x = c.getContext('2d');
    x.font = '600 ' + txtFs + 'px ui-monospace,Menlo,monospace';
    const tW = show ? Math.ceil(Math.max(x.measureText(L1).width, x.measureText(L2).width)) : 0;
    c.width = padX + 2 * r + (show ? gap + tW : 0) + padX;
    c.height = H;
    x = c.getContext('2d');
    x.textBaseline = 'middle';
    const cx = padX + r, cy = H / 2;
    // SVG 设计基准：viewBox 32×32，圆心(16,16)，外圈 r=14.5
    // 映射比例：canvas r=9*S → SVG r=14.5，scale = (r-1)/14.5
    const sc = (r - 1) / 14.5;
    // 粗圈
    x.strokeStyle = fg; x.lineWidth = 2.2 * S;
    x.beginPath(); x.arc(cx, cy, r - 1.5, 0, Math.PI * 2); x.stroke();
    // 三节点位置：与 SVG 一致（顶1底2）
    // SVG: top(16,4) bl(5.5,22) br(26.5,22)，相对中心(16,16)
    const nodes = [
      [cx + (16 - 16) * sc, cy + (4  - 16) * sc],  // top
      [cx + (5.5 - 16) * sc, cy + (22 - 16) * sc], // bottom-left
      [cx + (26.5- 16) * sc, cy + (22 - 16) * sc], // bottom-right
    ];
    // 连线（节点间 + 节点→中心）
    x.strokeStyle = fg; x.lineWidth = 0.65 * S; x.globalAlpha = 0.65; x.lineCap = 'round';
    [[0,1],[0,2],[1,2]].forEach(([a,b]) => {
      x.beginPath(); x.moveTo(nodes[a][0], nodes[a][1]); x.lineTo(nodes[b][0], nodes[b][1]); x.stroke();
    });
    nodes.forEach(([nx, ny]) => {
      x.beginPath(); x.moveTo(nx, ny); x.lineTo(cx, cy); x.stroke();
    });
    x.globalAlpha = 1;
    // 外节点实心点
    x.fillStyle = fg;
    nodes.forEach(([nx, ny]) => { x.beginPath(); x.arc(nx, ny, 1.4 * S, 0, Math.PI * 2); x.fill(); });
    // 中心圆
    x.beginPath(); x.arc(cx, cy, 7.5 * sc, 0, Math.PI * 2); x.fill();
    // 中心 T（镂空）
    x.globalCompositeOperation = 'destination-out';
    x.strokeStyle = 'rgba(0,0,0,1)'; x.lineCap = 'round'; x.lineWidth = 1.5 * S;
    const tw = 2.4 * S;
    x.beginPath(); x.moveTo(cx - tw, cy - 2.0 * S); x.lineTo(cx + tw, cy - 2.0 * S); x.stroke();
    x.beginPath(); x.moveTo(cx, cy - 2.0 * S); x.lineTo(cx, cy + 2.8 * S); x.stroke();
    x.globalCompositeOperation = 'source-over';
    // 两行数字
    if (show) {
      x.fillStyle = fg;
      x.font = '600 ' + txtFs + 'px ui-monospace,Menlo,monospace';
      x.textAlign = 'left'; x.textBaseline = 'middle';
      const tx = padX + 2 * r + gap;
      x.fillText(L1, tx, H * 0.32);
      x.fillText(L2, tx, H * 0.72);
    }
    return c.toDataURL('image/png');
  })()`;
  const dataURL = await win.webContents.executeJavaScript(js);
  const buf = Buffer.from(dataURL.split(',')[1], 'base64');
  const img = nativeImage.createFromBuffer(buf, { scaleFactor: 2 });
  img.setTemplateImage(false);
  return img;
}

/**
 * 统一刷新托盘外观。
 * macOS：图标+两行小字渲染成单色模板图（字号自定、深浅色自适应），开关关掉时只画 T。
 * 其它平台：绿/灰图标 + tooltip。
 */
let _lastTrayImportTs = 0;
function refreshTray() {
  if (!tray || tray.isDestroyed?.()) return;
  // 同步 session import，保证与 modal 数据一致；每 60s 最多跑一次
  const now = Date.now();
  if (now - _lastTrayImportTs > 60000) {
    try { syncSessionTelemetry(localStats); } catch {}
    _lastTrayImportTs = now;
  }
  const gw = gateway.getStatus?.() || {};
  const active = agent.isRunning() || gw.running;
  tray.setContextMenu(buildTrayContextMenu());
  if (process.platform === 'darwin') {
    const { inTok, outTok } = getTodayTokenSummary();
    const k = (n) => { n = n || 0; return n >= 1e6 ? `${Math.round(n / 1e6)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}K` : `${n}`; };
    const l1 = `↑${k(inTok)}`, l2 = `↓${k(outTok)}`;
    tray.setToolTip(`Token Bank · 今日 ${l1} ${l2}`);
    renderTrayImage(l1, l2, showTrayTokens, nativeTheme.shouldUseDarkColors)
      .then((img) => { if (tray && !tray.isDestroyed?.()) { tray.setImage(img); tray.setTitle(''); } })
      .catch((e) => {
        // 渲染失败兜底：退回系统字号 setTitle
        console.warn('[tray] render image failed, fallback to setTitle:', e.message);
        if (tray && !tray.isDestroyed?.()) tray.setTitle(showTrayTokens ? `${l1}\n${l2}` : '', { fontType: 'monospacedDigit' });
      });
  } else {
    const { inTok, outTok } = getTodayTokenSummary();
    const gwHint = gw.running ? `网关 :${gw.port}` : '网关已停止';
    tray.setImage(getTrayIcon(active ? 'running' : 'stopped'));
    tray.setToolTip(`Token Bank · ${gwHint} · 今日 ↑${fmtTrayTokens(inTok)} ↓${fmtTrayTokens(outTok)}`);
  }
}

/**
 * 极简托盘（参考 clawd-on-desk）：用 Template 图标创建一次 + setContextMenu，定时刷新。
 * 不再做延迟创建 / destroy-重建 / 屏外重试——实测那些对 Tahoe「菜单栏满了放不下」
 * 无效，只增加噪音。放不下时由 checkTrayVisibilityAndHint 一次性提示用户去腾位/装 Ice。
 */
function createTray() {
  if (tray && !tray.isDestroyed?.()) { refreshTray(); return; }
  try { showTrayTokens = readLocalConfig().tray_show_tokens !== false; } catch {}
  try { _trayUserLoggedIn = !!readLocalConfig().cloud_config?.token; } catch {}
  try {
    // macOS：黑底白字 T 图标（左）+ 两行 Token 文字（右，可由菜单开关关掉）；其它平台：绿/灰圆点
    const icon = getTrayIcon(agent.isRunning() ? 'running' : 'stopped');
    tray = new Tray(icon && !icon.isEmpty() ? icon : nativeImage.createEmpty());
  } catch (e) {
    console.error('[tray] create failed:', e.message);
    return;
  }
  if (process.platform === 'darwin') tray.setIgnoreDoubleClickEvents(true);
  tray.on('double-click', showMainWindow);
  if (process.platform !== 'darwin') tray.on('click', showMainWindow);
  // macOS 点击 tray 弹出菜单前立即刷新数据，确保 token 数字是最新的
  if (process.platform === 'darwin') tray.on('click', () => { tray.setContextMenu(buildTrayContextMenu()); });
  refreshTray();
  trayStatsTimer = setInterval(refreshTray, 30000);
  // 系统深/浅色切换时重画（数字颜色要跟着变）
  if (process.platform === 'darwin') {
    nativeTheme.removeAllListeners('updated');
    nativeTheme.on('updated', refreshTray);
    setTimeout(checkTrayVisibilityAndHint, 2500);
  }
}

/** 兼容旧调用：状态/用量变化时刷新托盘 */
function updateTrayMenu() { refreshTray(); }

// ── Agent ─────────────────────────────────────────────────────────────────────

const _agentLogBuf = [];   // keep last 200 lines for late-mounting pages
const AGENT_LOG_MAX = 200;

function startAgent() {
  console.log('[main] startAgent called, isRunning=', agent.isRunning());
  agent.start({
    onLog: (line) => {
      console.log('[agent-log]', line);
      _agentLogBuf.push(line);
      if (_agentLogBuf.length > AGENT_LOG_MAX) _agentLogBuf.shift();
      mainWindow?.webContents.send('agent:log', line);
    },
    onStatus: (status) => {
      console.log('[main] agent status', status);
      mainWindow?.webContents.send('agent:status', status);
      updateTrayMenu();
    },
  });
  updateTrayMenu();
}

function stopAgent() {
  agent.stop();
  updateTrayMenu();
}

// ── Auto updater ──────────────────────────────────────────────────────────────

/** 已下载、待用户重启安装的版本（侧栏标识用） */
let pendingUpdateReady = null;
let updaterRendererReady = false;
const pendingUpdateEvents = [];
let updaterEventsBound = false;

function pushUpdateEvent(channel, data) {
  if (updaterRendererReady && mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, data);
    return;
  }
  pendingUpdateEvents.push({ channel, data });
}

function markUpdaterRendererReady() {
  updaterRendererReady = true;
  if (!mainWindow || mainWindow.isDestroyed()) return;
  for (const { channel, data } of pendingUpdateEvents) {
    mainWindow.webContents.send(channel, data);
  }
  pendingUpdateEvents.length = 0;
}

/** 是否接收 beta/alpha/rc 预发布（用户可在设置页覆盖） */
function readUpdaterAllowPrerelease() {
  try {
    const v = readLocalConfig().updater_allow_prerelease;
    if (typeof v === 'boolean') return v;
  } catch { /* 首次启动无配置 */ }
  // 未显式设置时：当前安装包为预发布则默认可升预发布
  return /-(alpha|beta|rc)/i.test(String(app.getVersion() || ''));
}

function applyUpdaterAllowPrerelease(allow) {
  const v = allow != null ? !!allow : readUpdaterAllowPrerelease();
  autoUpdater.allowPrerelease = v;
  return v;
}

function persistUpdaterAllowPrerelease(allow) {
  const cfg = readLocalConfig();
  cfg.updater_allow_prerelease = !!allow;
  writeLocalConfig(cfg);
  return applyUpdaterAllowPrerelease(!!allow);
}

function resetUpdaterFeedDefault(allowPrerelease) {
  autoUpdater.setFeedURL({
    provider: 'github',
    owner: 'wink-run',
    repo: 'local-llm-proxy',
  });
  autoUpdater.allowPrerelease = allowPrerelease;
}

/**
 * 通过 GitHub API 解析最新 release，并指向具体 tag 的 yml。
 * 修复 0.4.9-betaN 版本号导致 electron-updater channel 匹配失败的问题。
 */
async function prepareUpdaterFeed() {
  const allowPrerelease = applyUpdaterAllowPrerelease();
  const current = app.getVersion();
  try {
    const latestTag = await findLatestReleaseTag(allowPrerelease);
    if (!latestTag || !isRemoteNewer(current, latestTag)) {
      resetUpdaterFeedDefault(allowPrerelease);
      return { allowPrerelease, hasUpdate: false, latestTag };
    }
    autoUpdater.setFeedURL(feedUrlForTag(latestTag));
    autoUpdater.allowPrerelease = allowPrerelease;
    console.info('[updater] targeting release:', latestTag);
    return { allowPrerelease, hasUpdate: true, latestTag };
  } catch (err) {
    console.warn('[updater] resolve latest release failed:', err.message);
    resetUpdaterFeedDefault(allowPrerelease);
    return { allowPrerelease, hasUpdate: null, error: err.message };
  }
}

function bindUpdaterEvents() {
  if (updaterEventsBound) return;
  updaterEventsBound = true;

  autoUpdater.on('update-available', (info) => {
    console.info('[updater] update available:', info.version);
    pushUpdateEvent('update:available', {
      version: info.version,
      releaseNotes: info.releaseNotes ?? null,
    });
  });

  autoUpdater.on('download-progress', (progress) => {
    pushUpdateEvent('update:progress', {
      percent: Math.round(progress.percent),
    });
  });

  autoUpdater.on('update-downloaded', (info) => {
    console.info('[updater] update downloaded:', info.version);
    pendingUpdateReady = { version: info.version };
    pushUpdateEvent('update:downloaded', { version: info.version });
  });

  autoUpdater.on('update-not-available', (info) => {
    console.info('[updater] already on latest:', app.getVersion(), '(remote:', info?.version, ')');
    pushUpdateEvent('update:not-available', { version: app.getVersion() });
  });

  autoUpdater.on('error', (err) => {
    console.error('[updater] error:', err.message);
    if (!pendingUpdateReady) {
      pushUpdateEvent('update:error', { message: err.message });
    }
  });
}

async function runUpdaterCheck() {
  const prep = await prepareUpdaterFeed();
  if (prep.hasUpdate === false) {
    console.info('[updater] already on latest:', app.getVersion());
    return null;
  }
  return autoUpdater.checkForUpdates().catch((err) => {
    console.error('[updater] checkForUpdates error:', err.message);
    throw err;
  });
}

/** 手动检查：等待 available / not-available / error 其一 */
async function checkForUpdatesAndWait(timeoutMs = 60000) {
  const prep = await prepareUpdaterFeed();
  if (prep.hasUpdate === false) {
    return { status: 'latest', version: app.getVersion() };
  }
  return new Promise((resolve) => {
    let settled = false;
    const finish = (payload) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      autoUpdater.removeListener('update-available', onAvail);
      autoUpdater.removeListener('update-not-available', onNotAvail);
      autoUpdater.removeListener('error', onErr);
      resolve(payload);
    };
    const onAvail = (info) => finish({ status: 'available', version: info.version });
    const onNotAvail = () => finish({ status: 'latest', version: app.getVersion() });
    const onErr = (err) => finish({ status: 'error', message: err?.message || String(err) });
    const timer = setTimeout(() => finish({ status: 'error', message: 'check timeout' }), timeoutMs);
    autoUpdater.once('update-available', onAvail);
    autoUpdater.once('update-not-available', onNotAvail);
    autoUpdater.once('error', onErr);
    autoUpdater.checkForUpdates().catch((e) => finish({ status: 'error', message: e.message }));
  });
}

function setupAutoUpdater() {
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.logger = console;
  applyUpdaterAllowPrerelease();
  bindUpdaterEvents();

  const CHECK_DELAY_MS = 3000;
  const CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000;

  function scheduleInitialCheck() {
    setTimeout(() => {
      markUpdaterRendererReady();
      runUpdaterCheck();
    }, CHECK_DELAY_MS);
  }

  // 等页面加载 + React 挂载 listener 后再检查；若 init 较慢导致 did-finish-load 已触发则立即排期
  if (mainWindow && !mainWindow.isDestroyed()) {
    const wc = mainWindow.webContents;
    if (wc.isLoading()) {
      wc.once('did-finish-load', scheduleInitialCheck);
    } else {
      scheduleInitialCheck();
    }
  } else {
    scheduleInitialCheck();
  }

  setInterval(() => runUpdaterCheck(), CHECK_INTERVAL_MS);
}

// ── Agent config helpers ──────────────────────────────────────────────────────

// Claude Desktop ↔ 3p 会话同步（启动/接管/定期共用；增量去重，无新增时近乎零成本）
function sync3pDebugLog(msg) {
  try {
    const p = require('electron').app.getPath('userData') + '/3p-sync-debug.log';
    fs.appendFileSync(p, new Date().toISOString() + ' ' + msg + '\n');
  } catch {}
}

function runClaude3pSync(reason) {
  try {
    const sync = require('./claude-3p-session-sync');
    const code = sync.syncCodeSessionsBidirectional();
    const cowork = sync.syncCoworkSessionsBidirectional();
    const copied = ((code.toP3 && code.toP3.copied) || 0) + ((code.toNative && code.toNative.copied) || 0)
      + (cowork.toP3 || 0) + (cowork.toNative || 0);
    const line = `[3p-sync] ${reason}: code →3p ${(code.toP3 && code.toP3.copied) || 0}/→native ${(code.toNative && code.toNative.copied) || 0}`
      + ` | dirs native=${code.nativeDir ? 'ok' : 'NULL'} p3=${code.p3Dir ? 'ok' : 'NULL'} skip=${code.skipped || '-'}`;
    // 定期同步只在真有新增时打日志，避免刷屏
    if (copied > 0 || reason !== 'interval') console.log(line);
    sync3pDebugLog(line);
  } catch (e) {
    console.warn(`[3p-sync] ${reason} failed:`, e && e.message);
    sync3pDebugLog(`FAILED ${reason}: ${e && e.message}`);
  }
}

function readAgentConfig() {
  try { return JSON.parse(fs.readFileSync(AGENT_CONFIG_PATH, 'utf-8')); }
  catch { return null; }
}

function writeAgentConfig(cfg) {
  fs.mkdirSync(path.dirname(AGENT_CONFIG_PATH), { recursive: true });
  fs.writeFileSync(AGENT_CONFIG_PATH, JSON.stringify(cfg, null, 2), 'utf-8');
}

/** 账户/刊例价模型 → agent config provider.models（启动与保存账户时调用） */
function syncAgentProviderModelsFromAccounts() {
  try {
    const billingConfig = require('./billing-config');
    const localCfg = readLocalConfig();
    const agentCfg = readAgentConfig() || { providers: [] };
    const { cfg, changed } = billingConfig.syncGatewayProvidersFromAccounts(agentCfg, localCfg);
    if (changed) {
      writeAgentConfig(cfg);
      console.log('[main] synced provider.models from personal accounts');
    }
  } catch (e) {
    console.warn('[main] sync provider models skipped:', e.message);
  }
}

// ── Local Config helpers (stored in userData) ────────────────────────────────

function localConfigPath() {
  return path.join(app.getPath('userData'), 'local-config.json');
}

// 默认策略组（首次使用 / 配置里没有时的初始值）
const DEFAULT_POLICIES = [
  { id: 'default-policy',       name: '默认',     strategy: 'fallback',    providers: [], created_at: '' },
  { id: 'code-policy',          name: '代码助手',  strategy: 'fallback',    providers: [], created_at: '' },
  { id: 'chat-policy',          name: '普通对话',  strategy: 'round-robin', providers: [], created_at: '' },
  { id: 'long-context-policy',  name: '长上下文',  strategy: 'fallback',    providers: [], created_at: '' },
];

// 从默认 yaml 文件加载某段数据（首次初始化用）
function loadDefaultYamlSection(filename, section) {
  try {
    const yamlLib = require('js-yaml');
    const filePath = path.join(__dirname, 'config', filename);
    if (!fs.existsSync(filePath)) return null;
    const doc = yamlLib.load(fs.readFileSync(filePath, 'utf8')) || {};
    return doc[section] || null;
  } catch { return null; }
}

function applyEnvServerDefault(cfg) {
  const url = defaultServerUrlFromEnv();
  if (!url) return cfg;
  if (!cfg.cloud_config) cfg.cloud_config = {};
  if (!cfg.cloud_config.url) cfg.cloud_config.url = url;
  return cfg;
}

function readLocalConfig() {
  try {
    const p = localConfigPath();
    if (fs.existsSync(p)) {
      const cfg = JSON.parse(fs.readFileSync(p, 'utf8'));
      // 补齐 policies 字段（老配置没有时用默认值）
      if (!cfg.policies) cfg.policies = DEFAULT_POLICIES.map(p => ({ ...p, created_at: new Date().toISOString() }));
      // 迁移 local_keys → apps（向后兼容）
      if (!cfg.apps) {
        cfg.apps = (cfg.local_keys || []).map(k => ({
          id: 'app-' + k.id,
          name: k.note || '未命名应用',
          icon: '🔑',
          link_method: 'api-key',
          api_key: k.key,
          route_id: k.model_key || null,
          description: '',
          allowed_models: [],
          max_rpm: null,
          max_concurrent: null,
          allow_stream: true,
          created_at: k.created_at || new Date().toISOString(),
        }));
      }
      // 首次启动但 scene_routes 为空：从默认 routes 文件加载
      if (!cfg.initialized_routes && (!cfg.scene_routes || cfg.scene_routes.length === 0)) {
        const defaultRoutes = loadDefaultYamlSection('tokenbank.routes.default.yaml', 'scene_routes');
        if (defaultRoutes && defaultRoutes.length > 0) {
          cfg.scene_routes = defaultRoutes.map(r => ({
            ...r, created_at: r.created_at || new Date().toISOString(),
          }));
          cfg.initialized_routes = true;
        }
      }
      // 用户显式取消托管的 agent_id 列表（自动托管会跳过这些）
      if (!Array.isArray(cfg.auto_host_disabled)) cfg.auto_host_disabled = [];
      return applyEnvServerDefault(cfg);
    }
  } catch {}
  // 全新安装：从默认文件初始化（场景路由从 routes 默认文件）
  const defaultRoutes = loadDefaultYamlSection('tokenbank.routes.default.yaml', 'scene_routes') || [];
  return applyEnvServerDefault({
    scene_routes: defaultRoutes.map(r => ({ ...r, created_at: new Date().toISOString() })),
    local_keys: [], apps: [],
    policies: DEFAULT_POLICIES.map(p => ({ ...p, created_at: new Date().toISOString() })),
    initialized_routes: defaultRoutes.length > 0,
    auto_host_disabled: [],
  });
}

function writeLocalConfig(cfg) {
  fs.writeFileSync(localConfigPath(), JSON.stringify(cfg, null, 2), 'utf8');
}

// ── API Key 应用（只能 config-file / API Key 托管，无法透明托管）──────────────────
// 定义来自 yaml 的 api_key_apps 段（config-loader）；{BASE}/{KEY} 由前端按应用解析。
// Appx 包检测 + 对应配置文件注入信息。未配置该段则返回 []（无 API Key 应用检测）。
function getApiKeyApps() {
  try {
    const apps = require('./config-loader').apiKeyApps() || [];
    return apps
      // enable_3p: false → 该 3p 应用被管理员禁用，不提供接入
      .filter(app => app.enable_3p !== false)
      // 处理 Claude Desktop 的动态配置路径
      .map(app => {
        if (app.id === 'claude-desktop' && app.config_file === '{CLAUDE_3P_CONFIG}') {
          const resolved = getClaudeCloudConfig();  // 有激活配置=其路径；configLibrary 空时=null（写入时再新建）
          // config_file_optional：本质是 config-file 应用，但目标路径依赖 Claude 开发者模式；
          // dev_mode_ready 只看开发者模式是否开过（configLibrary 目录在否），与「当前有没有 profile」解耦——
          // 否则清空/回官方后会误报「需启用开发者模式」。UI 据此决定是否显示启用引导。
          return { ...app, config_file: resolved, config_file_optional: true, dev_mode_ready: claudeDevModeReady() };
        }
        return app;
      });
  }
  catch { return []; }
}

let _appxCache = { ts: 0, map: {} };
function appxInstalled(name) {
  if (process.platform !== 'win32' || !name) return false;
  const now = Date.now();
  if (now - _appxCache.ts > 30000) _appxCache = { ts: now, map: {} };  // 30s 缓存，避免频繁 PS 调用
  if (name in _appxCache.map) return _appxCache.map[name];
  try {
    const out = require('child_process').execFileSync('powershell', ['-NoProfile', '-Command',
      `if (Get-AppxPackage -Name '*${name}*') { 'yes' } else { 'no' }`],
      { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
    return (_appxCache.map[name] = out === 'yes');
  } catch { return (_appxCache.map[name] = false); }
}

// 命令是否可执行（api_key_apps 里 CLI 工具用 command 检测，替代 appx）
function commandInstalled(cmd) {
  if (!cmd) return false;
  try { return !!require('./shim-installer').resolveRealCommand(cmd); }
  catch { return false; }
}

// 解析配置文件路径（{占位}+~）
function resolveCfgPath(p) {
  try { const cl = require('./config-loader'); return cl.expandHome(cl.resolvePlaceholders(String(p || ''), {})); }
  catch { return String(p || ''); }
}

/** config_file 检测：目录存在=弱信号；state.vscdb 等主配置存在=强信号（Trae 等 VS Code 系 IDE） */
function configFileDetect(d) {
  try {
    const f = resolveCfgPath(d.config_file);
    if (!f) return { hit: false, strong: false, weak: false };
    const fileOk = fs.existsSync(f);
    const dirOk = fs.existsSync(path.dirname(f));
    const strong = fileOk && /state\.vscdb$/i.test(f);
    return { hit: fileOk || dirOk, strong, weak: dirOk };
  } catch { return { hit: false, strong: false, weak: false }; }
}

// api_key 应用是否检测到（跨平台）：
//   Windows → appx 包 / CLI 命令
//   macOS   → /Applications/<App>.app / CLI 命令 / 配置目录已存在
//   Linux   → CLI 命令 / 配置目录已存在
function apiKeyAppDetected(d) {
  if (d.appx && appxInstalled(d.appx)) return true;            // Windows Store 包
  if (d.command && commandInstalled(d.command)) return true;   // CLI 命令（跨平台，含 npm 全局 bin）
  // macOS：按 appx 末段名探测 /Applications/<App>.app（OpenAI.Codex→Codex；Claude→Claude）
  if (process.platform === 'darwin' && d.appx) {
    const appName = String(d.appx).split('.').pop();
    for (const base of ['/Applications', path.join(os.homedir(), 'Applications')]) {
      try { if (fs.existsSync(path.join(base, appName + '.app'))) return true; } catch {}
    }
  }
  if (d.config_file) {
    const cf = configFileDetect(d);
    if (cf.strong || cf.weak) return true;
  }
  return false;
}

// 分强/弱信号检测（供 apps:supported 用）：
//   强信号 strong = 命令/appx/mac-app 现在确实装着；strongDefined 表示该应用配了强信号可判。
//   弱信号 weak   = 残留的配置目录（应用卸载后目录常仍在，不足以证明"已安装"）。
// 卸载（尤其 npm uninstall 只删命令、不删 ~/.<app> 目录）后，强信号立即转 false，
// 上层"有强信号只认强信号"即可正确变灰，不被残留目录误判为已安装。
function apiKeyDetect(d) {
  let strongDefined = false, strong = false;
  if (d.appx) {
    strongDefined = true;
    if (appxInstalled(d.appx)) strong = true;
    if (!strong && process.platform === 'darwin') {
      const appName = String(d.appx).split('.').pop();
      for (const base of ['/Applications', path.join(os.homedir(), 'Applications')]) {
        try { if (fs.existsSync(path.join(base, appName + '.app'))) strong = true; } catch {}
      }
    }
  }
  if (d.command) { strongDefined = true; if (commandInstalled(d.command)) strong = true; }
  let weak = false;
  if (d.config_file) {
    const cf = configFileDetect(d);
    if (cf.weak) weak = true;
    // state.vscdb 已生成 → 强信号（Trae 未在 /Applications 也可能已安装使用过）
    if (cf.strong) { strongDefined = true; strong = true; }
  }
  return { strongDefined, strong, weak };
}

// 递归解析 patch/env 中的 {BASE}/{KEY}/{REVERSE}（WorkBuddy models.json 等嵌套结构）
function resolvePatchDeep(obj, ctx = {}) {
  const cl = require('./config-loader');
  if (typeof obj === 'string') {
    return cl.resolvePlaceholders(obj, {
      reverse: ctx.reverse,
      mitm: ctx.mitm,
      caPath: ctx.caPath,
    })
      .replace(/\{BASE\}/g, ctx.base || '')
      .replace(/\{KEY\}/g, ctx.key || '');
  }
  if (Array.isArray(obj)) return obj.map(v => resolvePatchDeep(v, ctx));
  if (obj && typeof obj === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(obj)) out[k] = resolvePatchDeep(v, ctx);
    return out;
  }
  return obj;
}

// dot-path patch（a.b.c）→ 嵌套对象（用于整份写出 JSON / YAML 配置）
function patchToObject(patch) {
  const obj = {};
  for (const [k, v] of Object.entries(patch || {})) {
    const parts = String(k).split('.'); let cur = obj;
    for (let i = 0; i < parts.length - 1; i++) {
      if (typeof cur[parts[i]] !== 'object' || cur[parts[i]] == null) cur[parts[i]] = {};
      cur = cur[parts[i]];
    }
    cur[parts[parts.length - 1]] = v;
  }
  return obj;
}

// dot-path patch → 完整 TOML 文本（顶层标量 + [表] 分组）。整份写出我们的配置。
function patchToToml(patch) {
  const tomlVal = (v) => (v === true || v === false || v === 'true' || v === 'false' || /^-?\d+(\.\d+)?$/.test(String(v)))
    ? String(v) : `"${String(v).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
  const top = []; const tables = new Map();
  for (const [k, v] of Object.entries(patch || {})) {
    const i = String(k).lastIndexOf('.');
    if (i < 0) { top.push([k, v]); continue; }
    const tbl = k.slice(0, i), key = k.slice(i + 1);
    if (!tables.has(tbl)) tables.set(tbl, []);
    tables.get(tbl).push([key, v]);
  }
  let out = top.map(([k, v]) => `${k} = ${tomlVal(v)}`).join('\n');
  if (out) out += '\n';
  for (const [tbl, kvs] of tables) {
    out += `\n[${tbl}]\n` + kvs.map(([k, v]) => `${k} = ${tomlVal(v)}`).join('\n') + '\n';
  }
  return out;
}


// ── LLM config scanner ────────────────────────────────────────────────────────

const BASE_URL_KEYS = [
  'ANTHROPIC_BASE_URL', 'OPENAI_BASE_URL', 'OPENAI_API_BASE',
  'LLM_BASE_URL', 'API_BASE_URL', 'OLLAMA_HOST',
];
const TOKEN_KEYS = [
  'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_API_KEY', 'OPENAI_API_KEY',
  'LLM_TOKEN', 'LLM_API_KEY', 'API_KEY',
];
const MODEL_KEYS = ['MODELS', 'LLM_MODELS', 'DEFAULT_MODEL'];
// keys like ANTHROPIC_DEFAULT_HAIKU_MODEL whose values are model IDs
const ANTHROPIC_MODEL_KEYS = /^ANTHROPIC_DEFAULT_\w+_MODEL$/;

const SCAN_FILES = [
  { rel: '.claude/settings.json',       fmt: 'json-env' },
  { rel: '.claude/settings.local.json', fmt: 'json-env' },
  { rel: '.env',                         fmt: 'dotenv'   },
  { rel: '.config/openai/credentials',  fmt: 'dotenv'   },
  { rel: '.zshrc',                       fmt: 'shell'    },
  { rel: '.bashrc',                      fmt: 'shell'    },
  { rel: '.profile',                     fmt: 'shell'    },
  { rel: '.bash_profile',                fmt: 'shell'    },
  // openclaw / common agent tools
  { rel: '.openclaw/config.json',        fmt: 'json-flat' },
  { rel: '.config/openclaw/config.json', fmt: 'json-flat' },
  { rel: '.llm/config.json',             fmt: 'json-flat' },
  { rel: '.config/llm/config.json',      fmt: 'json-flat' },
];

function parseDotenv(content) {
  const map = {};
  for (const line of content.split('\n')) {
    const m = line.match(/^(?:export\s+)?([A-Z_][A-Z0-9_]*)=["']?([^"'\n#]*)["']?/);
    if (m) map[m[1]] = m[2].trim();
  }
  return map;
}

// ── Provider key import（从本机环境/工具导入已有 key）────────────────────────
// 命名环境变量 / 配置键 → 供给源 id（强提示，免试探）。只收来源明确的，
// 故意不收 GITHUB_TOKEN、通用 API_KEY 等易误导入的泛化名。
const ENV_PROVIDER_MAP = {
  OPENAI_API_KEY: 'openai',
  ANTHROPIC_API_KEY: 'anthropic-paid',
  ANTHROPIC_AUTH_TOKEN: 'anthropic-paid',
  GROQ_API_KEY: 'groq',
  DEEPSEEK_API_KEY: 'deepseek',
  OPENROUTER_API_KEY: 'openrouter',
  MISTRAL_API_KEY: 'mistral',
  TOGETHER_API_KEY: 'together',
  TOGETHER_AI_API_KEY: 'together',
  XAI_API_KEY: 'xai',
  GROK_API_KEY: 'xai',
  FIREWORKS_API_KEY: 'fireworks',
  CEREBRAS_API_KEY: 'cerebras',
  NVIDIA_API_KEY: 'nvidia',
  NVIDIA_NIM_API_KEY: 'nvidia',
  COHERE_API_KEY: 'cohere',
  SILICONFLOW_API_KEY: 'siliconflow',
};

// cc-switch 等结构未知的 JSON，靠值的形态判断是否是 key
const KEY_PREFIX_RE = /^(sk-|gsk_|csk-|nvapi-|xai-|fw_|tgp_v1_|ghp_|github_pat_)/;
function looksLikeKey(name, value) {
  if (typeof value !== 'string') return false;
  const v = value.trim();
  if (v.length < 20 || /\s/.test(v)) return false;
  if (KEY_PREFIX_RE.test(v)) return true;
  return /api[_-]?key|token|auth/i.test(name) && /^[A-Za-z0-9_.\-]+$/.test(v);
}

function collectKeysDeep(obj, source, push, depth = 0) {
  if (!obj || typeof obj !== 'object' || depth > 8) return;
  for (const [k, v] of Object.entries(obj)) {
    if (typeof v === 'string') { if (looksLikeKey(k, v)) push(v, null, source); }
    else if (v && typeof v === 'object') collectKeysDeep(v, source, push, depth + 1);
  }
}

// 返回 [{ key, providerId|null, source }]，仅本机扫描、绝不写日志/上传
function scanProviderKeys() {
  const out = [];
  const seen = new Set();
  const push = (key, providerId, source) => {
    if (typeof key !== 'string') return;
    const k = key.trim();
    if (k.length < 8) return;
    const dedupe = `${k}|${providerId || ''}`;
    if (seen.has(dedupe)) return;
    seen.add(dedupe);
    out.push({ key: k, providerId: providerId || null, source });
  };

  // 1) 环境变量（命名即来源）
  for (const [envName, pid] of Object.entries(ENV_PROVIDER_MAP)) {
    if (process.env[envName]) push(process.env[envName], pid, `env:${envName}`);
  }

  // 2) 已知配置文件里的命名 key（复用 SCAN_FILES 的解析）
  const home = os.homedir();
  for (const { rel, fmt } of SCAN_FILES) {
    const fp = path.join(home, rel);
    if (!fs.existsSync(fp)) continue;
    try {
      const content = fs.readFileSync(fp, 'utf-8');
      let envMap = {};
      if (fmt === 'json-env')       envMap = JSON.parse(content).env || {};
      else if (fmt === 'json-flat') envMap = JSON.parse(content);
      else                          envMap = parseDotenv(content);
      for (const [name, pid] of Object.entries(ENV_PROVIDER_MAP)) {
        if (envMap[name]) push(envMap[name], pid, `file:${rel}`);
      }
    } catch {}
  }

  // 3) cc-switch（结构按版本变化，深度遍历兜底）
  try {
    const ccPath = path.join(home, '.cc-switch', 'config.json');
    if (fs.existsSync(ccPath)) {
      collectKeysDeep(JSON.parse(fs.readFileSync(ccPath, 'utf-8')), 'file:.cc-switch/config.json', push);
    }
  } catch {}

  return out;
}

function scanLLMConfigs() {
  const home = os.homedir();
  const results = [];

  for (const { rel, fmt } of SCAN_FILES) {
    const filePath = path.join(home, rel);
    if (!fs.existsSync(filePath)) continue;
    try {
      const content = fs.readFileSync(filePath, 'utf-8');
      let envMap = {};

      if (fmt === 'json-env') {
        const json = JSON.parse(content);
        envMap = json.env || {};
      } else if (fmt === 'json-flat') {
        const json = JSON.parse(content);
        // accept both camelCase and UPPER_SNAKE_CASE keys
        for (const k of Object.keys(json)) envMap[k.toUpperCase().replace(/([a-z])([A-Z])/g, '$1_$2')] = json[k];
        Object.assign(envMap, json);
      } else {
        envMap = parseDotenv(content);
      }

      const base_url = BASE_URL_KEYS.map(k => envMap[k]).find(v => v && v.startsWith('http'));
      const token    = TOKEN_KEYS.map(k => envMap[k]).find(Boolean);

      // collect model names: explicit MODELS key (comma-sep) or ANTHROPIC_DEFAULT_*_MODEL values
      let models = [];
      const modelsStr = MODEL_KEYS.map(k => envMap[k]).find(Boolean);
      if (modelsStr) models = modelsStr.split(',').map(s => s.trim()).filter(Boolean);
      if (!models.length) {
        const anthropicModels = Object.entries(envMap)
          .filter(([k]) => ANTHROPIC_MODEL_KEYS.test(k))
          .map(([, v]) => v.trim())
          .filter(Boolean);
        models = [...new Set(anthropicModels)];
      }
      // also pick up json-flat "models" array
      if (!models.length && fmt === 'json-flat') {
        try {
          const json = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
          if (Array.isArray(json.models)) models = json.models.filter(m => typeof m === 'string');
        } catch {}
      }

      if (base_url || token) {
        results.push({ source: rel, base_url: base_url || null, token: token || null, models });
      }
    } catch {}
  }

  return results;
}

// ── Node-side HTTP proxy (avoids CORS in renderer) ───────────────────────────

function nodeRequest(url, method, headers, body, agentOrOpts) {
  let agent = null;
  let timeoutMs = 120_000;
  if (agentOrOpts != null) {
    if (typeof agentOrOpts === 'object' && (agentOrOpts.timeoutMs != null || agentOrOpts.agent != null)) {
      agent = agentOrOpts.agent || null;
      if (agentOrOpts.timeoutMs != null) timeoutMs = agentOrOpts.timeoutMs;
    } else if (agentOrOpts instanceof http.Agent || agentOrOpts instanceof https.Agent) {
      agent = agentOrOpts;
    }
  }
  return new Promise((resolve) => {
    const u = new URL(url);
    const mod = u.protocol === 'https:' ? https : http;
    const opts = {
      hostname: u.hostname,
      port: u.port || (u.protocol === 'https:' ? 443 : 80),
      path: u.pathname + (u.search || ''),
      method, headers, timeout: timeoutMs,
      ...(agent ? { agent } : {}),
    };
    const req = mod.request(opts, (res) => {
      const chunks = [];
      res.on('data', (d) => chunks.push(d));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString() }));
      res.on('error', (e) => resolve({ status: 0, body: e.message }));
    });
    req.on('error', (e) => resolve({ status: 0, body: e.message }));
    req.on('timeout', () => { req.destroy(); resolve({ status: 0, body: 'Request timeout' }); });
    if (body) req.write(body);
    req.end();
  });
}

// ── IPC handlers ──────────────────────────────────────────────────────────────

function registerIPC() {
  const billingConfigMod = require('./billing-config');
  ipcMain.on('tray:lang',  (_e, lang)      => { _trayLang = lang === 'en' ? 'en' : 'zh'; refreshTray(); });
  ipcMain.on('tray:auth',  (_e, loggedIn)  => {
    _trayUserLoggedIn = !!loggedIn;
    if (!loggedIn) {
      gateway.setUserAuth(null);
      stopAgent();
    }
    refreshTray();
  });
  ipcMain.handle('gateway:setUserAuth', (_e, jwt) => {
    gateway.setUserAuth(jwt || null);
    try {
      const cfg = readLocalConfig();
      if (jwt) cfg.user_session = { jwt };
      else delete cfg.user_session;
      writeLocalConfig(cfg);
    } catch {}
    return { ok: true };
  });
  ipcMain.on('app:version', (e) => { e.returnValue = app.getVersion(); });
  ipcMain.on('app:defaultServerUrl', (e) => { e.returnValue = defaultServerUrlFromEnv(); });
  // 设备注册用：系统电脑名 + macOS/Windows 版本说明
  ipcMain.on('app:getDeviceIdentity', (e, opts) => {
    e.returnValue = deviceIdentity.collect({
      type: 'desktop',
      version: app.getVersion(),
      customName: opts?.customName || '',
    });
  });
  ipcMain.handle('agent:start',   () => { startAgent(); return { running: agent.isRunning() }; });
  ipcMain.handle('agent:stop',    () => { stopAgent();  return { running: false }; });
  ipcMain.handle('agent:status',  () => ({ running: agent.isRunning() }));
  ipcMain.handle('agent:getLogs', () => [..._agentLogBuf]);
  ipcMain.handle('config:read',  () => readAgentConfig());
  ipcMain.handle('config:write', (_e, cfg) => { writeAgentConfig(cfg); return { ok: true }; });
  ipcMain.handle('config:scan',  () => scanLLMConfigs());
  ipcMain.handle('config:importKeys', () => scanProviderKeys());

  // ── 供给源 OAuth 订阅登录（Claude / Codex / Google / Copilot）──────────────
  // PKCE 流：start 返回 authUrl，用户浏览器授权后粘贴 code，exchange 换 credentials。
  // 设备码流（codex/copilot）：start 返回 userCode+verificationUrl，poll 轮询。
  const oauthMod = require('./oauth');
  const _oauthSessions = new Map(); // sessionId -> { provider, session, created }
  function gcOauthSessions() {
    const now = Date.now();
    for (const [k, v] of _oauthSessions) if (now - v.created > 30 * 60 * 1000) _oauthSessions.delete(k);
  }
  ipcMain.handle('oauth:start', async (_e, { provider, setupToken } = {}) => {
    gcOauthSessions();
    const mod = oauthMod.getModule(provider);
    if (!mod) throw new Error('unsupported oauth provider: ' + provider);
    const r = await mod.startLogin({ setupToken });
    const sessionId = require('crypto').randomUUID();
    _oauthSessions.set(sessionId, { provider, session: r.session, created: Date.now() });
    return { sessionId, mode: mod.mode, authUrl: r.authUrl || null,
             userCode: r.userCode || null, verificationUrl: r.verificationUrl || null };
  });
  ipcMain.handle('oauth:exchange', async (_e, { sessionId, code } = {}) => {
    const s = _oauthSessions.get(sessionId);
    if (!s) throw new Error('session 不存在或已过期，请重新登录');
    const mod = oauthMod.getModule(s.provider);
    const credentials = await mod.completeLogin(s.session, code);
    _oauthSessions.delete(sessionId);
    return { ok: true, oauth_provider: s.provider, credentials, email: credentials.email || '' };
  });
  // 设备码流轮询（codex/copilot 用；PKCE 流不需要）
  ipcMain.handle('oauth:poll', async (_e, { sessionId } = {}) => {
    const s = _oauthSessions.get(sessionId);
    if (!s) throw new Error('session 不存在或已过期');
    const mod = oauthMod.getModule(s.provider);
    if (typeof mod.poll !== 'function') throw new Error('provider 不支持轮询');
    const result = await mod.poll(s.session);
    if (result && result.credentials) {
      _oauthSessions.delete(sessionId);
      return { ok: true, done: true, oauth_provider: s.provider, credentials: result.credentials, email: result.credentials.email || '' };
    }
    return { ok: true, done: false, status: (result && result.status) || 'pending' };
  });
  ipcMain.handle('oauth:openExternal', (_e, { url } = {}) => { if (url) shell.openExternal(url); return { ok: true }; });

  // 订阅用量额度抓取（复用 oauth 凭证；provider 条目存在 agent config ~/.llm-agent/config.json）
  const usageMod = require('./usage');
  const usageDeps = { getCfg: readAgentConfig, saveCfg: writeAgentConfig };
  ipcMain.handle('usage:fetch', async (_e, { provider } = {}) => {
    const cfg = readAgentConfig() || {};
    const list = Array.isArray(cfg.providers) ? cfg.providers : [];
    const entry = list.find(p => p && (p.id === provider
      || (p.auth_type === 'oauth' && p.oauth_provider === provider)));
    if (!entry) return { error: 'provider_not_found' };
    return usageMod.fetchUsage(entry, usageDeps);
  });
  ipcMain.handle('usage:fetchAll', async () => usageMod.fetchAllUsage(usageDeps));
  // 应用列表切换路由（纳管/还原 Claude Desktop）时前端可主动触发一次会话同步（不等 30s 定时）
  ipcMain.handle('claude3p:sync', () => { runClaude3pSync('app-switch'); return { ok: true }; });

  // Write Claude Code config into ~/.claude/settings.json（用户级设置；Claude Code 实际读取的就是这个，
  // settings.local.json 是「项目级」约定，写在 ~/.claude 下不会被读取）
  ipcMain.handle('claude:configure', async (_e, { baseUrl, apiKey, models = [] }) => {
    const settingsPath = path.join(os.homedir(), '.claude', 'settings.json');
    let settings = {};
    try { settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8')); } catch {}
    settings.env = settings.env || {};
    settings.env.ANTHROPIC_BASE_URL = baseUrl;
    settings.env.ANTHROPIC_AUTH_TOKEN = apiKey;

    // Map available models to Claude tier env vars
    // Claude Code uses these to select models per task complexity
    if (models.length > 0) {
      const fast   = models[0];
      const mid    = models[Math.min(1, models.length - 1)];
      const heavy  = models[Math.min(2, models.length - 1)];
      settings.env.ANTHROPIC_DEFAULT_HAIKU_MODEL   = fast;
      settings.env.ANTHROPIC_DEFAULT_SONNET_MODEL  = mid;
      settings.env.ANTHROPIC_DEFAULT_OPUS_MODEL    = heavy;
      // Also write MODELS so other tools can discover them
      settings.env.MODELS = models.join(',');
    }

    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
    fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2), 'utf-8');
    return { ok: true };
  });

  // Read current Claude Code config status
  ipcMain.handle('claude:status', () => {
    const settingsPath = path.join(os.homedir(), '.claude', 'settings.json');
    try {
      const s = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
      return { configured: !!(s.env?.ANTHROPIC_BASE_URL && s.env?.ANTHROPIC_AUTH_TOKEN) };
    } catch { return { configured: false }; }
  });

  // Buffered HTTP request (for models list, non-streaming chat)
  ipcMain.handle('llm:fetch', async (_e, { url, method = 'GET', headers = {}, body, timeoutMs }) => {
    return nodeRequest(url, method, headers, body, timeoutMs != null ? { timeoutMs } : undefined);
  });

  // 登录 / 注册 / profile：走主进程 HTTP，避免系统代理拦截
  ipcMain.handle('auth:request', async (_e, { base, method = 'GET', path, body, token }) => {
    const url = `${String(base).replace(/\/$/, '')}${path.startsWith('/') ? path : `/${path}`}`;
    const headers = { 'Content-Type': 'application/json' };
    if (token) headers.Authorization = `Bearer ${token}`;
    const payload = body != null ? JSON.stringify(body) : null;
    return nodeRequest(url, method, headers, payload);
  });

  // Streaming HTTP request — sends chunks back via webContents events
  ipcMain.on('llm:stream', (event, { reqId, url, method, headers, body }) => {
    const u = new URL(url);
    const mod = u.protocol === 'https:' ? https : http;
    const opts = {
      hostname: u.hostname,
      port: u.port || (u.protocol === 'https:' ? 443 : 80),
      path: u.pathname + (u.search || ''),
      method, headers, timeout: 120000,
    };
    const send = (ch, data) => { if (!event.sender.isDestroyed()) event.sender.send(ch, data); };
    const req = mod.request(opts, (res) => {
      res.on('data', (chunk) => send('llm:stream-chunk', { reqId, data: chunk.toString() }));
      res.on('end', () => send('llm:stream-done', { reqId }));
      res.on('error', (e) => send('llm:stream-error', { reqId, error: e.message }));
    });
    req.on('error', (e) => send('llm:stream-error', { reqId, error: e.message }));
    req.on('timeout', () => { req.destroy(); send('llm:stream-error', { reqId, error: 'Request timeout' }); });
    if (body) req.write(body);
    req.end();
  });

  ipcMain.handle('update:install', () => {
    pendingUpdateReady = null;
    // 关闭窗口默认隐藏到托盘；安装更新须真正退出进程
    isQuitting = true;
    setImmediate(() => {
      autoUpdater.quitAndInstall(false, true);
    });
  });

  ipcMain.handle('updater:status', () => ({
    ready: !!pendingUpdateReady,
    version: pendingUpdateReady?.version ?? null,
  }));

  ipcMain.handle('updater:getSettings', () => ({
    enabled: !isDev,
    currentVersion: app.getVersion(),
    allowPrerelease: readUpdaterAllowPrerelease(),
    ready: !!pendingUpdateReady,
    pendingVersion: pendingUpdateReady?.version ?? null,
  }));

  ipcMain.handle('updater:setAllowPrerelease', (_e, allow) => ({
    allowPrerelease: persistUpdaterAllowPrerelease(!!allow),
  }));

  ipcMain.handle('updater:checkNow', async () => {
    if (isDev) return { status: 'dev', message: 'dev mode' };
    if (!updaterEventsBound) {
      applyUpdaterAllowPrerelease();
      bindUpdaterEvents();
    } else {
      applyUpdaterAllowPrerelease();
    }
    return checkForUpdatesAndWait();
  });

  ipcMain.handle('gateway:status',        () => gateway.getStatus());
  ipcMain.handle('gateway:getLog',        () => gateway.getLog());
  ipcMain.handle('gateway:speedMap',      () => {
    try {
      const ps = require('./provider-speed');
      let latency = {};
      try { latency = localStats.queryModelProviderLatency(localStats.sinceTsForDays(7)); } catch {}
      return ps.getSpeedMapWithLatency(latency);   // 被动/探针测速 + 历史请求延迟兜底
    } catch { return {}; }
  });
  // 主动测速探针：发个极小请求走本地网关（按真实模型名路由，非 claude 名不会被 keyScene 改写），
  // 请求跑完网关内部自动 record 记速。返回 {ok,status,latencyMs}。会消耗一次真实调用（P2P 扣积分）。
  ipcMain.handle('gateway:probeModel', (_e, model) => probeModelViaGateway(model));
  ipcMain.handle('gateway:restart',       () => gateway.restart());
  ipcMain.handle('localStats:compression', (_e, days) => {
    const d = Math.max(1, Math.min(365, parseInt(days, 10) || 1));
    try {
      const since = localStats.sinceTsForDays(d);
      const rates = localStats.queryGatewayInputCostRate(since);
      return require('./compression-report').readCompressionSummary(d, rates);
    }
    catch (e) { console.error('[localStats:compression]', e.message); return { count: 0, before: 0, after: 0, saved: 0, ratio: 0, saved_usd: 0, models: [] }; }
  });
  ipcMain.handle('localStats:todaySummary', () => {
    try { return localStats.queryTodaySummary(); }
    catch (e) { console.error('[localStats:todaySummary]', e.message); return { inTok: 0, outTok: 0, totalTokens: 0, calls: 0 }; }
  });
  ipcMain.handle('localStats:query', (_e, days) => {
    const d = Math.max(1, Math.min(365, parseInt(days, 10) || 1));
    const data = localStats.queryDashboard(d);
    // 按应用聚合（合并网关实时 + 会话补录），供「应用用量分布」按应用分组、判定网关/订阅/混合徽章
    try {
      const apps = getApps().filter(a => !a.draft);
      data.app_usage = apps.map(app => {
        const st = localStats.queryAppStatsInPeriod({
          appId: app.id,
          apiKey: app.api_key,
          dataSource: appSessionDataSource(app),
          days: d,
        });
        return {
          id: app.id,
          name: app.name,
          icon: app.icon || '🔧',
          calls: st.calls,
          tokens: st.tokens,
          proxyCalls: st.proxyCalls,
          sessionCalls: st.sessionCalls,
        };
      }).filter(a => a.calls > 0).sort((a, b) => b.calls - a.calls);
    } catch { data.app_usage = []; }
    return data;
  });
  ipcMain.handle('localStats:modelLatency', (_e, days) => {
    const d = Math.max(1, Math.min(365, parseInt(days, 10) || 7));
    try {
      const since = localStats.sinceTsForDays(d);
      return localStats.queryModelProviderLatency(since);
    } catch (e) {
      console.error('[localStats:modelLatency]', e.message);
      return {};
    }
  });
  ipcMain.handle('localStats:reassignProviderTier', (_e, providerId, tier) => {
    try {
      const result = localStats.reassignProviderTier(providerId, tier);
      if (result.updated > 0) {
        try { mainWindow?.webContents?.send('localStats:changed'); } catch {}
      }
      return result;
    } catch (e) {
      console.error('[localStats:reassignProviderTier]', e.message);
      return { updated: 0, error: e.message };
    }
  });
  // 手动触发会话文件补录（扫 ~/.claude、~/.codex、~/.gemini），返回各来源计数
  ipcMain.handle('sessionImport:run', () => syncSessionTelemetry(localStats));
  // 探测本机 AI 工具/本地服务，返回是否已接入网关的清单
  ipcMain.handle('detectTools:scan', async () => {
    const r = await detectTools.scan();
    return { ...r, scannedAt: Math.floor(Date.now() / 1000) };
  });
  // ── CLI 透明接入（配置驱动）：list/apply/revert ──
  // 记录/解除用户对某 agent 的「取消自动托管」标记
  function setAutoHostDisabled(agentId, disabled) {
    const cfg = readLocalConfig();
    const set = new Set(cfg.auto_host_disabled || []);
    if (disabled) set.add(agentId); else set.delete(agentId);
    cfg.auto_host_disabled = [...set];
    writeLocalConfig(cfg);
  }

  ipcMain.handle('agents:list',    () => agentLinker.list());
  // 手动托管：清除禁用标记后接入
  ipcMain.handle('agents:apply',   (_e, id) => { setAutoHostDisabled(id, false); return agentLinker.applyById(id); });
  // 手动取消托管：打上禁用标记，自动托管不再重新接入
  ipcMain.handle('agents:revert',  (_e, id) => { setAutoHostDisabled(id, true); return agentLinker.revertById(id); });
  ipcMain.handle('agents:applyAll',  () => {
    // 一键托管：清空所有禁用标记后全部接入
    const cfg = readLocalConfig();
    cfg.auto_host_disabled = [];
    writeLocalConfig(cfg);
    return agentLinker.applyAll();
  });
  ipcMain.handle('agents:revertAll', () => {
    // 全部取消托管：把所有工具加入禁用标记
    const cfg = readLocalConfig();
    cfg.auto_host_disabled = agentLinker.list().map(t => t.id);
    writeLocalConfig(cfg);
    return agentLinker.revertAll();
  });

  // ── 配置导入（统一格式，tools 段 + scene_routes 段，各自写入对应存储）────────
  // 格式：{ version, tools, protocols, mitm, routing, scene_routes, ... }
  // tools/protocols/mitm/routing 段 → ~/.tokenbank/tokenbank.yaml（config-loader）
  // scene_routes 段               → local-config.scene_routes
  const configLoader = require('./config-loader');
  const TB_TOOLS_YAML = path.join(os.homedir(), '.tokenbank', 'tokenbank.tools.yaml');
  const USER_REGISTRY_YAML = path.join(os.homedir(), '.tokenbank', 'providers.registry.yaml');
  // 应用段 → tokenbank.yaml；源目录 → providers.registry.yaml（废弃 tokenbank.tools.yaml）
  const APP_SECTIONS = new Set(['version', 'gateway', 'mitm', 'claude_models', 'app_entities', 'session_scans', 'handlers']);
  const SOURCE_SECTIONS = new Set(['subscription_plans', 'subscription_apps', 'api_subscription_apps', 'payg_providers']);
  const ROUTES_SECTIONS = new Set(['scene_routes']);

  /** 写入云端下发的 providers.registry.yaml，并删除旧 tokenbank.tools.yaml */
  function applyRegistryDoc(parsed, opts = {}) {
    const yamlLib = require('js-yaml');
    const tbDir = path.join(os.homedir(), '.tokenbank');
    if (!fs.existsSync(tbDir)) fs.mkdirSync(tbDir, { recursive: true });
    // 服务端旧库可能只有 providers，补全 billing_sources 避免个人源目录为空
    let doc = parsed && typeof parsed === 'object' ? { ...parsed } : {};
    try {
      const existing = fs.existsSync(USER_REGISTRY_YAML)
        ? yamlLib.load(fs.readFileSync(USER_REGISTRY_YAML, 'utf8')) || {}
        : {};
      const builtin = yamlLib.load(
        fs.readFileSync(path.join(__dirname, 'config', 'providers.registry.yaml'), 'utf8'),
      ) || {};
      if (!Array.isArray(doc.billing_sources) || !doc.billing_sources.length) {
        doc.billing_sources = (existing.billing_sources?.length && existing.billing_sources)
          || builtin.billing_sources
          || [];
      }
    } catch (e) {
      console.warn('[config] merge billing_sources failed:', e.message);
    }
    fs.writeFileSync(USER_REGISTRY_YAML, yamlLib.dump(doc, { lineWidth: 120 }), 'utf8');
    try { if (fs.existsSync(TB_TOOLS_YAML)) fs.unlinkSync(TB_TOOLS_YAML); } catch {}
    configLoader.reloadRegistryDoc();
    try {
      const cfg = readLocalConfig();
      const { cfg: pruned, changed } = billingConfigMod.pruneLocalBillingAgainstServer(cfg);
      if (changed) {
        applyUserBillingCfg(pruned);
        console.log('[config] 已按服务端 registry 清理本地过期计费数据');
      }
    } catch (e) {
      console.warn('[config] prune local billing failed:', e.message);
    }
    try { mainWindow?.webContents?.send('billing:changed'); } catch {}
    try { mainWindow?.webContents?.send('catalog:updated'); } catch {}
    return { ok: true, applied: { registry: true } };
  }

  function applyConfigDoc(parsed, source, opts = {}) {
    if (!parsed || typeof parsed !== 'object') return { ok: false, error: '无效的 yaml 格式' };
    const yamlLib = require('js-yaml');
    const replace = opts.replace === true;
    const applied = { tools: false, routes: false, registry: false };
    const addedApps = [];   // 本次同步「新增」的工具/应用（id 之前没有、现在有）

    // providers.registry 格式（云端唯一下发源目录）
    const isRegistryDoc = Array.isArray(parsed.providers) || Array.isArray(parsed.billing_sources);
    const hasAppSection = Object.keys(parsed).some(k => APP_SECTIONS.has(k) && k !== 'version');
    if (isRegistryDoc && !hasAppSection) {
      const r = applyRegistryDoc(parsed, opts);
      applied.registry = true;
      // 同文件内若带 scene_routes 继续处理（少见）
      if (Array.isArray(parsed.scene_routes) && parsed.scene_routes.length > 0) {
        // fall through to routes handling below — 简化：registry 下发通常不含 routes
      } else {
        return { ...r, applied, addedApps, addedRoutes: [] };
      }
    }

    // 应用段 → tokenbank.yaml
    const hasSourceSection = Object.keys(parsed).some(k => SOURCE_SECTIONS.has(k));
    if (hasAppSection || hasSourceSection) {
      const tbDir = path.join(os.homedir(), '.tokenbank');
      if (!fs.existsSync(tbDir)) fs.mkdirSync(tbDir, { recursive: true });
      // 应用前：记录现有工具 + api-key 应用的 id 集合（用于算新增）
      const beforeIds = new Set();
      try {
        for (const t of configLoader.tools()) beforeIds.add('tool:' + t.id);
        for (const a of (configLoader.apiKeyApps() || [])) beforeIds.add('app:' + a.id);
        for (const s of (configLoader.sessionSources() || [])) {
          if (s.direct_only) beforeIds.add('direct:' + s.id);
        }
      } catch {}
      // replace=true：服务端全量覆盖；否则与本地文件合并
      const writeMerged = (file, sectionSet) => {
        let doc;
        if (replace) {
          doc = { version: parsed.version || 1 };
          for (const k of Object.keys(parsed)) {
            if (sectionSet.has(k) || k === 'version') doc[k] = parsed[k];
          }
        } else {
          let existing = {};
          try { if (fs.existsSync(file)) existing = yamlLib.load(fs.readFileSync(file, 'utf8')) || {}; } catch {}
          doc = { ...existing };
          for (const k of Object.keys(parsed)) {
            if (sectionSet.has(k) || k === 'version') doc[k] = parsed[k];
          }
        }
        fs.writeFileSync(file, yamlLib.dump(doc, { lineWidth: 120 }), 'utf8');
      };
      if (hasAppSection) writeMerged(TB_YAML, APP_SECTIONS);
      // 旧 tokenbank.tools.yaml 格式已废弃，不再写入；请通过 GET /config/providers 同步
      if (hasSourceSection) {
        console.warn('[config] 收到旧 config.sources 格式，已忽略；请升级服务端并使用 /config/providers');
      }
      configLoader.load();
      applied.tools = true;

      // 应用后：算出新增的工具/应用（id 在 before 集合里没有的）
      try {
        for (const t of configLoader.tools()) if (!beforeIds.has('tool:' + t.id)) addedApps.push(t.name || t.id);
        for (const a of (configLoader.apiKeyApps() || [])) if (!beforeIds.has('app:' + a.id)) addedApps.push(a.name || a.id);
        for (const s of (configLoader.sessionSources() || [])) {
          if (s.direct_only && !beforeIds.has('direct:' + s.id)) addedApps.push(s.app_name || s.id);
        }
      } catch {}

      // 通知渲染进程刷新应用列表（让新的可配置行 / 托管状态立即显示）
      try { mainWindow?.webContents?.send('apps:changed'); } catch {}
    }

    // 路由配置（scene_routes）→ 写入 local-config
    const hasScenes  = Array.isArray(parsed.scene_routes) && parsed.scene_routes.length > 0;
    const addedRoutes = [];   // 本次同步「新增」的场景路由（本地没有、server 有）
    if (hasScenes) {
      const cfg = readLocalConfig();
      const now = new Date().toISOString();
      const local = cfg.scene_routes || [];
      const localKeys = new Set();
      for (const r of local) { if (r.id) localKeys.add(r.id); if (r.model_key) localKeys.add(r.model_key); }
      // replace=true（服务端全量同步）：按 id 合并更新 steps 等字段，保留用户自建路由
      if (opts.replace === true) {
        const byId = new Map();
        for (const r of local) { if (r.id) byId.set(r.id, r); }
        for (const r of parsed.scene_routes) {
          if (!r.id) continue;
          const existing = byId.get(r.id);
          if (existing) {
            Object.assign(existing, r);
          } else {
            byId.set(r.id, { ...r, created_at: r.created_at || now });
            addedRoutes.push(r.scene_name || r.model_key || r.id);
          }
        }
        cfg.scene_routes = [...byId.values()];
      } else {
        const newFromServer = parsed.scene_routes
          .filter(r => !localKeys.has(r.id) && !localKeys.has(r.model_key))
          .map(r => ({ ...r, created_at: r.created_at || now }));
        for (const r of newFromServer) addedRoutes.push(r.scene_name || r.model_key || r.id);
        cfg.scene_routes = [...local, ...newFromServer];
      }
      cfg.initialized_routes = true;
      writeLocalConfig(cfg);
      syncGatewayFromConfig(cfg);
      applied.routes = true;
    }

    // 工具配置变更后（claude_models / 计费目录可能更新）→ 同步给网关与刊例价
    if (applied.tools) {
      try { gateway.setClaudeModels(configLoader.claudeModels()); } catch {}
      try {
        const cfg = readLocalConfig();
        require('./billing-config').applyPricingOverrides(cfg.provider_pricing_overrides || {});
      } catch {}
      // 通知前端刷新个人页报价 / 订阅目录
      try { mainWindow?.webContents?.send('billing:changed'); } catch {}
    }

    if (!applied.tools && !applied.routes) {
      return { ok: false, error: '文件中未找到可识别的配置段（app_entities / scene_routes）' };
    }
    return { ok: true, source, applied, addedApps, addedRoutes };
  }

  function fetchYaml(url, token) {
    const https = require('https'); const http = require('http');
    return new Promise((resolve, reject) => {
      const mod = url.startsWith('https') ? https : http;
      // /config/apps 公开；sources/scenes 等仍可选带 JWT
      const opts = { timeout: 10000, headers: token ? { Authorization: `Bearer ${token}` } : {} };
      mod.get(url, opts, res => {
        let data = '';
        res.on('data', c => data += c);
        res.on('end', () => {
          if (res.statusCode && res.statusCode >= 400) {
            const hint = res.statusCode === 401
              ? '请确认已登录（此接口需要鉴权）'
              : '请确认服务器已上传配置';
            reject(new Error(`服务器返回 HTTP ${res.statusCode}（${hint}）`));
          } else {
            resolve(data);
          }
        });
        res.on('error', reject);
      }).on('error', reject);
    });
  }

  ipcMain.handle('toolsConfig:load', () => {
    try {
      if (fs.existsSync(TB_YAML)) return { ok: true, source: 'user', text: fs.readFileSync(TB_YAML, 'utf8') };
      const def = path.join(__dirname, 'config', 'tokenbank.default.yaml');
      return { ok: true, source: 'default', text: fs.existsSync(def) ? fs.readFileSync(def, 'utf8') : '' };
    } catch (e) { return { ok: false, error: e.message }; }
  });

  ipcMain.handle('toolsConfig:importFile', async () => {
    const { dialog } = require('electron');
    const result = await dialog.showOpenDialog(mainWindow, {
      title: '导入配置文件（工具 / 路由）', filters: [{ name: 'YAML', extensions: ['yaml', 'yml'] }],
      properties: ['openFile'],
    });
    if (result.canceled || !result.filePaths.length) return { ok: false, canceled: true };
    try {
      const text = fs.readFileSync(result.filePaths[0], 'utf8');
      const parsed = require('js-yaml').load(text);
      return applyConfigDoc(parsed, result.filePaths[0]);
    } catch (e) { return { ok: false, error: e.message }; }
  });

  /** 从 Token Bank 服务端拉取 apps / providers.registry / scenes 配置 */
  async function pullServerConfig(serverUrl, token, { replace = false } = {}) {
    const base = String(serverUrl || '').replace(/\/$/, '').replace(/\/(api|v\d+)(\/.*)?$/, '');
    if (!base) return { ok: false, error: 'missing_server' };
    const results = [];
    for (const ep of ['/api/config/apps', '/api/config/providers', '/api/config/scenes']) {
      const url = base + ep;
      const isPublicApps = ep === '/api/config/apps';
      if (!isPublicApps && !token) {
        results.push({ endpoint: ep, ok: false, error: 'missing_auth' });
        continue;
      }
      try {
        const text = await fetchYaml(url, isPublicApps ? (token || null) : token);
        const parsed = require('js-yaml').load(text);
        const shouldReplace = replace && (ep.includes('/apps') || ep.includes('/providers') || ep.includes('/scenes'));
        const r = applyConfigDoc(parsed, url, { replace: shouldReplace });
        results.push({ endpoint: ep, ...r });
      } catch (e) {
        results.push({ endpoint: ep, ok: false, error: e.message });
      }
    }
    return { ok: results.some(r => r.ok), results };
  }

  ipcMain.handle('toolsConfig:importUrl', async (_e, arg) => {
    // 兼容旧签名（字符串 url）与新签名（{ url, token, replace }）
    const url     = typeof arg === 'string' ? arg : arg?.url;
    const token   = typeof arg === 'string' ? null : arg?.token;
    const replace = typeof arg === 'string' ? false : !!arg?.replace;
    try {
      const text = await fetchYaml(url, token);
      const parsed = require('js-yaml').load(text);
      const u = String(url || '');
      const isServerCatalog = u.includes('/config/apps') || u.includes('/config/providers');
      return applyConfigDoc(parsed, url, { replace: replace || isServerCatalog });
    } catch (e) { return { ok: false, error: e.message }; }
  });

  ipcMain.handle('toolsConfig:syncRemote', async (_e, { token, serverUrl, replace = true } = {}) => {
    return pullServerConfig(serverUrl, token, { replace });
  });

  ipcMain.handle('toolsConfig:reset', () => {
    try {
      if (fs.existsSync(TB_YAML)) fs.unlinkSync(TB_YAML);
      configLoader.load();
      return { ok: true };
    } catch (e) { return { ok: false, error: e.message }; }
  });
  ipcMain.handle('gateway:setStrategy', (_e, strategy) => {
    if (strategy !== 'cost' && strategy !== 'quality') return { ok: false, error: 'invalid_strategy' };
    gateway.setStrategy(strategy);
    return { ok: true };
  });

  // ── Local Config (scene routes + local keys, stored in userData) ─────────────

  function rndHex(bytes) {
    return require('crypto').randomBytes(bytes).toString('hex');
  }

  function syncGatewayFromConfig(cfg) {
    const routes = cfg.scene_routes || [];
    const apps   = cfg.apps         || [];
    // llm-router-* → scene steps（从 scene_routes 生成）
    const routerMap = {};
    for (const r of routes) {
      if (r.model_key && (r.steps?.length || r.rules?.length)) {
        const entry = { steps: r.steps || [], scene_name: r.scene_name, rules: r.rules || null, classifier: r.classifier || null };
        routerMap[r.model_key] = entry;
        if (r.id && r.id !== r.model_key) routerMap[r.id] = entry;
      }
    }
    // manual / api-key apps: if model_intercept is set, redirect that incoming model name to the configured route
    const { parseRouteBinding } = require('../shared/route-binding');
    for (const app of apps) {
      if (app.model_intercept && app.route_id) {
        const parsed = parseRouteBinding(app.route_id, routes);
        if (parsed.isScene && parsed.scene) {
          const s = parsed.scene;
          routerMap[app.model_intercept] = { steps: s.steps || [], scene_name: s.scene_name, rules: s.rules || null, classifier: s.classifier || null };
        } else {
          const modelId = parsed.modelId || app.route_id;
          routerMap[app.model_intercept] = { steps: [{ model: modelId, ...(parsed.tier ? { tier: parsed.tier } : {}) }], scene_name: app.name || modelId, rules: null, classifier: null };
        }
      }
    }
    gateway.setRouterModelMap(routerMap);
    // api key → route（从 apps 生成，替代旧的 local_keys）
    // ── 请求控制：api-key 按 key 匹配，shim 按协议路径匹配 ──────────────────────
    const PROTOCOL_PATH = {
      anthropic: '/v1/messages',
      responses: '/v1/responses',
      openai:    '/v1/chat/completions',
      gemini:    '/v1beta',
    };
    // agent_id → protocol（来自 tools 配置）
    const toolProto = {};
    let appEntityById = () => null;
    try {
      const cl = require('./config-loader');
      appEntityById = (id) => cl.appEntityById(id);
      for (const t of cl.tools()) toolProto[t.id] = t.protocol;
    } catch {}

    const appControls = [];
    const keyScene = {};
    const codexGptFallback = {};   // Codex 内建 gpt-* 辅助模型 → 兜底到该应用绑定的主路由（按 api_key）
    const { bindClaudeRoutesToKeyScene, bindRouteToKeyScene } = require('../shared/route-binding');
    for (const app of apps) {
      const ctrl = { app_id: app.id, app_name: app.name };
      const aid = app.agent_id || app.preset_id;
      const ent = aid ? appEntityById(aid) : null;
      const caps = aid ? (() => { try { return require('./config-loader').appCapabilities(aid); } catch { return null; } })() : null;
      const gwProxy = caps ? !!caps.gateway_proxy : !!ent?.gateway_proxy;
      // 与 apps:list 的 resolveRouteBindable 一致：无 preset 的 manual 应用仍可按 route_id 绑路由
      const routeBindable = (() => {
        if (!aid) return app.route_bindable !== false;
        if (app.link_method === 'api-key' || app.link_method === 'manual' || app.link_method === 'shim') {
          return gwProxy && (ent ? ent.route_bindable !== false : app.route_bindable !== false);
        }
        if (app.link_method === 'session') {
          const sessCaps = caps || ent?.capabilities || {};
          return !!(sessCaps.session_trace || sessCaps.session_usage_import)
            && (ent ? ent.route_bindable !== false : app.route_bindable !== false);
        }
        return ent ? ent.route_bindable !== false : app.route_bindable !== false;
      })();
      if ((app.link_method === 'api-key' || app.link_method === 'manual' || app.link_method === 'session') && app.api_key) {
        appControls.push({ ...ctrl, match: { key: app.api_key } });
        const appRouteIds = (Array.isArray(app.route_ids) && app.route_ids.length)
          ? app.route_ids
          : (app.route_id ? [app.route_id] : []);
        if (appRouteIds.length && routeBindable) {
          // Claude Desktop：claude-* 名（inferenceModels.name）→ 绑定的 route；api_key 仅识别应用，不改写 model
          if (isClaudeDesktopApp(app.id)) {
            const cms = (() => { try { return require('./config-loader').claudeModels(); } catch { return []; } })();
            bindClaudeRoutesToKeyScene(keyScene, appRouteIds, routes, cms);
          }
          // Codex Desktop：它会用自带的 gpt-* 辅助模型（标题/分类等，写死在 App 里、非用户配置）发请求，
          // 网关没有这些模型 → 401。用 gpt 前缀兜底（future-proof：以后升级出新 gpt-* 也自动匹配），
          // 把这类请求转到该 Codex 应用绑定的主路由（route_ids[0]，= 用户在 Codex 里选的模型）。
          if (String(app.preset_id || app.agent_id || app.id || '').includes('codex')) {
            bindRouteToKeyScene(codexGptFallback, app.api_key, appRouteIds[0], routes);
          }
        }
      } else if (app.link_method === 'shim' && app.agent_id) {
        if (!routeBindable || !toolProto[app.agent_id]) continue;
        const path = PROTOCOL_PATH[toolProto[app.agent_id]];
        if (path) appControls.push({ ...ctrl, match: { path } });
      }
    }
    gateway.setAppControls(appControls);
    gateway.setKeySceneMap(keyScene);
    gateway.setCodexGptFallback(codexGptFallback);

    // P2P backend config（登出时也要清空，避免残留 token 继续上报）
    const cc = cfg.cloud_config || {};
    gateway.setBackendConfig({ url: cc.url || null, token: cc.token || null });
    const userJwt = cfg.user_session?.jwt || null;
    gateway.setUserAuth(userJwt);
  }

  // Fetch currently active P2P model names from /v1/models (requires auth, reflects live workers)
  async function fetchPeerModels(backendUrl, cloudToken) {
    if (!backendUrl || !cloudToken) {
      gateway.setPeerModels([]);
      return;
    }
    const url = backendUrl.replace(/\/$/, '') + '/v1/models';
    try {
      const r = await nodeRequest(url, 'GET', { Authorization: `Bearer ${cloudToken}` }, null);
      if (r.status === 200) {
        const data = JSON.parse(r.body);
        const names = (data.data || []).map(m => m.id).filter(Boolean);
        gateway.setPeerModels(names);
      } else {
        console.warn('[main] fetchPeerModels: status', r.status);
        gateway.setPeerModels([]);
      }
    } catch (err) {
      console.warn('[main] fetchPeerModels failed:', err.message);
    }
  }

  // Sync on startup
  const _initCfg = readLocalConfig();
  try {
        require('./billing-config').applyPricingOverrides(_initCfg.provider_pricing_overrides || {});
  } catch {}
  syncGatewayFromConfig(_initCfg);
  fetchPeerModels(_initCfg.cloud_config?.url, _initCfg.cloud_config?.token);

  ipcMain.handle('localConfig:get', () => readLocalConfig());

  // 供给源目录：后台拉 /api/catalog 写 yaml，UI 读本地 yaml
  const catalogSync = require('./catalog-sync');

  function notifyCatalogUpdated() {
    try { mainWindow?.webContents?.send('catalog:updated'); } catch {}
    try { mainWindow?.webContents?.send('billing:changed'); } catch {}
  }

  ipcMain.handle('localConfig:getProviderCatalog', () => catalogSync.readCatalogFromYaml());
  ipcMain.handle('localConfig:getBuiltinCatalog', () => {
    const configLoader = require('./config-loader');
    return configLoader.builtinCatalogPayload();
  });
  ipcMain.handle('localConfig:syncProviderCatalog', async () => {
    const cfg = readLocalConfig();
    const result = await catalogSync.syncCatalogToRegistry({
      readLocalConfig,
      applyUserBillingCfg,
      onApplied: notifyCatalogUpdated,
      token: cfg?.user_session?.jwt || null,
      serverUrl: resolveBillingServerUrl(),
    });
    return result;
  });

  // 个人页计费：云端同步辅助
  const cloudBilling = require('./cloud-billing-sync');

  /** 解析 Token Bank 服务地址：优先调用方传入，其次 cloud_config.url，最后 env */
  function resolveBillingServerUrl(serverUrl) {
    const explicit = cloudBilling.normalizeBase(serverUrl);
    if (explicit) return explicit;
    const cfg = readLocalConfig();
    const fromCfg = cloudBilling.normalizeBase(cfg?.cloud_config?.url);
    if (fromCfg) return fromCfg;
    return defaultServerUrlFromEnv();
  }

  function applyUserBillingCfg(cfg, overrides) {
    billingConfigMod.applyPricingOverrides(overrides || cfg.provider_pricing_overrides || {});
    writeLocalConfig(cfg);
    syncAgentProviderModelsFromAccounts();
  }

  // 启动时后台拉 /api/catalog 同步供给源（非阻塞；无 cloud_config 时用 env 默认地址）
  catalogSync.scheduleBackgroundSync({
    readLocalConfig,
    applyUserBillingCfg,
    onApplied: notifyCatalogUpdated,
    token: _initCfg.user_session?.jwt || null,
    serverUrl: resolveBillingServerUrl(),
  });

  async function pullUserBilling(_auth = {}) {
    const cfg = readLocalConfig();
    applyUserBillingCfg(cfg);
    return cfg;
  }

  async function pushUserBilling({ token, serverUrl, ...patch } = {}) {
    let cfg = readLocalConfig();
    if (Array.isArray(patch.user_subscriptions)) cfg.user_subscriptions = patch.user_subscriptions;
    if (Array.isArray(patch.user_payg_providers)) cfg.user_payg_providers = patch.user_payg_providers;
    if (patch.subscription_plans && typeof patch.subscription_plans === 'object') {
      cfg.subscription_plans = patch.subscription_plans;
    }
    if (patch.provider_pricing_overrides && typeof patch.provider_pricing_overrides === 'object') {
      cfg.provider_pricing_overrides = patch.provider_pricing_overrides;
    }
    if (patch.source_template_overrides && typeof patch.source_template_overrides === 'object') {
      cfg.source_template_overrides = patch.source_template_overrides;   // 本地模板覆盖
    }
    if (patch.custom_source_templates && typeof patch.custom_source_templates === 'object') {
      cfg.custom_source_templates = patch.custom_source_templates;       // 自定义源模板（纯本地）
    }
    if (patch.direct_source_billing && typeof patch.direct_source_billing === 'object') {
      cfg.direct_source_billing = patch.direct_source_billing;           // 直连应用计费
    }
    // 个人供给源仅写本机；账户摘要由设备心跳单向上报
    applyUserBillingCfg(cfg);
    return cfg;
  }

  // 订阅套餐 + 模型刊例价（个人页管理）
  ipcMain.handle('localConfig:getBilling', async (_e, auth = {}) => {
    const cfg = await pullUserBilling(auth);
    return billingConfigMod.getBillingSettings(cfg);
  });
  ipcMain.handle('localConfig:setBilling', async (_e, payload = {}) => {
    const { token, serverUrl, subscription_plans, provider_pricing_overrides } = payload;
    const cfg = await pushUserBilling({
      token, serverUrl, subscription_plans, provider_pricing_overrides,
    });
    return billingConfigMod.getBillingSettings(cfg);
  });
  ipcMain.handle('localConfig:resetBilling', async (_e, payload = {}) => {
    const { token, serverUrl, scope } = payload;
    const patch = {};
    if (scope === 'pricing' || scope === 'all') patch.provider_pricing_overrides = {};
    if (scope === 'plans' || scope === 'all') patch.subscription_plans = {};
    const cfg = await pushUserBilling({ token, serverUrl, ...patch });
    return billingConfigMod.getUserAccounts(cfg, { boundDirectAgentIds: boundDirectAgentIds() });
  });

  // 个人页：积分 / 订阅 / 按量付费账户
  // 已绑路由（走网关）的直连应用 agent_id —— 这些从「直连源」里移除（已变成路由源）；
  // 其余 direct_only 源默认都展示，可在「个人源」里设计费。
  function boundDirectAgentIds() {
    try {
      return getApps()
        .filter(a => a && a.link_method === 'direct' && a.route_id)
        .map(a => a.agent_id).filter(Boolean);
    } catch { return []; }
  }
  ipcMain.handle('localConfig:setLiveCatalog', async (_e, payload = {}) => {
    billingConfigMod.setLiveCatalogPayload(payload);
    // 不广播 billing:changed，避免 Providers 页 catalog 拉取 ↔ 账户重载死循环
    return { ok: true };
  });
  ipcMain.handle('localConfig:getUserAccounts', async () => {
    let cfg = readLocalConfig();
    const { cfg: pruned, changed } = billingConfigMod.pruneLocalBillingAgainstServer(cfg);
    if (changed) applyUserBillingCfg(pruned);
    cfg = pruned;
    return billingConfigMod.getUserAccounts(cfg, { boundDirectAgentIds: boundDirectAgentIds() });
  });
  ipcMain.handle('localConfig:setUserAccounts', async (_e, payload = {}) => {
    const cfg = await pushUserBilling(payload);
    return billingConfigMod.getUserAccounts(cfg, { boundDirectAgentIds: boundDirectAgentIds() });
  });
  /** 账户摘要随设备心跳上报；不再 PUT /user/accounts 同步配置 */
  ipcMain.handle('localConfig:pushUserAccountsToCloud', async () => {
    const cfg = readLocalConfig();
    return billingConfigMod.getUserAccounts(cfg, { boundDirectAgentIds: boundDirectAgentIds() });
  });

  ipcMain.handle('localConfig:createSceneRoute', (_e, { scene_name, icon, steps, rules, classifier }) => {
    const cfg   = readLocalConfig();
    const route = {
      id: rndHex(8), scene_name, icon: icon || '🔀',
      steps: steps || [],
      rules: rules || null,           // 条件路由规则（when → steps）
      classifier: classifier || null, // 语义分类器配置
      model_key: 'llm-router-' + rndHex(6),
      created_at: new Date().toISOString(),
    };
    cfg.scene_routes.push(route);
    writeLocalConfig(cfg);
    syncGatewayFromConfig(cfg);
    return route;
  });

  ipcMain.handle('localConfig:updateSceneRoute', (_e, { id, scene_name, icon, steps, rules, classifier }) => {
    const cfg = readLocalConfig();
    const idx = cfg.scene_routes.findIndex(r => r.id === id);
    if (idx === -1) return null;
    cfg.scene_routes[idx] = { ...cfg.scene_routes[idx], scene_name, icon, steps, rules: rules || null, classifier: classifier || null };
    writeLocalConfig(cfg);
    syncGatewayFromConfig(cfg);
    return cfg.scene_routes[idx];
  });

  ipcMain.handle('localConfig:deleteSceneRoute', (_e, id) => {
    const cfg = readLocalConfig();
    cfg.scene_routes = cfg.scene_routes.filter(r => r.id !== id);
    writeLocalConfig(cfg);
    syncGatewayFromConfig(cfg);
    return { ok: true };
  });

  ipcMain.handle('localConfig:createKey', (_e, { note }) => {
    const cfg = readLocalConfig();
    const key = {
      id: rndHex(8),
      key: 'sk-local-' + rndHex(16),
      note: note || '',
      model_key: null,
      created_at: new Date().toISOString(),
    };
    cfg.local_keys.push(key);
    writeLocalConfig(cfg);
    return key;
  });

  ipcMain.handle('localConfig:deleteKey', (_e, id) => {
    const cfg = readLocalConfig();
    cfg.local_keys = cfg.local_keys.filter(k => k.id !== id);
    writeLocalConfig(cfg);
    syncGatewayFromConfig(cfg);
    return { ok: true };
  });

  ipcMain.handle('localConfig:bindKey', (_e, { id, model_key }) => {
    const cfg = readLocalConfig();
    const key = cfg.local_keys.find(k => k.id === id);
    if (!key) return null;
    key.model_key = model_key || null;
    writeLocalConfig(cfg);
    syncGatewayFromConfig(cfg);
    return key;
  });

  // ── 策略组 CRUD（policies[]，UI 管理，存 local-config）─────────────────────
  // 数据结构：{ id, name, strategy, providers: [{id, weight?}], created_at }
  // strategy 枚举：fallback | round-robin | weighted | latency | direct

  function getPolicies() { return readLocalConfig().policies || []; }
  function savePolicies(policies) {
    const cfg = readLocalConfig();
    cfg.policies = policies;
    writeLocalConfig(cfg);
  }

  ipcMain.handle('policies:list', () => getPolicies());

  ipcMain.handle('policies:create', (_e, { name, strategy, providers }) => {
    const policies = getPolicies();
    const policy = {
      id: name.toLowerCase().replace(/[^a-z0-9]+/g, '-'),   // name → kebab-case id
      name: name || 'untitled',
      strategy: strategy || 'fallback',
      providers: (providers || []).map(p =>
        typeof p === 'string' ? { id: p, weight: 1 } : p
      ),
      created_at: new Date().toISOString(),
    };
    // id 冲突时加后缀
    const existing = policies.find(p => p.id === policy.id);
    if (existing) policy.id = policy.id + '-' + rndHex(3);
    policies.push(policy);
    savePolicies(policies);
    return policy;
  });

  ipcMain.handle('policies:update', (_e, { id, name, strategy, providers }) => {
    const policies = getPolicies();
    const idx = policies.findIndex(p => p.id === id);
    if (idx === -1) return { ok: false, error: 'not-found' };
    policies[idx] = {
      ...policies[idx],
      ...(name      !== undefined && { name }),
      ...(strategy  !== undefined && { strategy }),
      ...(providers !== undefined && {
        providers: providers.map(p => typeof p === 'string' ? { id: p, weight: 1 } : p)
      }),
    };
    savePolicies(policies);
    return policies[idx];
  });

  ipcMain.handle('policies:delete', (_e, id) => {
    const policies = getPolicies().filter(p => p.id !== id);
    savePolicies(policies);
    return { ok: true };
  });

  // ── 应用管理 CRUD（apps[]，统一管理托管和API Key应用）────────────────────────
  // 应用结构：{ id, name, icon, link_method(shim|api-key|manual), api_key, route_id,
  //             description, allowed_models[], max_rpm, max_concurrent,
  //             allow_stream, created_at }

  function getApps() {
    const cfg = readLocalConfig();
    return cfg.apps || [];
  }
  function saveApps(apps) {
    const cfg = readLocalConfig();
    cfg.apps = apps;
    writeLocalConfig(cfg);
    syncGatewayFromConfig(cfg);
  }
  // 应用「纳管」状态完全跟随用户操作（持久化在条目里，不靠扫描/匹配配置文件内容）
  function syncCursorHookState(apps) {
    try {
      const appsList = apps || getApps();
      cursorHooks.syncForApps(appsList, process.execPath);
      const cursor = appsList.find(a => a.link_method === 'direct' && a.agent_id === 'cursor');
      // hook 纳管后：清掉 transcript 0 token 脏数据并立即导入已有 hook 事件
      if (cursor?.hosted && cursorHooks.isInstalled()) {
        cursorHooks.purgeTranscriptZeroTokens(localStats);
        const n = cursorHooks.importEvents(localStats);
        if (n > 0) { try { mainWindow?.webContents?.send('apps:changed'); } catch {} }
      }
    } catch (e) {
      console.error('[cursor-hooks] sync failed:', e.message);
    }
  }
  function setAppHosted(appId, hosted) {
    if (!appId) return;
    const apps = getApps();
    const idx = apps.findIndex(a => a.id === appId);
    if (idx === -1) return;
    apps[idx] = { ...apps[idx], hosted: !!hosted };
    saveApps(apps);
    if (apps[idx].agent_id === 'cursor' && apps[idx].link_method === 'direct') {
      syncCursorHookState(apps);
    }
  }

  // 「支持的应用」总览：列出我们支持纳管的全部应用 + 本机是否已安装 + 未装时的官方安装链接。
  // 数据驱动：CLI 工具(tools) / 桌面应用(api_key_apps) / 仅统计(direct_only 会话源) 三类清单并集，
  // 各自复用既有检测逻辑判定 installed；install_url 集中维护官方下载页（无把握的留 null → 前端灰显不可点）。
  ipcMain.handle('apps:supported', () => {
    const configLoader = require('./config-loader');
    const entityMeta = (id) => {
      try { return configLoader.appEntityById(id); } catch { return null; }
    };
    const INSTALL_URLS = configLoader.appInstallUrls();
    const UNINSTALL_URLS = configLoader.appUninstallUrls();
    const INSTALL_GUIDES = configLoader.appInstallGuides();
    const UNINSTALL_GUIDES = configLoader.appUninstallGuides();
    const NPM_PACKAGES = configLoader.appNpmPackages();
    const guide = (map, id) => configLoader.resolveGuide(map[id]);
    // 按 id 合并三分支（CLI / 桌面 / 会话）：同一应用可同时出现在多条分支，
    // 不再"先到先得"丢弃后来的证据 —— 按 id 合并三分支、元数据补空，
    // npm_package 统一按 id 查（任何分支的应用都可能是 npm 命令行装的），有包即可命令行装卸。
    // installed 分强/弱信号聚合：强信号=命令/appx/app 现在确实装着；弱信号=残留配置/会话目录。
    // 有强信号只认强信号（卸载后立即变灰）；无强信号才用弱信号兜底（如纯会话源 WorkBuddy/cursor）。
    const byId = new Map();
    const KIND_RANK = { cli: 3, desktop: 2, session: 1, direct: 1 };
    const merge = (o) => {
      if (!o || !o.id) return;
      if (!o.npm_package) o.npm_package = NPM_PACKAGES[o.id] || null;
      const ex = byId.get(o.id);
      if (!ex) { byId.set(o.id, o); return; }
      ex.sStrongDefined = ex.sStrongDefined || o.sStrongDefined;
      ex.sStrong = ex.sStrong || o.sStrong;
      ex.sWeak = ex.sWeak || o.sWeak;
      for (const k of ['name', 'icon', 'capabilities', 'install_url', 'uninstall_url',
                       'install_guide', 'uninstall_guide', 'npm_package']) {
        if ((ex[k] == null || ex[k] === '') && o[k] != null) ex[k] = o[k];
      }
      if ((KIND_RANK[o.kind] || 0) > (KIND_RANK[ex.kind] || 0)) ex.kind = o.kind;
    };
    try {
      // ① CLI 工具（shim 托管，命令在 PATH）：命令检测=强信号
      for (const tool of agentLinker.list()) {
        const ent = entityMeta(tool.id);
        merge({ id: tool.id, name: ent?.name || tool.name || tool.id, icon: ent?.icon || '🤖',
              capabilities: ent?.capabilities || tool.capabilities || null,
              sStrongDefined: true, sStrong: !!tool.installed, sWeak: false,
              install_url: INSTALL_URLS[tool.id] || null,
              uninstall_url: UNINSTALL_URLS[tool.id] || null,
              install_guide: guide(INSTALL_GUIDES, tool.id),
              uninstall_guide: guide(UNINSTALL_GUIDES, tool.id),
              npm_package: NPM_PACKAGES[tool.id] || null,
              kind: 'cli' });
      }
      // ② 桌面应用（写配置文件）：被管理员禁用(enable_3p:false)的不展示
      for (const d of (configLoader.apiKeyApps() || [])) {
        if (d.enable_3p === false) continue;
        const ent = entityMeta(d.id);
        const det = apiKeyDetect(d);
        merge({ id: d.id, name: ent?.name || d.name || d.id, icon: ent?.icon || d.icon || '🖥️',
              capabilities: ent?.capabilities || d.capabilities || null,
              sStrongDefined: det.strongDefined, sStrong: det.strong, sWeak: det.weak,
              install_url: INSTALL_URLS[d.id] || null,
              uninstall_url: UNINSTALL_URLS[d.id] || null,
              install_guide: guide(INSTALL_GUIDES, d.id),
              uninstall_guide: guide(UNINSTALL_GUIDES, d.id),
              npm_package: NPM_PACKAGES[d.id] || null,
              kind: 'desktop' });
      }
      // ③ 会话统计源：direct_only 与可绑路由两类，目录存在=弱信号（残留数据，不足证明已安装）
      for (const s of (configLoader.sessionSources() || [])) {
        if (!s || !s.agent_id) continue;
        let weak = false;
        try { weak = !!s.root && fs.existsSync(configLoader.expandHome(s.root)); } catch {}
        merge({ id: s.agent_id, name: s.app_name || entityMeta(s.agent_id)?.name || s.agent_id,
              icon: s.app_icon || entityMeta(s.agent_id)?.icon || '🖱',
              capabilities: entityMeta(s.agent_id)?.capabilities || null,
              sStrongDefined: false, sStrong: false, sWeak: weak,
              install_url: INSTALL_URLS[s.agent_id] || null,
              uninstall_url: UNINSTALL_URLS[s.agent_id] || null,
              install_guide: guide(INSTALL_GUIDES, s.agent_id),
              uninstall_guide: guide(UNINSTALL_GUIDES, s.agent_id),
              npm_package: NPM_PACKAGES[s.agent_id] || null,
              kind: s.direct_only ? 'direct' : 'session' });
      }
    } catch (e) { console.error('[apps:supported] failed:', e.message); }
    const out = [...byId.values()].map(r => {
      // 有强信号只认强信号（命令/appx 卸载即变灰）；否则用弱信号（残留目录）兜底
      r.installed = r.sStrongDefined ? r.sStrong : r.sWeak;
      delete r.sStrongDefined; delete r.sStrong; delete r.sWeak;
      return r;
    });
    // 已安装靠前（彩色在左），其次有安装链接的，最后无链接的小众工具
    out.sort((a, b) => (Number(b.installed) - Number(a.installed)) || ((b.install_url ? 1 : 0) - (a.install_url ? 1 : 0)));
    return out;
  });

  // 稳健解析 npm 可执行文件：GUI 启动的 electron 主进程 PATH 有时不含 Node 目录，
  // 裸 'npm.cmd' 会找不到导致一键安装静默失败 → 先 resolveRealCommand，再探常见安装位置，最后回退裸命令。
  const resolveNpmCmd = () => {
    const isWin = process.platform === 'win32';
    try {
      const p = require('./shim-installer').resolveRealCommand(isWin ? 'npm.cmd' : 'npm');
      if (p && fs.existsSync(p)) return p;
    } catch {}
    const cands = isWin
      ? ['C:\\Program Files\\nodejs\\npm.cmd', 'C:\\Program Files (x86)\\nodejs\\npm.cmd',
         path.join(os.homedir(), 'AppData', 'Roaming', 'npm', 'npm.cmd')]
      : ['/usr/local/bin/npm', '/opt/homebrew/bin/npm', '/usr/bin/npm'];
    for (const c of cands) { try { if (fs.existsSync(c)) return c; } catch {} }
    return isWin ? 'npm.cmd' : 'npm';
  };

  // 一键安装/更新 CLI 工具：跑 npm i -g <包>@latest（用户级全局，无需管理员）。
  // 异步 exec，不阻塞主进程；装完前端刷新检测状态。
  ipcMain.handle('apps:npmGlobalInstall', async (_e, { id } = {}) => {
    const pkg = (require('./config-loader').appNpmPackages() || {})[id];
    if (!pkg) return { ok: false, error: 'no-npm-package' };
    const npmCmd = `"${resolveNpmCmd()}"`;
    return await new Promise((resolve) => {
      try {
        require('child_process').exec(`${npmCmd} i -g ${pkg}@latest`, { timeout: 300000, windowsHide: true },
          (err, _stdout, stderr) => {
            if (err) resolve({ ok: false, error: (String(stderr || '') || err.message).slice(0, 400) });
            else {
              // 清命令探测缓存，使前端刷新时立即检测到刚装的工具（不等 30s TTL）
              try { require('./shim-installer').clearCommandCache(); } catch {}
              // 通知前端应用列表刷新（新装的工具即时出现在应用列表虚拟条目）
              try { mainWindow?.webContents?.send('apps:changed'); } catch {}
              resolve({ ok: true, pkg });
            }
          });
      } catch (e) { resolve({ ok: false, error: e.message }); }
    });
  });

  // 一键卸载 CLI 工具：跑 npm uninstall -g <包>。与安装对称，装完/卸完都清命令缓存。
  ipcMain.handle('apps:npmGlobalUninstall', async (_e, { id } = {}) => {
    const pkg = (require('./config-loader').appNpmPackages() || {})[id];
    if (!pkg) return { ok: false, error: 'no-npm-package' };
    const npmCmd = `"${resolveNpmCmd()}"`;
    return await new Promise((resolve) => {
      try {
        require('child_process').exec(`${npmCmd} uninstall -g ${pkg}`, { timeout: 300000, windowsHide: true },
          (err, _stdout, stderr) => {
            if (err) resolve({ ok: false, error: (String(stderr || '') || err.message).slice(0, 400) });
            else {
              // 顺带清掉 Token Bank 托管的 shim，避免留下指向已删程序的失效 shim。
              // 命令名取自该工具的 detect.command（如 claude/codex/opencode）；api_key 应用无 shim，跳过。
              try {
                const tool = (require('./config-loader').tools() || []).find(t => t.id === id);
                const cmd = tool && tool.detect && tool.detect.command;
                if (cmd) require('./shim-installer').removeShim(cmd);
              } catch {}
              try { require('./shim-installer').clearCommandCache(); } catch {}
              // 通知前端应用列表刷新（卸载后虚拟条目即时消失）
              try { mainWindow?.webContents?.send('apps:changed'); } catch {}
              resolve({ ok: true, pkg });
            }
          });
      } catch (e) { resolve({ ok: false, error: e.message }); }
    });
  });

  ipcMain.handle('apps:list', () => {
    const configLoader = require('./config-loader');
    const INSTALL_GUIDES = configLoader.appInstallGuides();
    const INSTALL_URLS = configLoader.appInstallUrls();
    const guideFor = (id) => (id ? configLoader.resolveGuide(INSTALL_GUIDES[id]) : null);
    const entityMeta = (id) => {
      try { return configLoader.appEntityById(id); } catch { return null; }
    };
    const sessionSrcOf = (agentId) => (configLoader.sessionSources() || []).find(s => s.agent_id === agentId);
    const toolIds = new Set((configLoader.tools() || []).map(t => t.id));
    const apiKeyIds = new Set((configLoader.apiKeyApps() || []).map(a => a.id));

    /** 是否允许绑路由：api-key/shim/manual 须 gateway_proxy；session 须会话能力 */
    const resolveRouteBindable = (app, fallback = true) => {
      const aid = app.agent_id || app.preset_id;
      if (!aid) return fallback !== false;

      const ent = entityMeta(aid);
      const caps = configLoader.appCapabilities(aid);
      const gwProxy = caps ? !!caps.gateway_proxy : !!ent?.gateway_proxy;

      if (app.link_method === 'shim' || app.link_method === 'api-key' || app.link_method === 'manual') {
        return gwProxy;
      }
      if (app.link_method === 'session') {
        const sessCaps = caps || ent?.capabilities || {};
        return !!(sessCaps.session_trace || sessCaps.session_usage_import) && (ent?.route_bindable !== false);
      }

      if (app.link_method === 'shim') return gwProxy && toolIds.has(aid);
      if (app.link_method === 'api-key' || app.preset_id) return gwProxy && apiKeyIds.has(app.preset_id || aid);
      if (app.link_method === 'session') {
        const src = sessionSrcOf(aid);
        return !!(src && !src.direct_only);
      }
      return fallback !== false;
    };

    // 按云端实体能力同步本地持久化应用：取消路由能力时清空 route_id
    try {
      const cur = getApps();
      let mutated = false;
      for (const app of cur) {
        const bindable = resolveRouteBindable(app, app.route_bindable);
        if (app.route_bindable !== bindable) { app.route_bindable = bindable; mutated = true; }
        if (!bindable && (app.route_id || (app.route_ids && app.route_ids.length))) {
          app.route_id = null;
          app.route_ids = null;
          mutated = true;
          if (app.link_method === 'shim' && app.agent_id) {
            try { agentLinker.revertById(app.agent_id); } catch {}
          }
          // 取消网关能力时还原 config-file 应用（如 Claude Desktop）
          if ((app.link_method === 'api-key' || app.host_method === 'config-file') && app.config_file && app.hosted) {
            try { revertAppConfigFile(app.id, app.config_file); } catch {}
          }
        }
      }
      if (mutated) {
        saveApps(cur);
        try { syncGatewayFromConfig(readLocalConfig()); } catch {}
      }
    } catch (e) { console.warn('[apps:list] sync route_bindable:', e.message); }

    // 检测到的 api-key 应用 → 自动建立「离线」持久条目（生成 key、不写配置文件），
    // 使其与透明托管(shim)一致：始终是真实条目、有完整的下拉/编辑/测试控件，
    // 「纳管」只是再写一次配置文件。去重以「目标配置文件」为准（同一文件不重复建）。
    try {
      const cur = getApps();
      const norm = (p) => { try { return path.resolve(resolveCfgPath(p)).toLowerCase(); } catch { return String(p || '').toLowerCase(); } };
      const savedPresets  = new Set(cur.filter(a => a.preset_id).map(a => a.preset_id));
      const managedFiles  = new Set(cur.filter(a => a.config_file).map(a => norm(a.config_file)));
      let mutated = false;
      for (const d of getApiKeyApps()) {
        if (savedPresets.has(d.id)) continue;
        if (!apiKeyAppDetected(d)) continue;
        const nf = norm(resolveCfgPath(d.config_file));
        if (managedFiles.has(nf)) continue;
        cur.push({
          id: 'app-apikey-' + d.id,
          name: d.name, icon: d.icon, link_method: 'api-key', agent_id: null,
          api_key: 'sk-local-' + rndHex(16), route_id: null,
          description: '', allowed_models: [], max_rpm: null, max_concurrent: null, allow_stream: true,
          env: d.env || null, preset_id: d.id, inject: 'config-file',
          config_file: d.config_file || null, patch: d.patch || null,
          hosted: true,    // 默认纳管+直连：只读会话日志统计，不写配置/不走网关（绑路由才走网关）
          created_at: new Date().toISOString(),
        });
        savedPresets.add(d.id); managedFiles.add(nf); mutated = true;
      }
      if (mutated) { saveApps(cur); try { syncGatewayFromConfig(readLocalConfig()); } catch {} }
    } catch (e) { console.error('[apps:list] materialize api-key failed:', e.message); }

    // direct_only 会话源 → 仅当本机会话数据目录存在时才创建并展示（未安装不显示）。
    // 非 direct_only 的会话源 → 可绑路由（link_method: session），仍只读 trace 不走网关代理。
    const directInstalled = (agentId) => {
      const src = sessionSrcOf(agentId);
      if (!src?.root) return false;
      try {
        const root = configLoader.resolvePlaceholders
          ? configLoader.resolvePlaceholders(String(src.root))
          : configLoader.expandHome(src.root);
        return fs.existsSync(root);
      } catch { return false; }
    };
    try {
      const cur = getApps();
      let mutated = false;
      // 按最新 session_sources 同步已持久化条目（云端改 direct_only 后本地须跟着变）
      for (let i = 0; i < cur.length; i++) {
        const app = cur[i];
        if (!app.agent_id || (app.link_method !== 'direct' && app.link_method !== 'session')) continue;
        const src = sessionSrcOf(app.agent_id);
        if (!src) continue;
        const wantDirect = !!src.direct_only;
        if (wantDirect && app.link_method !== 'direct') {
          app.link_method = 'direct';
          app.route_bindable = false;
          app.direct_only = true;
          app.route_id = null;
          mutated = true;
        } else if (!wantDirect && app.link_method === 'direct') {
          app.link_method = 'session';
          app.route_bindable = resolveRouteBindable(app, true);
          app.direct_only = false;
          mutated = true;
        }
        if (src.app_name && app.name !== src.app_name) { app.name = src.app_name; mutated = true; }
        if (src.app_icon && app.icon !== src.app_icon) { app.icon = src.app_icon; mutated = true; }
      }
      const haveAgent = new Set(cur.filter(a => a.agent_id && (a.link_method === 'direct' || a.link_method === 'session')).map(a => a.agent_id));
      // 已有 shim / api-key 的 agent_id 不再为附属 session 单独建条目
      const proxyAgentIds = new Set([
        ...cur.filter(a => a.link_method === 'shim' || a.link_method === 'api-key').map(a => a.agent_id || a.preset_id),
        ...((configLoader.tools() || []).map(t => t.id)),
        ...((configLoader.apiKeyApps() || []).map(a => a.id)),
      ]);
      for (const s of (configLoader.sessionSources() || [])) {
        if (!s || !s.agent_id) continue;
        // standalone=false：附属统计，挂到已有 CLI/API 实体，不单独占百宝箱一行
        if (s.standalone === false) continue;
        if (proxyAgentIds.has(s.agent_id)) continue;
        if (haveAgent.has(s.agent_id)) continue;
        if (!directInstalled(s.agent_id)) continue;
        if (s.direct_only) {
          cur.push({
            id: 'app-direct-' + s.agent_id,
            name: s.app_name || s.agent_id, icon: s.app_icon || '🖱',
            link_method: 'direct', agent_id: s.agent_id,
            api_key: 'sk-local-' + rndHex(16), route_id: null,
            route_bindable: false, direct_only: true,
            hosted: true,
            created_at: new Date().toISOString(),
          });
        } else {
          cur.push({
            id: 'app-session-' + s.agent_id,
            name: s.app_name || s.agent_id, icon: s.app_icon || '🖱',
            link_method: 'session', agent_id: s.agent_id,
            api_key: 'sk-local-' + rndHex(16), route_id: null,
            route_bindable: resolveRouteBindable({ agent_id: s.agent_id, link_method: 'session' }, true),
            direct_only: false,
            hosted: true,
            created_at: new Date().toISOString(),
          });
        }
        haveAgent.add(s.agent_id);
        mutated = true;
      }
      if (mutated) saveApps(cur);
    } catch (e) { console.error('[apps:list] materialize session failed:', e.message); }

    // Trae Work：手工配置模型，统一为 session（可绑路由选参考模型，不写 state.vscdb）
    try {
      const { isTraeWorkEntity } = require('./app-handlers');
      const cur = getApps();
      let migrated = false;
      for (const app of cur) {
        const traeLike = isTraeWorkEntity(app.preset_id) || isTraeWorkEntity(app.agent_id)
          || String(app.id || '').toLowerCase().includes('trae');
        if (!traeLike) continue;
        app.agent_id = 'trae-work';
        app.preset_id = 'trae-work';
        if (app.link_method === 'direct' || app.link_method === 'api-key') {
          app.link_method = 'session';
          app.direct_only = false;
          app.route_bindable = true;
          app.host_method = 'session';
          delete app.config_file;
          delete app.patch;
          delete app.inject;
          migrated = true;
        }
        if (!app.api_key) { app.api_key = 'sk-local-' + rndHex(16); migrated = true; }
      }
      if (migrated) saveApps(cur);
    } catch (e) { console.error('[apps:list] migrate trae-work failed:', e.message); }

    // direct / shim / session 应用：补全 API Key（写入配置、网关识别、手工接入）
    try {
      const cur = getApps();
      let keyMutated = false;
      for (const app of cur) {
        if ((app.link_method === 'direct' || app.link_method === 'shim' || app.link_method === 'session') && !app.api_key) {
          app.api_key = 'sk-local-' + rndHex(16);
          keyMutated = true;
        }
      }
      if (keyMutated) {
        saveApps(cur);
        try { syncGatewayFromConfig(readLocalConfig()); } catch {}
      }
    } catch (e) { console.error('[apps:list] backfill api_key failed:', e.message); }

    // 被管理员禁用（enable_3p:false）的 api_key 应用预设 id —— 这些应用整条隐藏
    const disabledPresets = new Set(
      (() => { try { return (require('./config-loader').apiKeyApps() || []).filter(a => a.enable_3p === false).map(a => a.id); } catch { return []; } })()
    );
    const savedApps = getApps().filter(a => !(a.preset_id && disabledPresets.has(a.preset_id)));
    const agentTools = agentLinker.list();

    // 把 yaml tools 里有、但 apps[] 里还没有 shim 记录的 agent，动态补入。
    // 仅未安装则不虚拟展示（与 api-key/session 虚拟条目一致：卸载后即从应用列表消失，
    // 装回自动出现）；已被用户显式纳管的 shim 记录在 savedApps，不受此过滤，始终保留。
    const shimIds = new Set(savedApps.filter(a => a.link_method === 'shim').map(a => a.agent_id));
    const virtualShimApps = agentTools
      .filter(t => t.installed)
      .filter(t => !shimIds.has(t.id))
      .filter(t => toolIds.has(t.id))
      .filter(t => {
        const caps = configLoader.appCapabilities(t.id);
        if (caps) return !!caps.gateway_proxy;
        return true;
      })
      .map(t => {
        const ent = entityMeta(t.id);
        return {
        id: 'app-shim-' + t.id,
        name: ent?.name || t.name || t.id,
        icon: ent?.icon || '🤖',
        capabilities: ent?.capabilities || t.capabilities || null,
        link_method: 'shim',
        agent_id: t.id,
        api_key: null,
        route_id: null,
        description: '',
        type: t.type || 'cli',
        needs_ca: !!t.needs_ca,
        route_bindable: ent ? ent.route_bindable !== false : (t.route_bindable !== false),
        unsupported: !!t.unsupported,
        note: t.note || null,
        installed: t.installed,
        linked: t.linked,
        hosted: true,
        _virtual: true,
      }; });

    // 合并：持久化的 app + 虚拟的 shim app
    const allApps = [...savedApps, ...virtualShimApps];

    // shim 工具的自动配置详情（环境变量 / 自动写入文件），占位符已解析
    let toolDetails = [];
    try { toolDetails = require('./config-loader').tools(); } catch {}
    const autoConfigOf = (agentId) => {
      const t = toolDetails.find(x => x.id === agentId);
      if (!t) return null;
      return {
        strategy:    t.strategy || null,
        protocol:    t.protocol || null,
        env:         (t.inject && t.inject.env) || {},          // 注入的环境变量
        config_file: t['config-file'] || null,                  // 自动写入的配置文件
        patch:       t.patch || {},                             // 写入文件的字段
      };
    };

    const entityDerived = (aid) => {
      const ent = entityMeta(aid);
      if (!ent) return {};
      return {
        activity_agent_id: ent.activity_agent_id,
        trace_agent_id: ent.trace_agent_id,
        linked_data_sources: ent.linked_data_sources || [],
        pricing_provider_id: ent.pricing_provider_id,
        integrations: ent.integrations || {},
        handoff_target: !!ent.handoff_target,
        session_import: !!ent.session_import,
        session_usage_import: ent.session_usage_import,
        session_trace: ent.session_trace,
        gateway_proxy: ent.gateway_proxy,
        route_multi_select: !!ent.route_multi_select,
      };
    };

    // 注入实时托管状态 + 自动配置详情
    const rows = allApps
      .map(app => {
        const aid = app.agent_id || app.preset_id;
        const caps = aid ? configLoader.appCapabilities(aid) : null;
        const ent = entityMeta(aid);
        const derived = entityDerived(aid);
        const routeBindable = resolveRouteBindable(app, app.route_bindable);
        const withCaps = {
          ...app,
          ...derived,
          capabilities: caps || ent?.capabilities || app.capabilities || null,
          handler: ent?.handler || app.handler,
          route_bindable: routeBindable,
        };
        // 「仅直连·只统计」应用（cursor 等）：只读会话日志，不绑路由/不走网关。
        if (app.link_method === 'direct') {
          const src = sessionSrcOf(app.agent_id);
          if (src && !src.direct_only) {
            return { ...withCaps, linked: false, installed: true,
                     hosted: app.hosted === true,
                     direct_only: false, route_bindable: routeBindable,
                     link_method: 'session', host_method: 'session' };
          }
          return { ...withCaps, linked: false, installed: true,
                   hosted: app.hosted === true,
                   direct_only: true, route_bindable: false, host_method: 'direct' };
        }
        if (app.link_method === 'session') {
          return { ...withCaps, linked: false, installed: directInstalled(app.agent_id),
                   hosted: app.hosted === true,
                   direct_only: false, route_bindable: routeBindable, host_method: 'session' };
        }
        if (app.link_method === 'shim') {
          const tool = agentTools.find(t => t.id === app.agent_id);
          return {
            ...withCaps,
            linked: tool ? tool.linked : false,
            installed: tool ? tool.installed : false,
            hosted: app.hosted !== false,   // 默认纳管+直连（检测到即统计），仅显式取消纳管(false)才停扫
            type: tool ? tool.type : (app.type || 'cli'),
            note: tool ? tool.note : (app.note || null),
            route_bindable: tool ? (resolveRouteBindable(app, tool.route_bindable)) : routeBindable,
            auto_config: autoConfigOf(app.agent_id),
          };
        }
        // config-file 类 api-key 应用：标记 host_method + 是否已纳管（状态跟随用户操作，
        // 持久化在 app.hosted，不再扫描/匹配配置文件内容）。
        const def = getApiKeyApps().find(d => d.id === app.preset_id);
        // 从最新 yaml 预设刷新 patch/env/config_file（让 yaml 改动对已添加应用也生效；
        // config_file 对 Claude Desktop 是动态的，必须用预设解析后的最新路径=激活配置）
        const freshConfigFile = def?.config_file || app.config_file;
        const freshPatch       = def?.patch || app.patch;
        const freshEnv         = def?.env  ?? app.env;
        // config-file 预设即使当前解析不到路径（Claude Desktop 开发者模式未就绪）仍按 config-file 归类，
        // 避免掉进危险的「删除」分支；needs_dev_mode 让 UI 显示「启用开发者模式」引导。
        const isConfigFileApp = !!freshConfigFile || def?.config_file_optional === true;
        const needsDevMode = def?.config_file_optional === true && def?.dev_mode_ready === false;
        // 在线(经网关) = 纳管 且 绑了路由；纳管但直连(无 route_id) = 仅读文件、不走网关
        return { ...withCaps, linked: true, installed: true,
                 hosted: app.hosted === true,
                 configured: !!(app.hosted && (app.route_id || (app.route_ids && app.route_ids.length))),
                 config_file: freshConfigFile, patch: freshPatch, env: freshEnv,
                 route_bindable: def ? resolveRouteBindable({ ...app, preset_id: app.preset_id }, def.route_bindable) : routeBindable,
                 route_multi_select: !!(def?.route_multi_select ?? ent?.route_multi_select),
                 allow_direct: def ? def.allow_direct !== false : (app.allow_direct !== false),  // 无本地用量源的桌面壳=false
                 host_method: isConfigFileApp ? 'config-file' : 'api-key',
                 needs_dev_mode: needsDevMode };
      })
      // 机器上没有的 shim / direct 应用不展示；api-key 应用始终展示。
      .filter(app => app.link_method !== 'shim' || app.installed)
      .filter(app => app.link_method !== 'direct' || directInstalled(app.agent_id))
      .filter(app => app.link_method !== 'session' || directInstalled(app.agent_id));

    // 同一 agent_id 只保留一行：api-key(持久) > shim > session/direct
    const PRI = { 'api-key': 3, manual: 3, shim: 2, session: 1, direct: 1 };
    const bestByAgent = new Map();
    const noAgentRows = [];
    for (const app of rows) {
      const aid = app.agent_id || app.preset_id;
      if (!aid) { noAgentRows.push(app); continue; }
      const pri = PRI[app.link_method] || 0;
      const cur = bestByAgent.get(aid);
      if (!cur || pri > (PRI[cur.link_method] || 0)) bestByAgent.set(aid, app);
    }
    const dedupedRows = [...noAgentRows, ...bestByAgent.values()];

    // 追加：检测到、但还没"添加"过的 API Key 应用（虚拟行，显示「添加」）
    // 去重以「目标配置文件」为准：配置文件才是应用的真实身份（同一文件不可能托管两次）。
    // 例如 Claude Code（含桌面版）与 Claude Desktop 都写 ~/.claude/settings.json。
    const norm = (p) => { try { return path.resolve(resolveCfgPath(p)).toLowerCase(); } catch { return String(p || '').toLowerCase(); } };
    const managedFiles = new Set(savedApps.filter(a => a.config_file).map(a => norm(a.config_file)));
    const linkedApiKey = new Set(savedApps.filter(a => a.preset_id).map(a => a.preset_id));
    for (const d of getApiKeyApps()) {
      if (!apiKeyAppDetected(d)) continue;
      const file = resolveCfgPath(d.config_file);
      if (linkedApiKey.has(d.id) || managedFiles.has(norm(file))) continue;
      dedupedRows.push({
        id: 'app-apikey-' + d.id,
        name: d.name, icon: d.icon,
        link_method: 'api-key', host_method: 'config-file',
        needs_dev_mode: d.config_file_optional === true && !file,
        _virtual_apikey: true,
        preset_id: d.id,
        ...entityDerived(d.id),
        route_bindable: resolveRouteBindable({ preset_id: d.id, link_method: 'api-key' }, d.route_bindable),
        route_multi_select: !!entityDerived(d.id).route_multi_select,
        config_file: file, patch: d.patch, env: d.env || null,
        configured: false,
        installed: true, linked: false, api_key: null, route_id: null,
      });
    }
    return dedupedRows.map(app => {
      const aid = app.agent_id || app.preset_id;
      return {
        ...app,
        install_guide: guideFor(aid) || app.install_guide || null,
        install_url: INSTALL_URLS[aid] || app.install_url || null,
      };
    });
  });

  ipcMain.handle('apps:create', (_e, data) => {
    const apps = getApps();
    const app = {
      id: 'app-' + rndHex(8),
      name: data.name || '未命名应用',
      icon: data.icon || '🔧',
      link_method: data.link_method || 'api-key',
      agent_id: data.agent_id || null,           // shim 类专用，对应 tool id
      api_key: (data.link_method === 'api-key' || data.link_method === 'manual')
        ? ('sk-local-' + rndHex(16)) : null,
      route_id: data.route_id || null,
      description: data.description || '',
      allowed_models: data.allowed_models || [],
      max_rpm: data.max_rpm || null,
      max_concurrent: data.max_concurrent || null,
      allow_stream: data.allow_stream !== false,
      env: data.env || null,                     // 需写入工具的环境变量模板（{BASE}/{KEY} 占位）
      preset_id: data.preset_id || null,         // 来自哪个预设
      inject: data.inject || (data.env ? 'env' : null),  // env | config-file
      config_file: data.config_file || null,     // config-file 注入：目标配置文件
      patch: data.patch || null,                 // config-file 注入：写入的字段（{BASE}/{KEY} 占位）
      draft: data.draft === true,                // 草稿：新建面板未保存前的临时条目，列表不显示，保存时清除
      created_at: new Date().toISOString(),
    };
    apps.push(app);
    saveApps(apps);
    return app;
  });

  ipcMain.handle('apps:update', (_e, { id, ...patch }) => {
    const apps = getApps();
    const idx = apps.findIndex(a => a.id === id);
    if (idx === -1) return { ok: false, error: 'not-found' };
    // 不允许外部覆盖 api_key（通过 apps:regenKey 单独操作）
    const { api_key: _drop, ...safePatch } = patch;
    apps[idx] = { ...apps[idx], ...safePatch };
    saveApps(apps);
    try { syncGatewayFromConfig(readLocalConfig()); } catch {}
    const updated = apps[idx];
    if (updated.agent_id === 'cursor' && updated.link_method === 'direct' && Object.prototype.hasOwnProperty.call(patch, 'hosted')) {
      syncCursorHookState(apps);
    }
    // 路由相关字段变化 → 直接触发 Claude Desktop ↔ 3p 会话同步（不依赖前端主动调 claude3p:sync）。
    // runClaude3pSync 增量去重、无变化近乎零成本，多调无害。
    if (['route_id', 'route_ids', 'hosted'].some(k => Object.prototype.hasOwnProperty.call(patch, k))) {
      try { runClaude3pSync('apps-update'); } catch (e) { console.warn('[3p-sync] apps:update trigger error:', e && e.message); }
    }
    return updated;
  });

  ipcMain.handle('apps:delete', (_e, id) => {
    const apps = getApps().filter(a => a.id !== id);
    saveApps(apps);
    try { syncGatewayFromConfig(readLocalConfig()); } catch {}
    return { ok: true };
  });

  ipcMain.handle('apps:regenKey', (_e, id) => {
    const apps = getApps();
    const idx = apps.findIndex(a => a.id === id);
    const lm = idx >= 0 ? apps[idx].link_method : null;
    const regenOk = lm === 'api-key' || lm === 'manual' || lm === 'direct' || lm === 'shim' || lm === 'session';
    if (idx === -1 || !regenOk) return { ok: false };
    apps[idx].api_key = 'sk-local-' + rndHex(16);
    saveApps(apps);
    try { syncGatewayFromConfig(readLocalConfig()); } catch {}
    // shim 已接入时须重写脚本，否则 env 里仍是旧 Key
    const app = apps[idx];
    if (app.link_method === 'shim' && app.agent_id) {
      try {
        const tools = require('./config-loader').tools() || [];
        const tool = tools.find(t => t.id === app.agent_id);
        if (tool && agentLinker.status(tool)) agentLinker.apply(tool);
      } catch (e) { console.warn('[apps:regenKey] shim re-apply:', e.message); }
    }
    return { ok: true, api_key: app.api_key };
  });

  // 写入环境变量到系统（让目标工具下次启动时指向网关）。
  // Windows: setx 持久化用户环境变量；macOS/Linux: 写入 shell rc 的托管块。
  ipcMain.handle('apps:writeEnv', async (_e, env) => {
    if (!env || typeof env !== 'object') return { ok: false, error: 'no-env' };
    const entries = Object.entries(env).filter(([k]) => k && k.trim());
    if (!entries.length) return { ok: false, error: 'empty' };
    try {
      if (process.platform === 'win32') {
        const { execFileSync } = require('child_process');
        for (const [k, v] of entries) {
          execFileSync('setx', [k, String(v)], { stdio: ['ignore', 'ignore', 'ignore'] });
        }
      } else {
        const home = os.homedir();
        const candidates = ['.zshrc', '.bashrc', '.bash_profile', '.profile'].map(f => path.join(home, f));
        const targets = candidates.filter(f => fs.existsSync(f));
        if (!targets.length) targets.push(path.join(home, '.profile'));
        const block = '\n# >>> tokenbank env >>>\n'
          + entries.map(([k, v]) => `export ${k}=${JSON.stringify(String(v))}`).join('\n')
          + '\n# <<< tokenbank env <<<\n';
        for (const f of targets) {
          let txt = fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : '';
          txt = txt.replace(/\n?# >>> tokenbank env >>>[\s\S]*?# <<< tokenbank env <<<\n?/g, '');
          fs.writeFileSync(f, txt + block, 'utf8');
        }
      }
      return { ok: true, count: entries.length };
    } catch (e) { return { ok: false, error: e.message }; }
  });

  // 「添加应用」预设（来自 yaml app_presets，可选）。已识别的 CLI/桌面应用都在
  // 应用列表里直接托管，不再用预设面板；无配置时返回空。
  ipcMain.handle('apps:presets', () => {
    try {
      const list = require('./config-loader').appPresets();
      if (Array.isArray(list)) return list;
    } catch {}
    return [];
  });

  // 写入工具配置文件（config-file 注入：如 Codex Desktop API 模式改 ~/.codex/config.toml）。
  // 前端已把 {BASE}/{KEY} 解析进 patch/env；这里解析路径占位符 + 展开 ~ 后写入。
  ipcMain.handle('apps:writeConfigFile', async (_e, { app_id, config_file, patch, env, route_id, route_ids } = {}) => {
    try {
      const cl = require('./config-loader');
      let file = cl.resolvePlaceholders(String(config_file || ''), {});
      file = cl.expandHome(file);
      const isClaudeDesktop = shouldUseClaude3pConfigWrite({ app_id, config_file, file });
      let claudeConfigId = null;
      if (isClaudeDesktop) {
        const resolved = resolveClaude3pWriteTarget(file);
        file = resolved.file;
        claudeConfigId = resolved.configId;
      } else if (!file) {
        return { ok: false, error: 'no-config-file' };
      }
      // 兜底：前端未解析的 {BASE}/{KEY} 在此用本机网关地址 + 应用 api_key 替换
      const gctx = cl.gatewayCtx();
      const appRec = (getApps() || []).find(a => a.id === app_id);
      const patchCtx = {
        ...gctx,
        base: `http://${gctx.reverse}`,
        key: appRec?.api_key || '',
      };
      let resolvedPatch = resolvePatchDeep(patch || {}, patchCtx);
      const resolvedEnv = resolvePatchDeep(env || {}, patchCtx);
      // handler.patch_route：绑路由时改写 patch（如 WorkBuddy models.json id/name）
      const { applyRouteToProxyPatch, resolveHandlerId } = require('./app-handlers');
      const handlerId = resolveHandlerId(appRec);
      const effectiveRouteId = route_id ?? appRec?.route_id;
      const routeIds = Array.isArray(route_ids) && route_ids.length
        ? route_ids
        : (Array.isArray(appRec?.route_ids) && appRec.route_ids.length
          ? appRec.route_ids
          : (effectiveRouteId ? [effectiveRouteId] : []));
      if (handlerId && routeIds.length) {
        let claudeName = 'claude-sonnet-4-5';
        let claudeModels = [];
        try {
          const cms = require('./config-loader').claudeModels?.() || [];
          if (cms.length) { claudeModels = cms; claudeName = cms[0]; }
        } catch {}
        const def = getApiKeyApps().find(d => d.id === appRec?.preset_id);
        resolvedPatch = applyRouteToProxyPatch(handlerId, resolvedPatch, {
          routeIds,
          routes: readLocalConfig().scene_routes || [],
          marker: def?.marker || appRec?.marker,
          claudeName,
          // 多路由时每条按 claude_models 列表依次分配独立 name（与 keyScene 绑定顺序一致）
          claudeModels,
        });
      }
      // Codex Desktop：走合并写入(保留 config.toml 其他段)，不整份重写、不写系统环境变量。
      // 生成 model_catalog(绑定路由的模型) + requires_openai_auth=true + experimental_bearer_token，
      // 并保留 auth.json 官方登录态(Desktop 门控放行自定义模型的前提)。
      if (handlerId === 'codex-desktop-api') {
        const codexCfg = require('./codex-config');
        const { getRouteModels } = require('./app-handlers');
        const codexHome = path.dirname(file);
        const baseUrl = resolvedPatch['model_providers.tokenbank.base_url'] || `${patchCtx.base}/v1`;
        const models = getRouteModels(appRec, readLocalConfig().scene_routes || []);
        const model = resolvedPatch['model'] || models[0] || '';
        codexCfg.writeCodexCatalog(codexHome, models);
        codexCfg.applyCodexProvider(file, {
          providerId: 'tokenbank', name: 'Tokenbank',
          baseUrl, model, bearerToken: appRec?.api_key || '', catalogFile: codexCfg.CATALOG_FILE,
        });
        codexCfg.cleanupThirdPartyAuthKey(codexHome);   // 清第三方残留 key，不动官方 tokens.*
        // 会话归一到 tokenbank：threads(Desktop 列表) + rollout 一并归一，纳管态看到全部
        try { codexCfg.syncCodexSessionProvider(codexHome, 'tokenbank'); } catch {}
        setAppHosted(app_id, true);
        const officialLogin = codexCfg.codexHasOfficialLogin(codexHome);
        // 缺官方登录 → Desktop 门控会藏掉自定义模型，回传提示让前端引导登录
        return { ok: true, file, envCount: 0, codex: true, officialLogin,
          ...(officialLogin ? {} : { warning: 'codex-no-official-login' }) };
      }
      // Trae：模型配置由用户在 IDE 内手工填写，此处不写入 state.vscdb
      // 纳管 = 备份原配置文件（整份，仅首次），再写入我们的配置（整份替换）。
      // 不合并、不检测冲突、不预扫描内容——状态完全跟随用户操作。
      const bak = file + '.tokenbank-bak';
      if (fs.existsSync(file) && !fs.existsSync(bak)) { try { fs.copyFileSync(file, bak); } catch {} }
      fs.mkdirSync(path.dirname(file), { recursive: true });
      if (/\.json$/i.test(file)) {
        fs.writeFileSync(file, JSON.stringify(patchToObject(resolvedPatch), null, 2), 'utf8');
      } else if (/\.ya?ml$/i.test(file)) {
        fs.writeFileSync(file, require('js-yaml').dump(patchToObject(resolvedPatch), { lineWidth: 120 }), 'utf8');
      } else {
        fs.writeFileSync(file, patchToToml(resolvedPatch), 'utf8');
      }
      // 附带的环境变量（如存放 key 的 env_key）一并写入系统
      let envCount = 0;
      const entries = Object.entries(resolvedEnv || {}).filter(([k]) => k && k.trim());
      if (entries.length) {
        if (process.platform === 'win32') {
          const { execFileSync } = require('child_process');
          for (const [k, v] of entries) execFileSync('setx', [k, String(v)], { stdio: ['ignore', 'ignore', 'ignore'] });
        } else {
          const home = os.homedir();
          const targets = ['.zshrc', '.bashrc', '.bash_profile', '.profile'].map(f => path.join(home, f)).filter(f => fs.existsSync(f));
          if (!targets.length) targets.push(path.join(home, '.profile'));
          const block = '\n# >>> tokenbank env >>>\n' + entries.map(([k, v]) => `export ${k}=${JSON.stringify(String(v))}`).join('\n') + '\n# <<< tokenbank env <<<\n';
          for (const f of targets) {
            let txt = fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : '';
            txt = txt.replace(/\n?# >>> tokenbank env >>>[\s\S]*?# <<< tokenbank env <<<\n?/g, '');
            fs.writeFileSync(f, txt + block, 'utf8');
          }
        }
        envCount = entries.length;
      }
      // 状态跟随操作：标记该应用已纳管
      setAppHosted(app_id, true);
      // Claude Desktop：写入后补齐 _meta.json，否则网关配置 Claude 读不到
      if (isClaudeDesktop || isClaude3pConfigLibraryFile(file)) {
        ensureClaude3pMeta(claudeConfigId || path.basename(file, '.json'));
      }
      // Claude Desktop 接管后立即同步一次（定期同步另有 30s 兜底）
      if (isClaudeDesktop) runClaude3pSync('takeover');
      return { ok: true, file, envCount };
    } catch (e) { return { ok: false, error: (e.stderr ? e.stderr.toString() : e.message).slice(0, 300) }; }
  });

  // 取消纳管：用备份整份还原原配置文件（保留备份与应用条目，不删除）。状态跟随操作。
  ipcMain.handle('apps:revertConfigFile', (_e, { app_id, config_file } = {}) => {
    try {
      revertAppConfigFile(app_id, config_file);
      return { ok: true };
    } catch (e) { return { ok: false, error: e.message }; }
  });

  // 注册来自 toolsConfig 的 shim 托管 app（透明托管时自动创建或更新 app 记录）
  // shim agent_id → data_source 对应关系
  // agent_id → data_source（从 session_sources 配置派生，不再硬编码）
  const AGENT_DATA_SOURCE = (() => {
    const m = {};
    try {
      for (const s of (require('./config-loader').sessionSources() || [])) {
        if (s && s.agent_id && s.data_source) m[s.agent_id] = s.data_source;
      }
    } catch {}
    return m;
  })();

  ipcMain.handle('apps:detail', (_e, { app, days } = {}) => {
    maybeSyncSessionTelemetry(localStats);
    // Cursor：打开明细时立即清 transcript 0 token 占位（节流窗口内也能刷新列表）
    if (app?.agent_id === 'cursor') {
      try { cursorHooks.purgeTranscriptZeroTokens(localStats); } catch {}
    }
    const aid = app?.agent_id || app?.preset_id;
    const ent = configLoader.appEntityById(aid);
    const caps = configLoader.appCapabilities(aid);
    const usageImport = !!(caps?.session_usage_import ?? ent?.session_usage_import ?? app?.session_usage_import);
    const sessionTrace = !!(caps?.session_trace ?? ent?.session_trace ?? app?.session_trace);
    const linked = usageImport ? (app?.linked_data_sources || ent?.linked_data_sources || []) : [];
    let dataSource = null;
    if (usageImport) {
      if (app && (app.link_method === 'api-key' || app.link_method === 'manual') && linked.length) {
        dataSource = linked[0];
      } else if (app && (app.link_method === 'shim' || app.link_method === 'direct' || app.link_method === 'session') && app.agent_id) {
        dataSource = AGENT_DATA_SOURCE[app.agent_id] || null;
      }
    }
    const detail = localStats.queryAppDetail({
      appId: app && app.id, apiKey: app && app.api_key, dataSource,
      days: days || 30, includeSessionImport: usageImport,
    });
    const activityAgentId = app?.activity_agent_id || ent?.activity_agent_id || app?.trace_agent_id || app?.agent_id;
    if (sessionTrace && ent) {
      const scanned = sessionBrowser.listActivityForEntity(ent, {
        limit: 50, sinceDays: days || 30,
      });
      if (scanned.length) {
        detail.activity = sessionBrowser.mergeActivityWithStats(
          scanned, usageImport ? detail.sessions : [],
        ).map(a => sessionBrowser.normalizeActivityRow(a, activityAgentId));
      }
      if (detail.recent?.length) {
        detail.recent = sessionBrowser.enrichRecentDetail(activityAgentId, detail.recent, detail.activity);
      }
    }
    detail.hasModelStats = configLoader.agentHasModelStats(
      app?.activity_agent_id || app?.agent_id || app?.preset_id,
    );
    return detail;
  });

  ipcMain.handle('apps:handoffTargets', () => {
    try { return configLoader.handoffTargets(); } catch { return []; }
  });

  ipcMain.handle('apps:sessionTrace', (_e, { agent_id, session_id } = {}) => {
    if (!agent_id || !session_id) return { error: 'missing_params', steps: [] };
    const ent = configLoader.appEntityById(agent_id);
    const trace = ent
      ? sessionBrowser.getTraceForEntity(ent, session_id)
      : sessionBrowser.getTrace(agent_id, session_id);
    const hookOnly = !!(ent?.integrations?.editor_hook);
    const dbRow = localStats.querySessionDetail(session_id, { hookOnly });
    return sessionBrowser.enrichTraceWithDb(trace, dbRow);
  });

  // ── 会话管理：跨 agent 聚合 + 叠加层 + 导出 ──────────────────────────────
  const sessionManager = require('./session-manager');
  const _sessionDeps = { sessionBrowser, localStats };

  ipcMain.handle('sessions:listAll', (_e, opts = {}) => {
    try {
      // 与 apps:detail 一致：列表前先增量补录会话文件，否则 DB 无 session_id / cost 可对账
      try { syncSessionTelemetry(localStats); } catch {}
      return sessionManager.getSessions(_sessionDeps, opts);
    }
    catch (e) { console.error('[sessions:listAll]', e.message); return []; }
  });

  ipcMain.handle('sessions:setMeta', (_e, payload = {}) => {
    try { return localStats.setSessionMeta(payload); }
    catch (e) { console.error('[sessions:setMeta]', e.message); return null; }
  });

  ipcMain.handle('sessions:export', (_e, payload = {}) => {
    try { return sessionManager.exportSession(_sessionDeps, payload); }
    catch (e) { console.error('[sessions:export]', e.message); return { error: 'export_failed' }; }
  });

  ipcMain.handle('sessions:continue', async (_e, payload = {}) => {
    try { return await sessionManager.continueSession(_sessionDeps, payload); }
    catch (e) { console.error('[sessions:continue]', e.message); return { error: 'continue_failed' }; }
  });
  // 知识提炼：后台异步任务。点击 start 立即返回，合成在后台跑；result 拿当前状态/结果。
  // 状态：idle（没跑过）/ running（生成中）/ ready（已完成，含成功或兜底）/ error（异常）。
  let _knowledgeJob = { status: 'idle', ok: false, content: '', model: null, scanned: 0, error: null, projectPaths: {}, finishedAt: 0 };
  function _startKnowledgeJob(model) {
    if (_knowledgeJob.status === 'running') return;
    _knowledgeJob = { status: 'running', ok: false, content: '', model: null, scanned: 0, error: null, projectPaths: {}, finishedAt: 0 };
    sessionManager.synthesizeKnowledge(_sessionDeps, model ? { model } : {})
      .then(r => {
        _knowledgeJob = {
          status: 'ready', ok: !!r.ok, content: r.content || '', model: r.model || null,
          scanned: r.scanned || 0, error: r.error || null, projectPaths: r.projectPaths || {}, finishedAt: Date.now(),
        };
      })
      .catch(e => {
        console.error('[knowledgeJob]', e.message);
        _knowledgeJob = { status: 'error', ok: false, content: '', model: null, scanned: 0, error: 'mine_failed', finishedAt: Date.now() };
      });
  }
  ipcMain.handle('sessions:knowledgeStart', (_e, { model } = {}) => { _startKnowledgeJob(model); return { status: _knowledgeJob.status }; });
  ipcMain.handle('sessions:knowledgeResult', () => ({ ..._knowledgeJob }));
  // 保存 AGENTS.md：弹保存对话框让用户自选位置。写入 UI 传来的（可能已编辑的）content。
  ipcMain.handle('sessions:saveAgentsMd', async (_e, { content, defaultPath } = {}) => {
    try {
      const text = typeof content === 'string' ? content : '';
      // 项目 tab 传来项目目录 → 默认定位到 <项目>/AGENTS.md；否则回退家目录。
      const fallback = require('path').join(require('os').homedir(), 'AGENTS.md');
      const def = typeof defaultPath === 'string' && defaultPath ? defaultPath : fallback;
      const res = await dialog.showSaveDialog(mainWindow, {
        title: 'Save AGENTS.md',
        defaultPath: def,
        filters: [{ name: 'Markdown', extensions: ['md'] }],
      });
      if (res.canceled || !res.filePath) return { canceled: true };
      require('fs').writeFileSync(res.filePath, text, 'utf8');
      return { ok: true, file: res.filePath };
    } catch (e) { console.error('[sessions:saveAgentsMd]', e.message); return { error: 'save_failed' }; }
  });

  // 统一“打开对应应用 + 粘贴”模式：用 open -a 拉起目标 agent 的桌面应用，不注入 prompt。
  // Cursor 等编辑器可带工作区/交接文件参数；Claude/Codex 等聊天应用只拉起 App，brief 已在剪贴板。
  const _AGENT_APP = { 'claude-code': 'Claude', codex: 'Codex', cursor: 'Cursor' };
  const _EDITOR_AGENTS = new Set(['cursor']);

  function _appInstalled(appName) {
    const fs = require('fs');
    const home = require('os').homedir();
    return [`/Applications/${appName}.app`, `${home}/Applications/${appName}.app`]
      .some(p => { try { return fs.existsSync(p); } catch { return false; } });
  }

  ipcMain.handle('sessions:launch', (_e, { target_agent, cwd, handoffFile } = {}) => {
    try {
      if (process.platform !== 'darwin') return { error: 'launch_unsupported_platform' };
      const app = _AGENT_APP[target_agent];
      if (!app) return { error: 'unsupported_target' };
      if (!_appInstalled(app)) return { error: 'app_not_found', app };

      const args = ['-a', app];
      if (_EDITOR_AGENTS.has(target_agent)) {
        if (cwd) args.push(cwd);
        if (handoffFile) args.push(handoffFile);
      }
      require('child_process').execFile('open', args, err => {
        if (err) console.error('[sessions:launch] open', err.message);
      });
      return { ok: true, app };
    } catch (e) {
      console.error('[sessions:launch]', e.message);
      return { error: 'launch_failed' };
    }
  });

  // 批量查所有应用的统计（调一次，合并进 apps:list 或单独查询）
  /** 解析应用对应的会话补录 data_source（须启用 session_usage_import） */
  function appSessionDataSource(app) {
    if (!app) return null;
    if ((app.link_method === 'api-key' || app.link_method === 'manual')) {
      const aid = app.preset_id || app.agent_id;
      const caps = configLoader.appCapabilities(aid);
      const ent = configLoader.appEntityById(aid);
      const usageImport = app.session_usage_import ?? caps?.session_usage_import ?? ent?.session_usage_import;
      if (!usageImport) return null;
      if (app.linked_data_sources?.length) return app.linked_data_sources[0];
      if (ent?.linked_data_sources?.length) return ent.linked_data_sources[0];
      return null;
    }
    if ((app.link_method === 'shim' || app.link_method === 'direct' || app.link_method === 'session') && app.agent_id) {
      const aid = app.agent_id;
      const caps = configLoader.appCapabilities(aid);
      const ent = configLoader.appEntityById(aid);
      const usageImport = app.session_usage_import ?? caps?.session_usage_import ?? ent?.session_usage_import;
      if (!usageImport) return null;
      return AGENT_DATA_SOURCE[app.agent_id] || null;
    }
    return null;
  }

  ipcMain.handle('apps:stats', (_e, appList) => {
    try { syncSessionTelemetry(localStats); } catch {}
    const stats = {};
    for (const app of (appList || [])) {
      const ds = appSessionDataSource(app);
      const aid = app.agent_id || app.preset_id;
      const caps = aid ? configLoader.appCapabilities(aid) : null;
      const ent = aid ? configLoader.appEntityById(aid) : null;
      const usageImport = !!(app.session_usage_import ?? caps?.session_usage_import ?? ent?.session_usage_import);
      let s;
      if (app.link_method === 'api-key' || app.link_method === 'manual') {
        s = localStats.queryAppStatsToday({
          appId: app.id,
          apiKey: app.api_key,
          dataSource: ds,
          includeSessionImport: usageImport,
        });
      } else if ((app.link_method === 'shim' || app.link_method === 'direct' || app.link_method === 'session') && app.agent_id) {
        s = localStats.queryAppStatsToday({
          appId: app.id,
          apiKey: app.api_key,
          dataSource: ds,
          includeSessionImport: usageImport,
        });
      } else {
        s = { calls: 0, tokens: 0, lastTs: null };
      }
      stats[app.id] = s;
    }
    return stats;
  });

  // 盘点页：按网关应用聚合用量（合并原「工具来源 + 场景应用」）
  ipcMain.handle('localStats:appsUsage', (_e, days) => {
    const d = Math.max(1, Math.min(365, parseInt(days, 10) || 1));
    try { syncSessionTelemetry(localStats); } catch {}
    const apps = getApps().filter(a => !a.draft);
    return apps.map(app => {
      const dataSource = appSessionDataSource(app);
      const st = localStats.queryAppStatsInPeriod({
        appId: app.id,
        apiKey: app.api_key,
        dataSource,
        days: d,
      });
      return {
        id: app.id,
        name: app.name,
        icon: app.icon || '🔧',
        link_method: app.link_method,
        agent_id: app.agent_id || null,
        preset_id: app.preset_id || null,
        ...st,
      };
    })
      .filter(a => a.calls > 0)
      .sort((a, b) => b.calls - a.calls);
  });

  ipcMain.handle('apps:ensureShimApp', (_e, { agent_id, name, icon }) => {
    const apps = getApps();
    const existing = apps.find(a => a.agent_id === agent_id && a.link_method === 'shim');
    if (existing) return existing;
    const app = {
      id: 'app-shim-' + agent_id,
      name, icon: icon || '🤖',
      link_method: 'shim', agent_id,
      // shim 鉴权 key，仅用于识别应用（appControls）；模型由请求体指定
      api_key: 'sk-local-' + rndHex(16), route_id: null,
      description: '', allowed_models: [], max_rpm: null,
      max_concurrent: null, allow_stream: true,
      created_at: new Date().toISOString(),
    };
    apps.push(app);
    saveApps(apps);
    return app;
  });

  // Save cloud API config (url + user API key) for P2P forwarding
  ipcMain.handle('localConfig:setCloudConfig', (_e, { url, token } = {}) => {
    const cfg = readLocalConfig();
    cfg.cloud_config = { url: url || null, token: token || null };
    writeLocalConfig(cfg);
    syncGatewayFromConfig(cfg);
    // Refresh active P2P model list using authenticated /v1/models
    fetchPeerModels(url, token);
    // 登录后写入 cloud_config 时补拉供给源（启动时可能尚无 url）
    if (url) {
      catalogSync.scheduleBackgroundSync({
        readLocalConfig,
        applyUserBillingCfg,
        onApplied: notifyCatalogUpdated,
      });
    }
    return { ok: true };
  });

  ipcMain.handle('gateway:setKeySceneMap', (_e, map) => {
    gateway.setKeySceneMap(map);
    return { ok: true };
  });

  ipcMain.handle('gateway:setRouterModelMap', (_e, map) => {
    gateway.setRouterModelMap(map);
    return { ok: true };
  });

  // Claude 客户端模型名（Anthropic 名）：Claude Desktop 的 inferenceModels 只接受这些名字
  ipcMain.handle('apps:claudeModels', () => {
    try { return require('./config-loader').claudeModels() || []; } catch { return []; }
  });

  // Claude Desktop 开发者模式状态：configLibrary 是否就绪（决定能否自动配置）
  ipcMain.handle('apps:claudeDevModeStatus', () => {
    return {
      installed: appxInstalled('Claude'),
      dev_mode_ready: claudeDevModeReady(),
      config_dir: CLAUDE_3P_CONFIG_DIR,
    };
  });

  ipcMain.handle('gateway:testProvider', async (_e, p = {}) => {
    const base_url = p.base_url;
    if (!base_url || typeof base_url !== 'string') return { ok: false, error: 'base_url required' };
    try {
      const { providerTestTargets, logProviderTestProbe, parseProviderProbeError } = require('../shared/provider-test');
      const { resolveOutboundProxyAgent } = require('../shared/outbound-proxy');

      const agentCfg = readAgentConfig() || {};
      const ctx = { id: p.id, api_format: p.api_format, base_url: p.base_url };
      console.log('[provider-test] start', ctx);

      /** 解析响应体中的错误详情 */
      function parseProbeError(body, status) {
        const raw = String(body || '').trim();
        if (!raw) return status ? `HTTP ${status}` : 'Connection failed';
        try {
          const j = JSON.parse(raw);
          return j.error?.message || j.message || raw.slice(0, 300);
        } catch {
          return raw.slice(0, 300);
        }
      }

      // OAuth 供给源：刷新凭证后用 provider 注入头探测
      if (p.auth_type === 'oauth' && p.oauth_provider) {
        let headers = {};
        const ready = await oauthMod.prepare(
          { id: p.id, auth_type: 'oauth', oauth_provider: p.oauth_provider, credentials: p.credentials },
          readAgentConfig, writeAgentConfig,
        );
        if (ready._oauth) {
          const ap = ready._oauth.applyAuth({ headers: {}, body: {}, credentials: ready.credentials });
          headers = { ...ap.headers };
          delete headers['Content-Type'];
          delete headers['Content-Length'];
        }
        const base = base_url.replace(/\/$/, '');
        const oauthTargets = [`${base}/models`, `${base}/v1/models`];
        let result = null;
        for (const probeUrl of oauthTargets) {
          logProviderTestProbe(ctx, { url: probeUrl, headers }, 'request');
          result = await nodeRequest(probeUrl, 'GET', headers, null);
          const ok = result.status >= 200 && result.status < 400;
          logProviderTestProbe(ctx, { url: probeUrl, headers }, 'response', {
            ok,
            status: result.status,
            error: ok ? undefined : parseProbeError(result.body, result.status),
          });
          if (ok || (result.status !== 404 && probeUrl === oauthTargets[0])) break;
        }
        const ok = result.status >= 200 && result.status < 400;
        return { ok, status: result.status, error: ok ? undefined : parseProbeError(result.body, result.status) };
      }

      const { targets, error } = providerTestTargets({
        base_url,
        token: p.token,
        api_format: p.api_format,
      });
      if (error === 'missing_api_key') return { ok: false, error: 'API Key required' };
      if (error === 'invalid_base_url') return { ok: false, error: 'Invalid Base URL' };

      let last = { ok: false, status: 0, error: 'Connection failed' };
      for (const target of targets) {
        logProviderTestProbe(ctx, target, 'request');
        const method = target.method || 'GET';
        const payload = target.body ? JSON.stringify(target.body) : null;
        const agent = resolveOutboundProxyAgent({
          provider: { proxy: p.proxy },
          urlStr: target.url,
          networkProxy: agentCfg.network_proxy,
        });
        const result = await nodeRequest(target.url, method, target.headers, payload, agent);
        const ok = result.status >= 200 && result.status < 400;
        last = { ok, status: result.status, error: ok ? undefined : parseProviderProbeError(result.body, result.status) };
        logProviderTestProbe(ctx, target, 'response', last);
        if (ok) return last;
      }
      return last;
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  // Periodically refresh P2P model list so newly available models are detected
  ipcMain.handle('gateway:refreshPeerModels', async () => {
    const cc = readLocalConfig().cloud_config || {};
    await fetchPeerModels(cc.url, cc.token);
    return gateway.getStatus();
  });

  setInterval(async () => {
    const cc = readLocalConfig().cloud_config || {};
    if (cc.url && cc.token) await fetchPeerModels(cc.url, cc.token);
    seedRandomSpeedForSources();   // 社区节点/个人源新增的模型补随机初始速率（已有则不动）
  }, 60_000);
}

// 主动测速探针：向本地网关发一次极小流式请求，网关在流结束时 record 记速。
// gateway:probeModel IPC 与「启动自动测速」共用。
function probeModelViaGateway(model) {
  return new Promise((resolve) => {
    try {
      if (!model || typeof model !== 'string') return resolve({ ok: false, error: 'no-model' });
      const cfg = readLocalConfig();
      const key = (cfg.apps || []).map(a => a.api_key).find(Boolean);
      if (!key) return resolve({ ok: false, error: 'no-api-key' });
      const gctx = require('./config-loader').gatewayCtx();
      const [rawHost, portStr] = String(gctx.reverse || '127.0.0.1:11430').split(':');
      // 客户端不能拨 0.0.0.0/::（监听地址≠可连接地址）：macOS/Linux 内核会兜到回环，Windows 直接
      // WSAEADDRNOTAVAIL 失败 → 探针在 Windows 上永远拿不到数据。统一回退回环。
      const host = (!rawHost || rawHost === '0.0.0.0' || rawHost === '::' || rawHost === '*') ? '127.0.0.1' : rawHost;
      const payload = JSON.stringify({ model, max_tokens: 12, stream: true, messages: [{ role: 'user', content: 'hi' }] });
      const start = Date.now();
      const req = http.request({
        host, port: parseInt(portStr, 10) || 11430,
        path: '/v1/chat/completions', method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${key}`, 'Content-Length': Buffer.byteLength(payload) },
        timeout: 30000,
      }, (res) => {
        res.on('data', () => {});   // 必须读完流，网关才会在流结束时 record 记速
        res.on('end', () => resolve({ ok: res.statusCode < 400, status: res.statusCode, latencyMs: Date.now() - start }));
        res.on('error', () => resolve({ ok: false, error: 'stream-error' }));
      });
      req.on('error', (e) => resolve({ ok: false, error: e.message }));
      req.on('timeout', () => { try { req.destroy(); } catch {} resolve({ ok: false, error: 'timeout' }); });
      req.end(payload);
    } catch (e) { resolve({ ok: false, error: e.message }); }
  });
}

// 个人源可测速模型名（用于随机初始化速率）。
function collectPersonalModelsMain() {
  try {
    const lc = readLocalConfig();
    const out = new Set();
    const add = (models) => {
      for (const m of (models || [])) {
        const n = typeof m === 'string' ? m : (m && (m.name || m.id));
        if (n) out.add(n);
      }
    };
    for (const s of (lc.user_subscriptions || [])) add(s.models);
    for (const p of (lc.user_payg_providers || [])) add(p.models);
    for (const [, d] of Object.entries(lc.direct_source_billing || {})) if (d && d.mode === 'api') add(d.models);
    return [...out];
  } catch { return []; }
}

// 为社区源(p2p) + 个人源模型「随机初始化」一个测速速率：不发真实探针、不花积分/账单。
// 已有测速数据（随机种子或真实值）则不动 —— 满足"第一次加时随机给一个速率，已有则不变"。
// 新模型（社区节点变化 / 新增个人源）会在下次调用（60s 定时器）时补种子。
function seedRandomSpeedForSources() {
  try {
    const speed = require('./provider-speed');
    const peers = (gateway.getStatus() || {}).peerModels || [];
    const personal = collectPersonalModelsMain();
    let n = 0;
    for (const m of [...peers, ...personal]) if (speed.seedIfMissing(m)) n++;
    if (n) console.log(`[speed] 首次为 ${n} 个社区/个人源模型随机初始化测速`);
  } catch (e) { console.warn('[speed] 随机初始化测速失败:', e.message); }
}

// ── App lifecycle ─────────────────────────────────────────────────────────────

app.whenReady().then(() => {
  // 尽早注册菜单栏托盘：macOS 把新状态项插在已有第三方项的「左侧」（刘海侧，最先被挤掉），
  // 越早创建越靠右、越不容易在菜单栏满时被遮挡。数据读取已做空安全，2s 定时器随后补真实值。
  createTray();
  // IPC 须在 createWindow 之前注册，避免 preload sendSync 时 handler 未就绪导致白屏
  registerIPC();
  createWindow();
  repairClaude3pMetaIfNeeded();
  // Claude Desktop ↔ 3p 会话同步：启动一次 + 每 30s 一次（覆盖运行期间新建的会话，修复"新会话纳管后不同步"）
  console.log('[3p-sync] ==== BOOT v2 (reconcile + 双向 watch) 已加载，开始同步 ====');
  sync3pDebugLog('==== BOOT app.whenReady, pid=' + process.pid + ' ====');
  runClaude3pSync('startup');
  // 启动后为社区源+个人源模型随机初始化测速速率（已有则不动）；延迟 10s 等 p2p peer 模型拉到
  setTimeout(() => { seedRandomSpeedForSources(); }, 10000);
  // 文件监听兜底：native / 3p 任一 claude-code-sessions 目录有新/变更文件就立即同步（实时）。
  // 必须双向监听——3p 建的 session 只会改 3p 目录、native 建的只改 native 目录。
  // 只监 account/org 目录（findSessionDir 动态定位）。account/org 变化靠每 60s 重建 watcher 兜底。
  let watchTimer;
  function watchSessions() {
    try {
      const sync = require('./claude-3p-session-sync');
      const dirs = [
        sync.findSessionDir(sync.nativeCodeSessionsRoot()),
        sync.findSessionDir(sync.p3CodeSessionsRoot()),
      ].filter(Boolean);
      // 清除旧 watchers（account/org 变化时重建）
      if (global.__sessionWatchers) for (const w of global.__sessionWatchers) { try { w.close(); } catch {} }
      global.__sessionWatchers = [];
      for (const dir of dirs) {
        const w = fs.watch(dir, (eventType, filename) => {
          sync3pDebugLog(`watch event: evt=${eventType} file=${JSON.stringify(filename)}`);
          if (!filename || !/^local_.+\.json$/.test(filename)) return;
          clearTimeout(watchTimer);
          watchTimer = setTimeout(() => runClaude3pSync('watch'), 2000); // 2s 防抖
        });
        global.__sessionWatchers.push(w);
      }
      console.log(`[3p-sync] watchers armed: ${dirs.length} 个目录`, dirs);
      sync3pDebugLog(`watchers armed: ${dirs.length} dirs: ${JSON.stringify(dirs)}`);
      // 重建 watcher 时顺带对账一次：兜底 fs.watch 漏事件 / 新 account 目录的存量会话。
      // 取代原来独立的 30s 轮询——本函数每 60s 跑一次，即 60s 安全网（实时同步仍靠上面的 watch）。
      runClaude3pSync('watch-rebuild');
    } catch (e) { console.warn('[3p-sync] watch setup failed:', e.message); }
  }
  watchSessions();
  setInterval(watchSessions, 60000); // 每 60s 重建，覆盖 account/org 目录变化
  // Init local SQLite stats DB（与 CLI 共用 ~/.tokenbank）
  localStats.init(STATS_DIR);
  try { cursorHooks.syncForApps(readLocalConfig().apps || [], process.execPath); } catch (e) {
    console.warn('[cursor-hooks] startup sync skipped:', e.message);
  }
  // 一次性迁移：hook 已装时清掉历史 transcript 0 token 行并导入 hook 事件
  try {
    const MIG = '__migrate_cursor_hook_purge_v1__';
    if (!localStats.getImportState(MIG) && cursorHooks.isInstalled()) {
      cursorHooks.purgeTranscriptZeroTokens(localStats);
      cursorHooks.importEvents(localStats);
      localStats.setImportState(MIG, 1, 0);
    }
  } catch (e) { console.error('[cursor-hooks] migrate purge', e.message); }
  gateway.setStatsRecorder((...args) => {
    const ok = localStats.record(...args);
    if (ok) {
      try { mainWindow?.webContents?.send('localStats:changed'); } catch {}
    }
  });
  gateway.setLocalStats(localStats);
  gateway.setLocalConfigReader(readLocalConfig);   // 供策略组调度查 policies[]
  // 清理旧版付费供给源预填数据（须在 gateway 启动前）
  try {
    const billingConfig = require('./billing-config');
    const localCfg = readLocalConfig();
    const agentCfg = readAgentConfig() || { providers: [] };
    const { cfg: migrated, changed } = billingConfig.migrateAgentProviders({
      ...localCfg,
      providers: agentCfg.providers,
    });
    if (changed) {
      writeAgentConfig({ ...agentCfg, providers: migrated.providers });
      console.log('[main] migrated agent providers: removed stale paid/custom entries');
    }
    syncAgentProviderModelsFromAccounts();
  } catch (e) { console.warn('[main] provider migration skipped:', e.message); }
  // shim 写脚本时按 toolId 取该 shim 应用的 api_key（解析 inject.env 的 {KEY}）
  agentLinker.setKeyResolver((toolId) => {
    const apps = readLocalConfig().apps || [];
    const a = apps.find(x => x.link_method === 'shim' && x.agent_id === toolId);
    return a ? a.api_key : null;
  });
  gateway.start(11430, readAgentConfig, writeAgentConfig);

  // 注入 Claude 客户端模型名（内部透明逻辑，来自 yaml config-loader）
  try { gateway.setClaudeModels(require('./config-loader').claudeModels()); } catch {}

  // 不再启动自动托管：已安装的 CLI 工具在应用列表里显示，由用户手动托管。

  // 补录「不走网关、直连官方」的会话用量：启动跑一次 + 每 30s 增量扫一次。
  // 与网关实时记录靠 request_id 跨来源去重，不会重复计。
  // 有新增就通知前端刷新——否则直连用量要等重启重新挂载才显示，不像网关那样"实时"。
  const runSessionImport = () => {
    try {
      const { hookImported, sessionImported } = syncSessionTelemetry(localStats);
      if (hookImported > 0 || sessionImported > 0) {
        try { mainWindow?.webContents?.send('apps:changed'); } catch {}
      }
    } catch (e) { console.error('[session-import]', e.message); }
  };
  // 一次性迁移：历史 Claude 会话用量都存成 session-claude（混了 cli / claude-desktop）。
  // 删掉重扫，按 entrypoint 重新拆分（cli→session-claude、claude-desktop→session-claude-desktop、sdk-cli 跳过）。
  try {
    const MIG = '__migrate_claude_entrypoint_v1__';
    if (!localStats.getImportState(MIG)) {
      localStats.resetSessionData(['session-claude', 'session-claude-desktop'], '%.claude%projects%');
      localStats.setImportState(MIG, 1, 0);
    }
  } catch (e) { console.error('[session-import] migrate', e.message); }
  // 一次性迁移：早期 cursor 源要求 message.usage（Cursor 不记 usage）→ 旧版扫到 0 条仍标记文件已处理，
  // 导致改成「按请求数计」后文件被当作未变跳过。清掉 cursor 导入状态，让其按新规则重扫。
  try {
    const MIG = '__migrate_cursor_requests_v1__';
    if (!localStats.getImportState(MIG)) {
      localStats.resetSessionData(['session-cursor'], '%.cursor%agent-transcripts%');
      localStats.setImportState(MIG, 1, 0);
    }
  } catch (e) { console.error('[session-import] migrate cursor', e.message); }
  // 一次性迁移：claude-desktop-3p 曾误归 session-claude → 重扫按 entrypoint 拆分
  try {
    const MIG = '__migrate_claude_desktop_3p_v1__';
    if (!localStats.getImportState(MIG)) {
      localStats.resetSessionData(['session-claude', 'session-claude-desktop'], '%.claude%projects%');
      localStats.setImportState(MIG, 1, 0);
    }
  } catch (e) { console.error('[session-import] migrate desktop-3p', e.message); }
  runSessionImport();
  setInterval(runSessionImport, 30_000);

  if (!isDev) setupAutoUpdater();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
    else mainWindow?.show();
  });
});

// 关闭窗口后驻留托盘，不退出进程
app.on('window-all-closed', () => {});

app.on('before-quit', () => {
  isQuitting = true;
  destroyTray();
  agent.stop(); gateway.stop(); localStats.close();
  // 退出即还原所有接入：删 shim / 还原 PATH / 还原配置文件 / 停 MITM，绝不残留
  try { agentLinker.revertEverythingOnExit(); } catch (e) { console.error('[agent-linker] revert on exit failed:', e.message); }
});
