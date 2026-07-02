// 服务端 UTC 时间 → 浏览器本地时区（与 client/src/lib/datetime.js 逻辑一致）
(function (global) {
  function parseServerTime(iso) {
    if (!iso) return null;
    var s = String(iso).trim();
    if (!/[zZ]$/.test(s) && !/[+-]\d{2}:\d{2}$/.test(s)) {
      if (s.indexOf('T') < 0) s = s.replace(' ', 'T');
      if (!/[zZ]$/.test(s)) s += 'Z';
    }
    var d = new Date(s);
    return isNaN(d.getTime()) ? null : d;
  }

  /** locale 省略时用浏览器默认；展示时刻始终为用户本机时区 */
  function formatServerTime(iso, locale, options) {
    var d = parseServerTime(iso);
    if (!d) return iso ? String(iso) : '—';
    var fmt = Object.assign({
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }, options || {});
    return d.toLocaleString(locale, fmt);
  }

  global.parseServerTime = parseServerTime;
  global.formatServerTime = formatServerTime;
})(typeof window !== 'undefined' ? window : globalThis);
