// 流式文本片段合并：避免 token 增量 + 完整 assistant 快照重复展示
'use strict';

import {
  dedupeRepeatedText,
  normalizeLoose,
  splitInlineReasoning,
  looksLikeInlineReasoning,
  expandMixedOutputSteps,
  dedupeConsecutiveSteps,
  stripDuplicateThinkingPrefix,
  stripReasoningLeakage,
  looksLikeLeakedReasoning,
  repairThinkingOutputBoundary,
  sanitizeThinkingOutputPairs,
  hasClearReasoningBoundary,
  findUserFacingStart,
  isTruncatedThinking,
  joinThinkingOutput,
} from './inline-reasoning-split.js';

export {
  dedupeRepeatedText,
  splitInlineReasoning,
  looksLikeInlineReasoning,
  expandMixedOutputSteps,
  dedupeConsecutiveSteps,
  normalizeLoose,
  stripDuplicateThinkingPrefix,
  stripReasoningLeakage,
  looksLikeLeakedReasoning,
  repairThinkingOutputBoundary,
  sanitizeThinkingOutputPairs,
  hasClearReasoningBoundary,
  findUserFacingStart,
  isTruncatedThinking,
  joinThinkingOutput,
};

/**
 * @param {string} prev 已有文本
 * @param {string} next 新片段
 * @param {{ isDelta?: boolean, isSnapshot?: boolean }} [opts]
 */
export function mergeStreamText(prev, next, opts = {}) {
  const { isDelta = false, isSnapshot = false } = opts;
  let a = String(prev || '');
  let b = String(next || '');
  if (!b) return a;
  if (!a) return b;
  if (a === b) return a;
  if (b.startsWith(a)) return b;
  if (a.startsWith(b)) return a;
  if (b.includes(a)) return b;
  if (a.includes(b)) return a;

  // 快照优先：避免 delta 与完整 assistant 消息简单拼接造成重复
  if (isSnapshot && !isDelta) {
    const looseA = normalizeLoose(a);
    const looseB = normalizeLoose(b);
    if (looseB.includes(looseA)) return b;
    if (looseA.includes(looseB)) return a;
    return b.length >= a.length ? b : a;
  }

  if (isDelta) return dedupeRepeatedText(a + b);
  return dedupeRepeatedText(a + b);
}

/** 折叠步骤列表为单一文本 */
export function foldStreamSteps(steps) {
  if (!steps?.length) return '';
  return steps.reduce(
    (acc, s) => mergeStreamText(acc, s?.content, {
      isDelta: !!s?.is_delta,
      isSnapshot: !!s?.is_snapshot,
    }),
    '',
  );
}
