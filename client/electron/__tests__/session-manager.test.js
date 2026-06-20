'use strict';
const test = require('node:test');
const assert = require('node:assert');
const {
  mergeAgentRows,
  joinSessionsWithMeta,
  buildSessionPackJSON,
  renderSessionPackMarkdown,
  buildSessionDigest,
  filePathFromInput,
  composeHandoffDoc,
  summarizeViaGateway,
} = require('../session-manager');

test('mergeAgentRows tags agent_id and sorts by lastTs desc', () => {
  const out = mergeAgentRows({
    'claude-code': [{ session_id: 'a', lastTs: 100, agent: 'claude-code' }],
    codex: [{ session_id: 'b', lastTs: 300 }, { session_id: 'c', lastTs: 200 }],
  });
  assert.deepEqual(out.map(r => r.session_id), ['b', 'c', 'a']);
  assert.equal(out[0].agent_id, 'codex');
  assert.equal(out[2].agent_id, 'claude-code');
});

test('mergeAgentRows tolerates empty / missing arrays', () => {
  const out = mergeAgentRows({ cursor: [], codex: null });
  assert.deepEqual(out, []);
});

test('joinSessionsWithMeta attaches meta and filters archived by default', () => {
  const rows = [
    { session_id: 'a', agent_id: 'codex', lastTs: 2 },
    { session_id: 'b', agent_id: 'codex', lastTs: 1 },
  ];
  const meta = [
    { agent_id: 'codex', session_id: 'a', favorite: 1, tags: 'design', note: 'hi', archived: 0 },
    { agent_id: 'codex', session_id: 'b', favorite: 0, tags: '', note: '', archived: 1 },
  ];
  const out = joinSessionsWithMeta(rows, meta, { showArchived: false });
  assert.equal(out.length, 1);
  assert.equal(out[0].session_id, 'a');
  assert.equal(out[0].favorite, true);
  assert.deepEqual(out[0].tags, ['design']);
  assert.equal(out[0].note, 'hi');
});

test('joinSessionsWithMeta keeps archived when showArchived=true', () => {
  const rows = [{ session_id: 'b', agent_id: 'codex' }];
  const meta = [{ agent_id: 'codex', session_id: 'b', archived: 1 }];
  const out = joinSessionsWithMeta(rows, meta, { showArchived: true });
  assert.equal(out.length, 1);
  assert.equal(out[0].archived, true);
});

test('buildSessionPackJSON produces a versioned pack from a trace', () => {
  const trace = {
    project: 'demo', project_path: '/x/demo',
    stats: { steps: 2, tools: 1, tokens: { input: 10, output: 5, cached: 0 } },
    steps: [
      { kind: 'user', label: 'q', text: 'hello', ts: 1000 },
      { kind: 'tool', tool: 'Read', label: 'Read', input: { path: 'a' }, ts: 1001 },
    ],
  };
  const pack = buildSessionPackJSON({ trace, agent_id: 'codex', session_id: 's1' });
  assert.equal(pack.version, 1);
  assert.equal(pack.kind, 'tokenbank.session-pack');
  assert.equal(pack.source.agent_id, 'codex');
  assert.equal(pack.source.project, 'demo');
  assert.equal(pack.messages.length, 2);
  assert.equal(pack.messages[0].role, 'user');
  assert.equal(pack.messages[1].role, 'tool');
  assert.equal(pack.messages[1].tool, 'Read');
});

test('renderSessionPackMarkdown renders headers and bodies', () => {
  const pack = {
    source: { agent_id: 'codex', project: 'demo' },
    messages: [
      { role: 'user', text: 'hello', ts: 1000 },
      { role: 'assistant', text: 'hi there', ts: 1001 },
      { role: 'tool', tool: 'Read', input: 'path=a', ts: 1002 },
    ],
  };
  const md = renderSessionPackMarkdown(pack);
  assert.match(md, /# demo/);
  assert.match(md, /## USER/);
  assert.match(md, /hello/);
  assert.match(md, /## AI/);
  assert.match(md, /Read/);
});

test('filePathFromInput extracts paths from object and string inputs', () => {
  assert.equal(filePathFromInput({ path: 'a/b.js' }), 'a/b.js');
  assert.equal(filePathFromInput({ file_path: 'x/y.py' }), 'x/y.py');
  assert.equal(filePathFromInput('edited src/main.ts now'), 'src/main.ts');
  assert.equal(filePathFromInput(null), null);
});

test('buildSessionDigest includes header, files, and recent messages', () => {
  const trace = {
    project: 'demo', project_path: '/x/demo',
    steps: [
      { kind: 'user', text: 'add a feature', ts: 1 },
      { kind: 'tool', tool: 'Write', input: { path: 'src/a.js' }, ts: 2 },
      { kind: 'assistant', text: 'done', ts: 3 },
    ],
  };
  const d = buildSessionDigest(trace);
  assert.match(d, /项目: demo/);
  assert.match(d, /src\/a\.js/);
  assert.match(d, /USER: add a feature/);
  assert.match(d, /TOOL Write/);
});

test('composeHandoffDoc wraps the brief with source + continuation instruction', () => {
  const doc = composeHandoffDoc({ brief: 'BRIEF', project: 'demo', sourceAgent: 'codex' });
  assert.match(doc, /# 接续工作 — demo/);
  assert.match(doc, /来源：codex/);
  assert.match(doc, /BRIEF/);
  assert.match(doc, /请在当前项目继续/);
});

test('summarizeViaGateway returns first successful model, skips failures', async () => {
  const calls = [];
  const fetchImpl = async (url, opts) => {
    const body = JSON.parse(opts.body);
    calls.push(body.model);
    if (body.model === 'deepseek-v4-flash') return { ok: false };
    if (body.model === 'glm-4.7') {
      return { ok: true, json: async () => ({ choices: [{ message: { content: 'THE BRIEF' } }] }) };
    }
    return { ok: false };
  };
  const res = await summarizeViaGateway('digest', { fetchImpl });
  assert.equal(res.brief, 'THE BRIEF');
  assert.equal(res.model, 'glm-4.7');
  assert.deepEqual(calls, ['deepseek-v4-flash', 'glm-4.7']);
});

test('summarizeViaGateway returns null when all models fail', async () => {
  const res = await summarizeViaGateway('digest', { fetchImpl: async () => ({ ok: false }) });
  assert.equal(res, null);
});
