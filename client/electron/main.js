const { app, BrowserWindow, Tray, Menu, ipcMain, nativeImage } = require('electron');
const path = require('path');
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');

const isDev = process.env.NODE_ENV !== 'production';
const VITE_URL = 'http://localhost:5173';
const AGENT_CONFIG_PATH = path.join(os.homedir(), '.llm-agent', 'config.json');

let mainWindow = null;
let tray = null;
let agentProcess = null;

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

  if (isDev) {
    mainWindow.loadURL(VITE_URL);
  } else {
    mainWindow.loadFile(path.join(__dirname, '..', 'dist', 'index.html'));
  }

  mainWindow.once('ready-to-show', () => mainWindow.show());

  mainWindow.on('close', (e) => {
    // On macOS, hide instead of quit when clicking the red X
    if (process.platform === 'darwin') {
      e.preventDefault();
      mainWindow.hide();
    }
  });
}

// ── Tray ──────────────────────────────────────────────────────────────────────

function createTray() {
  tray = new Tray(getTrayIcon('stopped'));
  tray.setToolTip('LLM Proxy');
  updateTrayMenu();
  tray.on('double-click', () => {
    mainWindow?.show();
    mainWindow?.focus();
  });
}

function updateTrayMenu() {
  const running = agentProcess !== null;
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

// ── Agent subprocess ──────────────────────────────────────────────────────────

function getAgentCmd() {
  if (isDev) {
    // In dev, run the Python agent directly
    const agentScript = path.join(__dirname, '..', '..', 'agent', 'agent.py');
    return { cmd: 'python3', extraArgs: [agentScript] };
  }
  // In production, use the bundled binary placed by electron-builder extraResources
  const ext = process.platform === 'win32' ? '.exe' : '';
  return { cmd: path.join(process.resourcesPath, `llm-agent${ext}`), extraArgs: [] };
}

function startAgent() {
  if (agentProcess) return;
  if (!fs.existsSync(AGENT_CONFIG_PATH)) {
    mainWindow?.webContents.send('agent:status', { running: false, error: 'config missing — save Agent config first' });
    return;
  }
  const { cmd, extraArgs } = getAgentCmd();
  const args = [...extraArgs, 'start', '--config', AGENT_CONFIG_PATH];
  agentProcess = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });

  agentProcess.stdout.on('data', (d) => mainWindow?.webContents.send('agent:log', d.toString()));
  agentProcess.stderr.on('data', (d) => mainWindow?.webContents.send('agent:log', d.toString()));
  agentProcess.on('exit', () => {
    agentProcess = null;
    mainWindow?.webContents.send('agent:status', { running: false });
    updateTrayMenu();
  });

  mainWindow?.webContents.send('agent:status', { running: true });
  updateTrayMenu();
}

function stopAgent() {
  if (!agentProcess) return;
  agentProcess.kill('SIGTERM');
  agentProcess = null;
  mainWindow?.webContents.send('agent:status', { running: false });
  updateTrayMenu();
}

// ── Agent config helpers ──────────────────────────────────────────────────────

function readAgentConfig() {
  try {
    return JSON.parse(fs.readFileSync(AGENT_CONFIG_PATH, 'utf-8'));
  } catch {
    return null;
  }
}

function writeAgentConfig(cfg) {
  fs.mkdirSync(path.dirname(AGENT_CONFIG_PATH), { recursive: true });
  fs.writeFileSync(AGENT_CONFIG_PATH, JSON.stringify(cfg, null, 2), 'utf-8');
}

// ── IPC handlers ──────────────────────────────────────────────────────────────

function registerIPC() {
  ipcMain.handle('agent:start', () => { startAgent(); return { running: !!agentProcess }; });
  ipcMain.handle('agent:stop', () => { stopAgent(); return { running: false }; });
  ipcMain.handle('agent:status', () => ({ running: !!agentProcess }));
  ipcMain.handle('config:read', () => readAgentConfig());
  ipcMain.handle('config:write', (_e, cfg) => { writeAgentConfig(cfg); return { ok: true }; });
}

// ── App lifecycle ─────────────────────────────────────────────────────────────

app.whenReady().then(() => {
  createWindow();
  createTray();
  registerIPC();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
    else { mainWindow?.show(); }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  if (agentProcess) agentProcess.kill('SIGTERM');
});
