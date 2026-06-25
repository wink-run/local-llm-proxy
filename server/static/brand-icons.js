// 品牌 logo 解析 —— 与 client/src/lib/brandIcons.js 规则一致（静态页用 /static/brand-icons/ URL）
(function (global) {
  const BASE = '/static/brand-icons/';
  const RULES = [
    [/claude[\s_-]*code/i, BASE + 'claudecode-color.svg'],
    [/claude|anthropic/i, BASE + 'claude-color.svg'],
    [/codex/i, BASE + 'codex-color.svg'],
    [/openai|gpt|o[34]-|o1-/i, BASE + 'openai.svg'],
    [/cursor/i, BASE + 'cursor.svg'],
    [/openclaw/i, BASE + 'openclaw-color.svg'],
    [/gemini[\s_-]*cli/i, BASE + 'geminicli-color.svg'],
    [/gemini|google|palm/i, BASE + 'gemini-color.svg'],
    [/deepseek/i, BASE + 'deepseek-color.svg'],
    [/kimi|moonshot/i, BASE + 'kimi-color.svg'],
    [/glm|zhipu|chatglm|智谱/i, BASE + 'glmv-color.svg'],
    [/qwen|通义|tongyi/i, BASE + 'qwen-color.svg'],
    [/copilot/i, BASE + 'copilot-color.svg'],
    [/volcengine|火山|volc/i, BASE + 'volcengine-color.svg'],
  ];

  function resolveBrandIcon(text) {
    const hay = String(text || '');
    for (const [re, url] of RULES) if (re.test(hay)) return url;
    return null;
  }

  function brandIconFor(app) {
    app = app || {};
    return resolveBrandIcon(`${app.agent_id || ''} ${app.name || app.app_name || app.label || ''}`);
  }

  global.BrandIcons = { resolveBrandIcon, brandIconFor };
})(typeof window !== 'undefined' ? window : globalThis);
