'use strict';
// tokenbank-resources: 能力总览 + 已纳管资源 / 社区目录 / 网关发现 / 武将点将
const { test } = require('node:test');
const assert = require('node:assert/strict');

const mcp = require('../resources-mcp');

const SAMPLE = [
  {
    id: 's1', type: 'skill', name: 'image-gen', display_name: 'image-gen',
    description: '图片生成', content: '# image-gen\nuse model', projections: [],
    authorityPath: null,
  },
  {
    id: 'a1', type: 'assistant', name: 'writer', display_name: '写作助手',
    description: '写文章', content: JSON.stringify({
      soul: '你是写作助手', skills: ['image-gen'], prompts: [], mcp: [], model: '',
      runtime_agent: 'claude-code',
    }),
    projections: [{ agentId: 'cursor' }],
  },
  {
    id: 'p1', type: 'prompt', name: 'code-review', display_name: '代码审查',
    description: '审查', content: '请审查 $ARGUMENTS', projections: [],
  },
];

function mockRm() {
  const hits = [];
  return {
    hits,
    listResources(filters = {}) {
      let rows = SAMPLE;
      if (filters.type) rows = rows.filter(r => r.type === filters.type);
      if (filters.query) {
        const q = filters.query.toLowerCase();
        rows = rows.filter(r =>
          r.name.includes(q) || (r.description || '').toLowerCase().includes(q));
      }
      return rows;
    },
    listAssistantsForClient(clientId) {
      const cid = String(clientId || '').trim();
      const rows = SAMPLE.filter(r => r.type === 'assistant');
      if (!cid) {
        return rows.map(r => ({
          id: r.id, name: r.name, display_name: r.display_name, description: r.description,
        }));
      }
      return rows
        .filter(r => (r.projections || []).some(p => p.agentId === cid))
        .map(r => ({
          id: r.id, name: r.name, display_name: r.display_name, description: r.description,
        }));
    },
    resolveAssistantForClient(ref, clientId) {
      const cid = String(clientId || '').trim();
      const r = SAMPLE.find(x => x.type === 'assistant'
        && (x.name === ref || x.display_name === ref || x.id === ref || `#${x.id}` === ref));
      if (!r) return { found: false };
      if (cid && !(r.projections || []).some(p => p.agentId === cid)) return { found: false };
      return {
        found: true,
        id: r.id,
        name: r.name,
        resource: r,
        text: '你是写作助手\n\n## 可用 Skill\n请在任务中按需遵循以下 Skill：image-gen',
      };
    },
    recordResourceHit(id) { hits.push(id); return true; },
    getResource(id) {
      return SAMPLE.find(r => r.id === id) || null;
    },
    listCatalog(filters = {}) {
      const items = [
        { type: 'skill', name: 'git-commit', display_name: 'Git 提交', description: 'commit', installed: false },
        { type: 'prompt', name: 'api-design', display_name: 'API 设计', description: 'api', installed: true },
      ].filter(it => !filters.type || filters.type === 'all' || it.type === filters.type);
      return { items };
    },
  };
}

test('TOOLS 含能力总览与资源/目录/网关', () => {
  const names = mcp.TOOLS.map(t => t.name).sort();
  assert.deepEqual(names, [
    'tb_capabilities',
    'tb_get_resource',
    'tb_list_catalog',
    'tb_list_gateway',
    'tb_list_resources',
  ]);
});

test('tb_capabilities 描述分域体系与点将工作流', async () => {
  const r = await mcp.handleToolCall('tb_capabilities', {});
  assert.equal(r.isError, false);
  const text = r.content[0].text;
  assert.ok(text.includes('tokenbank-models'));
  assert.ok(text.includes('tb_list_models'));
  assert.ok(text.includes('tb_list_resources'));
  assert.ok(text.includes('推荐工作流'));
  assert.ok(text.includes('assistant') || text.includes('武将') || text.includes('点将'));
});

test('tb_list_resources 可按 type 过滤', async () => {
  mcp.setResourceManager(mockRm());
  try {
    const all = await mcp.handleToolCall('tb_list_resources', {});
    assert.ok(all.content[0].text.includes('image-gen'));
    assert.ok(all.content[0].text.includes('writer'));

    const skills = await mcp.handleToolCall('tb_list_resources', { type: 'skill' });
    assert.ok(skills.content[0].text.includes('image-gen'));
    assert.ok(!skills.content[0].text.includes('[assistant]'));
  } finally {
    mcp.setResourceManager(null);
  }
});

