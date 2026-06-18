/** 登录页占位提示（非默认地址） */
export const SERVER_URL_PLACEHOLDER = 'http://your-host:port';

/** Vite 本地开发时的同源 API 代理前缀（见 vite.config.js） */
export const DEV_API_PROXY_PREFIX = '/__tokenbank_api__';

/** 设置页「Token Bank 服务地址」（localStorage.serverUrl） */
export function getServerUrl() {
  return normalizeServerBase(localStorage.getItem('serverUrl') || '');
}

/**
 * axios / 浏览器 API 请求的 baseURL。
 * Vite dev 且目标为默认远程服务时走同源代理，避免 CORS。
 */
export function getApiBaseUrl() {
  if (import.meta.env.DEV && typeof window !== 'undefined' && !window.electronAPI) {
    const stored = getServerUrl();
    const proxyTarget = defaultServerUrlFromEnv() || 'https://tokenbank.wink.run';
    if (!stored || stored === proxyTarget) {
      return DEV_API_PROXY_PREFIX;
    }
  }
  return getServerUrl();
}

/** 归一化为服务器根地址（去掉 /api、/v1 等后缀） */
export function normalizeServerBase(url) {
  if (!url) return '';
  return String(url).trim().replace(/\/$/, '').replace(/\/(api|v\d+)(\/.*)?$/, '');
}

/** 环境变量 / 构建注入的默认 Token Bank 服务地址 */
function defaultServerUrlFromEnv() {
  return normalizeServerBase(import.meta.env.VITE_TOKEN_SERVER_URL || '');
}

/** 启动时：若设置页未填地址，从 env / 网关 cloud_config.url 回填 */
export async function bootstrapServerUrl() {
  const stored = normalizeServerBase(localStorage.getItem('serverUrl') || '');
  if (stored) return stored;

  // Electron 运行时 env（打包后仍可通过 TOKEN_SERVER_URL 指定）
  const fromElectron = typeof window !== 'undefined' && window.electronAPI?.app?.defaultServerUrl
    ? normalizeServerBase(window.electronAPI.app.defaultServerUrl() || '')
    : '';
  if (fromElectron) {
    localStorage.setItem('serverUrl', fromElectron);
    await syncCloudConfigUrl(fromElectron);
    return fromElectron;
  }

  const fromEnv = defaultServerUrlFromEnv();
  if (fromEnv) {
    localStorage.setItem('serverUrl', fromEnv);
    await syncCloudConfigUrl(fromEnv);
    return fromEnv;
  }

  if (typeof window !== 'undefined' && window.electronAPI?.localConfig?.get) {
    try {
      const cfg = await window.electronAPI.localConfig.get();
      const url = normalizeServerBase(cfg?.cloud_config?.url || '');
      if (url) {
        localStorage.setItem('serverUrl', url);
        return url;
      }
    } catch {}
  }
  return '';
}

/**
 * 配置同步 / API 请求用的服务器根地址。
 * 以设置页「Token Bank 服务地址」为准（getServerUrl）。
 */
export async function getSyncServerBase() {
  const url = getServerUrl() || await bootstrapServerUrl();
  return normalizeServerBase(url);
}

/** 将 Token Bank 服务地址写入 cloud_config（与 P2P 网关对齐） */
export async function syncCloudConfigUrl(url) {
  if (typeof window === 'undefined' || !window.electronAPI?.localConfig?.setCloudConfig) return;
  const base = normalizeServerBase(url || getServerUrl());
  if (!base) return;
  try {
    const cfg = await window.electronAPI.localConfig.get();
    const token = cfg?.cloud_config?.token;
    await window.electronAPI.localConfig.setCloudConfig({
      url: base,
      ...(token ? { token } : {}),
    });
  } catch {}
}
