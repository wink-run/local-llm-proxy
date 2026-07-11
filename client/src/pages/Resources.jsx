import React, { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import ServiceIcon from '../components/ServiceIcon';
import { useLang } from '../store/lang';

const VIEW_TAB_KEY = 'tokenbank.resources.viewTab';
const TYPE_FILTER_KEY = 'tokenbank.resources.typeFilter';
const AGENT_TAB_KEY = 'tokenbank.resources.agentTab';

function readAgentTab() {
  try {
    const v = localStorage.getItem(AGENT_TAB_KEY);
    return v && v !== 'all' ? v : '';
  } catch { return ''; }
}

function saveAgentTab(tab) {
  try { localStorage.setItem(AGENT_TAB_KEY, tab); } catch {}
}

const TYPE_OPTIONS = [
  { id: '', labelKey: 'resources.type.all' },
  { id: 'prompt', labelKey: 'resources.type.prompt' },
  { id: 'skill', labelKey: 'resources.type.skill' },
  { id: 'assistant', labelKey: 'resources.type.assistant' },
  { id: 'template', labelKey: 'resources.type.template' },
];

function readViewTab() {
  try {
    const v = localStorage.getItem(VIEW_TAB_KEY);
    if (v === 'catalog' || v === 'discovered' || v === 'managed') return v;
    return 'agents';
  } catch { return 'agents'; }
}

function saveViewTab(tab) {
  try { localStorage.setItem(VIEW_TAB_KEY, tab); } catch {}
}

function readTypeFilter() {
  try { return localStorage.getItem(TYPE_FILTER_KEY) || ''; } catch { return ''; }
}

function saveTypeFilter(type) {
  try { localStorage.setItem(TYPE_FILTER_KEY, type || ''); } catch {}
}

function typeBadge(type, t) {
  const map = {
    prompt: t('resources.type.prompt'),
    skill: t('resources.type.skill'),
    assistant: t('resources.type.assistant'),
    template: t('resources.type.template'),
  };
  return map[type] || type;
}

function sourceLabel(source, t) {
  if (!source || source === 'local') return t('resources.source.local');
  if (source === 'catalog' || String(source).startsWith('catalog')) return t('resources.source.catalog');
  if (source === 'builtin') return t('resources.source.builtin');
  if (String(source).startsWith('agent:')) return t('resources.source.scanned');
  if (source === 'imported') return t('resources.source.imported');
  return source;
}

const EMPTY_EDITOR = {
  id: '',
  type: 'prompt',
  name: '',
  display_name: '',
  description: '',
  content: '',
};

/** Skill 权威目录（用户安装位置） */
function getSkillLocation(resource) {
  if (resource?.type !== 'skill') return null;
  if (resource.authorityPath) return resource.authorityPath;

  const meta = resource.metadata || {};
  let loc = meta.authorityPath || meta.scannedFrom || meta.canonicalPath;
  if (loc && (loc.endsWith('/SKILL.md') || loc.endsWith('/skill.md') || loc.endsWith('\\SKILL.md'))) {
    loc = loc.replace(/[/\\][^/\\]+$/, '');
  }
  if (loc) return loc;

  const originProj = (resource.projections || []).find(
    p => p.projectionType === 'scan' || p.projectionType === 'origin',
  );
  return originProj?.targetPath || null;
}

/** 资产页：Prompt / Skill / Assistant / Template 纳管与投射 */
export default function Resources() {
  const { t } = useLang();
  const [viewTab, setViewTab] = useState(readViewTab);
  const [typeFilter, setTypeFilter] = useState(readTypeFilter);
  const [query, setQuery] = useState('');
  const [catalog, setCatalog] = useState([]);
  const [discovered, setDiscovered] = useState([]);
  const [scanStats, setScanStats] = useState(null);
  const [resources, setResources] = useState([]);
  const [agentInstallations, setAgentInstallations] = useState([]);
  const [agentTab, setAgentTab] = useState(() => readAgentTab());
  const [agents, setAgents] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState('');
  const [msg, setMsg] = useState('');
  const [expandedId, setExpandedId] = useState(null);
  const [projectMenu, setProjectMenu] = useState(null);
  const [projectSelected, setProjectSelected] = useState([]);
  const [editorOpen, setEditorOpen] = useState(false);
  const [editorForm, setEditorForm] = useState(EMPTY_EDITOR);
  const projectMenuRef = useRef(null);

  const loadAll = useCallback(async () => {
    if (!window.electronAPI?.resource) {
      setLoading(false);
      setError(t('resources.desktopOnly'));
      return;
    }
    setLoading(true);
    setError('');
    try {
      const filters = { type: typeFilter || undefined, query: query || undefined };
      const promises = [
        window.electronAPI.resource.listCatalog(filters),
        window.electronAPI.resource.listResources(filters),
        window.electronAPI.resource.listAgentTargets(),
        window.electronAPI.resource.scanDiscovered({ query: query || undefined }),
        window.electronAPI.resource.listAgentInstallations(),
      ];
      const [catRes, resRes, agentRes, scanRes, installRes] = await Promise.all(promises);
      if (catRes.success) setCatalog(catRes.items || []);
      else setError(catRes.error || t('resources.loadFailed'));
      if (resRes.success) setResources(resRes.resources || []);
      if (agentRes.success) setAgents(agentRes.agents || []);
      if (scanRes.success) {
        setDiscovered(scanRes.items || []);
        setScanStats(scanRes.scanStats || null);
      }
      if (installRes.success) {
        const list = installRes.agents || [];
        setAgentInstallations(list);
        const visible = list.filter(a => a.count > 0);
        if (visible.length && (!agentTab || !visible.some(a => a.id === agentTab))) {
          setAgentTab(visible[0].id);
          saveAgentTab(visible[0].id);
        }
      }
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, [typeFilter, query, t]);

  useEffect(() => { loadAll(); }, [loadAll]);

  useEffect(() => {
    if (!projectMenu) return undefined;
    function onDoc(e) {
      if (projectMenuRef.current?.contains(e.target)) return;
      setProjectMenu(null);
    }
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [projectMenu]);

  function changeViewTab(tab) {
    setViewTab(tab);
    saveViewTab(tab);
    if (tab === 'agents') {
      const visible = agentInstallations.filter(a => a.count > 0);
      if (visible.length && !visible.some(a => a.id === agentTab)) {
        setAgentTab(visible[0].id);
        saveAgentTab(visible[0].id);
      }
    }
  }

  function selectAgentTab(id) {
    setAgentTab(id);
    saveAgentTab(id);
  }

  function changeTypeFilter(type) {
    setTypeFilter(type);
    saveTypeFilter(type);
  }

  async function handleImportDiscovered(item) {
    setBusy(item.scanKey);
    setMsg('');
    try {
      const res = await window.electronAPI.resource.importDiscovered({
        scanKey: item.scanKey,
        updateIfExists: !!item.contentChanged,
      });
      if (!res.success) {
        alert(res.error || t('resources.installFailed'));
        return;
      }
      if (res.alreadyInstalled) {
        setMsg(t('resources.alreadyManaged'));
        return;
      }
      alert(res.hint || t('resources.scanImportOk'));
      await loadAll();
      changeViewTab('managed');
    } catch (e) {
      alert(e.message);
    } finally {
      setBusy('');
    }
  }

  async function handleInstall(catalogId) {
    setBusy(catalogId);
    setMsg('');
    try {
      const res = await window.electronAPI.resource.installCatalog({ catalogId });
      if (!res.success) {
        alert(res.error || t('resources.installFailed'));
        return;
      }
      setMsg(res.alreadyInstalled ? t('resources.alreadyManaged') : t('resources.installOk'));
      await loadAll();
      changeViewTab('managed');
    } catch (e) {
      alert(e.message);
    } finally {
      setBusy('');
    }
  }

  async function handleImportToTb(item) {
    if (!item?.clientKey || item.source !== 'client' || !activeAgent) return;
    setBusy(`${activeAgent.id}:import:${item.clientKey}`);
    try {
      const res = await window.electronAPI.resource.importFromAgent({
        agentId: activeAgent.id,
        skillKey: item.clientKey,
      });
      if (!res.success) {
        alert(res.error || t('resources.installFailed'));
        return;
      }
      changeViewTab('managed');
      await loadAll();
    } catch (e) {
      alert(e.message);
    } finally {
      setBusy('');
    }
  }

  async function handleOpenPath(targetPath) {
    if (!targetPath || !window.electronAPI?.resource?.openPath) return;
    try {
      const res = await window.electronAPI.resource.openPath({ targetPath });
      if (!res?.success) alert(res?.error || t('resources.openPathFailed'));
    } catch (e) {
      alert(e.message);
    }
  }

  async function handleRemoveAgentSkill(item) {
    if (!activeAgent) return;
    setBusy(`${activeAgent.id}:${item.clientKey}`);
    try {
      const res = await window.electronAPI.resource.removeFromAgent({
        resourceId: item.resourceId || undefined,
        agentId: activeAgent.id,
        skillKey: item.clientKey,
        external: item.source === 'client',
      });
      if (!res.success) alert(res.error || t('resources.deleteFailed'));
      else await loadAll();
    } finally {
      setBusy('');
    }
  }

  async function handleDelete(resource) {
    if (!window.confirm(t('resources.deleteConfirm', { name: resource.display_name || resource.name }))) return;
    setBusy(resource.id);
    try {
      const res = await window.electronAPI.resource.deleteResource(resource.id);
      if (!res.success) alert(res.error || t('resources.deleteFailed'));
      await loadAll();
    } finally {
      setBusy('');
    }
  }

  function openProjectMenu(e, resourceId) {
    const rect = e.currentTarget.getBoundingClientRect();
    setProjectSelected([]);
    setProjectMenu({ resourceId, x: rect.left, y: rect.bottom + 4 });
  }

  async function confirmProject() {
    if (!projectMenu) return;
    if (!projectSelected.length) {
      alert(t('resources.pickAgent'));
      return;
    }
    const { resourceId } = projectMenu;
    setProjectMenu(null);
    setBusy(resourceId);
    try {
      const res = await window.electronAPI.resource.project({
        resourceId,
        agentIds: projectSelected,
      });
      if (!res.success) {
        alert(res.error || t('resources.projectFailed'));
        return;
      }
      alert(res.hint || t('resources.projectOk'));
      await loadAll();
    } catch (e) {
      alert(e.message);
    } finally {
      setBusy('');
    }
  }

  async function handleUnproject(resource, agentId) {
    setBusy(`${resource.id}-${agentId}`);
    try {
      const res = await window.electronAPI.resource.unproject({ resourceId: resource.id, agentId });
      if (!res.success) alert(res.error || t('resources.unprojectFailed'));
      await loadAll();
    } finally {
      setBusy('');
    }
  }

  function openCreateEditor() {
    setEditorForm({
      ...EMPTY_EDITOR,
      type: typeFilter || 'prompt',
    });
    setEditorOpen(true);
  }

  function openEditEditor(resource) {
    setEditorForm({
      id: resource.id,
      type: resource.type || 'prompt',
      name: resource.name || '',
      display_name: resource.display_name || resource.name || '',
      description: resource.description || '',
      content: resource.content || '',
    });
    setEditorOpen(true);
  }

  async function saveEditor() {
    const name = String(editorForm.name || '').trim();
    if (!name) {
      alert(t('resources.editorNameRequired'));
      return;
    }
    setBusy('editor');
    try {
      const res = await window.electronAPI.resource.saveResource({
        id: editorForm.id || undefined,
        type: editorForm.type,
        name,
        display_name: editorForm.display_name || name,
        description: editorForm.description || '',
        content: editorForm.content || '',
      });
      if (!res.success) {
        alert(res.error || t('resources.saveFailed'));
        return;
      }
      setEditorOpen(false);
      setMsg(t('resources.saveOk'));
      changeViewTab('managed');
      await loadAll();
    } catch (e) {
      alert(e.message);
    } finally {
      setBusy('');
    }
  }

  async function handleImportFile() {
    setBusy('import');
    try {
      const pick = await window.electronAPI.resource.pickImportPath({
        title: t('resources.importPickTitle'),
      });
      if (!pick.success) {
        if (!pick.canceled && pick.error) alert(pick.error);
        return;
      }
      const res = await window.electronAPI.resource.importFromPath({
        sourcePath: pick.path,
        type: typeFilter || undefined,
      });
      if (!res.success) {
        alert(res.error || t('resources.importFailed'));
        return;
      }
      if (res.hint) alert(res.hint);
      else if (res.alreadyInstalled) alert(t('resources.alreadyManaged'));
      else setMsg(t('resources.importOk'));
      changeViewTab('managed');
      await loadAll();
    } catch (e) {
      alert(e.message);
    } finally {
      setBusy('');
    }
  }

  const filteredCatalog = catalog;
  const managedCount = resources.length;
  const discoveredCount = scanStats?.pendingCount ?? discovered.filter(d => !d.managed).length;
  const showSkillTabs = !typeFilter || typeFilter === 'skill';
  const visibleAgents = agentInstallations.filter(a => a.count > 0);
  const activeAgent = visibleAgents.find(a => a.id === agentTab) || visibleAgents[0] || null;
  const currentAgentItems = activeAgent?.items || [];

  function renderSourceBadge(source) {
    const styles = {
      tb_sync: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300',
      tb_scanned: 'bg-sky-100 text-sky-700 dark:bg-sky-900/40 dark:text-sky-300',
      client: 'bg-sky-100 text-sky-700 dark:bg-sky-900/40 dark:text-sky-300',
    };
    const labels = {
      tb_sync: t('resources.badge.tbSync'),
      tb_scanned: t('resources.badge.client'),
      client: t('resources.badge.client'),
    };
    return (
      <span className={`text-[10px] px-1.5 py-0.5 rounded shrink-0 ${styles[source] || styles.client}`}>
        {labels[source] || labels.client}
      </span>
    );
  }

  function renderAgentTabs() {
    return (
      <div className="flex flex-wrap gap-2 pb-1">
        {visibleAgents.map(agent => {
          const active = activeAgent?.id === agent.id;
          return (
            <button
              key={agent.id}
              type="button"
              onClick={() => selectAgentTab(agent.id)}
              title={agent.path}
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
                  {t('resources.agentSkillCount', { n: agent.count })}
                </p>
              </div>
            </button>
          );
        })}
      </div>
    );
  }

  function renderAgentInstallRow(item) {
    return (
      <div key={`${activeAgent?.id}:${item.clientKey}`} className="p-4 flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-sm font-medium text-zinc-800 dark:text-zinc-200">{item.displayName}</span>
            {renderSourceBadge(item.source)}
            {item.isSymlink && (
              <span className="text-[10px] px-1.5 py-0.5 rounded bg-zinc-100 dark:bg-zinc-800 text-zinc-500">symlink</span>
            )}
            {item.clientKey !== item.displayName && (
              <span className="text-[10px] text-zinc-400 font-mono">{item.clientKey}</span>
            )}
          </div>
          <p className="text-xs text-zinc-500 mt-1">{item.description}</p>
          {item.skillPath && (
            <p className="text-[11px] text-zinc-400 mt-1 font-mono truncate">
              <button
                type="button"
                className="hover:text-violet-600 dark:hover:text-violet-400 hover:underline text-left truncate max-w-full"
                title={item.skillPath}
                onClick={() => handleOpenPath(item.skillPath)}
              >
                {item.skillPath}
              </button>
            </p>
          )}
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {item.source === 'client' && (
            <button
              type="button"
              disabled={!!busy}
              onClick={() => handleImportToTb(item)}
              title={t('resources.importToTbHint')}
              className="text-xs px-2.5 py-1 rounded-lg border border-violet-200 dark:border-violet-700 text-violet-700 dark:text-violet-300 hover:bg-violet-50 dark:hover:bg-violet-900/30"
            >
              {t('resources.importToTb')}
            </button>
          )}
          <button
            type="button"
            disabled={!!busy}
            onClick={() => handleRemoveAgentSkill(item)}
            className="text-xs px-2.5 py-1 rounded-lg border border-zinc-200 dark:border-zinc-600 hover:bg-zinc-50 dark:hover:bg-zinc-700"
          >
            {t('resources.removeFromAgent')}
          </button>
        </div>
      </div>
    );
  }

  function renderDiscoveredRow(item) {
    return (
      <div
        key={item.scanKey}
        className="rounded-xl border border-zinc-200/80 dark:border-zinc-700/80 bg-white/70 dark:bg-zinc-900/50 p-3"
      >
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-sm font-medium text-zinc-800 dark:text-zinc-100 truncate">
                {item.display_name || item.name}
              </span>
              <span className="text-[10px] px-1.5 py-0.5 rounded bg-zinc-100 dark:bg-zinc-800 text-zinc-500">
                {t('resources.type.skill')}
              </span>
              {item.contentChanged && (
                <span className="text-[10px] px-1.5 py-0.5 rounded bg-amber-100 dark:bg-amber-900/40 text-amber-700 dark:text-amber-300">
                  {t('resources.contentChanged')}
                </span>
              )}
            </div>
            {item.description && (
              <p className="text-xs text-zinc-500 dark:text-zinc-400 mt-1 line-clamp-2">{item.description}</p>
            )}
            <div className="flex flex-wrap gap-1.5 mt-2">
              {(item.agents || []).map(a => (
                <span
                  key={`${item.scanKey}-${a.agentId}`}
                  className="text-[10px] px-2 py-0.5 rounded-full bg-sky-100 dark:bg-sky-900/30 text-sky-700 dark:text-sky-300"
                  title={a.skillPath}
                >
                  {a.label}
                </span>
              ))}
            </div>
          </div>
          <button
            type="button"
            disabled={!!busy}
            onClick={() => handleImportDiscovered(item)}
            title={t('resources.importToTbHint')}
            className="text-xs px-2.5 py-1 rounded-lg bg-violet-600 text-white hover:bg-violet-700 disabled:opacity-50 shrink-0"
          >
            {busy === item.scanKey
              ? t('resources.busy')
              : item.contentChanged
                ? t('resources.updateManage')
                : t('resources.scanImport')}
          </button>
        </div>
      </div>
    );
  }

  function renderProjections(resource) {
    const projs = resource.projections || [];
    if (!projs.length) {
      return <span className="text-[10px] text-zinc-400">{t('resources.notProjected')}</span>;
    }
    return (
      <div className="flex flex-wrap gap-1.5 mt-1">
        {projs.map(p => (
          <span
            key={p.id}
            className="inline-flex items-center gap-1 text-[10px] px-2 py-0.5 rounded-full bg-violet-100 dark:bg-violet-900/40 text-violet-700 dark:text-violet-300"
          >
            {p.label || p.agentId}
            <button
              type="button"
              className="opacity-60 hover:opacity-100"
              title={t('resources.unproject')}
              disabled={busy === `${resource.id}-${p.agentId}`}
              onClick={() => handleUnproject(resource, p.agentId)}
            >
              ×
            </button>
          </span>
        ))}
      </div>
    );
  }

  function renderResourceRow(resource, { catalogMode } = {}) {
    const id = resource.id || resource.catalogId;
    const expanded = expandedId === id;
    return (
      <div
        key={id}
        className="rounded-xl border border-zinc-200/80 dark:border-zinc-700/80 bg-white/70 dark:bg-zinc-900/50 p-3"
      >
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-sm font-medium text-zinc-800 dark:text-zinc-100 truncate">
                {resource.display_name || resource.name}
              </span>
              <span className="text-[10px] px-1.5 py-0.5 rounded bg-zinc-100 dark:bg-zinc-800 text-zinc-500">
                {typeBadge(resource.type, t)}
              </span>
              {!catalogMode && (
                <span className="text-[10px] text-zinc-400">{sourceLabel(resource.source, t)}</span>
              )}
            </div>
            {resource.description && (
              <p className="text-xs text-zinc-500 dark:text-zinc-400 mt-1 line-clamp-2">{resource.description}</p>
            )}
            {!catalogMode && resource.type === 'skill' && (() => {
              const loc = getSkillLocation(resource);
              return (
                <p className="text-[11px] text-zinc-400 mt-1 font-mono truncate">
                  <span className="text-zinc-500">{t('resources.skillLocation')}：</span>
                  {loc ? (
                    <button
                      type="button"
                      className="hover:text-violet-600 dark:hover:text-violet-400 hover:underline truncate align-baseline max-w-full"
                      title={loc}
                      onClick={() => handleOpenPath(loc)}
                    >
                      {loc}
                    </button>
                  ) : (
                    t('resources.skillLocationPending')
                  )}
                </p>
              );
            })()}
            {(resource.metadata?.tags || []).length > 0 && (
              <div className="flex flex-wrap gap-1 mt-1.5">
                {resource.metadata.tags.map(tag => (
                  <span key={tag} className="text-[10px] px-1.5 py-0.5 rounded bg-zinc-50 dark:bg-zinc-800 text-zinc-400">
                    {tag}
                  </span>
                ))}
              </div>
            )}
            {!catalogMode && renderProjections(resource)}
          </div>
          <div className="flex shrink-0 flex-wrap gap-1.5 justify-end">
            {catalogMode ? (
              <button
                type="button"
                disabled={!!busy || resource.installed}
                onClick={() => handleInstall(resource.catalogId)}
                className="text-xs px-2.5 py-1 rounded-lg bg-violet-600 text-white hover:bg-violet-700 disabled:opacity-50"
              >
                {busy === resource.catalogId ? t('resources.busy') : resource.installed ? t('resources.managed') : t('resources.addManage')}
              </button>
            ) : (
              <>
                <button
                  type="button"
                  className="text-xs px-2.5 py-1 rounded-lg border border-zinc-200 dark:border-zinc-600 hover:bg-zinc-50 dark:hover:bg-zinc-800"
                  onClick={() => openEditEditor(resource)}
                  disabled={!!busy}
                >
                  {t('resources.edit')}
                </button>
                <button
                  type="button"
                  className="text-xs px-2.5 py-1 rounded-lg border border-zinc-200 dark:border-zinc-600 hover:bg-zinc-50 dark:hover:bg-zinc-800"
                  onClick={() => setExpandedId(expanded ? null : id)}
                >
                  {expanded ? t('resources.collapse') : t('resources.preview')}
                </button>
                <button
                  type="button"
                  disabled={!!busy}
                  onClick={(e) => openProjectMenu(e, resource.id)}
                  className="text-xs px-2.5 py-1 rounded-lg bg-violet-600 text-white hover:bg-violet-700 disabled:opacity-50"
                >
                  {busy === resource.id ? t('resources.busy') : t('resources.project')}
                </button>
                {resource.source !== 'builtin' && (
                  <button
                    type="button"
                    disabled={!!busy}
                    onClick={() => handleDelete(resource)}
                    className="text-xs px-2.5 py-1 rounded-lg border border-red-200 text-red-600 hover:bg-red-50 dark:border-red-900 dark:hover:bg-red-950/30"
                  >
                    {t('resources.delete')}
                  </button>
                )}
              </>
            )}
          </div>
        </div>
        {expanded && !catalogMode && (
          <pre className="mt-3 text-[11px] leading-relaxed p-3 rounded-lg bg-zinc-50 dark:bg-zinc-950 text-zinc-600 dark:text-zinc-300 overflow-x-auto max-h-48 whitespace-pre-wrap">
            {(resource.content || '').slice(0, 4000)}
          </pre>
        )}
      </div>
    );
  }

  function renderProjectMenu() {
    if (!projectMenu) return null;
    const resource = resources.find(r => r.id === projectMenu.resourceId);
    return createPortal(
      <div
        ref={projectMenuRef}
        className="fixed z-[9999] w-56 rounded-xl border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-800 shadow-lg overflow-hidden"
        style={{ left: projectMenu.x, top: projectMenu.y }}
      >
        <div className="px-3 py-2 border-b border-zinc-100 dark:border-zinc-700">
          <p className="text-xs font-medium text-zinc-700 dark:text-zinc-200">{t('resources.projectTo')}</p>
          {resource?.type !== 'skill' && (
            <p className="text-[10px] text-zinc-400 mt-0.5">{t('resources.nonSkillHint')}</p>
          )}
        </div>
        <div className="max-h-48 overflow-y-auto p-2 space-y-1">
          {agents.map(a => (
            <label key={a.id} className="flex items-center gap-2 px-2 py-1.5 rounded-lg hover:bg-zinc-50 dark:hover:bg-zinc-700/50 cursor-pointer text-xs">
              <input
                type="checkbox"
                checked={projectSelected.includes(a.id)}
                onChange={() => setProjectSelected(prev =>
                  prev.includes(a.id) ? prev.filter(x => x !== a.id) : [...prev, a.id],
                )}
              />
              <span>{a.label}</span>
            </label>
          ))}
        </div>
        <div className="p-2 border-t border-zinc-100 dark:border-zinc-700 flex gap-2">
          <button
            type="button"
            className="flex-1 text-xs py-1.5 rounded-lg border border-zinc-200 dark:border-zinc-600"
            onClick={() => setProjectMenu(null)}
          >
            {t('resources.cancel')}
          </button>
          <button
            type="button"
            className="flex-1 text-xs py-1.5 rounded-lg bg-violet-600 text-white"
            onClick={confirmProject}
          >
            {t('resources.confirmProject')}
          </button>
        </div>
      </div>,
      document.body,
    );
  }

  return (
    <div className="flex flex-col h-full min-h-0">
      <header className="shrink-0 px-6 pt-6 pb-4 border-b border-zinc-200/60 dark:border-zinc-800">
        <h1 className="text-lg font-semibold text-zinc-900 dark:text-zinc-50">{t('resources.title')}</h1>
        <p className="text-xs text-zinc-500 dark:text-zinc-400 mt-1">{t('resources.subtitle')}</p>
      </header>

      <div className="flex-1 min-h-0 overflow-y-auto px-6 py-4 space-y-4">
        {/* 类型筛选 */}
        <div className="flex flex-wrap gap-1.5">
          {TYPE_OPTIONS.map(opt => (
            <button
              key={opt.id || 'all'}
              type="button"
              onClick={() => changeTypeFilter(opt.id)}
              className={`text-xs px-3 py-1 rounded-full border transition-colors ${
                typeFilter === opt.id
                  ? 'bg-violet-600 text-white border-violet-600'
                  : 'border-zinc-200 dark:border-zinc-700 text-zinc-600 dark:text-zinc-400 hover:bg-zinc-50 dark:hover:bg-zinc-800'
              }`}
            >
              {t(opt.labelKey)}
            </button>
          ))}
        </div>

        {/* 子 Tab + 搜索 */}
        <div className="flex flex-wrap items-center gap-3">
          <div className="inline-flex rounded-lg border border-zinc-200 dark:border-zinc-700 p-0.5 bg-zinc-50 dark:bg-zinc-900">
            {[
              ...(showSkillTabs ? [{ id: 'agents', label: t('resources.tab.agents') }] : []),
              { id: 'managed', label: t('resources.tab.managed'), count: managedCount },
              ...(showSkillTabs ? [{ id: 'discovered', label: t('resources.tab.discovered'), count: discoveredCount }] : []),
              { id: 'catalog', label: t('resources.tab.catalog'), count: filteredCatalog.length },
            ].map(tab => (
              <button
                key={tab.id}
                type="button"
                onClick={() => changeViewTab(tab.id)}
                className={`text-xs px-3 py-1.5 rounded-md transition-colors ${
                  viewTab === tab.id
                    ? 'bg-white dark:bg-zinc-800 shadow-sm text-zinc-900 dark:text-zinc-100'
                    : 'text-zinc-500 hover:text-zinc-700 dark:hover:text-zinc-300'
                }`}
              >
                {tab.label}
                {tab.count != null && <span className="ml-1 opacity-60">({tab.count})</span>}
              </button>
            ))}
          </div>
          <input
            type="search"
            value={query}
            onChange={e => setQuery(e.target.value)}
            placeholder={t('resources.searchPlaceholder')}
            className="flex-1 min-w-[160px] max-w-xs text-xs px-3 py-1.5 rounded-lg border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-900"
          />
          <button
            type="button"
            onClick={loadAll}
            className="text-xs px-3 py-1.5 rounded-lg border border-zinc-200 dark:border-zinc-700 hover:bg-zinc-50 dark:hover:bg-zinc-800"
          >
            {t('resources.refresh')}
          </button>
          <button
            type="button"
            disabled={!!busy}
            onClick={openCreateEditor}
            className="text-xs px-3 py-1.5 rounded-lg bg-violet-600 text-white hover:bg-violet-700 disabled:opacity-50"
          >
            {t('resources.create')}
          </button>
          <button
            type="button"
            disabled={!!busy}
            onClick={handleImportFile}
            className="text-xs px-3 py-1.5 rounded-lg border border-violet-200 dark:border-violet-700 text-violet-700 dark:text-violet-300 hover:bg-violet-50 dark:hover:bg-violet-900/30 disabled:opacity-50"
          >
            {busy === 'import' ? t('resources.busy') : t('resources.import')}
          </button>
        </div>

        {msg && <p className="text-xs text-violet-600 dark:text-violet-400">{msg}</p>}
        {error && <p className="text-xs text-red-500">{error}</p>}

        {loading ? (
          <p className="text-xs text-zinc-400 py-8 text-center">{t('resources.loading')}</p>
        ) : viewTab === 'agents' ? (
          !showSkillTabs ? (
            <p className="text-xs text-zinc-400 text-center py-8">{t('resources.discoveredSkillOnly')}</p>
          ) : visibleAgents.length === 0 ? (
            <p className="text-xs text-zinc-400 text-center py-8">{t('resources.noAgents')}</p>
          ) : (
            <div className="space-y-3">
              {renderAgentTabs()}
              {activeAgent && (
                <p className="text-[11px] text-zinc-400 truncate" title={activeAgent.path}>
                  {activeAgent.label} · {activeAgent.exists ? activeAgent.path : t('resources.agentSkillPath')}
                </p>
              )}
              <p className="text-[11px] text-zinc-400">
                {t('resources.agentLegend')}
                <span className="text-emerald-600 dark:text-emerald-400"> {t('resources.badge.tbSync')}</span>
                ·
                <span className="text-sky-600 dark:text-sky-400"> {t('resources.badge.client')}</span>
              </p>
              <div className="bg-white dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-800 rounded-2xl divide-y divide-zinc-100 dark:divide-zinc-700">
                {currentAgentItems.length === 0 ? (
                  <div className="p-5 text-center space-y-2">
                    <p className="text-xs text-zinc-400">{activeAgent?.label} {t('resources.noAgents')}</p>
                    <button type="button" onClick={() => changeViewTab('managed')} className="text-xs text-violet-600 hover:underline">
                      {t('resources.goManaged')}
                    </button>
                  </div>
                ) : currentAgentItems.map(renderAgentInstallRow)}
              </div>
            </div>
          )
        ) : viewTab === 'catalog' ? (
          filteredCatalog.length === 0 ? (
            <p className="text-xs text-zinc-400 text-center py-8">{t('resources.emptyCatalog')}</p>
          ) : (
            <div className="space-y-2">
              {filteredCatalog.map(item => renderResourceRow(item, { catalogMode: true }))}
            </div>
          )
        ) : viewTab === 'discovered' ? (
          !showSkillTabs ? (
            <p className="text-xs text-zinc-400 text-center py-8">{t('resources.discoveredSkillOnly')}</p>
          ) : discovered.length === 0 ? (
            <div className="text-center py-10 space-y-2">
              <p className="text-xs text-zinc-400">{t('resources.emptyDiscovered')}</p>
              {scanStats && (
                <p className="text-[11px] text-zinc-400">
                  {t('resources.scanSummary', {
                    total: scanStats.totalOnDisk,
                    managed: scanStats.managedCount,
                  })}
                </p>
              )}
            </div>
          ) : (
            <div className="space-y-2">
              <p className="text-[11px] text-zinc-400">
                {t('resources.discoveredHint')}
                {scanStats && (
                  <span className="ml-2 opacity-80">
                    {t('resources.scanSummary', {
                      total: scanStats.totalOnDisk,
                      managed: scanStats.managedCount,
                    })}
                  </span>
                )}
              </p>
              {discovered.map(item => renderDiscoveredRow(item))}
            </div>
          )
        ) : viewTab === 'managed' && resources.length === 0 ? (
          <div className="text-center py-10 space-y-2">
            <p className="text-xs text-zinc-400">{t('resources.emptyManaged')}</p>
            <button
              type="button"
              onClick={() => changeViewTab(showSkillTabs ? 'discovered' : 'catalog')}
              className="text-xs text-violet-600 hover:underline"
            >
              {showSkillTabs ? t('resources.goDiscovered') : t('resources.goCatalog')}
            </button>
          </div>
        ) : viewTab === 'managed' ? (
          <div className="space-y-2">
            {resources.map(r => renderResourceRow(r))}
          </div>
        ) : null}

        <p className="text-[11px] text-zinc-400 pt-2">{t('resources.footerHint')}</p>
      </div>

      {renderProjectMenu()}

      {editorOpen && (
        <div className="fixed inset-0 z-[9998] flex items-center justify-center p-4 bg-black/40">
          <div className="w-full max-w-lg max-h-[90vh] overflow-y-auto rounded-2xl border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 shadow-xl">
            <div className="px-4 py-3 border-b border-zinc-100 dark:border-zinc-800">
              <h3 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">
                {editorForm.id ? t('resources.editTitle') : t('resources.createTitle')}
              </h3>
              <p className="text-[11px] text-zinc-400 mt-1">{t('resources.editorHint')}</p>
            </div>
            <div className="p-4 space-y-3">
              <label className="block text-xs text-zinc-500">
                {t('resources.editorType')}
                <select
                  value={editorForm.type}
                  disabled={!!editorForm.id}
                  onChange={e => setEditorForm(prev => ({ ...prev, type: e.target.value }))}
                  className="mt-1 w-full text-xs px-2 py-1.5 rounded-lg border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-950"
                >
                  {TYPE_OPTIONS.filter(o => o.id && o.id !== 'template').map(opt => (
                    <option key={opt.id} value={opt.id}>{t(opt.labelKey)}</option>
                  ))}
                </select>
              </label>
              <label className="block text-xs text-zinc-500">
                {t('resources.editorName')}
                <input
                  value={editorForm.name}
                  disabled={!!editorForm.id}
                  onChange={e => setEditorForm(prev => ({ ...prev, name: e.target.value }))}
                  placeholder="code-review"
                  className="mt-1 w-full text-xs px-2 py-1.5 rounded-lg border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-950 font-mono"
                />
              </label>
              <label className="block text-xs text-zinc-500">
                {t('resources.editorDisplayName')}
                <input
                  value={editorForm.display_name}
                  onChange={e => setEditorForm(prev => ({ ...prev, display_name: e.target.value }))}
                  className="mt-1 w-full text-xs px-2 py-1.5 rounded-lg border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-950"
                />
              </label>
              <label className="block text-xs text-zinc-500">
                {t('resources.editorDescription')}
                <input
                  value={editorForm.description}
                  onChange={e => setEditorForm(prev => ({ ...prev, description: e.target.value }))}
                  className="mt-1 w-full text-xs px-2 py-1.5 rounded-lg border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-950"
                />
              </label>
              {editorForm.type === 'assistant' && (
                <p className="text-[11px] text-zinc-400">{t('resources.assistantRuntimeHint')}</p>
              )}
              <label className="block text-xs text-zinc-500">
                {t('resources.editorContent')}
                <textarea
                  value={editorForm.content}
                  onChange={e => setEditorForm(prev => ({ ...prev, content: e.target.value }))}
                  rows={12}
                  spellCheck={false}
                  placeholder={
                    editorForm.type === 'skill'
                      ? '---\nname: my-skill\ndescription: ...\n---\n\n# Skill'
                      : editorForm.type === 'assistant'
                        ? '{\n  "system_prompt": "你是…",\n  "runtime_agent": "claude-code",\n  "prompts": ["code-review"],\n  "skills": ["git-commit"]\n}'
                        : ''
                  }
                  className="mt-1 w-full text-xs px-2 py-1.5 rounded-lg border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-950 font-mono leading-relaxed"
                />
              </label>
            </div>
            <div className="px-4 py-3 border-t border-zinc-100 dark:border-zinc-800 flex gap-2 justify-end">
              <button
                type="button"
                onClick={() => setEditorOpen(false)}
                className="text-xs px-3 py-1.5 rounded-lg border border-zinc-200 dark:border-zinc-600"
              >
                {t('resources.cancel')}
              </button>
              <button
                type="button"
                disabled={!!busy}
                onClick={saveEditor}
                className="text-xs px-3 py-1.5 rounded-lg bg-violet-600 text-white disabled:opacity-50"
              >
                {busy === 'editor' ? t('resources.busy') : t('resources.save')}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
