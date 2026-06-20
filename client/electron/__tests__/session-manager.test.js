'use strict';
const test = require('node:test');
const assert = require('node:assert');
const {
  mergeAgentRows,
  joinSessionsWithMeta,
  buildSessionPackJSON,
  renderSessionPackMarkdown,
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
