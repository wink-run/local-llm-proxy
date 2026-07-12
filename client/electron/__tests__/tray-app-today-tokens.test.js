'use strict';

const assert = require('assert');

/** 与 main.js fmtTrayTokens 保持一致 */
function fmtTrayTokens(n) {
  n = n || 0;
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}K`;
  return String(n);
}

/** 与 tray-popover.html appsSignature 字段对齐（含今日 token） */
function appsSignature(apps) {
  return (apps || []).map((a) =>
    [a.id, a.name, a.routeLabel, a.ttftLabel, a.speedBucket, a.statusLabel, a.viaGateway ? 1 : 0, a.iconUrl || '', a.todayTokensLabel || '0', a.todayCalls || 0].join('\t')
  ).join('\n');
}

/**
 * 与 main.js trayAppDataSources 对齐的纯函数版本：
 * 直连应用无 api_key 命中时，靠 linked_data_sources / session 源计入用量。
 */
function resolveTrayDataSources(app, ent, caps) {
  const usageImport = !!(
    app.session_usage_import
    ?? caps?.session_usage_import
    ?? ent?.session_usage_import
  );
  if (!usageImport) return { dataSources: [], usageImport: false };
  if (Array.isArray(app.linked_data_sources) && app.linked_data_sources.length) {
    return { dataSources: app.linked_data_sources, usageImport: true };
  }
  if (Array.isArray(ent?.linked_data_sources) && ent.linked_data_sources.length) {
    return { dataSources: ent.linked_data_sources, usageImport: true };
  }
  return { dataSources: [], usageImport: true };
}

/** 与 getActiveAppsForTray 去重规则一致 */
function dedupeTrayApps(items) {
  const LINK_PRI = { 'api-key': 3, manual: 3, shim: 2, session: 1, direct: 1 };
  const bestByAgent = new Map();
  const noAgent = [];
  for (const item of items) {
    const aid = item.agentId;
    if (!aid) { noAgent.push(item); continue; }
    const pri = LINK_PRI[item.linkMethod] || (item.viaGateway ? 3 : 0);
    const cur = bestByAgent.get(aid);
    if (!cur) {
      bestByAgent.set(aid, item);
      continue;
    }
    const curPri = LINK_PRI[cur.linkMethod] || (cur.viaGateway ? 3 : 0);
    if (pri > curPri
      || (pri === curPri && item.viaGateway && !cur.viaGateway)
      || (pri === curPri && item.viaGateway === cur.viaGateway && item.todayTokens > cur.todayTokens)) {
      bestByAgent.set(aid, item);
    }
  }
  return [...noAgent, ...bestByAgent.values()];
}

assert.equal(fmtTrayTokens(0), '0');
assert.equal(fmtTrayTokens(999), '999');
assert.equal(fmtTrayTokens(1500), '1.5K');
assert.equal(fmtTrayTokens(1_200_000), '1.2M');

const a = {
  id: '1', name: 'Claude', routeLabel: 'm1', ttftLabel: 'TTFT 10ms',
  speedBucket: 'fast', statusLabel: '经网关', viaGateway: true, iconUrl: '',
  todayTokensLabel: '1.5K', todayCalls: 3,
};
const b = { ...a, todayTokensLabel: '2.0K', todayCalls: 4 };
assert.notEqual(appsSignature([a]), appsSignature([b]), 'token 变化应触发列表刷新');
assert.equal(appsSignature([a]), appsSignature([{ ...a }]), '同值签名应稳定');

const direct = resolveTrayDataSources(
  { id: 'app-cursor', link_method: 'direct' },
  { linked_data_sources: ['session-cursor'], session_usage_import: true },
  { session_usage_import: true },
);
assert.deepEqual(direct.dataSources, ['session-cursor']);
assert.equal(direct.usageImport, true);

const desktop = resolveTrayDataSources(
  { id: 'app-codex', preset_id: 'codex-desktop' },
  { linked_data_sources: ['session-codex'], session_usage_import: true },
  { session_usage_import: true },
);
assert.deepEqual(desktop.dataSources, ['session-codex']);

const noImport = resolveTrayDataSources(
  { id: 'app-x' },
  { linked_data_sources: ['session-x'], session_usage_import: false },
  { session_usage_import: false },
);
assert.deepEqual(noImport.dataSources, []);
assert.equal(noImport.usageImport, false);

// WorkBuddy：经网关 + 直连两条 → 只保留 api-key 经网关
const wbDup = dedupeTrayApps([
  {
    id: 'app-wb-gw', name: 'WorkBuddy', agentId: 'workbuddy', linkMethod: 'api-key',
    viaGateway: true, todayTokens: 0,
  },
  {
    id: 'app-wb-direct', name: 'WorkBuddy', agentId: 'workbuddy', linkMethod: 'direct',
    viaGateway: false, todayTokens: 100,
  },
]);
assert.equal(wbDup.length, 1);
assert.equal(wbDup[0].id, 'app-wb-gw');
assert.equal(wbDup[0].viaGateway, true);

console.log('tray-app-today-tokens.test.js OK');
