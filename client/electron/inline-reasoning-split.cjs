// CJS sync copy
// 从混在一起的 assistant 文本中拆分内部推理与用户可见回复
// 参考 Anthropic stream-json：thinking 块(thinking_delta) 与 text 块(text_delta) 分离

const REASONING_START = /^(The user (is|has|just|wants|said|asked|mentioned|is just|is saying)|I'll respond|I should (respond|reply|answer|keep|provide|be|not)|This is (a |an )?(simple|straightforward|basic|quick|casual)|No need for any)/i;

const REASONING_MARKERS = /\b(CLAUDE\.md|without any fluff|simple greeting|casual greeting|as per (their|the|user)|I should respond|match their tone|match their language|respond in (Chinese|English|briefly)|concise(?:ly)? without|No need for any tools)/i;

const REASONING_BOUNDARY = /(?:instructions\.?|without any fluff\.?|simple greeting\.?|complex responses\.?|CLAUDE\.md instructions\.?)(?=[\u4e00-\u9fffA-Z「"'(!?]|$)/i;

const EN_REPLY_START = /^(Hi|Hello|Hey|Sure|OK|Yes|No)\b/i;

/** 英文 meta 片段（含 thinking 截断后的续写） */
const REASONING_META = /\b(The user|which means|Let me (?:write|respond|help|create)|I'll (?:write|respond|help)|in Chinese|in English|write a (?:poem|short)|for them|for the user|I should|They said|asking me to)\b/i;

function hasReasoningMeta(text) {
  return REASONING_META.test(String(text || ''));
}

function normalizeLoose(s) {
  return String(s).replace(/\s+/g, ' ').replace(/[.,!?;:]/g, '').trim().toLowerCase();
}

function looksLikeInlineReasoning(text) {
  const t = String(text || '').trim();
  if (!t || t.length < 20) return false;
  return REASONING_START.test(t)
    || (REASONING_MARKERS.test(t) && /The user\b|I'll respond|No need for/i.test(t));
}

function dedupeRepeatedText(text) {
  let raw = String(text || '');
  if (raw.length < 30) return raw;

  if (/^The user\b/i.test(raw)) {
    const second = raw.indexOf('The user', 10);
    if (second > 20) {
      const first = raw.slice(0, second).trim();
      const rest = raw.slice(second).trim();
      if (normalizeLoose(first) === normalizeLoose(rest)) return first;
      if (normalizeLoose(rest).startsWith(normalizeLoose(first))) {
        return dedupeRepeatedText(rest);
      }
    }
  }

  const half = Math.floor(raw.length / 2);
  const a = raw.slice(0, half);
  const b = raw.slice(half);
  if (a === b || normalizeLoose(a) === normalizeLoose(b)) return a;
  if (b.startsWith(a) || normalizeLoose(b).startsWith(normalizeLoose(a))) return b;
  if (a.startsWith(b)) return a;

  return raw;
}

/** 输出中去掉与已有 thinking 重复的前缀（stream_event + assistant 快照重复时） */
function stripDuplicateThinkingPrefix(output, thinking) {
  let o = dedupeRepeatedText(String(output || '')).trim();
  const t = String(thinking || '').trim();
  if (!o || !t) return o;

  const looseO = normalizeLoose(o);
  const looseT = normalizeLoose(t);
  if (looseO.startsWith(looseT)) {
    o = o.slice(t.length).replace(/^[\s.]+/, '').trim();
  } else if (looksLikeInlineReasoning(o)) {
    const parts = splitInlineReasoning(o);
    const outputs = parts.filter(p => p.stepType === 'output').map(p => p.content).join('').trim();
    if (outputs) o = outputs;
  }

  return o;
}

/** 定位用户可见回复的起点（跳过 thinking 续写 / 英文 meta） */
function findUserFacingStart(text) {
  const raw = String(text || '');
  if (!raw) return 0;

  const metaThenCjk = raw.match(
    /(?:which means[^.]*\.|Let me (?:write|respond|help|create)[^.]*\.|I'll (?:write|respond|help)[^.]*\.|in Chinese\.|for them\.|for the user\.|a poem for them\.|a short poem for them\.)\s*(?=[\u4e00-\u9fff《「])/i,
  );
  if (metaThenCjk) return metaThenCjk.index + metaThenCjk[0].length;

  const cjk = raw.search(/[\u4e00-\u9fff《「]/);
  if (cjk > 6) {
    const prefix = raw.slice(0, cjk);
    if (REASONING_META.test(prefix)) return cjk;
  }

  return 0;
}

/** output 含推理泄漏（含 thinking 在句中被截断后的续写） */
function looksLikeLeakedReasoning(text) {
  const t = String(text || '').trim();
  if (!t) return false;
  if (looksLikeInlineReasoning(t)) return true;
  return hasReasoningMeta(t) && findUserFacingStart(t) > 0;
}

/** 结合已有 thinking，剥离 output 中所有推理泄漏 */
function stripReasoningLeakage(output, thinking) {
  let o = dedupeRepeatedText(String(output || '')).trim();
  const t = String(thinking || '').trim();
  if (!o) return o;

  if (t) o = stripDuplicateThinkingPrefix(o, t);

  const thinkingIncomplete = !t || /["'`]\s*$|\bsaid\s+"?$|They said\s+"?$/i.test(t) || /\b(to|me to)\s+\w+\.\s*They\b/i.test(t);
  const start = findUserFacingStart(o);
  if (start > 0 && (thinkingIncomplete || hasReasoningMeta(o.slice(0, start)))) {
    o = o.slice(start).trim();
  }

  return o;
}

/**
 * 修复 thinking 末尾与 output 开头之间的 Markdown/书名号截断
 * 例：think="…fresh one.** 《" + out="无题》 **\n诗…" → "**《无题》**\n诗…"
 */
function repairThinkingOutputBoundary(thinking, output) {
  let t = String(thinking || '').trim();
  let o = String(output || '').trim();
  if (!t || !o) return { thinking: t, output: o };

  const tailOpen = t.match(/^(.*?)(\*\*\s*[《「]?)\s*$/)
    || t.match(/^(.*?)(\*\s*[《「]?)\s*$/);
  if (tailOpen) {
    const [, english, openFrag] = tailOpen;
    const closeMatch = o.match(/^([^》\n]+》)\s*(\*{1,2})\s*([\s\S]*)$/);
    if (closeMatch && /[\u4e00-\u9fff]/.test(closeMatch[1])) {
      const titleInner = closeMatch[1].replace(/》$/, '');
      const rest = closeMatch[3] || '';
      const openBracket = openFrag.includes('《') ? '《' : openFrag.includes('「') ? '「' : '《';
      o = `**${openBracket}${titleInner}》**${rest.startsWith('\n') ? rest : (rest ? `\n${rest}` : '')}`;
      t = english.trim();
      return { thinking: t, output: o.trim() };
    }
    if (/[》」]/.test(o)) {
      t = english.trim();
      o = openFrag.replace(/\s/g, '') + o;
      return { thinking: t, output: o };
    }
  }

  // thinking 不应以 markdown/书名号碎片结尾
  if (/(\*{1,2}\s*[《「]?)\s*$/.test(t)) {
    t = t.replace(/(\*{1,2}\s*[《「]?)\s*$/, '').trim();
  }

  return { thinking: t, output: o };
}

/** 逐步修复相邻 thinking → output 边界 */
function sanitizeThinkingOutputPairs(steps) {
  if (!steps?.length) return steps;
  const out = steps.map(s => ({ ...s }));
  for (let i = 0; i < out.length - 1; i++) {
    if (out[i].stepType !== 'thinking' || out[i + 1].stepType !== 'output') continue;
    const repaired = repairThinkingOutputBoundary(out[i].content, out[i + 1].content);
    out[i] = { ...out[i], content: repaired.thinking };
    out[i + 1] = { ...out[i + 1], content: repaired.output };
  }
  return out;
}

function splitAtUserFacingBoundary(text) {
  const raw = String(text || '').trim();
  if (!looksLikeInlineReasoning(raw)) return null;

  const cjkIdx = raw.search(/[\u4e00-\u9fff]/);
  if (cjkIdx > 15) {
    const thinking = raw.slice(0, cjkIdx).replace(/[.\s]+$/, '').trim();
    const output = raw.slice(cjkIdx).trim();
    if (thinking && output) {
      return [
        { stepType: 'thinking', content: thinking },
        { stepType: 'output', content: output },
      ];
    }
  }

  const enMatch = raw.match(
    /^((?:The user|I'll respond|I should|No need for)[\s\S]{8,}?)(?<=[.!?])\s*((?:Hi|Hello|Hey|Sure|OK|Yes|No)\b[\s\S]*)$/i,
  );
  if (enMatch) {
    const thinking = enMatch[1].trim();
    const output = enMatch[2].trim();
    if (thinking && output) {
      return [{ stepType: 'thinking', content: thinking }, { stepType: 'output', content: output }];
    }
  }

  // 无标点直接拼接："...complex responsesHi"
  const tight = raw.match(
    /^((?:The user|I'll respond|I should|No need for)[\s\S]*?(?:responses|language|tone|briefly|concisely))((?:Hi|Hello|Hey)\b[\s\S]*)$/i,
  );
  if (tight) {
    return [
      { stepType: 'thinking', content: tight[1].trim() },
      { stepType: 'output', content: tight[2].trim() },
    ];
  }

  return null;
}

function splitInlineReasoning(text) {
  let raw = dedupeRepeatedText(String(text || '')).trim();
  if (!raw) return [];

  if (!looksLikeInlineReasoning(raw)) {
    return [{ stepType: 'output', content: raw }];
  }

  const atBoundary = splitAtUserFacingBoundary(raw);
  if (atBoundary) {
    const out = [];
    for (const part of atBoundary) {
      if (part.stepType === 'output' && looksLikeInlineReasoning(part.content)) {
        out.push(...splitInlineReasoning(part.content));
      } else {
        out.push(part);
      }
    }
    return out;
  }

  const steps = [];
  let remaining = raw;
  let guard = 0;

  while (remaining && looksLikeInlineReasoning(remaining) && guard++ < 4) {
    const m = remaining.match(REASONING_BOUNDARY);
    if (!m) break;
    const cut = m.index + m[0].length;
    const thinking = remaining.slice(0, cut).trim();
    remaining = remaining.slice(cut).trim();
    if (thinking) steps.push({ stepType: 'thinking', content: thinking });
  }

  remaining = dedupeRepeatedText(remaining).trim();
  if (remaining) {
    if (looksLikeInlineReasoning(remaining) && !/[\u4e00-\u9fff]/.test(remaining) && !EN_REPLY_START.test(remaining)) {
      steps.push({ stepType: 'thinking', content: remaining });
    } else {
      steps.push({ stepType: 'output', content: remaining });
    }
  }

  return steps.length ? steps : [{ stepType: 'thinking', content: raw }];
}

function expandMixedOutputSteps(steps) {
  if (!steps?.length) return steps;
  const out = [];
  for (const s of steps) {
    if (s.stepType === 'output' && s.content && looksLikeInlineReasoning(s.content)) {
      for (const part of splitInlineReasoning(s.content)) {
        out.push({ ...s, stepType: part.stepType, content: part.content });
      }
    } else {
      out.push(s);
    }
  }
  return dedupeConsecutiveSteps(out);
}

function dedupeConsecutiveSteps(steps) {
  if (!steps?.length) return steps;
  const out = [];
  for (const s of steps) {
    const last = out[out.length - 1];
    const type = s.stepType || 'output';
    if (last && last.stepType === type && (type === 'thinking' || type === 'output')) {
      if (normalizeLoose(last.content) === normalizeLoose(s.content)) continue;
      const merged = String(s.content).startsWith(last.content) ? s.content : last.content + s.content;
      if (normalizeLoose(merged) === normalizeLoose(last.content)) continue;
      out[out.length - 1] = { ...last, ...s, content: merged };
    } else {
      out.push(s);
    }
  }
  return out;
}

module.exports = { normalizeLoose, looksLikeInlineReasoning, looksLikeLeakedReasoning, hasReasoningMeta, findUserFacingStart, dedupeRepeatedText, stripDuplicateThinkingPrefix, stripReasoningLeakage, repairThinkingOutputBoundary, sanitizeThinkingOutputPairs, splitInlineReasoning, expandMixedOutputSteps, dedupeConsecutiveSteps };
