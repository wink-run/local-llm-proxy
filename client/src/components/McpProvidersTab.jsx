import React, { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import ServiceIcon from './ServiceIcon';
import { resolveBrandIcon } from '../lib/brandIcons';
import { useLang } from '../store/lang';

const SUPPLY_TAB_KEY = 'tokenbank.providers.supplyTab';
const MCP_VIEW_TAB_KEY = 'tokenbank.providers.mcpViewTab';
const MCP_AGENT_TAB_KEY = 'tokenbank.providers.mcpAgentTab';

/** 目录分组 id → i18n key（无词条时回退后端 label） */
function localizeGroupLabel(group, t) {
  if (!group?.id) return group?.label || '';
  const key = `providers.mcp.group.${group.id}`;
  const v = t(key);
  return v === key ? (group.label || group.id) : v;
}

/** 目录项描述：按 catalogId 取词条 */
function localizeCatalogDesc(item, t) {
  const id = item?.catalogId || item?.id || item?.name;
  if (!id) return item?.description || '';
  const key = `providers.mcp.catalog.${id}.desc`;
  const v = t(key);
  return v === key ? (item?.description || '') : v;
}

/** 中文标签 → slug（品牌名保持原样） */
const MCP_TAG_SLUG = {
  内置: 'builtin',
  编排: 'orchestrate',
  提示词: 'prompt',
  官方: 'official',
  文件: 'file',
  记忆: 'memory',
  推理: 'reasoning',
  演示: 'demo',
  代码: 'code',
  搜索: 'search',
  抓取: 'fetch',
  网页: 'web',
  地图: 'maps',
  文档: 'docs',
  浏览器: 'browser',
  协作: 'collab',
  笔记: 'notes',
  监控: 'monitor',
  缓存: 'cache',
};

function localizeCatalogTag(tag, t) {
  const slug = MCP_TAG_SLUG[tag];
  if (!slug) return tag;
  const key = `providers.mcp.tag.${slug}`;
  const v = t(key);
  return v === key ? tag : v;
}

/** 纳管表单字段 label */
function localizeFieldLabel(field, t) {
  if (!field?.key) return field?.label || '';
  const key = `providers.mcp.field.${field.key}`;
  const v = t(key);
  return v === key ? (field.label || field.key) : v;
}

/** URL 型：远程 HTTP / SSE；否则为 CLI（stdio command） */
function isMcpUrlServer(s) {
  if (!s) return false;
  return !!(s.url || s.type === 'sse' || s.type === 'http');
}

const EMPTY_CUSTOM_FORM = {
  name: '',
  display_name: '',
  type: 'stdio', // stdio=CLI，http=URL
  command: 'npx',
  args: '-y mcp-fetch-server',
  url: '',
  headersText: '{}',
};

function readMcpAgentTab() {
  try {
    const v = localStorage.getItem(MCP_AGENT_TAB_KEY);
    return v && v !== 'all' ? v : '';
  } catch { return ''; }
}

function saveMcpAgentTab(tab) {
  try { localStorage.setItem(MCP_AGENT_TAB_KEY, tab); } catch {}
}

function readMcpViewTab() {
  try {
    const v = localStorage.getItem(MCP_VIEW_TAB_KEY);
    // 已安装 / 已纳管合并为「已纳管」（与 Skill 一致）
    if (v === 'catalog') return 'catalog';
    return 'managed';
  } catch { return 'managed'; }
}

function saveMcpViewTab(tab) {
  try { localStorage.setItem(MCP_VIEW_TAB_KEY, tab); } catch {}
}

/** Providers 页 MCP 工具 Tab */
export default function McpProvidersTab() {
  const { t } = useLang();
  const [catalog, setCatalog] = useState([]);
  const [catalogGroups, setCatalogGroups] = useState([]);
  const [catalogFilter, setCatalogFilter] = useState('');
  const [mcpViewTab, setMcpViewTab] = useState(() => readMcpViewTab());
  const [servers, setServers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState('');
  const [installTarget, setInstallTarget] = useState(null);
  const [installConfig, setInstallConfig] = useState({});
  const [showCustom, setShowCustom] = useState(false);
  const [customForm, setCustomForm] = useState(() => ({ ...EMPTY_CUSTOM_FORM }));
  /** 点击标题编辑已纳管 MCP */
  const [editServer, setEditServer] = useState(null);
  const [syncStatus, setSyncStatus] = useState(null);
  const [syncMsg, setSyncMsg] = useState('');
  const [agentTab, setAgentTab] = useState(() => readMcpAgentTab());
  const [syncMenuOpen, setSyncMenuOpen] = useState(false);
  const [syncMenuPos, setSyncMenuPos] = useState(null);
  /** null=批量安装菜单，string=单行 MCP id */
  const [installMenuServerId, setInstallMenuServerId] = useState(null);
  const [syncSelectedIds, setSyncSelectedIds] = useState([]);
  // 菜单模式：project=写盘投射；relay=中转绑定（分按钮入口）
  const [syncMenuMode, setSyncMenuMode] = useState('project');
  const [selectedServerIds, setSelectedServerIds] = useState([]);
  const syncProjectBtnRef = useRef(null);
  const syncRelayBtnRef = useRef(null);
  const syncMenuRef = useRef(null);
  /** 编辑弹窗内容区：打开时滚回顶部 */
  const editPanelRef = useRef(null);
  /** 内置 MCP 网关状态（URL / token / 已路由列表） */
  const [gatewayInfo, setGatewayInfo] = useState(null);
  const [gatewayCopyMsg, setGatewayCopyMsg] = useState('');
  /** 网关按应用隔离：当前编辑/复制的目标应用 id */
  const [gatewayProfileId, setGatewayProfileId] = useState('api');
  /** Gateway API 应用（与 apps:list 同源，避免下拉漏项） */
  const [gatewayApiApps, setGatewayApiApps] = useState([]);
  /** Gateway 应用全量（与「应用」页 apps:list 同源，供顶部筛选对齐已纳管） */
  const [gatewayApps, setGatewayApps] = useState([]);

  // 主栏有 backdrop-filter 时 fixed 会相对主栏定位；弹窗挂到 body 并复位滚动
  useEffect(() => {
    if (!editServer) return undefined;
    const id = requestAnimationFrame(() => {
      if (editPanelRef.current) editPanelRef.current.scrollTop = 0;
    });
    return () => cancelAnimationFrame(id);
  }, [editServer]);

  const loadAll = useCallback(async (opts = {}) => {
    if (!window.electronAPI?.mcp) {
      setLoading(false);
      return;
    }
    const silent = !!opts.silent;
    // silent：投射等操作后局部刷新，不整页进入 loading
    if (!silent) setLoading(true);
    setError('');
    // apps:list 很重：与 MCP 并行拉，但不参与首屏 loading 门闩
    const appsPromise = window.electronAPI.apps?.list?.() || Promise.resolve([]);
    try {
      // 目录多为本地 yaml，先返回以尽快结束「加载中」；servers/sync 含扫盘+安装探测更慢
      const catRes = await window.electronAPI.mcp.listCatalog();
      if (catRes.success) {
        setCatalog(catRes.catalog || []);
        setCatalogGroups(catRes.grouped || []);
      } else {
        setError(catRes.error || t('providers.mcp.loadCatalogFailed'));
      }
      if (!silent) setLoading(false);

      const [srvRes, syncRes, gwRes] = await Promise.all([
        window.electronAPI.mcp.listServers(),
        window.electronAPI.mcp.getSyncStatus(),
        window.electronAPI.mcp.getGatewayInfo?.() || Promise.resolve(null),
      ]);
      if (srvRes.success) setServers(srvRes.servers || []);
      if (syncRes.success) setSyncStatus(syncRes);
      if (gwRes?.success) setGatewayInfo(gwRes);
      else if (gwRes && gwRes.success === false) setGatewayInfo(null);
    } catch (e) {
      setError(e.message);
      if (!silent) setLoading(false);
    }

    // 补齐 Gateway 纳管应用（筛选 / 投射列表）；失败不影响已展示的 MCP
    try {
      const appsList = await appsPromise;
      const rows = Array.isArray(appsList) ? appsList : [];
      setGatewayApps(rows.filter((a) => a && !a.draft));
      setGatewayApiApps(
        rows
          .filter((a) => a && !a.draft && !a._virtual_apikey && a.link_method === 'manual')
          .filter((a) => typeof a.id === 'string')
          .map((a) => ({
            id: a.id,
            label: a.name || a.id,
            kind: 'api-app',
            link_method: a.link_method,
          })),
      );
    } catch {
      /* ignore */
    }
  }, [t]);

  useEffect(() => { loadAll(); }, [loadAll]);

  /**
   * 与 Gateway 应用表「状态」列一致：已纳管 / API 在线 → true；未纳管 → false。
   * 见 Gateway.jsx 行内 isManaged 计算。
   */
  function isGatewayAppManaged(app) {
    if (!app || app.draft) return false;
    const keyApp = app.link_method === 'api-key' || app.link_method === 'manual';
    const isCfgApp = keyApp && app.host_method === 'config-file';
    const isDirectOnly = app.link_method === 'direct';
    const isSessionApp = app.link_method === 'session';
    const hostable = app.link_method === 'shim' || isCfgApp || isDirectOnly;
    const tracked = app.hosted === true && !app.needs_dev_mode;
    if (isSessionApp) return tracked;
    if (hostable) return tracked;
    return keyApp && !app._virtual_apikey;
  }

  // 投射/中转桌面列表：与顶部筛选同源（Gateway 已纳管，不含 API）
  // syncClientId：实际写盘目标（codex-desktop→codex，claude-desktop→claude-code）
  const MCP_SYNC_ID_ALIAS = {
    'codex-desktop': 'codex',
    'claude-desktop': 'claude-code',
  };
  // 与 CLI 复用写盘：投射列表不单独展示（选 Claude Code 即覆盖 Desktop）
  const MCP_PROJECT_LIST_HIDDEN = new Set(['claude-desktop']);
  function resolveSyncWriteId(filterId) {
    const cand = MCP_SYNC_ID_ALIAS[filterId] || filterId;
    const t = (syncStatus?.targets || []).find((x) => x.id === cand && x.syncEnabled !== false);
    return t ? t.id : null;
  }
  function expandClientMatchIds(filterId) {
    const ids = new Set([filterId]);
    const syncId = resolveSyncWriteId(filterId) || MCP_SYNC_ID_ALIAS[filterId];
    if (syncId) ids.add(syncId);
    for (const [from, to] of Object.entries(MCP_SYNC_ID_ALIAS)) {
      if (from === filterId || to === filterId || from === syncId || to === syncId) {
        ids.add(from);
        ids.add(to);
      }
    }
    return ids;
  }

  const syncWritableAgents = (() => {
    const items = [];
    const seen = new Set();
    for (const app of gatewayApps) {
      if (!isGatewayAppManaged(app) || app.link_method === 'manual') continue;
      const id = app.agent_id || app.preset_id || app.id;
      if (!id || seen.has(id)) continue;
      // Claude Desktop 不单独展示，与 Claude Code 复用
      if (MCP_PROJECT_LIST_HIDDEN.has(id)) continue;
      seen.add(id);
      const syncClientId = resolveSyncWriteId(id);
      items.push({
        id,
        label: app.name || id,
        syncClientId,
        projectable: !!syncClientId,
        installed: true,
        appId: app.id,
      });
    }
    return items;
  })();

  // 当前筛选目标须落在 Gateway「已纳管/在线」列表；尚未拉到 apps 时不误清
  useEffect(() => {
    if (!agentTab) return;
    if (gatewayApps.length === 0 && gatewayApiApps.length === 0) return;
    const managedIds = new Set();
    for (const app of gatewayApps) {
      if (!isGatewayAppManaged(app)) continue;
      if (app.link_method === 'manual' && app.id) managedIds.add(app.id);
      else {
        const aid = app.agent_id || app.preset_id || app.id;
        if (aid) managedIds.add(aid);
        if (app.id) managedIds.add(app.id);
        // Desktop 隐藏项：映射到复用的 CLI id，避免旧筛选态被清掉后空白
        const aliased = MCP_SYNC_ID_ALIAS[aid];
        if (aliased) managedIds.add(aliased);
      }
    }
    for (const a of gatewayApiApps) if (a?.id) managedIds.add(a.id);
    // 旧态若停在 claude-desktop，自动切到 claude-code
    if (MCP_PROJECT_LIST_HIDDEN.has(agentTab)) {
      const next = MCP_SYNC_ID_ALIAS[agentTab] || '';
      setAgentTab(next);
      saveMcpAgentTab(next);
      return;
    }
    if (managedIds.has(agentTab)) return;
    setAgentTab('');
    saveMcpAgentTab('');
  }, [agentTab, gatewayApps, gatewayApiApps]);

  /** 可加入网关代理：已启用、stdio、非 Bridge */
  function canRouteViaGateway(s) {
    if (!s || s.status !== 'active') return false;
    if (s.id === 'tokenbank-agent-bridge') return false;
    if (isMcpUrlServer(s)) return false;
    return !!s.command;
  }

  /** Token Bank 内置 MCP（可进「通用」中转档；不含 Bridge） */
  function isTbBuiltinRelayMcp(s) {
    if (!s) return false;
    return s.id === 'tokenbank-prompts'
      || s.id === 'tokenbank-models'
      || s.id === 'tokenbank-resources';
  }

  /** 网关目标：通用 api + 已纳管桌面/CLI + Gateway「API 应用」 */
  function gatewayProfileOptions() {
    const seen = new Set();
    const opts = [];
    const push = (id, label, kind) => {
      if (!id || seen.has(id)) return;
      seen.add(id);
      opts.push({
        id,
        label: id === 'api' ? t('providers.mcp.gatewayProfileApi') : (label || id),
        kind: kind || (String(id).startsWith('app-') ? 'api-app' : 'agent'),
      });
    };
    push('api', t('providers.mcp.gatewayProfileApi'), 'generic');
    // 仅已纳管且可写盘的应用（不含未安装 / OpenClaw 等）
    for (const a of syncWritableAgents) {
      push(a.id, a.label || a.id, 'agent');
    }
    for (const t of gatewayInfo?.bindTargets || gatewayInfo?.profiles || []) {
      if (!t?.id || t.id === 'api') continue;
      // Agent 类已由 syncWritableAgents 覆盖；此处只补 API 应用等
      if (t.kind === 'agent') continue;
      push(t.id, t.label, t.kind);
    }
    // 与 Gateway 页 apps:list 同源，确保「New app」等可见
    for (const a of gatewayApiApps) {
      push(a.id, a.label, 'api-app');
    }
    for (const a of gatewayInfo?.apiApps || []) {
      push(a.id, a.label, 'api-app');
    }
    return opts;
  }

  function serverGatewayClients(server) {
    return Array.isArray(server?.gateway_clients) ? server.gateway_clients : [];
  }

  function isGatewayBoundToProfile(server, profileId = gatewayProfileId) {
    return serverGatewayClients(server).includes(profileId);
  }

  /** 当前操作的网关应用：优先顶部筛选 Agent，否则用面板所选 */
  function activeGatewayProfileId() {
    if (agentTab) return agentTab;
    return gatewayProfileId || 'api';
  }

  async function bulkSetGateway(enabled, explicitServerIds) {
    let ids = [...new Set((explicitServerIds || selectedServerIds).filter(Boolean))];
    if (!ids.length) {
      alert(t('providers.mcp.gatewaySelectStdio'));
      return;
    }
    const profileId = activeGatewayProfileId();
    if (!profileId) {
      alert(t('providers.mcp.gatewayNeedApp'));
      return;
    }
    // 通用档：只允许绑定 Token Bank 内置 MCP
    if (enabled && profileId === 'api') {
      const before = ids.length;
      ids = ids.filter((id) => isTbBuiltinRelayMcp(servers.find((s) => s.id === id)));
      if (!ids.length) {
        alert(t('providers.mcp.gatewayGenericBuiltinOnly'));
        return;
      }
      if (ids.length < before && !explicitServerIds) {
        // 勾选了非内置时：仅加入内置，并提示
        alert(t('providers.mcp.gatewayGenericBuiltinOnly'));
      }
    }
    const api = window.electronAPI?.mcp?.setServersGatewayRouted;
    if (typeof api !== 'function') {
      alert(t('providers.mcp.gatewayApiMissing'));
      return;
    }
    setBusy('gateway');
    try {
      const res = await api({
        serverIds: ids,
        enabled,
        clientIds: [profileId],
      });
      if (!res?.success) {
        alert(res?.error || t('providers.mcp.gatewayToggleFailed'));
        return;
      }
      // 用返回结果立刻刷新本地列表，避免再读到旧数据
      const patched = new Map();
      for (const r of res.results || []) {
        if (r?.server?.id) patched.set(r.server.id, r.server);
      }
      if (patched.size) {
        setServers((prev) => prev.map((s) => patched.get(s.id) || s));
      }
      const boundN = [...patched.values()].filter((s) => (
        Array.isArray(s.gateway_clients) && s.gateway_clients.includes(profileId)
      )).length;
      if (enabled && boundN === 0 && !(res.ok > 0)) {
        alert(t('providers.mcp.gatewayToggleFailed') + (res.error ? `: ${res.error}` : ''));
        return;
      }
      setSelectedServerIds([]);
      // 先刷新再弹结果
      await loadAll({ silent: true });
      if (res.failed > 0) {
        alert(t('providers.mcp.gatewayPartialFail', { ok: res.ok || 0, fail: res.failed }));
      } else if (enabled) {
        const appLabel = gatewayProfileOptions().find((o) => o.id === profileId)?.label || profileId;
        alert(t('providers.mcp.gatewayBoundOk', { n: res.ok || boundN || ids.length, app: appLabel }));
      }
    } catch (e) {
      alert(e.message || t('providers.mcp.gatewayToggleFailed'));
    } finally {
      setBusy('');
    }
  }

  async function copyGatewayConfig() {
    const profileId = activeGatewayProfileId();
    const profile = (gatewayInfo?.profiles || []).find((p) => p.id === profileId);
    const cfg = profile?.configJson
      || (gatewayInfo?.endpoint
        ? {
          mcpServers: {
            'tokenbank-relay': {
              url: `${String(gatewayInfo.endpoint.url || '').replace(/\/mcp\/?$/, '')}/mcp/${profileId}`,
              headers: { Authorization: `Bearer ${gatewayInfo.endpoint.token}` },
            },
          },
        }
        : null);
    const text = cfg ? JSON.stringify(cfg, null, 2) : '';
    if (!text || !gatewayInfo?.endpoint?.token) {
      alert(t('providers.mcp.gatewayNotReady'));
      return;
    }
    try {
      await navigator.clipboard.writeText(text);
      setGatewayCopyMsg(t('providers.mcp.gatewayCopied'));
      setTimeout(() => setGatewayCopyMsg(''), 2000);
    } catch {
      alert(t('providers.mcp.gatewayCopyFailed'));
    }
  }

  function renderGatewayPanel() {
    const profileId = activeGatewayProfileId();
    const profileOpts = gatewayProfileOptions();
    const profile = (gatewayInfo?.profiles || []).find((p) => p.id === profileId);
    const url = profile?.url
      || (gatewayInfo?.endpoint?.url
        ? `${String(gatewayInfo.endpoint.url).replace(/\/mcp\/?$/, '')}/mcp/${profileId}`
        : '');
    const boundServers = servers.filter((s) => isGatewayBoundToProfile(s, profileId));
    const n = boundServers.length;
    const isApiProfile = profileOpts.find((o) => o.id === profileId)?.kind === 'api-app'
      || String(profileId).startsWith('app-');

    const profileSelect = (
      <select
        value={agentTab || gatewayProfileId}
        disabled={!!agentTab}
        onChange={(e) => setGatewayProfileId(e.target.value)}
        className="text-[11px] px-2 py-1 rounded-lg border border-zinc-200 dark:border-zinc-600 bg-white/70 dark:bg-zinc-800/70 text-zinc-700 dark:text-zinc-200 disabled:opacity-60 max-w-[11rem]"
        title={agentTab ? t('providers.mcp.gatewayFollowFilter') : t('providers.mcp.gatewayHint')}
      >
        {(() => {
          const generic = profileOpts.filter((o) => o.kind === 'generic' || o.id === 'api');
          const agents = profileOpts.filter((o) => o.kind === 'agent');
          const apiApps = profileOpts.filter((o) => o.kind === 'api-app');
          const rest = profileOpts.filter((o) => (
            !generic.includes(o) && !agents.includes(o) && !apiApps.includes(o)
          ));
          return (
            <>
              {generic.map((o) => (
                <option key={o.id} value={o.id}>{o.label}</option>
              ))}
              {agents.length > 0 && (
                <optgroup label={t('providers.mcp.gatewayGroupAgents')}>
                  {agents.map((o) => (
                    <option key={o.id} value={o.id}>{o.label}</option>
                  ))}
                </optgroup>
              )}
              <optgroup label={t('providers.mcp.gatewayGroupApiApps')}>
                {apiApps.length > 0
                  ? apiApps.map((o) => (
                    <option key={o.id} value={o.id}>{o.label}</option>
                  ))
                  : (
                    <option value="__no_api_apps__" disabled>
                      {t('providers.mcp.gatewayNoApiApps')}
                    </option>
                  )}
              </optgroup>
              {rest.map((o) => (
                <option key={o.id} value={o.id}>{o.label}</option>
              ))}
            </>
          );
        })()}
      </select>
    );

    return (
      <div className="tb-soft-card rounded-xl px-3 py-2 space-y-1.5" title={t('providers.mcp.gatewayHint')}>
        {/* 第 1 行：标题 + 状态 */}
        <div className="flex items-center gap-2 min-h-[1.25rem]">
          <span className="text-xs font-semibold text-zinc-800 dark:text-zinc-100 shrink-0">
            {t('providers.mcp.gatewayTitle')}
          </span>
          <span className={`text-[10px] px-1.5 py-0.5 rounded-md shrink-0 ${
            gatewayInfo?.running
              ? 'bg-emerald-50 dark:bg-emerald-900/30 text-emerald-700 dark:text-emerald-300'
              : 'bg-zinc-100 dark:bg-zinc-800 text-zinc-500'
          }`}>
            {gatewayInfo?.running ? t('providers.mcp.gatewayRunning') : t('providers.mcp.gatewayStopped')}
          </span>
          <span className="text-[10px] text-zinc-400 truncate min-w-0">
            {t('providers.mcp.gatewayHint')}
          </span>
        </div>

        {/* 第 2 行：接入应用 + URL + 操作 */}
        <div className="flex items-center gap-2 min-h-[1.75rem]">
          <span className="text-[11px] text-zinc-500 shrink-0">{t('providers.mcp.gatewayBindApp')}</span>
          {profileSelect}
          {url && (
            <code className="text-[10px] font-mono text-zinc-500 dark:text-zinc-400 truncate min-w-0 flex-1" title={url}>
              {url}
            </code>
          )}
          <div className="flex items-center gap-1 shrink-0 ml-auto">
            {(() => {
              const isGeneric = profileId === 'api';
              // 通用档：一键只绑内置；API 应用：空档时一键绑全部可中转 stdio
              const bindIds = isGeneric
                ? servers.filter((s) => canRouteViaGateway(s) && isTbBuiltinRelayMcp(s)
                  && !isGatewayBoundToProfile(s, 'api')).map((s) => s.id)
                : (isApiProfile && n === 0
                  ? servers.filter((s) => canRouteViaGateway(s)).map((s) => s.id)
                  : []);
              if (!bindIds.length) return null;
              return (
                <button
                  type="button"
                  disabled={!!busy}
                  onClick={() => bulkSetGateway(true, bindIds)}
                  className="tb-press text-[11px] px-2 py-1 rounded-lg border border-amber-300/80 text-amber-800 dark:text-amber-200 disabled:opacity-40"
                >
                  {isGeneric
                    ? t('providers.mcp.gatewayBindBuiltin')
                    : t('providers.mcp.gatewayBindAllStdio')}
                </button>
              );
            })()}
            <button
              type="button"
              disabled={!gatewayInfo?.endpoint?.token || !!busy}
              onClick={copyGatewayConfig}
              className="tb-press text-[11px] px-2.5 py-1 rounded-lg bg-violet-600 text-white hover:bg-violet-500 disabled:opacity-40"
            >
              {gatewayCopyMsg || t('providers.mcp.gatewayCopyJson')}
            </button>
          </div>
        </div>

        {/* 第 3 行：已绑定芯片 */}
        <div className="flex items-center gap-1.5 min-h-[1.5rem] overflow-hidden">
          <span className="text-[10px] text-zinc-400 shrink-0 whitespace-nowrap">
            {t('providers.mcp.gatewayBoundListTitle')}
            <span className="tabular-nums ml-1">{n}</span>
          </span>
          {n === 0 ? (
            <span className="text-[10px] text-zinc-400 truncate">{t('providers.mcp.gatewayBoundListEmpty')}</span>
          ) : (
            <div className="flex flex-wrap gap-1 min-w-0 flex-1 content-center">
              {boundServers.map((s) => (
                <span
                  key={s.id}
                  className="tb-tag tb-tag-blue !rounded-full pl-2 pr-0.5 py-0.5 text-[10px] max-w-full"
                  title={s.display_name || s.name}
                >
                  <span className="truncate max-w-[7.5rem]">{s.display_name || s.name}</span>
                  <button
                    type="button"
                    disabled={!!busy}
                    onClick={() => bulkSetGateway(false, [s.id])}
                    title={t('providers.mcp.gatewayRemoveOneHint', { name: s.display_name || s.name })}
                    aria-label={t('providers.mcp.gatewayRemoveOneHint', { name: s.display_name || s.name })}
                    className="tb-press ml-0.5 w-4 h-4 inline-flex items-center justify-center rounded-full text-current/55 hover:text-red-500 hover:bg-black/5 dark:hover:bg-white/10 disabled:opacity-40"
                  >
                    ×
                  </button>
                </span>
              ))}
            </div>
          )}
        </div>
      </div>
    );
  }

  /** 可勾选同步的 MCP（已启用、非 Bridge） */
  const syncSelectableServers = servers.filter(
    s => s.status === 'active' && s.id !== 'tokenbank-agent-bridge',
  );
  const selectedSyncableIds = selectedServerIds.filter(id =>
    syncSelectableServers.some(s => s.id === id),
  );
  const allSyncSelectableChecked = syncSelectableServers.length > 0
    && syncSelectableServers.every(s => selectedServerIds.includes(s.id));

  function toggleServerSelected(serverId) {
    setSelectedServerIds(prev => (
      prev.includes(serverId) ? prev.filter(id => id !== serverId) : [...prev, serverId]
    ));
  }

  function toggleSelectAllServers() {
    if (allSyncSelectableChecked) {
      setSelectedServerIds([]);
    } else {
      setSelectedServerIds(syncSelectableServers.map(s => s.id));
    }
  }

  const closeSyncMenu = useCallback(() => {
    setSyncMenuOpen(false);
    setSyncMenuPos(null);
    setInstallMenuServerId(null);
  }, []);

  useEffect(() => {
    if (!syncMenuOpen) return;
    const onDoc = (e) => {
      const t = e.target;
      if (syncMenuRef.current?.contains(t)) return;
      if (syncProjectBtnRef.current?.contains(t) || syncRelayBtnRef.current?.contains(t)) return;
      if (t.closest?.('[data-row-install-btn]')) return;
      closeSyncMenu();
    };
    // 页面或任意外层滚动时关闭浮窗（菜单内部滚动除外）
    const onScroll = (e) => {
      if (syncMenuRef.current?.contains(e.target)) return;
      closeSyncMenu();
    };
    document.addEventListener('mousedown', onDoc);
    window.addEventListener('scroll', onScroll, true);
    return () => {
      document.removeEventListener('mousedown', onDoc);
      window.removeEventListener('scroll', onScroll, true);
    };
  }, [syncMenuOpen, closeSyncMenu]);

  function openInstallMenu({ serverId = null, anchorEl, selectedAgentIds, mode = 'project' }) {
    if (syncMenuOpen && installMenuServerId === serverId && syncMenuMode === mode) {
      closeSyncMenu();
      return;
    }
    setInstallMenuServerId(serverId);
    setSyncMenuMode(mode === 'relay' ? 'relay' : 'project');
    setSyncSelectedIds(selectedAgentIds);
    if (anchorEl) {
      const r = anchorEl.getBoundingClientRect();
      const menuW = 256;
      const spaceBelow = window.innerHeight - r.bottom - 8;
      const spaceAbove = r.top - 8;
      // 下方空间不足时向上展开，避免被视口裁切
      const openUp = spaceBelow < 240 && spaceAbove > spaceBelow;
      const maxH = Math.min(400, Math.max(180, openUp ? spaceAbove : spaceBelow));
      const left = Math.min(Math.max(8, r.right - menuW), window.innerWidth - menuW - 8);
      setSyncMenuPos({
        top: openUp ? null : r.bottom + 4,
        bottom: openUp ? window.innerHeight - r.top + 4 : null,
        left,
        maxH,
      });
    }
    setSyncMenuOpen(true);
  }

  function openSyncMenu(mode, anchorEl) {
    // 批量：投射仅可写盘纳管应用；中转默认勾选当前档 API（若有）+ 全部纳管桌面
    const profileId = activeGatewayProfileId();
    const apiDefault = gatewayApiApps.some((a) => a.id === profileId) ? [profileId] : [];
    const projectableIds = syncWritableAgents.filter((t) => t.projectable).map((t) => t.id);
    const selected = mode === 'relay'
      ? [...apiDefault, ...syncWritableAgents.map((t) => t.id)]
      : projectableIds;
    openInstallMenu({
      serverId: null,
      anchorEl,
      selectedAgentIds: selected,
      mode,
    });
  }

  function openRowInstallMenu(server, e, mode = 'project') {
    if (server.status !== 'active') return;
    let defaults;
    if (mode === 'relay') {
      const fromGateway = getGatewayBoundRelayIds(server);
      defaults = fromGateway.length
        ? fromGateway
        : [...gatewayApiApps.map((a) => a.id), ...syncWritableAgents.map((t) => t.id)];
    } else {
      const installed = getInstalledAgentIds(server);
      const projectableIds = syncWritableAgents.filter((t) => t.projectable).map((t) => t.id);
      defaults = installed.length ? installed : projectableIds;
    }
    openInstallMenu({
      serverId: server.id,
      anchorEl: e.currentTarget,
      selectedAgentIds: defaults,
      mode,
    });
  }

  function toggleSyncSelected(id) {
    const isApi = gatewayApiApps.some((a) => a.id === id);
    const agent = syncWritableAgents.find((t) => t.id === id);
    if (!isApi && !agent) return;
    // 投射菜单：不可写盘的纳管应用不可勾选
    if (syncMenuMode === 'project' && agent && !agent.projectable) return;
    setSyncSelectedIds(prev => (
      prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id]
    ));
  }

  /** 收集某 MCP 当前已投射到的纳管应用（返回筛选同源 id） */
  function getInstalledAgentIds(server) {
    if (!server) return [];
    const ids = new Set();
    const hitIds = new Set();
    for (const c of server.clientTargets || []) {
      if (c.installed) hitIds.add(c.id);
    }
    for (const id of server.sync_clients || []) hitIds.add(id);

    for (const agent of syncWritableAgents) {
      const match = expandClientMatchIds(agent.id);
      if ([...hitIds].some((h) => match.has(h))) ids.add(agent.id);
    }
    return [...ids];
  }

  /** 某 MCP 已中转绑定的目标（API 应用 + 可写桌面/CLI；不含「通用」） */
  function getGatewayBoundRelayIds(server) {
    if (!server) return [];
    const clients = serverGatewayClients(server);
    const ids = [];
    for (const a of gatewayApiApps) {
      if (clients.includes(a.id)) ids.push(a.id);
    }
    for (const a of syncWritableAgents) {
      if (clients.includes(a.id)) ids.push(a.id);
    }
    return ids;
  }

  function relayTargetLabel(id) {
    return gatewayApiApps.find((a) => a.id === id)?.label
      || syncStatus?.targets?.find((t) => t.id === id)?.label
      || id;
  }

  async function handleSyncClients(clientIds) {
    const ids = Array.isArray(clientIds)
      ? clientIds
      : clientIds
        ? [clientIds]
        : syncWritableAgents.map(t => t.id);
    const singleId = installMenuServerId;
    const serverIds = singleId ? [singleId] : selectedSyncableIds;
    if (!serverIds.length) {
      alert(singleId ? t('providers.mcp.cannotInstall') : t('providers.mcp.selectMcpFirst'));
      return;
    }

    const apiIds = ids.filter((id) => gatewayApiApps.some((a) => a.id === id));
    const syncDoProject = syncMenuMode === 'project';
    const syncDoRelay = syncMenuMode === 'relay';
    // 投射：筛选用 id → 写盘 syncClientId（跳过暂不支持写盘的项）
    const agentIds = syncDoProject
      ? [...new Set(
        ids
          .map((id) => syncWritableAgents.find((a) => a.id === id))
          .filter((a) => a?.projectable && a.syncClientId)
          .map((a) => a.syncClientId),
      )]
      : ids.filter((id) => syncWritableAgents.some((a) => a.id === id));
    // 中转入口：桌面+API；投射入口：不写中转（API 不应出现在投射列表）
    const relayIds = syncDoRelay
      ? [...new Set([...apiIds, ...agentIds])]
      : [];

    const singleServer = singleId ? servers.find(s => s.id === singleId) : null;
    const singleName = singleServer?.display_name || singleServer?.name || null;
    const isWorkbuddyId = (id) => String(id || '').toLowerCase().includes('workbuddy');

    closeSyncMenu();
    setBusy(singleId || 'sync');
    setSyncMsg('');
    try {
      const parts = [];
      let projectedToWorkbuddy = false;

      // 中转绑定（仅「中转」入口）
      if (syncDoRelay && singleId) {
        const previouslyAll = getGatewayBoundRelayIds(singleServer);
        const toAdd = relayIds.filter((id) => !previouslyAll.includes(id));
        const toRemove = previouslyAll.filter((id) => !relayIds.includes(id));
        for (const appId of toAdd) {
          const r = await window.electronAPI.mcp.setServerGatewayRouted({
            serverId: singleId,
            enabled: true,
            clientIds: [appId],
          });
          if (!r?.success) throw new Error(r?.error || t('providers.mcp.gatewayToggleFailed'));
        }
        for (const appId of toRemove) {
          const r = await window.electronAPI.mcp.setServerGatewayRouted({
            serverId: singleId,
            enabled: false,
            clientIds: [appId],
          });
          if (!r?.success) throw new Error(r?.error || t('providers.mcp.gatewayToggleFailed'));
        }
        if (relayIds.length) {
          parts.push(t('providers.mcp.gatewayBoundTo', {
            agents: relayIds.map(relayTargetLabel).join('、'),
          }));
        }
        if (toRemove.length) {
          parts.push(t('providers.mcp.gatewayUnboundFrom', {
            agents: toRemove.map(relayTargetLabel).join('、'),
          }));
        }
      } else if (syncDoRelay && relayIds.length) {
        const r = await window.electronAPI.mcp.setServersGatewayRouted({
          serverIds,
          enabled: true,
          clientIds: relayIds,
        });
        if (!r?.success) throw new Error(r?.error || t('providers.mcp.gatewayToggleFailed'));
        parts.push(t('providers.mcp.gatewayBoundBatch', {
          n: serverIds.length,
          agents: relayIds.map(relayTargetLabel).join('、'),
        }));
      }

      // 桌面/CLI：写盘投射（仅「投射」入口）
      if (syncDoProject && (singleId || agentIds.length)) {
        let res;
        if (singleId) {
          const previously = getInstalledAgentIds(singleServer);
          const selected = agentIds;
          const affected = [...new Set([...previously, ...selected])];
          res = await window.electronAPI.mcp.setServerSyncClients({
            serverId: singleId,
            clientIds: selected,
            syncClientIds: affected,
          });
          const removed = previously.filter(id => !selected.includes(id));
          for (const clientId of removed) {
            try {
              await window.electronAPI.mcp.removeFromAgent({
                serverId: singleId,
                clientId,
              });
            } catch { /* ignore */ }
          }
          if (!res?.success) {
            throw new Error(res?.error || t('providers.mcp.installFailed'));
          }
          const addedLabels = selected
            .map(id => syncStatus?.targets?.find(t => t.id === id)?.label || id)
            .join('、');
          const removedLabels = removed
            .map(id => syncStatus?.targets?.find(t => t.id === id)?.label || id)
            .join('、');
          if (selected.length) parts.push(t('providers.mcp.installedTo', { agents: addedLabels }));
          if (removed.length) parts.push(t('providers.mcp.removedFrom', { agents: removedLabels }));
          if (selected.some(isWorkbuddyId)) projectedToWorkbuddy = true;
        } else if (agentIds.length) {
          res = await window.electronAPI.mcp.syncClients({ clientIds: agentIds, serverIds });
          if (!res?.success) {
            throw new Error(res?.error || t('providers.mcp.installFailed'));
          }
          const labels = agentIds
            .map(id => syncStatus?.targets?.find(t => t.id === id)?.label || id)
            .join('、');
          parts.push(res.hint || t('providers.mcp.installedBatch', { n: serverIds.length, agents: labels }));
          if (agentIds.some(isWorkbuddyId)) projectedToWorkbuddy = true;
        }
      }

      // 批量须至少选目标；单条空勾选可撤
      if (!singleId && !apiIds.length && !agentIds.length) {
        alert(t('providers.mcp.selectAgentFirst'));
        return;
      }

      // 含 API 应用时提醒：客户端须手工配置中转
      if (syncDoRelay && apiIds.length) {
        parts.push(t('providers.mcp.gatewayApiManualConfigHint'));
      }
      // WorkBuddy：写盘后还须在客户端「信任」自定义连接器
      if (projectedToWorkbuddy) {
        parts.push(t('providers.mcp.workbuddyTrustHint'));
      }
      if (!singleId) setSelectedServerIds([]);
      // 中转成功后同步下拉
      if (syncDoRelay && relayIds[0]) setGatewayProfileId(relayIds[0]);
      setSyncMsg('');
      // 先完成静默刷新，再弹结果（避免先提示后刷新）
      await loadAll({ silent: true });
      if (singleId) {
        if (!parts.length) parts.push(t('providers.mcp.notInstalledAny'));
        alert(`${singleName}：${parts.join('；')}`);
      } else {
        alert(parts.join('\n') || t('providers.mcp.installedBatch', { n: serverIds.length, agents: '' }));
      }
    } catch (e) {
      setSyncMsg(e.message);
      alert(e.message);
    } finally {
      setBusy('');
    }
  }

  function renderInstallAgentMenu() {
    if (!syncMenuOpen || !syncMenuPos) return null;
    const singleServer = installMenuServerId
      ? servers.find(s => s.id === installMenuServerId)
      : null;
    const isRelay = syncMenuMode === 'relay';
    // 勾选了 API 应用时展示手工配置提醒（仅中转菜单）
    const hasApiSelected = isRelay && syncSelectedIds.some((id) => gatewayApiApps.some((a) => a.id === id));
    const showApiApps = isRelay && gatewayApiApps.length > 0;
    return createPortal(
      <div
        ref={syncMenuRef}
        className="fixed z-[9999] w-64 flex flex-col rounded-xl border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-800 shadow-lg overflow-hidden"
        style={{
          ...(syncMenuPos.top != null ? { top: syncMenuPos.top } : {}),
          ...(syncMenuPos.bottom != null ? { bottom: syncMenuPos.bottom } : {}),
          left: syncMenuPos.left,
          maxHeight: syncMenuPos.maxH,
        }}
      >
        <div className="px-3 py-2 border-b border-zinc-100 dark:border-zinc-700 shrink-0">
          <p className="text-xs font-medium text-zinc-700 dark:text-zinc-200">
            {isRelay ? t('providers.mcp.pickRelayTitle') : t('providers.mcp.pickProjectTitle')}
          </p>
          <p className="text-[10px] text-zinc-400 mt-0.5">
            {singleServer
              ? (isRelay
                ? t('providers.mcp.relayHintSingle', { name: singleServer.display_name || singleServer.name })
                : t('providers.mcp.installHintSingle', { name: singleServer.display_name || singleServer.name }))
              : (isRelay
                ? t('providers.mcp.relayHintBatch', { n: selectedSyncableIds.length })
                : t('providers.mcp.installHintBatch', { n: selectedSyncableIds.length }))}
          </p>
        </div>
        <div className="py-1 min-h-0 flex-1 overflow-y-auto">
          {showApiApps && (
            <>
              <p className="px-3 pt-1.5 pb-0.5 text-[10px] text-zinc-400">{t('providers.mcp.gatewayGroupApiApps')}</p>
              {gatewayApiApps.map((app) => {
                const checked = syncSelectedIds.includes(app.id);
                return (
                  <label
                    key={app.id}
                    className={`flex items-center gap-2 px-3 py-2 text-xs cursor-pointer ${
                      checked ? 'bg-amber-50 dark:bg-amber-900/20' : 'hover:bg-zinc-50 dark:hover:bg-zinc-700/40'
                    }`}
                  >
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={() => toggleSyncSelected(app.id)}
                      className="rounded border-zinc-300 dark:border-zinc-600"
                    />
                    <ServiceIcon id={app.id} name={app.label} boxClass="w-6 h-6" imgClass="w-3.5 h-3.5" />
                    <span className="text-zinc-700 dark:text-zinc-200 flex-1 truncate" title={app.label}>{app.label}</span>
                    <span className="text-[9px] text-amber-600 dark:text-amber-400 shrink-0">{t('providers.mcp.gatewayApiAppTag')}</span>
                  </label>
                );
              })}
              {hasApiSelected && (
                <p className="px-3 pb-1.5 text-[10px] leading-snug text-amber-700 dark:text-amber-300/90">
                  {t('providers.mcp.gatewayApiManualConfigHint')}
                </p>
              )}
            </>
          )}
          {syncWritableAgents.length > 0 && (
            <p className="px-3 pt-1.5 pb-0.5 text-[10px] text-zinc-400">{t('providers.mcp.gatewayGroupAgents')}</p>
          )}
          {syncWritableAgents.length === 0 && !showApiApps ? (
            <p className="text-xs text-zinc-400 px-3 py-2">{t('providers.mcp.noAgents')}</p>
          ) : syncWritableAgents.map(agent => {
            const checked = syncSelectedIds.includes(agent.id);
            const blocked = !isRelay && !agent.projectable;
            return (
              <label
                key={agent.id}
                className={`flex items-center gap-2 px-3 py-2 text-xs ${
                  blocked
                    ? 'opacity-45 cursor-not-allowed'
                    : `cursor-pointer ${checked ? 'bg-violet-50 dark:bg-violet-900/20' : 'hover:bg-zinc-50 dark:hover:bg-zinc-700/40'}`
                }`}
                title={blocked ? t('providers.mcp.projectUnsupported') : undefined}
              >
                <input
                  type="checkbox"
                  checked={checked}
                  disabled={blocked}
                  onChange={() => toggleSyncSelected(agent.id)}
                  className="rounded border-zinc-300 dark:border-zinc-600"
                />
                <ServiceIcon id={agent.id} name={agent.label} boxClass="w-6 h-6" imgClass="w-3.5 h-3.5" />
                <span className="text-zinc-700 dark:text-zinc-200 flex-1 truncate" title={agent.label}>{agent.label}</span>
                {blocked && (
                  <span className="text-[9px] text-zinc-400 shrink-0">{t('providers.mcp.projectUnsupportedTag')}</span>
                )}
              </label>
            );
          })}
        </div>
        <div className="flex items-center justify-between gap-2 px-3 py-2 border-t border-zinc-100 dark:border-zinc-700 bg-zinc-50/80 dark:bg-zinc-900/40 shrink-0">
          {(() => {
            const allIds = isRelay
              ? [...gatewayApiApps.map((a) => a.id), ...syncWritableAgents.map((t) => t.id)]
              : syncWritableAgents.filter((t) => t.projectable).map((t) => t.id);
            const allSelected = allIds.length > 0 && allIds.every((id) => syncSelectedIds.includes(id));
            return (
              <button
                type="button"
                onClick={() => setSyncSelectedIds(allSelected ? [] : allIds)}
                className="text-[10px] text-zinc-500 hover:text-zinc-700 dark:hover:text-zinc-300"
              >
                {allSelected ? t('providers.mcp.deselectAll') : t('providers.mcp.selectAll')}
              </button>
            );
          })()}
          <button
            type="button"
            disabled={!!busy || (!installMenuServerId && syncSelectedIds.length === 0)}
            onClick={() => handleSyncClients(syncSelectedIds)}
            className={`text-xs px-2.5 py-1 rounded-lg text-white disabled:opacity-40 ${
              isRelay
                ? 'bg-sky-600 hover:bg-sky-500'
                : 'bg-violet-600 hover:bg-violet-500'
            }`}
          >
            {busy
              ? t('providers.mcp.processing')
              : isRelay
                ? t('providers.mcp.relayConfirmN', { n: syncSelectedIds.length })
                : t('providers.mcp.confirmN', { n: syncSelectedIds.length })}
          </button>
        </div>
      </div>,
      document.body,
    );
  }

  function renderSyncDropdown() {
    return (
      <>
        <button
          ref={syncProjectBtnRef}
          type="button"
          onClick={() => openSyncMenu('project', syncProjectBtnRef.current)}
          disabled={!!busy || !syncWritableAgents.some((t) => t.projectable) || selectedSyncableIds.length === 0}
          className="text-xs px-3 py-1.5 rounded-lg border border-violet-200 dark:border-violet-800 text-violet-700 dark:text-violet-300 hover:bg-violet-50 dark:hover:bg-violet-900/30 whitespace-nowrap disabled:opacity-40 inline-flex items-center gap-1"
        >
          {busy === 'sync' && syncMenuMode === 'project' ? t('providers.mcp.installing') : (
            selectedSyncableIds.length
              ? t('providers.mcp.installToAgentN', { n: selectedSyncableIds.length })
              : t('providers.mcp.installToAgent')
          )}
          <span className="text-[10px] opacity-70">▾</span>
        </button>
        <button
          ref={syncRelayBtnRef}
          type="button"
          onClick={() => openSyncMenu('relay', syncRelayBtnRef.current)}
          disabled={!!busy || (syncWritableAgents.length === 0 && gatewayApiApps.length === 0) || selectedSyncableIds.length === 0}
          className="text-xs px-3 py-1.5 rounded-lg border border-sky-200 dark:border-sky-800 text-sky-700 dark:text-sky-300 hover:bg-sky-50 dark:hover:bg-sky-900/30 whitespace-nowrap disabled:opacity-40 inline-flex items-center gap-1"
        >
          {busy === 'sync' && syncMenuMode === 'relay' ? t('providers.mcp.relaying') : (
            selectedSyncableIds.length
              ? t('providers.mcp.installRelayN', { n: selectedSyncableIds.length })
              : t('providers.mcp.installRelay')
          )}
          <span className="text-[10px] opacity-70">▾</span>
        </button>
      </>
    );
  }

  async function handleInstall(item) {
    if (item.alwaysInstalled || item.installed) return;
    if (item.configFields?.length) {
      const defaults = {};
      for (const f of item.configFields) {
        if (f.defaultValue) defaults[f.key] = f.defaultValue;
      }
      setInstallConfig(defaults);
      setInstallTarget(item);
      return;
    }
    setBusy(item.catalogId);
    const res = await window.electronAPI.mcp.installCatalog({ catalogId: item.catalogId });
    setBusy('');
    if (!res.success) alert(res.error || t('providers.mcp.importFailed'));
    else {
      setMcpViewTab('managed');
      saveMcpViewTab('managed');
      loadAll();
    }
  }

  async function confirmInstall() {
    if (!installTarget) return;
    setBusy(installTarget.catalogId);
    const res = await window.electronAPI.mcp.installCatalog({
      catalogId: installTarget.catalogId,
      config: installConfig,
    });
    setBusy('');
    if (!res.success) {
      alert(res.error || t('providers.mcp.importFailed'));
      return;
    }
    setInstallTarget(null);
    setInstallConfig({});
    setMcpViewTab('managed');
    saveMcpViewTab('managed');
    loadAll();
  }

  async function handleUninstall(server) {
    if (server.builtin) return;
    if (!confirm(t('providers.mcp.uninstallConfirm', { name: server.display_name || server.name }))) return;
    setBusy(server.id);
    const res = await window.electronAPI.mcp.uninstallServer(server.id);
    setBusy('');
    if (!res.success) alert(res.error);
    else loadAll();
  }

  async function saveCustomServer() {
    const isUrl = isMcpUrlServer(customForm);
    if (!customForm.name.trim()) {
      alert(t('providers.mcp.nameRequired'));
      return;
    }
    if (isUrl && !customForm.url.trim()) {
      alert(t('providers.mcp.urlRequired'));
      return;
    }
    if (!isUrl && !customForm.command.trim()) {
      alert(t('providers.mcp.commandRequired'));
      return;
    }
    let headers = {};
    if (isUrl) {
      try {
        headers = customForm.headersText.trim() ? JSON.parse(customForm.headersText) : {};
        if (!headers || typeof headers !== 'object' || Array.isArray(headers)) {
          alert(t('providers.mcp.headersObjectRequired'));
          return;
        }
      } catch (e) {
        alert(t('providers.mcp.headersJsonInvalid', { msg: e.message }));
        return;
      }
    }
    const args = customForm.args.split(/\s+/).filter(Boolean);
    const metadata = { category: 'custom', description: t('providers.mcp.customServerDesc') };
    if (isUrl && Object.keys(headers).length) metadata.headers = headers;
    setBusy('custom');
    const res = await window.electronAPI.mcp.saveServer({
      name: customForm.name.trim(),
      display_name: customForm.display_name.trim() || customForm.name.trim(),
      type: isUrl ? 'http' : 'stdio',
      command: isUrl ? '' : customForm.command.trim(),
      args: isUrl ? [] : args,
      url: isUrl ? customForm.url.trim() : null,
      metadata,
    });
    setBusy('');
    if (!res.success) {
      alert(res.error || t('providers.mcp.saveFailed'));
      return;
    }
    setShowCustom(false);
    setCustomForm({ ...EMPTY_CUSTOM_FORM });
    setMcpViewTab('managed');
    saveMcpViewTab('managed');
    loadAll();
  }

  /** CLI / URL 模式切换（内部仍用 stdio / http） */
  function renderTypeModeToggle(isUrl, onChange) {
    return (
      <div className="space-y-1">
        <span className="text-[10px] text-zinc-500">{t('providers.mcp.type')}</span>
        <div className="inline-flex rounded-lg border border-zinc-200 dark:border-zinc-700 overflow-hidden text-xs">
          <button
            type="button"
            onClick={() => onChange(false)}
            className={`px-3 py-1.5 ${
              !isUrl
                ? 'bg-violet-50 dark:bg-violet-900/30 text-violet-700 dark:text-violet-200 font-medium'
                : 'text-zinc-400 hover:text-zinc-600'
            }`}
          >
            {t('providers.mcp.typeCli')}
          </button>
          <button
            type="button"
            onClick={() => onChange(true)}
            className={`px-3 py-1.5 ${
              isUrl
                ? 'bg-violet-50 dark:bg-violet-900/30 text-violet-700 dark:text-violet-200 font-medium'
                : 'text-zinc-400 hover:text-zinc-600'
            }`}
          >
            {t('providers.mcp.typeUrl')}
          </button>
        </div>
        <p className="text-[10px] text-zinc-400">
          {isUrl ? t('providers.mcp.typeUrlHint') : t('providers.mcp.typeCliHint')}
        </p>
      </div>
    );
  }

  /** 打开编辑弹窗（内置不可改） */
  function openEditServer(server) {
    if (!server || server.builtin) return;
    const isUrl = isMcpUrlServer(server);
    const envObj = server.env && typeof server.env === 'object' ? server.env : {};
    const headers = server.metadata?.headers && typeof server.metadata.headers === 'object'
      ? server.metadata.headers
      : {};
    const form = {
      id: server.id,
      builtin: false,
      name: server.name || '',
      display_name: server.display_name || server.name || '',
      type: isUrl ? (server.type === 'sse' ? 'sse' : 'http') : 'stdio',
      command: server.command || '',
      args: Array.isArray(server.args) ? server.args.join(' ') : '',
      url: server.url || '',
      envText: JSON.stringify(envObj, null, 2),
      headersText: JSON.stringify(headers, null, 2),
      description: server.metadata?.description || '',
      metadata: server.metadata || {},
      syncToAgents: true,
      editMode: 'form', // form | json
      rawJson: '',
      installedCount: [...new Set([
        ...(server.clientTargets || []).filter(c => c.installed).map(c => c.id),
        ...(server.sync_clients || []).filter((id) => syncWritableAgents.some((t) => t.id === id)),
      ])].length,
    };
    form.rawJson = buildEditRawJson(form);
    setEditServer(form);
  }

  /** 表单 → 原始 JSON（与写入 Agent 的 MCP 条目对齐，并含 TB 字段） */
  function buildEditRawJson(form) {
    const isUrl = form.type === 'sse' || form.type === 'http';
    let env = {};
    let headers = {};
    try { env = form.envText?.trim() ? JSON.parse(form.envText) : {}; } catch { env = {}; }
    try { headers = form.headersText?.trim() ? JSON.parse(form.headersText) : {}; } catch { headers = {}; }
    const doc = {
      name: form.name || '',
      display_name: form.display_name || form.name || '',
      description: form.description || '',
      type: form.type || 'stdio',
    };
    if (isUrl) {
      doc.url = form.url || '';
      if (headers && typeof headers === 'object' && Object.keys(headers).length) {
        doc.headers = headers;
      }
    } else {
      doc.command = form.command || '';
      doc.args = String(form.args || '').split(/\s+/).filter(Boolean);
      if (env && typeof env === 'object' && Object.keys(env).length) doc.env = env;
    }
    return JSON.stringify(doc, null, 2);
  }

  /** 原始 JSON → 表单字段 */
  function applyRawJsonToForm(form, text) {
    const doc = JSON.parse(text);
    if (!doc || typeof doc !== 'object' || Array.isArray(doc)) {
      throw new Error(t('providers.mcp.jsonObjectRequired'));
    }
    const hasUrl = !!(doc.url || doc.type === 'sse' || doc.type === 'http');
    const type = doc.type === 'http' || doc.type === 'sse'
      ? doc.type
      : (hasUrl ? 'sse' : 'stdio');
    return {
      ...form,
      name: String(doc.name ?? form.name ?? '').trim(),
      display_name: String(doc.display_name ?? doc.name ?? form.display_name ?? '').trim(),
      description: String(doc.description ?? form.description ?? ''),
      type,
      command: String(doc.command ?? ''),
      args: Array.isArray(doc.args) ? doc.args.join(' ') : String(doc.args || ''),
      url: String(doc.url ?? ''),
      envText: JSON.stringify(doc.env && typeof doc.env === 'object' ? doc.env : {}, null, 2),
      headersText: JSON.stringify(doc.headers && typeof doc.headers === 'object' ? doc.headers : {}, null, 2),
      rawJson: JSON.stringify(doc, null, 2),
    };
  }

  function switchEditMode(mode) {
    setEditServer(prev => {
      if (!prev || prev.editMode === mode) return prev;
      if (mode === 'json') {
        return { ...prev, editMode: 'json', rawJson: buildEditRawJson(prev) };
      }
      // json → form：先解析再切回
      try {
        return { ...applyRawJsonToForm(prev, prev.rawJson), editMode: 'form' };
      } catch (e) {
        alert(t('providers.mcp.rawJsonInvalidSwitch', { msg: e.message }));
        return prev;
      }
    });
  }

  async function saveEditServer() {
    if (!editServer) return;

    let form = editServer;
    if (editServer.editMode === 'json') {
      try {
        form = { ...applyRawJsonToForm(editServer, editServer.rawJson), editMode: 'json' };
      } catch (e) {
        alert(t('providers.mcp.rawJsonInvalid', { msg: e.message }));
        return;
      }
    }

    let env = {};
    let headers = {};
    try {
      env = form.envText.trim() ? JSON.parse(form.envText) : {};
      if (!env || typeof env !== 'object' || Array.isArray(env)) {
        alert(t('providers.mcp.envObjectRequired'));
        return;
      }
    } catch (e) {
      alert(t('providers.mcp.envJsonInvalid', { msg: e.message }));
      return;
    }
    try {
      headers = form.headersText.trim() ? JSON.parse(form.headersText) : {};
      if (!headers || typeof headers !== 'object' || Array.isArray(headers)) {
        alert(t('providers.mcp.headersObjectRequired'));
        return;
      }
    } catch (e) {
      alert(t('providers.mcp.headersJsonInvalid', { msg: e.message }));
      return;
    }

    const isUrl = form.type === 'sse' || form.type === 'http';
    if (!form.name.trim()) {
      alert(t('providers.mcp.nameRequired'));
      return;
    }
    if (isUrl && !form.url.trim()) {
      alert(t('providers.mcp.urlRequired'));
      return;
    }
    if (!isUrl && !form.command.trim()) {
      alert(t('providers.mcp.commandRequired'));
      return;
    }

    const metadata = {
      ...form.metadata,
      description: form.description.trim(),
    };
    if (Object.keys(headers).length) metadata.headers = headers;
    else delete metadata.headers;

    setBusy(form.id);
    try {
      const res = await window.electronAPI.mcp.saveServer({
        id: form.id,
        name: form.name.trim(),
        display_name: form.display_name.trim() || form.name.trim(),
        type: form.type,
        command: isUrl ? '' : form.command.trim(),
        args: isUrl ? [] : form.args.split(/\s+/).filter(Boolean),
        url: isUrl ? form.url.trim() : null,
        env,
        metadata,
        skipAutoSync: !form.syncToAgents,
        syncInstalled: !!form.syncToAgents,
      });
      if (!res.success) {
        alert(res.error || t('providers.mcp.saveFailed'));
        return;
      }
      const synced = (res.sync?.results || []).filter(r => r.success).map(r => r.label || r.clientId);
      if (form.syncToAgents && synced.length) {
        const hitWb = (res.sync?.results || []).some(
          (r) => r.success && String(r.clientId || r.label || '').toLowerCase().includes('workbuddy'),
        );
        const msg = t('providers.mcp.savedSynced', { agents: synced.join('、') });
        alert(hitWb ? `${msg}\n${t('providers.mcp.workbuddyTrustHint')}` : msg);
      } else if (form.syncToAgents && !synced.length) {
        alert(t('providers.mcp.savedNoAgents'));
      }
      setEditServer(null);
      loadAll();
    } catch (e) {
      alert(e.message);
    } finally {
      setBusy('');
    }
  }

  function matchFilter(item) {
    if (!catalogFilter.trim()) return true;
    const q = catalogFilter.trim().toLowerCase();
    const tags = item.metadata?.tags || [];
    const hay = [
      item.display_name,
      item.name,
      item.description,
      localizeCatalogDesc(item, t),
      item.metadata?.package,
      ...tags,
      ...tags.map(tag => localizeCatalogTag(tag, t)),
      ...(item.metadata?.tools || []),
    ].filter(Boolean).join(' ').toLowerCase();
    return hay.includes(q);
  }

  function renderCatalogCard(item) {
    return (
      <div
        key={item.catalogId}
        className="tb-soft-tile rounded-2xl p-4 flex flex-col gap-2"
      >
        <div className="flex items-start gap-2">
          <span className="text-xl">{item.metadata?.icon || '🔧'}</span>
          <div className="min-w-0 flex-1">
            <p className="text-sm font-semibold text-zinc-800 dark:text-zinc-200 truncate" title={item.display_name}>
              {item.display_name}
            </p>
            <p className="text-[11px] text-zinc-400 font-mono truncate" title={item.metadata?.package || item.name}>
              {item.metadata?.package || item.name}
            </p>
          </div>
          {item.installed ? (
            <span className="text-[10px] px-1.5 py-0.5 rounded bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300 shrink-0">
              {item.alwaysInstalled ? t('providers.mcp.builtin') : t('providers.mcp.managedTag')}
            </span>
          ) : null}
        </div>
        <p className="text-xs text-zinc-500 flex-1">{localizeCatalogDesc(item, t)}</p>
        {item.metadata?.tools?.length > 0 && (
          <p
            className="text-[10px] text-zinc-400 font-mono break-words line-clamp-2"
            title={item.metadata.tools.join(', ')}
          >
            {t('providers.mcp.toolsLabel', {
              tools: item.metadata.tools.join(', '),
            })}
          </p>
        )}
        {item.metadata?.tags?.length > 0 && (
          <div className="flex flex-wrap gap-1">
            {item.metadata.tags.map(tag => (
              <span key={tag} className="text-[10px] px-1 py-0.5 rounded bg-zinc-100 dark:bg-zinc-700 text-zinc-500">
                {localizeCatalogTag(tag, t)}
              </span>
            ))}
          </div>
        )}
        {!item.alwaysInstalled && (
          <button
            type="button"
            disabled={!!busy || item.installed}
            onClick={() => handleInstall(item)}
            className="mt-1 text-xs px-3 py-1.5 rounded-lg bg-violet-600 text-white disabled:opacity-40 hover:bg-violet-500"
          >
            {item.installed ? t('providers.mcp.managedTag') : busy === item.catalogId ? t('providers.mcp.importing') : t('providers.mcp.oneClickImport')}
          </button>
        )}
      </div>
    );
  }

  const filteredGroups = catalogGroups
    .map(g => ({ ...g, items: g.items.filter(matchFilter) }))
    .filter(g => g.items.length > 0);

  const totalCatalogCount = catalog.length;
  const managedCount = servers.length;

  // 应用筛选：严格对齐 Gateway「应用」页 — 仅「已纳管 / 在线」
  // Claude Desktop 与 Claude Code 复用 MCP，筛选不单独展示 Desktop
  const filterAppItems = (() => {
    const items = [];
    const seen = new Set();
    for (const app of gatewayApps) {
      if (!isGatewayAppManaged(app)) continue;
      const isApi = app.link_method === 'manual';
      const id = isApi ? app.id : (app.agent_id || app.preset_id || app.id);
      if (!id || seen.has(id)) continue;
      if (!isApi && MCP_PROJECT_LIST_HIDDEN.has(id)) continue;
      seen.add(id);
      items.push({
        id,
        label: app.name || id,
        kind: isApi ? 'api-app' : 'agent',
        appId: app.id,
      });
    }
    return items;
  })();
  const activeAgent = filterAppItems.find(a => a.id === agentTab) || null;

  // 按应用筛选：Agent → 已投射或已中转；API 应用 → 仅已中转绑定
  const filteredManagedServers = (() => {
    if (!agentTab) return servers;
    const isApiTab = activeAgent?.kind === 'api-app'
      || gatewayApiApps.some((a) => a.id === agentTab)
      || (gatewayInfo?.apiApps || []).some((a) => a.id === agentTab)
      || String(agentTab).startsWith('app-');
    // 同时匹配 agent 目标 id、别名（codex↔codex-desktop）与 Gateway app.id
    const matchIds = expandClientMatchIds(agentTab);
    if (activeAgent?.appId) matchIds.add(activeAgent.appId);
    if (isApiTab) {
      return servers.filter((s) => (s.gateway_clients || []).some((id) => matchIds.has(id)));
    }
    return servers.filter((s) => {
      const onAgent = (s.clientTargets || []).some((c) => matchIds.has(c.id) && c.installed);
      const onGateway = (s.gateway_clients || []).some((id) => matchIds.has(id));
      const onSync = (s.sync_clients || []).some((id) => matchIds.has(id));
      return onAgent || onGateway || onSync;
    });
  })();

  function selectMcpViewTab(tab) {
    setMcpViewTab(tab);
    saveMcpViewTab(tab);
  }

  function selectAgentTab(id) {
    setAgentTab(id);
    saveMcpAgentTab(id);
  }

  function renderMcpSourceBadge(source) {
    const styles = {
      tb_sync: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300',
      tb_scanned: 'bg-sky-100 text-sky-700 dark:bg-sky-900/40 dark:text-sky-300',
      client: 'bg-sky-100 text-sky-700 dark:bg-sky-900/40 dark:text-sky-300',
    };
    const labels = {
      tb_sync: t('providers.mcp.sourceTb'),
      tb_scanned: t('providers.mcp.sourceClient'),
      client: t('providers.mcp.sourceClient'),
    };
    return (
      <span className={`text-[10px] px-1.5 py-0.5 rounded shrink-0 ${styles[source] || styles.client}`}>
        {labels[source] || labels.client}
      </span>
    );
  }

  /** 已纳管 MCP：用 tag 区分「通过 TB 安装」与「客户端自配」（扫描纳管） */
  function managedOriginSource(server) {
    if (server?.builtin) return null;
    if (server?.metadata?.origin === 'client_scan' || server?.metadata?.category === 'imported') {
      return 'client';
    }
    return 'tb_sync';
  }

  /** 本机 MCP 列表上方的应用筛选：对齐 Gateway「已纳管 / 在线」 */
  function renderAppFilter() {
    if (filterAppItems.length === 0) return null;
    const options = [
      { id: '', label: t('resources.appFilterAll'), kind: 'all' },
      ...filterAppItems,
    ];
    return (
      <div className="flex flex-wrap gap-2">
        {options.map(opt => {
          const active = agentTab === opt.id;
          const isApiApp = opt.kind === 'api-app';
          return (
            <button
              key={opt.id || 'all'}
              type="button"
              onClick={() => {
                selectAgentTab(opt.id);
                if (opt.id) setGatewayProfileId(opt.id);
              }}
              title={isApiApp ? t('providers.mcp.gatewayFilterApiApp') : undefined}
              className={`tb-press inline-flex items-center gap-2 px-3 py-1.5 rounded-full border transition-colors ${
                active
                  ? (isApiApp
                    ? 'border-amber-500 bg-amber-50/90 dark:bg-amber-900/30 shadow-sm'
                    : 'border-sky-500 bg-sky-50/90 dark:bg-sky-900/30 shadow-sm')
                  : 'tb-soft-tile !rounded-full'
              }`}
            >
              {opt.id ? (
                <ServiceIcon id={opt.id} name={opt.label} boxClass="w-5 h-5" imgClass="w-3 h-3" className="!rounded-md" />
              ) : (
                <ServiceIcon icon="◫" name={opt.label} boxClass="w-5 h-5" imgClass="w-3 h-3" className="!rounded-md" />
              )}
              <span className={`text-xs font-medium ${
                active
                  ? (isApiApp ? 'text-amber-800 dark:text-amber-200' : 'text-sky-800 dark:text-sky-200')
                  : 'text-zinc-700 dark:text-zinc-300'
              }`}>
                {opt.label}
              </span>
              {isApiApp && (
                <span className="text-[9px] opacity-70">{t('providers.mcp.gatewayApiAppTag')}</span>
              )}
            </button>
          );
        })}
      </div>
    );
  }

  /** 已投射于哪些已纳管 Agent（配置残留但未安装的不展示） */
  function renderInstalledAgentBadges(server) {
    const writable = new Set(syncWritableAgents.map((t) => t.id));
    const installed = (server.clientTargets || []).filter(
      (c) => c.installed && writable.has(c.id),
    );
    if (!installed.length) {
      return <span className="text-[10px] text-zinc-400">{t('providers.mcp.notInstalledOnAgent')}</span>;
    }
    return installed.map(c => (
      <span
        key={c.id}
        title={c.synced
          ? t('providers.mcp.sourceTitleTb', { label: c.label })
          : t('providers.mcp.sourceTitleClient', { label: c.label })}
        className="inline-flex items-center justify-center w-7 h-7 rounded-lg bg-emerald-50 dark:bg-emerald-900/30 ring-1 ring-emerald-200 dark:ring-emerald-700/60 shrink-0"
      >
        <ServiceIcon
          id={c.id}
          name={c.label}
          boxClass="w-6 h-6 !bg-transparent dark:!bg-transparent rounded-md"
          imgClass="w-4 h-4"
        />
      </span>
    ));
  }

  /** 已中转的 API 应用（排除「通用」档；无品牌图标则直接显示名称） */
  function renderGatewayClientBadges(server) {
    const clients = serverGatewayClients(server).filter((cid) => cid !== 'api');
    if (!clients.length) return null;
    return clients.map((cid) => {
      const label = gatewayProfileOptions().find((o) => o.id === cid)?.label || cid;
      const hay = `${cid} ${label}`;
      const hasIcon = !!resolveBrandIcon(hay) || /kimi|moonshot/i.test(hay);
      if (!hasIcon) {
        return (
          <span
            key={cid}
            title={label}
            className="text-[10px] text-emerald-700 dark:text-emerald-300 whitespace-nowrap"
          >
            {label}
          </span>
        );
      }
      return (
        <span
          key={cid}
          title={label}
          className="inline-flex items-center justify-center w-7 h-7 rounded-lg bg-emerald-50 dark:bg-emerald-900/30 ring-1 ring-emerald-200 dark:ring-emerald-700/60 shrink-0"
        >
          <ServiceIcon
            id={cid}
            name={label}
            boxClass="w-6 h-6 !bg-transparent dark:!bg-transparent rounded-md"
            imgClass="w-4 h-4"
          />
        </span>
      );
    });
  }

  function renderManagedRow(s) {
    const canSelect = s.status === 'active' && s.id !== 'tokenbank-agent-bridge';
    const checked = selectedServerIds.includes(s.id);
    return (
      <div
        key={s.id}
        className={`tb-soft-tile rounded-2xl p-4 flex flex-wrap items-start justify-between gap-3 ${
          checked ? '!border-violet-300/70 dark:!border-violet-600/50 ring-1 ring-violet-200/50 dark:ring-violet-800/40' : ''
        }`}
      >
        <div className="min-w-0 flex-1 flex gap-3">
          {canSelect ? (
            <input
              type="checkbox"
              checked={checked}
              disabled={!!busy}
              onChange={() => toggleServerSelected(s.id)}
              className="mt-1 rounded border-zinc-300 dark:border-zinc-600 shrink-0"
              title={t('providers.mcp.checkToInstall')}
            />
          ) : (
            <span className="w-4 shrink-0" />
          )}
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2 flex-wrap">
              <button
                type="button"
                disabled={!!s.builtin}
                onClick={() => openEditServer(s)}
                title={s.display_name || s.name || (s.builtin ? undefined : t('providers.mcp.clickToEdit'))}
                className={`text-sm font-medium text-left truncate max-w-full ${
                  s.builtin
                    ? 'text-zinc-800 dark:text-zinc-200'
                    : 'text-zinc-800 dark:text-zinc-200 hover:text-violet-600 dark:hover:text-violet-300 hover:underline underline-offset-2'
                }`}
              >
                {s.display_name || s.name}
              </button>
              {s.builtin && (
                <span className="text-[10px] px-1.5 py-0.5 rounded bg-violet-100 text-violet-700 dark:bg-violet-900/40 dark:text-violet-300">{t('providers.mcp.builtin')}</span>
              )}
              {managedOriginSource(s) && renderMcpSourceBadge(managedOriginSource(s))}
              <span className="text-[10px] px-1.5 py-0.5 rounded bg-zinc-100 dark:bg-zinc-700 text-zinc-500">
                {isMcpUrlServer(s) ? t('providers.mcp.typeUrl') : t('providers.mcp.typeCli')}
              </span>
              <span className={`text-[10px] px-1.5 py-0.5 rounded ${
                s.status === 'active'
                  ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300'
                  : 'bg-zinc-100 text-zinc-500'
              }`}>
                {s.status === 'active' ? t('providers.mcp.enabled') : t('providers.mcp.disabled')}
              </span>
            </div>
            {s.id !== 'tokenbank-agent-bridge' && (
              <div className="flex items-center gap-2 mt-2 flex-wrap">
                <span className="text-[10px] text-zinc-400 shrink-0">{t('providers.mcp.installedOn')}</span>
                {renderInstalledAgentBadges(s)}
              </div>
            )}
            {s.id === 'tokenbank-agent-bridge' && (
              <p className="text-[10px] text-zinc-400 mt-2">{t('providers.mcp.playgroundOnly')}</p>
            )}
            {serverGatewayClients(s).some((cid) => cid !== 'api') && (
              <div className="flex flex-wrap items-center gap-2 mt-1.5">
                <span className="text-[10px] text-zinc-400 shrink-0">
                  {t('providers.mcp.gatewayBadge')}
                </span>
                {renderGatewayClientBadges(s)}
              </div>
            )}
            <p className="text-xs text-zinc-500 mt-1">
              {localizeCatalogDesc({
                catalogId: s.name || s.id,
                id: s.id,
                name: s.name,
                description: s.metadata?.description || s.metadata?.category || s.type,
              }, t)}
            </p>
            {s.metadata?.tools?.length > 0 && (
              <p
                className="text-[11px] text-zinc-400 mt-1 font-mono break-words line-clamp-2"
                title={s.metadata.tools.join(', ')}
              >
                {s.metadata.tools.join(', ')}
              </p>
            )}
          </div>
        </div>
        {!(s.builtin && s.id === 'tokenbank-agent-bridge') && (
          <div className="flex items-center gap-2 shrink-0 flex-wrap justify-end">
            {canSelect && (
              <>
                <button
                  type="button"
                  data-row-install-btn
                  disabled={!!busy || !syncWritableAgents.some((t) => t.projectable)}
                  onClick={(e) => openRowInstallMenu(s, e, 'project')}
                  className="tb-press text-xs px-2.5 py-1 rounded-lg border border-violet-200/80 dark:border-violet-700/60 bg-violet-50/60 dark:bg-violet-900/20 text-violet-700 dark:text-violet-300 hover:bg-violet-50 dark:hover:bg-violet-900/30 disabled:opacity-40"
                >
                  {busy === s.id && syncMenuMode === 'project' ? t('providers.mcp.installing') : t('providers.mcp.installToAgent')}
                </button>
                <button
                  type="button"
                  data-row-install-btn
                  disabled={!!busy || (syncWritableAgents.length === 0 && gatewayApiApps.length === 0)}
                  onClick={(e) => openRowInstallMenu(s, e, 'relay')}
                  className="tb-press text-xs px-2.5 py-1 rounded-lg border border-sky-200/80 dark:border-sky-700/60 bg-sky-50/60 dark:bg-sky-900/20 text-sky-700 dark:text-sky-300 hover:bg-sky-50 dark:hover:bg-sky-900/30 disabled:opacity-40"
                >
                  {busy === s.id && syncMenuMode === 'relay' ? t('providers.mcp.relaying') : t('providers.mcp.installRelay')}
                </button>
              </>
            )}
            {!s.builtin && (
              <button type="button" disabled={!!busy} onClick={() => handleUninstall(s)}
                className="tb-press text-xs px-2.5 py-1 rounded-lg text-red-600 border border-red-200/80 dark:border-red-900/50 bg-white/40 dark:bg-transparent hover:bg-red-50 dark:hover:bg-red-900/20">
                {t('providers.mcp.uninstall')}
              </button>
            )}
          </div>
        )}
      </div>
    );
  }

  function renderMcpViewTabs() {
    const tabs = [
      { id: 'managed', label: t('providers.mcp.tab.managed'), count: managedCount },
      { id: 'catalog', label: t('providers.mcp.tab.catalog'), count: totalCatalogCount },
    ];
    return (
      <div className="inline-flex rounded-lg border border-zinc-200 dark:border-zinc-700 overflow-hidden text-xs shrink-0">
        {tabs.map(tab => (
          <button
            key={tab.id}
            type="button"
            onClick={() => selectMcpViewTab(tab.id)}
            className={`px-3 py-1.5 whitespace-nowrap ${
              mcpViewTab === tab.id
                ? 'bg-violet-50 dark:bg-violet-900/30 font-medium text-violet-800 dark:text-violet-200'
                : 'text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-300'
            }`}
          >
            {tab.label}{tab.count != null ? ` (${tab.count})` : ''}
          </button>
        ))}
      </div>
    );
  }

  if (!window.electronAPI?.mcp) {
    return (
      <p className="text-sm text-zinc-400 py-8 text-center">{t('providers.mcp.desktopOnly')}</p>
    );
  }

  return (
    <div className="space-y-4">
      {renderInstallAgentMenu()}
      {loading ? (
        <p className="text-xs text-zinc-400 py-8 text-center">{t('providers.mcp.loading')}</p>
      ) : error ? (
        <p className="text-xs text-red-500 py-4">{error}</p>
      ) : (
        <>
          {/* Tab 左对齐，搜索/操作 右对齐 */}
          <div className="flex items-center justify-between gap-3 w-full">
            {renderMcpViewTabs()}
            <div className="flex items-center gap-2 shrink-0">
              <button
                type="button"
                onClick={() => loadAll()}
                disabled={!!busy}
                className="text-xs px-2.5 py-1.5 rounded-lg border border-zinc-200 dark:border-zinc-700 hover:bg-zinc-50 dark:hover:bg-zinc-800 whitespace-nowrap disabled:opacity-40"
              >
                {t('providers.mcp.refresh')}
              </button>
              {mcpViewTab === 'catalog' && (
                <>
                  <input
                    type="search"
                    value={catalogFilter}
                    onChange={e => setCatalogFilter(e.target.value)}
                    placeholder={t('providers.mcp.searchPlaceholder')}
                    className="w-44 sm:w-52 text-xs px-3 py-1.5 rounded-lg border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-800"
                  />
                  <span className="text-[11px] text-zinc-400 whitespace-nowrap hidden sm:inline">
                    {t('providers.mcp.catalogCount', { n: totalCatalogCount })}
                  </span>
                </>
              )}
              {mcpViewTab === 'managed' && (
                <>
                  {renderSyncDropdown()}
                  <button
                    type="button"
                    onClick={() => setShowCustom(true)}
                    className="text-xs px-3 py-1.5 rounded-lg border border-zinc-200 dark:border-zinc-700 hover:bg-zinc-50 dark:hover:bg-zinc-800 whitespace-nowrap"
                  >
                    {t('providers.mcp.customMcp')}
                  </button>
                </>
              )}
            </div>
          </div>

          {mcpViewTab === 'catalog' ? (
          <section className="space-y-3">
            {filteredGroups.length === 0 ? (
              <p className="text-xs text-zinc-400 text-center py-6">{t('providers.mcp.noMatch')}</p>
            ) : filteredGroups.map(group => (
              <div key={group.id} className="space-y-2">
                <h3 className="text-xs font-semibold text-zinc-500 dark:text-zinc-400 flex items-center gap-2">
                  <span className="w-1 h-3 rounded-full bg-violet-400" />
                  {localizeGroupLabel(group, t)}
                  <span className="text-zinc-400 font-normal">({group.items.length})</span>
                </h3>
                <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-3">
                  {group.items.map(renderCatalogCard)}
                </div>
              </div>
            ))}
          </section>
          ) : (
          <>
          {renderAppFilter()}
          {renderGatewayPanel()}
          {syncMsg && (
            <p className="text-xs text-violet-600 dark:text-violet-400 -mt-1 whitespace-pre-line">{syncMsg}</p>
          )}
          <p className="text-[11px] text-zinc-400 -mt-1 flex flex-wrap items-center gap-3">
            <span>{t('providers.mcp.managedHint')}</span>
            {syncSelectableServers.length > 0 && (
              <label className="inline-flex items-center gap-1.5 cursor-pointer text-zinc-500 hover:text-zinc-700 dark:hover:text-zinc-300">
                <input
                  type="checkbox"
                  checked={allSyncSelectableChecked}
                  onChange={toggleSelectAllServers}
                  className="rounded border-zinc-300 dark:border-zinc-600"
                />
                {t('providers.mcp.selectAll')}
              </label>
            )}
          </p>
          {/* 与供给源卡一致：独立 soft-tile，去掉整表分割线 */}
          <div className="space-y-2.5">
            {filteredManagedServers.length === 0 ? (
              <div className="tb-soft-tile rounded-2xl p-5 text-center space-y-2">
                <p className="text-xs text-zinc-400">
                  {agentTab
                    ? (activeAgent ? t('providers.mcp.noManagedOnAgent', { agent: activeAgent.label }) : t('providers.mcp.noManaged'))
                    : t('providers.mcp.noManaged')}
                </p>
                {!agentTab && (
                  <button type="button" onClick={() => selectMcpViewTab('catalog')}
                    className="text-xs text-violet-600 dark:text-violet-400 hover:underline">
                    {t('providers.mcp.goCatalog')}
                  </button>
                )}
                {agentTab && (
                  <button type="button" onClick={() => selectAgentTab('')}
                    className="text-xs text-violet-600 dark:text-violet-400 hover:underline">
                    {t('resources.clearAppFilter')}
                  </button>
                )}
              </div>
            ) : filteredManagedServers.map(renderManagedRow)}
          </div>

          </>
          )}
        </>
      )}

      {/* 弹窗挂 body：避开主栏 backdrop-filter 导致 fixed 错位 */}
      {installTarget && createPortal(
        <div className="electron-no-drag fixed inset-0 z-[9998] flex items-center justify-center bg-black/40 p-4" onClick={() => setInstallTarget(null)}>
          <div className="bg-white dark:bg-zinc-900 rounded-2xl border border-zinc-200 dark:border-zinc-700 w-full max-w-md p-5 space-y-4 shadow-xl" onClick={e => e.stopPropagation()}>
            <h3 className="text-sm font-semibold">{t('providers.mcp.importTitle', { name: installTarget.display_name })}</h3>
            {(installTarget.configFields || []).map(field => (
              <div key={field.key}>
                <label className="text-xs text-zinc-500 block mb-1">{localizeFieldLabel(field, t)}</label>
                <input
                  type={field.type === 'secret' ? 'password' : 'text'}
                  value={installConfig[field.key] ?? ''}
                  onChange={e => setInstallConfig(c => ({ ...c, [field.key]: e.target.value }))}
                  className="w-full text-sm px-3 py-2 rounded-lg border border-zinc-200 dark:border-zinc-700 bg-zinc-50 dark:bg-zinc-800"
                  placeholder={field.placeholder || field.defaultValue || ''}
                />
              </div>
            ))}
            <div className="flex justify-end gap-2">
              <button type="button" onClick={() => setInstallTarget(null)} className="text-xs px-3 py-1.5 rounded-lg border">{t('providers.mcp.cancel')}</button>
              <button type="button" onClick={confirmInstall} disabled={!!busy} className="text-xs px-3 py-1.5 rounded-lg bg-violet-600 text-white">{t('providers.mcp.confirmImport')}</button>
            </div>
          </div>
        </div>,
        document.body,
      )}

      {/* 编辑已纳管 MCP */}
      {editServer && createPortal(
        <div className="electron-no-drag fixed inset-0 z-[9998] flex items-center justify-center bg-black/40 p-4" onClick={() => setEditServer(null)}>
          <div
            ref={editPanelRef}
            className="bg-white dark:bg-zinc-900 rounded-2xl border border-zinc-200 dark:border-zinc-700 w-full max-w-lg p-5 space-y-3 max-h-[90vh] overflow-y-auto shadow-xl"
            onClick={e => e.stopPropagation()}
          >
            <div className="flex items-center justify-between gap-2">
              <div>
                <h3 className="text-sm font-semibold">{t('providers.mcp.editTitle')}</h3>
                <p className="text-[10px] text-zinc-400 mt-0.5">{t('providers.mcp.editHint')}</p>
              </div>
              <div className="inline-flex rounded-lg border border-zinc-200 dark:border-zinc-700 overflow-hidden text-[10px] shrink-0">
                <button
                  type="button"
                  onClick={() => switchEditMode('form')}
                  className={`px-2.5 py-1 ${
                    editServer.editMode !== 'json'
                      ? 'bg-violet-50 dark:bg-violet-900/30 text-violet-700 dark:text-violet-200 font-medium'
                      : 'text-zinc-400 hover:text-zinc-600'
                  }`}
                >
                  {t('providers.mcp.formMode')}
                </button>
                <button
                  type="button"
                  onClick={() => switchEditMode('json')}
                  className={`px-2.5 py-1 ${
                    editServer.editMode === 'json'
                      ? 'bg-violet-50 dark:bg-violet-900/30 text-violet-700 dark:text-violet-200 font-medium'
                      : 'text-zinc-400 hover:text-zinc-600'
                  }`}
                >
                  {t('providers.mcp.rawJsonMode')}
                </button>
              </div>
            </div>

            {editServer.editMode === 'json' ? (
              <label className="block space-y-1">
                <span className="text-[10px] text-zinc-500">
                  {t('providers.mcp.rawJsonLabel')}
                </span>
                <textarea
                  value={editServer.rawJson}
                  onChange={e => setEditServer(f => ({ ...f, rawJson: e.target.value }))}
                  rows={16}
                  spellCheck={false}
                  className="w-full text-xs px-3 py-2 rounded-lg border border-zinc-200 dark:border-zinc-700 bg-zinc-50 dark:bg-zinc-800 font-mono leading-relaxed"
                />
              </label>
            ) : (
              <>
            <label className="block space-y-1">
              <span className="text-[10px] text-zinc-500">{t('providers.mcp.displayName')}</span>
              <input
                value={editServer.display_name}
                onChange={e => setEditServer(f => ({ ...f, display_name: e.target.value }))}
                className="w-full text-sm px-3 py-2 rounded-lg border border-zinc-200 dark:border-zinc-700 bg-zinc-50 dark:bg-zinc-800"
              />
            </label>
            <label className="block space-y-1">
              <span className="text-[10px] text-zinc-500">{t('providers.mcp.configName')}</span>
              <input
                value={editServer.name}
                onChange={e => setEditServer(f => ({ ...f, name: e.target.value }))}
                className="w-full text-sm px-3 py-2 rounded-lg border border-zinc-200 dark:border-zinc-700 bg-zinc-50 dark:bg-zinc-800 font-mono"
              />
            </label>
            {renderTypeModeToggle(isMcpUrlServer(editServer), (urlMode) => {
              setEditServer((f) => ({
                ...f,
                type: urlMode ? (f.type === 'sse' ? 'sse' : 'http') : 'stdio',
              }));
            })}
            {isMcpUrlServer(editServer) ? (
              <>
                <label className="block space-y-1">
                  <span className="text-[10px] text-zinc-500">URL</span>
                  <input
                    value={editServer.url}
                    onChange={e => setEditServer(f => ({ ...f, url: e.target.value }))}
                    className="w-full text-sm px-3 py-2 rounded-lg border border-zinc-200 dark:border-zinc-700 bg-zinc-50 dark:bg-zinc-800 font-mono"
                    placeholder={t('providers.mcp.urlPh')}
                  />
                </label>
                <label className="block space-y-1">
                  <span className="text-[10px] text-zinc-500">{t('providers.mcp.headersJson')}</span>
                  <textarea
                    value={editServer.headersText}
                    onChange={e => setEditServer(f => ({ ...f, headersText: e.target.value }))}
                    rows={3}
                    className="w-full text-xs px-3 py-2 rounded-lg border border-zinc-200 dark:border-zinc-700 bg-zinc-50 dark:bg-zinc-800 font-mono"
                  />
                </label>
              </>
            ) : (
              <>
                <label className="block space-y-1">
                  <span className="text-[10px] text-zinc-500">command</span>
                  <input
                    value={editServer.command}
                    onChange={e => setEditServer(f => ({ ...f, command: e.target.value }))}
                    className="w-full text-sm px-3 py-2 rounded-lg border border-zinc-200 dark:border-zinc-700 bg-zinc-50 dark:bg-zinc-800 font-mono"
                  />
                </label>
                <label className="block space-y-1">
                  <span className="text-[10px] text-zinc-500">{t('providers.mcp.argsHint')}</span>
                  <input
                    value={editServer.args}
                    onChange={e => setEditServer(f => ({ ...f, args: e.target.value }))}
                    className="w-full text-sm px-3 py-2 rounded-lg border border-zinc-200 dark:border-zinc-700 bg-zinc-50 dark:bg-zinc-800 font-mono"
                  />
                </label>
                <label className="block space-y-1">
                  <span className="text-[10px] text-zinc-500">{t('providers.mcp.envJson')}</span>
                  <textarea
                    value={editServer.envText}
                    onChange={e => setEditServer(f => ({ ...f, envText: e.target.value }))}
                    rows={3}
                    className="w-full text-xs px-3 py-2 rounded-lg border border-zinc-200 dark:border-zinc-700 bg-zinc-50 dark:bg-zinc-800 font-mono"
                  />
                </label>
              </>
            )}
            <label className="block space-y-1">
              <span className="text-[10px] text-zinc-500">{t('providers.mcp.description')}</span>
              <input
                value={editServer.description}
                onChange={e => setEditServer(f => ({ ...f, description: e.target.value }))}
                className="w-full text-sm px-3 py-2 rounded-lg border border-zinc-200 dark:border-zinc-700 bg-zinc-50 dark:bg-zinc-800"
              />
            </label>
              </>
            )}

            <label className="flex items-center gap-2 text-xs text-zinc-600 dark:text-zinc-300 cursor-pointer">
              <input
                type="checkbox"
                checked={editServer.syncToAgents}
                onChange={e => setEditServer(f => ({ ...f, syncToAgents: e.target.checked }))}
                className="rounded border-zinc-300 dark:border-zinc-600"
              />
              {t('providers.mcp.syncToAgents')}
              {editServer.installedCount > 0 && (
                <span className="text-[10px] text-zinc-400">{t('providers.mcp.syncCount', { n: editServer.installedCount })}</span>
              )}
            </label>
            <div className="flex justify-end gap-2 pt-1">
              <button type="button" onClick={() => setEditServer(null)} className="text-xs px-3 py-1.5 rounded-lg border">{t('providers.mcp.cancel')}</button>
              <button
                type="button"
                onClick={saveEditServer}
                disabled={!!busy || (editServer.editMode !== 'json' && (!editServer.name.trim() || (editServer.type !== 'stdio' ? !editServer.url.trim() : !editServer.command.trim())))}
                className="text-xs px-3 py-1.5 rounded-lg bg-violet-600 text-white disabled:opacity-40"
              >
                {busy === editServer.id ? t('providers.mcp.saving') : t('providers.mcp.save')}
              </button>
            </div>
          </div>
        </div>,
        document.body,
      )}

      {/* 自定义 Server */}
      {showCustom && createPortal(
        <div className="electron-no-drag fixed inset-0 z-[9998] flex items-center justify-center bg-black/40 p-4" onClick={() => setShowCustom(false)}>
          <div className="bg-white dark:bg-zinc-900 rounded-2xl border border-zinc-200 dark:border-zinc-700 w-full max-w-md p-5 space-y-3 shadow-xl max-h-[90vh] overflow-y-auto" onClick={e => e.stopPropagation()}>
            <h3 className="text-sm font-semibold">{t('providers.mcp.addCustomTitle')}</h3>
            <input
              placeholder={t('providers.mcp.namePh')}
              value={customForm.name}
              onChange={e => setCustomForm(f => ({ ...f, name: e.target.value }))}
              className="w-full text-sm px-3 py-2 rounded-lg border border-zinc-200 dark:border-zinc-700 bg-zinc-50 dark:bg-zinc-800"
            />
            <input
              placeholder={t('providers.mcp.displayNamePh')}
              value={customForm.display_name}
              onChange={e => setCustomForm(f => ({ ...f, display_name: e.target.value }))}
              className="w-full text-sm px-3 py-2 rounded-lg border border-zinc-200 dark:border-zinc-700 bg-zinc-50 dark:bg-zinc-800"
            />
            {renderTypeModeToggle(isMcpUrlServer(customForm), (urlMode) => {
              setCustomForm((f) => ({ ...f, type: urlMode ? 'http' : 'stdio' }));
            })}
            {isMcpUrlServer(customForm) ? (
              <>
                <input
                  placeholder={t('providers.mcp.urlPh')}
                  value={customForm.url}
                  onChange={e => setCustomForm(f => ({ ...f, url: e.target.value }))}
                  className="w-full text-sm px-3 py-2 rounded-lg border border-zinc-200 dark:border-zinc-700 bg-zinc-50 dark:bg-zinc-800 font-mono"
                />
                <label className="block space-y-1">
                  <span className="text-[10px] text-zinc-500">{t('providers.mcp.headersJson')}</span>
                  <textarea
                    value={customForm.headersText}
                    onChange={e => setCustomForm(f => ({ ...f, headersText: e.target.value }))}
                    rows={3}
                    className="w-full text-xs px-3 py-2 rounded-lg border border-zinc-200 dark:border-zinc-700 bg-zinc-50 dark:bg-zinc-800 font-mono"
                  />
                </label>
              </>
            ) : (
              <>
                <input
                  placeholder="command"
                  value={customForm.command}
                  onChange={e => setCustomForm(f => ({ ...f, command: e.target.value }))}
                  className="w-full text-sm px-3 py-2 rounded-lg border border-zinc-200 dark:border-zinc-700 bg-zinc-50 dark:bg-zinc-800 font-mono"
                />
                <input
                  placeholder={t('providers.mcp.argsPh')}
                  value={customForm.args}
                  onChange={e => setCustomForm(f => ({ ...f, args: e.target.value }))}
                  className="w-full text-sm px-3 py-2 rounded-lg border border-zinc-200 dark:border-zinc-700 bg-zinc-50 dark:bg-zinc-800 font-mono"
                />
              </>
            )}
            <div className="flex justify-end gap-2">
              <button type="button" onClick={() => { setShowCustom(false); setCustomForm({ ...EMPTY_CUSTOM_FORM }); }} className="text-xs px-3 py-1.5 rounded-lg border">{t('providers.mcp.cancel')}</button>
              <button
                type="button"
                onClick={saveCustomServer}
                disabled={!!busy || !customForm.name.trim() || (isMcpUrlServer(customForm) ? !customForm.url.trim() : !customForm.command.trim())}
                className="text-xs px-3 py-1.5 rounded-lg bg-violet-600 text-white disabled:opacity-40"
              >
                {t('providers.mcp.save')}
              </button>
            </div>
          </div>
        </div>,
        document.body,
      )}
    </div>
  );
}

export function readSupplyTab() {
  try { return localStorage.getItem(SUPPLY_TAB_KEY) || 'model'; } catch { return 'model'; }
}

export function saveSupplyTab(tab) {
  try { localStorage.setItem(SUPPLY_TAB_KEY, tab); } catch {}
}
