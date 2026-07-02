// 供给源账户配置指纹（浏览器 ESM）；Node 侧见 shared/account-config-fingerprint.js

const SENSITIVE_KEYS = new Set([
  'token', 'credentials', 'api_key', 'password', 'secret', 'refresh_token', 'access_token',
]);

/** 稳定 JSON（键排序） */
export function stableStringify(value) {
  if (value == null) return 'null';
  if (typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map(k => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(',')}}`;
}

/** 纯 JS MD5（Node / 浏览器通用） */
export function md5hex(input) {
  const str = String(input);
  function cmn(q, a, b, x, s, t) {
    a = (a + q + x + t) | 0;
    return (((a << s) | (a >>> (32 - s))) + b) | 0;
  }
  function ff(a, b, c, d, x, s, t) { return cmn((b & c) | (~b & d), a, b, x, s, t); }
  function gg(a, b, c, d, x, s, t) { return cmn((b & d) | (c & ~d), a, b, x, s, t); }
  function hh(a, b, c, d, x, s, t) { return cmn(b ^ c ^ d, a, b, x, s, t); }
  function ii(a, b, c, d, x, s, t) { return cmn(c ^ (b | ~d), a, b, x, s, t); }

  const bytes = [];
  for (let i = 0; i < str.length; i++) {
    const c = str.charCodeAt(i);
    if (c < 128) bytes.push(c);
    else if (c < 2048) { bytes.push((c >> 6) | 192, (c & 63) | 128); }
    else { bytes.push((c >> 12) | 224, ((c >> 6) & 63) | 128, (c & 63) | 128); }
  }
  const bitLen = bytes.length * 8;
  bytes.push(0x80);
  while (bytes.length % 64 !== 56) bytes.push(0);
  for (let i = 0; i < 4; i++) bytes.push((bitLen >>> (i * 8)) & 255);

  let a0 = 0x67452301; let b0 = 0xefcdab89; let c0 = 0x98badcfe; let d0 = 0x10325476;
  for (let i = 0; i < bytes.length; i += 64) {
    const w = new Array(16);
    for (let j = 0; j < 16; j++) {
      w[j] = bytes[i + j * 4] | (bytes[i + j * 4 + 1] << 8) | (bytes[i + j * 4 + 2] << 16) | (bytes[i + j * 4 + 3] << 24);
    }
    let a = a0; let b = b0; let c = c0; let d = d0;
    a = ff(a, b, c, d, w[0], 7, -680876936); d = ff(d, a, b, c, w[1], 12, -389564586);
    c = ff(c, d, a, b, w[2], 17, 606105819); b = ff(b, c, d, a, w[3], 22, -1044525330);
    a = ff(a, b, c, d, w[4], 7, -176418897); d = ff(d, a, b, c, w[5], 12, 1200080426);
    c = ff(c, d, a, b, w[6], 17, -1473231341); b = ff(b, c, d, a, w[7], 22, -45705983);
    a = ff(a, b, c, d, w[8], 7, 1770035416); d = ff(d, a, b, c, w[9], 12, -1958414417);
    c = ff(c, d, a, b, w[10], 17, -42063); b = ff(b, c, d, a, w[11], 22, -1990404162);
    a = ff(a, b, c, d, w[12], 7, 1804603682); d = ff(d, a, b, c, w[13], 12, -40341101);
    c = ff(c, d, a, b, w[14], 17, -1502002290); b = ff(b, c, d, a, w[15], 22, 1236535329);
    a = gg(a, b, c, d, w[1], 5, -165796510); d = gg(d, a, b, c, w[6], 9, -1069501632);
    c = gg(c, d, a, b, w[11], 14, 643717713); b = gg(b, c, d, a, w[0], 20, -373897302);
    a = gg(a, b, c, d, w[5], 5, -701558691); d = gg(d, a, b, c, w[10], 9, 38016083);
    c = gg(c, d, a, b, w[15], 14, -660478335); b = gg(b, c, d, a, w[4], 20, -405537848);
    a = gg(a, b, c, d, w[9], 5, 568446438); d = gg(d, a, b, c, w[14], 9, -1019803690);
    c = gg(c, d, a, b, w[3], 14, -187363961); b = gg(b, c, d, a, w[8], 20, 1163531501);
    a = gg(a, b, c, d, w[13], 5, -1444681467); d = gg(d, a, b, c, w[2], 9, -51403784);
    c = gg(c, d, a, b, w[7], 14, 1735328473); b = gg(b, c, d, a, w[12], 20, -1926607734);
    a = hh(a, b, c, d, w[5], 4, -378558); d = hh(d, a, b, c, w[8], 11, -2022574463);
    c = hh(c, d, a, b, w[11], 16, 1839030562); b = hh(b, c, d, a, w[14], 23, -35309556);
    a = hh(a, b, c, d, w[1], 4, -1530992060); d = hh(d, a, b, c, w[4], 11, 1272893353);
    c = hh(c, d, a, b, w[7], 16, -155497632); b = hh(b, c, d, a, w[10], 23, -1094730640);
    a = hh(a, b, c, d, w[13], 4, 681279174); d = hh(d, a, b, c, w[0], 11, -358537222);
    c = hh(c, d, a, b, w[3], 16, -722521979); b = hh(b, c, d, a, w[6], 23, 76029189);
    a = hh(a, b, c, d, w[9], 4, -640364487); d = hh(d, a, b, c, w[12], 11, -421815835);
    c = hh(c, d, a, b, w[15], 16, 530742520); b = hh(b, c, d, a, w[2], 23, -995338651);
    a = ii(a, b, c, d, w[0], 6, -198630844); d = ii(d, a, b, c, w[7], 10, 1126891415);
    c = ii(c, d, a, b, w[14], 15, -1416354905); b = ii(b, c, d, a, w[5], 21, -57434055);
    a = ii(a, b, c, d, w[12], 6, 1700485571); d = ii(d, a, b, c, w[3], 10, -1894986606);
    c = ii(c, d, a, b, w[10], 15, -1051523); b = ii(b, c, d, a, w[1], 21, -2054922799);
    a = ii(a, b, c, d, w[8], 6, 1873313359); d = ii(d, a, b, c, w[15], 10, -30611744);
    c = ii(c, d, a, b, w[6], 15, -1560198380); b = ii(b, c, d, a, w[13], 21, 1309151649);
    a = ii(a, b, c, d, w[4], 6, -145523070); d = ii(d, a, b, c, w[11], 10, -1120210379);
    c = ii(c, d, a, b, w[2], 15, 718787259); b = ii(b, c, d, a, w[9], 21, -343485551);
    a0 = (a0 + a) | 0; b0 = (b0 + b) | 0; c0 = (c0 + c) | 0; d0 = (d0 + d) | 0;
  }
  const toHex = n => ((n >>> 0).toString(16).padStart(8, '0'));
  return (toHex(a0) + toHex(b0) + toHex(c0) + toHex(d0));
}

function modelNamesFromEntry(entry) {
  const names = [];
  for (const m of entry?.models || []) {
    const n = typeof m === 'string' ? m.trim() : String(m?.name || m?.id || '').trim();
    if (n && n !== '_excluded_models' && n !== 'excluded_models') names.push(n);
  }
  return names.sort();
}

function secretFingerprints(obj) {
  if (!obj || typeof obj !== 'object') return [];
  const fps = [];
  for (const k of SENSITIVE_KEYS) {
    const v = obj[k];
    if (v == null || v === '') continue;
    fps.push(md5hex(typeof v === 'object' ? stableStringify(v) : String(v)));
  }
  return fps.sort();
}

function fingerprintPayload(payload) {
  return md5hex(stableStringify(payload));
}

export function fingerprintSubscription(sub) {
  const payload = {
    t: 'sub',
    source_id: sub?.source_id || '',
    plan_provider_id: sub?.plan_provider_id || '',
    plan_id: sub?.plan_id || '',
    subscription_kind: sub?.subscription_kind || 'app',
    subscription_to_api: !!sub?.subscription_to_api,
    monthly_usd: sub?.monthly_usd != null && sub?.monthly_usd !== '' ? Number(sub.monthly_usd) : null,
    custom: !!sub?.custom,
    models: modelNamesFromEntry(sub),
    secrets: secretFingerprints(sub),
  };
  return fingerprintPayload(payload);
}

export function fingerprintPayg(p) {
  const payload = {
    t: 'payg',
    provider_id: p?.provider_id || '',
    custom: !!p?.custom,
    label: p?.custom ? (p?.label || p?.name || '') : '',
    models: modelNamesFromEntry(p),
    secrets: secretFingerprints(p),
  };
  return fingerprintPayload(payload);
}

export function fingerprintDirect(agentId, billing) {
  const b = billing || {};
  const payload = {
    t: 'direct',
    agent_id: agentId || '',
    source_id: b.source_id || agentId || '',
    mode: b.mode === 'api' ? 'api' : 'subscription',
    monthly_usd: b.monthly_usd != null && b.monthly_usd !== '' ? Number(b.monthly_usd) : null,
    models: modelNamesFromEntry(b),
    secrets: secretFingerprints(b),
  };
  return fingerprintPayload(payload);
}

/** 合并同 config_fp 的多设备登记（保留 device 列表） */
export function dedupeByConfigFp(items) {
  const map = new Map();
  for (const item of items || []) {
    const fp = item.config_fp || item.id || item.source_id || item.provider_id || '';
    if (!fp) continue;
    const prev = map.get(fp);
    if (!prev) {
      map.set(fp, {
        ...item,
        device_ids: item.device_id ? [item.device_id] : [],
        device_labels: item.device_label ? [item.device_label] : [],
      });
      continue;
    }
    if (item.device_id && !prev.device_ids.includes(item.device_id)) {
      prev.device_ids.push(item.device_id);
      if (item.device_label) prev.device_labels.push(item.device_label);
    }
  }
  return [...map.values()];
}
