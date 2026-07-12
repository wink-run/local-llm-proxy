// agent-dispatch-client.js
// bridge MCP 子进程侧：优先走主进程 HTTP 派发，无 TB_DISPATCH_URL 时回退本地模块（单测用）。
'use strict';

const agentExecutor = require('./agent-executor');
const resourceManager = require('./resource-manager');

const DISPATCH_URL = (process.env.TB_DISPATCH_URL || '').replace(/\/$/, '');
const DISPATCH_TOKEN = process.env.TB_DISPATCH_TOKEN || '';

function useHttpDispatch() {
  return !!(DISPATCH_URL && DISPATCH_TOKEN);
}

async function httpRequest(method, pathWithQuery, body) {
  const headers = {
    Authorization: `Bearer ${DISPATCH_TOKEN}`,
  };
  let bodyStr;
  if (body != null) {
    headers['Content-Type'] = 'application/json';
    bodyStr = JSON.stringify(body);
  }

  const res = await fetch(`${DISPATCH_URL}${pathWithQuery}`, {
    method,
    headers,
    body: bodyStr,
  });

  let data = {};
  try { data = await res.json(); } catch { /* ignore */ }
  if (!res.ok) {
    throw new Error(data.error || `dispatch HTTP ${res.status}`);
  }
  return data;
}

async function listAgents() {
  if (useHttpDispatch()) {
    const data = await httpRequest('GET', '/agents');
    return data.agents || [];
  }
  return agentExecutor.listAvailableAgents();
}

async function dispatchAndWait(agentId, prompt, options = {}) {
  if (useHttpDispatch()) {
    const data = await httpRequest('POST', '/dispatch', {
      agentId,
      prompt,
      workingDir: options.workingDir,
      parentTaskId: options.parentTaskId,
      parentSessionKey: options.parentSessionKey,
      parentSessionInstanceId: options.parentSessionInstanceId,
    });
    return data.status;
  }
  return agentExecutor.dispatchAndWait(agentId, prompt, options);
}

function resolvePrompt(ref, args, clientId = '') {
  if (useHttpDispatch()) {
    const q = new URLSearchParams({ name: ref, args: args || '', clientId: clientId || '' });
    return httpRequest('GET', `/prompt?${q.toString()}`);
  }
  return resourceManager.resolvePromptForClient(ref, args, clientId);
}

module.exports = {
  useHttpDispatch,
  listAgents,
  dispatchAndWait,
  resolvePrompt,
};
