'use strict';
// Cursor hook 调试日志：仅 log_level=debug 时写入 ~/.tokenbank/hooks.log

const fs = require('fs');
const path = require('path');
const os = require('os');

const HOOKS_LOG = path.join(os.homedir(), '.tokenbank', 'hooks.log');
const AGENT_CFG = path.join(os.homedir(), '.llm-agent', 'config.json');

/** 读取 ~/.llm-agent/config.json 中的 log_level */
function isDebugEnabled() {
  try {
    const cfg = JSON.parse(fs.readFileSync(AGENT_CFG, 'utf8'));
    return cfg.log_level === 'debug';
  } catch {
    return false;
  }
}

/** debug 模式下追加 hooks.log */
function hookLog(label, data) {
  if (!isDebugEnabled()) return;
  try {
    fs.mkdirSync(path.dirname(HOOKS_LOG), { recursive: true });
    const body = typeof data === 'string' ? data : JSON.stringify(data, null, 2);
    fs.appendFileSync(HOOKS_LOG, `[${new Date().toISOString()}] ${label}\n${body}\n\n`, 'utf8');
  } catch { /* 非关键 */ }
}

module.exports = { HOOKS_LOG, isDebugEnabled, hookLog };
