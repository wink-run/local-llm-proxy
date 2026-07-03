// 社区分享网络（tokenbank-p2p）开关 — Node 侧与 gatewayModels.isCommunityP2pEnabled 保持一致
'use strict';

function isCommunityP2pEnabled(cfg) {
  const p = (cfg?.providers || []).find(x => x.id === 'tokenbank-p2p' || x.type === 'p2p');
  if (!p) return true;
  return p.enabled !== false;
}

module.exports = { isCommunityP2pEnabled };
