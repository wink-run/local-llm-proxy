'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const {
  cliLoopbackGatewayBase,
  normalizeAgentForwardCfg,
} = require('../../shared/agent-forward-url');

describe('agent-forward-url', () => {
  const prev = { cli: process.env.TOKENBANK_CLI, port: process.env.GATEWAY_PORT };

  beforeEach(() => {
    process.env.TOKENBANK_CLI = '1';
    process.env.GATEWAY_PORT = '11430';
  });

  afterEach(() => {
    process.env.TOKENBANK_CLI = prev.cli;
    process.env.GATEWAY_PORT = prev.port;
  });

  it('cliLoopbackGatewayBase uses loopback and port', () => {
    assert.equal(cliLoopbackGatewayBase(11431), 'http://127.0.0.1:11431/v1');
  });

  it('normalizeAgentForwardCfg rewrites external gateway URL to loopback', () => {
    const cfg = {
      llm_base_url: 'http://myhost.example.com:11430/v1',
      model_groups: [{ base_url: 'http://myhost.example.com:11430/v1', models: ['glm-5.1'] }],
    };
    const out = normalizeAgentForwardCfg(cfg);
    assert.equal(out.llm_base_url, 'http://127.0.0.1:11430/v1');
    assert.equal(out.model_groups[0].base_url, 'http://127.0.0.1:11430/v1');
  });

  it('normalizeAgentForwardCfg is no-op outside CLI mode', () => {
    delete process.env.TOKENBANK_CLI;
    const cfg = { llm_base_url: 'http://cloud.example.com/v1' };
    assert.equal(normalizeAgentForwardCfg(cfg).llm_base_url, cfg.llm_base_url);
  });
});
