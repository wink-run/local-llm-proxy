'use strict';

/**
 * Token Bank 托盘悬浮窗（参考 AIUsage menu bar popover）
 * 毛玻璃卡片 + 状态分组 + 底部快捷操作，替代原生 Context Menu。
 */
const { BrowserWindow, screen, ipcMain } = require('electron');
const path = require('path');

const POPOVER_W = 360;
const POPOVER_H = 500;

let win = null;
let ready = false;
let deps = null;
let blurTimer = null;
let lastRefreshAt = 0;

function formatRelativeRefresh(lang, ts) {
  if (!ts) return null;
  const sec = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  const zh = lang !== 'en';
  if (sec < 5) return zh ? '刚刚测速' : 'Just tested';
  if (sec < 60) return zh ? `${sec} 秒前测速` : `Tested ${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return zh ? `${min} 分钟前测速` : `Tested ${min}m ago`;
  const hr = Math.floor(min / 60);
  return zh ? `${hr} 小时前测速` : `Tested ${hr}h ago`;
}

function labelsFor(lang) {
  const zh = lang !== 'en';
  // 仅返回可 IPC 序列化的字符串（禁止函数，否则 invoke 会报 Error invoking remote method）
  return zh ? {
    notRefreshed: '尚未测速',
    gateway: '本地网关',
    gatewayStopped: '网关已停止',
    today: '今日用量',
    agent: '贡献 Agent',
    agentRunning: '贡献 Agent 运行中',
    agentStopped: '贡献 Agent 已停止',
    active: '活跃',
    stopped: '已停',
    pillGw: '网关',
    pillAgent: '出租算力',
    pillCircles: '圈子',
    contributing: '出租中',
    notContributing: '未出租',
    squadTitle: '资源',
    squadTag: 'RESOURCES',
    squadEmpty: '启用一个智能体到 Cursor / Claude',
    squadToday: '今日取用 {n}',
    squadCopy: '复制口令',
    squadCopied: '已复制',
    postsUnit: '帖',
    circleLogin: '登录看帖',
    circleEmpty: '暂无新帖',
    showWindow: '主面板',
    showTokens: '菜单栏显示 Token 上下行',
    startAgent: '点击开启贡献',
    stopAgent: '点击停止贡献',
    refresh: '测速',
    speedTesting: '正在测试',
    speedDone: '测速完成',
    speedNone: '无绑定模型可测',
    ttftPending: '待测速',
    ttftFailed: '连接失败',
    todayTokens: '今日',
    quit: '退出',
    callsUnit: '次',
    appsTitle: '活跃应用',
    appsEmpty: '暂无已纳管应用',
    appsTag: 'APPS',
  } : {
    notRefreshed: 'Not tested yet',
    gateway: 'Local Gateway',
    gatewayStopped: 'Gateway stopped',
    today: 'Today',
    agent: 'Contribute Agent',
    agentRunning: 'Contribute Agent running',
    agentStopped: 'Contribute Agent stopped',
    active: 'Active',
    stopped: 'Off',
    pillGw: 'GW',
    pillAgent: 'Rent GPU',
    pillCircles: 'Circles',
    contributing: 'Renting',
    notContributing: 'Idle',
    squadTitle: 'Resources',
    squadTag: 'RESOURCES',
    squadEmpty: 'Enable an assistant to Cursor / Claude',
    squadToday: 'Used today {n}',
    squadCopy: 'Copy invoke',
    squadCopied: 'Copied',
    postsUnit: 'posts',
    circleLogin: 'Sign in',
    circleEmpty: 'No posts',
    showWindow: 'Main Panel',
    showTokens: 'Show tokens in menu bar',
    startAgent: 'Click to start',
    stopAgent: 'Click to stop',
    refresh: 'Speed',
    speedTesting: 'Testing…',
    speedDone: 'Done',
    speedNone: 'No models to probe',
    ttftPending: 'Not tested',
    ttftFailed: 'Failed',
    todayTokens: 'Today',
    quit: 'Quit',
    callsUnit: '×',
    appsTitle: 'Active Apps',
    appsEmpty: 'No managed apps',
    appsTag: 'APPS',
  };
}

function gatewayRunningLabel(lang, port) {
  return lang === 'en' ? `Running :${port}` : `运行中 :${port}`;
}

function buildState() {
  const d = deps;
  if (!d) return { error: 'not-ready', labels: labelsFor('zh') };
  try {
    const gw = d.getGatewayStatus() || {};
    const summary = d.getTodaySummary() || {};
    const inTok = summary.inTok || 0;
    const outTok = summary.outTok || 0;
    const calls = summary.calls || 0;
    const agentRunning = !!d.isAgentRunning();
    const lang = d.getLang() === 'en' ? 'en' : 'zh';
    const L = labelsFor(lang);
    const inFmt = d.fmtTokens(inTok);
    const outFmt = d.fmtTokens(outTok);
    const gwRunning = !!gw.running;
    const port = gw.port || 0;
    const gwDetail = gwRunning ? gatewayRunningLabel(lang, port) : L.gatewayStopped;
    const refreshed = formatRelativeRefresh(lang, lastRefreshAt);
    const subtitle = refreshed
      || (gwRunning ? gwDetail : L.notRefreshed);

    let circlePosts = { count: 0, ok: false, loggedIn: false };
    try {
      circlePosts = d.getCirclePosts?.() || circlePosts;
    } catch { /* ignore */ }

    let apps = [];
    try {
      const raw = d.getActiveApps?.();
      apps = Array.isArray(raw) ? raw : [];
    } catch (e) {
      console.warn('[tray-popover] getActiveApps failed:', e.message);
      apps = [];
    }
    // 保证 IPC 可序列化
    apps = apps.map((a) => ({
      id: String(a.id || ''),
      name: String(a.name || ''),
      agentId: String(a.agentId || ''),
      linkMethod: String(a.linkMethod || ''),
      iconUrl: String(a.iconUrl || ''),
      emoji: String(a.emoji || ''),
      viaGateway: !!a.viaGateway,
      routeLabel: String(a.routeLabel || ''),
      tag: String(a.tag || ''),
      statusLabel: String(a.statusLabel || ''),
      ttftMs: a.ttftMs != null ? Number(a.ttftMs) : null,
      ttftLabel: String(a.ttftLabel || ''),
      speedBucket: String(a.speedBucket || 'unknown'),
      speedFailed: !!a.speedFailed,
      todayTokens: Number(a.todayTokens) || 0,
      todayCalls: Number(a.todayCalls) || 0,
      todayTokensLabel: String(a.todayTokensLabel || '0'),
      active: a.active !== false,
    }));

    const circleCount = Number(circlePosts.count) || 0;
    let circleLabel;
    if (!circlePosts.loggedIn) circleLabel = L.circleLogin;
    else if (circleCount <= 0) circleLabel = L.circleEmpty;
    else circleLabel = `${circleCount}${L.postsUnit}`;

    // 资源：今日取用 + 快捷口令
    let generalsTodayCount = 0;
    let quickInvokes = [];
    try {
      const slice = d.getGeneralsSlice?.() || {};
      generalsTodayCount = Number(slice.todayCount) || 0;
      quickInvokes = Array.isArray(slice.quickInvokes)
        ? slice.quickInvokes.slice(0, 3).map((q) => ({
          id: String(q.id || ''),
          displayName: String(q.displayName || q.name || ''),
          clientId: String(q.clientId || ''),
          invokeText: String(q.invokeText || ''),
          routeLabel: String(q.routeLabel || ''),
        }))
        : [];
    } catch { /* ignore */ }

    const squadBit = lang === 'en'
      ? (generalsTodayCount > 0 ? ` · used ${generalsTodayCount}` : '')
      : (generalsTodayCount > 0 ? ` · 取用 ${generalsTodayCount}` : '');
    const subOut = String(subtitle || L.notRefreshed) + squadBit;

    return {
      lang,
      isMac: process.platform === 'darwin',
      showTokenToggle: process.platform === 'darwin',
      showTokens: !!d.getShowTokens(),
      gatewayRunning: gwRunning,
      gatewayPort: port,
      agentRunning,
      agentLabel: agentRunning ? L.contributing : L.notContributing,
      inFmt: String(inFmt ?? '0'),
      outFmt: String(outFmt ?? '0'),
      calls,
      callsLabel: `${calls}${L.callsUnit}`,
      subtitle: subOut,
      lastRefreshAt: lastRefreshAt || 0,
      circlePostsCount: circleCount,
      circlePostsLabel: String(circleLabel),
      circlePostsOk: !!circlePosts.ok,
      circleLoggedIn: !!circlePosts.loggedIn,
      apps,
      generalsTodayCount,
      quickInvokes,
      labels: {
        ...L,
        gatewayRunningDetail: gwDetail,
      },
    };
  } catch (e) {
    console.error('[tray-popover] buildState failed:', e);
    const L = labelsFor('zh');
    return {
      lang: 'zh',
      isMac: process.platform === 'darwin',
      showTokenToggle: process.platform === 'darwin',
      showTokens: false,
      gatewayRunning: false,
      gatewayPort: 0,
      agentRunning: false,
      agentLabel: L.notContributing,
      inFmt: '0',
      outFmt: '0',
      calls: 0,
      callsLabel: `0${L.callsUnit}`,
      subtitle: String(e?.message || e),
      lastRefreshAt: 0,
      apps: [],
      circlePostsCount: 0,
      circlePostsLabel: '',
      circlePostsOk: false,
      circleLoggedIn: false,
      labels: { ...L, gatewayRunningDetail: L.gatewayStopped },
    };
  }
}

function pushState() {
  if (!win || win.isDestroyed() || !ready) return;
  try {
    win.webContents.send('tray-popover:state', buildState());
  } catch { /* ignore */ }
}

function positionNearTray(tray) {
  if (!win || win.isDestroyed() || !tray) return;
  let tb;
  try { tb = tray.getBounds(); } catch { tb = null; }
  const display = screen.getDisplayNearestPoint(
    tb ? { x: tb.x + tb.width / 2, y: tb.y + tb.height / 2 } : screen.getCursorScreenPoint(),
  );
  const wa = display.workArea;
  const gap = 6;
  let x;
  let y;
  if (tb && tb.width > 0) {
    x = Math.round(tb.x + tb.width / 2 - POPOVER_W / 2);
    // 菜单栏在顶部：窗体在图标下方；部分 Linux 在底部
    if (tb.y < wa.y + 80) {
      y = Math.round(tb.y + tb.height + gap);
    } else {
      y = Math.round(tb.y - POPOVER_H - gap);
    }
  } else {
    const cursor = screen.getCursorScreenPoint();
    x = cursor.x - POPOVER_W / 2;
    y = cursor.y + gap;
  }
  x = Math.max(wa.x + 8, Math.min(x, wa.x + wa.width - POPOVER_W - 8));
  y = Math.max(wa.y + 8, Math.min(y, wa.y + wa.height - POPOVER_H - 8));
  win.setPosition(x, y, false);
}

function ensureWindow() {
  if (win && !win.isDestroyed()) return win;

  const opts = {
    width: POPOVER_W,
    height: POPOVER_H,
    show: false,
    frame: false,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    transparent: true,
    hasShadow: true,
    focusable: true,
    webPreferences: {
      preload: path.join(__dirname, 'tray-popover-preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  };
  if (process.platform === 'darwin') {
    opts.vibrancy = 'popover';
    opts.visualEffectState = 'active';
    opts.backgroundColor = '#00000000';
  } else {
    opts.backgroundColor = '#00000000';
  }

  win = new BrowserWindow(opts);
  ready = false;
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  win.setAlwaysOnTop(true, 'pop-up-menu');
  win.loadFile(path.join(__dirname, 'tray-popover.html'));

  win.webContents.on('did-finish-load', () => {
    ready = true;
    pushState();
  });

  // 失焦关闭（短延迟，避免点 tray 切换时误关）
  win.on('blur', () => {
    if (blurTimer) clearTimeout(blurTimer);
    blurTimer = setTimeout(() => {
      if (win && !win.isDestroyed() && !win.isFocused()) hide();
    }, 120);
  });

  win.on('closed', () => {
    win = null;
    ready = false;
  });

  return win;
}

function show(tray) {
  ensureWindow();
  if (blurTimer) { clearTimeout(blurTimer); blurTimer = null; }
  // 先定位并亮窗，避免 syncStats / buildState 卡住首帧
  positionNearTray(tray);
  if (!win.isVisible()) win.show();
  win.focus();
  if (ready) pushState();
  // 延迟刷用量，优先保证亮窗动画流畅
  setTimeout(() => {
    try { deps?.syncStats?.(); } catch { /* ignore */ }
    pushState();
  }, 40);
}

/** 启动时预创建隐藏窗口，避免首次点击再 loadFile 卡顿 */
function warmup() {
  try { ensureWindow(); } catch { /* ignore */ }
}

function hide() {
  if (blurTimer) { clearTimeout(blurTimer); blurTimer = null; }
  if (win && !win.isDestroyed() && win.isVisible()) win.hide();
}

function toggle(tray) {
  if (win && !win.isDestroyed() && win.isVisible()) {
    hide();
    return false;
  }
  show(tray);
  return true;
}

function refresh() {
  pushState();
}

function destroy() {
  if (blurTimer) { clearTimeout(blurTimer); blurTimer = null; }
  if (win && !win.isDestroyed()) {
    win.removeAllListeners();
    win.destroy();
  }
  win = null;
  ready = false;
}

function registerIpc() {
  ipcMain.removeHandler('tray-popover:getState');
  ipcMain.removeHandler('tray-popover:action');

  ipcMain.handle('tray-popover:getState', () => buildState());

  ipcMain.handle('tray-popover:action', async (_e, payload = {}) => {
    const name = payload.name;
    const d = deps;
    if (!d) return buildState();

    switch (name) {
      case 'refresh':
      case 'speedTest': {
        // 测速：对活跃应用已选模型/路由发探针
        try { d.syncStats?.(); } catch { /* ignore */ }
        let probe = { total: 0 };
        try {
          probe = (await d.probeActiveModels?.()) || probe;
        } catch (e) {
          console.warn('[tray-popover] probe failed:', e.message);
        }
        try { await d.refreshCirclePosts?.(); } catch { /* ignore */ }
        lastRefreshAt = Date.now();
        d.refreshTrayIcon?.();
        const state = buildState();
        state.speedProbeTotal = Number(probe.total) || 0;
        // 摘要：成功探针的平均首字延迟
        const okTtfts = (probe.results || [])
          .map((r) => Number(r.ttftMs ?? r.firstTokenMs))
          .filter((n) => Number.isFinite(n) && n > 0);
        if (okTtfts.length) {
          const avg = Math.round(okTtfts.reduce((a, b) => a + b, 0) / okTtfts.length);
          state.speedAvgTtftMs = avg;
          const zh = state.lang !== 'en';
          state.subtitle = zh
            ? `测速完成 · 均 TTFT ${avg}ms`
            : `Done · avg TTFT ${avg}ms`;
        }
        return state;
      }
      case 'showWindow':
        hide();
        d.showMainWindow();
        break;
      case 'quit':
        hide();
        d.quitApp();
        break;
      case 'startAgent':
        if (!d.isUserLoggedIn()) {
          hide();
          d.showMainWindow();
          d.navigateLogin?.();
        } else {
          d.startAgent();
        }
        break;
      case 'stopAgent':
        d.stopAgent();
        break;
      case 'toggleAgent': {
        // 点击贡献胶囊：运行中则停止，否则开启（未登录跳转登录）
        if (d.isAgentRunning()) {
          d.stopAgent();
        } else if (!d.isUserLoggedIn()) {
          hide();
          d.showMainWindow();
          d.navigateLogin?.();
        } else {
          d.startAgent();
        }
        d.refreshTrayIcon?.();
        break;
      }
      case 'toggleTokens':
        d.setShowTokens(!d.getShowTokens());
        d.refreshTrayIcon?.();
        break;
      case 'openSquad':
        hide();
        d.showMainWindow?.();
        try { d.navigateResources?.(); } catch { /* ignore */ }
        break;
      case 'copyInvoke': {
        const text = String(payload.text || '');
        if (text && d.copyText) {
          try { d.copyText(text); } catch { /* ignore */ }
        }
        break;
      }
      default:
        break;
    }
    return buildState();
  });
}

/**
 * @param {object} d 依赖注入，避免 tray-popover 反向依赖 main 全局
 */
function init(d) {
  deps = d;
  registerIpc();
}

module.exports = {
  init,
  show,
  hide,
  toggle,
  refresh,
  destroy,
  warmup,
  isVisible: () => !!(win && !win.isDestroyed() && win.isVisible()),
};
