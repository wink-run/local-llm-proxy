// client/electron/model-context-window.js
// 按模型解析上下文窗口，避免 catalog / Claude Code 全员硬编码同一窗口。
// 优先级：显式字段 → 供给源元数据 → 模型名族启发式 → 仅未知时兜底。
'use strict';

/** 完全未知模型时的兜底（对齐 Claude Code 对未知模型的默认量级 200K） */
const FALLBACK_CONTEXT_WINDOW = 200000;

/**
 * 路由类 model_key（llm-router-auto / -cost / -speed …）不是真实模型：网关按策略落到候选源。
 * 无钉死模型时写入应用配置默认 200k；若 steps 钉了具体模型，则以这些模型窗口为准（取最大）。
 */
const ROUTE_MODEL_KEY = /^llm-router-/i;
const ROUTE_CONTEXT_WINDOW = 200000;

/**
 * 解析模型名末尾窗口后缀，如 deepseek-v4-pro[1m] / glm-5.2[200k] / model[1048576]。
 * @returns {{ slug: string, window: number|null }}
 */
function parseContextWindowSuffix(model) {
  const trimmed = String(model || '').trim();
  if (!trimmed) return { slug: '', window: null };
  const close = trimmed.lastIndexOf(']');
  if (close !== trimmed.length - 1) return { slug: trimmed, window: null };
  const open = trimmed.lastIndexOf('[');
  if (open <= 0) return { slug: trimmed, window: null };
  const inner = trimmed.slice(open + 1, close).trim().toLowerCase();
  const slug = trimmed.slice(0, open);
  // 纯数字
  if (/^\d+$/.test(inner)) {
    const n = parseInt(inner, 10);
    return { slug, window: n > 0 ? n : null };
  }
  // 1m / 200k / 1.5m
  const m = /^(\d+(?:\.\d+)?)(m|k)$/i.exec(inner);
  if (!m) return { slug: trimmed, window: null };
  const num = parseFloat(m[1]);
  if (!(num > 0)) return { slug: trimmed, window: null };
  const mult = m[2].toLowerCase() === 'm' ? 1_000_000 : 1_000;
  return { slug, window: Math.round(num * mult) };
}

/** 从对象上读显式上下文字段 */
function readExplicitContextWindow(obj) {
  if (!obj || typeof obj !== 'object') return null;
  for (const key of ['context_window', 'contextWindow', 'context_length', 'contextLength', 'max_context_window']) {
    const n = Number(obj[key]);
    if (Number.isFinite(n) && n > 0) return Math.floor(n);
  }
  return null;
}

/**
 * 扫描供给源 providers[].models[]，按名字取显式 context_* 字段。
 */
function contextWindowFromProviders(modelId, providers = []) {
  if (!modelId) return null;
  for (const p of Array.isArray(providers) ? providers : []) {
    for (const m of (p && Array.isArray(p.models) ? p.models : [])) {
      const id = typeof m === 'string' ? m : (m && (m.name || m.id));
      if (id !== modelId) continue;
      if (typeof m === 'object') {
        const n = readExplicitContextWindow(m);
        if (n) return n;
      }
    }
  }
  return null;
}

/**
 * 按模型名族推断窗口（更具体的规则在前）。
 * 数值对齐 cc-switch `codexProviderPresets.ts` / 官方 catalog 模板；同名多值时取官方直连口径。
 */
function contextWindowFromModelName(modelId) {
  const raw = String(modelId || '').trim();
  if (!raw) return null;
  const { slug, window: suffixWin } = parseContextWindowSuffix(raw);
  if (suffixWin) return suffixWin;
  const id = (slug || raw).toLowerCase();

  // 顺序：更具体在前。注释标注 cc-switch 来源。
  const rules = [
    // OpenAI GPT —— Codex gpt5_5 模板 / #5804：5.4/5.5/5.6 = 272000；其它 gpt-5 ≈ 400000（openclaw）
    { re: /gpt-5\.6|gpt-5-6|gpt-5\.5|gpt-5-5|gpt-5\.4|gpt-5-4/, window: 272000 },
    { re: /gpt-5\.1|gpt-5-1|gpt-5(?![\d.])/, window: 400000 },
    { re: /\bo3\b|\bo4-mini\b/, window: 200000 },

    // Claude —— 4.x 系列 200K；opus-5 / sonnet-5 为 1M（opencode/bedrock 预设）
    { re: /claude-(opus|sonnet)-5(?!\d)|claude-opus-5|claude-sonnet-5/, window: 1000000 },
    { re: /claude/, window: 200000 },

    // DeepSeek —— v4 = 1M；其余保守 128K（codex deepseek catalog / presets）
    { re: /deepseek.*v4|deepseek-v4/, window: 1048576 },
    { re: /deepseek/, window: 128000 },

    // 智谱 GLM —— 官方 Coding 预设 glm-5.2 = 200000（OpenCode Go 偶见 204800，取官方）
    { re: /glm-5|glm-4\.7|glm-4-7/, window: 200000 },
    { re: /glm-4/, window: 128000 },

    // Kimi / Moonshot —— k3 = 1M；k2.x / for-coding = 256K
    { re: /kimi-k3|kimi.*k3|(^|[^a-z0-9])k3(\.|[-_]|$)/, window: 1048576 },
    { re: /kimi|moonshot|(^|[^a-z0-9])k2(\.|[-_]|$)|kimi-for-coding/, window: 262144 },

    // MiniMax —— M3 = 1000000；M2.7 = 200000（勿把全家写成 1M）
    { re: /minimax-m3|minimax_m3|(^|[^a-z0-9])m3(\.|[-_]|$)/, window: 1000000 },
    { re: /minimax-m2\.7|minimax_m2\.7|m2\.7|minimax/, window: 200000 },

    // 通义 —— qwen3-coder* = 1M；其它 qwen 默认 128K
    { re: /qwen3-coder|qwen.*coder/, window: 1048576 },
    { re: /qwen/, window: 131072 },

    // Gemini
    { re: /gemini-3|gemini.*2\.5|gemini-2\.5/, window: 1048576 },
    { re: /gemini/, window: 128000 },

    // 小米 MiMo v2.5 = 1M（codex presets）
    { re: /mimo/, window: 1048576 },

    // xAI Grok 4.5 = 500K
    { re: /grok/, window: 500000 },

    // 豆包 / Seed —— seed-2 = 262144；ark-code = 256000
    { re: /doubao-seed|seed-2|doubao/, window: 262144 },
    { re: /ark-code|hy3/, window: 256000 },

    // 美团 LongCat 2.0 = 1M
    { re: /longcat/, window: 1048576 },

    // StepFun / 阶跃
    { re: /step-3|step\d/, window: 262144 },

    // 百川 / 千帆 / 蚂蚁 Ling
    { re: /qianfan/, window: 131072 },
    { re: /ling-2|ling_2|(^|[^a-z0-9])ling(\.|[-_]|$)/, window: 262144 },
  ];
  for (const { re, window } of rules) {
    if (re.test(id)) return window;
  }
  return null;
}

