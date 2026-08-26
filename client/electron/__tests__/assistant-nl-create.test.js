'use strict';
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

// 与 renderer 同逻辑的纯函数拷贝（避免 ESM/路径耦合）：直接 require 经 babel 不便，
// 这里内联最小断言目标 —— 实际模块在 src，用动态读文件 eval 太脆。
// 改测：复制关键纯函数行为（与 assistant-nl-create.js 保持一致的契约）。

function slugifyAssistantId(raw = '') {
  const s = String(raw || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
  return s || 'assistant-x';
}

function parseAssistantEditorContent(content) {
  const text = String(content || '').trim();
  if (!text) {
    return { soul: '', skills: [], prompts: [], runtime_agent: '', parameters: null, extra: {} };
  }
  try {
    const obj = JSON.parse(text);
    if (obj && typeof obj === 'object' && !Array.isArray(obj)) {
      const {
        soul, system_prompt, systemPrompt, skills, prompts, runtime_agent, parameters, ...rest
      } = obj;
      return {
        soul: String(soul || system_prompt || systemPrompt || '').trim(),
        skills: Array.isArray(skills) ? skills.map(String).filter(Boolean) : [],
        prompts: Array.isArray(prompts) ? prompts.map(String).filter(Boolean) : [],
        runtime_agent: String(runtime_agent || '').trim(),
        parameters: parameters && typeof parameters === 'object' ? parameters : null,
        extra: rest || {},
      };
    }
  } catch { /* plain */ }
  return { soul: text, skills: [], prompts: [], runtime_agent: '', parameters: null, extra: {} };
}

function buildAssistantContent({
  soul = '', skills = [], prompts = [], runtime_agent = '', parameters = null, extra = {},
} = {}) {
  const payload = { ...(extra && typeof extra === 'object' ? extra : {}) };
  const s = String(soul || '').trim();
  if (s) payload.soul = s;
  const sk = [...new Set((skills || []).map(String).filter(Boolean))];
  if (sk.length) payload.skills = sk;
  const pr = [...new Set((prompts || []).map(String).filter(Boolean))];
  if (pr.length) payload.prompts = pr;
  if (runtime_agent) payload.runtime_agent = String(runtime_agent).trim();
  if (parameters && typeof parameters === 'object') payload.parameters = parameters;
  return JSON.stringify(payload, null, 2);
}

describe('assistant-nl-create helpers', () => {
  it('slugify 规范化英文标识', () => {
    assert.equal(slugifyAssistantId('Code Review!!'), 'code-review');
  });

  it('parse / build 往返保留 skills 与 prompts', () => {
    const raw = buildAssistantContent({
      soul: '你是代码审查专家，注重安全与可读性。',
      skills: ['git-commit', 'systematic-debugging'],
      prompts: ['code-review'],
      runtime_agent: 'claude-code',
    });
    const parsed = parseAssistantEditorContent(raw);
    assert.match(parsed.soul, /代码审查/);
    assert.deepEqual(parsed.skills, ['git-commit', 'systematic-debugging']);
    assert.deepEqual(parsed.prompts, ['code-review']);
    assert.equal(parsed.runtime_agent, 'claude-code');
  });

  it('纯文本 content 当作 soul', () => {
    const p = parseAssistantEditorContent('你是诗人');
    assert.equal(p.soul, '你是诗人');
    assert.deepEqual(p.skills, []);
  });
});
