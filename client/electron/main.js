const { app, BrowserWindow, Tray, Menu, ipcMain, nativeImage, shell, clipboard, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const http = require('http');
const https = require('https');
const { autoUpdater } = require('electron-updater');
const agent = require('./agent-worker');
const gateway = require('./local-gateway');
const localStats = require('./local-stats');
const sessionImport = require('./session-import');
const detectTools = require('./detect-tools');
const agentLinker = require('./agent-linker');
// device-reporter is used by the CLI only; desktop registration is handled
// by useDeviceReporter in the renderer (which has access to the JWT).

const isDev = !app.isPackaged;
const VITE_URL = 'http://localhost:5173';
const AGENT_CONFIG_PATH = path.join(os.homedir(), '.llm-agent', 'config.json');

let mainWindow = null;
let tray = null;

// ── Icons ──────────────────────────────────────────────────────────────────────

function getTrayIcon(state) {
  const name = state === 'running' ? 'tray-green.png' : 'tray-gray.png';
  const iconPath = path.join(__dirname, '..', 'assets', name);
  if (!fs.existsSync(iconPath)) return nativeImage.createEmpty();
  const img = nativeImage.createFromPath(iconPath);
  img.setTemplateImage(false);
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
  mainWindow = new BrowserWindow({
    width: 960,
    height: 680,
    minWidth: 800,
    minHeight: 560,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
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
  });

  mainWindow.on('close', (e) => {
    if (process.platform === 'darwin') {
      e.preventDefault();
      mainWindow.hide();
    }
  });
}

// ── Tray ──────────────────────────────────────────────────────────────────────

let trayStatsTimer = null;

function updateTrayTitle() {
  if (!tray) return;
  if (process.platform !== 'darwin') return;
  const { running: r, activeRequests, tokensPerMin } = agent.getStats();
  if (!r) { tray.setTitle(''); return; }
  const parts = [];
  if (activeRequests > 0) parts.push(`${activeRequests}req`);
  if (tokensPerMin > 0) parts.push(`${tokensPerMin}tok/m`);
  tray.setTitle(parts.length ? parts.join(' ') : '●');
}

function createTray() {
  tray = new Tray(getTrayIcon('stopped'));
  tray.setToolTip('LLM Proxy');
  updateTrayMenu();
  tray.on('double-click', () => { mainWindow?.show(); mainWindow?.focus(); });
  if (process.platform === 'darwin') {
    trayStatsTimer = setInterval(updateTrayTitle, 2000);
  }
}

function updateTrayMenu() {
  const running = agent.isRunning();
  const menu = Menu.buildFromTemplate([
    { label: running ? 'Agent 运行中' : 'Agent 已停止', enabled: false },
    { type: 'separator' },
    { label: '启动 Agent', enabled: !running, click: startAgent },
    { label: '停止 Agent', enabled: running, click: stopAgent },
    { type: 'separator' },
    { label: '打开主窗口', click: () => { mainWindow?.show(); mainWindow?.focus(); } },
    { type: 'separator' },
    { label: '退出', click: () => app.quit() },
  ]);
  tray.setContextMenu(menu);
  tray.setImage(getTrayIcon(running ? 'running' : 'stopped'));
}

// ── Agent ─────────────────────────────────────────────────────────────────────

function startAgent() {
  console.log('[main] startAgent called, isRunning=', agent.isRunning());
  agent.start({
    onLog: (line) => {
      console.log('[agent-log]', line);
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

function setupAutoUpdater() {
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;

  autoUpdater.on('update-available', (info) => {
    mainWindow?.webContents.send('update:available', {
      version: info.version,
      releaseNotes: info.releaseNotes ?? null,
    });
  });

  autoUpdater.on('download-progress', (progress) => {
    mainWindow?.webContents.send('update:progress', {
      percent: Math.round(progress.percent),
    });
  });

  autoUpdater.on('update-downloaded', (info) => {
    mainWindow?.webContents.send('update:downloaded', { version: info.version });
  });

  autoUpdater.on('error', (err) => {
    console.error('[updater] error:', err.message);
    mainWindow?.webContents.send('update:error');
  });

  setTimeout(() => autoUpdater.checkForUpdates().catch((err) => {
    console.error('[updater] checkForUpdates error:', err.message);
  }), 5000);
}

// ── Agent config helpers ──────────────────────────────────────────────────────

function readAgentConfig() {
  try { return JSON.parse(fs.readFileSync(AGENT_CONFIG_PATH, 'utf-8')); }
  catch { return null; }
}

function writeAgentConfig(cfg) {
  fs.mkdirSync(path.dirname(AGENT_CONFIG_PATH), { recursive: true });
  fs.writeFileSync(AGENT_CONFIG_PATH, JSON.stringify(cfg, null, 2), 'utf-8');
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
          request_format: 'auto',
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
      return cfg;
    }
  } catch {}
  // 全新安装：从两个默认文件初始化
  const defaultRoutes = loadDefaultYamlSection('tokenbank.routes.default.yaml', 'scene_routes') || [];
  return {
    scene_routes: defaultRoutes.map(r => ({ ...r, created_at: new Date().toISOString() })),
    local_keys: [], apps: [],
    policies: DEFAULT_POLICIES.map(p => ({ ...p, created_at: new Date().toISOString() })),
    initialized_routes: defaultRoutes.length > 0,
    auto_host_disabled: [],
  };
}

function writeLocalConfig(cfg) {
  fs.writeFileSync(localConfigPath(), JSON.stringify(cfg, null, 2), 'utf8');
}

// 自动托管：对机器上已安装、尚未托管、且用户未显式取消的 shim 工具自动接入。
// 返回本次新托管的 agent_id 数组。默认启用，无需用户手动操作。
function autoHostInstalledApps() {
  const cfg = readLocalConfig();
  const disabled = new Set(cfg.auto_host_disabled || []);
  const newlyHosted = [];
  for (const t of agentLinker.list()) {
    // GUI 应用(需装证书 / 改系统代理)不自动托管，必须用户显式操作
    if (t.needs_ca || t.strategy === 'mitm-system') continue;
    if (t.installed && !t.linked && !disabled.has(t.id)) {
      try {
        const r = agentLinker.applyById(t.id);
        if (r && r.ok !== false) newlyHosted.push(t.id);
      } catch (e) { console.error('[auto-host]', t.id, e.message); }
    }
  }
  return newlyHosted;
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

function nodeRequest(url, method, headers, body) {
  return new Promise((resolve) => {
    const u = new URL(url);
    const mod = u.protocol === 'https:' ? https : http;
    const opts = {
      hostname: u.hostname,
      port: u.port || (u.protocol === 'https:' ? 443 : 80),
      path: u.pathname + (u.search || ''),
      method, headers, timeout: 120000,
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
  ipcMain.handle('agent:start', () => { startAgent(); return { running: agent.isRunning() }; });
  ipcMain.handle('agent:stop',  () => { stopAgent();  return { running: false }; });
  ipcMain.handle('agent:status', () => ({ running: agent.isRunning() }));
  ipcMain.handle('config:read',  () => readAgentConfig());
  ipcMain.handle('config:write', (_e, cfg) => { writeAgentConfig(cfg); return { ok: true }; });
  ipcMain.handle('config:scan',  () => scanLLMConfigs());
  ipcMain.handle('config:importKeys', () => scanProviderKeys());

  // Write Claude Code config into ~/.claude/settings.local.json
  ipcMain.handle('claude:configure', async (_e, { baseUrl, apiKey, models = [] }) => {
    const settingsPath = path.join(os.homedir(), '.claude', 'settings.local.json');
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
    const settingsPath = path.join(os.homedir(), '.claude', 'settings.local.json');
    try {
      const s = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
      return { configured: !!(s.env?.ANTHROPIC_BASE_URL && s.env?.ANTHROPIC_AUTH_TOKEN) };
    } catch { return { configured: false }; }
  });

  // Buffered HTTP request (for models list, non-streaming chat)
  ipcMain.handle('llm:fetch', async (_e, { url, method = 'GET', headers = {}, body }) => {
    return nodeRequest(url, method, headers, body);
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
    autoUpdater.quitAndInstall();
  });

  ipcMain.handle('gateway:status',        () => gateway.getStatus());
  ipcMain.handle('gateway:getLog',        () => gateway.getLog());
  ipcMain.handle('gateway:restart',       () => gateway.restart());
  ipcMain.handle('localStats:query', (_e, days) => {
    const d = Math.max(1, Math.min(365, parseInt(days, 10) || 1));
    return localStats.queryDashboard(d);
  });
  // 手动触发会话文件补录（扫 ~/.claude、~/.codex、~/.gemini），返回各来源计数
  ipcMain.handle('sessionImport:run', () => sessionImport.run(localStats));
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

  // ── 根证书（GUI 应用 MITM 托管前置）：状态 / 安装 / 卸载 ──
  const caManager = require('./ca-manager');
  ipcMain.handle('ca:status',    () => {
    try { return { installed: caManager.isInstalledInSystem() }; }
    catch (e) { return { installed: false, error: e.message }; }
  });
  ipcMain.handle('ca:install',   () => { try { return caManager.installToSystem(); } catch (e) { return { ok: false, error: e.message }; } });
  ipcMain.handle('ca:uninstall', () => { try { return caManager.uninstallFromSystem(); } catch (e) { return { ok: false, error: e.message }; } });

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
  const TB_YAML = path.join(os.homedir(), '.tokenbank', 'tokenbank.yaml');
  const TOOLS_SECTIONS = new Set(['version','tools','mitm','gateway']);
  const ROUTES_SECTIONS = new Set(['scene_routes']);

  function applyConfigDoc(parsed, source) {
    if (!parsed || typeof parsed !== 'object') return { ok: false, error: '无效的 yaml 格式' };
    const yamlLib = require('js-yaml');
    const applied = { tools: false, routes: false };

    // 有 tools 相关段 → 写 tokenbank.yaml + reload config-loader
    const hasToolsSection = Object.keys(parsed).some(k => TOOLS_SECTIONS.has(k) && k !== 'version');
    if (hasToolsSection) {
      const tbDir = path.join(os.homedir(), '.tokenbank');
      if (!fs.existsSync(tbDir)) fs.mkdirSync(tbDir, { recursive: true });
      // 只保留 tools 相关的段写入 yaml（剥离 scene_routes 等路由段）
      const toolsDoc = {};
      for (const k of Object.keys(parsed)) {
        if (TOOLS_SECTIONS.has(k) || k === 'version') toolsDoc[k] = parsed[k];
      }
      fs.writeFileSync(TB_YAML, yamlLib.dump(toolsDoc, { lineWidth: 120 }), 'utf8');
      configLoader.load();
      applied.tools = true;
    }

    // 有 scene_routes 段 → 写入 local-config，标记已导入（不再用默认文件）
    if (Array.isArray(parsed.scene_routes) && parsed.scene_routes.length > 0) {
      const cfg = readLocalConfig();
      cfg.scene_routes = parsed.scene_routes.map(r => ({
        ...r, created_at: r.created_at || new Date().toISOString(),
      }));
      cfg.initialized_routes = true;   // 标记：已有用户导入数据，不再用默认文件
      writeLocalConfig(cfg);
      syncGatewayFromConfig(cfg);
      applied.routes = true;
    }

    if (!applied.tools && !applied.routes) {
      return { ok: false, error: '文件中未找到可识别的配置段（tools / scene_routes）' };
    }
    return { ok: true, source, applied };
  }

  function fetchYaml(url) {
    const https = require('https'); const http = require('http');
    return new Promise((resolve, reject) => {
      const mod = url.startsWith('https') ? https : http;
      mod.get(url, { timeout: 10000 }, res => {
        let data = '';
        res.on('data', c => data += c);
        res.on('end', () => resolve(data));
        res.on('error', reject);
      }).on('error', reject);
    });
  }

  ipcMain.handle('toolsConfig:load', () => {
    try {
      if (fs.existsSync(TB_YAML)) return { ok: true, source: 'user', text: fs.readFileSync(TB_YAML, 'utf8') };
      const def = path.join(__dirname, 'config', 'tokenbank.tools.default.yaml');
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

  ipcMain.handle('toolsConfig:importUrl', async (_e, url) => {
    try {
      const text = await fetchYaml(url);
      const parsed = require('js-yaml').load(text);
      return applyConfigDoc(parsed, url);
    } catch (e) { return { ok: false, error: e.message }; }
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
      if (r.model_key && r.steps?.length) {
        routerMap[r.model_key] = { steps: r.steps, scene_name: r.scene_name };
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
    try { for (const t of require('./config-loader').tools()) toolProto[t.id] = t.protocol; } catch {}

    const appControls = [];
    for (const app of apps) {
      const ctrl = {
        app_id: app.id, app_name: app.name,
        allow_stream:   app.allow_stream !== false,
        request_format: app.request_format || 'auto',
        max_rpm:        app.max_rpm || null,
        max_concurrent: app.max_concurrent || null,
        allowed_models: app.allowed_models || [],
      };
      if (app.link_method === 'api-key' && app.api_key) {
        appControls.push({ ...ctrl, match: { key: app.api_key } });
      } else if (app.link_method === 'shim' && app.agent_id) {
        const path = PROTOCOL_PATH[toolProto[app.agent_id]];
        if (path) appControls.push({ ...ctrl, match: { path } });
      }
    }
    gateway.setAppControls(appControls);

    // P2P backend config
    const cc = cfg.cloud_config || {};
    if (cc.url && cc.token) gateway.setBackendConfig({ url: cc.url, token: cc.token });
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
  syncGatewayFromConfig(_initCfg);
  fetchPeerModels(_initCfg.cloud_config?.url, _initCfg.cloud_config?.token);

  ipcMain.handle('localConfig:get', () => readLocalConfig());

  ipcMain.handle('localConfig:createSceneRoute', (_e, { scene_name, icon, steps }) => {
    const cfg   = readLocalConfig();
    const route = {
      id: rndHex(8), scene_name, icon: icon || '🔀',
      steps: steps || [],
      model_key: 'llm-router-' + rndHex(6),
      created_at: new Date().toISOString(),
    };
    cfg.scene_routes.push(route);
    writeLocalConfig(cfg);
    syncGatewayFromConfig(cfg);
    return route;
  });

  ipcMain.handle('localConfig:updateSceneRoute', (_e, { id, scene_name, icon, steps }) => {
    const cfg = readLocalConfig();
    const idx = cfg.scene_routes.findIndex(r => r.id === id);
    if (idx === -1) return null;
    cfg.scene_routes[idx] = { ...cfg.scene_routes[idx], scene_name, icon, steps };
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
  // 应用结构：{ id, name, icon, link_method(shim|api-key), api_key, route_id,
  //             description, allowed_models[], max_rpm, max_concurrent,
  //             allow_stream, request_format(auto|openai|anthropic), created_at }

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

  ipcMain.handle('apps:list', () => {
    // 每次拉列表时先自动托管新出现的应用（机器上有了就直接托管）
    autoHostInstalledApps();

    const savedApps = getApps();
    const agentTools = agentLinker.list();

    // 把 yaml tools 里有、但 apps[] 里还没有 shim 记录的 agent，动态补入
    const shimIds = new Set(savedApps.filter(a => a.link_method === 'shim').map(a => a.agent_id));
    const TOOL_ICONS = { 'claude-code': '🤖', 'codex': '💻', 'gemini-cli': '🔮',
                         'claude-desktop': '🖥️', 'codex-desktop': '🖥️' };
    const TOOL_NAMES = { 'claude-code': 'Claude Code', 'codex': 'Codex CLI', 'gemini-cli': 'Gemini CLI' };
    const caInstalled = (() => { try { return require('./ca-manager').isInstalledInSystem(); } catch { return false; } })();
    const virtualShimApps = agentTools
      .filter(t => !shimIds.has(t.id))
      .map(t => ({
        id: 'app-shim-' + t.id,
        name: TOOL_NAMES[t.id] || t.name || t.id,
        icon: TOOL_ICONS[t.id] || '🤖',
        link_method: 'shim',
        agent_id: t.id,
        api_key: null,
        route_id: null,
        description: '',
        type: t.type || 'cli',
        needs_ca: !!t.needs_ca,
        unsupported: !!t.unsupported,
        note: t.note || null,
        installed: t.installed,
        linked: t.linked,
        _virtual: true,   // 未持久化，仅展示
      }));

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

    // 注入实时托管状态 + 自动配置详情
    return allApps
      .map(app => {
        if (app.link_method === 'shim') {
          const tool = agentTools.find(t => t.id === app.agent_id);
          return {
            ...app,
            linked: tool ? tool.linked : false,
            installed: tool ? tool.installed : false,
            type: tool ? tool.type : (app.type || 'cli'),
            needs_ca: tool ? tool.needs_ca : !!app.needs_ca,
            unsupported: tool ? tool.unsupported : !!app.unsupported,
            note: tool ? tool.note : (app.note || null),
            ca_installed: caInstalled,            // 系统是否已装根证书
            auto_config: autoConfigOf(app.agent_id),
          };
        }
        return { ...app, linked: true, installed: true };
      })
      // 机器上没有的 shim 应用不展示（yaml 里有但本机没装的隐藏）；api-key 应用始终展示
      .filter(app => app.link_method !== 'shim' || app.installed);
  });

  ipcMain.handle('apps:create', (_e, data) => {
    const apps = getApps();
    const app = {
      id: 'app-' + rndHex(8),
      name: data.name || '未命名应用',
      icon: data.icon || '🔧',
      link_method: data.link_method || 'api-key',
      agent_id: data.agent_id || null,           // shim 类专用，对应 tool id
      api_key: data.link_method === 'api-key'
        ? ('sk-local-' + rndHex(16)) : null,
      route_id: data.route_id || null,
      description: data.description || '',
      allowed_models: data.allowed_models || [],
      max_rpm: data.max_rpm || null,
      max_concurrent: data.max_concurrent || null,
      allow_stream: data.allow_stream !== false,
      request_format: data.request_format || 'auto',
      env: data.env || null,                     // 需写入工具的环境变量模板（{BASE}/{KEY} 占位）
      preset_id: data.preset_id || null,         // 来自哪个已识别应用预设
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
    return apps[idx];
  });

  ipcMain.handle('apps:delete', (_e, id) => {
    const apps = getApps().filter(a => a.id !== id);
    saveApps(apps);
    return { ok: true };
  });

  ipcMain.handle('apps:regenKey', (_e, id) => {
    const apps = getApps();
    const idx = apps.findIndex(a => a.id === id);
    if (idx === -1 || apps[idx].link_method !== 'api-key') return { ok: false };
    apps[idx].api_key = 'sk-local-' + rndHex(16);
    saveApps(apps);
    return { ok: true, api_key: apps[idx].api_key };
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

  // 注册来自 toolsConfig 的 shim 托管 app（透明托管时自动创建或更新 app 记录）
  // shim agent_id → data_source 对应关系
  const AGENT_DATA_SOURCE = {
    'claude-code': 'session-claude',
    'codex':       'session-codex',
    'gemini-cli':  'session-gemini',
  };

  // 批量查所有应用的统计（调一次，合并进 apps:list 或单独查询）
  ipcMain.handle('apps:stats', (_e, appList) => {
    const stats = {};
    for (const app of (appList || [])) {
      let s;
      if (app.link_method === 'api-key' && app.api_key) {
        s = localStats.queryByApiKey(app.api_key);
      } else if (app.link_method === 'shim' && app.agent_id) {
        const ds = AGENT_DATA_SOURCE[app.agent_id];
        s = ds ? localStats.queryByDataSource(ds) : { calls: 0, tokens: 0, lastTs: null };
      } else {
        s = { calls: 0, tokens: 0, lastTs: null };
      }
      stats[app.id] = s;
    }
    return stats;
  });

  ipcMain.handle('apps:ensureShimApp', (_e, { agent_id, name, icon }) => {
    const apps = getApps();
    const existing = apps.find(a => a.agent_id === agent_id && a.link_method === 'shim');
    if (existing) return existing;
    const app = {
      id: 'app-shim-' + agent_id,
      name, icon: icon || '🤖',
      link_method: 'shim', agent_id,
      api_key: null, route_id: null,
      description: '', allowed_models: [], max_rpm: null,
      max_concurrent: null, allow_stream: true, request_format: 'auto',
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

  ipcMain.handle('gateway:testProvider', async (_e, { base_url, token } = {}) => {
    if (!base_url || typeof base_url !== 'string') return { ok: false, error: 'base_url required' };
    try {
      const result = await nodeRequest(
        base_url.replace(/\/$/, '') + '/models',
        'GET',
        token ? { Authorization: `Bearer ${token}` } : {},
        null,
      );
      return { ok: result.status >= 200 && result.status < 400, status: result.status };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  // Periodically refresh P2P model list so newly available models are detected
  setInterval(() => {
    const cc = readLocalConfig().cloud_config || {};
    if (cc.url && cc.token) fetchPeerModels(cc.url, cc.token);
  }, 60_000);
}

// ── App lifecycle ─────────────────────────────────────────────────────────────

app.whenReady().then(() => {
  createWindow();
  createTray();
  registerIPC();
  // Init local SQLite stats DB in Electron userData directory
  localStats.init(app.getPath('userData'));
  gateway.setStatsRecorder(localStats.record);
  gateway.setLocalStats(localStats);
  gateway.setLocalConfigReader(readLocalConfig);   // 供策略组调度查 policies[]
  gateway.start(11430, readAgentConfig);

  // 默认启用一键托管：启动时自动接入本机已安装、用户未取消的 CLI 工具。
  try {
    const hosted = autoHostInstalledApps();
    if (hosted && hosted.length) console.log('[auto-host] hosted on startup:', hosted.join(', '));
  } catch (e) { console.error('[auto-host] startup failed:', e.message); }

  // 补录「不走网关、直连官方」的会话用量：启动跑一次 + 每 60s 增量扫一次。
  // 与网关实时记录靠 request_id 跨来源去重，不会重复计。
  const runSessionImport = () => { try { sessionImport.run(localStats); } catch (e) { console.error('[session-import]', e.message); } };
  runSessionImport();
  setInterval(runSessionImport, 60_000);

  if (!isDev) setupAutoUpdater();

  // Auto-start agent if configured
  const cfg = readAgentConfig();
  if (cfg?.auto_start && cfg?.worker_key) {
    startAgent();
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
    else mainWindow?.show();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  agent.stop(); gateway.stop(); localStats.close();
  // 退出即还原所有接入：删 shim / 还原 PATH / 还原配置文件 / 停 MITM，绝不残留
  try { agentLinker.revertEverythingOnExit(); } catch (e) { console.error('[agent-linker] revert on exit failed:', e.message); }
});
