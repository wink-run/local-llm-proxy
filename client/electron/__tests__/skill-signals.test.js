'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  extractSkillsFromCursorTool,
  extractSkillsFromCursorRecord,
  extractSkillsFromToolCall,
  extractSkillsFromWorkbuddySpan,
  extractSkillNamesFromPathText,
} = require('../skill-signals');
const { buildTraceStats } = require('../session-trace/shared');
const { buildStepsFromSpans } = require('../session-trace/workbuddy-trace');

test('Cursor 手动附加 Skill（user 消息）计入 Trace', () => {
  const record = {
    role: 'user',
    message: {
      content: [{
        type: 'text',
        text: [
          '<manually_attached_skills>',
          'Skill Name: apple-design',
          'Path: /Users/ully/.claude/skills/apple-design/SKILL.md',
          'SKILL.md content:',
          '# Apple Design',
          '</manually_attached_skills>',
          '/apple-design当前的设计有何改进',
        ].join('\n'),
      }],
    },
  };
  const hits = extractSkillsFromCursorRecord(record);
  assert.ok(hits.some((h) => h.key === 'apple-design'), hits);
  assert.ok(hits.some((h) => h.signal === 'cursor-attach' || h.signal === 'cursor-path'), hits);

  const steps = hits.map((sk) => ({
    kind: 'tool',
    tool: 'attach_skill',
    skill: sk.raw,
    label: `Skill · ${sk.raw}`,
  }));
  const stats = buildTraceStats(steps, {});
  assert.ok(stats.skills_used.some((s) => s.name === 'apple-design'));
});

test('普通 user 提示不含 Skill 时不误报', () => {
  const hits = extractSkillsFromCursorRecord({
    role: 'user',
    message: { content: [{ type: 'text', text: '帮我改一下按钮样式' }] },
  });
  assert.equal(hits.length, 0);
});

test('Cursor Read skills-cursor/SKILL.md 解析为 Skill', () => {
  const hits = extractSkillsFromCursorTool('Read', {
    path: '/Users/ully/.cursor/skills-cursor/canvas/SKILL.md',
  });
  assert.equal(hits.length, 1);
  assert.equal(hits[0].raw, 'canvas');
  assert.equal(hits[0].key, 'canvas');
});

test('Cursor 忽略代码编辑里的 SKILL.md 字符串', () => {
  const hits = extractSkillsFromCursorTool('StrReplace', {
    old_string: '/** 读取 SKILL.md */',
    new_string: 'function skillFsActivityMs() {}',
  });
  assert.equal(hits.length, 0);
});

test('Cursor assistant 行进入 Trace skills_used', () => {
  const line = JSON.stringify({
    role: 'assistant',
    message: {
      content: [{
        type: 'tool_use',
        name: 'Read',
        input: { path: '/Users/ully/.cursor/skills-cursor/babysit/SKILL.md' },
      }],
    },
  });
  const record = JSON.parse(line);
  assert.equal(extractSkillsFromCursorRecord(record)[0].raw, 'babysit');

  const steps = [{
    kind: 'tool',
    tool: 'Read',
    skill: 'babysit',
    label: 'Skill · babysit',
  }];
  const stats = buildTraceStats(steps, {});
  assert.deepEqual(stats.skills_used, [{ name: 'babysit', count: 1 }]);
});

test('插件路径 skills/<name>/SKILL.md 可识别', () => {
  const names = extractSkillNamesFromPathText(
    '/Users/ully/.claude/plugins/cache/foo/skills/systematic-debugging/SKILL.md',
  );
  assert.deepEqual(names, ['systematic-debugging']);
});

test('WorkBuddy Skill 工具 + Read 路径', () => {
  const structured = extractSkillsFromWorkbuddySpan({
    name: 'Skill',
    type: 'function',
    toolInput: '{"skill":"apple-notes"}',
  });
  assert.equal(structured[0].raw, 'apple-notes');

  const viaRead = extractSkillsFromToolCall('Read', {
    path: '/Users/ully/.workbuddy/skills/code-avatar-icon-generator/SKILL.md',
  }, { signalPrefix: 'workbuddy' });
  assert.equal(viaRead[0].raw, 'code-avatar-icon-generator');

  const span = { t0: 0, span: 1000, lineCount: 3 };
  const steps = buildStepsFromSpans([
    {
      type: 'function',
      name: 'Skill',
      toolInput: '{"skill":"brandkit"}',
      startedAt: '2026-07-12T10:00:00.000Z',
    },
  ], span);
  assert.ok(steps.some(s => s.skill === 'brandkit'));
  const stats = buildTraceStats(steps, {});
  assert.deepEqual(stats.skills_used, [{ name: 'brandkit', count: 1 }]);
});

test('Codex 路径面包屑走通用提取', () => {
  const hits = extractSkillsFromToolCall(
    'Bash',
    'cat ~/.agents/skills/tt-probe-skill/SKILL.md',
    { signalPrefix: 'codex' },
  );
  assert.equal(hits[0]?.raw, 'tt-probe-skill');
});
