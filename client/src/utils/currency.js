/** 内部结算货币为 USD；展示层按用户设置换算 */
export const DEFAULT_USD_CNY_RATE = 7;

export function defaultCurrencyForLang(lang) {
  return lang === 'en' ? 'USD' : 'CNY';
}

/** USD 金额 → 展示货币数值 */
export function usdToDisplayAmount(usd, currency = 'USD', rate = DEFAULT_USD_CNY_RATE) {
  const v = Number(usd);
  if (!Number.isFinite(v)) return 0;
  if (currency === 'CNY') return v * (Number(rate) || DEFAULT_USD_CNY_RATE);
  return v;
}

/**
 * 格式化 USD 内部金额为用户所选货币
 * @param {number} usd 内部美元金额
 * @param {'USD'|'CNY'} currency
 * @param {number} rate 1 USD = rate CNY
 */
export function fmtCostFromUsd(usd, currency = 'USD', rate = DEFAULT_USD_CNY_RATE) {
  const v = Number(usd);
  if (!Number.isFinite(v) || v <= 0) return '—';

  if (currency === 'CNY') {
    const cny = v * (Number(rate) || DEFAULT_USD_CNY_RATE);
    if (cny < 0.01) return `¥${cny.toFixed(4)}`;
    if (cny < 1) return `¥${cny.toFixed(3)}`;
    if (cny < 100) return `¥${cny.toFixed(2)}`;
    return `¥${cny.toFixed(2)}`;
  }

  if (v < 0.01) return `$${v.toFixed(4)}`;
  if (v < 1) return `$${v.toFixed(3)}`;
  return `$${v.toFixed(2)}`;
}

/** 无费用时返回 null（供条件渲染） */
export function fmtCostOptionalFromUsd(usd, currency = 'USD', rate = DEFAULT_USD_CNY_RATE) {
  const v = Number(usd);
  if (!Number.isFinite(v) || v <= 0) return null;
  return fmtCostFromUsd(v, currency, rate);
}
