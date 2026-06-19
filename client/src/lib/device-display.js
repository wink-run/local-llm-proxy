/** 个人页设备列表：标题与副标题格式化（兼容旧 MacIntel / hostname.local 数据） */

const TYPE_LABEL = { desktop: '桌面版', cli: '命令行版' };

function stripLocalSuffix(name) {
  return String(name || '').trim().replace(/\.local$/i, '');
}

/** 旧版 navigator.platform 等无效平台字符串 → 可读文案 */
export function formatLegacyPlatform(platform) {
  if (!platform) return '';
  const p = String(platform).trim();
  if (p === 'MacIntel' || p === 'MacPPC') return 'macOS';
  if (p === 'Win32') return 'Windows';
  if (/^darwin\//i.test(p)) return p.replace(/^darwin\//i, 'macOS ');
  return p;
}

/** 设备主标题：优先可读名称，去掉 .local */
export function formatDeviceTitle(device) {
  const raw = device?.name || device?.device_id || '';
  return stripLocalSuffix(raw) || raw;
}

/** 设备副标题：类型 · 版本 · 平台 */
export function formatDeviceSubtitle(device, { lastSeen } = {}) {
  const parts = [];
  const typeLabel = TYPE_LABEL[device?.type] || device?.type;
  if (typeLabel) parts.push(typeLabel);
  if (device?.version) parts.push(`v${device.version}`);
  const plat = formatLegacyPlatform(device?.platform);
  if (plat) parts.push(plat);
  if (lastSeen) parts.push(lastSeen);
  return parts.join(' · ');
}
