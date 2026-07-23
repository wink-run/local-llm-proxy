// 闲置 Skill 大模型分析：分批处理，避免 Skill 过多时卡死

/** 每批送给模型的条数（过大易超时/卡 UI） */
const BATCH_SIZE = 12;
/** 模型最多分析条数；超出部分仅用启发式 */
const MAX_AI_ITEMS = 96;
const MAX_DESC = 72;

/** 让出主线程，避免连续同步/大响应解析卡死界面 */
function yieldToUi() {
  return new Promise((resolve) => {
    if (typeof requestAnimationFrame === 'function') {
      requestAnimationFrame(() => setTimeout(resolve, 0));
    } else {
      setTimeout(resolve, 0);
    }
  });
}

/** 解析本地网关 base（与 resource-purpose 一致） */
async function resolveGatewayBase() {
  let base = 'http://127.0.0.1:11430';
  if (!window.electronAPI?.gateway?.status) return base;
  try {
    const st = await window.electronAPI.gateway.status();
    const port = st?.port || st?.listenPort || st?.localPort;
    if (port) base = `http://127.0.0.1:${port}`;
    else if (st?.url || st?.baseUrl) base = String(st.url || st.baseUrl).replace(/\/$/, '');
  } catch { /* 默认口 */ }
  return base;
}

function compactItem(item) {
  const desc = String(item.description || '').replace(/\s+/g, ' ').trim().slice(0, MAX_DESC);
  return {
    id: item.id,
    name: item.name,
    desc,
    idleDays: item.idleDays || 0,
    never: !item.lastActivityAt,
    projections: item.projectionCount || 0,
  };
}

/** 从模型文本里抠 JSON 数组/对象 */
function extractJson(text) {
  const raw = String(text || '').trim();
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { /* continue */ }
  const arr = raw.match(/\[[\s\S]*\]/);
  if (arr) {
    try { return JSON.parse(arr[0]); } catch { /* continue */ }
  }
  const obj = raw.match(/\{[\s\S]*\}/);
  if (obj) {
    try { return JSON.parse(obj[0]); } catch { /* continue */ }
  }
  return null;
}

/**
 * 无模型时的兜底：从未调用 → 推荐；其余仅标记闲置不强制推荐。
 * @returns {Record<string, { recommend: boolean, reason: string, source: string }>}
 */
export function heuristicIdleRecommendations(items, days = 60) {
  const out = {};
  const list = Array.isArray(items) ? items : [];
  // 同前缀簇（如 codex-slides-*）且全部从未调用 → 整簇推荐
  const groups = new Map();
  for (const it of list) {
    const name = String(it.name || '');
    const prefix = name.includes('-') ? name.split('-').slice(0, 2).join('-') : name;
    if (!groups.has(prefix)) groups.set(prefix, []);
    groups.get(prefix).push(it);
  }

  for (const it of list) {
    const never = !it.lastActivityAt;
    const name = String(it.name || '');
    const prefix = name.includes('-') ? name.split('-').slice(0, 2).join('-') : name;
    const peers = groups.get(prefix) || [];
    const clusterUnused = peers.length >= 3 && peers.every((p) => !p.lastActivityAt);

    if (never && clusterUnused) {
      out[it.id] = {
        recommend: true,
        reason: `同系列「${prefix}-*」共 ${peers.length} 个均从未调用，建议整批清理`,
        source: 'heuristic',
      };
    } else if (never) {
      out[it.id] = {
        recommend: true,
        reason: `超过 ${days} 天从未被会话调用，优先清理`,
        source: 'heuristic',
      };
    } else if ((it.idleDays || 0) >= days) {
      out[it.id] = {
        recommend: false,
        reason: `已闲置 ${it.idleDays} 天；曾有调用记录，是否删除请自行判断`,
        source: 'heuristic',
      };
    } else {
      out[it.id] = {
        recommend: false,
        reason: '闲置未达阈值，建议保留',
        source: 'heuristic',
      };
    }
  }
  return out;
}

/** 优先把「从未调用」送给模型，其余靠后 */
function prioritizeForAi(items) {
  const list = Array.isArray(items) ? items.slice() : [];
  list.sort((a, b) => {
    const an = a.lastActivityAt ? 1 : 0;
    const bn = b.lastActivityAt ? 1 : 0;
    if (an !== bn) return an - bn;
    return (b.idleDays || 0) - (a.idleDays || 0);
  });
  return list;
}

