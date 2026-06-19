// 默认 Token Bank 服务地址：环境变量 TOKEN_SERVER_URL（兼容 TOKENBANK_SERVER_URL）
'use strict';

/** 打包版 / 未配置环境变量时的官方默认地址 */
const DEFAULT_TOKEN_SERVER_URL = 'https://tokenbank.wink.run';

function normalizeServerBase(url) {
  if (!url) return '';
  return String(url).trim().replace(/\/$/, '').replace(/\/(api|v\d+)(\/.*)?$/, '');
}

/** 从环境变量读取默认服务根地址（未设置时回退官方默认） */
function defaultServerUrlFromEnv() {
  const raw = process.env.TOKEN_SERVER_URL || process.env.TOKENBANK_SERVER_URL || '';
  return normalizeServerBase(raw) || DEFAULT_TOKEN_SERVER_URL;
}

module.exports = { normalizeServerBase, defaultServerUrlFromEnv, DEFAULT_TOKEN_SERVER_URL };
