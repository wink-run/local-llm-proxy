/**
 * 社区接单：按调用方隔离 CLI session / 工作目录，避免多用户互相污染本机游乐场。
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const CONTRIBUTE_SESSION_PREFIX = 'contribute:';
const WORKSPACE_ROOT = path.join(os.homedir(), '.tokenbank', 'contribute-workspaces');

/** 路径段安全化（保留字母数字与少量分隔符） */
function safeSegment(raw, fallback = 'x') {
  let s = String(raw || '')
    .trim()
    .replace(/[^A-Za-z0-9._@+-]+/g, '_')
    .replace(/^\.+/, '') // 去掉前导 . 防 ../
    .replace(/^_+|_+$/g, '')
    .slice(0, 80);
  if (!s || s === '.' || s === '..') s = fallback;
  return s;
}

/**
 * 调用方隔离键：优先用云端下发的 consumer_key；否则回退 uid / task。
 * @returns {string} 如 u12 / gabc123 / task-at-xxx
 */
function resolveConsumerKey(msg = {}) {
  const fromMsg = String(msg.consumer_key || '').trim();
  if (fromMsg) return safeSegment(fromMsg, 'anon');
  if (msg.consumer_user_id != null && String(msg.consumer_user_id).trim() !== '') {
    return safeSegment(`u${msg.consumer_user_id}`, 'anon');
  }
  const taskId = String(msg.task_id || msg.req_id || '').trim();
  return safeSegment(taskId ? `task-${taskId}` : 'anon', 'anon');
}

/** 游乐场 sessionKey：contribute:<assistant>:<consumer> */
function contributeSessionKey(assistantId, consumerKey) {
  return `${CONTRIBUTE_SESSION_PREFIX}${safeSegment(assistantId)}:${safeSegment(consumerKey)}`;
}

/** 是否社区接单 session（本机游乐场应忽略） */
function isContributeSessionKey(sessionKey) {
  return String(sessionKey || '').startsWith(CONTRIBUTE_SESSION_PREFIX);
}

/**
 * 为该调用方准备独立工作目录（同用户可复用，跨用户不共用）。
 */
function ensureContributeWorkspace(assistantId, consumerKey) {
  const dir = path.join(
    WORKSPACE_ROOT,
    safeSegment(assistantId, 'assistant'),
    safeSegment(consumerKey, 'anon'),
  );
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

module.exports = {
  CONTRIBUTE_SESSION_PREFIX,
  WORKSPACE_ROOT,
  safeSegment,
  resolveConsumerKey,
  contributeSessionKey,
  isContributeSessionKey,
  ensureContributeWorkspace,
};