test('tb_list_resources type=assistant 按 TB_CLIENT_ID 投射过滤', async () => {
  const rm = mockRm();
  mcp.setResourceManager(rm);
  const prev = process.env.TB_CLIENT_ID;
  try {
    process.env.TB_CLIENT_ID = 'cursor';
    const ok = await mcp.handleToolCall('tb_list_resources', { type: 'assistant' });
    assert.ok(ok.content[0].text.includes('writer'));
    assert.ok(ok.content[0].text.includes('武将') || ok.content[0].text.includes('writer'));

    process.env.TB_CLIENT_ID = 'codex';
    const empty = await mcp.handleToolCall('tb_list_resources', { type: 'assistant' });
    assert.ok(empty.content[0].text.includes('暂无') || !empty.content[0].text.includes('[assistant] writer'));
  } finally {
    if (prev == null) delete process.env.TB_CLIENT_ID;
    else process.env.TB_CLIENT_ID = prev;
    mcp.setResourceManager(null);
  }
});

test('tb_get_resource: assistant 返回出战全文并记命中', async () => {
  const rm = mockRm();
  mcp.setResourceManager(rm);
  const prev = process.env.TB_CLIENT_ID;
  try {
    process.env.TB_CLIENT_ID = 'cursor';
    const r = await mcp.handleToolCall('tb_get_resource', { type: 'assistant', name: 'writer' });
    assert.equal(r.isError, false);
    const text = r.content[0].text;
    assert.ok(text.includes('dispatch_id: assistant:a1'));
    assert.ok(text.includes('你是写作助手'));
    assert.ok(text.includes('当前会话'));
    assert.ok(!text.trim().startsWith('{'), '默认不应只返回 JSON 摘要');
    assert.deepEqual(rm.hits, ['a1']);
  } finally {
    if (prev == null) delete process.env.TB_CLIENT_ID;
    else process.env.TB_CLIENT_ID = prev;
    mcp.setResourceManager(null);
  }
});

test('tb_get_resource: assistant 未投射 → isError', async () => {
  mcp.setResourceManager(mockRm());
  const prev = process.env.TB_CLIENT_ID;
  try {
    process.env.TB_CLIENT_ID = 'codex';
    const r = await mcp.handleToolCall('tb_get_resource', { type: 'assistant', name: 'writer' });
    assert.equal(r.isError, true);
  } finally {
    if (prev == null) delete process.env.TB_CLIENT_ID;
    else process.env.TB_CLIENT_ID = prev;
    mcp.setResourceManager(null);
  }
});

test('tb_get_resource: mode=summary 仍可取摘要', async () => {
  mcp.setResourceManager(mockRm());
  const prev = process.env.TB_CLIENT_ID;
  try {
    process.env.TB_CLIENT_ID = 'cursor';
    const r = await mcp.handleToolCall('tb_get_resource', {
      type: 'assistant', name: 'writer', mode: 'summary',
    });
    assert.equal(r.isError, false);
    const body = JSON.parse(r.content[0].text);
    assert.equal(body.dispatch_id, 'assistant:a1');
  } finally {
    if (prev == null) delete process.env.TB_CLIENT_ID;
    else process.env.TB_CLIENT_ID = prev;
    mcp.setResourceManager(null);
  }
});

test('tb_list_catalog 区分已纳管/未安装', async () => {
  mcp.setResourceManager(mockRm());
  try {
    const r = await mcp.handleToolCall('tb_list_catalog', { type: 'skill' });
    assert.ok(r.content[0].text.includes('未安装'));
    assert.ok(r.content[0].text.includes('git-commit'));
  } finally {
    mcp.setResourceManager(null);
  }
});

test('tb_list_gateway 含图像与 TTS 端点', async () => {
  const r = await mcp.handleToolCall('tb_list_gateway', {});
  assert.ok(r.content[0].text.includes('/v1/images/generations'));
  assert.ok(r.content[0].text.includes('/v1/audio/speech'));
  assert.ok(r.content[0].text.includes('11430') || r.content[0].text.includes('http'));
});

test('initialize 返回 tokenbank-resources', () => {
  const sent = [];
  const orig = process.stdout.write;
  process.stdout.write = (s) => { sent.push(String(s)); return true; };
  try {
    mcp.handleMessage({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
  } finally {
    process.stdout.write = orig;
  }
  assert.equal(JSON.parse(sent[0]).result.serverInfo.name, 'tokenbank-resources');
});
