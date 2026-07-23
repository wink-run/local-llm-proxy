// client/electron/resource-skill-scanner.js
// 扫描各 Agent / aweskill 本机已有 Skill（SKILL.md），供 Token Bank 纳管
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { AGENT_RESOURCE_TARGETS } = require('./resource-agent-targets');

/** 通用 skills 目录（与各 Agent 默认目录并列扫描并展示；不含 aweskill） */
const EXTRA_SKILL_ROOTS = [
  {
    agentId: 'agents-hub',
    // 界面展示为 .agents，路径为 ~/.agents/skills
    label: '.agents',
    getSkillRoot: () => path.join(os.homedir(), '.agents', 'skills'),
  },
  {
    agentId: 'tokenbank',
    label: '.tokenbank',
    getSkillRoot: () => path.join(os.homedir(), '.tokenbank', 'skills'),
  },
];

/** 项目内 Skill 目录（Claude Code `npx skills` 等默认装到 `<cwd>/.agents/skills` 并软链到 `.claude/skills`） */
const PROJECT_SKILL_DIRS = [
  { segments: ['.agents', 'skills'], agentId: 'agents-hub', agentLabel: 'Agents Hub' },
  { segments: ['.claude', 'skills'], agentId: 'claude-code', agentLabel: 'Claude Code' },
  { segments: ['.codex', 'skills'], agentId: 'codex', agentLabel: 'Codex' },
  { segments: ['.cursor', 'skills'], agentId: 'cursor', agentLabel: 'Cursor' },
  { segments: ['.workbuddy', 'skills'], agentId: 'workbuddy', agentLabel: 'WorkBuddy' },
];

function projectRootToken(projectRoot) {
  return crypto.createHash('sha256').update(String(projectRoot || '')).digest('hex').slice(0, 8);
}

/** 从 Debug 任务 context / 显式传入路径收集项目根目录 */
function collectProjectRoots(options = {}) {
  const roots = new Set();
  const add = (p) => {
    const resolved = path.resolve(String(p || '').trim());
    if (!resolved) return;
    try {
      if (fs.existsSync(resolved)) roots.add(resolved);
    } catch { /* ignore */ }
  };

  for (const p of options.projectRoots || []) add(p);
  for (const ctx of options.taskContexts || []) {
    try {
      const parsed = typeof ctx === 'string' ? JSON.parse(ctx) : ctx;
      if (parsed?.workingDir) add(parsed.workingDir);
    } catch { /* ignore */ }
  }
  return [...roots];
}

/** 扫描单个项目下的各 Agent Skill 目录 */
function scanProjectSkills(projectRoot) {
  const flat = [];
  const projLabel = path.basename(projectRoot) || projectRoot;
  const projToken = projectRootToken(projectRoot);

  for (const spec of PROJECT_SKILL_DIRS) {
    const skillRoot = path.join(projectRoot, ...spec.segments);
    const label = `${spec.agentLabel} · ${projLabel}`;
    for (const item of scanSkillRoot(skillRoot, spec.agentId, label)) {
      flat.push({
        ...item,
        scanKey: `${spec.agentId}::project::${projToken}::${item.name}`,
        scope: 'project',
        projectRoot,
        projectLabel: projLabel,
      });
    }
  }
  return flat;
}

function decorateScanItem(item) {
  let isSymlink = false;
  let linkTarget = null;
  try {
    const st = fs.lstatSync(item.skillDir);
    isSymlink = st.isSymbolicLink();
    if (isSymlink) linkTarget = fs.realpathSync(item.skillDir);
  } catch { /* ignore */ }
  return { ...item, isSymlink, linkTarget };
}

function indexKeyForItem(item) {
  if (item.customScanRoot) {
    return `${item.name}::${customDirToken(item.customScanRoot)}::${customDirToken(item.skillDir)}`;
  }
  if (item.projectRoot) {
    return `${item.name}::${projectRootToken(item.projectRoot)}`;
  }
  return item.name;
}

