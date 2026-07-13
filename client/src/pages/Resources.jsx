import React, { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import ServiceIcon from '../components/ServiceIcon';
import { useLang } from '../store/lang';

const VIEW_TAB_KEY = 'tokenbank.resources.viewTab';
const TYPE_FILTER_KEY = 'tokenbank.resources.typeFilter';
const SCAN_SCOPE_KEY = 'tokenbank.resources.scanScope';
const SCAN_CUSTOM_DIR_KEY = 'tokenbank.resources.scanCustomDir';
const APP_FILTER_KEY = 'tokenbank.resources.appFilter';
const IDLE_DAYS_KEY = 'tokenbank.resources.idleDays';
const DEFAULT_IDLE_DAYS = 60;

function readIdleDays() {
  try {
    const n = Number(localStorage.getItem(IDLE_DAYS_KEY));
    if (Number.isFinite(n) && n >= 1 && n <= 3650) return Math.floor(n);
  } catch {}
  return DEFAULT_IDLE_DAYS;
}

function saveIdleDays(days) {
  try { localStorage.setItem(IDLE_DAYS_KEY, String(days)); } catch {}
}

// `.agents` / 自定义扫描等是公共 skill 目录，不是可筛选的 Agent 应用
const NON_AGENT_APP_IDS = new Set(['agents-hub', 'custom', 'aweskill']);

function isAgentAppId(agentId) {
  return !!agentId && !NON_AGENT_APP_IDS.has(agentId);
}

function readScanScope() {
  try {
    const v = localStorage.getItem(SCAN_SCOPE_KEY);
    // 未设置时默认全局目录
    if (!v) return 'global';
    return v === 'custom' ? 'custom' : 'global';
  } catch { return 'global'; }
}

function saveScanScope(scope) {
  try { localStorage.setItem(SCAN_SCOPE_KEY, scope); } catch {}
}

function readScanCustomDir() {
  try { return localStorage.getItem(SCAN_CUSTOM_DIR_KEY) || ''; } catch { return ''; }
}

function saveScanCustomDir(dir) {
  try { localStorage.setItem(SCAN_CUSTOM_DIR_KEY, dir || ''); } catch {}
}


const TYPE_OPTIONS = [
  { id: 'prompt', labelKey: 'resources.type.prompt' },
  { id: 'skill', labelKey: 'resources.type.skill' },
  { id: 'assistant', labelKey: 'resources.type.assistant' },
];

function readViewTab() {
  try {
    const v = localStorage.getItem(VIEW_TAB_KEY);
    // 默认「已纳管」；旧的 'discovered' / 'agents' 都归并到 'managed'
    if (v === 'catalog' || v === 'managed') return v;
    return 'managed';
  } catch { return 'managed'; }
}

function saveViewTab(tab) {
  try { localStorage.setItem(VIEW_TAB_KEY, tab); } catch {}
}

function readTypeFilter() {
  try {
    const v = localStorage.getItem(TYPE_FILTER_KEY) || '';
    // 已去掉「全部」；空值 / 旧 template 默认落到 skill
    if (v === 'prompt' || v === 'skill' || v === 'assistant') return v;
    return 'skill';
  } catch { return 'skill'; }
}

function saveTypeFilter(type) {
  try { localStorage.setItem(TYPE_FILTER_KEY, type || 'skill'); } catch {}
}

function readAppFilter() {
  try { return localStorage.getItem(APP_FILTER_KEY) || ''; } catch { return ''; }
}

function saveAppFilter(agentId) {
  try { localStorage.setItem(APP_FILTER_KEY, agentId || ''); } catch {}
}

function typeBadge(type, t) {
  const map = {
    prompt: t('resources.type.prompt'),
    skill: t('resources.type.skill'),
    assistant: t('resources.type.assistant'),
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
  if (!resource) return null;
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

/** 路径归一化后比较（判断是否同一权威目录） */
function sameSkillDir(a, b) {
  if (!a || !b) return false;
  const norm = (p) => String(p).replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
  return norm(a) === norm(b);
}

/** 该投射是否指向权威源（唯一不可取消） */
function isAuthorityProjection(proj, authorityPath) {
  return sameSkillDir(proj?.targetPath, authorityPath);
}

/**
 * 可取消投射：非权威的软链/副本/其它位置实体均可 ×
 * 权威源仅保留一处，用「卸载」删除；无权威路径时 scan 不拦截（避免死锁）
 */
function canUnprojectProjection(proj, authorityPath) {
  if (!proj || !isAgentAppId(proj.agentId)) return false;
  if (isAuthorityProjection(proj, authorityPath)) return false;
  const t = proj.projectionType;
  if (t === 'symlink' || t === 'copy') return true;
  // 纯 DB 标记型投射（智能体 reference / 提示词 mcp）无权威目录顾虑，始终可取消
  if (t === 'reference' || t === 'mcp') return true;
  if (t === 'scan' || t === 'origin') {
    // 能识别权威源时，其它位置才可取消；识别不了则不挡卸载
    return !!authorityPath;
  }
  return false;
}

/** 资产页：Prompt / Skill / Assistant 纳管与投射 */
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
  const [agents, setAgents] = useState([]);
  const [promptAgents, setPromptAgents] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState('');
  const [msg, setMsg] = useState('');
  const [expandedId, setExpandedId] = useState(null);
  const [projectMenu, setProjectMenu] = useState(null);
  const [projectSelected, setProjectSelected] = useState([]);
  const [editorOpen, setEditorOpen] = useState(false);
  const [editorForm, setEditorForm] = useState(EMPTY_EDITOR);
  const [scanScope, setScanScope] = useState(readScanScope);
  const [customScanDir, setCustomScanDir] = useState(readScanCustomDir);
  const [scanning, setScanning] = useState(false);
  const [scanExpanded, setScanExpanded] = useState(false);
  const [appFilter, setAppFilter] = useState(readAppFilter);
  /** Skill 闲置清理 */
  const [cleanupOpen, setCleanupOpen] = useState(false);
  const [idleLoading, setIdleLoading] = useState(false);
  const [idleResult, setIdleResult] = useState(null);
  const [idleSelected, setIdleSelected] = useState([]);
  const [idleDays, setIdleDays] = useState(readIdleDays);
  const projectMenuRef = useRef(null);

  const scanFilters = useCallback(() => ({
    query: query || undefined,
    scanScope,
    customDirs: scanScope === 'custom' && customScanDir.trim()
      ? [customScanDir.trim()]
      : [],
    includeManaged: true,
  }), [query, scanScope, customScanDir]);

  const loadBase = useCallback(async () => {
    if (!window.electronAPI?.resource) {
      setLoading(false);
      setError(t('resources.desktopOnly'));
      return;
    }
    setLoading(true);
    setError('');
    try {
      const filters = { type: typeFilter || undefined, query: query || undefined };
      const [catRes, resRes, agentRes] = await Promise.all([
        window.electronAPI.resource.listCatalog(filters),
        window.electronAPI.resource.listResources(filters),
        window.electronAPI.resource.listAgentTargets(),
      ]);
      if (catRes.success) setCatalog(catRes.items || []);
      else setError(catRes.error || t('resources.loadFailed'));
      if (resRes.success) setResources(resRes.resources || []);
      if (agentRes.success) setAgents(agentRes.agents || []);
      if (agentRes.success) setPromptAgents(agentRes.promptAgents || []);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, [typeFilter, query, t]);

  const runScan = useCallback(async () => {
    if (!window.electronAPI?.resource) return;
    if (scanScope === 'custom' && !customScanDir.trim()) {
      setMsg('');
      setError(t('resources.scanCustomDirRequired'));
      return;
    }
    setScanning(true);
    setError('');
    setMsg('');
    try {
      const filters = scanFilters();
      const [scanRes, installRes] = await Promise.all([
        // 扫描即纳管：本机扫描到的 skill 即已纳管 skill
        window.electronAPI.resource.syncDiscovered(filters),
        window.electronAPI.resource.listAgentInstallations(filters),
      ]);
      if (scanRes.success) {
        setDiscovered(scanRes.items || []);
        setScanStats(scanRes.scanStats || null);
      } else {
        setError(scanRes.error || t('resources.scanFailed'));
      }
      if (installRes.success) {
        // agentInstallations 仅用于「来源应用筛选」选项聚合
        setAgentInstallations(installRes.agents || []);
      }
      if (scanRes.success) setMsg(t('resources.scanDone'));
    } catch (e) {
      setError(e.message);
    } finally {
      setScanning(false);
    }
  }, [scanFilters, scanScope, customScanDir, t]);

  const loadAll = useCallback(async () => {
    // 先扫描即纳管（入库），再读取 resources，确保投射菜单能查到刚纳管的 skill
    await runScan();
    await loadBase();
  }, [loadBase, runScan]);

  useEffect(() => { loadAll(); }, [loadAll]);

  // 成功提示 3 秒后自动消失
  useEffect(() => {
    if (!msg) return undefined;
    const timer = setTimeout(() => setMsg(''), 3000);
    return () => clearTimeout(timer);
  }, [msg]);

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
  }

  function changeTypeFilter(type) {
    setTypeFilter(type);
    saveTypeFilter(type);
  }

  function changeAppFilter(agentId) {
    setAppFilter(agentId);
    saveAppFilter(agentId);
  }

  function changeScanScope(scope) {
    setScanScope(scope);
    saveScanScope(scope);
  }

  function changeCustomScanDir(dir) {
    setCustomScanDir(dir);
    saveScanCustomDir(dir);
  }

  async function pickCustomScanDir() {
    if (!window.electronAPI?.resource?.pickImportPath) return;
    try {
      const pick = await window.electronAPI.resource.pickImportPath({
        title: t('resources.scanPickDirTitle'),
        allowFile: false,
        allowDirectory: true,
      });
      if (pick.success && pick.path) changeCustomScanDir(pick.path);
    } catch (e) {
      setError(e.message);
    }
  }

  function toggleScanPanel() {
    setScanExpanded(v => !v);
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

  async function handleOpenPath(targetPath) {
    if (!targetPath || !window.electronAPI?.resource?.openPath) return;
    try {
      const res = await window.electronAPI.resource.openPath({ targetPath });
      if (!res?.success) alert(res?.error || t('resources.openPathFailed'));
    } catch (e) {
      alert(e.message);
    }
  }

  /** 局部更新某资产的投射列表（避免 loadAll 整页抖动） */
  function applyResourcePatch(resourceId, nextResource) {
    const projections = nextResource?.projections || [];
    setResources(prev => prev.map(r => (
      r.id === resourceId
        ? { ...r, ...nextResource, projections }
        : r
    )));
    setDiscovered(prev => prev.map(item => (
      item.resourceId === resourceId
        ? { ...item, projections }
        : item
    )));
  }

  /** 局部移除已卸载/删除的资产 */
  function removeResourceLocally(resourceId) {
    setResources(prev => prev.filter(r => r.id !== resourceId));
    // Skill 卸载会删权威目录，本机列表中对应行一并移除
    setDiscovered(prev => prev.filter(item => item.resourceId !== resourceId));
    setScanStats(prev => (prev && typeof prev.totalOnDisk === 'number'
      ? { ...prev, totalOnDisk: Math.max(0, prev.totalOnDisk - 1) }
      : prev));
  }

  async function handleDelete(resource) {
    if (!window.confirm(t('resources.deleteConfirm', { name: resource.display_name || resource.name }))) return;
    setBusy(resource.id);
    try {
      const res = await window.electronAPI.resource.deleteResource(resource.id);
      if (!res.success) {
        alert(res.error || t('resources.deleteFailed'));
        return;
      }
      removeResourceLocally(resource.id);
    } finally {
      setBusy('');
    }
  }

  /** 是否仍有可取消的非权威投射（须先取消再卸载） */
  function hasProjectedLinks(projections, authorityPath) {
    return (projections || []).some(p => canUnprojectProjection(p, authorityPath));
  }

  /** Skill 卸载：有其它投射则提示先取消；否则确认后删除权威目录 */
  async function handleUninstallSkill(item) {
    const resourceId = item.resourceId || item.id;
    if (!resourceId) return;
    const authorityPath = item.authorityPath || getSkillLocation(item);
    if (hasProjectedLinks(item.projections, authorityPath)) {
      alert(t('resources.uninstallNeedUnproject'));
      return;
    }
    const name = item.display_name || item.name;
    if (!window.confirm(t('resources.uninstallConfirm', { name }))) return;
    setBusy(resourceId);
    try {
      const res = await window.electronAPI.resource.deleteResource(resourceId);
      if (!res.success) {
        alert(res.error || t('resources.uninstallFailed'));
        return;
      }
      removeResourceLocally(resourceId);
    } finally {
      setBusy('');
    }
  }

  /** 按指定天数扫描闲置 Skill */
  async function scanIdleSkills(days = idleDays, { closeOnError = false } = {}) {
    if (!window.electronAPI?.resource?.listIdleSkills) return;
    const n = Math.max(1, Math.min(3650, Math.floor(Number(days) || DEFAULT_IDLE_DAYS)));
    setIdleDays(n);
    saveIdleDays(n);
    setIdleLoading(true);
    setIdleResult(null);
    setIdleSelected([]);
    try {
      const res = await window.electronAPI.resource.listIdleSkills({ days: n });
      if (!res.success) {
        alert(res.error || t('resources.cleanupScanFailed'));
        if (closeOnError) setCleanupOpen(false);
        return;
      }
      setIdleResult(res);
      setIdleSelected((res.items || []).map(i => i.id));
    } catch (e) {
      alert(e.message);
      if (closeOnError) setCleanupOpen(false);
    } finally {
      setIdleLoading(false);
    }
  }

  /** 打开闲置 Skill 清理面板并扫描 */
  async function openSkillCleanup() {
    if (!window.electronAPI?.resource?.listIdleSkills) return;
    setCleanupOpen(true);
    await scanIdleSkills(idleDays, { closeOnError: true });
  }

  function applyIdleDays(raw) {
    const n = Math.max(1, Math.min(3650, Math.floor(Number(raw) || DEFAULT_IDLE_DAYS)));
    setIdleDays(n);
    saveIdleDays(n);
  }

  function toggleIdleSelected(id) {
    setIdleSelected(prev => (
      prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id]
    ));
  }

  function toggleIdleSelectAll() {
    const all = (idleResult?.items || []).map(i => i.id);
    setIdleSelected(prev => (prev.length === all.length ? [] : all));
  }

  /** 一键清理勾选的闲置 Skill */
  async function confirmSkillCleanup() {
    if (!idleSelected.length) {
      alert(t('resources.cleanupPick'));
      return;
    }
    if (!window.confirm(t('resources.cleanupConfirm', { n: idleSelected.length, days: idleDays }))) {
      return;
    }
    setBusy('cleanup');
    try {
      const res = await window.electronAPI.resource.cleanupSkills({ resourceIds: idleSelected });
      if (!res.success && !res.cleaned) {
        alert(res.error || t('resources.cleanupFailed'));
        return;
      }
      const failed = (res.results || []).filter(r => !r.success);
      for (const r of res.results || []) {
        if (r.success) removeResourceLocally(r.id);
      }
      setCleanupOpen(false);
      setIdleResult(null);
      setIdleSelected([]);
      if (failed.length) {
        alert(t('resources.cleanupPartial', {
          ok: res.cleaned || 0,
          fail: failed.length,
        }));
      } else {
        setMsg(t('resources.cleanupOk', { n: res.cleaned || 0 }));
      }
      await loadAll();
    } catch (e) {
      alert(e.message);
    } finally {
      setBusy('');
    }
  }

  function formatIdleTime(ms) {
    if (!ms) return t('resources.cleanupNever');
    try {
      return new Date(ms).toLocaleString();
    } catch {
      return String(ms);
    }
  }

  async function openProjectMenu(e, resourceId) {
    const rect = e.currentTarget.getBoundingClientRect();
    setProjectSelected([]);
    setProjectMenu({ resourceId, x: rect.left, y: rect.bottom + 4 });

    // 打开时刷新可投射 Agent（MCP 可能刚在供给源页安装，避免列表过期）
    if (!window.electronAPI?.resource?.listAgentTargets) return;
    try {
      const agentRes = await window.electronAPI.resource.listAgentTargets();
      if (!agentRes.success) return;
      setAgents(agentRes.agents || []);
      setPromptAgents(agentRes.promptAgents || []);
    } catch { /* ignore */ }
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
      // 目标处存在同名的其他目录：默认不覆盖，询问后再强制
      if (res.conflicts?.length
        && window.confirm(`${res.hint}\n\n是否强制覆盖并投射？这会删除目标位置的同名目录，不可撤销。`)) {
        const forced = await window.electronAPI.resource.project({
          resourceId,
          agentIds: projectSelected,
          force: true,
        });
        alert(forced.success ? (forced.hint || t('resources.projectOk')) : (forced.error || t('resources.projectFailed')));
      } else {
        alert(res.hint || t('resources.projectOk'));
      }
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
      if (!res.success) {
        alert(res.error || t('resources.unprojectFailed'));
        return;
      }
      // 用返回的最新投射列表局部更新，不整页刷新
      if (res.resource) applyResourcePatch(resource.id, res.resource);
      else {
        const nextProjs = (resource.projections || []).filter(p => p.agentId !== agentId);
        applyResourcePatch(resource.id, { ...resource, projections: nextProjs });
      }
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

  /** Skill 类型：引导用户在 Agent / Debug 安装后扫描纳管 */
  function handleSkillInstallHint() {
    alert(t('resources.skillInstallHint'));
    setScanExpanded(true);
    setMsg(t('resources.skillInstallHintShort'));
  }

  function handlePrimaryAction() {
    if (typeFilter === 'skill') {
      handleSkillInstallHint();
      return;
    }
    openCreateEditor();
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
  const discoveredCount = scanStats?.totalOnDisk ?? discovered.length;
  const showSkillTabs = !typeFilter || typeFilter === 'skill';
  // 「本机」Tab 计数：技能=磁盘总数;提示词/助手=该类型已纳管数;全部=非 skill 已纳管 + 磁盘 skill
  const localCount = typeFilter === 'skill'
    ? discoveredCount
    : typeFilter
      ? managedCount
      : resources.filter(r => r.type !== 'skill').length + discoveredCount;

  // 从扫描结果汇总可选应用，供「应用筛选」使用（排除公共 skill 目录）
  const appFilterOptions = (() => {
    const map = new Map();
    for (const item of discovered) {
      for (const a of item.agents || []) {
        if (!isAgentAppId(a.agentId)) continue;
        if (!map.has(a.agentId)) map.set(a.agentId, a.label || a.agentId);
      }
    }
    for (const inst of agentInstallations) {
      if (!isAgentAppId(inst.id)) continue;
      if (!map.has(inst.id)) map.set(inst.id, inst.label || inst.id);
    }
    return [{ id: '', label: t('resources.appFilterAll') }, ...[...map.entries()]
      .sort((a, b) => a[1].localeCompare(b[1], undefined, { sensitivity: 'base' }))
      .map(([id, label]) => ({ id, label }))];
  })();

  // 若上次筛到了已隐藏的公共目录，回退到全部应用
  const effectiveAppFilter = isAgentAppId(appFilter) || !appFilter ? appFilter : '';

  const filteredDiscovered = effectiveAppFilter
    ? discovered.filter(item => (item.agents || []).some(a => a.agentId === effectiveAppFilter))
    : discovered;

  /** 本机 Skill 列表上方的应用筛选：图标 + 名称 */
  function renderAppFilter() {
    if (!showSkillTabs || appFilterOptions.length <= 1) return null;
    return (
      <div className="flex flex-wrap gap-2">
          {appFilterOptions.map(opt => {
            const active = effectiveAppFilter === opt.id;
            return (
              <button
                key={opt.id || 'all'}
                type="button"
                onClick={() => changeAppFilter(opt.id)}
                className={`inline-flex items-center gap-2 px-3 py-1.5 rounded-full border transition-colors ${
                  active
                    ? 'border-sky-500 bg-sky-50 dark:bg-sky-900/30 shadow-sm'
                    : 'border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-800 hover:border-zinc-300 dark:hover:border-zinc-600'
                }`}
              >
                {opt.id ? (
                  <ServiceIcon
                    id={opt.id}
                    name={opt.label}
                    boxClass="w-5 h-5"
                    imgClass="w-3 h-3"
                    className="!rounded-md"
                  />
                ) : (
                  <ServiceIcon
                    icon="◫"
                    name={opt.label}
                    boxClass="w-5 h-5"
                    imgClass="w-3 h-3"
                    className="!rounded-md"
                  />
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

  function renderDiscoveredRow(item) {
    // 同名 Skill 可能共用 scanKey（frontmatter name 相同），用 name+hash 保证 key 唯一
    const rowKey = `${item.name}::${item.hash}`;
    return (
      <div
        key={rowKey}
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
              {item.version && (
                <span
                  className="text-[10px] px-1.5 py-0.5 rounded bg-sky-50 dark:bg-sky-900/30 text-sky-700 dark:text-sky-300 font-mono"
                  title={t('resources.skillVersion')}
                >
                  {/^v/i.test(item.version) ? item.version : `v${item.version}`}
                </span>
              )}
              {item.contentChanged && (
                <span className="text-[10px] px-1.5 py-0.5 rounded bg-amber-100 dark:bg-amber-900/40 text-amber-700 dark:text-amber-300">
                  {t('resources.contentChanged')}
                </span>
              )}
            </div>
            {item.description && (
              <p className="text-xs text-zinc-500 dark:text-zinc-400 mt-1 line-clamp-2">{item.description}</p>
            )}
            {/* 具体 skill 路径（点击打开原始安装目录） */}
            {item.authorityPath && (
              <p className="text-[11px] text-zinc-400 mt-1.5 font-mono truncate">
                <button
                  type="button"
                  className="hover:text-violet-600 dark:hover:text-violet-400 hover:underline text-left truncate max-w-full"
                  title={item.authorityPath}
                  onClick={() => handleOpenPath(item.authorityPath)}
                >
                  {item.authorityPath}
                </button>
              </p>
            )}
            {/* 映射到哪些 App（软链投射，可 × 取消），与提示词/智能体一致 */}
            {item.resourceId && renderProjections({
              id: item.resourceId,
              type: 'skill',
              projections: item.projections,
              authorityPath: item.authorityPath,
            })}
          </div>
          <div className="flex shrink-0 flex-col items-end gap-1.5">
            {item.resourceId && (
              <>
                <button
                  type="button"
                  disabled={!!busy}
                  onClick={(e) => openProjectMenu(e, item.resourceId)}
                  className="text-xs px-2.5 py-1 rounded-lg bg-violet-600 text-white hover:bg-violet-700 disabled:opacity-50"
                >
                  {busy === item.resourceId ? t('resources.busy') : t('resources.project')}
                </button>
                <button
                  type="button"
                  disabled={!!busy}
                  onClick={() => handleUninstallSkill(item)}
                  className="text-xs px-2.5 py-1 rounded-lg border border-red-200 text-red-600 hover:bg-red-50 dark:border-red-900 dark:hover:bg-red-950/30 disabled:opacity-50"
                  title={hasProjectedLinks(item.projections, item.authorityPath || getSkillLocation(item))
                    ? t('resources.uninstallNeedUnproject')
                    : undefined}
                >
                  {busy === item.resourceId ? t('resources.busy') : t('resources.uninstall')}
                </button>
              </>
            )}
          </div>
        </div>
      </div>
    );
  }

  function renderProjections(resource) {
    // 只展示真实 Agent 应用的投射；.agents / custom 等公共目录不显示为应用标签
    const projs = (resource.projections || []).filter(p => isAgentAppId(p.agentId));
    const authorityPath = resource.authorityPath || getSkillLocation(resource);
    if (!projs.length) {
      return <span className="text-[10px] text-zinc-400">{t('resources.notProjected')}</span>;
    }
    return (
      <div className="flex flex-wrap gap-1.5 mt-1">
        {projs.map(p => {
          // 权威源唯一不可取消；其它软链/副本/多余实体均可 ×
          const canUnproject = canUnprojectProjection(p, authorityPath);
          const isAuthority = isAuthorityProjection(p, authorityPath);
          let typeLabel;
          if (isAuthority) {
            typeLabel = t('resources.projType.scan');
          } else if (p.projectionType === 'scan' || p.projectionType === 'origin') {
            typeLabel = t('resources.projType.extra');
          } else {
            const typeKey = `resources.projType.${p.projectionType}`;
            const typeRaw = t(typeKey);
            typeLabel = typeRaw === typeKey ? (p.projectionType || '') : typeRaw;
          }
          const pathLine = p.targetPath
            ? t('resources.projHover', { type: typeLabel, path: p.targetPath })
            : t('resources.projHoverNoPath', { type: typeLabel });
          const hoverTitle = canUnproject
            ? pathLine
            : `${pathLine}\n${t('resources.projAuthorityHint')}`;
          return (
            <span
              key={p.id}
              title={hoverTitle}
              className={`inline-flex items-center gap-1 text-[10px] px-2 py-0.5 rounded-full cursor-default ${
                canUnproject
                  ? 'bg-violet-100 dark:bg-violet-900/40 text-violet-700 dark:text-violet-300'
                  : 'bg-zinc-100 dark:bg-zinc-800 text-zinc-500 dark:text-zinc-400'
              }`}
            >
              {p.label || p.agentId}
              {canUnproject && (
                <button
                  type="button"
                  className="opacity-60 hover:opacity-100"
                  title={t('resources.unproject')}
                  disabled={busy === `${resource.id}-${p.agentId}`}
                  onClick={() => handleUnproject(resource, p.agentId)}
                >
                  ×
                </button>
              )}
            </span>
          );
        })}
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

  /**
   * 「本机」Tab 列表：按类型筛选分流。
   * 技能→扫描行(discovered,带来源应用筛选);提示词/助手→managed 行;全部→非-skill managed 行 + 扫描行。
   */
  function renderLocalList() {
    const showSkills = !typeFilter || typeFilter === 'skill';
    const managedRows = typeFilter === 'skill'
      ? []
      : (typeFilter ? resources : resources.filter(r => r.type !== 'skill'));
    const skillRows = showSkills ? filteredDiscovered : [];

    if (managedRows.length + skillRows.length === 0) {
      // 有本机 skill,但被来源应用筛选过滤空了
      if (showSkills && effectiveAppFilter && discovered.length > 0) {
        return (
          <div className="space-y-3">
            {renderAppFilter()}
            <div className="text-center py-10 space-y-2">
              <p className="text-xs text-zinc-400">{t('resources.emptyDiscoveredFiltered')}</p>
              <button type="button" onClick={() => changeAppFilter('')} className="text-xs text-violet-600 hover:underline">
                {t('resources.clearAppFilter')}
              </button>
            </div>
          </div>
        );
      }
      return (
        <div className="text-center py-10 space-y-2">
          <p className="text-xs text-zinc-400">{t('resources.emptyManaged')}</p>
          <button type="button" onClick={() => changeViewTab('catalog')} className="text-xs text-violet-600 hover:underline">
            {t('resources.goCatalog')}
          </button>
        </div>
      );
    }

    return (
      <div className="space-y-3">
        {showSkills && renderAppFilter()}
        {showSkills && scanStats && (
          <p className="text-[11px] text-zinc-400">
            {t('resources.syncSummary', { n: scanStats.totalOnDisk })}
            {effectiveAppFilter && (
              <span className="ml-2 opacity-80">
                {t('resources.discoveredFilteredCount', { n: skillRows.length })}
              </span>
            )}
          </p>
        )}
        <div className="space-y-2">
          {managedRows.map(r => renderResourceRow(r))}
          {skillRows.map(item => renderDiscoveredRow(item))}
        </div>
      </div>
    );
  }

  function renderProjectMenu() {
    if (!projectMenu) return null;
    const resource = resources.find(r => r.id === projectMenu.resourceId);
    const targetList = resource?.type === 'prompt' ? promptAgents : agents;
    return createPortal(
      <div
        ref={projectMenuRef}
        className="fixed z-[9999] w-56 rounded-xl border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-800 shadow-lg overflow-hidden"
        style={{ left: projectMenu.x, top: projectMenu.y }}
      >
        <div className="px-3 py-2 border-b border-zinc-100 dark:border-zinc-700">
          <p className="text-xs font-medium text-zinc-700 dark:text-zinc-200">{t('resources.projectTo')}</p>
          {resource?.type === 'prompt' ? (
            <p className="text-[10px] text-zinc-400 mt-0.5">{t('resources.promptMcpHint')}</p>
          ) : resource?.type !== 'skill' && (
            <p className="text-[10px] text-zinc-400 mt-0.5">{t('resources.nonSkillHint')}</p>
          )}
        </div>
        <div className="max-h-48 overflow-y-auto p-2 space-y-1">
          {targetList.length === 0 ? (
            <p className="text-[10px] text-zinc-400 px-2 py-1.5">
              {resource?.type === 'prompt'
                ? t('resources.promptNoMcpAgents')
                : t('resources.noProjectAgents')}
            </p>
          ) : targetList.map(a => (
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
            disabled={targetList.length === 0}
            className="flex-1 text-xs py-1.5 rounded-lg bg-violet-600 text-white disabled:opacity-40"
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
              key={opt.id}
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

        {/* 子 Tab + 搜索 + 操作 */}
        <div className="space-y-2">
          <div className="flex flex-wrap items-center gap-3">
            <div className="inline-flex rounded-lg border border-zinc-200 dark:border-zinc-700 p-0.5 bg-zinc-50 dark:bg-zinc-900">
              {[
                { id: 'managed', label: t('resources.tab.managed'), count: localCount },
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
              disabled={!!busy}
              onClick={handlePrimaryAction}
              className="text-xs px-3 py-1.5 rounded-lg bg-violet-600 text-white hover:bg-violet-700 disabled:opacity-50"
            >
              {typeFilter === 'skill' ? t('resources.skillInstall') : t('resources.create')}
            </button>
            <button
              type="button"
              disabled={!!busy}
              onClick={handleImportFile}
              className="text-xs px-3 py-1.5 rounded-lg border border-violet-200 dark:border-violet-700 text-violet-700 dark:text-violet-300 hover:bg-violet-50 dark:hover:bg-violet-900/30 disabled:opacity-50"
            >
              {busy === 'import' ? t('resources.busy') : t('resources.import')}
            </button>
            {showSkillTabs && (
              <button
                type="button"
                onClick={toggleScanPanel}
                className={`text-xs px-3 py-1.5 rounded-lg border transition-colors ${
                  scanExpanded
                    ? 'border-violet-300 dark:border-violet-600 bg-violet-50 dark:bg-violet-900/30 text-violet-700 dark:text-violet-300'
                    : 'border-zinc-200 dark:border-zinc-700 text-zinc-600 dark:text-zinc-400 hover:bg-zinc-50 dark:hover:bg-zinc-800'
                }`}
              >
                {t('resources.scan')}
                <span className="ml-1 opacity-60">{scanExpanded ? '▴' : '▾'}</span>
              </button>
            )}
            {showSkillTabs && viewTab === 'managed' && (
              <button
                type="button"
                disabled={!!busy || idleLoading}
                onClick={openSkillCleanup}
                className="text-xs px-3 py-1.5 rounded-lg border border-amber-200 dark:border-amber-800 text-amber-700 dark:text-amber-300 hover:bg-amber-50 dark:hover:bg-amber-900/20 disabled:opacity-50"
              >
                {idleLoading ? t('resources.cleanupScanning') : t('resources.cleanup')}
              </button>
            )}
          </div>

          {/* 点击「扫描」展开：范围选项 */}
          {showSkillTabs && scanExpanded && (
            <div className="flex flex-wrap items-center gap-3 p-3 rounded-xl border border-zinc-200/80 dark:border-zinc-700/80 bg-zinc-50/50 dark:bg-zinc-900/40">
              <span className="text-xs text-zinc-500 shrink-0">{t('resources.scanScopeLabel')}</span>
              <label className="inline-flex items-center gap-1.5 text-xs text-zinc-700 dark:text-zinc-300 cursor-pointer">
                <input
                  type="radio"
                  name="scanScope"
                  checked={scanScope === 'global'}
                  onChange={() => changeScanScope('global')}
                />
                {t('resources.scanScopeGlobal')}
              </label>
              <label className="inline-flex items-center gap-1.5 text-xs text-zinc-700 dark:text-zinc-300 cursor-pointer">
                <input
                  type="radio"
                  name="scanScope"
                  checked={scanScope === 'custom'}
                  onChange={() => changeScanScope('custom')}
                />
                {t('resources.scanScopeCustom')}
              </label>
              {scanScope === 'custom' && (
                <>
                  <input
                    type="text"
                    value={customScanDir}
                    onChange={e => changeCustomScanDir(e.target.value)}
                    placeholder={t('resources.scanCustomDirPlaceholder')}
                    className="flex-1 min-w-[200px] text-xs px-2.5 py-1.5 rounded-lg border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 font-mono"
                  />
                  <button
                    type="button"
                    onClick={pickCustomScanDir}
                    className="text-xs px-2.5 py-1.5 rounded-lg border border-zinc-200 dark:border-zinc-700 hover:bg-white dark:hover:bg-zinc-800"
                  >
                    {t('resources.scanBrowse')}
                  </button>
                </>
              )}
              <button
                type="button"
                disabled={scanning || !!busy}
                onClick={runScan}
                className="text-xs px-3 py-1.5 rounded-lg bg-violet-600 text-white hover:bg-violet-700 disabled:opacity-50 shrink-0"
              >
                {scanning ? t('resources.scanning') : t('resources.scanStart')}
              </button>
              <p className="w-full text-[11px] text-zinc-400">
                {scanScope === 'global'
                  ? t('resources.scanScopeGlobalHint')
                  : t('resources.scanScopeCustomHint')}
              </p>
            </div>
          )}
        </div>

        {msg && <p className="text-xs text-violet-600 dark:text-violet-400">{msg}</p>}
        {error && <p className="text-xs text-red-500">{error}</p>}

        {loading ? (
          <p className="text-xs text-zinc-400 py-8 text-center">{t('resources.loading')}</p>
        ) : viewTab === 'catalog' ? (
          filteredCatalog.length === 0 ? (
            <p className="text-xs text-zinc-400 text-center py-8">{t('resources.emptyCatalog')}</p>
          ) : (
            <div className="space-y-2">
              {filteredCatalog.map(item => renderResourceRow(item, { catalogMode: true }))}
            </div>
          )
        ) : viewTab === 'managed' ? (
          renderLocalList()
        ) : null}

        <p className="text-[11px] text-zinc-400 pt-2">
          {t(
            typeFilter === 'prompt'
              ? 'resources.footerHint.prompt'
              : typeFilter === 'assistant'
                ? 'resources.footerHint.assistant'
                : 'resources.footerHint',
          )}
        </p>
      </div>

      {renderProjectMenu()}

      {/* 闲置 Skill 清理 */}
      {cleanupOpen && (
        <div className="fixed inset-0 z-[9998] flex items-center justify-center p-4 bg-black/40" onClick={() => !busy && setCleanupOpen(false)}>
          <div
            className="w-full max-w-lg max-h-[85vh] overflow-hidden flex flex-col rounded-2xl border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 shadow-xl"
            onClick={e => e.stopPropagation()}
          >
            <div className="px-4 py-3 border-b border-zinc-100 dark:border-zinc-800 space-y-2">
              <h3 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">
                {t('resources.cleanupTitle')}
              </h3>
              <p className="text-[10px] text-zinc-400">
                {t('resources.cleanupHint', { days: idleDays })}
              </p>
              <div className="flex items-center gap-2">
                <label className="text-[11px] text-zinc-500 dark:text-zinc-400 whitespace-nowrap">
                  {t('resources.cleanupDaysLabel')}
                </label>
                <input
                  type="number"
                  min={1}
                  max={3650}
                  value={idleDays}
                  disabled={idleLoading || busy === 'cleanup'}
                  onChange={e => applyIdleDays(e.target.value)}
                  onKeyDown={e => {
                    if (e.key === 'Enter') {
                      e.preventDefault();
                      scanIdleSkills(idleDays);
                    }
                  }}
                  className="w-20 px-2 py-1 text-xs rounded-lg border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-800 text-zinc-800 dark:text-zinc-200"
                />
                <span className="text-[11px] text-zinc-400">{t('resources.cleanupDaysUnit')}</span>
                <button
                  type="button"
                  disabled={idleLoading || busy === 'cleanup'}
                  onClick={() => scanIdleSkills(idleDays)}
                  className="ml-auto px-2.5 py-1 text-[11px] rounded-lg border border-zinc-200 dark:border-zinc-700 text-zinc-600 dark:text-zinc-300 hover:bg-zinc-50 dark:hover:bg-zinc-800 disabled:opacity-50"
                >
                  {idleLoading ? t('resources.cleanupScanning') : t('resources.cleanupRescan')}
                </button>
              </div>
            </div>
            <div className="flex-1 min-h-0 overflow-y-auto px-4 py-3 space-y-2">
              {idleLoading ? (
                <p className="text-xs text-zinc-400 py-6 text-center">{t('resources.cleanupScanning')}</p>
              ) : !(idleResult?.items || []).length ? (
                <p className="text-xs text-zinc-400 py-6 text-center">{t('resources.cleanupEmpty', { days: idleDays })}</p>
              ) : (
                <>
                  <div className="flex items-center justify-between text-[10px] text-zinc-400">
                    <span>{t('resources.cleanupSummary', { n: idleResult.items.length, total: idleResult.totalManaged })}</span>
                    <button type="button" onClick={toggleIdleSelectAll} className="text-violet-600 dark:text-violet-400 hover:underline">
                      {idleSelected.length === idleResult.items.length
                        ? t('resources.cleanupDeselectAll')
                        : t('resources.cleanupSelectAll')}
                    </button>
                  </div>
                  {idleResult.items.map(item => {
                    const checked = idleSelected.includes(item.id);
                    return (
                      <label
                        key={item.id}
                        className={`flex items-start gap-2 p-2.5 rounded-xl border cursor-pointer ${
                          checked
                            ? 'border-amber-300 dark:border-amber-700 bg-amber-50/60 dark:bg-amber-900/20'
                            : 'border-zinc-100 dark:border-zinc-800 hover:bg-zinc-50 dark:hover:bg-zinc-800/40'
                        }`}
                      >
                        <input
                          type="checkbox"
                          checked={checked}
                          onChange={() => toggleIdleSelected(item.id)}
                          className="mt-0.5 rounded border-zinc-300 dark:border-zinc-600"
                        />
                        <div className="min-w-0 flex-1">
                          <p className="text-xs font-medium text-zinc-800 dark:text-zinc-200 truncate">
                            {item.display_name || item.name}
                          </p>
                          <p className="text-[10px] text-zinc-400 mt-0.5">
                            {t('resources.cleanupIdleDays', { n: item.idleDays })}
                            {' · '}
                            {t('resources.cleanupLastActivity')}: {formatIdleTime(item.lastActivityAt)}
                          </p>
                          {item.authorityPath && (
                            <p className="text-[10px] text-zinc-400 font-mono truncate mt-0.5" title={item.authorityPath}>
                              {item.authorityPath}
                            </p>
                          )}
                        </div>
                      </label>
                    );
                  })}
                </>
              )}
            </div>
            <div className="px-4 py-3 border-t border-zinc-100 dark:border-zinc-800 flex gap-2 justify-end">
              <button
                type="button"
                disabled={!!busy}
                onClick={() => setCleanupOpen(false)}
                className="text-xs px-3 py-1.5 rounded-lg border border-zinc-200 dark:border-zinc-600"
              >
                {t('resources.cancel')}
              </button>
              <button
                type="button"
                disabled={!!busy || idleLoading || !idleSelected.length}
                onClick={confirmSkillCleanup}
                className="text-xs px-3 py-1.5 rounded-lg bg-amber-600 text-white hover:bg-amber-500 disabled:opacity-40"
              >
                {busy === 'cleanup'
                  ? t('resources.cleanupRunning')
                  : t('resources.cleanupAction', { n: idleSelected.length })}
              </button>
            </div>
          </div>
        </div>
      )}

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
                  {TYPE_OPTIONS.filter(o => o.id).map(opt => (
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
                        ? '{\n  "soul": "你是…",\n  "runtime_agent": "claude-code",\n  "prompts": ["code-review"],\n  "skills": ["git-commit"]\n}'
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
