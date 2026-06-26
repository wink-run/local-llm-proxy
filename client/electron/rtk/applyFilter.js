'use strict';
function safeApply(fn, text) {
  if (typeof fn !== 'function') return text;
  try {
    const out = fn(text);
    if (typeof out !== 'string' || out.length === 0) return text;
    return out;
  } catch (err) {
    const name = fn.filterName || fn.name || 'anonymous';
    console.warn(`[rtk] filter '${name}' error — passthrough: ${err && err.message}`);
    return text;
  }
}
module.exports = { safeApply };