function hashContent(content) {
  return crypto.createHash('sha256').update(String(content || '')).digest('hex').slice(0, 16);
}

/** 解析 SKILL.md YAML frontmatter */
function parseSkillFrontmatter(content) {
  const text = String(content || '');
  const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) return {};

  const meta = {};
  for (const line of match[1].split(/\r?\n/)) {
    const m = line.match(/^([A-Za-z0-9_-]+)\s*:\s*(.+)$/);
    if (!m) continue;
    const key = m[1].toLowerCase();
    let val = m[2].trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    meta[key] = val;
  }
  return meta;
}

/**
 * 技能说明:优先 frontmatter.description;否则取正文首段非标题散文(很多 SkillHub 包没有 YAML 说明)。
 */
function extractSkillDescription(content, fm = null) {
  const meta = fm || parseSkillFrontmatter(content);
  const fromFm = String(meta.description || '').trim();
  if (fromFm) return fromFm;

  const body = String(content || '').replace(/^---\r?\n[\s\S]*?\r?\n---\s*/, '');
  const buf = [];
  for (const line of body.split(/\r?\n/)) {
    const t = line.trim();
    if (!t) {
      if (buf.length) break;
      continue;
    }
    if (/^#+\s/.test(t)) {
      if (buf.length) break;
      continue;
    }
    if (/^```/.test(t)) break;
    if (/^[-*]\s/.test(t) && !buf.length) continue;
    buf.push(t);
    if (buf.join(' ').length >= 48) break;
  }
  let desc = buf.join(' ').replace(/\s+/g, ' ').trim();
  if (desc.length > 180) desc = `${desc.slice(0, 177)}…`;
  return desc;
}

function readSkillFile(skillPath) {
  try {
    return fs.readFileSync(skillPath, 'utf8');
  } catch {
    return null;
  }
}

/** 判断目录是否为 Skill（含 SKILL.md / skill.md / meta.json） */
function isSkillDir(skillDir) {
  if (!skillDir || !fs.existsSync(skillDir)) return false;
  try {
    const st = fs.lstatSync(skillDir);
    if (!st.isDirectory() && !st.isSymbolicLink()) return false;
  } catch {
    return false;
  }
  return ['SKILL.md', 'skill.md', 'meta.json'].some(f => fs.existsSync(path.join(skillDir, f)));
}

/** 扫描单个 skills 根目录下的 <name>/ 目录 */
function scanSkillRoot(skillRoot, agentId, agentLabel) {
  if (!skillRoot || !fs.existsSync(skillRoot)) return [];

  const items = [];
  let entries;
  try {
    entries = fs.readdirSync(skillRoot, { withFileTypes: true });
  } catch {
    return [];
  }

  for (const ent of entries) {
    // 支持目录或目录级软链
    if (!ent.isDirectory() && !ent.isSymbolicLink()) continue;

    const skillDir = path.join(skillRoot, ent.name);
    if (!isSkillDir(skillDir)) continue;

    const skillPath = fs.existsSync(path.join(skillDir, 'SKILL.md'))
      ? path.join(skillDir, 'SKILL.md')
      : path.join(skillDir, 'skill.md');
    const content = readSkillFile(skillPath);
    if (content == null) continue;

    const fm = parseSkillFrontmatter(content);
    const name = fm.name || ent.name;
    // scanKey 用目录名，避免多个文件夹 frontmatter 同名导致 scanKey 冲突
    // 展示统一用 name，不改写原始 SKILL.md
    items.push({
      scanKey: `${agentId}::${ent.name}`,
      type: 'skill',
      name,
      display_name: name,
      description: extractSkillDescription(content, fm),
      version: fm.version || '',
      content,
      hash: hashContent(content),
      agentId,
      agentLabel,
      skillDir,
      skillPath,
      skillRoot,
      metadata: {
        tags: fm.tags ? String(fm.tags).split(/[,\s]+/).filter(Boolean) : [],
        scannedFrom: skillDir,
        version: fm.version || undefined,
      },
    });
  }

  return items;
}

function customDirToken(dir) {
  return crypto.createHash('sha256').update(String(dir || '')).digest('hex').slice(0, 8);
}

/** 递归扫描时跳过的目录名 */
const SKIP_DIR_NAMES = new Set([
  'node_modules', '.git', 'vendor', 'dist', 'build', '.next', '__pycache__', '.cache',
]);

function skillItemFromDir(skillDir, entName, agentId, agentLabel, extra = {}) {
  const skillPath = fs.existsSync(path.join(skillDir, 'SKILL.md'))
    ? path.join(skillDir, 'SKILL.md')
    : path.join(skillDir, 'skill.md');
  const content = readSkillFile(skillPath);
  if (content == null) return null;

  const fm = parseSkillFrontmatter(content);
  const name = fm.name || entName || path.basename(skillDir);
  const scanKey = extra.scanKey || `${agentId}::${name}`;
  return {
    scanKey,
    type: 'skill',
    name,
    display_name: name,
    description: extractSkillDescription(content, fm),
    version: fm.version || '',
    content,
    hash: hashContent(content),
    agentId,
    agentLabel,
    skillDir,
    skillPath,
    skillRoot: extra.skillRoot || path.dirname(skillDir),
    metadata: {
      tags: fm.tags ? String(fm.tags).split(/[,\s]+/).filter(Boolean) : [],
      scannedFrom: skillDir,
      version: fm.version || undefined,
    },
    ...extra,
  };
}

/** 扫描各 Agent 全局 skills 根目录 */
function scanGlobalSkills() {
  const flat = [];
  for (const target of Object.values(AGENT_RESOURCE_TARGETS)) {
    for (const item of scanSkillRoot(target.getSkillRoot(), target.id, target.label)) {
      flat.push({ ...item, scope: 'global' });
    }
  }
  for (const extra of EXTRA_SKILL_ROOTS) {
    for (const item of scanSkillRoot(extra.getSkillRoot(), extra.agentId, extra.label)) {
      flat.push({ ...item, scope: 'global' });
    }
  }
  return flat;
}

/**
 * 在指定目录下递归查找 Skill（含子目录），并识别项目内 .agents/.claude 等结构
 * @param {string} rootDir 用户指定的扫描根目录
 */
function scanCustomSkillTree(rootDir, options = {}) {
  const maxDepth = options.maxDepth ?? 8;
  const resolved = path.resolve(String(rootDir || '').trim());
  if (!resolved || !fs.existsSync(resolved)) return [];

  const flat = [];
  const seenDirs = new Set();
  const rootLabel = path.basename(resolved) || resolved;
  const rootToken = customDirToken(resolved);

  const addSkillDir = (skillDir, labelSuffix = '') => {
    let real;
    try { real = fs.realpathSync(skillDir); } catch { return; }
    if (seenDirs.has(real)) return;
    seenDirs.add(real);

    const item = skillItemFromDir(
      skillDir,
      path.basename(skillDir),
      'custom',
      labelSuffix ? `指定目录 · ${rootLabel} · ${labelSuffix}` : `指定目录 · ${rootLabel}`,
      {
        scanKey: `custom::${rootToken}::${customDirToken(real)}::${path.basename(skillDir)}`,
        scope: 'custom',
        customScanRoot: resolved,
        skillRoot: resolved,
      },
    );
    if (item) flat.push(item);
  };

  function walk(dir, depth) {
    if (depth > maxDepth) return;
    if (isSkillDir(dir)) {
      addSkillDir(dir);
      return;
    }
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const ent of entries) {
      if (!ent.isDirectory() && !ent.isSymbolicLink()) continue;
      if (SKIP_DIR_NAMES.has(ent.name)) continue;
      walk(path.join(dir, ent.name), depth + 1);
    }
  }

  walk(resolved, 0);

  // 同时识别项目内 Agent skills 目录（如 Debug 工作区的 .claude/skills）
  for (const item of scanProjectSkills(resolved)) {
    let real;
    try { real = fs.realpathSync(item.skillDir); } catch { continue; }
    if (seenDirs.has(real)) continue;
    seenDirs.add(real);
    flat.push({
      ...item,
      scope: 'custom',
      customScanRoot: resolved,
      scanKey: `${item.agentId}::custom::${rootToken}::${item.name}`,
    });
  }

  return flat;
}

/** 默认监控目录（各 Agent 全局 skills + Hub） */
function listDefaultSkillScanRoots() {
  const roots = [];
  for (const target of Object.values(AGENT_RESOURCE_TARGETS)) {
    const p = target.getSkillRoot();
    roots.push({
      id: target.id,
      label: target.label,
      path: p,
      kind: 'default',
      exists: (() => { try { return fs.existsSync(p); } catch { return false; } })(),
    });
  }
  for (const extra of EXTRA_SKILL_ROOTS) {
    const p = extra.getSkillRoot();
    roots.push({
      id: extra.agentId,
      label: extra.label,
      path: p,
      kind: 'default',
      exists: (() => { try { return fs.existsSync(p); } catch { return false; } })(),
    });
  }
  return roots;
}

/**
 * 扫描全部监控目录：默认全局目录 ∪ 用户添加的目录（并列补充，非互斥）
 */
function scanAllAgentSkills(options = {}) {
  const flat = [];
  flat.push(...scanGlobalSkills());
  const dirs = [...new Set((options.customDirs || []).map(d => path.resolve(String(d || '').trim())).filter(Boolean))];
  for (const dir of dirs) {
    flat.push(...scanCustomSkillTree(dir, options));
  }
  return flat;
}

/**
 * 合并同名 Skill（多 Agent 各有一份），按内容 hash 分组
 * @returns {Array<object>} 每项含 agents[]、managed 由上层填充
 */
function groupDiscoveredSkills(flatItems) {
  const groups = new Map();

  for (const item of flatItems) {
    const groupKey = `${item.name}::${item.hash}`;
    if (!groups.has(groupKey)) {
      groups.set(groupKey, {
        scanKey: item.scanKey,
        type: 'skill',
        name: item.name,
        display_name: item.display_name,
        description: item.description,
        version: item.version || item.metadata?.version || '',
        hash: item.hash,
        // 预览用正文(与推荐卡一致)
        content: item.content || '',
        contentLength: item.content.length,
        agents: [],
      });
    }
    const g = groups.get(groupKey);
    // 同组若后续条目带版本而首条没有，补上
    if (!g.version && (item.version || item.metadata?.version)) {
      g.version = item.version || item.metadata.version;
    }
    const agentKey = `${item.agentId}::${item.projectRoot || item.customScanRoot || ''}`;
    if (!g.agents.some(a => `${a.agentId}::${a.projectRoot || a.customScanRoot || ''}` === agentKey)) {
      g.agents.push({
        agentId: item.agentId,
        label: item.agentLabel,
        skillDir: item.skillDir,
        skillPath: item.skillPath,
        skillRoot: item.skillRoot,
        projectRoot: item.projectRoot || null,
        customScanRoot: item.customScanRoot || null,
        scope: item.scope || 'global',
      });
    }
    // 优先用 scanKey 指向第一个 Agent
    if (!g.scanKey) g.scanKey = item.scanKey;
  }

  return Array.from(groups.values()).sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'));
}

/** 构建 Agent 安装索引：默认目录 + 用户添加目录（并列） */
function buildAgentSkillScanIndex(options = {}) {
  const index = {};

  for (const target of Object.values(AGENT_RESOURCE_TARGETS)) {
    index[target.id] = new Map();
    for (const item of scanSkillRoot(target.getSkillRoot(), target.id, target.label)) {
      index[target.id].set(item.name, decorateScanItem({ ...item, scope: 'global' }));
    }
  }

  const dirs = [...new Set((options.customDirs || []).map(d => path.resolve(String(d || '').trim())).filter(Boolean))];
  if (dirs.length) {
    index.custom = new Map();
    for (const dir of dirs) {
      for (const item of scanCustomSkillTree(dir, options)) {
        const mapKey = indexKeyForItem(item);
        if (item.agentId === 'custom') {
          index.custom.set(mapKey, decorateScanItem(item));
          continue;
        }
        if (!index[item.agentId]) index[item.agentId] = new Map();
        index[item.agentId].set(mapKey, decorateScanItem(item));
      }
    }
  }

  return index;
}

/** 从 Agent skills 目录删除整目录（目录软链或实体目录） */
function removeRawAgentSkill(agentId, skillKey, options = {}) {
  const { getAgentTarget } = require('./resource-agent-targets');
  const target = getAgentTarget(agentId);
  if (!target) throw new Error(`未知 Agent: ${agentId}`);

  const skillDir = path.join(target.getSkillRoot(), skillKey);
  if (!fs.existsSync(skillDir)) {
    if (options.ignoreMissing) return { agentId, skillKey, path: skillDir, skipped: true };
    throw new Error(`未在 ${target.label} 中找到 Skill: ${skillKey}`);
  }

  const st = fs.lstatSync(skillDir);
  if (st.isSymbolicLink()) {
    fs.unlinkSync(skillDir);
  } else {
    fs.rmSync(skillDir, { recursive: true, force: true });
  }

  return { agentId, skillKey, path: skillDir };
}

function findScanEntry(scanKey, options = {}) {
  const flat = scanAllAgentSkills(options);
  const direct = flat.find(i => i.scanKey === scanKey);
  if (direct) return direct;

  // custom::token::dirToken::basename
  if (scanKey.startsWith('custom::')) {
    const parts = scanKey.split('::');
    const baseName = parts[parts.length - 1];
    return flat.find(i => i.scanKey === scanKey)
      || flat.find(i => i.name === baseName && i.scope === 'custom') || null;
  }

  // scanKey: claude-code::project::<token>::name
  if (scanKey.includes('::project::')) {
    const parts = scanKey.split('::');
    const name = parts[parts.length - 1];
    const agentId = parts[0];
    const projToken = parts[2];
    return flat.find(i =>
      i.name === name
      && i.agentId === agentId
      && i.projectRoot
      && projectRootToken(i.projectRoot) === projToken,
    ) || null;
  }

  const name = scanKey.includes('::') ? scanKey.split('::').pop() : scanKey;
  return flat.find(i => i.name === name && !i.projectRoot) || flat.find(i => i.name === name) || null;
}

/** 按 name 查找扫描到的全部 Agent 副本（同 hash） */
function findScanGroupByScanKey(scanKey, options = {}) {
  const entry = findScanEntry(scanKey, options);
  if (!entry) return null;
  const grouped = groupDiscoveredSkills(scanAllAgentSkills(options));
  return grouped.find(g => g.name === entry.name && g.hash === entry.hash) || null;
}

module.exports = {
  EXTRA_SKILL_ROOTS,
  PROJECT_SKILL_DIRS,
  parseSkillFrontmatter,
  extractSkillDescription,
  collectProjectRoots,
  scanProjectSkills,
  scanGlobalSkills,
  scanCustomSkillTree,
  listDefaultSkillScanRoots,
  scanAllAgentSkills,
  buildAgentSkillScanIndex,
  removeRawAgentSkill,
  groupDiscoveredSkills,
  findScanEntry,
  findScanGroupByScanKey,
  hashContent,
  projectRootToken,
  customDirToken,
};
