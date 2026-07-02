// shared/agent-forward-url.js
// CLI/Docker 贡献 Agent 转发地址：必须走本机 loopback 网关，X-P2P-Hop 才能生效。
'use strict';

function cliLoopbackGatewayBase(port) {
  const p = Number(port) || 11430;
  return `http://127.0.0.1:${p}/v1`;
}

function isCliGatewayMode() {
  return process.env.TOKENBANK_CLI === '1';
}

/** 将贡献配置中的转发 base_url 归一到本机网关（仅 CLI/Docker 进程） */
function normalizeAgentForwardCfg(cfg) {
  if (!cfg || !isCliGatewayMode()) return cfg;
  const loop = cliLoopbackGatewayBase(process.env.GATEWAY_PORT);
  const next = { ...cfg, llm_base_url: loop };
  if (next.model_groups?.length) {
    next.model_groups = next.model_groups.map((g) => ({ ...g, base_url: loop }));
  }
  if (Array.isArray(next.models)) {
    next.models = next.models.map((m) => {
      if (typeof m === 'string' || !m?.base_url) return m;
      return { ...m, base_url: loop };
    });
  }
  return next;
}

module.exports = {
  cliLoopbackGatewayBase,
  isCliGatewayMode,
  normalizeAgentForwardCfg,
};
