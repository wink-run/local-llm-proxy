#!/usr/bin/env node
// Token Bank 模型资源 MCP（stdio）
// 常驻同步进各 Agent：查询网关可用模型、校验 skill 所需模型是否存在并推荐替代
'use strict';

const readline = require('readline');

const TOOLS = [
  {
    name: 'tb_list_models',
    description:
      '列出 Token Bank 本地网关当前可用的模型（含 chat / image / embedding）。'
      + '调用图像生成、聊天或 embedding 前应先查此列表；不要假设 skill 文档里的模型名一定存在。',
    inputSchema: {
      type: 'object',
      properties: {
        type: {
          type: 'string',
          description: '按模态过滤：chat | image | embedding | all（默认 all）',
          enum: ['chat', 'image', 'embedding', 'all'],
        },
      },
    },
  },
  {
    name: 'tb_resolve_model',
    description:
      '解析要用的模型：若 preferred 在网关可用则直接采用；否则按 type（或从名字推断）推荐同模态可用模型。'
      + '用于 skill/脚本硬编码模型不存在时的动态切换，避免调用失败。',
    inputSchema: {
      type: 'object',
      properties: {
        preferred: {
          type: 'string',
          description: '期望使用的模型 ID（如 gpt-image-2、claude-sonnet-4）',
        },
        type: {
          type: 'string',
          description: '任务模态：chat | image | embedding；省略时从 preferred 名字推断',
          enum: ['chat', 'image', 'embedding'],
        },
      },
      required: ['preferred'],
    },
  },
];

/** 可注入：单测 mock；生产默认走本地网关 /v1/models */
let _listModelsImpl = null;

function setListModelsImpl(fn) {
  _listModelsImpl = typeof fn === 'function' ? fn : null;
}

function send(msg) {
  process.stdout.write(`${JSON.stringify(msg)}\n`);
}

function textResult(text, isError = false) {
  return {
    content: [{ type: 'text', text: String(text) }],
    isError: !!isError,
  };
}

/** 模型名启发式推断模态（与前端 gatewayModels.inferModelTypeFromName 对齐） */
function inferModelTypeFromName(id) {
  const n = String(id || '').toLowerCase();
  if (/(?:^|[\-_/])image(?:[\-_/]|$|\d)|gpt-image|dall-e|stable-diffusion|flux-|midjourney/.test(n)) {
    return 'image';
  }
  if (/embed|text-embedding|bge-|e5-/.test(n)) return 'embedding';
  return 'chat';
}

function normalizeModel(raw) {
  const id = typeof raw === 'string' ? raw : (raw?.id || raw?.name || '');
  if (!id) return null;
  const owned_by = (typeof raw === 'object' && raw?.owned_by) || 'tokenbank';
  const explicit = typeof raw === 'object'
    ? (raw.model_type || raw.type || raw.modality || null)
    : null;
  const model_type = explicit || inferModelTypeFromName(id);
  return { id: String(id), owned_by: String(owned_by), model_type };
}

function gatewayBaseUrl() {
  if (process.env.TB_GATEWAY_URL) {
    return String(process.env.TB_GATEWAY_URL).replace(/\/$/, '');
  }
  const port = process.env.TB_GATEWAY_PORT || process.env.GATEWAY_PORT || '11430';
  return `http://127.0.0.1:${port}`;
}

/** 从本地网关拉取模型列表 */
async function fetchGatewayModels() {
  const url = `${gatewayBaseUrl()}/v1/models`;
  const res = await fetch(url, {
    method: 'GET',
    headers: { Accept: 'application/json' },
    signal: AbortSignal.timeout(4000),
  });
  if (!res.ok) throw new Error(`网关 /v1/models HTTP ${res.status}`);
  const json = await res.json();
  const rows = Array.isArray(json?.data) ? json.data : [];
  return rows.map(normalizeModel).filter(Boolean);
}

async function listModels() {
  if (_listModelsImpl) return _listModelsImpl();
  return fetchGatewayModels();
}

function filterByType(models, type) {
  const t = String(type || 'all').toLowerCase();
  if (!t || t === 'all') return models;
  return models.filter(m => m.model_type === t);
}

function formatModelLine(m) {
  return `- ${m.id} [${m.model_type}] (owned_by=${m.owned_by})`;
}

function findExact(models, preferred) {
  const want = String(preferred || '').trim().toLowerCase();
  if (!want) return null;
  return models.find(m => m.id.toLowerCase() === want) || null;
}

