// client/electron/cli-endpoint-config.js
// CLI「兼容端点实例」的 settings.json 托管。
//
// 背景：claude 合并 env 是 {...process.env, ...settings.env} —— settings.json 的 env 永远
// 压过 shim 注入。若某实例 CONFIG_DIR/settings.json 里写死了自定义 ANTHROPIC_BASE_URL
// (私有兼容端点，如 forti-coder)，shim 就改不动它到网关。此时唯一出路是改写 settings.json 本身：
//   选路由(hosted 且有 route) → env.ANTHROPIC_BASE_URL=网关、ANTHROPIC_AUTH_TOKEN=本实例 api_key
//      (路由交给网关 keyScene)，去掉写死的 model 提示；原始配置备份到 .tokenbank-bak。
//   直连/还原(无 route / forceDirect) → 从 .tokenbank-bak 还原原始(兼容端点)配置。
// OAuth 实例(settings.json 无自定义 base_url) → 不碰，shim 自己就能托管。
// 「已托管」靠 base_url 是否指向本机网关判定，不往 settings.json 塞外来标记键。
'use strict';

const fs = require('fs');
const path = require('path');

function isGatewayBaseUrl(u) {
  return /(?:127\.0\.0\.1|localhost):11430/.test(String(u || ''));
}
function readJsonSafe(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; }
}

/**
 * 同步单个兼容端点实例的 settings.json。
 * @param app  应用记录（需 link_method==='shim' + instance.config_dir + api_key + hosted + route_id/route_ids）
 * @param opts { expandHome:(p)=>string, gatewayOrigin:string, forceDirect?:boolean }
 * @returns 'routed' | 'direct' | 'skip'（便于测试与日志）
 */
function syncCliInstanceEndpointConfig(app, opts = {}) {
  if (!app || app.link_method !== 'shim' || !app.instance || !app.instance.config_dir) return 'skip';
  const expandHome = opts.expandHome || ((p) => p);
  const dir = expandHome(String(app.instance.config_dir));
  const file = path.join(dir, 'settings.json');
  const bak = file + '.tokenbank-bak';

  // 原始配置来源：优先「未托管」的 .tokenbank-bak；否则当前 settings.json（若它自身还没被托管）。
  const curObj = fs.existsSync(file) ? readJsonSafe(file) : null;
  const curManaged = isGatewayBaseUrl(curObj && curObj.env && curObj.env.ANTHROPIC_BASE_URL);
  const bakObj = fs.existsSync(bak) ? readJsonSafe(bak) : null;
  const bakManaged = isGatewayBaseUrl(bakObj && bakObj.env && bakObj.env.ANTHROPIC_BASE_URL);
  const orig = (bakObj && !bakManaged) ? bakObj : (curObj && !curManaged ? curObj : null);
  const origBase = (orig && orig.env && orig.env.ANTHROPIC_BASE_URL) || '';

  // 判定兼容端点：原始配置里写死了「非网关」的 base_url。否则（OAuth / 无 base_url）不接管。
  if (!origBase || isGatewayBaseUrl(origBase)) {
    // 若历史上误托管过该 OAuth 实例，用备份还原回去，避免残留网关配置
    if (curManaged && bakObj && !bakManaged) { try { fs.copyFileSync(bak, file); } catch {} }
    return 'skip';
  }

  const routed = !opts.forceDirect
    && !!app.hosted && !!(app.route_id || (Array.isArray(app.route_ids) && app.route_ids.length));

  if (routed) {
    // 备份原始（仅首次；当前文件若已是托管配置则不备份，避免把网关配置存成 bak）
    if (curObj && !curManaged && !fs.existsSync(bak)) { try { fs.copyFileSync(file, bak); } catch {} }
    const next = { ...(orig || {}) };
    // 托管路由：整个 env 段替换成「只有网关这两项」，不保留原兼容端点 env 里的任何键
    // （尤其写死的 ANTHROPIC_MODEL / ANTHROPIC_DEFAULT_*_MODEL / SMALL_FAST_MODEL 等，会泄漏到
    // 网关变成上游不认的模型名；路由一律交给网关 keyScene）。原始整份已备份 .tokenbank-bak，还原时整份恢复。
    next.env = { ANTHROPIC_BASE_URL: opts.gatewayOrigin || 'http://127.0.0.1:11430' };
    if (app.api_key) next.env.ANTHROPIC_AUTH_TOKEN = app.api_key;
    delete next.model;   // 顶层写死的 model 也去掉
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(file, JSON.stringify(next, null, 2), 'utf8');
    return 'routed';
  }
  // 直连/还原：还原原始（兼容端点）配置
  if (bakObj && !bakManaged) { try { fs.copyFileSync(bak, file); } catch {} }
  return 'direct';
}

module.exports = { syncCliInstanceEndpointConfig, isGatewayBaseUrl, readJsonSafe };