async function analyzeBatch(base, batch, days, lang, signal) {
  if (signal?.aborted) throw new Error('aborted');
  const zh = lang !== 'en';
  const payload = batch.map(compactItem);
  const prompt = zh
    ? [
      '你是 Token Bank 的 Skill 清理顾问。下面是「闲置」候选（近 N 天无会话调用）。',
      `闲置阈值 N=${days} 天。请判断哪些可以推荐删除，并给一句简短中文理由。`,
      '规则：',
      '1. 从未调用(never=true)、明显重复/系列冗余、描述空或过时 → recommend=true',
      '2. 名称像核心工作流/通用工具、虽闲置但可能仍需要 → recommend=false，说明保留理由',
      '3. 不要编造不存在的替代技能；理由 ≤ 40 字',
      '4. 必须覆盖输入里每一个 id',
      '只输出 JSON 数组，不要 markdown：',
      '[{"id":"...","recommend":true,"reason":"..."}]',
      `候选: ${JSON.stringify(payload)}`,
    ].join('\n')
    : [
      'You are a Skill cleanup advisor for Token Bank. Candidates are idle (no session use in N days).',
      `Threshold N=${days}. Decide which to recommend deleting, with a short reason.`,
      'Rules: never-used / redundant series / empty-or-stale desc → recommend=true;',
      'core workflow tools → recommend=false with keep reason; do not invent replacements; reason ≤ 40 words;',
      'cover every id. Output JSON array only:',
      '[{"id":"...","recommend":true,"reason":"..."}]',
      `Candidates: ${JSON.stringify(payload)}`,
    ].join('\n');

  const res = await window.electronAPI.llm.fetch(`${base}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'auto',
      temperature: 0.2,
      max_tokens: 1200,
      messages: [{ role: 'user', content: prompt }],
    }),
  });
  if (signal?.aborted) throw new Error('aborted');
  if (!res || res.status >= 400) throw new Error(`llm http ${res?.status || '?'}`);
  // 大响应解析前让出一帧，减轻卡顿
  await yieldToUi();
  const data = JSON.parse(res.body || '{}');
  const text = data?.choices?.[0]?.message?.content || data?.content || '';
  const parsed = extractJson(text);
  const rows = Array.isArray(parsed)
    ? parsed
    : Array.isArray(parsed?.recommendations)
      ? parsed.recommendations
      : [];
  const map = {};
  for (const row of rows) {
    if (!row || !row.id) continue;
    map[String(row.id)] = {
      recommend: !!row.recommend,
      reason: String(row.reason || '').trim().slice(0, 120),
      source: 'ai',
    };
  }
  return map;
}

/**
 * 用本地网关大模型分析闲置 Skill（分批 + 进度回调）。
 * @param {object[]} items
 * @param {{
 *   days?: number,
 *   lang?: string,
 *   signal?: AbortSignal,
 *   onProgress?: (p: { done: number, total: number, batch: number, batches: number, phase: string }) => void,
 *   onPartial?: (map: Record<string, object>) => void,
 * }} [options]
 */
export async function analyzeIdleSkillsWithAi(items, options = {}) {
  const list = Array.isArray(items) ? items : [];
  const days = Math.max(1, Number(options.days) || 60);
  const lang = options.lang === 'en' ? 'en' : 'zh';
  const signal = options.signal;
  const onProgress = typeof options.onProgress === 'function' ? options.onProgress : null;
  const onPartial = typeof options.onPartial === 'function' ? options.onPartial : null;

  const fallback = heuristicIdleRecommendations(list, days);
  if (!list.length) return { map: {}, source: 'heuristic', batches: 0 };

  // 先回传启发式，界面立刻可勾选，再分批用模型覆盖
  onPartial?.(fallback);
  onProgress?.({ done: 0, total: list.length, batch: 0, batches: 0, phase: 'heuristic' });
  await yieldToUi();

  if (!window.electronAPI?.llm?.fetch) {
    return { map: fallback, source: 'heuristic', error: 'no llm', batches: 0 };
  }
  if (signal?.aborted) {
    return { map: fallback, source: 'heuristic', error: 'aborted', batches: 0 };
  }

  const ranked = prioritizeForAi(list);
  const aiQueue = ranked.slice(0, MAX_AI_ITEMS);
  const batches = Math.ceil(aiQueue.length / BATCH_SIZE) || 0;
  const merged = { ...fallback };
  let aiHits = 0;
  let lastError = '';

  try {
    const base = await resolveGatewayBase();
    for (let i = 0; i < aiQueue.length; i += BATCH_SIZE) {
      if (signal?.aborted) {
        return { map: merged, source: aiHits > 0 ? 'ai' : 'heuristic', error: 'aborted', batches };
      }
      const batchNo = Math.floor(i / BATCH_SIZE) + 1;
      const batch = aiQueue.slice(i, i + BATCH_SIZE);
      onProgress?.({
        done: i,
        total: aiQueue.length,
        batch: batchNo,
        batches,
        phase: 'ai',
      });

      try {
        const part = await analyzeBatch(base, batch, days, lang, signal);
        for (const it of batch) {
          const hit = part[it.id];
          if (hit && hit.reason) {
            merged[it.id] = hit;
            aiHits += 1;
          }
        }
      } catch (e) {
        if (String(e.message || e) === 'aborted') {
          return { map: merged, source: aiHits > 0 ? 'ai' : 'heuristic', error: 'aborted', batches };
        }
        // 单批失败：保留启发式，继续下一批，避免整次卡死
        lastError = e.message || String(e);
      }

      onPartial?.({ ...merged });
      onProgress?.({
        done: Math.min(i + batch.length, aiQueue.length),
        total: aiQueue.length,
        batch: batchNo,
        batches,
        phase: 'ai',
      });
      // 批间让出主线程，给渲染/输入喘气
      await yieldToUi();
    }

    // 超出 MAX_AI_ITEMS 的仍用启发式（已在 merged）
    return {
      map: merged,
      source: aiHits > 0 ? 'ai' : 'heuristic',
      error: lastError || undefined,
      batches,
      aiCovered: aiQueue.length,
      skippedHeuristic: Math.max(0, list.length - aiQueue.length),
    };
  } catch (e) {
    return {
      map: merged,
      source: aiHits > 0 ? 'ai' : 'heuristic',
      error: e.message || String(e),
      batches,
    };
  }
}

/** 按推荐优先排序闲置列表 */
export function sortIdleByRecommendation(items, map = {}) {
  const list = Array.isArray(items) ? items.slice() : [];
  list.sort((a, b) => {
    const ar = map[a.id]?.recommend ? 1 : 0;
    const br = map[b.id]?.recommend ? 1 : 0;
    if (ar !== br) return br - ar;
    return (a.lastActivityAt || 0) - (b.lastActivityAt || 0);
  });
  return list;
}

export const IDLE_AI_BATCH_SIZE = BATCH_SIZE;
export const IDLE_AI_MAX_ITEMS = MAX_AI_ITEMS;
