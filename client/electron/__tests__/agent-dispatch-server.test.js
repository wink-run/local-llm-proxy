'use strict';

const assert = require('assert');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  startDispatchServer,
  stopDispatchServer,
  getDispatchEndpoint,
  INFO_PATH,
} = require('../agent-dispatch-server');

function requestJson(url, token, method, pathName, body) {
  return new Promise((resolve, reject) => {
    const u = new URL(pathName, url);
    const payload = body != null ? JSON.stringify(body) : null;
    const req = http.request(u, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}),
      },
    }, (res) => {
      let buf = '';
      res.on('data', c => { buf += c; });
      res.on('end', () => {
        try { resolve({ status: res.statusCode, data: JSON.parse(buf || '{}') }); }
        catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

(async () => {
  const fakeExecutor = {
    listAvailableAgents: async () => [{ id: 'codex', name: 'Codex' }],
    dispatchAndWait: async (agentId, prompt, opts) => ({
      status: 'completed',
      agent_id: agentId,
      prompt,
      result: { summary: `ok:${prompt}` },
      context: opts,
    }),
  };
  const fakeResources = {
    resolvePromptForClient: (name, args, clientId) => ({ found: true, text: `${name}/${args}`, clientId }),
  };

  stopDispatchServer();
  startDispatchServer(fakeExecutor, fakeResources);

  let ep = null;
  for (let i = 0; i < 20; i++) {
    ep = getDispatchEndpoint();
    if (ep?.url) break;
    await sleep(50);
  }
  assert.ok(ep?.url, 'dispatch server endpoint should be available');
  assert.ok(ep?.token, 'dispatch server token should be available');
  assert.ok(fs.existsSync(INFO_PATH), 'dispatch-server.json should exist');

  const health = await requestJson(ep.url, ep.token, 'GET', '/health');
  assert.equal(health.status, 200);
  assert.equal(health.data.ok, true);

  const agents = await requestJson(ep.url, ep.token, 'GET', '/agents');
  assert.equal(agents.status, 200);
  assert.equal(agents.data.agents[0].id, 'codex');

  const prompt = await requestJson(ep.url, ep.token, 'GET', '/prompt?name=hi&args=1&clientId=claude-code');
  assert.equal(prompt.status, 200);
  assert.equal(prompt.data.text, 'hi/1');
  assert.equal(prompt.data.clientId, 'claude-code');

  const dispatch = await requestJson(ep.url, ep.token, 'POST', '/dispatch', {
    agentId: 'codex',
    prompt: 'write poem',
    parentTaskId: 'task_parent',
  });
  assert.equal(dispatch.status, 200);
  assert.equal(dispatch.data.status.status, 'completed');
  assert.equal(dispatch.data.status.result.summary, 'ok:write poem');

  const bad = await requestJson(ep.url, 'wrong', 'GET', '/agents');
  assert.equal(bad.status, 401);

  stopDispatchServer();
  console.log('agent-dispatch-server.test.js OK');
})().catch((e) => {
  stopDispatchServer();
  console.error(e);
  process.exit(1);
});
