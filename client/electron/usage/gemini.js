'use strict';
/**
 * Gemini（Google Gemini CLI）配额抓取（窗口型，移植自 CodexBar Gemini quota）。
 * 端点：POST https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuota
 * 头：Authorization: Bearer <google access_token>  ·  Content-Type: application/json
 * 体：{ project: <projectId> } 或 {}
 * 响应：{ buckets: [{ modelId, remainingFraction(0-1), resetTime(ISO), tokenType }] }
 *
 * 凭证来源：优先 provider.credentials.access_token，回退读 Gemini CLI 的
 * ~/.gemini/oauth_creds.json；access_token 过期（expiry_date 已过）则用 gemini-cli 内置的
 * 公共 OAuth client 走 https://oauth2.googleapis.com/token 刷新，并把新 token 写回该文件。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { num, readCliCreds } = require('./shared');

const QUOTA_URL = 'https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuota';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const CREDS_PATH = () => path.join(os.homedir(), '.gemini', 'oauth_creds.json');
// gemini-cli 刷新 token 需要它「公开内置」的一对 OAuth 客户端凭证（随 npm 包分发、非用户私密）。
// 不把它硬编码进本仓库（会触发密钥扫描）——运行时从已安装的 @google/gemini-cli 里读取。
let _geminiOAuthClient; // 缓存：undefined=未查 / null=没找到 / {clientId,clientSecret}=命中
function readGeminiOAuthClient() {
  if (_geminiOAuthClient !== undefined) return _geminiOAuthClient;
  _geminiOAuthClient = null;
  const home = os.homedir();
  const pkgRoots = process.platform === 'win32'
    ? [path.join(process.env.APPDATA || path.join(home, 'AppData', 'Roaming'), 'npm', 'node_modules', '@google', 'gemini-cli')]
    : ['/opt/homebrew/lib', '/usr/local/lib', '/usr/lib', path.join(home, '.npm-global', 'lib')]
        .map((d) => path.join(d, 'node_modules', '@google', 'gemini-cli'));
  const rels = [
    'dist/src/code_assist/oauth2.js',
    'node_modules/@google/gemini-cli-core/dist/src/code_assist/oauth2.js',
    'bundle/gemini.js',
  ];
  const idRe = /OAUTH_CLIENT_ID\s*=\s*['"]([\w\-.]+)['"]/;
  const secRe = /OAUTH_CLIENT_SECRET\s*=\s*['"]([\w-]+)['"]/;
  for (const root of pkgRoots) {
    for (const rel of rels) {
      try {
        const txt = fs.readFileSync(path.join(root, rel), 'utf8');
        const id = txt.match(idRe), sec = txt.match(secRe);
        if (id && sec) { _geminiOAuthClient = { clientId: id[1], clientSecret: sec[1] }; return _geminiOAuthClient; }
      } catch { /* 该路径没有，试下一个 */ }
    }
  }
  return _geminiOAuthClient;
}

/** modelId → tier（Pro / Flash / Flash-Lite）。 */
function tierOf(modelId) {
  const m = String(modelId || '').toLowerCase();
  if (m.includes('flash-lite')) return { id: 'flash_lite', title: 'Flash-Lite · 24h', order: 2 };
  if (m.includes('flash')) return { id: 'flash', title: 'Flash · 24h', order: 1 };
  if (m.includes('pro')) return { id: 'pro', title: 'Pro · 24h', order: 0 };
  return { id: 'other', title: modelId || '其他', order: 3 };
}

/** quota 响应 → 统一快照（纯函数，可单测）；每 tier 取用量最高（剩余最少）的桶。 */
function mapGeminiUsage(data, provider) {
  const d = data || {};
  const buckets = Array.isArray(d.buckets) ? d.buckets : [];
  const byTier = new Map();
  for (const b of buckets) {
    const frac = num(b.remainingFraction);
    if (frac == null) continue;
    const t = tierOf(b.modelId);
    const usedPercent = Math.max(0, Math.min(100, (1 - frac) * 100));
    const cur = byTier.get(t.id);
    if (!cur || usedPercent > cur.usedPercent) {
      byTier.set(t.id, {
        id: t.id,
        title: t.title,
        usedPercent,
        usageKnown: true,
        resetsAt: b.resetTime || null,
        windowMinutes: 1440,
        _order: t.order,
      });
    }
  }
  const windows = [...byTier.values()].sort((a, b) => a._order - b._order).map(({ _order, ...w }) => w);
  return {
    provider: 'gemini',
    id: (provider && provider.id) || 'gemini',
    primary: windows[0] || null,
    windows,
    fetchedAt: new Date().toISOString(),
  };
}

/** refresh_token → 新 access_token；成功后写回 ~/.gemini/oauth_creds.json（照 CLI 落盘格式）。 */
async function refreshGeminiToken(refreshToken) {
  const client = readGeminiOAuthClient();
  if (!client) {
    throw new Error('未找到 gemini-cli 的 OAuth 客户端（需已安装 @google/gemini-cli），无法刷新 token，请重新登录 Gemini CLI');
  }
  const body = new URLSearchParams({
    client_id: client.clientId,
    client_secret: client.clientSecret,
    refresh_token: refreshToken,
    grant_type: 'refresh_token',
  });
  const resp = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });
  if (!resp.ok) throw new Error(`Google token 刷新失败：HTTP ${resp.status}`);
  const j = await resp.json();
  if (!j || !j.access_token) throw new Error('Google token 刷新响应缺 access_token');
  try {
    const p = CREDS_PATH();
    const cur = JSON.parse(fs.readFileSync(p, 'utf8'));
    cur.access_token = j.access_token;
    if (typeof j.expires_in === 'number') cur.expiry_date = Date.now() + j.expires_in * 1000;
    if (j.id_token) cur.id_token = j.id_token;
    fs.writeFileSync(p, JSON.stringify(cur, null, 2));
  } catch {
    // 写回失败不致命 —— 本次仍用新 token
  }
  return j.access_token;
}

async function fetchGeminiUsage(provider) {
  // 优先 agent config 凭证，回退 Gemini CLI 的 oauth_creds.json。
  let creds = (provider && provider.credentials) || {};
  if (!creds.access_token && !creds.refresh_token) creds = readCliCreds('gemini') || creds;
  let token = creds.access_token || null;
  const expired = creds.expiry_date != null && Date.now() >= Number(creds.expiry_date);
  if ((!token || expired) && creds.refresh_token) {
    token = await refreshGeminiToken(creds.refresh_token);
  }
  if (!token) throw new Error('缺少 Google access_token，请重新登录 Gemini CLI');
  const projectId = creds.project_id || creds.project || null;
  const doFetch = (t) => fetch(QUOTA_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${t}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(projectId ? { project: projectId } : {}),
  });
  let resp = await doFetch(token);
  // 401：token 可能刚过期而 expiry_date 不准 —— 有 refresh_token 就刷新后重试一次。
  if (resp.status === 401 && creds.refresh_token) {
    token = await refreshGeminiToken(creds.refresh_token);
    resp = await doFetch(token);
  }
  if (resp.status === 401) throw new Error('401：Google token 失效，请重新登录 Gemini CLI');
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  return mapGeminiUsage(await resp.json(), provider);
}

module.exports = { fetchGeminiUsage, mapGeminiUsage, tierOf, refreshGeminiToken };
