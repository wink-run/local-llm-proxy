/**
 * 贡献节点：常见厂商 OpenAI/Anthropic 兼容 Base URL 与常用模型 ID 预设。
 * 与 agent-worker / Python agent 的 URL 拼接规则一致：多数厂商 base 已含 /v1、/v3、/v4 等，实际请求为 {base}/chat/completions；
 * 裸域名类为 {base}/v1/chat/completions。用户仍可完全手工修改 Base URL 与模型列表。
 * 模型名随各厂商迭代会变，请以各平台控制台文档为准；此处为 2026 年前后常见调用名。
 */
export const LLM_PROVIDER_PRESETS = [
  {
    id: 'custom',
    label: '手工填写 / 其他',
    baseUrl: '',
    defaultModels: [],
    hint: '自行填写下方 Base URL 与模型，适用于自建网关、Azure OpenAI、OneAPI 等。',
  },
  {
    id: 'ollama',
    label: '本地 Ollama',
    baseUrl: 'http://127.0.0.1:11434/v1',
    defaultModels: [],
    hint: '需本机已启动 Ollama；模型名与 ollama list 一致。',
  },
  {
    id: 'openai',
    label: 'OpenAI',
    baseUrl: 'https://api.openai.com/v1',
    defaultModels: ['gpt-5.5','gpt-5.5-pro','gpt-5.5-mini','gpt-5.5-instant','gpt-4o-mini'],
    hint: '官方 https://api.openai.com/v1 ，文档：https://platform.openai.com/docs',
  },
  {
    id: 'anthropic',
    label: 'Anthropic (Claude)',
    baseUrl: 'https://api.anthropic.com',
    defaultModels: ['claude-opus-4-7','claude-sonnet-4-6','claude-haiku-4-5','claude-sonnet-4-5'],
    hint: '官方 Claude API（Messages 格式）；桌面端 Agent 会自动走 /v1/messages。命令行 llm-agent 请改用 OpenAI 兼容中转。文档：https://docs.anthropic.com',
  },
  {
    id: 'zhipu',
    label: '智谱 AI (GLM)',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4/',
    defaultModels: ['glm-5.1','glm-5','glm-4.7', 'glm-4.6', 'glm-4-plus', 'glm-4-air', 'glm-4-flash'],
    hint: 'OpenAI 兼容，官方文档：https://docs.bigmodel.cn/cn/guide/develop/openai/introduction',
  },
  {
    id: 'volcengine',
    label: '火山引擎方舟',
    baseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
    defaultModels: [],
    hint: 'OpenAI 兼容；线上模型名常为「推理接入点 ID」（ep-xxxx）。文档：https://www.volcengine.com/docs/82379/1330626',
  },
  {
    id: 'siliconflow',
    label: '硅基流动 SiliconFlow',
    baseUrl: 'https://api.siliconflow.cn/v1',
    defaultModels: [],
    hint: 'OpenAI 兼容。文档：https://docs.siliconflow.cn/',
  },
  {
    id: 'minimax',
    label: 'MiniMax',
    baseUrl: 'https://api.minimax.io/v1',
    defaultModels: ['MiniMax-M2.7', 'MiniMax-M2.5', 'MiniMax-M2.1', 'MiniMax-M2'],
    hint: 'OpenAI 兼容；国际站 api.minimax.io。文档：https://platform.minimax.io/docs',
  },
  {
    id: 'gemini',
    label: 'Google Gemini (OpenAI 兼容)',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai/',
    defaultModels: ['gemini-2.5-pro', 'gemini-2.5-flash', 'gemini-2.0-flash'],
    hint: '需 Google AI Studio API Key；部分环境需 x-goog-api-key，若 Bearer 失败请查官方说明。文档：https://ai.google.dev/gemini-api/docs/openai',
  },
  {
    id: 'moonshot',
    label: 'Moonshot (Kimi)',
    baseUrl: 'https://api.moonshot.cn/v1',
    defaultModels: ['kimi-k2-turbo-preview', 'moonshot-v1-128k', 'moonshot-v1-32k', 'moonshot-v1-8k'],
    hint: 'OpenAI 兼容。文档：https://platform.moonshot.cn/docs',
  },
  {
    id: 'deepseek',
    label: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com/v1',
    defaultModels: ['deepseek-chat', 'deepseek-reasoner', 'deepseek-v4-flash', 'deepseek-v4-pro'],
    hint: '官方 OpenAI 兼容。文档：https://api-docs.deepseek.com/',
  },
  {
    id: 'openrouter',
    label: 'OpenRouter',
    baseUrl: 'https://openrouter.ai/api/v1',
    defaultModels: [],
    hint: '聚合多家模型，model 为带厂商前缀的字符串。文档：https://openrouter.ai/docs',
  }
];

/** 根据已保存的 baseUrl 反推当前应选中的预设 id（用于打开编辑时恢复下拉） */
export function matchPresetId(savedBaseUrl) {
  if (!savedBaseUrl || !String(savedBaseUrl).trim()) return 'custom';
  const n = savedBaseUrl.trim().replace(/\/+$/, '');
  const hit = LLM_PROVIDER_PRESETS.find(
    (p) => p.baseUrl && p.baseUrl.replace(/\/+$/, '') === n,
  );
  return hit ? hit.id : 'custom';
}
