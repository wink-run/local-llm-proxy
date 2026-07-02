/** 与 server/credit_pricing.py 默认消费率对齐 */
export const DEFAULT_CONSUME_RATE = 5;
export const DEFAULT_CNY_PER_MILLION = 5;

/** Token 大数展示 */
export function fmtContribTokens(n) {
  const v = Number(n) || 0;
  if (v >= 1_000_000) return (v / 1_000_000).toFixed(1).replace(/\.0$/, '') + 'M';
  if (v >= 1000) return (v / 1000).toFixed(1).replace(/\.0$/, '') + 'K';
  return v.toLocaleString();
}

/** 积分 → 人民币（与 server/credit_pricing.credits_to_cny 一致） */
export function creditsToCny(credits, consumeRate = DEFAULT_CONSUME_RATE) {
  const rate = consumeRate > 0 ? consumeRate : DEFAULT_CONSUME_RATE;
  return (Number(credits) || 0) * DEFAULT_CNY_PER_MILLION / (1000 * rate);
}

/** 积分折算人民币展示 */
export function fmtCreditCny(cny) {
  const v = Number(cny) || 0;
  if (v <= 0) return '¥0';
  if (v < 0.01) return `¥${v.toFixed(4)}`;
  if (v < 1) return `¥${v.toFixed(3)}`;
  if (v < 100) return `¥${v.toFixed(2)}`;
  return `¥${v.toFixed(1)}`;
}
