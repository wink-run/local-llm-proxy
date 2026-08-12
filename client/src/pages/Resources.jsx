import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useNavigate } from 'react-router-dom';
import ServiceIcon from '../components/ServiceIcon';
import PersonalizedRecommend from '../components/PersonalizedRecommend';
import SkillInstallDialog from '../components/SkillInstallDialog';
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
import {
  PURPOSE_SLUGS,
  aggregateTagsWithAi,
  classifySkillsPurposeWithAi,
  inferPurposeHeuristic,
  loadAiPurposeMap,
  resolvePurposes,
  tagToPurpose,
} from '../lib/resource-purpose';
import {
  analyzeIdleSkillsWithAi,
  hasStoredPortrait,
  sortIdleByRecommendation,
} from '../lib/idle-skill-ai';
import { classifyLifecycle, isLifecycleExempt } from '../lib/resource-lifecycle';
import { buildInvokeText, copyText } from '../lib/resource-enable';
import { catalogSharerHandle } from '../lib/catalog-sharer';
import {
  formatApiError,
  recommendCommunitySkill,
  settleCommunityCatalogInstall,
} from '../api/client';

const VIEW_TAB_KEY = 'tokenbank.resources.viewTab';
const TYPE_FILTER_KEY = 'tokenbank.resources.typeFilter';
const SCAN_CUSTOM_DIR_KEY = 'tokenbank.resources.scanCustomDir';
const APP_FILTER_KEY = 'tokenbank.resources.appFilter';
const IDLE_DAYS_KEY = 'tokenbank.resources.idleDays';
const LAYER_FILTER_KEY = 'tokenbank.resources.layerFilter';
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
const NON_AGENT_APP_IDS = new Set(['agents-hub', 'tokenbank', 'custom', 'aweskill']);
/** 未落入任何一级用途的筛选项 */
const PURPOSE_OTHER = 'other';

function isAgentAppId(agentId) {
  return !!agentId && !NON_AGENT_APP_IDS.has(agentId);
}

/** 用户添加的扫描目录列表（兼容旧版单字符串） */
function readScanCustomDirs() {
  try {
    const raw = localStorage.getItem(SCAN_CUSTOM_DIR_KEY);
    if (!raw) return [];
    if (raw.startsWith('[')) {
      const arr = JSON.parse(raw);
      return Array.isArray(arr)
        ? [...new Set(arr.map(d => String(d || '').trim()).filter(Boolean))]
        : [];
    }
    // 旧版：单个路径字符串
    const one = raw.trim();
    return one ? [one] : [];
  } catch {
    return [];
  }
}

function saveScanCustomDirs(dirs) {
  try {
    const list = [...new Set((dirs || []).map(d => String(d || '').trim()).filter(Boolean))];
    localStorage.setItem(SCAN_CUSTOM_DIR_KEY, JSON.stringify(list));
  } catch { /* ignore */ }
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
    // 默认「为你推荐」；旧 portrait 并入 recommend
    if (v === 'catalog' || v === 'portrait') return 'recommend';
    if (v === 'managed' || v === 'recommend') return v;
    if (v === 'discovered' || v === 'agents') return 'managed';
    return 'recommend';
  } catch { return 'recommend'; }
}

function saveViewTab(tab) {
  try { localStorage.setItem(VIEW_TAB_KEY, tab); } catch {}
}

