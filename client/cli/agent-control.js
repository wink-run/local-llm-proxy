// client/cli/agent-control.js
// Docker / CLI 内嵌 P2P 贡献 Agent（与 Electron main.js 共用 agent-worker）
'use strict';

const agent = require('../electron/agent-worker');

const LOG_MAX = 200;
const _logBuf = [];

function _pushLog(line) {
  _logBuf.push(String(line));
  if (_logBuf.length > LOG_MAX) _logBuf.shift();
}

function startAgent() {
  agent.start({
    onLog: (line) => {
      console.log('[agent-log]', line);
      _pushLog(line);
    },
    onStatus: (status) => {
      console.log('[agent] status', status);
      if (status?.error) _pushLog(`[error] ${status.error}`);
    },
  });
}

function stopAgent() {
  agent.stop();
}

function getLogs() {
  return [..._logBuf];
}

function isRunning() {
  return agent.isRunning();
}

module.exports = { startAgent, stopAgent, getLogs, isRunning };
