// 从 Token Bank 后端拉取当前在线 P2P 模型，写入本地 gateway（CLI / Docker 与 Electron 一致）
'use strict';

const http  = require('http');
const https = require('https');
const { isCommunityP2pEnabled } = require('./community-p2p');

function normalizeBase(url) {
  if (!url) return '';
  return String(url).trim().replace(/\/$/, '').replace(/\/(api|v\d+)(\/.*)?$/, '');
}

function fetchModelsJson(serverUrl, token) {
  const base = normalizeBase(serverUrl);
  if (!base) return Promise.reject(new Error('no server url'));
  const url = `${base}/v1/models`;
  const u = new URL(url);
  const mod = u.protocol === 'https:' ? https : http;
  return new Promise((resolve, reject) => {
    const req = mod.request(url, {
      method: 'GET',
      timeout: 15000,
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => {
        if (res.statusCode >= 400) {
          reject(new Error(`HTTP ${res.statusCode}`));
          return;
        }
        try { resolve(data ? JSON.parse(data) : {}); }
        catch { reject(new Error('invalid json')); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    req.end();
  });
}

/** 解析 /v1/models 响应中的模型 id 列表 */
function parseModelIds(payload) {
  return (payload?.data || []).map(m => m.id).filter(Boolean);
}

/**
 * 拉取云端在线 P2P 模型并更新 gateway.setPeerModels。
 * @param {object} gateway - local-gateway 实例
 * @param {function} readLocalConfig - 读取 local-config
 * @param {function} [defaultServerUrlFromEnv] - 环境变量默认地址
 * @param {function} [readAgentConfig] - 读取 agent config（检查 tokenbank-p2p 开关）
 */
async function refreshGatewayPeerModels(gateway, readLocalConfig, defaultServerUrlFromEnv, readAgentConfig) {
  if (!gateway?.setPeerModels) return [];
  // 用户关闭社区源时不拉取/缓存 P2P 模型
  if (readAgentConfig) {
    try {
      if (!isCommunityP2pEnabled(readAgentConfig())) {
        gateway.setPeerModels([]);
        return [];
      }
    } catch {}
  }
  const lc = (readLocalConfig && readLocalConfig()) || {};
  const cc = lc.cloud_config || {};
  const serverUrl = normalizeBase(cc.url)
    || (defaultServerUrlFromEnv ? normalizeBase(defaultServerUrlFromEnv()) : '');
  const token = cc.token || '';

  if (!serverUrl || !token) {
    gateway.setBackendConfig({ url: serverUrl || null, token: null });
    gateway.setPeerModels([]);
    return [];
  }

  gateway.setBackendConfig({ url: serverUrl, token });

  try {
    const data = await fetchModelsJson(serverUrl, token);
    const names = parseModelIds(data);
    gateway.setPeerModels(names);
    return names;
  } catch (e) {
    console.warn('[gateway] fetchPeerModels failed:', e.message);
    gateway.setPeerModels([]);
    return [];
  }
}

module.exports = {
  refreshGatewayPeerModels,
  fetchModelsJson,
  parseModelIds,
};
