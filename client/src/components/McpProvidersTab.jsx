import React, { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import ServiceIcon from './ServiceIcon';
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
      const [catRes, srvRes, syncRes, agentRes] = await Promise.all([
        window.electronAPI.mcp.listCatalog(),
        window.electronAPI.mcp.listServers(),
        window.electronAPI.mcp.getSyncStatus(),
        window.electronAPI.mcp.listAgentInstallations(),
      ]);
      if (catRes.success) {
        setCatalog(catRes.catalog || []);
        setCatalogGroups(catRes.grouped || []);
      }
      else setError(catRes.error || t('providers.mcp.loadCatalogFailed'));
      if (srvRes.success) setServers(srvRes.servers || []);
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
  }, [t]);

  useEffect(() => { loadAll(); }, [loadAll]);

  // 与 Skill/Prompt 一致：只列出本机已纳管的应用（不再用 syncEnabled 裁剪）
  const syncWritableAgents = (syncStatus?.targets || []).filter(t => t.installed);

  // 当前筛选的 Agent 已不在「已安装」列表时回退到全部
  useEffect(() => {
    if (!agentTab) return;
    if (agentInstallations.some(a => a.id === agentTab && a.installed)) return;
    setAgentTab('');
    saveMcpAgentTab('');
  }, [agentTab, agentInstallations]);

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
    if (!agent?.installed) return;
    setSyncSelectedIds(prev => (
      prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id]
    ));
  }

  /** 收集某 MCP 当前已投射到的可写 Agent */
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
      alert(singleId ? t('providers.mcp.cannotInstall') : t('providers.mcp.selectMcpFirst'));
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
          alert(t('providers.mcp.selectAgentFirst'));
          return;
        }
        res = await window.electronAPI.mcp.syncClients({ clientIds: ids, serverIds });
      }

      if (!res.success) {
        setSyncMsg(res.error || t('providers.mcp.installFailed'));
        alert(res.error || t('providers.mcp.installFailed'));
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
        if (selected.length) parts.push(t('providers.mcp.installedTo', { agents: addedLabels }));
        if (removed.length) parts.push(t('providers.mcp.removedFrom', { agents: removedLabels }));
        if (!parts.length) parts.push(t('providers.mcp.notInstalledAny'));
        alert(`${singleName}：${parts.join('；')}`);
      } else {
        const labels = ids
          .map(id => syncStatus?.targets?.find(t => t.id === id)?.label || id)
          .join('、');
        alert(res.hint || t('providers.mcp.installedBatch', { n: serverIds.length, agents: labels }));
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
          <p className="text-xs font-medium text-zinc-700 dark:text-zinc-200">{t('providers.mcp.pickAgentsTitle')}</p>
          <p className="text-[10px] text-zinc-400 mt-0.5">
            {singleServer
              ? t('providers.mcp.installHintSingle', { name: singleServer.display_name || singleServer.name })
              : t('providers.mcp.installHintBatch', { n: selectedSyncableIds.length })}
          </p>
        </div>
        <div className="py-1 max-h-56 overflow-y-auto">
          {syncWritableAgents.length === 0 ? (
            <p className="text-xs text-zinc-400 px-3 py-2">{t('providers.mcp.noAgents')}</p>
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
                <span className="text-zinc-700 dark:text-zinc-200 flex-1 truncate" title={agent.label}>{agent.label}</span>
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
            {t('providers.mcp.selectAll')}
          </button>
          <button
            type="button"
            disabled={!!busy || (!installMenuServerId && syncSelectedIds.length === 0)}
            onClick={() => handleSyncClients(syncSelectedIds)}
            className="text-xs px-2.5 py-1 rounded-lg bg-violet-600 text-white disabled:opacity-40 hover:bg-violet-500"
          >
            {busy
              ? t('providers.mcp.processing')
              : installMenuServerId
                ? t('providers.mcp.confirmN', { n: syncSelectedIds.length })
                : t('providers.mcp.installN', { n: syncSelectedIds.length })}
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
          {busy === 'sync' ? t('providers.mcp.installing') : (
            selectedSyncableIds.length
              ? t('providers.mcp.installToAgentN', { n: selectedSyncableIds.length })
              : t('providers.mcp.installToAgent')
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
    if (!confirm(t('providers.mcp.uninstallConfirm', { name: server.display_name || server.name }))) return;
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
      metadata: { category: 'custom', description: t('providers.mcp.customServerDesc') },
    });
    setBusy('');
    if (!res.success) {
      alert(res.error || t('providers.mcp.saveFailed'));
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
        alert(t('providers.mcp.savedSynced', { agents: synced.join('、') }));
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

  // 应用筛选：仅本机已纳管的应用（有残留 MCP 配置但未装的不展示）
  const visibleAgents = agentInstallations.filter(a => a.installed);
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
              className={`tb-press inline-flex items-center gap-2 px-3 py-1.5 rounded-full border transition-colors ${
                active
                  ? 'border-sky-500 bg-sky-50/90 dark:bg-sky-900/30 shadow-sm'
                  : 'tb-soft-tile !rounded-full'
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
          <div className="flex items-center gap-2 shrink-0">
            {canSelect && (
              <button
                type="button"
                data-row-install-btn
                disabled={!!busy || syncWritableAgents.length === 0}
                onClick={(e) => openRowInstallMenu(s, e)}
                className="tb-press text-xs px-2.5 py-1 rounded-lg border border-violet-200/80 dark:border-violet-700/60 bg-violet-50/60 dark:bg-violet-900/20 text-violet-700 dark:text-violet-300 hover:bg-violet-50 dark:hover:bg-violet-900/30 disabled:opacity-40"
              >
                {busy === s.id ? t('providers.mcp.installing') : t('providers.mcp.installToAgent')}
              </button>
            )}
            <button type="button" disabled={!!busy} onClick={() => toggleStatus(s)}
              className="tb-press text-xs px-2.5 py-1 rounded-lg border border-zinc-200/80 dark:border-zinc-600 bg-white/40 dark:bg-zinc-800/40 hover:bg-white/70 dark:hover:bg-zinc-700/60">
              {s.status === 'active' ? t('providers.mcp.disable') : t('providers.mcp.enable')}
            </button>
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

      {/* 纳管配置弹窗 */}
      {installTarget && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={() => setInstallTarget(null)}>
          <div className="bg-white dark:bg-zinc-900 rounded-2xl border border-zinc-200 dark:border-zinc-700 w-full max-w-md p-5 space-y-4" onClick={e => e.stopPropagation()}>
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
            <label className="block space-y-1">
              <span className="text-[10px] text-zinc-500">{t('providers.mcp.type')}</span>
              <select
                value={editServer.type}
                onChange={e => setEditServer(f => ({ ...f, type: e.target.value }))}
                className="w-full text-sm px-3 py-2 rounded-lg border border-zinc-200 dark:border-zinc-700 bg-zinc-50 dark:bg-zinc-800"
              >
                <option value="stdio">{t('providers.mcp.typeStdio')}</option>
                <option value="sse">{t('providers.mcp.typeSse')}</option>
                <option value="http">{t('providers.mcp.typeHttp')}</option>
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
        </div>
      )}

      {/* 自定义 Server */}
      {showCustom && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={() => setShowCustom(false)}>
          <div className="bg-white dark:bg-zinc-900 rounded-2xl border border-zinc-200 dark:border-zinc-700 w-full max-w-md p-5 space-y-3" onClick={e => e.stopPropagation()}>
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
            <div className="flex justify-end gap-2">
              <button type="button" onClick={() => setShowCustom(false)} className="text-xs px-3 py-1.5 rounded-lg border">{t('providers.mcp.cancel')}</button>
              <button type="button" onClick={saveCustomServer} disabled={!!busy || !customForm.name.trim()} className="text-xs px-3 py-1.5 rounded-lg bg-violet-600 text-white">{t('providers.mcp.save')}</button>
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