/**
 * 解析单个模型的上下文窗口。
 * @param {string|object} model 模型名，或含 name/context_window 的对象
 * @param {object[]} [providers] 供给源列表（可选，用于读元数据）
 * @returns {number}
 */
function resolveContextWindow(model, providers = []) {
  if (model && typeof model === 'object') {
    const explicit = readExplicitContextWindow(model);
    if (explicit) return explicit;                              // 用户/源显式指定优先
    const name = model.name || model.id || model.model;
    if (ROUTE_MODEL_KEY.test(String(name || ''))) return ROUTE_CONTEXT_WINDOW;  // 路由 → 保守
    const fromProv = contextWindowFromProviders(name, providers);
    if (fromProv) return fromProv;
    return contextWindowFromModelName(name) || FALLBACK_CONTEXT_WINDOW;
  }
  const name = String(model || '');
  if (ROUTE_MODEL_KEY.test(name)) return ROUTE_CONTEXT_WINDOW;   // 路由 model_key → 默认 200k
  const fromProv = contextWindowFromProviders(name, providers);
  if (fromProv) return fromProv;
  return contextWindowFromModelName(name) || FALLBACK_CONTEXT_WINDOW;
}

/**
 * 从场景路由 steps / rules[].steps 收集钉死的具体模型名（跳过 strategy-only / 空 model）。
 */
function concreteModelsFromScene(scene) {
  const out = [];
  const seen = new Set();
  const add = (raw) => {
    const id = String(raw || '').trim();
    if (!id || ROUTE_MODEL_KEY.test(id) || seen.has(id)) return;
    seen.add(id);
    out.push(id);
  };
  const walk = (steps) => {
    if (!Array.isArray(steps)) return;
    for (const s of steps) {
      if (!s || typeof s !== 'object') continue;
      add(s.model || s.label);
    }
  };
  if (!scene || typeof scene !== 'object') return out;
  walk(scene.steps);
  if (Array.isArray(scene.rules)) {
    for (const rule of scene.rules) walk(rule && rule.steps);
  }
  return out;
}

/**
 * 场景路由写入应用配置时的上下文窗口：
 * 有钉死模型 → 取这些模型窗口的最小值（落到哪个都不超）；纯策略/过滤路由 → 默认 200k。
 */
function resolveContextWindowForScene(scene, providers = []) {
  const models = concreteModelsFromScene(scene);
  if (models.length) {
    const min = resolveMinContextWindow(models, providers);
    if (min && min > 0) return min;
  }
  return ROUTE_CONTEXT_WINDOW;
}

/** 多个模型取最大窗口（Claude Code 注入 ACW/MAX 时用） */
function resolveMaxContextWindow(models, providers = []) {
  const list = Array.isArray(models) ? models : [];
  let max = 0;
  for (const m of list) {
    const w = resolveContextWindow(m, providers);
    if (w > max) max = w;
  }
  return max > 0 ? max : null;
}

/**
 * 多个候选模型取最小窗口。用于路由：路由会落到候选里任意一个，取最小才保证落到哪个都不超其真实窗口。
 * 空列表返回 null（调用方回退保守默认）。
 */
function resolveMinContextWindow(models, providers = []) {
  const list = Array.isArray(models) ? models : [];
  let min = Infinity;
  for (const m of list) {
    const w = resolveContextWindow(m, providers);
    if (w > 0 && w < min) min = w;
  }
  return Number.isFinite(min) ? min : null;
}

/** Claude Code 自动压缩阈值 ≈ 窗口 × 80%（与 cc-switch 一致） */
function autoCompactWindow(contextWindow) {
  const w = Number(contextWindow);
  if (!(w > 0)) return null;
  return Math.floor(w * 0.8);
}

module.exports = {
  FALLBACK_CONTEXT_WINDOW,
  ROUTE_CONTEXT_WINDOW,
  ROUTE_MODEL_KEY,
  parseContextWindowSuffix,
  readExplicitContextWindow,
  contextWindowFromProviders,
  contextWindowFromModelName,
  concreteModelsFromScene,
  resolveContextWindow,
  resolveContextWindowForScene,
  resolveMaxContextWindow,
  resolveMinContextWindow,
  autoCompactWindow,
};
