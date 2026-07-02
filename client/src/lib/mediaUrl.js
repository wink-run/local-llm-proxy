import { getApiBaseUrl, getServerUrl } from '../config';

/** 将服务端相对媒体路径转为可访问的完整 URL */
export function resolveMediaUrl(path) {
  if (!path) return path;
  if (/^(https?:|data:|blob:)/i.test(path)) return path;
  const base = getApiBaseUrl() || getServerUrl();
  if (!base) return path;
  return `${base}${path.startsWith('/') ? path : `/${path}`}`;
}
