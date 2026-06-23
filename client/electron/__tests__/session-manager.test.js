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
  collectGitContext,
  buildKnowledgeCorpus,
  synthesizeKnowledge,
} = require('../session-manager');

// Fake sessionBrowser for knowledge mining tests.
function fakeBrowser(traces) {
  const rows = traces.map((t, i) => ({ agent_id: t.agent_id || 'claude-code', session_id: `s${i}`, project: t.project }));
  const byId = Object.fromEntries(traces.map((t, i) => [`s${i}`, t]));
  return {
    listAllSessions: () => rows,
    getTrace: (_a, sid) => byId[sid],
  };
}

test('buildKnowledgeCorpus cleans noise, labels by project, prioritizes strong signals', () => {
  const deps = { sessionBrowser: fakeBrowser([
    { project: 'proj-a', steps: [
      { kind: 'user', text: '不要折行' },                       // strong signal
      { kind: 'user', text: '网关是指本地转发层' },              // weak (concept) — kept
      { kind: 'user', text: 'Caveat: The messages below were generated' }, // boilerplate — dropped
      { kind: 'user', text: '路径错误 应该是/Users/x/y.js' },    // path — dropped
      { kind: 'assistant', text: 'ignored' },
    ] },
  ]) };
  const { corpus, projects, lineCount } = buildKnowledgeCorpus(deps);
  assert.ok(corpus.includes('[proj-a] 不要折行'));
  assert.ok(corpus.includes('网关是指本地转发层'));
  assert.ok(!corpus.includes('Caveat'));
  assert.ok(!corpus.includes('/Users/'));
  assert.deepEqual(projects, ['proj-a']);
  assert.equal(lineCount, 2);
  // strong signal ordered before weak
  assert.ok(corpus.indexOf('不要折行') < corpus.indexOf('网关是指本地转发层'));
});

test('synthesizeKnowledge sends corpus to the model and returns its content', async () => {
  const deps = { sessionBrowser: fakeBrowser([
    { project: 'p', steps: [{ kind: 'user', text: '总是用 pnpm 管理依赖' }] },
  ]) };
  let seenSystem = '', seenUser = '';
  const fakeFetch = async (_url, opts) => {
    const body = JSON.parse(opts.body);
    seenSystem = body.messages[0].content; seenUser = body.messages[1].content;
    return { ok: true, json: async () => ({ choices: [{ message: { content: '# 全局级\n## 开发规则\n- 用 pnpm' } }] }) };
  };
  const r = await synthesizeKnowledge(deps, { fetchImpl: fakeFetch });
  assert.equal(r.ok, true);
  assert.ok(r.content.includes('# 全局级'));
  assert.ok(r.content.includes('记忆提炼'), 'header comment present');
  assert.ok(/项目级|全局级|概念/.test(seenSystem), 'system prompt asks for the knowledge structure');
  assert.ok(seenUser.includes('总是用 pnpm'));
});

test('synthesizeKnowledge falls back to raw candidates when model unavailable', async () => {
  const deps = { sessionBrowser: fakeBrowser([
    { project: 'p', steps: [{ kind: 'user', text: '不要每次都打包' }] },
  ]) };
  const r = await synthesizeKnowledge(deps, { fetchImpl: async () => ({ ok: false }) });
  assert.equal(r.ok, false);
  assert.equal(r.error, 'model_unavailable');
  assert.ok(r.content.includes('不要每次都打包'), 'fallback shows raw candidate');
});

test('synthesizeKnowledge reports no_corpus when nothing minable', async () => {
  const deps = { sessionBrowser: fakeBrowser([
    { project: 'p', steps: [{ kind: 'user', text: 'ok' }, { kind: 'assistant', text: 'sure' }] },
  ]) };
  const r = await synthesizeKnowledge(deps, { fetchImpl: async () => ({ ok: true, json: async () => ({}) }) });
  assert.equal(r.ok, false);
  assert.equal(r.error, 'no_corpus');
});

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

test('mergeAgentRows dedupes same (agent_id, session_id), keeping latest lastTs', () => {
  const out = mergeAgentRows({
    cursor: [
      { session_id: 'x', lastTs: 100, project: 'old' },
      { session_id: 'x', lastTs: 300, project: 'new' },
      { session_id: 'y', lastTs: 200, project: 'other' },
    ],
  });
  assert.equal(out.length, 2, 'duplicate session_id collapsed to one');
  const x = out.find(r => r.session_id === 'x');
  assert.equal(x.project, 'new', 'kept the row with the latest lastTs');
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
  assert.match(d, /\[原始目标\]/);
  assert.match(d, /USER\(原始请求\): add a feature/);
  assert.match(d, /\[最近进展\]/);
  assert.match(d, /TOOL Write/);
});

test('composeHandoffDoc wraps the brief with source + continuation instruction', () => {
  const doc = composeHandoffDoc({ brief: 'BRIEF', project: 'demo', sourceAgent: 'codex' });
  assert.match(doc, /# 交接工作 — demo/);
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

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

test('collectGitContext reports recent commits and uncommitted changes', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gitctx-'));
  const git = (...args) => execFileSync('git', args, { cwd: dir, stdio: ['ignore', 'ignore', 'ignore'] });
  git('init', '-q');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'Test');
  git('config', 'commit.gpgsign', 'false');
  fs.writeFileSync(path.join(dir, 'a.txt'), 'one\n');
  git('add', 'a.txt');
  git('commit', '-q', '-m', 'initial commit');
  // an unstaged modification + an untracked file
  fs.writeFileSync(path.join(dir, 'a.txt'), 'two\n');
  fs.writeFileSync(path.join(dir, 'b.txt'), 'new\n');

  const out = collectGitContext(dir);
  assert.match(out, /\[Git 状态\]/);
  assert.match(out, /initial commit/);     // recent commit title
  assert.match(out, /^ M a\.txt$/m);       // unstaged modification
  assert.match(out, /^\?\? b\.txt$/m);     // untracked file
});

test('collectGitContext returns empty string for a non-git directory', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nogit-'));
  assert.equal(collectGitContext(dir), '');
});

test('collectGitContext never throws on missing cwd or git failure', () => {
  assert.equal(collectGitContext(null), '');
  assert.equal(collectGitContext('/no/such/path/xyz'), '');
  // git binary unavailable → still returns '' instead of throwing
  const boom = () => { throw new Error('ENOENT'); };
  assert.equal(collectGitContext('/tmp', { execImpl: boom }), '');
});
