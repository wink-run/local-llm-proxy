'use strict';

/** 出站 HTTP(S) 代理：与 local-gateway 一致（provider.proxy > network_proxy > 环境变量） */
let _HttpsProxyAgent = null;
let _getProxyForUrl = null;
try { _HttpsProxyAgent = require('https-proxy-agent').HttpsProxyAgent; } catch {}
try { _getProxyForUrl = require('proxy-from-env').getProxyForUrl; } catch {}

function resolveOutboundProxyAgent({ provider, urlStr, networkProxy } = {}) {
  if (!_HttpsProxyAgent) return undefined;
  let proxyUrl = provider && provider.proxy;
  if (!proxyUrl && networkProxy) proxyUrl = networkProxy;
  if (!proxyUrl && _getProxyForUrl && urlStr) {
    try { proxyUrl = _getProxyForUrl(urlStr); } catch {}
  }
  return proxyUrl ? new _HttpsProxyAgent(proxyUrl) : undefined;
}

module.exports = { resolveOutboundProxyAgent };
