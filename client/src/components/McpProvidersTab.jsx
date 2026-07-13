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
  /** 点击标题编辑已纳管 MCP */
  const [editServer, setEditServer] = useState(null);
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
    // 默认勾选「当前已安装」的 Agent；首次安装则全选可写 Agent
    const installed = (server.clientTargets || [])
      .filter(c => c.installed && syncWritableAgents.some(t => t.id === c.id))
      .map(c => c.id);
    const fromSync = (server.sync_clients || [])
      .filter(id => syncWritableAgents.some(t => t.id === id));
    const assigned = [...new Set([...installed, ...fromSync])];
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

  /** 收集某 MCP 当前已安装到的可写 Agent */
  function getInstalledAgentIds(server) {
    if (!server) return [];
    const ids = new Set();
    for (const c of server.clientTargets || []) {
      if (c.installed && syncWritableAgents.some(t => t.id === c.id)) ids.add(c.id);
    }
    for (const id of server.sync_clients || []) {
      if (syncWritableAgents.some(t => t.id === id)) ids.add(id);
    }
    return [...ids];
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

    const singleServer = singleId ? servers.find(s => s.id === singleId) : null;
    const singleName = singleServer?.display_name || singleServer?.name || null;

    closeSyncMenu();
    setBusy(singleId || 'sync');
    setSyncMsg('');
    try {
      let res;
      if (singleId) {
        // 单 MCP：勾选=安装/保留，取消勾选=从该 Agent 移除
        const previously = getInstalledAgentIds(singleServer);
        const selected = ids.filter(id => syncWritableAgents.some(t => t.id === id));
        const affected = [...new Set([...previously, ...selected])];
        res = await window.electronAPI.mcp.setServerSyncClients({
          serverId: singleId,
          clientIds: selected,
          syncClientIds: affected,
        });
        // 对取消勾选的 Agent 再清一次配置文件中的同名条目（含残留自配）
        const removed = previously.filter(id => !selected.includes(id));
        for (const clientId of removed) {
          try {
            await window.electronAPI.mcp.removeFromAgent({
              serverId: singleId,
              clientId,
            });
          } catch {}
        }
      } else {
        if (!ids.length) {
          alert('请至少选择一个 Agent');
          return;
        }
        res = await window.electronAPI.mcp.syncClients({ clientIds: ids, serverIds });
      }

      if (!res.success) {
        setSyncMsg(res.error || '安装失败');
        alert(res.error || '安装失败');
        return;
      }

      if (singleId) {
        const selected = ids.filter(id => syncWritableAgents.some(t => t.id === id));
        const previously = getInstalledAgentIds(singleServer);
        const removed = previously.filter(id => !selected.includes(id));
        const addedLabels = selected
          .map(id => syncStatus?.targets?.find(t => t.id === id)?.label || id)
          .join('、');
        const removedLabels = removed
          .map(id => syncStatus?.targets?.find(t => t.id === id)?.label || id)
          .join('、');
        const parts = [];
        if (selected.length) parts.push(`已安装到 ${addedLabels}`);
        if (removed.length) parts.push(`已从 ${removedLabels} 移除`);
        if (!parts.length) parts.push('未安装到任何 Agent');
        alert(`${singleName}：${parts.join('；')}`);
      } else {
        const labels = ids
          .map(id => syncStatus?.targets?.find(t => t.id === id)?.label || id)
          .join('、');
        alert(res.hint || `已将 ${serverIds.length} 个 MCP 安装到 ${labels}`);
        setSelectedServerIds([]);
      }
      setSyncMsg('');
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
              ? `勾选=安装 ${singleServer.display_name || singleServer.name}；取消勾选=从该 Agent 移除`
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
            disabled={!!busy || (!installMenuServerId && syncSelectedIds.length === 0)}
            onClick={() => handleSyncClients(syncSelectedIds)}
            className="text-xs px-2.5 py-1 rounded-lg bg-violet-600 text-white disabled:opacity-40 hover:bg-violet-500"
          >
            {busy
              ? '处理中…'
              : installMenuServerId
                ? `确认 (${syncSelectedIds.length})`
                : `安装 (${syncSelectedIds.length})`}
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

  /** 打开编辑弹窗（内置不可改） */
  function openEditServer(server) {
    if (!server || server.builtin) return;
    const isUrl = !!(server.url || server.type === 'sse' || server.type === 'http');
    const envObj = server.env && typeof server.env === 'object' ? server.env : {};
    const headers = server.metadata?.headers && typeof server.metadata.headers === 'object'
      ? server.metadata.headers
      : {};
    const form = {
      id: server.id,
      builtin: false,
      name: server.name || '',
      display_name: server.display_name || server.name || '',
      type: isUrl ? (server.type === 'http' ? 'http' : 'sse') : 'stdio',
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
        ...(server.sync_clients || []),
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
      throw new Error('须为 JSON 对象');
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
        alert(`原始 JSON 无效，无法切换到表单：${e.message}`);
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
        alert(`原始 JSON 无效：${e.message}`);
        return;
      }
    }

    let env = {};
    let headers = {};
    try {
      env = form.envText.trim() ? JSON.parse(form.envText) : {};
      if (!env || typeof env !== 'object' || Array.isArray(env)) throw new Error('env 须为 JSON 对象');
    } catch (e) {
      alert(`环境变量 JSON 无效：${e.message}`);
      return;
    }
    try {
      headers = form.headersText.trim() ? JSON.parse(form.headersText) : {};
      if (!headers || typeof headers !== 'object' || Array.isArray(headers)) {
        throw new Error('headers 须为 JSON 对象');
      }
    } catch (e) {
      alert(`Headers JSON 无效：${e.message}`);
      return;
    }

    const isUrl = form.type === 'sse' || form.type === 'http';
    if (!form.name.trim()) {
      alert('请填写 name');
      return;
    }
    if (isUrl && !form.url.trim()) {
      alert('URL 类型需填写 url');
      return;
    }
    if (!isUrl && !form.command.trim()) {
      alert('stdio 类型需填写 command');
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
        alert(res.error || '保存失败');
        return;
      }
      const synced = (res.sync?.results || []).filter(r => r.success).map(r => r.label || r.clientId);
      if (form.syncToAgents && synced.length) {
        alert(`已保存，并同步到：${synced.join('、')}`);
      } else if (form.syncToAgents && !synced.length) {
        alert('已保存（当前无已安装 Agent，未同步）');
      }
      setEditServer(null);
      loadAll();
    } catch (e) {
      alert(e.message);
    } finally {
      setBusy('');
    }
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

  /** 可筛选的 Agent（可写入或配置中有 MCP）——与 Skill 应用筛选一致 */
  const visibleAgents = agentInstallations.filter(a => a.syncEnabled || a.count > 0);
  const activeAgent = visibleAgents.find(a => a.id === agentTab) || null;

  // 按应用筛选：有选中 Agent 时只看装在该 Agent 上的纳管 MCP
  const filteredManagedServers = agentTab
    ? servers.filter(s => (s.clientTargets || []).some(c => c.id === agentTab && c.installed))
    : servers;

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

  /** 已纳管 MCP：用 tag 区分「通过 TB 安装」与「客户端自配」（扫描纳管） */
  function managedOriginSource(server) {
    if (server?.builtin) return null;
    if (server?.metadata?.origin === 'client_scan' || server?.metadata?.category === 'imported') {
      return 'client';
    }
    return 'tb_sync';
  }

  /** 本机 MCP 列表上方的应用筛选（参考 Skill） */
  function renderAppFilter() {
    if (visibleAgents.length === 0) return null;
    const options = [
      { id: '', label: t('resources.appFilterAll') },
      ...visibleAgents.map(a => ({ id: a.id, label: a.label })),
    ];
    return (
      <div className="flex flex-wrap gap-2">
        {options.map(opt => {
          const active = agentTab === opt.id;
          return (
            <button
              key={opt.id || 'all'}
              type="button"
              onClick={() => selectAgentTab(opt.id)}
              className={`inline-flex items-center gap-2 px-3 py-1.5 rounded-full border transition-colors ${
                active
                  ? 'border-sky-500 bg-sky-50 dark:bg-sky-900/30 shadow-sm'
                  : 'border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-800 hover:border-zinc-300 dark:hover:border-zinc-600'
              }`}
            >
              {opt.id ? (
                <ServiceIcon id={opt.id} name={opt.label} boxClass="w-5 h-5" imgClass="w-3 h-3" className="!rounded-md" />
              ) : (
                <ServiceIcon icon="◫" name={opt.label} boxClass="w-5 h-5" imgClass="w-3 h-3" className="!rounded-md" />
              )}
              <span className={`text-xs font-medium ${active ? 'text-sky-800 dark:text-sky-200' : 'text-zinc-700 dark:text-zinc-300'}`}>
                {opt.label}
              </span>
            </button>
          );
        })}
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
              <button
                type="button"
                disabled={!!s.builtin}
                onClick={() => openEditServer(s)}
                title={s.builtin ? undefined : '点击编辑配置'}
                className={`text-sm font-medium text-left truncate max-w-full ${
                  s.builtin
                    ? 'text-zinc-800 dark:text-zinc-200'
                    : 'text-zinc-800 dark:text-zinc-200 hover:text-violet-600 dark:hover:text-violet-300 hover:underline underline-offset-2'
                }`}
              >
                {s.display_name || s.name}
              </button>
              {s.builtin && (
                <span className="text-[10px] px-1.5 py-0.5 rounded bg-violet-100 text-violet-700 dark:bg-violet-900/40 dark:text-violet-300">内置</span>
              )}
              {managedOriginSource(s) && renderMcpSourceBadge(managedOriginSource(s))}
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
              <p className="text-[10px] text-zinc-400 mt-2">仅游乐场编排</p>
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
          ) : (
          <>
          {renderAppFilter()}
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
            {filteredManagedServers.length === 0 ? (
              <div className="p-5 text-center space-y-2">
                <p className="text-xs text-zinc-400">
                  {agentTab
                    ? (activeAgent ? `${activeAgent.label} 上暂无已纳管 MCP` : t('providers.mcp.noManaged'))
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

      {/* 编辑已纳管 MCP */}
      {editServer && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={() => setEditServer(null)}>
          <div
            className="bg-white dark:bg-zinc-900 rounded-2xl border border-zinc-200 dark:border-zinc-700 w-full max-w-lg p-5 space-y-3 max-h-[90vh] overflow-y-auto"
            onClick={e => e.stopPropagation()}
          >
            <div className="flex items-center justify-between gap-2">
              <div>
                <h3 className="text-sm font-semibold">编辑 MCP 配置</h3>
                <p className="text-[10px] text-zinc-400 mt-0.5">修改后可同步到已安装的 Agent</p>
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
                  表单
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
                  原始 JSON
                </button>
              </div>
            </div>

            {editServer.editMode === 'json' ? (
              <label className="block space-y-1">
                <span className="text-[10px] text-zinc-500">
                  MCP 配置 JSON（含 name / type / command·args·env 或 url·headers）
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
              <span className="text-[10px] text-zinc-500">显示名称</span>
              <input
                value={editServer.display_name}
                onChange={e => setEditServer(f => ({ ...f, display_name: e.target.value }))}
                className="w-full text-sm px-3 py-2 rounded-lg border border-zinc-200 dark:border-zinc-700 bg-zinc-50 dark:bg-zinc-800"
              />
            </label>
            <label className="block space-y-1">
              <span className="text-[10px] text-zinc-500">配置键名 (name)</span>
              <input
                value={editServer.name}
                onChange={e => setEditServer(f => ({ ...f, name: e.target.value }))}
                className="w-full text-sm px-3 py-2 rounded-lg border border-zinc-200 dark:border-zinc-700 bg-zinc-50 dark:bg-zinc-800 font-mono"
              />
            </label>
            <label className="block space-y-1">
              <span className="text-[10px] text-zinc-500">类型</span>
              <select
                value={editServer.type}
                onChange={e => setEditServer(f => ({ ...f, type: e.target.value }))}
                className="w-full text-sm px-3 py-2 rounded-lg border border-zinc-200 dark:border-zinc-700 bg-zinc-50 dark:bg-zinc-800"
              >
                <option value="stdio">stdio（command）</option>
                <option value="sse">SSE / HTTP（url）</option>
                <option value="http">HTTP（url）</option>
              </select>
            </label>
            {(editServer.type === 'sse' || editServer.type === 'http') ? (
              <>
                <label className="block space-y-1">
                  <span className="text-[10px] text-zinc-500">URL</span>
                  <input
                    value={editServer.url}
                    onChange={e => setEditServer(f => ({ ...f, url: e.target.value }))}
                    className="w-full text-sm px-3 py-2 rounded-lg border border-zinc-200 dark:border-zinc-700 bg-zinc-50 dark:bg-zinc-800 font-mono"
                    placeholder="http://127.0.0.1:xxxx/mcp"
                  />
                </label>
                <label className="block space-y-1">
                  <span className="text-[10px] text-zinc-500">Headers（JSON）</span>
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
                  <span className="text-[10px] text-zinc-500">args（空格分隔）</span>
                  <input
                    value={editServer.args}
                    onChange={e => setEditServer(f => ({ ...f, args: e.target.value }))}
                    className="w-full text-sm px-3 py-2 rounded-lg border border-zinc-200 dark:border-zinc-700 bg-zinc-50 dark:bg-zinc-800 font-mono"
                  />
                </label>
                <label className="block space-y-1">
                  <span className="text-[10px] text-zinc-500">env（JSON）</span>
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
              <span className="text-[10px] text-zinc-500">描述</span>
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
              同步到已安装的 Agent
              {editServer.installedCount > 0 && (
                <span className="text-[10px] text-zinc-400">（{editServer.installedCount} 个）</span>
              )}
            </label>
            <div className="flex justify-end gap-2 pt-1">
              <button type="button" onClick={() => setEditServer(null)} className="text-xs px-3 py-1.5 rounded-lg border">取消</button>
              <button
                type="button"
                onClick={saveEditServer}
                disabled={!!busy || (editServer.editMode !== 'json' && (!editServer.name.trim() || (editServer.type !== 'stdio' ? !editServer.url.trim() : !editServer.command.trim())))}
                className="text-xs px-3 py-1.5 rounded-lg bg-violet-600 text-white disabled:opacity-40"
              >
                {busy === editServer.id ? '保存中…' : '保存'}
              </button>
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
