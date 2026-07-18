// client/electron/cursor-ide-auth.js
// 从 Cursor IDE 会话共享登录给 cursor-agent（仅读 state.vscdb + 可选写 auth.json，不碰钥匙串）
//
// 对比 Tutti：Tutti 只探测 `cursor-agent status` / 要求主机自行 `cursor-agent login` 或
// CURSOR_API_KEY，不桥接 IDE 登录。此处更进一步：复用 IDE 已登录的 accessToken。
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const AUTH_JSON = path.join(os.homedir(), '.cursor', 'auth.json');

/** IDE state.vscdb 路径（macOS / Windows / Linux） */
function resolveIdeStateDb() {
  if (process.platform === 'darwin') {
    return path.join(
      os.homedir(),
      'Library', 'Application Support', 'Cursor', 'User', 'globalStorage', 'state.vscdb',
    );
  }
  if (process.platform === 'win32') {
    const appData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
    return path.join(appData, 'Cursor', 'User', 'globalStorage', 'state.vscdb');
  }
  return path.join(os.homedir(), '.config', 'Cursor', 'User', 'globalStorage', 'state.vscdb');
}

/** 只读 ItemTable（优先 better-sqlite3；失败回退 sqlite3 CLI；不碰钥匙串） */
function readIdeItem(key) {
  const dbPath = resolveIdeStateDb();
  if (!fs.existsSync(dbPath)) return null;
  const k = String(key);

  try {
    const Database = require('better-sqlite3');
    const db = new Database(dbPath, { readonly: true, fileMustExist: true });
    try {
      const row = db.prepare('SELECT value FROM ItemTable WHERE key = ?').get(k);
      const v = row?.value;
      if (v == null) return null;
      return Buffer.isBuffer(v) ? v.toString('utf8') : String(v);
    } finally {
      try { db.close(); } catch { /* ignore */ }
    }
  } catch {
    // Electron ABI 的 better-sqlite3 在系统 Node 单测里会失败，回退 CLI
  }

  try {
    const { execFileSync } = require('child_process');
    const out = execFileSync(
      'sqlite3',
      [dbPath, `SELECT value FROM ItemTable WHERE key='${k.replace(/'/g, "''")}';`],
      { encoding: 'utf8', timeout: 3000, maxBuffer: 2 * 1024 * 1024 },
    ).trim();
    return out || null;
  } catch {
    return null;
  }
}

/**
 * 读取 Cursor IDE 当前登录（access / refresh JWT）。
 * @returns {{ accessToken: string, refreshToken: string, email: string|null }|null}
 */
function readIdeCursorSession() {
  const accessToken = readIdeItem('cursorAuth/accessToken');
  if (!accessToken || accessToken.length < 20) return null;
  const refreshToken = readIdeItem('cursorAuth/refreshToken') || accessToken;
  const email = readIdeItem('cursorAuth/cachedEmail');
  return { accessToken, refreshToken, email };
}

/**
 * 将 IDE 会话写入 ~/.cursor/auth.json（文件凭证；macOS 上 CLI 仍可能优先钥匙串，
 * 但 spawn 时我们另注 CURSOR_AUTH_TOKEN，不依赖钥匙串读写）。
 */
function syncIdeAuthJson(session = null) {
  const s = session || readIdeCursorSession();
  if (!s?.accessToken) return { ok: false, reason: 'no_ide_session' };
  try {
    fs.mkdirSync(path.dirname(AUTH_JSON), { recursive: true });
    const payload = {
      accessToken: s.accessToken,
      refreshToken: s.refreshToken || s.accessToken,
    };
    fs.writeFileSync(AUTH_JSON, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 });
    try { fs.chmodSync(AUTH_JSON, 0o600); } catch { /* ignore */ }
    return { ok: true, path: AUTH_JSON, email: s.email || null };
  } catch (e) {
    return { ok: false, reason: e.message };
  }
}

/**
 * 为 spawn cursor-agent 准备环境：注入 CURSOR_AUTH_TOKEN（官方隐藏/支持通道）。
 * 不使用钥匙串 API；不设置 CURSOR_API_KEY（IDE JWT 不是 API Key）。
 */
function buildCursorSpawnEnv(baseEnv = process.env) {
  const env = { ...baseEnv };
  // 避免误把会话 JWT 当 API Key
  if (env.CURSOR_API_KEY && /^eyJ/.test(String(env.CURSOR_API_KEY))) {
    delete env.CURSOR_API_KEY;
  }

  const session = readIdeCursorSession();
  if (!session?.accessToken) {
    return { env, injected: false, reason: 'no_ide_session' };
  }

  // 文件侧同步（非钥匙串）；失败不阻断 env 注入
  syncIdeAuthJson(session);

  env.CURSOR_AUTH_TOKEN = session.accessToken;
  return {
    env,
    injected: true,
    email: session.email || null,
    reason: 'ide_state_vscdb',
  };
}

module.exports = {
  AUTH_JSON,
  resolveIdeStateDb,
  readIdeCursorSession,
  syncIdeAuthJson,
  buildCursorSpawnEnv,
};
