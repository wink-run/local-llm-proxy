// 默认 Token Bank 服务地址：环境变量 TOKEN_SERVER_URL（兼容 TOKENBANK_SERVER_URL）
'use strict';

function normalizeServerBase(url) {
  if (!url) return '';
  return String(url).trim().replace(/\/$/, '').replace(/\/(api|v\d+)(\/.*)?$/, '');
}

/** 从环境变量读取默认服务根地址（未设置时返回空字符串） */
function defaultServerUrlFromEnv() {
  const raw = process.env.TOKEN_SERVER_URL || process.env.TOKENBANK_SERVER_URL || '';
  return normalizeServerBase(raw);
}

module.exports = { normalizeServerBase, defaultServerUrlFromEnv };
