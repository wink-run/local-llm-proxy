// client/electron/resource-catalog.js
// 常见 Prompt / Skill / Assistant 资源目录（参考 aweskill / 社区常见模板）
'use strict';

const RESOURCE_TYPE_LABELS = {
  prompt: '提示词',
  skill: '技能',
  assistant: '助手',
  template: '模板',
};

/** @type {Array<object>} */
const BUILTIN_CATALOG = [
  {
    catalogId: 'code-review-prompt',
    type: 'prompt',
    name: 'code-review',
    display_name: '代码审查',
    description: '结构化代码审查：安全、性能、可维护性',
    metadata: { tags: ['code', 'review', 'quality'], version: '1.0.0' },
    content: `你是一个资深代码审查专家。请审查以下代码，输出：
1. 严重问题（必须修复）
2. 改进建议（可选）
3. 简要总结

{{#if focus_security}}重点关注安全漏洞与权限问题。{{/if}}
{{#if focus_performance}}重点关注性能与资源占用。{{/if}}

代码：
\`\`\`
{{code}}
\`\`\`
`,
  },
  {
    catalogId: 'api-design-prompt',
    type: 'prompt',
    name: 'api-design',
    display_name: 'API 设计',
    description: 'REST/OpenAPI 接口设计与评审',
    metadata: { tags: ['api', 'design', 'backend'], version: '1.0.0' },
    content: `你是 API 架构师。根据需求设计 REST API：
- 资源命名与 HTTP 动词
- 请求/响应 JSON Schema 要点
- 错误码与分页约定
- 鉴权方式建议

需求描述：
{{requirements}}
`,
  },
  {
    catalogId: 'git-commit-skill',
    type: 'skill',
    name: 'git-commit',
    display_name: 'Git 提交规范',
    description: '生成符合 Conventional Commits 的提交信息',
    metadata: {
      tags: ['git', 'commit', 'workflow'],
      version: '1.0.0',
      compatible_agents: ['claude-code', 'codex', 'cursor', 'workbuddy'],
    },
    content: `---
name: git-commit
description: 分析 diff 并生成规范的 Git 提交信息（Conventional Commits）
---

# Git Commit Skill

## 何时使用
用户要求写 commit message、总结变更、或准备 git commit 时。

## 规则
1. 使用 Conventional Commits：feat/fix/docs/refactor/test/chore 等
2. 标题 ≤ 72 字符，英文或中文均可
3. 正文说明 WHY，必要时列出 BREAKING CHANGE

## 输出格式
\`\`\`
<type>(<scope>): <subject>

<body>
\`\`\`
`,
  },
  {
    catalogId: 'systematic-debugging-skill',
    type: 'skill',
    name: 'systematic-debugging',
    display_name: '系统化调试',
    description: '遇 bug 时按步骤收集证据再修复',
    metadata: {
      tags: ['debug', 'quality'],
      version: '1.0.0',
      compatible_agents: ['claude-code', 'codex', 'cursor', 'workbuddy'],
    },
    content: `---
name: systematic-debugging
description: 系统化调试流程，先复现与定位根因再改代码
---

# Systematic Debugging

## 流程
1. 复现：最小步骤、期望 vs 实际
2. 证据：日志、堆栈、最近变更
3. 假设：列出 2–3 个可能根因并验证
4. 修复：最小 diff，附带验证方式
5. 回归：确认未引入新问题

## 禁止
- 未理解根因就大面积重写
- 同时改多处 unrelated 代码
`,
  },
  {
    catalogId: 'python-expert-assistant',
    type: 'assistant',
    name: 'python-expert',
    display_name: 'Python 专家',
    description: 'Python / 数据科学 / Web 开发预设',
    metadata: {
      tags: ['python', 'assistant', 'development'],
      version: '1.0.0',
      category: 'development',
    },
    content: JSON.stringify({
      system_prompt: '你是 Python 专家，精通标准库、类型注解、pytest 与 FastAPI。回答简洁，代码可运行。',
      skills: ['systematic-debugging'],
      prompts: ['code-review'],
      parameters: { temperature: 0.3 },
    }, null, 2),
  },
  {
    catalogId: 'api-dev-template',
    type: 'template',
    name: 'api-development-workflow',
    display_name: 'API 开发工作流',
    description: '需求 → 设计 → 实现 → 测试 四步模板',
    metadata: { tags: ['workflow', 'api', 'backend'], steps_count: 4, version: '1.0.0' },
    content: JSON.stringify({
      steps: [
        { name: '需求分析', prompt: 'api-design', inputs: ['requirements'] },
        { name: '接口设计', assistant: 'python-expert', inputs: ['requirements'] },
        { name: '生成代码', skills: ['systematic-debugging'], inputs: ['api_design'] },
        { name: '提交变更', skill: 'git-commit', inputs: ['diff'] },
      ],
    }, null, 2),
  },
];

function getCatalogItem(catalogId) {
  return BUILTIN_CATALOG.find(c => c.catalogId === catalogId) || null;
}

function listCatalogItems(filters = {}) {
  let items = [...BUILTIN_CATALOG];
  if (filters.type) items = items.filter(i => i.type === filters.type);
  if (filters.query) {
    const q = String(filters.query).toLowerCase();
    items = items.filter(i =>
      i.name.includes(q)
      || (i.display_name || '').toLowerCase().includes(q)
      || (i.description || '').toLowerCase().includes(q)
      || (i.metadata?.tags || []).some(t => t.includes(q)),
    );
  }
  return items;
}

function listCatalogGrouped() {
  const groups = {};
  for (const item of BUILTIN_CATALOG) {
    if (!groups[item.type]) groups[item.type] = [];
    groups[item.type].push(item);
  }
  return groups;
}

module.exports = {
  RESOURCE_TYPE_LABELS,
  BUILTIN_CATALOG,
  getCatalogItem,
  listCatalogItems,
  listCatalogGrouped,
};
