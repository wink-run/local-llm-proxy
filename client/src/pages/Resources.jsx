import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import ServiceIcon from '../components/ServiceIcon';
import PersonalizedRecommend from '../components/PersonalizedRecommend';
import ResourceAssetCard, {
  ASSET_BTN_GHOST,
  ASSET_BTN_MANAGED,
  ASSET_BTN_PRIMARY,
  AssetLogo,
  buildPreviewText,
  resourceDescription,
} from '../components/ResourceAssetCard';
import { useLang } from '../store/lang';
import { getSyncServerBase } from '../config';

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
  { id: '', labelKey: 'resources.type.all' },
  { id: 'prompt', labelKey: 'resources.type.prompt' },
  { id: 'skill', labelKey: 'resources.type.skill' },
  { id: 'assistant', labelKey: 'resources.type.assistant' },
];

function readViewTab() {
  try {
    const v = localStorage.getItem(VIEW_TAB_KEY);
    // 默认「已纳管」；旧的 'discovered' / 'agents' 都归并到 'managed'
    // 'catalog' 已并入「个性化推荐」下半区,旧值迁移过去
    if (v === 'catalog') return 'recommend';
    if (v === 'managed' || v === 'recommend') return v;
    return 'managed';
  } catch { return 'managed'; }
}

function saveViewTab(tab) {
  try { localStorage.setItem(VIEW_TAB_KEY, tab); } catch {}
}

function readTypeFilter() {
  try {
    const v = localStorage.getItem(TYPE_FILTER_KEY);
    // 空字符串 = 全部；缺省默认 skill
    if (v === '') return '';
    if (v === 'prompt' || v === 'skill' || v === 'assistant') return v;
    return 'skill';
  } catch { return 'skill'; }
}