function readTypeFilter() {
  try {
    const v = localStorage.getItem(TYPE_FILTER_KEY);
    // 缺省 / 空 = 全部；记住用户上次选择
    if (v === null || v === undefined) return '';
    if (v === '') return '';
    if (v === 'prompt' || v === 'skill' || v === 'assistant') return v;
    return '';
  } catch { return ''; }
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

/** 内置资产：source / metadata / 固定 catalogId / name */
function isBuiltinResource(item) {
  if (!item) return false;
  if (item.source === 'builtin') return true;
  if (item.metadata?.builtin) return true;
  const url = String(item.source_url || '');
  if (url.startsWith('builtin:')) return true;
  const tags = item.metadata?.tags;
  if (Array.isArray(tags) && tags.includes('builtin')) return true;
  const catalogId = String(item.catalogId || item.catalog_id || '');
  if (
    catalogId === 'resource-finder-assistant'
    || catalogId === 'resource-installer-assistant'
    || catalogId === 'resource-portrait-assistant'
  ) {
    return true;
  }
  // 内置智能体固定名（目录卡可能尚未带 source）
  const name = String(item.name || '');
  return name === 'resource-finder'
    || name === 'resource-installer'
    || name === 'resource-portrait';
}

function sourceLabel(source, t) {
  if (!source || source === 'local') return t('resources.source.local');
  if (source === 'catalog' || String(source).startsWith('catalog')) return t('resources.source.catalog');
  if (source === 'builtin') return t('resources.source.builtin');
  if (String(source).startsWith('agent:')) return t('resources.source.scanned');
  if (source === 'imported') return t('resources.source.imported');
  return source;
}

/** 提示词模版用途：文本对话 / 图像生成（存 metadata.promptKind） */
function promptKindOf(resource) {
  return resource?.metadata?.promptKind === 'image' ? 'image' : 'text';
}

/** 统一读取资源标签（metadata.tags） */
function resourceTags(item) {
  const raw = item?.metadata?.tags ?? item?.tags;
  if (!Array.isArray(raw)) return [];
  return raw.map(t => String(t || '').trim()).filter(Boolean);
}

/** 标签输入：逗号/空格分隔 → 数组 */
function parseTagsInput(text) {
  return String(text || '')
    .split(/[,，\s]+/)
    .map(t => t.trim())
    .filter(Boolean);
}

const EMPTY_EDITOR = {
  id: '',
  type: 'prompt',
  name: '',
  display_name: '',
  description: '',
  content: '',
  promptKind: 'text',
  tagsText: '',
  metadata: {},
};

/** 是否 Windows 前端环境（路径用反斜杠） */
function isWindowsPathEnv(sample = '') {
  const s = String(sample || '');
  if (s.includes('\\')) return true;
  if (s.includes('/')) return false;
  if (typeof navigator !== 'undefined') {
    return /Win/i.test(navigator.userAgent || '') || /Win/i.test(navigator.platform || '');
  }
  return false;
}

/** 拼本地路径，兼容 Windows `\` 与 POSIX `/` */
function joinFsPath(base, ...segments) {
  const sep = isWindowsPathEnv(base) ? '\\' : '/';
  const parts = [String(base || '').replace(/[/\\]+$/, '')];
  for (const seg of segments) {
    const bit = String(seg || '').replace(/^[/\\]+|[/\\]+$/g, '');
    if (bit) parts.push(bit);
  }
  return parts.filter(Boolean).join(sep);
}

/** 从智能体 content JSON 解析声明绑定的 skill / prompt 名列表 */
function depsFromAssistantContent(content) {
  try {
    const raw = typeof content === 'string' ? content : JSON.stringify(content || '');
    const obj = JSON.parse(raw || '{}');
    const names = (arr) => (Array.isArray(arr) ? arr.map(String).filter(Boolean) : []);
    return { skills: names(obj.skills), prompts: names(obj.prompts) };
  } catch {
    return { skills: [], prompts: [] };
  }
}

/** Skill 权威目录（用户安装位置） */
function getSkillLocation(resource) {
  if (!resource) return null;
  if (resource.authorityPath) return resource.authorityPath;

  const meta = resource.metadata || {};
  let loc = meta.authorityPath || meta.scannedFrom || meta.canonicalPath;
  // 兼容 / 与 \，以及 SKILL.md / skill.md
  if (loc && /[/\\]skill\.md$/i.test(String(loc))) {
    loc = String(loc).replace(/[/\\][^/\\]+$/, '');
  }
  if (loc) return loc;

  const originProj = (resource.projections || []).find(
    p => p.projectionType === 'scan' || p.projectionType === 'origin',
  );
  return originProj?.targetPath || null;
}

/** 路径归一化后比较（判断是否同一权威目录；忽略分隔符与大小写，适配 Windows） */
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

/** 闲置清理加载态：扫帚清扫尘埃 + 可选分批进度 */
function CleanupSweepMotion({ label, progress }) {
  const pct = progress && progress.total > 0
    ? Math.min(100, Math.round((progress.done / progress.total) * 100))
    : null;
  return (
    <div className="py-8 flex flex-col items-center gap-3">
      <div className="tb-cleanup-sweep" aria-hidden="true">
        <span className="tb-cleanup-sweep__dust" />
        <span className="tb-cleanup-sweep__dust" />
        <span className="tb-cleanup-sweep__dust" />
        <span className="tb-cleanup-sweep__dust" />
        <span className="tb-cleanup-sweep__dust" />
        <span className="tb-cleanup-sweep__floor" />
        <span className="tb-cleanup-sweep__trail" />
        <span className="tb-cleanup-sweep__broom">
          <span className="tb-cleanup-sweep__handle" />
          <span className="tb-cleanup-sweep__head" />
        </span>
      </div>
      <p className="text-xs text-zinc-500 dark:text-zinc-400 text-center">{label}</p>
      {pct != null && (
        <div className="w-48 space-y-1">
          <div className="h-1 rounded-full bg-zinc-100 dark:bg-zinc-800 overflow-hidden">
            <div
              className="h-full rounded-full bg-amber-500/80 transition-[width] duration-300"
              style={{ width: `${pct}%` }}
            />
          </div>
          <p className="text-[10px] text-zinc-400 text-center">
            {progress.batches > 0
              ? `${progress.done}/${progress.total} · ${progress.batch}/${progress.batches}`
              : `${progress.done}/${progress.total}`}
          </p>
        </div>
      )}
    </div>
  );
}

// 交付 cid 归一：Codex Desktop 与 CLI 共用 config.toml；Claude Desktop 归 Claude Code
const MCP_DELIVERY_ID_ALIASES = { 'codex-desktop': 'codex', 'claude-desktop': 'claude-code' };

/**
 * prompt / 智能体的投射目标 = 全部已纳管应用（与 Gateway apps:list 同源）。
 * apps:list 已做安装过滤与去重；此处取 hosted（已纳管）行，归一到交付 cid 后再去重。
 */
function deriveManagedAppTargets(apps) {
  const byId = new Map(); // deliveryId -> { label, canonical, order }
  let order = 0;
  for (const a of Array.isArray(apps) ? apps : []) {
    if (!a || a.draft || !a.hosted) continue;
    const raw = a.agent_id || a.preset_id || a.id;
    if (!raw) continue;
    const id = MCP_DELIVERY_ID_ALIASES[raw] || raw;
    const canonical = raw === id; // 非别名行(如 claude-code CLI shim)优先提供展示名
    const label = a.name || a.label || id;
    const prev = byId.get(id);
    if (!prev) {
      byId.set(id, { label, canonical, order: order++ });
    } else if (canonical && !prev.canonical) {
      // 别名行(Claude Desktop)先占位 → 被规范行(Claude Code CLI)接管展示名，位置不变
      byId.set(id, { label, canonical: true, order: prev.order });
    }
  }
  return [...byId.entries()]
    .sort((a, b) => a[1].order - b[1].order)
    .map(([id, v]) => ({ id, label: v.label }));
}

/** 资产页：Prompt / Skill / Assistant 纳管与投射 */
export default function Resources() {
  const navigate = useNavigate();
  const { t, lang } = useLang();
  const [viewTab, setViewTab] = useState(readViewTab);
  const [typeFilter, setTypeFilter] = useState(readTypeFilter);
  const [query, setQuery] = useState('');
  const [debouncedQuery, setDebouncedQuery] = useState('');
  const [catalog, setCatalog] = useState([]);
  const [discovered, setDiscovered] = useState([]);
  const [scanStats, setScanStats] = useState(null);
  const [resources, setResources] = useState([]);
  /** 全部智能体（不受 typeFilter 限制），用于标记被绑定为依赖的 Skill */
  const [assistantsForBind, setAssistantsForBind] = useState([]);
  const [agentInstallations, setAgentInstallations] = useState([]);
  const [agents, setAgents] = useState([]);
  const [promptAgents, setPromptAgents] = useState([]);
  const [assistantAgents, setAssistantAgents] = useState([]);
  // prompt / 智能体的投射目标 = 全部已纳管应用（与 Gateway 列表同源，含 Trae / API 应用）
  const [managedAppTargets, setManagedAppTargets] = useState([]);
  const [loading, setLoading] = useState(true);
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState('');
  const [msg, setMsg] = useState('');
  const [expandedId, setExpandedId] = useState(null);
  const [projectMenu, setProjectMenu] = useState(null);
  const [projectSelected, setProjectSelected] = useState([]);
  const [editorOpen, setEditorOpen] = useState(false);
  const [skillInstallOpen, setSkillInstallOpen] = useState(false);
  const [editorForm, setEditorForm] = useState(EMPTY_EDITOR);
  /** 提示词子筛选：'' | 'text' | 'image' */
  const [promptKindFilter, setPromptKindFilter] = useState('');
  /** 用途筛选（空 = 全部；值为 purpose slug） */
  const [tagFilter, setTagFilter] = useState('');
  /** Hit-or-Exit 分层：'' | active | pending | dormant | cold | shelf */
  const [layerFilter, setLayerFilter] = useState(() => {
    try {
      const v = localStorage.getItem(LAYER_FILTER_KEY) || '';
      if (['', 'active', 'pending', 'dormant', 'cold', 'shelf'].includes(v)) return v;
    } catch { /* ignore */ }
    return '';
  });
  /** AI / 静态聚合后的 tag→用途 映射 */
  const [purposeAiMap, setPurposeAiMap] = useState(loadAiPurposeMap);
  const purposeAiMapRef = useRef(purposeAiMap);
  purposeAiMapRef.current = purposeAiMap;
  /** 个性化推荐结果变更时递增，刷新用途芯片 */
  const [recoPurposeRev, setRecoPurposeRev] = useState(0);
  const [customScanDirs, setCustomScanDirs] = useState(readScanCustomDirs);
  const [defaultScanRoots, setDefaultScanRoots] = useState([]);
  const [scanning, setScanning] = useState(false);
  // 用 ref 做重入守卫，避免 scanning/autoTagging 进 runScan deps → 重建 loadAll → 误触发「搜索中」
  const scanningRef = useRef(false);
  const autoTaggingRef = useRef(false);
  /** 扫描后自动打标进行中（禁用再次扫描） */
  const [autoTagging, setAutoTagging] = useState(false);
  const [scanExpanded, setScanExpanded] = useState(false);
  const [appFilter, setAppFilter] = useState(readAppFilter);
  /** Skill 闲置清理 */
  const [cleanupOpen, setCleanupOpen] = useState(false);
  const [idleLoading, setIdleLoading] = useState(false);
  const [idleAiLoading, setIdleAiLoading] = useState(false);
  const [idleResult, setIdleResult] = useState(null);
  const [idleSelected, setIdleSelected] = useState([]);
  const [idleDays, setIdleDays] = useState(readIdleDays);
  /** id → { recommend, reason, source } 大模型/启发式分析结果 */
  const [idleAiMap, setIdleAiMap] = useState({});
  const [idleAiMeta, setIdleAiMeta] = useState({ source: '', error: '' });
  /** 分批分析进度：done/total/batch/batches */
  const [idleAiProgress, setIdleAiProgress] = useState(null);
  const idleAiAbortRef = useRef(null);
  const projectMenuRef = useRef(null);
  const bootstrappedRef = useRef(false);

  // 搜索防抖：避免每键触发全量扫描/加载
  useEffect(() => {
    const id = setTimeout(() => setDebouncedQuery(query.trim()), 280);
    return () => clearTimeout(id);
  }, [query]);

  const scanFilters = useCallback(() => ({
    // 搜索在前端过滤；扫盘只跟监控目录有关，避免每次输入都重扫磁盘
    customDirs: customScanDirs,
    includeManaged: true,
  }), [customScanDirs]);

  const loadBase = useCallback(async ({ silent = false } = {}) => {
    if (!window.electronAPI?.resource) {
      setLoading(false);
      setError(t('resources.desktopOnly'));
      return;
    }
    if (!silent) setLoading(true);
    setError('');
    try {
      // 内置智能体默认纳管（幂等）
      try { await window.electronAPI.resource.ensureBuiltinAssistants?.(); } catch { /* ignore */ }
      // 全量拉取，搜索/类型在前端筛，避免每次筛选触发 IPC
      const [catRes, resRes, agentRes, asstBindRes] = await Promise.all([
        window.electronAPI.resource.listCatalog({}),
        window.electronAPI.resource.listResources({}),
        window.electronAPI.resource.listAgentTargets(),
        // Skill 卡片「智能体依赖」标记：始终拉全量智能体（不受当前类型筛选）
        window.electronAPI.resource.listResources({ type: 'assistant' }),
      ]);
      if (catRes.success) setCatalog(catRes.items || []);
      else setError(catRes.error || t('resources.loadFailed'));
      if (resRes.success) setResources(resRes.resources || []);
      if (asstBindRes?.success) setAssistantsForBind(asstBindRes.resources || []);
      if (agentRes.success) {
        setAgents(agentRes.agents || []);
        setPromptAgents(agentRes.promptAgents || []);
        setAssistantAgents(agentRes.assistantAgents || []);
      }
      try {
        const apps = await window.electronAPI.apps?.list?.();
        if (apps) setManagedAppTargets(deriveManagedAppTargets(apps));
      } catch { /* apps 拉取失败时回退到 agents */ }
    } catch (e) {
      setError(e.message);
    } finally {
      if (!silent) setLoading(false);
    }
  }, [t]);

  /** 拉取默认监控目录：listScanRoots → scanStatsHint → Agent skillRoot 回退 */
  const refreshDefaultScanRoots = useCallback(async (filters, scanStatsHint) => {
    const api = window.electronAPI?.resource;
    if (!api) return;
    // 1) 专用 IPC
    try {
      if (api.listScanRoots) {
        const res = await api.listScanRoots(filters || scanFilters());
        const defaults = (res?.roots || []).filter(r => r.kind === 'default' && r.path);
        if (res?.success && defaults.length) {
          setDefaultScanRoots(defaults);
          return;
        }
      }
    } catch { /* 旧主进程无 handler 时回退 */ }
    // 2) 扫描统计里附带的 defaultRoots
    if (Array.isArray(scanStatsHint?.defaultRoots) && scanStatsHint.defaultRoots.length) {
      setDefaultScanRoots(scanStatsHint.defaultRoots.filter(r => r.path));
      return;
    }
    // 3) 用已安装 Agent 的 skillRoot 拼一份，并补上 .agents
    try {
      const agentRes = await api.listAgentTargets();
      if (agentRes?.success) {
        const roots = (agentRes.agents || [])
          .filter(a => a.skillRoot)
          .map(a => ({
            id: a.id,
            label: a.label || a.id,
            path: a.skillRoot,
            kind: 'default',
            exists: true,
          }));
        // 从任一 skill 路径反推家目录，补全 .agents / .tokenbank（分隔符随平台）
        const sample = roots[0]?.path || '';
        const homeMatch = String(sample).match(/^(.*)[/\\]\.[^/\\]+[/\\]skills(?:-cursor)?$/i);
        const home = homeMatch?.[1];
        if (home) {
          const extras = [
            { id: 'agents-hub', label: '.agents', path: joinFsPath(home, '.agents', 'skills') },
            { id: 'tokenbank', label: '.tokenbank', path: joinFsPath(home, '.tokenbank', 'skills') },
          ];
          for (const ex of extras) {
            if (!roots.some(r => r.id === ex.id || sameSkillDir(r.path, ex.path))) {
              roots.push({ ...ex, kind: 'default', exists: true });
            }
          }
        }
        if (roots.length) setDefaultScanRoots(roots);
      }
    } catch { /* ignore */ }
  }, [scanFilters]);

  /** 扫描后 AI 打标；有未打标时才跑模型。返回是否实际进入打标 */
  const aiTagInflightRef = useRef(false);
  const aiTagAbortRef = useRef(null);
  const aiTagCancelledRef = useRef(false);
  /** 取消自动打标并立刻恢复可扫描状态（避免卡死） */
  const cancelAutoTagging = useCallback(() => {
    aiTagCancelledRef.current = true;
    try { aiTagAbortRef.current?.abort(); } catch { /* ignore */ }
    aiTagInflightRef.current = false;
    autoTaggingRef.current = false;
    scanningRef.current = false;
    setAutoTagging(false);
    setScanning(false);
    setMsg(t('resources.autoTaggingCancelled'));
  }, [t]);

  const silentAiTagAfterScan = useCallback(async (discoveredItems, aiMap = {}, { onTagging, signal } = {}) => {
    if (!window.electronAPI?.resource?.listResources) return false;
    if (aiTagInflightRef.current) return false;
    aiTagInflightRef.current = true;
    const aborted = () => !!signal?.aborted;
    try {
      if (aborted()) return false;
      const resRes = await window.electronAPI.resource.listResources({ type: 'skill' });
      if (aborted()) return false;
      const managedList = resRes.success ? (resRes.resources || []) : [];
      if (!managedList.length) return false;
      const byId = new Map(managedList.map((r) => [r.id, r]));
      // 仅未归入任何用途的技能；已打标的一律跳过（不先整表 setResources，避免列表闪空）
      const targets = (discoveredItems || []).filter((item) => {
        if (!item.resourceId) return false;
        const managed = byId.get(item.resourceId);
        if (!managed) return false;
        return resolvePurposes(managed, aiMap).length === 0;
      });
      if (!targets.length) return false;

      // 确有未打标项：通知 UI 进入「自动打标中」
      if (typeof onTagging === 'function') onTagging();
      if (aborted()) return false;

      const mapped = await classifySkillsPurposeWithAi(targets.map((item) => {
        const managed = byId.get(item.resourceId);
        return {
          id: item.resourceId,
          name: item.name || managed?.name || '',
          description: item.description || managed?.description || '',
        };
      }), { signal });
      if (aborted()) return false;

      // AI 返回后再拉一次，跳过本轮已被其它路径打上用途的项
      try {
        const again = await window.electronAPI.resource.listResources({ type: 'skill' });
        if (again?.success) {
          for (const r of again.resources || []) byId.set(r.id, r);
        }
      } catch { /* ignore */ }

      const taggedIds = new Set();
      for (const item of targets) {
        if (aborted()) break;
        const existing = byId.get(item.resourceId);
        if (!existing) continue;
        // 落库前再确认一次，避免并发/同步后已打标被覆盖
        if (resolvePurposes(existing, aiMap).length > 0) continue;
        // AI 结果优先；缺失时用名称/简介启发式，避免残留「其它」
        const purpose = PURPOSE_SLUGS.includes(mapped[item.resourceId])
          ? mapped[item.resourceId]
          : inferPurposeHeuristic(
            item.name || existing.name || '',
            item.description || existing.description || '',
          );
        const kept = resourceTags(existing).filter((tag) => {
          if (PURPOSE_SLUGS.includes(tag)) return false;
          return !tagToPurpose(tag, aiMap);
        });
        try {
          const saveRes = await window.electronAPI.resource.saveResource({
            id: existing.id,
            type: 'skill',
            name: existing.name,
            display_name: existing.display_name || existing.name,
            description: existing.description || item.description || '',
            content: existing.content || item.content || '',
            metadata: { ...(existing.metadata || {}), tags: [...kept, purpose] },
          });
          if (!saveRes.success || !saveRes.resource) continue;
          byId.set(saveRes.resource.id, saveRes.resource);
          taggedIds.add(saveRes.resource.id);
        } catch { /* 单条失败继续 */ }
      }
      if (aborted() || !taggedIds.size) return true;
      setDiscovered((prev) => prev.map((item) => {
        const r = item.resourceId ? byId.get(item.resourceId) : null;
        if (!r || !taggedIds.has(r.id)) return item;
        return {
          ...item,
          metadata: r.metadata || {},
          description: r.description || item.description,
        };
      }));
      // 只局部合并已打标项，避免整表替换导致短暂空白
      setResources((prev) => prev.map((r) => (taggedIds.has(r.id) ? (byId.get(r.id) || r) : r)));
      return true;
    } catch (e) {
      if (e?.name === 'AbortError') return false;
      // 打标失败不阻断扫描结果
      return false;
    } finally {
      aiTagInflightRef.current = false;
    }
  }, []);

  const runScan = useCallback(async ({ silent = false, autoTag = !silent } = {}) => {
    if (!window.electronAPI?.resource) return;
    // 自动打标未结束时禁止再次手动扫描（读 ref，勿依赖 scanning state 以免重建 loadAll）
    if (!silent && (scanningRef.current || autoTaggingRef.current || aiTagInflightRef.current)) return;
    if (!silent) {
      scanningRef.current = true;
      setScanning(true);
      setError('');
      setMsg('');
    }
    let scanHint = '';
    try {
      const filters = scanFilters();
      const [scanRes, installRes] = await Promise.all([
        // 扫描即纳管：本机扫描到的 skill 即已纳管 skill
        window.electronAPI.resource.syncDiscovered(filters),
        window.electronAPI.resource.listAgentInstallations(filters),
      ]);
      if (scanRes.success) {
        const nextDiscovered = scanRes.items || [];
        setDiscovered(nextDiscovered);
        setScanStats(scanRes.scanStats || null);
        // 默认目录与扫描结果一并刷新
        await refreshDefaultScanRoots(filters, scanRes.scanStats);
        if (!silent) {
          scanHint = t('resources.scanDoneHint', {
            total: scanRes.scanStats?.totalOnDisk ?? nextDiscovered.length,
            imported: scanRes.imported || 0,
            updated: scanRes.updated || 0,
          });
          setMsg(scanHint);
        }
        // 仅手动扫描才自动打标；首屏/静默刷新绝不进入，避免 loading 卡死空白与重复打标
        if (autoTag && !silent) {
          // 扫描 UI 先结束，列表可交互；打标单独占 autoTagging
          scanningRef.current = false;
          setScanning(false);
          const ac = new AbortController();
          aiTagCancelledRef.current = false;
          aiTagAbortRef.current = ac;
          try {
            await silentAiTagAfterScan(nextDiscovered, purposeAiMapRef.current, {
              signal: ac.signal,
              onTagging: () => {
                if (aiTagCancelledRef.current) return;
                autoTaggingRef.current = true;
                setAutoTagging(true);
                setMsg(t('resources.autoTagging'));
              },
            });
          } finally {
            if (aiTagAbortRef.current === ac) aiTagAbortRef.current = null;
          }
        }
      } else if (!silent) {
        setError(scanRes.error || t('resources.scanFailed'));
      }
      if (installRes.success) {
        setAgentInstallations(installRes.agents || []);
      }
    } catch (e) {
      if (!silent) setError(e.message);
    } finally {
      if (!silent) {
        const cancelled = aiTagCancelledRef.current;
        autoTaggingRef.current = false;
        scanningRef.current = false;
        setAutoTagging(false);
        setScanning(false);
        // 取消时保留「已取消」提示；正常结束恢复扫描摘要
        if (!cancelled && scanHint) setMsg(scanHint);
        aiTagCancelledRef.current = false;
      }
    }
  }, [scanFilters, refreshDefaultScanRoots, silentAiTagAfterScan, t]);

  const loadAll = useCallback(async ({ silent = false } = {}) => {
    // 先扫描即纳管（入库），再读取 resources；打标不跟首屏走，避免整页空白
    await runScan({ silent, autoTag: false });
    await loadBase({ silent });
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
    refreshAfterAdopt();
  }, [refreshAfterAdopt]);

  // 首屏全量加载；之后筛选/搜索走 silent，避免列表被掏空
  useEffect(() => {
    let alive = true;
    (async () => {
      const silent = bootstrappedRef.current;
      if (silent) setSearching(true);
      try {
        await loadAll({ silent });
        if (alive) bootstrappedRef.current = true;
      } finally {
        if (alive) setSearching(false);
      }
    })();
    return () => { alive = false; };
  }, [loadAll]);

  // Esc 关闭编辑 / 清理模态（忙碌中不可关）
  useEffect(() => {
    if (!editorOpen && !cleanupOpen) return undefined;
    function onKey(e) {
      if (e.key !== 'Escape') return;
      if (busy === 'editor' || busy === 'cleanup' || idleLoading) return;
      if (editorOpen) setEditorOpen(false);
      if (cleanupOpen) {
        abortIdleAi();
        setCleanupOpen(false);
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [editorOpen, cleanupOpen, busy, idleLoading]);

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

  // 滚动/缩放时跟随锚点重定位，而不是关闭（与 RouteSelect / Providers 下拉一致）
  useEffect(() => {
    const anchorEl = projectMenu?.anchorEl;
    if (!anchorEl) return undefined;
    let raf = 0;
    const reposition = () => {
      if (raf) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        if (!anchorEl.isConnected) return;
        const r = anchorEl.getBoundingClientRect();
        setProjectMenu(prev => (prev ? {
          ...prev,
          anchor: { top: r.top, bottom: r.bottom, left: r.left, right: r.right },
        } : null));
      });
    };
    // capture=true：捕获内部滚动容器的 scroll（scroll 不冒泡）
    document.addEventListener('scroll', reposition, true);
    window.addEventListener('resize', reposition);
    return () => {
      if (raf) cancelAnimationFrame(raf);
      document.removeEventListener('scroll', reposition, true);
      window.removeEventListener('resize', reposition);
    };
  }, [projectMenu?.anchorEl]);

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
  }, [projectMenu, agents, promptAgents, assistantAgents, managedAppTargets]);

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

  function updateCustomScanDirs(dirs) {
    const next = [...new Set((dirs || []).map(d => String(d || '').trim()).filter(Boolean))];
    setCustomScanDirs(next);
    saveScanCustomDirs(next);
  }

  function removeCustomScanDir(dir) {
    updateCustomScanDirs(customScanDirs.filter(d => !sameSkillDir(d, dir)));
  }

  /** 添加用户扫描目录（去重）；与默认目录并列，不互斥 */
  async function pickCustomScanDir() {
    if (!window.electronAPI?.resource?.pickImportPath) return;
    try {
      const pick = await window.electronAPI.resource.pickImportPath({
        title: t('resources.scanPickDirTitle'),
        allowFile: false,
        allowDirectory: true,
      });
      if (pick.success && pick.path) {
        const p = String(pick.path).trim();
        // Windows 路径大小写/分隔符可能不一致，用归一化去重
        if (p && !customScanDirs.some(d => sameSkillDir(d, p))) {
          updateCustomScanDirs([...customScanDirs, p]);
        }
      }
    } catch (e) {
      setError(e.message);
    }
  }

  // 展开扫描面板时拉取默认监控目录；首次挂载也拉一次
  useEffect(() => {
    refreshDefaultScanRoots();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps -- 仅启动时

  useEffect(() => {
    if (!scanExpanded) return undefined;
    refreshDefaultScanRoots();
    return undefined;
  }, [scanExpanded, refreshDefaultScanRoots]);

  function toggleScanPanel() {
    setScanExpanded(v => !v);
  }

  async function handleInstall(catalogId) {
    // 依赖缺失的智能体：纳管前确认，避免静默带上坏数据
    const catalogItem = catalog.find(c => c.catalogId === catalogId);
    if (catalogItem?.type === 'assistant' && catalogItem.depsBroken && catalogItem.missingDeps?.length) {
      const list = catalogItem.missingDeps.map(d => `${d.type}:${d.name}`).join(', ');
      if (!window.confirm(t('resources.depsBrokenConfirm', { list }))) return;
    }
    setBusy(catalogId);
    setMsg('');
    setError('');
    try {
      // 用户推荐项：先服务端结算（扣 8 / 奖推荐人 5，额度后台可改）
      const meta = catalogItem?.metadata || {};
      const needSettle = !!(meta.user_recommended && meta.recommender_user_id);
      if (needSettle) {
        if (!localStorage.getItem('token')) {
          setError(t('resources.recommendNeedLogin'));
          return;
        }
        try {
          const { data: settled } = await settleCommunityCatalogInstall(catalogId);
          if (settled?.item) {
            try {
              await window.electronAPI.resource.upsertCommunitySkill?.({ item: settled.item });
            } catch { /* 缓存写入失败仍尝试本地纳管 */ }
          }
          if (settled?.charged) {
            setMsg(t('resources.installCharged', {
              cost: settled.install_cost,
              reward: settled.recommend_reward,
            }));
          }
        } catch (e) {
          setError(formatApiError(e, t('resources.installSettleFailed')));
          return;
        }
      }

      const res = await window.electronAPI.resource.installCatalog({ catalogId });
      if (!res.success) {
        setError(res.error || t('resources.installFailed'));
        return;
      }
      setMsg((prev) => {
        const base = res.alreadyInstalled ? t('resources.alreadyManaged') : t('resources.installOk');
        return prev && needSettle ? `${prev} · ${base}` : base;
      });
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
          const filters = { type: typeFilter || undefined, query: debouncedQuery || undefined };
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
      setError(e.message);
    } finally {
      setBusy('');
    }
  }

  /** 推荐本机 Skill 到社区：他人可见并可纳管（纳管扣积分、推荐人获奖） */
  async function handleRecommendToCommunity(skillLike) {
    if (!localStorage.getItem('token')) {
      setError(t('resources.recommendNeedLogin'));
      return;
    }
    const managed = skillLike?.resourceId
      ? resourcesById.get(skillLike.resourceId)
      : (skillLike?.id ? resourcesById.get(skillLike.id) : null);
    const name = String(managed?.name || skillLike?.name || '').trim();
    if (!name) {
      setError(t('resources.recommendNeedContent'));
      return;
    }
    let content = String(managed?.content || skillLike?.content || '').trim();
    // 列表行常无正文：从权威路径读文件
    if (!content && skillLike?.authorityPath && window.electronAPI?.resource?.previewFile) {
      try {
        const prev = await window.electronAPI.resource.previewFile({
          targetPath: skillLike.authorityPath,
        });
        if (prev?.success && prev.content) content = String(prev.content).trim();
      } catch { /* ignore */ }
    }
    if (!content) {
      setError(t('resources.recommendNeedContent'));
      return;
    }
    const busyKey = `rec-${managed?.id || skillLike?.resourceId || name}`;
    if (!window.confirm(t('resources.recommendConfirm', { name }))) return;
    setBusy(busyKey);
    setError('');
    setMsg('');
    try {
      const { data } = await recommendCommunitySkill({
        name,
        content,
        display_name: managed?.display_name || skillLike?.display_name || name,
        description: managed?.description || skillLike?.description || '',
        metadata: {
          ...(managed?.metadata || skillLike?.metadata || {}),
          tags: managed?.metadata?.tags || skillLike?.metadata?.tags,
        },
      });
      if (data?.item) {
        try {
          await window.electronAPI.resource.upsertCommunitySkill?.({ item: data.item });
        } catch { /* ignore */ }
      }
      try {
        await window.electronAPI.resource.syncCommunityCatalog?.();
      } catch { /* ignore */ }
      // 刷新目录列表，推荐 Tab 可见
      try {
        const catRes = await window.electronAPI.resource.listCatalog({});
        if (catRes.success) setCatalog(catRes.items || []);
      } catch { /* ignore */ }
      setMsg(t('resources.recommendOk', { name: data?.item?.display_name || name }));
    } catch (e) {
      setError(formatApiError(e, t('resources.recommendFailed')));
    } finally {
      setBusy('');
    }
  }

  async function handleOpenPath(targetPath) {
    if (!targetPath || !window.electronAPI?.resource?.openPath) return;
    try {
      const res = await window.electronAPI.resource.openPath({ targetPath });
      if (!res?.success) setError(res?.error || t('resources.openPathFailed'));
    } catch (e) {
      setError(e.message);
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
        // 打标后同步 metadata，用途芯片可立刻更新
        metadata: resource.metadata || {},
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
        setError(t('resources.deleteNeedUnproject'));
        return;
      }
    }
    if (!window.confirm(t('resources.deleteConfirm', { name: resource.display_name || resource.name }))) return;
    setBusy(resource.id);
    try {
      const res = await window.electronAPI.resource.deleteResource(resource.id);
      if (!res.success) {
        setError(res.error || t('resources.deleteFailed'));
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

  /** Skill 卸载：有投射则确认强制撤投射并删权威目录 */
  async function handleUninstallSkill(item) {
    const resourceId = item.resourceId || item.id;
    if (!resourceId) return;
    const authorityPath = item.authorityPath || getSkillLocation(item);
    const name = item.display_name || item.name;
    const hasLinks = hasProjectedLinks(item.projections, authorityPath);
    // 系统弹窗确认（列表很长时顶部提示看不见）
    const ok = window.confirm(
      hasLinks
        ? t('resources.uninstallForceConfirm', { name })
        : t('resources.uninstallConfirm', { name }),
    );
    if (!ok) return;
    setBusy(resourceId);
    try {
      // 先撤可取消投射：不依赖 preload 是否已重载 force 参数，避免仍被后端拦截
      const removable = (item.projections || []).filter((p) => canUnprojectProjection(p, authorityPath));
      for (const p of removable) {
        const up = await window.electronAPI.resource.unproject({
          resourceId,
          agentId: p.agentId,
          projectionId: p.id,
        });
        if (!up?.success) {
          window.alert(up?.error || t('resources.unprojectFailed'));
          return;
        }
      }
      // force:true 双保险（preload 已更新时由主进程一并处理）
      const res = await window.electronAPI.resource.deleteResource(resourceId, { force: true });
      if (!res.success) {
        window.alert(res.error || t('resources.uninstallFailed'));
        return;
      }
      removeResourceLocally(resourceId, { ...item, id: resourceId, type: 'skill' });
    } finally {
      setBusy('');
    }
  }

  /** 中止进行中的闲置 AI 分析（关面板 / 重新扫描） */
  function abortIdleAi() {
    try { idleAiAbortRef.current?.abort(); } catch { /* ignore */ }
    idleAiAbortRef.current = null;
  }

  /** 根据分析结果同步默认勾选（只勾已分析且推荐项；无推荐时勾已分析全部） */
  function applyIdleSelectionFromMap(items, map, { streaming = false } = {}) {
    const analyzed = (items || []).filter((it) => map?.[it.id]);
    const recommended = analyzed
      .filter((it) => map[it.id]?.recommend)
      .map((it) => it.id);
    if (recommended.length) {
      setIdleSelected(recommended);
      return;
    }
    // 流式过程中无推荐则先不勾；结束后无推荐则勾已分析全部
    setIdleSelected(streaming ? [] : analyzed.map((it) => it.id));
  }

  /** 对闲置列表做大模型分析：每批 30 条，分析一条上屏一条 */
  async function analyzeIdleWithAi(items, days) {
    abortIdleAi();
    const ac = typeof AbortController !== 'undefined' ? new AbortController() : null;
    idleAiAbortRef.current = ac;
    setIdleAiLoading(true);
    setIdleAiMap({});
    setIdleSelected([]);
    setIdleAiMeta({ source: '', error: '' });
    setIdleAiProgress({ done: 0, total: (items || []).length, batch: 0, batches: 0 });
    try {
      // 附上用途标签，供模型从「习惯/画像/质量」综合判断
      const enriched = (items || []).map((it) => ({
        ...it,
        purposes: purposesOf(it),
      }));
      const { map, source, error, skippedHeuristic } = await analyzeIdleSkillsWithAi(enriched, {
        days,
        lang: lang === 'en' ? 'en' : 'zh',
        signal: ac?.signal,
        onProgress: (p) => setIdleAiProgress(p),
        onPartial: (partial) => {
          setIdleAiMap(partial || {});
          applyIdleSelectionFromMap(enriched, partial || {}, { streaming: true });
        },
      });
      if (ac?.signal?.aborted) return;
      setIdleAiMap(map || {});
      setIdleAiMeta({
        source: source || '',
        error: error || '',
        skippedHeuristic: skippedHeuristic || 0,
      });
      applyIdleSelectionFromMap(items, map || {});
    } catch (e) {
      if (String(e.message || e) === 'aborted') return;
      setIdleAiMap({});
      setIdleAiMeta({ source: 'heuristic', error: e.message || String(e) });
      setIdleSelected((items || []).map((it) => it.id));
    } finally {
      if (idleAiAbortRef.current === ac) idleAiAbortRef.current = null;
      setIdleAiLoading(false);
      setIdleAiProgress(null);
    }
  }

  /** 按指定天数扫描闲置 Skill，并自动触发大模型分析 */
  async function scanIdleSkills(days = idleDays, { closeOnError = false } = {}) {
    if (!window.electronAPI?.resource?.listIdleSkills) return;
    abortIdleAi();
    const n = Math.max(1, Math.min(3650, Math.floor(Number(days) || DEFAULT_IDLE_DAYS)));
    setIdleDays(n);
    saveIdleDays(n);
    setIdleLoading(true);
    setIdleResult(null);
    setIdleSelected([]);
    setIdleAiMap({});
    setIdleAiMeta({ source: '', error: '' });
    setIdleAiProgress(null);
    try {
      const res = await window.electronAPI.resource.listIdleSkills({ days: n });
      if (!res.success) {
        setError(res.error || t('resources.cleanupScanFailed'));
        if (closeOnError) setCleanupOpen(false);
        return;
      }
      setIdleResult(res);
      // 先进入分析态再结束扫描态，避免中间一帧露出未分析列表
      if ((res.items || []).length) setIdleAiLoading(true);
      setIdleLoading(false);
      // 扫描完成后分批分析；结果在分析结束后再展示
      await analyzeIdleWithAi(res.items || [], n);
    } catch (e) {
      setError(e.message);
      if (closeOnError) setCleanupOpen(false);
      setIdleLoading(false);
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
    const items = idleResult?.items || [];
    const recommended = items.filter((it) => idleAiMap[it.id]?.recommend).map((it) => it.id);
    // 有推荐时：全选推荐 ↔ 清空；无推荐：全选全部 ↔ 清空
    const target = recommended.length ? recommended : items.map((i) => i.id);
    setIdleSelected((prev) => (
      prev.length === target.length && target.every((id) => prev.includes(id)) ? [] : target
    ));
  }

  /** 一键清理勾选的闲置 Skill */
  async function confirmSkillCleanup() {
    if (!idleSelected.length) {
      setError(t('resources.cleanupPick'));
      return;
    }
    if (!window.confirm(t('resources.cleanupConfirm', { n: idleSelected.length, days: idleDays }))) {
      return;
    }
    setBusy('cleanup');
    try {
      const res = await window.electronAPI.resource.cleanupSkills({ resourceIds: idleSelected });
      if (!res.success && !res.cleaned) {
        setError(res.error || t('resources.cleanupFailed'));
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
        setError(t('resources.cleanupPartial', {
          ok: res.cleaned || 0,
          fail: failed.length,
        }));
      } else {
        setMsg(t('resources.cleanupOk', { n: res.cleaned || 0 }));
      }
      // 已在上方 removeResourceLocally，无需 loadAll
    } catch (e) {
      setError(e.message);
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
    const anchorEl = e.currentTarget; // 存活引用：滚动时据此重定位（异步 await 后 e.currentTarget 会失效）
    const rect = anchorEl.getBoundingClientRect();
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
      anchorEl,
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
      // prompt / 智能体：目标 = 全部已纳管应用（与 Gateway 应用列表同源，保证一致）
      try {
        const apps = await window.electronAPI.apps.list();
        setManagedAppTargets(deriveManagedAppTargets(apps));
      } catch { /* apps 拉取失败时回退到 agents 列表 */ }
    } catch { /* ignore */ }
  }

  async function confirmProject() {
    if (!projectMenu) return;
    if (!projectSelected.length) {
      setError(t('resources.pickAgent'));
      return;
    }
    const { resourceId } = projectMenu;
    // 依赖缺失的智能体：投射到应用前确认
    const target = resources.find(r => r.id === resourceId);
    if (target?.type === 'assistant' && target.depsBroken && target.missingDeps?.length) {
      const list = target.missingDeps.map(d => `${d.type}:${d.name}`).join(', ');
      if (!window.confirm(t('resources.depsBrokenConfirm', { list }))) return;
    }
    setProjectMenu(null);
    setBusy(resourceId);
    setError('');
    try {
      const res = await window.electronAPI.resource.project({
        resourceId,
        agentIds: projectSelected,
      });
      if (!res.success) {
        setError(res.error || t('resources.projectFailed'));
        return;
      }
      // 目标处存在同名的其他目录：默认不覆盖，询问后再强制
      let finalRes = res;
      if (res.conflicts?.length
        && window.confirm(t('resources.forceProjectConfirm', { hint: res.hint || '' }))) {
        finalRes = await window.electronAPI.resource.project({
          resourceId,
          agentIds: projectSelected,
          force: true,
        });
        if (finalRes.success) setMsg(finalRes.hint || t('resources.projectOk'));
        else setError(finalRes.error || t('resources.projectFailed'));
      } else if (res.conflicts?.length) {
        setMsg(res.hint || t('resources.projectSkippedConflict'));
      } else {
        setMsg(res.hint || t('resources.projectOk'));
      }
      // 用返回资源局部更新投射状态，避免整页重刷
      if (finalRes?.success && finalRes.resource) {
        applyResourcePatch(resourceId, finalRes.resource);
      }
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy('');
    }
  }

  /** 取消投射：优先按 projectionId，避免同 agent 多条时误删/找不到 */
  async function handleUnproject(resource, projOrAgentId) {
    const resourceId = resource?.id || resource?.resourceId;
    const proj = projOrAgentId && typeof projOrAgentId === 'object' ? projOrAgentId : null;
    const agentId = proj ? proj.agentId : projOrAgentId;
    if (!resourceId || !agentId) return;

    const busyKey = `${resourceId}-${agentId}`;
    setBusy(busyKey);
    setError('');
    // 先乐观去掉标签，避免「点了没反应」的观感；失败再回滚
    const prevProjs = resource.projections || [];
    const optimistic = prevProjs.filter((p) => (proj?.id ? p.id !== proj.id : p.agentId !== agentId));
    applyResourcePatch(resourceId, { ...resource, id: resourceId, projections: optimistic });

    try {
      const res = await window.electronAPI.resource.unproject({
        resourceId,
        agentId,
        ...(proj?.id ? { projectionId: proj.id } : {}),
      });
      if (!res?.success) {
        applyResourcePatch(resourceId, { ...resource, id: resourceId, projections: prevProjs });
        const err = res?.error || t('resources.unprojectFailed');
        setError(err);
        window.alert(err);
        return;
      }
      if (res.resource) applyResourcePatch(resourceId, res.resource);
      setMsg(t('resources.unprojectOk'));
    } catch (e) {
      applyResourcePatch(resourceId, { ...resource, id: resourceId, projections: prevProjs });
      const err = e?.message || t('resources.unprojectFailed');
      setError(err);
      window.alert(err);
    } finally {
      setBusy('');
    }
  }

  /** Hit-or-Exit：对该资源撤掉全部投射（沉睡/休眠轻推，不进清理面板） */
  async function handleUnprojectAll(resource) {
    const projs = resource?.projections || [];
    if (!projs.length) {
      setMsg(t('resources.layer.alreadyCold'));
      return;
    }
    const name = resource.display_name || resource.name || '';
    if (!window.confirm(t('resources.layer.unprojectConfirm', { name, n: projs.length }))) return;
    setBusy(`cold-${resource.id}`);
    setError('');
    try {
      let last = resource;
      for (const p of projs) {
        const res = await window.electronAPI.resource.unproject({
          resourceId: resource.id,
          agentId: p.agentId,
          projectionId: p.id,
        });
        if (!res.success) {
          setError(res.error || t('resources.unprojectFailed'));
          return;
        }
        last = res.resource || { ...last, projections: (last.projections || []).filter(x => x.id !== p.id) };
      }
      applyResourcePatch(resource.id, { ...last, projections: [] });
      setMsg(t('resources.layer.unprojectDone', { name }));
    } finally {
      setBusy('');
    }
  }

  function openCreateEditor() {
    setEditorForm({
      ...EMPTY_EDITOR,
      type: typeFilter || 'prompt',
      // 新建时若正筛「图片」提示词，默认归为图片类
      promptKind: typeFilter === 'prompt' && promptKindFilter === 'image' ? 'image' : 'text',
      // 当前标签筛选项预填，便于归类
      tagsText: tagFilter || '',
      metadata: {},
    });
    setEditorOpen(true);
  }

  /** Skill 类型：打开安装对话框，由资源安装智能体执行 */
  function handlePrimaryAction() {
    if (typeFilter === 'skill') {
      setSkillInstallOpen(true);
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
      promptKind: promptKindOf(resource),
      tagsText: resourceTags(resource).join(', '),
      // 保留原 metadata，避免编辑时冲掉其它字段
      metadata: { ...(resource.metadata || {}) },
    });
    setEditorOpen(true);
  }

  async function saveEditor() {
    const name = String(editorForm.name || '').trim();
    if (!name) {
      setError(t('resources.editorNameRequired'));
      return;
    }
    setBusy('editor');
    try {
      const metadata = { ...(editorForm.metadata || {}) };
      if (editorForm.type === 'prompt') {
        metadata.promptKind = editorForm.promptKind === 'image' ? 'image' : 'text';
      }
      metadata.tags = parseTagsInput(editorForm.tagsText);
      const res = await window.electronAPI.resource.saveResource({
        id: editorForm.id || undefined,
        type: editorForm.type,
        name,
        display_name: editorForm.display_name || name,
        description: editorForm.description || '',
        content: editorForm.content || '',
        metadata,
      });
      if (!res.success) {
        setError(res.error || t('resources.saveFailed'));
        return;
      }
      setEditorOpen(false);
      setMsg(t('resources.saveOk'));
      changeViewTab('managed');
      if (res.resource) upsertResourceLocally(res.resource);
    } catch (e) {
      setError(e.message);
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
        if (!pick.canceled && pick.error) setError(pick.error);
        return;
      }
      const res = await window.electronAPI.resource.importFromPath({
        sourcePath: pick.path,
        type: typeFilter || undefined,
      });
      if (!res.success) {
        setError(res.error || t('resources.importFailed'));
        return;
      }
      if (res.hint) setMsg(res.hint);
      else if (res.alreadyInstalled) setMsg(t('resources.alreadyManaged'));
      else setMsg(t('resources.importOk'));
      changeViewTab('managed');
      if (res.resource) upsertResourceLocally(res.resource);
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy('');
    }
  }

  // 目录 / 本机：提示词按文本|图片子类筛选
  const matchPromptKind = (r) => {
    if (typeFilter !== 'prompt' || !promptKindFilter) return true;
    if (r.type && r.type !== 'prompt') return true;
    return promptKindOf(r) === promptKindFilter;
  };

  /** 资源用途列表（含发现项从已纳管补 tags） */
  const purposesOf = useCallback((item, managedLookup) => {
    let probe = item;
    if (managedLookup && !(resourceTags(item).length || item?.metadata?.category)) {
      if (item?.resourceId && managedLookup.get(item.resourceId)) {
        probe = managedLookup.get(item.resourceId);
      } else if (item?.name) {
        const byName = [...managedLookup.values()].find(
          r => r.name === item.name && r.type === (item.type || 'skill'),
        );
        if (byName) probe = byName;
      }
    }
    return resolvePurposes(probe, purposeAiMap);
  }, [purposeAiMap]);

  /** 用途匹配（other = 未归入任一一级用途） */
  const matchTag = (item, managedLookup) => {
    if (!tagFilter) return true;
    const ps = purposesOf(item, managedLookup);
    if (tagFilter === PURPOSE_OTHER) return ps.length === 0;
    return ps.includes(tagFilter);
  };

  /** 名称/描述/标签本地搜索（不再靠后端 query 重扫） */
  const matchQuery = useCallback((item) => {
    const q = String(debouncedQuery || '').trim().toLowerCase();
    if (!q) return true;
    const hay = [
      item?.name, item?.display_name, item?.description,
      ...(resourceTags(item) || []),
      item?.metadata?.category,
    ].filter(Boolean).join('\n').toLowerCase();
    return hay.includes(q);
  }, [debouncedQuery]);

  // 类型切换：目录项必须与 typeFilter 一致（空=全部）
  const filteredCatalog = catalog.filter(r =>
    (!typeFilter || r.type === typeFilter)
    && matchPromptKind(r) && matchTag(r) && matchQuery(r),
  );
  // 已纳管计数：跟随当前类型筛选，避免「智能体」Tab 显示全库数量
  const managedCount = typeFilter
    ? resources.filter(r => r.type === typeFilter).length
    : resources.length;
  const discoveredCount = scanStats?.totalOnDisk ?? discovered.length;
  const showSkillTabs = !typeFilter || typeFilter === 'skill';

  // 当前类型下的已纳管资源（分层/轻推与列表共用，避免串类型）
  const resourcesInType = useMemo(
    () => (typeFilter ? resources.filter(r => r.type === typeFilter) : resources),
    [resources, typeFilter],
  );

  // Hit-or-Exit：轻推条 + 分层计数
  const lifecycleNudges = useMemo(() => {
    const now = Date.now();
    return resourcesInType
      .filter((r) => !isLifecycleExempt(r))
      .map((r) => ({ r, life: classifyLifecycle(r, now) }))
      .filter(({ life }) => life.nudge)
      .sort((a, b) => b.life.ageMs - a.life.ageMs)
      .slice(0, 5);
  }, [resourcesInType]);

  // 分层计数：空层不占筛选位（Simplicity）
  const layerCounts = useMemo(() => {
    const counts = { active: 0, pending: 0, dormant: 0, cold: 0, shelf: 0 };
    for (const r of resourcesInType) {
      if (isLifecycleExempt(r)) continue;
      const layer = classifyLifecycle(r).layer;
      if (counts[layer] != null) counts[layer] += 1;
    }
    return counts;
  }, [resourcesInType]);

  const changeLayerFilter = useCallback((next) => {
    setLayerFilter(next);
    try { localStorage.setItem(LAYER_FILTER_KEY, next); } catch { /* ignore */ }
  }, []);

  const copyInvokeFor = useCallback(async (resource) => {
    const text = buildInvokeText(resource, lang === 'en' ? 'en' : 'zh');
    if (!text) return;
    const ok = await copyText(text);
    setMsg(ok
      ? t('resources.enabledWithInvoke', { name: resource.display_name || resource.name, invoke: text })
      : text);
  }, [lang, t]);

  // 「本机」Tab 计数：技能=磁盘总数;提示词/助手=该类型已纳管数;全部=非 skill 已纳管 + 磁盘 skill
  const localCount = typeFilter === 'skill'
    ? discoveredCount
    : typeFilter
      ? managedCount
      : resources.filter(r => r.type !== 'skill').length + discoveredCount;

  // 应用筛选：prompt / skill / 智能体均按已纳管应用
  const installedFilterAgents = agents;
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

  // 若上次筛到了当前类型不可用的 Agent，回退到全部
  const effectiveAppFilter = (() => {
    if (!appFilter) return '';
    if (!isAgentAppId(appFilter)) return '';
    if (!appFilterOptions.some((o) => o.id === appFilter)) return '';
    return appFilter;
  })();

  const resourcesById = useMemo(
    () => new Map(resources.map(r => [r.id, r])),
    [resources],
  );

  /** agentId → 应用展示名：投射标签缺 label 时回退用，避免直接暴露 app-xxxx 原始 id */
  const appNameById = useMemo(() => {
    const map = new Map();
    for (const a of managedAppTargets) {
      if (a?.id && a.label) map.set(a.id, a.label);
    }
    for (const a of agents) {
      if (a?.id && a.label && !map.has(a.id)) map.set(a.id, a.label);
    }
    return map;
  }, [managedAppTargets, agents]);

  /** `${type}:${name}` → 声明绑定它的智能体列表（skill / prompt） */
  const resourceBoundByAssistants = useMemo(() => {
    const map = new Map();
    const add = (type, name, binder) => {
      const n = String(name || '').trim();
      if (!n) return;
      const key = `${type}:${n}`;
      if (!map.has(key)) map.set(key, []);
      const list = map.get(key);
      if (!list.some((x) => x.id === binder.id || x.name === binder.name)) {
        list.push(binder);
      }
    };
    for (const a of assistantsForBind) {
      const { skills, prompts } = depsFromAssistantContent(a.content);
      if (!skills.length && !prompts.length) continue;
      const binder = {
        id: a.id,
        name: a.name,
        label: a.display_name || a.name || a.id,
      };
      for (const sk of skills) add('skill', sk, binder);
      for (const pr of prompts) add('prompt', pr, binder);
    }
    return map;
  }, [assistantsForBind]);

  /** 各 Agent / 自添目录的本机技能数（来自 listAgentInstallations） */
  const skillCountByAgentId = useMemo(() => {
    const m = new Map();
    for (const a of agentInstallations) {
      if (a.id === 'custom') continue;
      m.set(a.id, a.count || 0);
    }
    return m;
  }, [agentInstallations]);

  const skillCountByCustomDir = useMemo(() => {
    const m = new Map();
    const custom = agentInstallations.find(a => a.id === 'custom');
    for (const item of custom?.items || []) {
      const root = item.customScanRoot;
      if (!root) continue;
      m.set(root, (m.get(root) || 0) + 1);
    }
    return m;
  }, [agentInstallations]);

  function countForCustomScanDir(dir) {
    for (const [root, n] of skillCountByCustomDir) {
      if (sameSkillDir(root, dir)) return n;
    }
    return 0;
  }

  const filteredDiscovered = discovered
    .filter(item => !effectiveAppFilter || (item.agents || []).some(a => a.agentId === effectiveAppFilter))
    .filter(item => matchTag(item, resourcesById))
    .filter(item => matchQuery(item));

  /**
   * 用途芯片：只展示「当前 Tab + 类型 + 应用筛选」下至少有一张卡片的用途。
   * 不计入 tagFilter 本身，否则选中后其它芯片会全部消失。
   * 同时统计各用途数量（一项可归入多个用途）与「全部」可见项总数。
   */
  const { availableTags, purposeCounts, purposeTotal, purposeOther } = useMemo(() => {
    const counts = Object.fromEntries(PURPOSE_SLUGS.map(s => [s, 0]));
    let total = 0;
    let other = 0;

    const visit = (item, managedLookup) => {
      total += 1;
      const ps = purposesOf(item, managedLookup).filter(p => counts[p] != null);
      if (!ps.length) {
        other += 1;
        return;
      }
      for (const p of ps) counts[p] += 1;
    };

    if (viewTab === 'managed') {
      // 与 renderLocalList 可见行对齐（不含用途筛选）
      if (!typeFilter || typeFilter !== 'skill') {
        const managedItems = typeFilter
          ? resources.filter(r => r.type === typeFilter)
          : resources.filter(r => r.type !== 'skill');
        for (const r of managedItems) {
          if (r.type === 'prompt' && !matchPromptKind(r)) continue;
          if (effectiveAppFilter
            && !(r.projections || []).some(p => p.agentId === effectiveAppFilter)) continue;
          visit(r);
        }
      }
      if (!typeFilter || typeFilter === 'skill') {
        for (const item of discovered) {
          if (effectiveAppFilter
            && !(item.agents || []).some(a => a.agentId === effectiveAppFilter)) continue;
          visit(item, resourcesById);
        }
      }
    } else {
      // 推荐 Tab：个性化缓存 + 下方社区目录
      try {
        const rt = typeFilter === 'prompt' || typeFilter === 'assistant' ? typeFilter : 'skill';
        const raw = localStorage.getItem(`tokenbank.resources.recommend.last.${rt}`);
        const doc = raw ? JSON.parse(raw) : null;
        for (const rec of (doc?.items || [])) {
          total += 1;
          const cat = String(rec?.category || '').trim();
          if (!cat) { other += 1; continue; }
          const purpose = PURPOSE_SLUGS.includes(cat) ? cat : tagToPurpose(cat, purposeAiMap);
          if (!purpose || counts[purpose] == null) { other += 1; continue; }
          counts[purpose] += 1;
        }
      } catch { /* ignore */ }
      for (const r of catalog) {
        if (typeFilter && r.type && r.type !== typeFilter) continue;
        if (!matchPromptKind(r)) continue;
        visit(r);
      }
    }

    return {
      availableTags: PURPOSE_SLUGS.filter(s => counts[s] > 0),
      purposeCounts: counts,
      purposeTotal: total,
      purposeOther: other,
    };
  }, [
    viewTab, typeFilter, promptKindFilter, effectiveAppFilter,
    resources, discovered, catalog, resourcesById, purposeAiMap,
    recoPurposeRev, purposesOf,
  ]);

  // 用途筛选项已不存在时回退（含「其它」）
  useEffect(() => {
    if (!tagFilter) return;
    if (tagFilter === PURPOSE_OTHER) {
      if (purposeOther <= 0) setTagFilter('');
      return;
    }
    if (availableTags.length && !availableTags.includes(tagFilter)) {
      setTagFilter('');
    }
  }, [tagFilter, availableTags, purposeOther]);

  // 未知原始标签 → 调本地网关 AI 归入用途（有缓存，失败静默）
  useEffect(() => {
    const raw = new Set();
    const collect = (item) => {
      if (typeFilter && item.type && item.type !== typeFilter) return;
      for (const t of resourceTags(item)) raw.add(t);
      if (item?.metadata?.category) raw.add(item.metadata.category);
    };
    catalog.forEach(collect);
    resources.forEach(collect);
    discovered.forEach(collect);
    const unknown = [...raw].filter(t => !tagToPurpose(t, purposeAiMap));
    if (!unknown.length) return undefined;
    let cancelled = false;
    aggregateTagsWithAi(unknown, purposeAiMap).then((next) => {
      if (cancelled) return;
      const grew = unknown.some((t) => {
        const k = String(t || '').trim().toLowerCase().replace(/[_\s]+/g, '-');
        return next[k] && next[k] !== purposeAiMap[k];
      });
      if (grew) setPurposeAiMap(next);
    });
    return () => { cancelled = true; };
  }, [catalog, resources, discovered, typeFilter]); // eslint-disable-line react-hooks/exhaustive-deps -- 仅资源变化时尝试 AI 归类

  // Skill / Prompt / 智能体均可按主公（Cursor 等）筛选投射目标
  const showAppFilterBar = !typeFilter
    || typeFilter === 'skill'
    || typeFilter === 'prompt'
    || typeFilter === 'assistant';

  /** 已纳管列表上方的主公筛选：图标 + 名称（Skill / Prompt / 智能体） */
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
                className={`inline-flex items-center gap-2 px-3 py-1.5 rounded-full transition-colors ${
                  active
                    ? 'tb-soft-bubble !rounded-full text-zinc-900 dark:text-zinc-100'
                    : 'tb-soft-tile !rounded-full'
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

  /** 用途筛选条：零散 tag 已聚合成 SkillHub 一级用途 */
  function purposeLabel(slug) {
    if (slug === PURPOSE_OTHER) return t('resources.tagFilterOther');
    const key = `resources.reco.cat.${slug}`;
    const v = t(key);
    return v === key ? slug : v;
  }

  /** 用途芯片：玻璃底 + 选中亮片，去掉蓝边网页感 */
  function purposeChipClass(active, size = 'md') {
    const pad = size === 'sm' ? 'text-[10px] px-2 py-0.5 rounded-md' : 'text-[11px] px-2.5 py-1 rounded-lg';
    const round = size === 'sm' ? '!rounded-md' : '!rounded-lg';
    return active
      ? `tb-press tb-soft-bubble ${pad} text-zinc-900 dark:text-zinc-100 font-medium`
      : `tb-press tb-soft-tile ${pad} ${round} text-zinc-600 dark:text-zinc-400`;
  }

  function renderTagFilter() {
    if (availableTags.length === 0 && purposeOther <= 0) return null;
    return (
      <div className="flex flex-wrap items-center gap-1.5" title={t('resources.tagFilterHint')}>
        <button
          type="button"
          onClick={() => setTagFilter('')}
          className={purposeChipClass(!tagFilter)}
        >
          {t('resources.tagFilterAll')}
          <span className="ml-1 tabular-nums opacity-60">{purposeTotal}</span>
        </button>
        {availableTags.map(slug => {
          const active = tagFilter === slug;
          const n = purposeCounts[slug] || 0;
          return (
            <button
              key={slug}
              type="button"
              onClick={() => setTagFilter(active ? '' : slug)}
              className={purposeChipClass(active)}
            >
              {purposeLabel(slug)}
              <span className="ml-1 tabular-nums opacity-60">{n}</span>
            </button>
          );
        })}
        {purposeOther > 0 && (
          <button
            type="button"
            onClick={() => setTagFilter(tagFilter === PURPOSE_OTHER ? '' : PURPOSE_OTHER)}
            className={purposeChipClass(tagFilter === PURPOSE_OTHER)}
          >
            {purposeLabel(PURPOSE_OTHER)}
            <span className="ml-1 tabular-nums opacity-60">{purposeOther}</span>
          </button>
        )}
      </div>
    );
  }

  /** 用量徽标：行自身优先，Skill 扫描行回退已纳管资源 */
  function renderUseCountBadge(item) {
    const linked = item?.resourceId ? resourcesById.get(item.resourceId) : null;
    const n = Math.max(0, Number(item?.use_count ?? linked?.use_count ?? 0) || 0);
    if (n <= 0) return null;
    return (
      <span
        className="text-[10px] px-1.5 py-0.5 rounded-md bg-zinc-100 dark:bg-zinc-800 text-zinc-600 dark:text-zinc-300 tabular-nums whitespace-nowrap"
        title={t('resources.useCountHint', { n })}
      >
        {t('resources.useCount', { n })}
      </span>
    );
  }

  /** Skill/Prompt 被智能体 content.skills / prompts 声明绑定 → 卡片标记 */
  function renderAssistantBoundBadge(type, name) {
    if (type !== 'skill' && type !== 'prompt') return null;
    const binders = resourceBoundByAssistants.get(`${type}:${String(name || '').trim()}`);
    if (!binders?.length) return null;
    const sep = lang === 'en' ? ', ' : '、';
    const list = binders.map((b) => b.label).join(sep);
    const label = binders.length === 1
      ? t('resources.assistantBoundOne', { name: binders[0].label })
      : t('resources.assistantBoundMany', { n: binders.length });
    return (
      <span
        className="text-[10px] px-1.5 py-0.5 rounded-md bg-violet-100 dark:bg-violet-900/40 text-violet-700 dark:text-violet-300 whitespace-nowrap"
        title={t('resources.assistantBoundHint', { list })}
      >
        {label}
      </span>
    );
  }

  function renderDiscoveredRow(item) {
    // 同名 Skill 可能共用 scanKey（frontmatter name 相同），用 name+hash 保证 key 唯一
    const rowKey = `${item.name}::${item.hash}`;
    const expanded = expandedId === rowKey;
    const toggle = () => setExpandedId(expanded ? null : rowKey);
    const purposes = purposesOf(item, resourcesById);
    // 列表项不再带全文，预览回退到已纳管资源正文
    const previewSrc = (item.resourceId && resourcesById.get(item.resourceId)) || item;
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
        previewText={buildPreviewText('skill', previewSrc)}
        layout="row"
        badges={(
          <>
            {renderUseCountBadge(item)}
            {renderAssistantBoundBadge('skill', item.name)}
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
                  className="hover:text-blue-600 dark:hover:text-blue-400 hover:underline text-left truncate max-w-full"
                  title={item.authorityPath}
                  onClick={() => handleOpenPath(item.authorityPath)}
                >
                  {item.authorityPath}
                </button>
              </p>
            )}
            {/* 用途：扫描后自动打标，此处仅展示并可点选筛选 */}
            {purposes.length > 0 && (
              <div className="flex flex-wrap items-center gap-1.5 mt-2.5">
                {purposes.map(slug => (
                  <button
                    key={slug}
                    type="button"
                    title={t('resources.tagFilterHint')}
                    onClick={() => setTagFilter(tagFilter === slug ? '' : slug)}
                    className={purposeChipClass(tagFilter === slug, 'sm')}
                  >
                    {purposeLabel(slug)}
                  </button>
                ))}
              </div>
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
              disabled={!!busy && busy !== `rec-${item.resourceId}` && busy !== item.resourceId}
              onClick={() => handleRecommendToCommunity(item)}
              className={ASSET_BTN_GHOST}
              title={t('resources.recommendHint')}
            >
              {busy === `rec-${item.resourceId}` ? t('resources.busy') : t('resources.recommendCommunity')}
            </button>
            <button
              type="button"
              disabled={!!busy && busy !== item.resourceId}
              onClick={(e) => openProjectMenu(e, item.resourceId)}
              className={ASSET_BTN_PRIMARY}
            >
              {busy === item.resourceId ? t('resources.busy') : t('resources.project')}
            </button>
            <button
              type="button"
              disabled={!!busy && busy !== item.resourceId}
              onClick={() => handleUninstallSkill(item)}
              className="text-xs px-3 py-1.5 rounded-lg border border-red-200/90 text-red-600 hover:bg-red-50 dark:border-red-900 dark:hover:bg-red-950/30 disabled:opacity-45 transition active:scale-[0.98]"
              title={hasProjectedLinks(item.projections, item.authorityPath || getSkillLocation(item))
                ? t('resources.uninstallForceConfirm', { name: item.display_name || item.name })
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
              className={`tb-tag text-[10px] pl-2 ${canUnproject ? 'pr-0.5' : 'pr-2'} py-0.5 cursor-default ${
                canUnproject ? 'tb-tag-blue' : 'tb-tag-muted !border-solid'
              }`}
            >
              {/* p.label 对自定义应用回退成 agentId（后端无友好名），此时用 apps 列表的展示名 */}
              {(p.label && p.label !== p.agentId)
                ? p.label
                : (appNameById.get(p.agentId) || p.agentId)}
              {canUnproject && (
                <button
                  type="button"
                  className="tb-press electron-no-drag ml-0.5 w-4 h-4 inline-flex items-center justify-center rounded-full text-current/55 hover:text-red-500 hover:bg-black/5 dark:hover:bg-white/10 disabled:opacity-40"
                  title={t('resources.unproject')}
                  aria-label={t('resources.unproject')}
                  disabled={busy === `${resource.id || resource.resourceId}-${p.agentId}`}
                  onClick={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    handleUnproject(resource, p);
                  }}
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
    const builtin = isBuiltinResource(resource);
    return (
      <ResourceAssetCard
        key={id}
        type={resource.type}
        item={resource}
        typeLabel={typeBadge(resource.type, t)}
        categoryLabel={resource.type === 'prompt'
          ? t(promptKindOf(resource) === 'image' ? 'resources.promptKind.image' : 'resources.promptKind.text')
          : undefined}
        description={resourceDescription(resource)}
        previewText={buildPreviewText(resource.type, resource)}
        expanded={expanded}
        onTogglePreview={toggle}
        previewLabel={t('resources.preview')}
        collapseLabel={t('resources.collapse')}
        emptyPreviewLabel={t('resources.emptyDetail')}
        layout={catalogMode ? 'stack' : 'row'}
        className={catalogMode && expanded ? 'sm:col-span-2' : ''}
        badges={(
          <>
            {/* 内置：目录/本机统一「内置」徽标，目录卡不再伪装成社区分享人 */}
            {builtin && (
              <span
                className="text-[10px] px-1.5 py-0.5 rounded-md font-medium bg-sky-100 dark:bg-sky-900/40 text-sky-700 dark:text-sky-300 whitespace-nowrap"
                title={t('resources.builtinHint')}
              >
                {t('resources.source.builtin')}
              </span>
            )}
            {catalogMode && !builtin && (
              <span
                className="text-[10px] px-1.5 py-0.5 rounded-md bg-zinc-100/90 dark:bg-zinc-800/80 text-zinc-500 dark:text-zinc-400 whitespace-nowrap"
                title={t('resources.sharedByHint')}
              >
                {t('resources.sharedBy', { handle: catalogSharerHandle(resource) })}
              </span>
            )}
            {!catalogMode && !builtin && (
              <span className="text-[10px] text-zinc-400 tracking-wide">{sourceLabel(resource.source, t)}</span>
            )}
            {/* 用量次数：与排序一致，有命中才标 */}
            {!catalogMode && renderUseCountBadge(resource)}
            {/* 被智能体声明为 skill / prompt 依赖 */}
            {!catalogMode && renderAssistantBoundBadge(resource.type, resource.name)}
            {/* Hit-or-Exit 状态徽标（内置智能体不评估、不标） */}
            {!catalogMode && (() => {
              const life = classifyLifecycle(resource);
              if (life.layer === 'exempt') return null;
              if (life.layer === 'active') {
                return (
                  <span className="text-[10px] px-1.5 py-0.5 rounded-md bg-emerald-100 dark:bg-emerald-900/40 text-emerald-700 dark:text-emerald-300 whitespace-nowrap">
                    {t('resources.layer.active')}
                  </span>
                );
              }
              if (life.layer === 'pending') {
                return (
                  <span className="text-[10px] px-1.5 py-0.5 rounded-md bg-amber-100 dark:bg-amber-900/40 text-amber-800 dark:text-amber-200 whitespace-nowrap">
                    {t('resources.layer.pending')}
                  </span>
                );
              }
              if (life.layer === 'dormant') {
                return (
                  <span className="text-[10px] px-1.5 py-0.5 rounded-md bg-orange-100 dark:bg-orange-900/40 text-orange-800 dark:text-orange-200 whitespace-nowrap">
                    {t('resources.layer.dormant')}
                  </span>
                );
              }
              if (life.layer === 'cold') {
                return (
                  <span className="text-[10px] px-1.5 py-0.5 rounded-md bg-zinc-200 dark:bg-zinc-700 text-zinc-600 dark:text-zinc-300 whitespace-nowrap">
                    {t('resources.layer.cold')}
                  </span>
                );
              }
              if (life.layer === 'shelf') {
                return (
                  <span className="text-[10px] px-1.5 py-0.5 rounded-md bg-zinc-100 dark:bg-zinc-800 text-zinc-400 whitespace-nowrap">
                    {t('resources.layer.shelf')}
                  </span>
                );
              }
              return null;
            })()}
            {/* 智能体声明的 prompt 目录与本机均无 → 依赖缺失（skill 可执行时自装，不标） */}
            {resource.type === 'assistant' && resource.depsBroken && Array.isArray(resource.missingDeps) && (
              <span
                className="text-[10px] px-1.5 py-0.5 rounded-md bg-rose-100 dark:bg-rose-900/40 text-rose-700 dark:text-rose-300 whitespace-nowrap"
                title={t('resources.depsBrokenHint', {
                  list: resource.missingDeps.map(d => `${d.type}:${d.name}`).join(', '),
                })}
              >
                {t('resources.depsBroken')}
              </span>
            )}
          </>
        )}
        meta={(
          <>
            {!catalogMode && resource.type === 'skill' && (
              <p className="text-[11px] text-zinc-400 mt-2 font-mono truncate">
                <span className="text-zinc-500">{t('resources.skillLocation')}：</span>
                {loc ? (
                  <button
                    type="button"
                    className="hover:text-blue-600 dark:hover:text-blue-400 hover:underline truncate align-baseline max-w-full"
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
            {purposesOf(resource).length > 0 && (
              <div className="flex flex-wrap gap-1.5 mt-2.5">
                {purposesOf(resource).map(slug => (
                  <button
                    key={slug}
                    type="button"
                    title={t('resources.tagFilterHint')}
                    onClick={() => setTagFilter(tagFilter === slug ? '' : slug)}
                    className={purposeChipClass(tagFilter === slug, 'sm')}
                  >
                    {purposeLabel(slug)}
                  </button>
                ))}
              </div>
            )}
            {!catalogMode && renderProjections(resource)}
          </>
        )}
        actions={catalogMode ? (
          <button
            type="button"
            disabled={(!!busy && busy !== resource.catalogId) || resource.installed || builtin}
            onClick={() => handleInstall(resource.catalogId)}
            className={(resource.installed || builtin) ? ASSET_BTN_MANAGED : ASSET_BTN_PRIMARY}
          >
            {busy === resource.catalogId
              ? t('resources.busy')
              : (resource.installed || builtin)
                ? t('resources.managed')
                : t('resources.addManage')}
          </button>
        ) : (
          <>
            {resource.type === 'skill' && (
              <button
                type="button"
                className={ASSET_BTN_GHOST}
                disabled={!!busy && busy !== `rec-${resource.id}`}
                onClick={() => handleRecommendToCommunity(resource)}
                title={t('resources.recommendHint')}
              >
                {busy === `rec-${resource.id}` ? t('resources.busy') : t('resources.recommendCommunity')}
              </button>
            )}
            <button
              type="button"
              className={ASSET_BTN_GHOST}
              onClick={() => openEditEditor(resource)}
              disabled={busy === 'editor' || busy === 'cleanup'}
            >
              {t('resources.edit')}
            </button>
            <button
              type="button"
              disabled={!!busy && busy !== resource.id}
              onClick={(e) => openProjectMenu(e, resource.id)}
              className={ASSET_BTN_PRIMARY}
            >
              {busy === resource.id ? t('resources.busy') : t('resources.project')}
            </button>
            {resource.source !== 'builtin' && !resource.metadata?.builtin && (
              <button
                type="button"
                disabled={!!busy && busy !== resource.id}
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
   * 技能→扫描行(discovered);提示词/助手→managed 行。
   * 默认按用量排序：命中次数 → 最近使用 → 纳管时间。
   */
  function renderLocalList() {
    const showSkills = !typeFilter || typeFilter === 'skill';
    const byManagedAt = (a, b) => {
      const ta = Number(a.created_at || a.createdAt || 0);
      const tb = Number(b.created_at || b.createdAt || 0);
      if (tb !== ta) return tb - ta;
      return String(a.name || a.display_name || '').localeCompare(String(b.name || b.display_name || ''), 'zh-CN');
    };
    // 用量：优先行自身，Skill 扫描行回退到已纳管资源
    const usageOf = (item) => {
      const linked = item?.resourceId ? resourcesById.get(item.resourceId) : null;
      const useCount = Math.max(
        0,
        Number(item?.use_count ?? linked?.use_count ?? 0) || 0,
      );
      const lastUsed = Math.max(
        0,
        Number(item?.last_used_at ?? linked?.last_used_at ?? 0) || 0,
      );
      return { useCount, lastUsed };
    };
    const byUsage = (a, b) => {
      const ua = usageOf(a);
      const ub = usageOf(b);
      if (ub.useCount !== ua.useCount) return ub.useCount - ua.useCount;
      if (ub.lastUsed !== ua.lastUsed) return ub.lastUsed - ua.lastUsed;
      return byManagedAt(a, b);
    };
    // Hit-or-Exit：与分层计数同源；Skill 扫描行回退到已纳管资源再判定
    const matchLayer = (item) => {
      if (!layerFilter) return true;
      const linked = item?.resourceId ? resourcesById.get(item.resourceId) : null;
      const probe = linked || item;
      const life = classifyLifecycle(probe);
      if (life.layer === 'exempt') return false;
      return life.layer === layerFilter;
    };
    // 提示词/智能体：按 typeFilter 收窄；全部时排除 skill（技能走扫描行）
    const managedRows = (typeFilter === 'skill'
      ? []
      : (typeFilter ? resourcesInType : resources.filter(r => r.type !== 'skill')))
      .filter(r => {
        if (r.type === 'prompt' && !matchPromptKind(r)) return false;
        if (!matchTag(r)) return false;
        if (!matchQuery(r)) return false;
        if (!matchLayer(r)) return false;
        if (!effectiveAppFilter) return true;
        // Prompt / 智能体：按已投射到的 Agent 筛选
        return (r.projections || []).some(p => p.agentId === effectiveAppFilter);
      })
      .slice()
      .sort(byUsage);
    // 技能优先磁盘扫描行；扫描为空时回退已纳管 skill（避免分层有数、列表空白）
    const useDiscoveredSkills = showSkills && discovered.length > 0;
    const skillBase = !showSkills
      ? []
      : useDiscoveredSkills
        ? filteredDiscovered
        : resources
          .filter(r => r.type === 'skill')
          .filter(r => matchTag(r) && matchQuery(r))
          .filter(r => !effectiveAppFilter
            || (r.projections || []).some(p => p.agentId === effectiveAppFilter));
    const skillRows = skillBase.filter(matchLayer).slice().sort(byUsage);

    if (managedRows.length + skillRows.length === 0) {
      // 有本机 skill / 资源,但被来源应用筛选过滤空了
      if (showAppFilterBar && effectiveAppFilter && (discovered.length > 0 || resources.length > 0)) {
        return (
          <div className="space-y-3">
            {renderAppFilter()}
            <div className="text-center py-10 space-y-2">
              <p className="text-xs text-zinc-400">{t('resources.emptyDiscoveredFiltered')}</p>
              <button type="button" onClick={() => changeAppFilter('')} className="text-xs text-blue-600 hover:underline">
                {t('resources.clearAppFilter')}
              </button>
            </div>
          </div>
        );
      }
      if (tagFilter && (discovered.length > 0 || resources.length > 0)) {
        return (
          <div className="space-y-3">
            {showAppFilterBar && renderAppFilter()}
            <div className="text-center py-10 space-y-2">
              <p className="text-xs text-zinc-400">{t('resources.emptyTagFiltered')}</p>
              <button type="button" onClick={() => setTagFilter('')} className="text-xs text-blue-600 hover:underline">
                {t('resources.clearTagFilter')}
              </button>
            </div>
          </div>
        );
      }
      // 分层筛空：提示切回「全部」，避免误显示「暂无已纳管」
      if (layerFilter && resourcesInType.length > 0) {
        return (
          <div className="space-y-3">
            {showAppFilterBar && renderAppFilter()}
            <div className="text-center py-10 space-y-2">
              <p className="text-xs text-zinc-400">{t('resources.emptyLayerFiltered')}</p>
              <button type="button" onClick={() => changeLayerFilter('')} className="text-xs text-blue-600 hover:underline">
                {t('resources.clearLayerFilter')}
              </button>
            </div>
          </div>
        );
      }
      return (
        <div className="space-y-3">
          {showAppFilterBar && renderAppFilter()}
          <div className="text-center py-10 space-y-2">
            <p className="text-xs text-zinc-400">{t('resources.emptyManaged')}</p>
            <button type="button" onClick={() => changeViewTab('recommend')} className="text-xs text-blue-600 hover:underline">
              {t('resources.goCatalog')}
            </button>
          </div>
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
          {skillRows.map(item => (
            useDiscoveredSkills ? renderDiscoveredRow(item) : renderResourceRow(item)
          ))}
        </div>
      </div>
    );
  }

  function renderProjectMenu() {
    if (!projectMenu) return null;
    // 本机 Skill 行可能只在 discovered 里，需两边查找类型
    const resource = resources.find(r => r.id === projectMenu.resourceId)
      || discovered.find(i => i.resourceId === projectMenu.resourceId);
    // Skill 必须落盘到有 skills 目录的 agent（保持 agents）；
    // prompt / 智能体走 MCP/中转，可投到全部已纳管应用（含 Trae / API 应用）。
    const targetList = (resource?.type === 'prompt' || resource?.type === 'assistant')
      ? (managedAppTargets.length ? managedAppTargets : agents)
      : agents;
    const maxMenuH = Math.max(160, window.innerHeight - 16);
    return createPortal(
      <div
        ref={projectMenuRef}
        className="fixed z-[9999] w-56 flex flex-col rounded-2xl border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-800 shadow-lg overflow-hidden"
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
            className="tb-press flex-1 text-xs py-1.5 rounded-lg bg-blue-600 text-white hover:bg-blue-500 disabled:opacity-40"
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
    <div className="flex flex-col h-full min-h-0 bg-transparent">
      {/* 与下方内容同色：透明底，不单独铺白 */}
      <header className="shrink-0 px-4 pt-4 pb-2">
        <h1 className="text-lg font-semibold tracking-tight text-zinc-900 dark:text-zinc-50">{t('resources.title')}</h1>
        <p className="text-xs text-zinc-500 dark:text-zinc-400 mt-1">{t('resources.subtitle')}</p>
      </header>

      <div className="flex-1 min-h-0 overflow-y-auto px-4 py-3.5 space-y-3.5">
        {/* 类型筛选：与 Playground 分段同系 */}
        <div className="flex flex-wrap items-center gap-2">
          <div className="tb-glass-chip inline-flex flex-wrap rounded-2xl p-1 gap-0.5">
            {TYPE_OPTIONS.map(opt => (
              <button
                key={opt.id || 'all'}
                type="button"
                onClick={() => {
                  changeTypeFilter(opt.id);
                  if (opt.id !== 'prompt') setPromptKindFilter('');
                }}
                className={`tb-press text-xs px-3 py-1.5 rounded-xl transition-colors ${
                  typeFilter === opt.id
                    ? 'bg-white/80 dark:bg-white/10 text-zinc-900 dark:text-zinc-100 shadow-sm'
                    : 'text-zinc-600 dark:text-zinc-400 hover:text-zinc-900 dark:hover:text-zinc-100'
                }`}
              >
                {t(opt.labelKey)}
              </button>
            ))}
          </div>
          {/* 提示词：文本 / 图片 子分类 */}
          {typeFilter === 'prompt' && (
            <div className="tb-glass-chip inline-flex rounded-lg p-0.5 gap-0.5">
              {[
                { id: '', labelKey: 'resources.promptKind.all' },
                { id: 'text', labelKey: 'resources.promptKind.text' },
                { id: 'image', labelKey: 'resources.promptKind.image' },
              ].map(opt => (
                <button
                  key={opt.id || 'kind-all'}
                  type="button"
                  onClick={() => setPromptKindFilter(opt.id)}
                  className={`tb-press text-xs px-2.5 py-1.5 rounded-md transition-colors ${
                    promptKindFilter === opt.id
                      ? 'bg-white/80 dark:bg-white/10 text-zinc-900 dark:text-zinc-100 font-semibold'
                      : 'text-zinc-500 dark:text-zinc-400 hover:text-zinc-800 dark:hover:text-zinc-100'
                  }`}
                >
                  {t(opt.labelKey)}
                </button>
              ))}
            </div>
          )}
        </div>
        {/* 标签筛选：目录 + 已纳管聚合 */}
        {renderTagFilter()}

        {/* 子 Tab + 搜索 + 操作 */}
        <div className="space-y-2">
          <div className="flex flex-wrap items-center gap-2">
            <div className="tb-glass-chip inline-flex rounded-lg p-0.5">
              {[
                { id: 'managed', label: t('resources.tab.managed'), count: localCount },
                { id: 'recommend', label: t('resources.tab.recommend') },
              ].map(tab => (
                <button
                  key={tab.id}
                  type="button"
                  onClick={() => changeViewTab(tab.id)}
                  className={`tb-press text-xs px-3 py-1.5 rounded-md transition-colors ${
                    viewTab === tab.id
                      ? 'bg-white/80 dark:bg-white/10 font-semibold text-zinc-900 dark:text-zinc-100'
                      : 'text-zinc-500 hover:text-zinc-700 dark:hover:text-zinc-300'
                  }`}
                >
                  {tab.label}
                  {tab.count != null && <span className="ml-1 opacity-60">({tab.count})</span>}
                </button>
              ))}
            </div>
            <div className="relative flex-1 min-w-[160px] max-w-xs">
              <input
                type="search"
                value={query}
                onChange={e => setQuery(e.target.value)}
                placeholder={t('resources.searchPlaceholder')}
                className="tb-soft-field w-full text-xs px-3 py-1.5 pr-14 rounded-lg text-zinc-900 dark:text-zinc-100"
              />
              {searching && (
                <span className="absolute right-2.5 top-1/2 -translate-y-1/2 text-[10px] text-zinc-400 pointer-events-none">
                  {t('resources.searching')}
                </span>
              )}
            </div>
            <button
              type="button"
              disabled={busy === 'editor' || busy === 'cleanup'}
              onClick={handlePrimaryAction}
              className="tb-press text-xs px-3 py-1.5 rounded-lg bg-blue-600 text-white hover:bg-blue-500 disabled:opacity-50"
            >
              {typeFilter === 'skill' ? t('resources.skillInstall') : t('resources.create')}
            </button>
            <button
              type="button"
              disabled={busy === 'import' || busy === 'cleanup' || busy === 'editor'}
              onClick={handleImportFile}
              className="tb-press tb-soft-tile text-xs px-3 py-1.5 !rounded-lg text-zinc-700 dark:text-zinc-200 disabled:opacity-50"
            >
              {busy === 'import' ? t('resources.busy') : t('resources.import')}
            </button>
            {showSkillTabs && (
              <button
                type="button"
                onClick={toggleScanPanel}
                className={`tb-press text-xs px-3 py-1.5 rounded-lg border transition-colors ${
                  scanExpanded
                    ? 'border-blue-300 dark:border-blue-700 bg-blue-50 dark:bg-blue-950/40 text-blue-700 dark:text-blue-300'
                    : 'border-zinc-200 dark:border-zinc-700 text-zinc-600 dark:text-zinc-400 hover:bg-zinc-50 dark:hover:bg-zinc-800'
                }`}
              >
                {t('resources.scan')}
                <span className="ml-1 opacity-60">{scanExpanded ? '▴' : '▾'}</span>
              </button>
            )}
            {viewTab === 'managed' && (
              <button
                type="button"
                disabled={busy === 'cleanup' || idleLoading}
                onClick={openSkillCleanup}
                className="tb-press text-xs px-3 py-1.5 rounded-lg border border-amber-200 dark:border-amber-800 text-amber-700 dark:text-amber-300 hover:bg-amber-50 dark:hover:bg-amber-900/20 disabled:opacity-50"
              >
                {idleLoading ? t('resources.cleanupScanning') : t('resources.cleanup')}
              </button>
            )}
          </div>

          {/* Hit-or-Exit：分段筛选 + 紧凑轻推芯片 */}
          {viewTab === 'managed' && (
            <div className="space-y-2">
              <div
                className="inline-flex flex-wrap gap-0.5 p-0.5 rounded-xl border border-zinc-200/70 dark:border-zinc-700/70 bg-zinc-100/70 dark:bg-zinc-900/60"
                role="tablist"
                aria-label={t('resources.layer.filterAll')}
              >
                {[
                  { id: '', label: t('resources.layer.filterAll'), count: null },
                  { id: 'active', label: t('resources.layer.active'), count: layerCounts.active },
                  { id: 'pending', label: t('resources.layer.pending'), count: layerCounts.pending },
                  { id: 'dormant', label: t('resources.layer.dormant'), count: layerCounts.dormant },
                  { id: 'cold', label: t('resources.layer.cold'), count: layerCounts.cold },
                  { id: 'shelf', label: t('resources.layer.shelf'), count: layerCounts.shelf },
                ]
                  .filter((opt) => opt.id === '' || (opt.count != null && opt.count > 0) || layerFilter === opt.id)
                  .map((opt) => (
                    <button
                      key={opt.id || 'layer-all'}
                      type="button"
                      role="tab"
                      aria-selected={layerFilter === opt.id}
                      onClick={() => changeLayerFilter(opt.id)}
                      className={`tb-press text-[11px] px-2.5 py-1 rounded-lg transition-colors tabular-nums ${
                        layerFilter === opt.id
                          ? 'bg-white/80 dark:bg-white/10 text-zinc-900 dark:text-zinc-100 shadow-sm'
                          : 'text-zinc-500 hover:text-zinc-700 dark:hover:text-zinc-300'
                      }`}
                    >
                      {opt.label}
                      {opt.count != null && opt.count > 0 && (
                        <span className="ml-1 opacity-55">{opt.count}</span>
                      )}
                    </button>
                  ))}
              </div>

              {lifecycleNudges.length > 0 && (
                <div className="rounded-lg border border-amber-200/80 dark:border-amber-800/60 bg-amber-50/70 dark:bg-amber-950/30 px-3 py-2 space-y-1.5">
                  <p className="text-[11px] text-amber-800 dark:text-amber-200">
                    {t('resources.layer.nudgeBanner', { n: lifecycleNudges.length })}
                  </p>
                  <div className="flex flex-wrap gap-1.5">
                    {lifecycleNudges.map(({ r, life }) => (
                      <button
                        key={r.id}
                        type="button"
                        disabled={busy === `cold-${r.id}`}
                        onClick={() => {
                          if (life.nudge === 'invoke') copyInvokeFor(r);
                          else handleUnprojectAll(r);
                        }}
                        className="tb-press text-[10px] px-2 py-0.5 rounded-md bg-white/80 dark:bg-zinc-900/60 border border-amber-200 dark:border-amber-800 text-amber-900 dark:text-amber-100 disabled:opacity-50"
                        title={r.display_name || r.name}
                      >
                        {r.display_name || r.name}
                        {' · '}
                        {life.nudge === 'invoke'
                          ? t('resources.layer.nudgeInvoke')
                          : life.nudge === 'unproject'
                            ? t('resources.layer.nudgeUnproject')
                            : t('resources.layer.nudgeCold')}
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}

          {/* 点击「扫描」展开：默认目录 ∪ 用户添加目录（并列，列出全部监控路径） */}
          {showSkillTabs && scanExpanded && (
            <div className="space-y-2 p-3 rounded-xl border border-zinc-200 dark:border-zinc-800 bg-zinc-100 dark:bg-zinc-950/50">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-xs text-zinc-500 shrink-0">{t('resources.scanScopeLabel')}</span>
                <span className="text-[11px] text-zinc-400">
                  {t('resources.scanRootsCount', {
                    n: defaultScanRoots.length + customScanDirs.length,
                  })}
                </span>
                <button
                  type="button"
                  disabled={(!autoTagging && scanning) || busy === 'cleanup' || busy === 'editor'}
                  onClick={autoTagging ? cancelAutoTagging : runScan}
                  className="tb-press ml-auto text-xs px-3 py-1.5 rounded-lg bg-blue-600 text-white hover:bg-blue-500 disabled:opacity-50 shrink-0"
                >
                  {autoTagging
                    ? t('resources.autoTaggingCancel')
                    : (scanning ? t('resources.scanning') : t('resources.scanStart'))}
                </button>
              </div>
              <ul className="space-y-1 max-h-48 overflow-y-auto">
                {defaultScanRoots.map(root => {
                  const n = skillCountByAgentId.has(root.id)
                    ? skillCountByAgentId.get(root.id)
                    : null;
                  return (
                  <li
                    key={root.id || root.path}
                    className="flex items-center gap-2 text-[11px] bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-700 rounded-lg px-2.5 py-1.5"
                  >
                    <span className="shrink-0 text-[10px] px-1.5 py-0.5 rounded bg-sky-50 dark:bg-sky-950/40 text-sky-700 dark:text-sky-300 border border-sky-200/70 dark:border-sky-800/60">
                      {t('resources.scanRootDefault')}
                    </span>
                    <span className="shrink-0 text-zinc-500">{root.label}</span>
                    <span className="flex-1 min-w-0 truncate font-mono text-zinc-600 dark:text-zinc-300" title={root.path}>
                      {root.path}
                    </span>
                    {n != null && root.exists !== false && (
                      <span className="shrink-0 tabular-nums text-zinc-400">
                        {t('resources.agentSkillCount', { n })}
                      </span>
                    )}
                    {!root.exists && (
                      <span className="shrink-0 text-[10px] text-zinc-400">{t('resources.scanRootMissing')}</span>
                    )}
                  </li>
                  );
                })}
                {customScanDirs.map(dir => {
                  const n = countForCustomScanDir(dir);
                  return (
                  <li
                    key={dir}
                    className="flex items-center gap-2 text-[11px] bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-700 rounded-lg px-2.5 py-1.5"
                  >
                    <span className="shrink-0 text-[10px] px-1.5 py-0.5 rounded bg-amber-50 dark:bg-amber-950/40 text-amber-700 dark:text-amber-300 border border-amber-200/70 dark:border-amber-800/60">
                      {t('resources.scanRootCustom')}
                    </span>
                    <span className="flex-1 min-w-0 truncate font-mono text-zinc-600 dark:text-zinc-300" title={dir}>
                      {dir}
                    </span>
                    <span className="shrink-0 tabular-nums text-zinc-400">
                      {t('resources.agentSkillCount', { n })}
                    </span>
                    <button
                      type="button"
                      onClick={() => removeCustomScanDir(dir)}
                      className="shrink-0 text-zinc-400 hover:text-red-500 px-1"
                      title={t('resources.scanCustomDirRemove')}
                    >
                      ×
                    </button>
                  </li>
                  );
                })}
              </ul>
              <div className="flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  onClick={pickCustomScanDir}
                  className="tb-press text-xs px-2.5 py-1.5 rounded-lg border border-zinc-200 dark:border-zinc-700 hover:bg-white dark:hover:bg-zinc-800"
                >
                  {t('resources.scanCustomDirAdd')}
                </button>
                <p className="text-[11px] text-zinc-400 flex-1 min-w-[12rem]">
                  {t('resources.scanScopeMergedHint')}
                </p>
              </div>
            </div>
          )}
        </div>

        {msg && <p className="text-xs text-blue-600 dark:text-blue-400">{msg}</p>}
        {error && <p className="text-xs text-red-500">{error}</p>}

        {loading ? (
          <div className="space-y-3 py-2" aria-busy="true">
            {[1, 2, 3].map(i => (
              <div key={i} className="h-20 rounded-xl bg-zinc-100 dark:bg-zinc-800/80 animate-pulse" />
            ))}
          </div>
        ) : viewTab === 'managed' ? (
          renderLocalList()
        ) : viewTab === 'recommend' ? (
          <div className="space-y-6">
            {/* 画像挖掘 + 基于画像推荐（同一板块） */}
            <PersonalizedRecommend
              typeFilter={typeFilter}
              purposeFilter={tagFilter}
              LogoComp={AssetLogo}
              onNeedProject={() => changeViewTab('managed')}
              onNeedAgent={() => navigate('/gateway')}
              onRefresh={refreshAfterAdopt}
              onAdopted={handleRecoAdopted}
              onItemsChange={() => setRecoPurposeRev((n) => n + 1)}
            />
            {/* 下半:社区目录 */}
            <div className="space-y-2 border-t border-zinc-200/80 dark:border-zinc-800 pt-4">
              <p className="text-xs font-medium text-zinc-500 dark:text-zinc-400">{t('resources.catalogSection')}</p>
              {filteredCatalog.length === 0 ? (
                <div className="text-center py-6 space-y-2">
                  <p className="text-xs text-zinc-400">
                    {tagFilter ? t('resources.emptyTagFiltered') : t('resources.emptyCatalog')}
                  </p>
                  {tagFilter && (
                    <button type="button" onClick={() => setTagFilter('')} className="text-xs text-blue-600 hover:underline">
                      {t('resources.clearTagFilter')}
                    </button>
                  )}
                </div>
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

      {/* 闲置 Skill 清理 — portal 到 body，避免被主内容区 / glass 裁切 */}
      {cleanupOpen && createPortal(
        <div
          className="electron-no-drag fixed inset-0 z-[9998] flex items-center justify-center p-4 bg-black/40"
          onClick={() => {
            if (!busy && !idleLoading && !idleAiLoading) {
              abortIdleAi();
              setCleanupOpen(false);
            }
          }}
        >
          <div
            className="w-full max-w-xl max-h-[85vh] overflow-hidden flex flex-col rounded-2xl border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 shadow-xl"
            onClick={e => e.stopPropagation()}
          >
            <div className="px-4 py-3 border-b border-zinc-100 dark:border-zinc-800 space-y-2">
              <h3 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">
                {t('resources.cleanupTitle')}
              </h3>
              <p className="text-[10px] text-zinc-400">
                {t('resources.cleanupHint', { days: idleDays })}
              </p>
              <p className="text-[10px] text-violet-600/90 dark:text-violet-400/90">
                {t('resources.cleanupAiHint')}
              </p>
              {!hasStoredPortrait() && (
                <div className="flex items-start gap-2 rounded-lg bg-zinc-50 dark:bg-zinc-800/60 px-2.5 py-2">
                  <p className="min-w-0 flex-1 text-[10px] text-zinc-500 dark:text-zinc-400 leading-relaxed">
                    {t('resources.cleanupPortraitTip')}
                  </p>
                  <button
                    type="button"
                    disabled={idleLoading || idleAiLoading || busy === 'cleanup'}
                    onClick={() => {
                      abortIdleAi();
                      setCleanupOpen(false);
                      if (typeFilter !== 'skill') changeTypeFilter('skill');
                      changeViewTab('recommend');
                    }}
                    className="shrink-0 text-[10px] text-violet-600 dark:text-violet-400 hover:underline disabled:opacity-50"
                  >
                    {t('resources.cleanupPortraitAction')}
                  </button>
                </div>
              )}
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
                  disabled={idleLoading || idleAiLoading || busy === 'cleanup'}
                  onClick={() => scanIdleSkills(idleDays)}
                  className="ml-auto px-2.5 py-1 text-[11px] rounded-lg border border-zinc-200 dark:border-zinc-700 text-zinc-600 dark:text-zinc-300 hover:bg-zinc-50 dark:hover:bg-zinc-800 disabled:opacity-50"
                >
                  {idleLoading || idleAiLoading
                    ? (idleAiLoading ? t('resources.cleanupAiAnalyzing') : t('resources.cleanupScanning'))
                    : t('resources.cleanupRescan')}
                </button>
              </div>
            </div>
            <div className="flex-1 min-h-0 overflow-y-auto px-4 py-3 space-y-2">
              {idleLoading ? (
                <CleanupSweepMotion label={t('resources.cleanupScanning')} />
              ) : !(idleResult?.items || []).length ? (
                <p className="text-xs text-zinc-400 py-6 text-center">{t('resources.cleanupEmpty', { days: idleDays })}</p>
              ) : (
                <>
                  {(() => {
                    // 分析中：只展示已出结果的条目（分析一个出来一个）
                    const visibleItems = idleAiLoading
                      ? idleResult.items.filter((it) => idleAiMap[it.id])
                      : idleResult.items;
                    const sorted = sortIdleByRecommendation(visibleItems, idleAiMap);
                    const recommendCount = sorted.filter((it) => idleAiMap[it.id]?.recommend).length;
                    return (
                      <>
                        {idleAiLoading && (
                          <div className="rounded-xl border border-amber-200/80 dark:border-amber-800/50 bg-amber-50/50 dark:bg-amber-950/20 px-3 py-2.5 space-y-2">
                            <div className="flex items-center gap-3">
                              <div className="tb-cleanup-sweep scale-75 origin-left shrink-0" aria-hidden="true" style={{ width: '5.5rem', height: '2.4rem', margin: 0 }}>
                                <span className="tb-cleanup-sweep__dust" />
                                <span className="tb-cleanup-sweep__dust" />
                                <span className="tb-cleanup-sweep__dust" />
                                <span className="tb-cleanup-sweep__floor" />
                                <span className="tb-cleanup-sweep__trail" />
                                <span className="tb-cleanup-sweep__broom">
                                  <span className="tb-cleanup-sweep__handle" />
                                  <span className="tb-cleanup-sweep__head" />
                                </span>
                              </div>
                              <div className="min-w-0 flex-1">
                                <p className="text-[11px] text-amber-800 dark:text-amber-200">
                                  {t('resources.cleanupAiAnalyzing')}
                                </p>
                                {idleAiProgress && idleAiProgress.total > 0 && (
                                  <p className="text-[10px] text-zinc-400 mt-0.5">
                                    {t('resources.cleanupAiBatchProgress', {
                                      done: idleAiProgress.done,
                                      total: idleAiProgress.total,
                                      batch: idleAiProgress.batch || 0,
                                      batches: idleAiProgress.batches || 0,
                                    })}
                                  </p>
                                )}
                              </div>
                            </div>
                            {idleAiProgress && idleAiProgress.total > 0 && (
                              <div className="h-1 rounded-full bg-amber-100 dark:bg-amber-900/40 overflow-hidden">
                                <div
                                  className="h-full rounded-full bg-amber-500/85 transition-[width] duration-300"
                                  style={{
                                    width: `${Math.min(100, Math.round((idleAiProgress.done / idleAiProgress.total) * 100))}%`,
                                  }}
                                />
                              </div>
                            )}
                          </div>
                        )}
                        <div className="flex items-center justify-between gap-2 text-[10px] text-zinc-400">
                          <span>
                            {t('resources.cleanupSummary', { n: idleResult.items.length, total: idleResult.totalManaged })}
                            {recommendCount > 0 && (
                              <>
                                {' · '}
                                <span className="text-amber-600 dark:text-amber-400">
                                  {t('resources.cleanupAiRecommendN', { n: recommendCount })}
                                </span>
                              </>
                            )}
                          </span>
                          <div className="flex items-center gap-2 shrink-0">
                            <button
                              type="button"
                              disabled={idleAiLoading || busy === 'cleanup'}
                              onClick={() => analyzeIdleWithAi(idleResult.items, idleDays)}
                              className="text-violet-600 dark:text-violet-400 hover:underline disabled:opacity-50"
                            >
                              {t('resources.cleanupAiRetry')}
                            </button>
                            <button
                              type="button"
                              disabled={idleAiLoading}
                              onClick={toggleIdleSelectAll}
                              className="text-blue-600 dark:text-blue-400 hover:underline disabled:opacity-50"
                            >
                              {idleSelected.length
                                ? t('resources.cleanupDeselectAll')
                                : t('resources.cleanupSelectRecommended')}
                            </button>
                          </div>
                        </div>
                        {!idleAiLoading && idleAiMeta.source === 'ai' && (
                          <p className="text-[10px] text-violet-600/80 dark:text-violet-400/80">
                            {t('resources.cleanupAiDone')}
                            {idleAiMeta.skippedHeuristic > 0
                              ? ` ${t('resources.cleanupAiPartial', { n: idleAiMeta.skippedHeuristic })}`
                              : ''}
                          </p>
                        )}
                        {!idleAiLoading && idleAiMeta.source === 'heuristic' && (
                          <p className="text-[10px] text-zinc-400">
                            {t('resources.cleanupAiFallback')}
                            {idleAiMeta.error ? ` (${idleAiMeta.error})` : ''}
                          </p>
                        )}
                        {idleAiLoading && !sorted.length && (
                          <p className="text-[10px] text-zinc-400 py-4 text-center">
                            {t('resources.cleanupAiAnalyzing')}
                          </p>
                        )}
                        {sorted.map((item) => {
                          const checked = idleSelected.includes(item.id);
                          const ai = idleAiMap[item.id];
                          const recommended = !!ai?.recommend;
                          return (
                            <label
                              key={item.id}
                              className={`flex items-start gap-2 p-2.5 rounded-xl border cursor-pointer ${
                                checked
                                  ? recommended
                                    ? 'border-amber-300 dark:border-amber-700 bg-amber-50/60 dark:bg-amber-900/20'
                                    : 'border-zinc-300 dark:border-zinc-600 bg-zinc-50/80 dark:bg-zinc-800/50'
                                  : recommended
                                    ? 'border-amber-200/80 dark:border-amber-900/50 hover:bg-amber-50/40 dark:hover:bg-amber-950/20'
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
                                <div className="flex items-center gap-1.5 min-w-0">
                                  <p className="text-xs font-medium text-zinc-800 dark:text-zinc-200 truncate">
                                    {item.display_name || item.name}
                                  </p>
                                  {item.type === 'assistant' && (
                                    <span className="shrink-0 text-[10px] px-1.5 py-0.5 rounded-md bg-violet-100 text-violet-700 dark:bg-violet-900/40 dark:text-violet-300">
                                      {t('resources.type.assistant')}
                                    </span>
                                  )}
                                  {recommended && (
                                    <span className="shrink-0 text-[10px] px-1.5 py-0.5 rounded-md bg-amber-100 text-amber-800 dark:bg-amber-900/50 dark:text-amber-200">
                                      {t('resources.cleanupAiBadge')}
                                    </span>
                                  )}
                                </div>
                                <p className="text-[10px] text-zinc-400 mt-0.5">
                                  {t('resources.cleanupIdleDays', { n: item.idleDays })}
                                  {' · '}
                                  {t('resources.cleanupLastActivity')}: {formatIdleTime(item.lastActivityAt)}
                                </p>
                                {ai?.reason && (
                                  <p className={`text-[11px] mt-1 leading-snug ${
                                    recommended
                                      ? 'text-amber-800/90 dark:text-amber-200/90'
                                      : 'text-zinc-500 dark:text-zinc-400'
                                  }`}
                                  >
                                    {recommended
                                      ? t('resources.cleanupAiReason', { reason: ai.reason })
                                      : t('resources.cleanupAiKeep', { reason: ai.reason })}
                                  </p>
                                )}
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
                    );
                  })()}
                </>
              )}
            </div>
            <div className="px-4 py-3 border-t border-zinc-100 dark:border-zinc-800 flex gap-2 justify-end">
              <button
                type="button"
                disabled={!!busy}
                onClick={() => {
                  abortIdleAi();
                  setCleanupOpen(false);
                }}
                className="text-xs px-3 py-1.5 rounded-lg border border-zinc-200 dark:border-zinc-600 disabled:opacity-50"
              >
                {t('resources.cancel')}
              </button>
              <button
                type="button"
                disabled={!!busy || idleLoading || idleAiLoading || !idleSelected.length}
                onClick={confirmSkillCleanup}
                className="text-xs px-3 py-1.5 rounded-lg bg-amber-600 text-white hover:bg-amber-500 disabled:opacity-40"
              >
                {busy === 'cleanup'
                  ? t('resources.cleanupRunning')
                  : t('resources.cleanupAction', { n: idleSelected.length })}
              </button>
            </div>
          </div>
        </div>,
        document.body,
      )}

      <SkillInstallDialog
        open={skillInstallOpen}
        onClose={() => setSkillInstallOpen(false)}
        onNeedAgent={() => {
          // 无可投射 Agent：跳转网关页纳管 Agent 应用
          setSkillInstallOpen(false);
          navigate('/gateway');
        }}
        onInstalled={async () => {
          // 安装完成后静默刷新一次（不自动打标，避免空白/重复）
          await loadAll({ silent: true });
          setScanExpanded(true);
        }}
      />

      {editorOpen && createPortal(
        <div
          className="electron-no-drag fixed inset-0 z-[9998] flex items-center justify-center p-4 bg-black/40"
          onClick={() => { if (busy !== 'editor') setEditorOpen(false); }}
        >
          <div
            className="w-full max-w-lg max-h-[90vh] overflow-y-auto rounded-2xl border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 shadow-xl"
            onClick={e => e.stopPropagation()}
          >
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
              {editorForm.type === 'prompt' && (
                <label className="block text-xs text-zinc-500">
                  {t('resources.editorPromptKind')}
                  <select
                    value={editorForm.promptKind === 'image' ? 'image' : 'text'}
                    onChange={e => setEditorForm(prev => ({ ...prev, promptKind: e.target.value }))}
                    className="mt-1 w-full text-xs px-2 py-1.5 rounded-lg border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-950"
                  >
                    <option value="text">{t('resources.promptKind.text')}</option>
                    <option value="image">{t('resources.promptKind.image')}</option>
                  </select>
                  <span className="block mt-1 text-[10px] text-zinc-400">{t('resources.editorPromptKindHint')}</span>
                </label>
              )}
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
              <label className="block text-xs text-zinc-500">
                {t('resources.editorTags')}
                <input
                  value={editorForm.tagsText || ''}
                  onChange={e => setEditorForm(prev => ({ ...prev, tagsText: e.target.value }))}
                  placeholder={t('resources.editorTagsPh')}
                  className="mt-1 w-full text-xs px-2 py-1.5 rounded-lg border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-950"
                />
                <span className="block mt-1 text-[10px] text-zinc-400">{t('resources.editorTagsHint')}</span>
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
                className="tb-press text-xs px-3 py-1.5 rounded-lg bg-blue-600 text-white hover:bg-blue-500 disabled:opacity-50"
              >
                {busy === 'editor' ? t('resources.busy') : t('resources.save')}
              </button>
            </div>
          </div>
        </div>,
        document.body,
      )}
    </div>
  );
}