/** 同模态推荐：精确匹配优先，否则按 id 字典序取第一个 */
function pickAlternative(models, preferred, type) {
  const pool = filterByType(models, type);
  if (!pool.length) return null;
  const exact = findExact(pool, preferred);
  if (exact) return exact;
  // 名字包含关系（如 gpt-image ≈ gpt-image-2）
  const want = String(preferred || '').trim().toLowerCase();
  if (want) {
    const fuzzy = pool.find(m => m.id.toLowerCase().includes(want) || want.includes(m.id.toLowerCase()));
    if (fuzzy) return fuzzy;
  }
  return [...pool].sort((a, b) => a.id.localeCompare(b.id))[0];
}

async function handleToolCall(name, args = {}) {
  if (name === 'tb_list_models') {
    try {
      const models = await listModels();
      const filtered = filterByType(models, args.type);
      if (!filtered.length) {
        const hint = args.type && args.type !== 'all'
          ? `（无 type=${args.type} 的可用模型）`
          : '（网关暂无可用模型；请确认 Token Bank 网关已启动并已配置供给源）';
        return textResult(hint);
      }
      const byType = { chat: 0, image: 0, embedding: 0 };
      for (const m of filtered) {
        if (byType[m.model_type] != null) byType[m.model_type] += 1;
      }
      const summary = `共 ${filtered.length} 个：chat=${byType.chat} image=${byType.image} embedding=${byType.embedding}`;
      const lines = filtered
        .slice()
        .sort((a, b) => a.model_type.localeCompare(b.model_type) || a.id.localeCompare(b.id))
        .map(formatModelLine);
      return textResult(
        `${summary}\n提示：skill 硬编码模型不存在时，用 tb_resolve_model 切换；全貌见 tb_capabilities。\n${lines.join('\n')}`,
      );
    } catch (e) {
      return textResult(
        `无法读取模型列表: ${e.message}\n请确认 Token Bank 本地网关已启动（默认 http://127.0.0.1:11430）。`,
        true,
      );
    }
  }

  if (name === 'tb_resolve_model') {
    const preferred = String(args.preferred || args.model || '').trim();
    if (!preferred) return textResult('缺少 preferred', true);
    const type = String(args.type || inferModelTypeFromName(preferred)).toLowerCase();

    try {
      const models = await listModels();
      const hit = findExact(models, preferred);
      if (hit) {
        return textResult(JSON.stringify({
          ok: true,
          available: true,
          model: hit.id,
          model_type: hit.model_type,
          owned_by: hit.owned_by,
          message: `模型可用，请使用: ${hit.id}`,
        }, null, 2));
      }

      const alt = pickAlternative(models, preferred, type);
      if (!alt) {
        return textResult(JSON.stringify({
          ok: false,
          available: false,
          preferred,
          model_type: type,
          model: null,
          alternatives: [],
          message: `首选模型 ${preferred} 不存在，且网关无可用的 ${type} 模型`,
        }, null, 2), true);
      }

      const alternatives = filterByType(models, type).map(m => m.id).slice(0, 12);
      return textResult(JSON.stringify({
        ok: true,
        available: false,
        preferred,
        model_type: type,
        model: alt.id,
        owned_by: alt.owned_by,
        alternatives,
        message: `首选模型 ${preferred} 不可用；已切换为同模态可用模型: ${alt.id}`,
      }, null, 2));
    } catch (e) {
      return textResult(
        `无法解析模型: ${e.message}\n请确认 Token Bank 本地网关已启动。`,
        true,
      );
    }
  }

  return textResult(`未知工具: ${name}`, true);
}

function handleMessage(msg) {
  const { id, method, params } = msg;

  if (method === 'initialize') {
    send({
      jsonrpc: '2.0',
      id,
      result: {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'tokenbank-models', version: '1.0.0' },
      },
    });
    return;
  }

  if (method === 'notifications/initialized') {
    return;
  }

  if (method === 'tools/list') {
    send({ jsonrpc: '2.0', id, result: { tools: TOOLS } });
    return;
  }

  if (method === 'tools/call') {
    const toolName = params?.name;
    const toolArgs = params?.arguments || {};
    handleToolCall(toolName, toolArgs)
      .then(result => send({ jsonrpc: '2.0', id, result }))
      .catch(err => send({
        jsonrpc: '2.0',
        id,
        result: textResult(err.message, true),
      }));
    return;
  }

  if (method === 'ping') {
    send({ jsonrpc: '2.0', id, result: {} });
    return;
  }

  if (id != null) {
    send({ jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` } });
  }
}

if (require.main === module) {
  const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  rl.on('line', (line) => {
    const t = line.trim();
    if (!t) return;
    try {
      handleMessage(JSON.parse(t));
    } catch (e) {
      // 忽略非法行
    }
  });
}

module.exports = {
  TOOLS,
  handleToolCall,
  handleMessage,
  setListModelsImpl,
  inferModelTypeFromName,
  normalizeModel,
  pickAlternative,
};
