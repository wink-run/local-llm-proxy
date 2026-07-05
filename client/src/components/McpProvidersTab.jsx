import React, { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import ServiceIcon from './ServiceIcon';
import { useLang } from '../store/lang';

const SUPPLY_TAB_KEY = 'tokenbank.providers.supplyTab';
const MCP_VIEW_TAB_KEY = 'tokenbank.providers.mcpViewTab';
const MCP_AGENT_TAB_KEY = 'tokenbank.providers.mcpAgentTab';

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
    if (v === 'catalog' || v === 'managed' || v === 'agents') return v;
    return 'agents';
  } catch { return 'agents'; }
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
  const [profiles, setProfiles] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState('');
  const [installTarget, setInstallTarget] = useState(null);
  const [installConfig, setInstallConfig] = useState({});
  const [profileEdit, setProfileEdit] = useState(null);
  const [showCustom, setShowCustom] = useState(false);
  const [customForm, setCustomForm] = useState({
    name: '', display_name: '', command: 'npx', args: '-y mcp-fetch-server',
  });
  const [syncStatus, setSyncStatus] = useState(null);
  const [syncMsg, setSyncMsg] = useState('');
  const [agentInstallations, setAgentInstallations] = useState([]);
  const [agentTab, setAgentTab] = useState(() => readMcpAgentTab());
  const [syncMenuOpen, setSyncMenuOpen] = useState(false);
  const [syncMenuPos, setSyncMenuPos] = useState(null);
  /** null=批量安装菜单，string=单行 MCP id */
  const [installMenuServerId, setInstallMenuServerId] = useState(null);
  const [syncSelectedIds, setSyncSelectedIds] = useState([]);
  const [selectedServerIds, setSelectedServerIds] = useState([]);
  const syncBtnRef = useRef(null);
  const syncMenuRef = useRef(null);

  const loadAll = useCallback(async () => {
    if (!window.electronAPI?.mcp) {
      setLoading(false);
      return;
    }
    setLoading(true);
    setError('');
    try {
      const [catRes, srvRes, profRes, syncRes, agentRes] = await Promise.all([
        window.electronAPI.mcp.listCatalog(),
        window.electronAPI.mcp.listServers(),
        window.electronAPI.mcp.listProfiles(),
        window.electronAPI.mcp.getSyncStatus(),
        window.electronAPI.mcp.listAgentInstallations(),
      ]);
      if (catRes.success) {
        setCatalog(catRes.catalog || []);
        setCatalogGroups(catRes.grouped || []);
      }
      else setError(catRes.error || '加载目录失败');
      if (srvRes.success) setServers(srvRes.servers || []);
      if (profRes.success) setProfiles(profRes.profiles || []);
      if (syncRes.success) setSyncStatus(syncRes);
      if (agentRes.success) {
        const agents = agentRes.agents || [];
        setAgentInstallations(agents);
        const visible = agents.filter(a => a.syncEnabled || a.count > 0);
        if (visible.length && (!agentTab || !visible.some(a => a.id === agentTab))) {
          const next = visible[0].id;
          setAgentTab(next);
          saveMcpAgentTab(next);
        }
      }
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { loadAll(); }, [loadAll]);

  const syncWritableAgents = (syncStatus?.targets || []).filter(t => t.syncEnabled);

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
      if (syncBtnRef.current?.contains(t) || syncMenuRef.current?.contains(t)) return;
      if (t.closest?.('[data-row-install-btn]')) return;
      closeSyncMenu();
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [syncMenuOpen, closeSyncMenu]);

  function openInstallMenu({ serverId = null, anchorEl, selectedAgentIds }) {
    if (syncMenuOpen && installMenuServerId === serverId) {
      closeSyncMenu();
      return;
    }
    setInstallMenuServerId(serverId);
    setSyncSelectedIds(selectedAgentIds);
    if (anchorEl) {
      const r = anchorEl.getBoundingClientRect();
      setSyncMenuPos({ top: r.bottom + 4, left: r.right, align: 'right' });
    }
    setSyncMenuOpen(true);
  }

  function openSyncMenu() {
    const defaults = syncWritableAgents.map(t => t.id);
    openInstallMenu({
      serverId: null,
      anchorEl: syncBtnRef.current,
      selectedAgentIds: defaults,
    });
  }

  function openRowInstallMenu(server, e) {
    if (server.status !== 'active') return;
    const assigned = (server.sync_clients || []).filter(id => syncWritableAgents.some(t => t.id === id));
    const defaults = assigned.length ? assigned : syncWritableAgents.map(t => t.id);
    openInstallMenu({
      serverId: server.id,
      anchorEl: e.currentTarget,
      selectedAgentIds: defaults,
    });
  }

  function toggleSyncSelected(id) {
    const agent = (syncStatus?.targets || []).find(t => t.id === id);
    if (!agent?.syncEnabled) return;
    setSyncSelectedIds(prev => (
      prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id]
    ));
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
      alert(singleId ? '无法安装该 MCP' : '请至少勾选一个 MCP');
      return;
    }
    if (!ids.length) {
      alert('请至少选择一个 Agent');
      return;
    }

    const singleName = singleId
      ? servers.find(s => s.id === singleId)?.display_name || servers.find(s => s.id === singleId)?.name
      : null;

    closeSyncMenu();
    setBusy(singleId || 'sync');
    setSyncMsg('');
    try {
      const res = await window.electronAPI.mcp.syncClients({ clientIds: ids, serverIds });
      if (!res.success) {
        setSyncMsg(res.error || '安装失败');
        alert(res.error || '安装失败');
        return;
      }
      const labels = ids
        .map(id => syncStatus?.targets?.find(t => t.id === id)?.label || id)
        .join('、');
      const successMsg = res.hint || (singleName
        ? `已将 ${singleName} 安装到 ${labels}`
        : `已将 ${serverIds.length} 个 MCP 安装到 ${labels}`);
      alert(successMsg);
      setSyncMsg('');
      if (!singleId) setSelectedServerIds([]);
      const st = await window.electronAPI.mcp.getSyncStatus();
      if (st.success) setSyncStatus(st);
      const srvRes = await window.electronAPI.mcp.listServers();
      if (srvRes.success) setServers(srvRes.servers || []);
      const agentRes = await window.electronAPI.mcp.listAgentInstallations();
      if (agentRes.success) setAgentInstallations(agentRes.agents || []);
    } catch (e) {
      setSyncMsg(e.message);
    } finally {
      setBusy('');
    }
  }

  function renderInstallAgentMenu() {
    if (!syncMenuOpen || !syncMenuPos) return null;
    const singleServer = installMenuServerId
      ? servers.find(s => s.id === installMenuServerId)
      : null;
    return createPortal(
      <div
        ref={syncMenuRef}
        className="fixed z-[9999] w-56 rounded-xl border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-800 shadow-lg overflow-hidden"
        style={{
          top: syncMenuPos.top,
          left: syncMenuPos.align === 'right' ? syncMenuPos.left - 224 : syncMenuPos.left,
        }}
      >
        <div className="px-3 py-2 border-b border-zinc-100 dark:border-zinc-700">
          <p className="text-xs font-medium text-zinc-700 dark:text-zinc-200">选择安装的 Agent</p>
          <p className="text-[10px] text-zinc-400 mt-0.5">
            {singleServer
              ? `安装 ${singleServer.display_name || singleServer.name} 到所选 Agent`
              : `已勾选 ${selectedSyncableIds.length} 个 MCP，选择目标 Agent 后安装`}
          </p>
        </div>
        <div className="py-1 max-h-56 overflow-y-auto">
          {syncWritableAgents.length === 0 ? (
            <p className="text-xs text-zinc-400 px-3 py-2">暂无可安装的 Agent</p>
          ) : syncWritableAgents.map(agent => {
            const checked = syncSelectedIds.includes(agent.id);
            return (
              <label
                key={agent.id}
                className={`flex items-center gap-2 px-3 py-2 text-xs cursor-pointer ${
                  checked ? 'bg-violet-50 dark:bg-violet-900/20' : 'hover:bg-zinc-50 dark:hover:bg-zinc-700/40'
                }`}
              >
                <input
                  type="checkbox"
                  checked={checked}
                  onChange={() => toggleSyncSelected(agent.id)}
                  className="rounded border-zinc-300 dark:border-zinc-600"
                />
                <ServiceIcon id={agent.id} name={agent.label} boxClass="w-6 h-6" imgClass="w-3.5 h-3.5" />
                <span className="text-zinc-700 dark:text-zinc-200 flex-1 truncate">{agent.label}</span>
              </label>
            );
          })}
        </div>
        <div className="flex items-center justify-between gap-2 px-3 py-2 border-t border-zinc-100 dark:border-zinc-700 bg-zinc-50/80 dark:bg-zinc-900/40">
          <button
            type="button"
            onClick={() => setSyncSelectedIds(syncWritableAgents.map(t => t.id))}
            className="text-[10px] text-zinc-500 hover:text-zinc-700 dark:hover:text-zinc-300"
          >
            全选
          </button>
          <button
            type="button"
            disabled={!!busy || syncSelectedIds.length === 0}
            onClick={() => handleSyncClients(syncSelectedIds)}
            className="text-xs px-2.5 py-1 rounded-lg bg-violet-600 text-white disabled:opacity-40 hover:bg-violet-500"
          >
            {busy ? '安装中…' : `安装 (${syncSelectedIds.length})`}
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
          ref={syncBtnRef}
          type="button"
          onClick={openSyncMenu}
          disabled={!!busy || syncWritableAgents.length === 0 || selectedSyncableIds.length === 0}
          className="text-xs px-3 py-1.5 rounded-lg border border-violet-200 dark:border-violet-800 text-violet-700 dark:text-violet-300 hover:bg-violet-50 dark:hover:bg-violet-900/30 whitespace-nowrap disabled:opacity-40 inline-flex items-center gap-1"
        >
          {busy === 'sync' ? '安装中…' : `安装到 Agent${selectedSyncableIds.length ? ` (${selectedSyncableIds.length})` : ''}`}
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
    if (!res.success) alert(res.error || '纳管失败');
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
      alert(res.error || '纳管失败');
      return;
    }
    setInstallTarget(null);
    setInstallConfig({});
    setMcpViewTab('managed');
    saveMcpViewTab('managed');
    loadAll();
  }

  async function handleImportToTb(item) {
    if (!item?.clientKey || item.source !== 'client' || !activeAgent) return;
    setBusy(`${activeAgent.id}:import:${item.clientKey}`);
    try {
      const res = await window.electronAPI.mcp.importFromAgent({
        clientId: activeAgent.id,
        clientKey: item.clientKey,
      });
      if (!res.success) {
        alert(res.error || t('providers.mcp.importFailed'));
        return;
      }
      if (res.hint) alert(res.hint);
      selectMcpViewTab('managed');
      loadAll();
    } catch (e) {
      alert(e.message);
    } finally {
      setBusy('');
    }
  }

  async function handleRemoveAgentMcp(item) {
    const agent = agentInstallations.find(a => a.id === agentTab);
    if (!agent) return;
    setBusy(`${agent.id}:${item.clientKey}`);
    const res = await window.electronAPI.mcp.removeFromAgent({
      serverId: item.serverId || undefined,
      clientId: agent.id,
      clientKey: item.clientKey,
      external: item.source === 'client',
    });
    setBusy('');
    if (!res.success) alert(res.error || '操作失败');
    else loadAll();
  }

  async function toggleStatus(server) {
    if (server.builtin && server.id === 'tokenbank-agent-bridge') return;
    setBusy(server.id);
    const next = server.status === 'active' ? 'inactive' : 'active';
    const res = await window.electronAPI.mcp.setServerStatus({ serverId: server.id, status: next });
    setBusy('');
    if (!res.success) alert(res.error);
    else loadAll();
  }

  async function handleUninstall(server) {
    if (server.builtin) return;
    if (!confirm(`确定卸载 ${server.display_name || server.name}？`)) return;
    setBusy(server.id);
    const res = await window.electronAPI.mcp.uninstallServer(server.id);
    setBusy('');
    if (!res.success) alert(res.error);
    else loadAll();
  }

  async function saveCustomServer() {
    const args = customForm.args.split(/\s+/).filter(Boolean);
    setBusy('custom');
    const res = await window.electronAPI.mcp.saveServer({
      name: customForm.name.trim(),
      display_name: customForm.display_name.trim() || customForm.name.trim(),
      command: customForm.command.trim(),
      args,
      metadata: { category: 'custom', description: '自定义 MCP Server' },
    });
    setBusy('');
    if (!res.success) {
      alert(res.error || '保存失败');
      return;
    }
    setShowCustom(false);
    setCustomForm({ name: '', display_name: '', command: 'npx', args: '-y mcp-fetch-server' });
    setMcpViewTab('managed');
    saveMcpViewTab('managed');
    loadAll();
  }

  function openProfileEdit(profile) {
    setProfileEdit({
      ...profile,
      selectedIds: (profile.servers || []).map(s => s.id),
    });
  }

  async function saveProfileEdit() {
    if (!profileEdit) return;
    setBusy(profileEdit.id);
    const res = await window.electronAPI.mcp.saveProfile({
      profileId: profileEdit.id,
      serverIds: profileEdit.selectedIds,
    });
    setBusy('');
    if (!res.success) alert(res.error);
    else {
      setProfileEdit(null);
      loadAll();
    }
  }

  function toggleProfileServer(serverId) {
    setProfileEdit(prev => {
      const set = new Set(prev.selectedIds);
      if (set.has(serverId)) set.delete(serverId);
      else set.add(serverId);
      return { ...prev, selectedIds: [...set] };
    });
  }

  function matchFilter(item) {
    if (!catalogFilter.trim()) return true;
    const q = catalogFilter.trim().toLowerCase();
    const hay = [
      item.display_name,
      item.name,
      item.description,
      item.metadata?.package,
      ...(item.metadata?.tags || []),
      ...(item.metadata?.tools || []),
    ].filter(Boolean).join(' ').toLowerCase();
    return hay.includes(q);
  }

  function renderCatalogCard(item) {
    return (
      <div
        key={item.catalogId}
        className="rounded-2xl border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-800 p-4 flex flex-col gap-2"
      >
        <div className="flex items-start gap-2">
          <span className="text-xl">{item.metadata?.icon || '🔧'}</span>
          <div className="min-w-0 flex-1">
            <p className="text-sm font-semibold text-zinc-800 dark:text-zinc-200 truncate">
              {item.display_name}
            </p>
            <p className="text-[11px] text-zinc-400 font-mono truncate">{item.metadata?.package || item.name}</p>
          </div>
          {item.installed ? (
            <span className="text-[10px] px-1.5 py-0.5 rounded bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300 shrink-0">
              {item.alwaysInstalled ? '内置' : '已纳管'}
            </span>
          ) : null}
        </div>
        <p className="text-xs text-zinc-500 flex-1">{item.description}</p>
        {item.metadata?.tools?.length > 0 && (
          <p className="text-[10px] text-zinc-400 truncate">
            工具: {item.metadata.tools.slice(0, 4).join(', ')}
            {item.metadata.tools.length > 4 ? '…' : ''}
          </p>
        )}
        {item.metadata?.tags?.length > 0 && (
          <div className="flex flex-wrap gap-1">
            {item.metadata.tags.map(tag => (
              <span key={tag} className="text-[10px] px-1 py-0.5 rounded bg-zinc-100 dark:bg-zinc-700 text-zinc-500">
                {tag}
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
            {item.installed ? '已纳管' : busy === item.catalogId ? '纳管中…' : '一键纳管'}
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

  /** 在 Agent 安装 Tab 中展示的 Agent（可写入或配置中有 MCP） */
  const visibleAgents = agentInstallations.filter(a => a.syncEnabled || a.count > 0);
  const activeAgent = visibleAgents.find(a => a.id === agentTab) || visibleAgents[0] || null;
  const currentAgentItems = activeAgent?.items || [];

  function selectMcpViewTab(tab) {
    setMcpViewTab(tab);
    saveMcpViewTab(tab);
    if (tab === 'agents' && visibleAgents.length && !visibleAgents.some(a => a.id === agentTab)) {
      setAgentTab(visibleAgents[0].id);
      saveMcpAgentTab(visibleAgents[0].id);
    }
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
      tb_sync: '通过 TB 安装',
      tb_scanned: '客户端自配',
      client: '客户端自配',
    };
    return (
      <span className={`text-[10px] px-1.5 py-0.5 rounded shrink-0 ${styles[source] || styles.client}`}>
        {labels[source] || labels.client}
      </span>
    );
  }

  function renderAgentTabs() {
    const tabBtn = (agent) => {
      const active = activeAgent?.id === agent.id;
      return (
        <button
          key={agent.id}
          type="button"
          onClick={() => selectAgentTab(agent.id)}
          title={Array.isArray(agent.paths) ? agent.paths.join('\n') : agent.path}
          className={`flex items-center gap-2 px-3 py-2 rounded-xl border text-left transition-colors ${
            active
              ? 'border-violet-300 dark:border-violet-700 bg-violet-50 dark:bg-violet-900/25 shadow-sm'
              : 'border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-800 hover:border-zinc-300 dark:hover:border-zinc-600'
          }`}
        >
          <ServiceIcon id={agent.id} name={agent.label} boxClass="w-7 h-7" imgClass="w-4 h-4" />
          <div className="min-w-0">
            <p className={`text-xs font-medium ${active ? 'text-violet-800 dark:text-violet-200' : 'text-zinc-700 dark:text-zinc-200'}`}>
              {agent.label}
            </p>
            <p className={`text-[10px] ${active ? 'text-violet-600/80 dark:text-violet-300/80' : 'text-zinc-400'}`}>
              {agent.count} 项 MCP
            </p>
          </div>
        </button>
      );
    };

    return (
      <div className="flex flex-wrap gap-2 pb-1">
        {visibleAgents.map(tabBtn)}
      </div>
    );
  }

  /** 已安装于哪些 Agent（只读徽标） */
  function renderInstalledAgentBadges(server) {
    const installed = (server.clientTargets || []).filter(c => c.installed);
    if (!installed.length) {
      return <span className="text-[10px] text-zinc-400">未安装到 Agent</span>;
    }
    return installed.map(c => (
      <span
        key={c.id}
        title={`${c.label}${c.synced ? ' · 通过 TB 安装' : ' · 客户端自配'}`}
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

  function renderAgentInstallRow(item) {
    return (
      <div key={`${activeAgent?.id}:${item.clientKey}`} className="p-4 flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-sm font-medium text-zinc-800 dark:text-zinc-200">{item.displayName}</span>
            {renderMcpSourceBadge(item.source)}
            {item.clientKey !== item.displayName && (
              <span className="text-[10px] text-zinc-400 font-mono">{item.clientKey}</span>
            )}
          </div>
          <p className="text-xs text-zinc-500 mt-1">{item.description || item.type}</p>
          {item.command && (
            <p className="text-[11px] text-zinc-400 mt-1 font-mono truncate">
              {item.command}{item.args?.length ? ` ${item.args.join(' ')}` : ''}
            </p>
          )}
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {item.source === 'client' && (
            <button
              type="button"
              disabled={!!busy}
              onClick={() => handleImportToTb(item)}
              title={t('providers.mcp.importToTbHint')}
              className="text-xs px-2.5 py-1 rounded-lg border border-violet-200 dark:border-violet-700 text-violet-700 dark:text-violet-300 hover:bg-violet-50 dark:hover:bg-violet-900/30"
            >
              {t('providers.mcp.importToTb')}
            </button>
          )}
          <button
            type="button"
            disabled={!!busy}
            onClick={() => handleRemoveAgentMcp(item)}
            className="text-xs px-2.5 py-1 rounded-lg border border-zinc-200 dark:border-zinc-600 hover:bg-zinc-50 dark:hover:bg-zinc-700"
          >
            {t('providers.mcp.removeFromAgent')}
          </button>
        </div>
      </div>
    );
  }

  function renderManagedRow(s) {
    const canSelect = s.status === 'active' && s.id !== 'tokenbank-agent-bridge';
    const checked = selectedServerIds.includes(s.id);
    return (
      <div key={s.id} className={`p-4 flex flex-wrap items-start justify-between gap-3 ${checked ? 'bg-violet-50/50 dark:bg-violet-900/10' : ''}`}>
        <div className="min-w-0 flex-1 flex gap-3">
          {canSelect ? (
            <input
              type="checkbox"
              checked={checked}
              disabled={!!busy}
              onChange={() => toggleServerSelected(s.id)}
              className="mt-1 rounded border-zinc-300 dark:border-zinc-600 shrink-0"
              title="勾选后通过「安装到 Agent」写入"
            />
          ) : (
            <span className="w-4 shrink-0" />
          )}
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="text-sm font-medium text-zinc-800 dark:text-zinc-200">{s.display_name || s.name}</span>
              {s.builtin && (
                <span className="text-[10px] px-1.5 py-0.5 rounded bg-violet-100 text-violet-700 dark:bg-violet-900/40 dark:text-violet-300">内置</span>
              )}
              <span className={`text-[10px] px-1.5 py-0.5 rounded ${
                s.status === 'active'
                  ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300'
                  : 'bg-zinc-100 text-zinc-500'
              }`}>
                {s.status === 'active' ? '已启用' : '已停用'}
              </span>
            </div>
            {s.id !== 'tokenbank-agent-bridge' && (
              <div className="flex items-center gap-2 mt-2 flex-wrap">
                <span className="text-[10px] text-zinc-400 shrink-0">已安装于</span>
                {renderInstalledAgentBadges(s)}
              </div>
            )}
            {s.id === 'tokenbank-agent-bridge' && (
              <p className="text-[10px] text-zinc-400 mt-2">仅 Debug 编排</p>
            )}
            <p className="text-xs text-zinc-500 mt-1">{s.metadata?.description || s.metadata?.category || s.type}</p>
            {s.metadata?.tools?.length > 0 && (
              <p className="text-[11px] text-zinc-400 mt-1 font-mono truncate">{s.metadata.tools.join(', ')}</p>
            )}
          </div>
        </div>
        {!(s.builtin && s.id === 'tokenbank-agent-bridge') && (
          <div className="flex items-center gap-2 shrink-0">
            {canSelect && (
              <button
                type="button"
                data-row-install-btn
                disabled={!!busy || syncWritableAgents.length === 0}
                onClick={(e) => openRowInstallMenu(s, e)}
                className="text-xs px-2.5 py-1 rounded-lg border border-violet-200 dark:border-violet-700 text-violet-700 dark:text-violet-300 hover:bg-violet-50 dark:hover:bg-violet-900/30 disabled:opacity-40"
              >
                {busy === s.id ? '安装中…' : '安装到 Agent'}
              </button>
            )}
            <button type="button" disabled={!!busy} onClick={() => toggleStatus(s)}
              className="text-xs px-2.5 py-1 rounded-lg border border-zinc-200 dark:border-zinc-600 hover:bg-zinc-50 dark:hover:bg-zinc-700">
              {s.status === 'active' ? '停用' : '启用'}
            </button>
            {!s.builtin && (
              <button type="button" disabled={!!busy} onClick={() => handleUninstall(s)}
                className="text-xs px-2.5 py-1 rounded-lg text-red-600 border border-red-200 dark:border-red-900/50 hover:bg-red-50 dark:hover:bg-red-900/20">
                卸载
              </button>
            )}
          </div>
        )}
      </div>
    );
  }

  function renderMcpViewTabs() {
    const tabs = [
      { id: 'agents', label: t('providers.mcp.tab.installed') },
      { id: 'managed', label: t('providers.mcp.tab.managed'), count: managedCount },
      { id: 'catalog', label: t('providers.mcp.tab.catalog'), count: totalCatalogCount },
    ];
    return (
      <div className="inline-flex rounded-lg border border-zinc-200 dark:border-zinc-700 overflow-hidden text-xs shrink-0">
        {tabs.map(t => (
          <button
            key={t.id}
            type="button"
            onClick={() => selectMcpViewTab(t.id)}
            className={`px-3 py-1.5 whitespace-nowrap ${
              mcpViewTab === t.id
                ? 'bg-violet-50 dark:bg-violet-900/30 font-medium text-violet-800 dark:text-violet-200'
                : 'text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-300'
            }`}
          >
            {t.label}{t.count != null ? ` (${t.count})` : ''}
          </button>
        ))}
      </div>
    );
  }

  if (!window.electronAPI?.mcp) {
    return (
      <p className="text-sm text-zinc-400 py-8 text-center">MCP 管理仅桌面版可用</p>
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
                    共 {totalCatalogCount} 项
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
                    + 自定义 MCP
                  </button>
                </>
              )}
            </div>
          </div>

          {mcpViewTab === 'catalog' ? (
          <section className="space-y-3">
            {filteredGroups.length === 0 ? (
              <p className="text-xs text-zinc-400 text-center py-6">无匹配项</p>
            ) : filteredGroups.map(group => (
              <div key={group.id} className="space-y-2">
                <h3 className="text-xs font-semibold text-zinc-500 dark:text-zinc-400 flex items-center gap-2">
                  <span className="w-1 h-3 rounded-full bg-violet-400" />
                  {group.label}
                  <span className="text-zinc-400 font-normal">({group.items.length})</span>
                </h3>
                <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-3">
                  {group.items.map(renderCatalogCard)}
                </div>
              </div>
            ))}
          </section>
          ) : mcpViewTab === 'agents' ? (
          <div className="space-y-3">
            {visibleAgents.length === 0 ? (
              <p className="text-xs text-zinc-400 text-center py-8">{t('providers.mcp.noAgents')}</p>
            ) : (
              <>
                {renderAgentTabs()}
                {activeAgent && (
                  <p className="text-[11px] text-zinc-400 truncate" title={activeAgent.path}>
                    {activeAgent.label} 配置文件
                    {activeAgent.exists && activeAgent.path ? ` · ${activeAgent.path}` : ' · 尚未创建'}
                  </p>
                )}
                <p className="text-[11px] text-zinc-400">
                  扫描该 Agent 配置中的 MCP：
                  <span className="text-emerald-600 dark:text-emerald-400"> 通过 TB 安装</span> ·
                  <span className="text-sky-600 dark:text-sky-400"> 客户端自配</span>
                </p>
                <div className="bg-white dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-800 rounded-2xl divide-y divide-zinc-100 dark:divide-zinc-700">
                  {currentAgentItems.length === 0 ? (
                    <div className="p-5 text-center space-y-2">
                      <p className="text-xs text-zinc-400">
                        {activeAgent?.label || '该 Agent'} 配置中暂无 MCP
                      </p>
                      <button type="button" onClick={() => selectMcpViewTab('managed')}
                        className="text-xs text-violet-600 dark:text-violet-400 hover:underline">
                        {t('providers.mcp.goManaged')}
                      </button>
                    </div>
                  ) : currentAgentItems.map(renderAgentInstallRow)}
                </div>
              </>
            )}
          </div>
          ) : (
          <>
          {syncMsg && (
            <p className="text-xs text-violet-600 dark:text-violet-400 -mt-1 whitespace-pre-line">{syncMsg}</p>
          )}
          <p className="text-[11px] text-zinc-400 -mt-1 flex flex-wrap items-center gap-3">
            <span>勾选 MCP，点击「安装到 Agent」选择目标并写入配置文件。</span>
            {syncSelectableServers.length > 0 && (
              <label className="inline-flex items-center gap-1.5 cursor-pointer text-zinc-500 hover:text-zinc-700 dark:hover:text-zinc-300">
                <input
                  type="checkbox"
                  checked={allSyncSelectableChecked}
                  onChange={toggleSelectAllServers}
                  className="rounded border-zinc-300 dark:border-zinc-600"
                />
                全选
              </label>
            )}
          </p>
          <div className="bg-white dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-800 rounded-2xl divide-y divide-zinc-100 dark:divide-zinc-700">
            {servers.length === 0 ? (
              <div className="p-5 text-center space-y-2">
                <p className="text-xs text-zinc-400">{t('providers.mcp.noManaged')}</p>
                <button type="button" onClick={() => selectMcpViewTab('catalog')}
                  className="text-xs text-violet-600 dark:text-violet-400 hover:underline">
                  {t('providers.mcp.goCatalog')}
                </button>
              </div>
            ) : servers.map(renderManagedRow)}
          </div>

          {/* Profile：编排场景 MCP 组合 */}
          <section className="space-y-2 pt-1">
            <p className="text-xs font-semibold text-zinc-600 dark:text-zinc-300">{t('providers.mcp.profileTitle')}</p>
            <p className="text-[11px] text-zinc-400 -mt-1">{t('providers.mcp.profileHint')}</p>
            <div className="grid sm:grid-cols-2 gap-3">
              {profiles.map(p => (
                <div
                  key={p.id}
                  className="rounded-2xl border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-800 p-4"
                >
                  <div className="flex items-start justify-between gap-2">
                    <div>
                      <p className="text-sm font-semibold text-zinc-800 dark:text-zinc-200">{p.display_name || p.name}</p>
                      <p className="text-xs text-zinc-500 mt-0.5">{p.description}</p>
                      <p className="text-[11px] text-zinc-400 mt-2">
                        {(p.servers || []).map(s => s.display_name || s.name).join(' · ') || '（空）'}
                      </p>
                    </div>
                    <button
                      type="button"
                      onClick={() => openProfileEdit(p)}
                      className="text-xs px-2 py-1 rounded-lg border border-zinc-200 dark:border-zinc-600 shrink-0"
                    >
                      编辑
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </section>
          </>
          )}
        </>
      )}

      {/* 纳管配置弹窗 */}
      {installTarget && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={() => setInstallTarget(null)}>
          <div className="bg-white dark:bg-zinc-900 rounded-2xl border border-zinc-200 dark:border-zinc-700 w-full max-w-md p-5 space-y-4" onClick={e => e.stopPropagation()}>
            <h3 className="text-sm font-semibold">纳管 {installTarget.display_name}</h3>
            {(installTarget.configFields || []).map(field => (
              <div key={field.key}>
                <label className="text-xs text-zinc-500 block mb-1">{field.label}</label>
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
              <button type="button" onClick={() => setInstallTarget(null)} className="text-xs px-3 py-1.5 rounded-lg border">取消</button>
              <button type="button" onClick={confirmInstall} disabled={!!busy} className="text-xs px-3 py-1.5 rounded-lg bg-violet-600 text-white">确认纳管</button>
            </div>
          </div>
        </div>
      )}

      {/* Profile 编辑 */}
      {profileEdit && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={() => setProfileEdit(null)}>
          <div className="bg-white dark:bg-zinc-900 rounded-2xl border border-zinc-200 dark:border-zinc-700 w-full max-w-md p-5 space-y-3 max-h-[80vh] overflow-y-auto" onClick={e => e.stopPropagation()}>
            <h3 className="text-sm font-semibold">编辑 Profile: {profileEdit.display_name}</h3>
            <p className="text-xs text-zinc-400">勾选此场景启用的 MCP Server</p>
            {servers.filter(s => s.status === 'active' || profileEdit.selectedIds.includes(s.id)).map(s => (
              <label key={s.id} className="flex items-center gap-2 text-sm cursor-pointer">
                <input
                  type="checkbox"
                  checked={profileEdit.selectedIds.includes(s.id)}
                  disabled={s.id === 'tokenbank-agent-bridge'}
                  onChange={() => toggleProfileServer(s.id)}
                />
                <span>{s.display_name || s.name}</span>
                {s.id === 'tokenbank-agent-bridge' && <span className="text-[10px] text-zinc-400">（必选）</span>}
              </label>
            ))}
            <div className="flex justify-end gap-2 pt-2">
              <button type="button" onClick={() => setProfileEdit(null)} className="text-xs px-3 py-1.5 rounded-lg border">取消</button>
              <button type="button" onClick={saveProfileEdit} disabled={!!busy} className="text-xs px-3 py-1.5 rounded-lg bg-violet-600 text-white">保存</button>
            </div>
          </div>
        </div>
      )}

      {/* 自定义 Server */}
      {showCustom && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={() => setShowCustom(false)}>
          <div className="bg-white dark:bg-zinc-900 rounded-2xl border border-zinc-200 dark:border-zinc-700 w-full max-w-md p-5 space-y-3" onClick={e => e.stopPropagation()}>
            <h3 className="text-sm font-semibold">添加自定义 MCP Server</h3>
            <input
              placeholder="名称 (name)"
              value={customForm.name}
              onChange={e => setCustomForm(f => ({ ...f, name: e.target.value }))}
              className="w-full text-sm px-3 py-2 rounded-lg border border-zinc-200 dark:border-zinc-700 bg-zinc-50 dark:bg-zinc-800"
            />
            <input
              placeholder="显示名称"
              value={customForm.display_name}
              onChange={e => setCustomForm(f => ({ ...f, display_name: e.target.value }))}
              className="w-full text-sm px-3 py-2 rounded-lg border border-zinc-200 dark:border-zinc-700 bg-zinc-50 dark:bg-zinc-800"
            />
            <input
              placeholder="command"
              value={customForm.command}
              onChange={e => setCustomForm(f => ({ ...f, command: e.target.value }))}
              className="w-full text-sm px-3 py-2 rounded-lg border border-zinc-200 dark:border-zinc-700 bg-zinc-50 dark:bg-zinc-800 font-mono"
            />
            <input
              placeholder="args（空格分隔）"
              value={customForm.args}
              onChange={e => setCustomForm(f => ({ ...f, args: e.target.value }))}
              className="w-full text-sm px-3 py-2 rounded-lg border border-zinc-200 dark:border-zinc-700 bg-zinc-50 dark:bg-zinc-800 font-mono"
            />
            <div className="flex justify-end gap-2">
              <button type="button" onClick={() => setShowCustom(false)} className="text-xs px-3 py-1.5 rounded-lg border">取消</button>
              <button type="button" onClick={saveCustomServer} disabled={!!busy || !customForm.name.trim()} className="text-xs px-3 py-1.5 rounded-lg bg-violet-600 text-white">保存</button>
            </div>
          </div>
        </div>
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
