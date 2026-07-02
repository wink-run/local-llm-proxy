/** 将服务端时间串解析为 Date（SQLite datetime('now') 为 UTC，无时区后缀补 Z） */
export function parseServerTime(iso) {
  if (!iso) return null;
  let s = String(iso).trim();
  if (!/[zZ]$/.test(s) && !/[+-]\d{2}:\d{2}$/.test(s)) {
    if (!s.includes('T')) s = s.replace(' ', 'T');
    if (!/[zZ]$/.test(s)) s += 'Z';
  }
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * 服务端 UTC 时间 → 用户本机时区展示（toLocaleString 自动用浏览器时区与 locale）
 * @param {string} iso
 * @param {{ locale?: string }} [opts] 不传 locale 则跟随浏览器语言
 */
export function formatServerTime(iso, opts = {}) {
  const d = parseServerTime(iso);
  if (!d) return iso ? String(iso) : '—';
  const { locale, ...rest } = opts;
  return d.toLocaleString(locale, {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    ...rest,
  });
}