function saveTypeFilter(type) {
  try { localStorage.setItem(TYPE_FILTER_KEY, type || ''); } catch {}
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
  const [assistantAgents, setAssistantAgents] = useState([]);
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

  const loadBase = useCallback(async ({ silent = false } = {}) => {
    if (!window.electronAPI?.resource) {
      setLoading(false);
      setError(t('resources.desktopOnly'));
      return;
    }
    if (!silent) setLoading(true);
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
      if (agentRes.success) {
        setAgents(agentRes.agents || []);
        setPromptAgents(agentRes.promptAgents || []);
        setAssistantAgents(agentRes.assistantAgents || []);
      }
    } catch (e) {
      setError(e.message);
    } finally {
      if (!silent) setLoading(false);
    }
  }, [typeFilter, query, t]);

  const runScan = useCallback(async ({ silent = false } = {}) => {
    if (!window.electronAPI?.resource) return;
    if (scanScope === 'custom' && !customScanDir.trim()) {
      setMsg('');
      setError(t('resources.scanCustomDirRequired'));
      return;
    }
    if (!silent) {
      setScanning(true);
      setError('');
      setMsg('');
    }
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
      } else if (!silent) {
        setError(scanRes.error || t('resources.scanFailed'));
      }
      if (installRes.success) {
        setAgentInstallations(installRes.agents || []);
      }
      // 扫描成功不弹「扫描完成」提示，避免刷屏干扰
    } catch (e) {
      if (!silent) setError(e.message);
    } finally {
      if (!silent) setScanning(false);
    }
  }, [scanFilters, scanScope, customScanDir, t]);

  const loadAll = useCallback(async () => {
    // 先扫描即纳管（入库），再读取 resources，确保投射菜单能查到刚纳管的 skill
    await runScan();
    await loadBase();
  }, [loadBase, runScan]);

  /** 推荐页纳管后的静默刷新:不切 loading,避免卸载 PersonalizedRecommend 丢按钮状态 */
  const refreshAfterAdopt = useCallback(async () => {
    try { await runScan({ silent: true }); } catch { /* 扫描失败不阻断列表刷新 */ }
    try { await loadBase({ silent: true }); } catch { /* ignore */ }
  }, [loadBase, runScan]);

  /** 个性化推荐纳管成功:立刻插入本机列表,再静默刷新依赖 */
  const handleRecoAdopted = useCallback((resource, meta = {}) => {
    if (resource && resource.id) {
      upsertResourceLocally(resource);
      if (meta.catalogId) markCatalogInstalled(meta.catalogId, resource);
    }
    // 级联技能等依赖异步刷入
    refreshAfterAdopt();
  }, [refreshAfterAdopt]);

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

  // 按实际菜单尺寸贴齐锚点：下方不够则翻到上方，并限制在视口内
  useLayoutEffect(() => {
    if (!projectMenu?.anchor || !projectMenuRef.current) return;
    const el = projectMenuRef.current;
    const margin = 8;
    const h = el.offsetHeight;
    const w = el.offsetWidth;
    if (!h || !w) return;
    const { anchor } = projectMenu;
    let top = anchor.bottom + 4;
    if (top + h > window.innerHeight - margin) {
      top = Math.max(margin, anchor.top - h - 4);
    }
    if (top + h > window.innerHeight - margin) {
      top = margin;
    }
    let left = anchor.left;
    if (left + w > window.innerWidth - margin) {
      left = Math.max(margin, window.innerWidth - w - margin);
    }
    if (left === projectMenu.x && top === projectMenu.y) return;
    setProjectMenu(prev => (prev ? { ...prev, x: left, y: top } : null));
  }, [projectMenu, agents, promptAgents, assistantAgents]);

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
      // 局部更新目录/本机列表，避免 loadAll 整页闪烁
      if (res.resource) {
        upsertResourceLocally(res.resource);
        markCatalogInstalled(catalogId, res.resource);
      } else {
        markCatalogInstalled(catalogId, null);
      }
      // 级联纳管依赖：静默刷新资源/目录列表（不置 loading）
      if ((res.installedDependencies || []).length) {
        try {
          const filters = { type: typeFilter || undefined, query: query || undefined };
          const [catRes, resRes] = await Promise.all([
            window.electronAPI.resource.listCatalog(filters),
            window.electronAPI.resource.listResources(filters),
          ]);
          if (catRes.success) setCatalog(catRes.items || []);
          if (resRes.success) setResources(resRes.resources || []);
        } catch { /* ignore */ }
      }
      // 留在当前「社区推荐」Tab，不跳转到已纳管
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

  /** 本机列表 upsert（纳管/保存/导入后局部刷新） */
  function upsertResourceLocally(resource) {
    if (!resource?.id) return;
    const projections = resource.projections || [];
    setResources(prev => {
      const idx = prev.findIndex(r => r.id === resource.id);
      const row = {
        ...(idx >= 0 ? prev[idx] : {}),
        ...resource,
        projections: projections.length ? projections : (idx >= 0 ? (prev[idx].projections || []) : []),
      };
      // 刚纳管/更新的顶到最前(与纳管时间倒序一致)
      if (idx >= 0) {
        const next = prev.filter((_, i) => i !== idx);
        return [row, ...next];
      }
      return [row, ...prev];
    });
    if (resource.type !== 'skill') return;
    setDiscovered(prev => {
      const idx = prev.findIndex(item => item.resourceId === resource.id || item.name === resource.name);
      const patch = {
        name: resource.name,
        display_name: resource.name,
        description: resource.description || '',
        managed: true,
        resourceId: resource.id,
        projections,
        authorityPath: resource.authorityPath || resource.metadata?.authorityPath || null,
        type: 'skill',
        contentChanged: false,
        created_at: resource.created_at || Date.now(),
        updated_at: resource.updated_at || Date.now(),
      };
      if (idx >= 0) {
        const next = prev.filter((_, i) => i !== idx);
        return [{ ...prev[idx], ...patch }, ...next];
      }
      return [patch, ...prev];
    });
  }

  /** 社区推荐：标记已纳管 */
  function markCatalogInstalled(catalogId, resource) {
    setCatalog(prev => prev.map(c => {
      if (catalogId && c.catalogId === catalogId) {
        return { ...c, installed: true, resourceId: resource?.id || c.resourceId || null };
      }
      if (resource && c.type === resource.type && c.name === resource.name) {
        return { ...c, installed: true, resourceId: resource.id };
      }
      return c;
    }));
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
  function removeResourceLocally(resourceId, meta = {}) {
    const removed = resources.find((r) => r.id === resourceId)
      || discovered.find((i) => i.resourceId === resourceId || i.id === resourceId)
      || meta;
    setResources(prev => prev.filter(r => r.id !== resourceId));
    // Skill 卸载会删权威目录，本机列表中对应行一并移除
    setDiscovered(prev => prev.filter(item => item.resourceId !== resourceId));
    setScanStats(prev => (prev && typeof prev.totalOnDisk === 'number'
      ? { ...prev, totalOnDisk: Math.max(0, prev.totalOnDisk - 1) }
      : prev));
    // 社区目录标记恢复为未纳管
    if (removed) {
      setCatalog((prev) => prev.map((c) => {
        if (c.resourceId === resourceId) return { ...c, installed: false, resourceId: null };
        if (removed.name && c.type === (removed.type || typeFilter) && c.name === removed.name) {
          return { ...c, installed: false, resourceId: null };
        }
        return c;
      }));
      // 推荐页可能未挂载:直接改 localStorage 里的 adopted
      try {
        const LAST = 'tokenbank.resources.recommend.last';
        const names = new Set(
          [removed.name, removed.display_name, removed.displayName, removed.id, removed.resourceId, resourceId]
            .filter(Boolean).map(String),
        );
        for (const tf of ['skill', 'prompt', 'assistant']) {
          const key = `${LAST}.${tf}`;
          const data = JSON.parse(localStorage.getItem(key) || 'null');
          if (!data || !Array.isArray(data.items)) continue;
          let changed = false;
          const items = data.items.map((rec) => {
            const hit = [rec.slug, rec.name, rec.catalogId, rec.resourceId]
              .some((k) => k && names.has(String(k)));
            if (hit && rec.adopted) {
              changed = true;
              return { ...rec, adopted: false };
            }
            return rec;
          });
          if (changed) localStorage.setItem(key, JSON.stringify({ ...data, items }));
        }
      } catch { /* ignore */ }
    }
    // 通知个性化推荐(若在挂载)立刻刷新按钮
    try {
      window.dispatchEvent(new CustomEvent('tokenbank:resource-removed', {
        detail: {
          id: resourceId,
          name: removed && removed.name,
          display_name: removed && (removed.display_name || removed.displayName),
          type: (removed && removed.type) || typeFilter,
        },
      }));
    } catch { /* ignore */ }
  }

  async function handleDelete(resource) {
    // 已投射的智能体须先取消投射再删,避免 Agent 侧残留引用
    if (resource.type === 'assistant') {
      const authorityPath = resource.authorityPath || getSkillLocation(resource);
      if (hasProjectedLinks(resource.projections, authorityPath)) {
        alert(t('resources.deleteNeedUnproject'));
        return;
      }
    }
    if (!window.confirm(t('resources.deleteConfirm', { name: resource.display_name || resource.name }))) return;
    setBusy(resource.id);
    try {
      const res = await window.electronAPI.resource.deleteResource(resource.id);
      if (!res.success) {
        alert(res.error || t('resources.deleteFailed'));
        return;
      }
      removeResourceLocally(resource.id, resource);
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
      removeResourceLocally(resourceId, { ...item, id: resourceId, type: 'skill' });
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
      // 已在上方 removeResourceLocally，无需 loadAll
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
    const menuWidth = 224; // w-56
    // 预估高度：标题 + 若干项 + 底栏；实际高度在 layout 后再校正
    const estimatedHeight = 260;
    const margin = 8;
    let x = rect.left;
    let y = rect.bottom + 4;
    // 下方空间不足则向上弹出，避免贴底被裁切
    if (y + estimatedHeight > window.innerHeight - margin) {
      y = Math.max(margin, rect.top - estimatedHeight - 4);
    }
    if (x + menuWidth > window.innerWidth - margin) {
      x = Math.max(margin, window.innerWidth - menuWidth - margin);
    }
    setProjectSelected([]);
    setProjectMenu({
      resourceId,
      x,
      y,
      anchor: { top: rect.top, bottom: rect.bottom, left: rect.left, right: rect.right },
    });

    // 先拉最新应用目录（服务端发布后无需重启），再刷新可投射 Agent 列表
    if (!window.electronAPI?.resource?.listAgentTargets) return;
    try {
      try {
        const base = await getSyncServerBase();
        if (base && window.electronAPI.toolsConfig?.importUrl) {
          await window.electronAPI.toolsConfig.importUrl(
            `${base}/api/config/apps`,
            localStorage.getItem('token'),
            { replace: true },
          );
        }
      } catch { /* 离线时沿用本地 yaml */ }
      const agentRes = await window.electronAPI.resource.listAgentTargets();
      if (!agentRes.success) return;
      setAgents(agentRes.agents || []);
      setPromptAgents(agentRes.promptAgents || []);
      setAssistantAgents(agentRes.assistantAgents || []);
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
      let finalRes = res;
      if (res.conflicts?.length
        && window.confirm(`${res.hint}\n\n是否强制覆盖并投射？这会删除目标位置的同名目录，不可撤销。`)) {
        finalRes = await window.electronAPI.resource.project({
          resourceId,
          agentIds: projectSelected,
          force: true,
        });
        alert(finalRes.success ? (finalRes.hint || t('resources.projectOk')) : (finalRes.error || t('resources.projectFailed')));
      } else {
        alert(res.hint || t('resources.projectOk'));
      }
      // 用返回资源局部更新投射状态，避免整页重刷
      if (finalRes?.success && finalRes.resource) {
        applyResourcePatch(resourceId, finalRes.resource);
      }
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
      if (res.resource) upsertResourceLocally(res.resource);
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
      if (res.resource) upsertResourceLocally(res.resource);
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

  // 应用筛选：仅本机已安装 Agent（Skill / Prompt 与 MCP 一致；有残留目录未装的不展示）
  const installedFilterAgents = typeFilter === 'prompt' ? promptAgents : agents;
  const installedFilterIds = new Set(installedFilterAgents.map(a => a.id));
  const appFilterOptions = (() => {
    const map = new Map();
    for (const a of installedFilterAgents) {
      if (!isAgentAppId(a.id)) continue;
      map.set(a.id, a.label || a.id);
    }
    return [{ id: '', label: t('resources.appFilterAll') }, ...[...map.entries()]
      .sort((a, b) => a[1].localeCompare(b[1], undefined, { sensitivity: 'base' }))
      .map(([id, label]) => ({ id, label }))];
  })();

  // 若上次筛到了未安装/公共目录，回退到全部应用
  const effectiveAppFilter = (() => {
    if (!appFilter) return '';
    if (!isAgentAppId(appFilter)) return '';
    if (!installedFilterIds.has(appFilter)) return '';
    return appFilter;
  })();

  const filteredDiscovered = effectiveAppFilter
    ? discovered.filter(item => (item.agents || []).some(a => a.agentId === effectiveAppFilter))
    : discovered;

  const showAppFilterBar = !typeFilter || typeFilter === 'skill' || typeFilter === 'prompt';

  /** 本机 Skill / Prompt 列表上方的应用筛选：图标 + 名称 */
  function renderAppFilter() {
    if (!showAppFilterBar || appFilterOptions.length <= 1) return null;
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
    const expanded = expandedId === rowKey;
    const toggle = () => setExpandedId(expanded ? null : rowKey);
    return (
      <ResourceAssetCard
        key={rowKey}
        type="skill"
        item={item}
        typeLabel={t('resources.type.skill')}
        description={resourceDescription(item)}
        expanded={expanded}
        onTogglePreview={toggle}
        previewLabel={t('resources.preview')}
        collapseLabel={t('resources.collapse')}
        emptyPreviewLabel={t('resources.emptyDetail')}
        layout="col"
        badges={(
          <>
            {item.version && (
              <span
                className="text-[10px] px-1.5 py-0.5 rounded-md bg-sky-50 dark:bg-sky-900/30 text-sky-700 dark:text-sky-300 font-mono"
                title={t('resources.skillVersion')}
              >
                {/^v/i.test(item.version) ? item.version : `v${item.version}`}
              </span>
            )}
            {item.contentChanged && (
              <span className="text-[10px] px-1.5 py-0.5 rounded-md bg-amber-100 dark:bg-amber-900/40 text-amber-700 dark:text-amber-300">
                {t('resources.contentChanged')}
              </span>
            )}
          </>
        )}
        meta={(
          <>
            {item.authorityPath && (
              <p className="text-[11px] text-zinc-400 mt-2 font-mono truncate">
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
            {item.resourceId && renderProjections({
              id: item.resourceId,
              type: 'skill',
              projections: item.projections,
              authorityPath: item.authorityPath,
            })}
          </>
        )}
        actions={item.resourceId ? (
          <>
            <button
              type="button"
              disabled={!!busy}
              onClick={(e) => openProjectMenu(e, item.resourceId)}
              className={ASSET_BTN_PRIMARY}
            >
              {busy === item.resourceId ? t('resources.busy') : t('resources.project')}
            </button>
            <button
              type="button"
              disabled={!!busy}
              onClick={() => handleUninstallSkill(item)}
              className="text-xs px-3 py-1.5 rounded-lg border border-red-200/90 text-red-600 hover:bg-red-50 dark:border-red-900 dark:hover:bg-red-950/30 disabled:opacity-45 transition active:scale-[0.98]"
              title={hasProjectedLinks(item.projections, item.authorityPath || getSkillLocation(item))
                ? t('resources.uninstallNeedUnproject')
                : undefined}
            >
              {busy === item.resourceId ? t('resources.busy') : t('resources.uninstall')}
            </button>
          </>
        ) : null}
      />
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
    const toggle = () => setExpandedId(expanded ? null : id);
    const loc = resource.type === 'skill' ? getSkillLocation(resource) : null;
    return (
      <ResourceAssetCard
        key={id}
        type={resource.type}
        item={resource}
        typeLabel={typeBadge(resource.type, t)}
        description={resourceDescription(resource)}
        previewText={buildPreviewText(resource.type, resource)}
        expanded={expanded}
        onTogglePreview={toggle}
        previewLabel={t('resources.preview')}
        collapseLabel={t('resources.collapse')}
        emptyPreviewLabel={t('resources.emptyDetail')}
        layout={catalogMode ? 'stack' : 'row'}
        className={catalogMode && expanded ? 'sm:col-span-2' : ''}
        badges={!catalogMode ? (
          <span className="text-[10px] text-zinc-400 tracking-wide">{sourceLabel(resource.source, t)}</span>
        ) : null}
        meta={(
          <>
            {!catalogMode && resource.type === 'skill' && (
              <p className="text-[11px] text-zinc-400 mt-2 font-mono truncate">
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
            )}
            {(resource.metadata?.tags || []).length > 0 && (
              <div className="flex flex-wrap gap-1.5 mt-2.5">
                {resource.metadata.tags.map(tag => (
                  <span
                    key={tag}
                    className="text-[10px] px-2 py-0.5 rounded-md border border-zinc-200/80 dark:border-zinc-700/80 bg-zinc-50/80 dark:bg-zinc-800/70 text-zinc-500 dark:text-zinc-400"
                  >
                    {tag}
                  </span>
                ))}
              </div>
            )}
            {!catalogMode && renderProjections(resource)}
          </>
        )}
        actions={catalogMode ? (
          <button
            type="button"
            disabled={!!busy || resource.installed}
            onClick={() => handleInstall(resource.catalogId)}
            className={resource.installed ? ASSET_BTN_MANAGED : ASSET_BTN_PRIMARY}
          >
            {busy === resource.catalogId ? t('resources.busy') : resource.installed ? t('resources.managed') : t('resources.addManage')}
          </button>
        ) : (
          <>
            <button
              type="button"
              className={ASSET_BTN_GHOST}
              onClick={() => openEditEditor(resource)}
              disabled={!!busy}
            >
              {t('resources.edit')}
            </button>
            <button
              type="button"
              disabled={!!busy}
              onClick={(e) => openProjectMenu(e, resource.id)}
              className={ASSET_BTN_PRIMARY}
            >
              {busy === resource.id ? t('resources.busy') : t('resources.project')}
            </button>
            {resource.source !== 'builtin' && (
              <button
                type="button"
                disabled={!!busy}
                onClick={() => handleDelete(resource)}
                className="text-xs px-3 py-1.5 rounded-lg border border-red-200/90 text-red-600 hover:bg-red-50 dark:border-red-900 dark:hover:bg-red-950/30 disabled:opacity-45 transition active:scale-[0.98]"
                title={resource.type === 'assistant' && hasProjectedLinks(resource.projections, resource.authorityPath || getSkillLocation(resource))
                  ? t('resources.deleteNeedUnproject')
                  : undefined}
              >
                {t('resources.delete')}
              </button>
            )}
          </>
        )}
      />
    );
  }

  /**
   * 「本机」Tab 列表：按类型筛选分流。
   * 技能→扫描行(discovered,带来源应用筛选);提示词/助手→managed 行;全部→非-skill managed 行 + 扫描行。
   * 统一按纳管时间倒序。
   */
  function renderLocalList() {
    const showSkills = !typeFilter || typeFilter === 'skill';
    const byManagedAt = (a, b) => {
      const ta = Number(a.created_at || a.createdAt || 0);
      const tb = Number(b.created_at || b.createdAt || 0);
      if (tb !== ta) return tb - ta;
      return String(a.name || a.display_name || '').localeCompare(String(b.name || b.display_name || ''), 'zh-CN');
    };
    const managedRows = (typeFilter === 'skill'
      ? []
      : (typeFilter ? resources : resources.filter(r => r.type !== 'skill')))
      .filter(r => {
        if (!effectiveAppFilter) return true;
        // Prompt / 智能体：按已投射到的 Agent 筛选
        return (r.projections || []).some(p => p.agentId === effectiveAppFilter);
      })
      .slice()
      .sort(byManagedAt);
    const skillRows = (showSkills ? filteredDiscovered : []).slice().sort(byManagedAt);

    if (managedRows.length + skillRows.length === 0) {
      // 有本机 skill / 资源,但被来源应用筛选过滤空了
      if (showAppFilterBar && effectiveAppFilter && (discovered.length > 0 || resources.length > 0)) {
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
          <button type="button" onClick={() => changeViewTab('recommend')} className="text-xs text-violet-600 hover:underline">
            {t('resources.goCatalog')}
          </button>
        </div>
      );
    }

    return (
      <div className="space-y-3">
        {showAppFilterBar && renderAppFilter()}
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
        <div className="space-y-3">
          {managedRows.map(r => renderResourceRow(r))}
          {skillRows.map(item => renderDiscoveredRow(item))}
        </div>
      </div>
    );
  }

  function renderProjectMenu() {
    if (!projectMenu) return null;
    // 本机 Skill 行可能只在 discovered 里，需两边查找类型
    const resource = resources.find(r => r.id === projectMenu.resourceId)
      || discovered.find(i => i.resourceId === projectMenu.resourceId);
    // prompt/skill：已安装即可；assistant：需勾选「可投射智能体」
    const targetList = resource?.type === 'prompt'
      ? promptAgents
      : resource?.type === 'assistant'
        ? assistantAgents
        : agents;
    const maxMenuH = Math.max(160, window.innerHeight - 16);
    return createPortal(
      <div
        ref={projectMenuRef}
        className="fixed z-[9999] w-56 flex flex-col rounded-xl border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-800 shadow-lg overflow-hidden"
        style={{
          left: projectMenu.x,
          top: projectMenu.y,
          maxHeight: maxMenuH,
        }}
      >
        <div className="shrink-0 px-3 py-2 border-b border-zinc-100 dark:border-zinc-700">
          <p className="text-xs font-medium text-zinc-700 dark:text-zinc-200">{t('resources.projectTo')}</p>
          {resource?.type === 'prompt' ? (
            <p className="text-[10px] text-zinc-400 mt-0.5">{t('resources.promptMcpHint')}</p>
          ) : resource?.type !== 'skill' && (
            <p className="text-[10px] text-zinc-400 mt-0.5">{t('resources.nonSkillHint')}</p>
          )}
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto p-2 space-y-1">
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
        <div className="shrink-0 p-2 border-t border-zinc-100 dark:border-zinc-700 flex gap-2">
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

        {/* 子 Tab + 搜索 + 操作 */}
        <div className="space-y-2">
          <div className="flex flex-wrap items-center gap-3">
            <div className="inline-flex rounded-lg border border-zinc-200 dark:border-zinc-700 p-0.5 bg-zinc-50 dark:bg-zinc-900">
              {[
                { id: 'managed', label: t('resources.tab.managed'), count: localCount },
                { id: 'recommend', label: t('resources.tab.recommend') },
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
        ) : viewTab === 'managed' ? (
          renderLocalList()
        ) : viewTab === 'recommend' ? (
          <div className="space-y-6">
            {/* 上半:个性化挖掘(按类型分流)*/}
            <PersonalizedRecommend
              typeFilter={typeFilter}
              LogoComp={AssetLogo}
              onNeedProject={() => changeViewTab('managed')}
              onRefresh={refreshAfterAdopt}
              onAdopted={handleRecoAdopted}
            />
            {/* 下半:原社区推荐 */}
            <div className="space-y-2 border-t border-zinc-100 dark:border-zinc-800 pt-4">
              <p className="text-xs text-zinc-400">社区推荐</p>
              {filteredCatalog.length === 0 ? (
                <p className="text-xs text-zinc-400 text-center py-6">{t('resources.emptyCatalog')}</p>
              ) : (
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  {filteredCatalog.map(item => renderResourceRow(item, { catalogMode: true }))}
                </div>
              )}
            </div>
          </div>
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
