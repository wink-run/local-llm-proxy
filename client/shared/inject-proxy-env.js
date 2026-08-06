'use strict';

/**
 * 将系统代理注入进程环境变量，供 proxy-from-env / 出站 Agent 使用。
 * 已有 HTTP(S)_PROXY 时不覆盖（尊重外部环境）。
 */
const { execFileSync } = require('child_process');

const PROXY_ENV_KEYS = [
  'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY',
  'http_proxy', 'https_proxy', 'all_proxy',
];

function hasProxyEnv() {
  return PROXY_ENV_KEYS.some((k) => process.env[k]);
}

/** 解析 macOS `scutil --proxy` → http://host:port */
function parseScutilProxy(text) {
  const src = String(text || '');
  const get = (key) => {
    const m = src.match(new RegExp(`\\b${key}\\s*:\\s*(\\S+)`, 'i'));
    return m ? m[1] : null;
  };
  const httpsOn = get('HTTPSEnable') === '1';
  const httpOn = get('HTTPEnable') === '1';
  if (httpsOn) {
    const host = get('HTTPSProxy');
    const port = get('HTTPSPort');
    if (host && port) return `http://${host}:${port}`;
  }
  if (httpOn) {
    const host = get('HTTPProxy');
    const port = get('HTTPPort');
    if (host && port) return `http://${host}:${port}`;
  }
  return null;
}

/** 解析 Windows 注册表 ProxyServer（如 127.0.0.1:7890 或 http=...;https=...） */
function parseWinProxyServer(raw) {
  const s = String(raw || '').trim();
  if (!s) return null;
  // https=host:port;http=host:port
  const https = s.match(/(?:^|;)\s*https\s*=\s*([^;]+)/i);
  const http = s.match(/(?:^|;)\s*http\s*=\s*([^;]+)/i);
  let hostPort = (https && https[1]) || (http && http[1]) || s;
  hostPort = hostPort.trim();
  if (!hostPort) return null;
  if (/^https?:\/\//i.test(hostPort)) return hostPort.replace(/^https:/i, 'http:');
  return `http://${hostPort}`;
}

function readSystemProxyUrl() {
  try {
    if (process.platform === 'darwin') {
      const out = execFileSync('scutil', ['--proxy'], {
        encoding: 'utf8',
        timeout: 2000,
        maxBuffer: 64 * 1024,
      });
      return parseScutilProxy(out);
    }
    if (process.platform === 'win32') {
      const out = execFileSync(
        'reg',
        ['query', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings'],
        { encoding: 'utf8', timeout: 3000, maxBuffer: 64 * 1024 },
      );
      const enabled = /ProxyEnable\s+REG_DWORD\s+0x1\b/i.test(out);
      if (!enabled) return null;
      const m = out.match(/ProxyServer\s+REG_SZ\s+(\S+)/i);
      return m ? parseWinProxyServer(m[1]) : null;
    }
  } catch {
    return null;
  }
  return null;
}

/**
 * 若进程尚无代理环境变量，则从系统代理注入 HTTP(S)_PROXY。
 * @returns {string|null} 注入的代理 URL；未注入则 null
 */
function injectProxyEnv() {
  if (hasProxyEnv()) return null;
  const url = readSystemProxyUrl();
  if (!url) return null;

  process.env.HTTP_PROXY = url;
  process.env.HTTPS_PROXY = url;
  process.env.http_proxy = url;
  process.env.https_proxy = url;

  // 本机服务不经代理，避免回环
  if (!process.env.NO_PROXY && !process.env.no_proxy) {
    const bypass = 'localhost,127.0.0.1,::1';
    process.env.NO_PROXY = bypass;
    process.env.no_proxy = bypass;
  }
  return url;
}

module.exports = {
  injectProxyEnv,
  parseScutilProxy,
  parseWinProxyServer,
  hasProxyEnv,
};
