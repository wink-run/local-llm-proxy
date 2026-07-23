// Token Bank 能力体系（供 MCP 总览与编排提示共用）
// 分域暴露：编排 / 提示词 / 模型 / 资源发现，各有同步策略，勿合并成单一巨型 MCP
'use strict';

/** 能力域与工具对照（体系入口） */
const CAPABILITY_DOMAINS = [
  {
    id: 'overview',
    mcp: 'tokenbank-resources',
    title: '能力总览与资源发现',
    tools: ['tb_capabilities', 'tb_list_resources', 'tb_get_resource', 'tb_list_catalog', 'tb_list_gateway'],
    when: '不确定有哪些能力时先调 tb_capabilities；查已纳管 skill/assistant/prompt、社区目录、网关 API',
  },
  {
    id: 'models',
    mcp: 'tokenbank-models',
    title: '模型资源',
    tools: ['tb_list_models', 'tb_resolve_model'],
    when: '调聊天/图像/embedding 前确认可用模型；skill 硬编码模型不存在时用 tb_resolve_model 切换',
  },
  {
    id: 'prompts',
    mcp: 'tokenbank-prompts',
    title: '提示词',
    tools: ['tb_list_prompts', 'tb_get_prompt'],
    when: '用户提到「用某某提示词」时，先 list 再 get，禁止臆造正文',
  },
  {
    id: 'dispatch',
    mcp: 'tokenbank-agent-bridge',
    title: 'Agent 派发（编排层）',
    tools: ['tb_list_agents', 'tb_dispatch_agent'],
    when: '编排主 Agent：优先派发给专业智能体 assistant:*，勿在 shell 直接跑 CLI',
  },
];

/** 本地网关能力面（只读发现，实际调用走 HTTP） */
const GATEWAY_ENDPOINTS = [
  { method: 'GET', path: '/v1/models', capability: 'models', note: '列出可用模型；亦可用 tb_list_models' },
  { method: 'POST', path: '/v1/chat/completions', capability: 'chat', note: 'OpenAI 兼容聊天' },
  { method: 'POST', path: '/v1/messages', capability: 'chat', note: 'Anthropic Messages' },
  { method: 'POST', path: '/v1/images/generations', capability: 'image', note: '文生图；model 须在 tb_list_models(type=image) 中' },
  { method: 'POST', path: '/v1/embeddings', capability: 'embedding', note: '向量嵌入' },
  { method: 'POST', path: '/v1/audio/speech', capability: 'tts', note: '语音合成 TTS' },
  { method: 'GET', path: '/health', capability: 'health', note: '网关健康检查' },
];

function gatewayBaseUrl() {
  if (process.env.TB_GATEWAY_URL) {
    return String(process.env.TB_GATEWAY_URL).replace(/\/$/, '');
  }
  const port = process.env.TB_GATEWAY_PORT || process.env.GATEWAY_PORT || '11430';
  return `http://127.0.0.1:${port}`;
}

/** 生成给 Agent 阅读的能力总览正文 */
function formatCapabilitiesOverview() {
  const base = gatewayBaseUrl();
  const lines = [
    '# Token Bank 能力体系',
    '',
    '本软件通过内置 MCP 暴露资源与能力。不确定时先读本总览，再按域调用对应工具。',
    '',
    '## 能力域',
    '',
  ];
  for (const d of CAPABILITY_DOMAINS) {
    lines.push(`### ${d.title}（MCP: ${d.mcp}）`);
    lines.push(`- 工具: ${d.tools.join(', ')}`);
    lines.push(`- 何时用: ${d.when}`);
    lines.push('');
  }
  lines.push('## 推荐工作流');
  lines.push('1. tb_capabilities → 了解全貌');
  lines.push('2. 任务需模型 → tb_list_models / tb_resolve_model（勿假设 skill 里的模型名一定存在）');
  lines.push('3. 任务需 skill/智能体 → tb_list_resources；社区未安装项 → tb_list_catalog（安装请用户在 Token Bank UI 操作）');
  lines.push('4. 用户点名提示词 → tb_list_prompts / tb_get_prompt');
  lines.push('5. 编排派发 → tb_list_agents / tb_dispatch_agent');
  lines.push('6. 直连网关 API → tb_list_gateway 查路径，base = ' + base);
  lines.push('');
  lines.push('## 原则');
  lines.push('- 只读发现优先；安装/投射/改配置留给 Token Bank 客户端 UI');
  lines.push('- skill 硬编码模型失败时，用 tb_resolve_model 切换到网关实际可用模型');
  lines.push('- 禁止臆造 prompt/skill 正文；以 MCP 取回内容为准');
  return lines.join('\n');
}

/** 编排层系统提示中的精简能力指引 */
function formatOrchestratorCapabilityHint() {
  return [
    '6. 不确定本软件能力时，先 tb_capabilities；模型用 tb_list_models / tb_resolve_model；',
    '   资源用 tb_list_resources / tb_get_resource；提示词用 tb_list_prompts / tb_get_prompt。',
  ].join('\n');
}

module.exports = {
  CAPABILITY_DOMAINS,
  GATEWAY_ENDPOINTS,
  gatewayBaseUrl,
  formatCapabilitiesOverview,
  formatOrchestratorCapabilityHint,
};
