// client/electron/resource-skill-scanner.js
// 扫描各 Agent / aweskill 本机已有 Skill（SKILL.md），供 Token Bank 纳管
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { AGENT_RESOURCE_TARGETS } = require('./resource-agent-targets');

/** aweskill / 通用 skills 目录（存在才扫描） */
const EXTRA_SKILL_ROOTS = [
  {
    agentId: 'agents-hub',
    label: 'Agents Hub',
    getSkillRoot: () => path.join(os.homedir(), '.agents', 'skills'),
  },
  {
    agentId: 'aweskill',
    label: 'Aweskill',
    getSkillRoot: () => path.join(os.homedir(), '.aweskill', 'skills'),
  },
];

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
    items.push({
      scanKey: `${agentId}::${name}`,
      type: 'skill',
      name,
      display_name: fm.name || ent.name,
      description: fm.description || '',
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
      },
    });
  }

  return items;
}

/** 扫描所有 Agent + aweskill 目录 */
function scanAllAgentSkills() {
  const flat = [];

  for (const target of Object.values(AGENT_RESOURCE_TARGETS)) {
    flat.push(...scanSkillRoot(target.getSkillRoot(), target.id, target.label));
  }
  for (const extra of EXTRA_SKILL_ROOTS) {
    flat.push(...scanSkillRoot(extra.getSkillRoot(), extra.agentId, extra.label));
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
        hash: item.hash,
        contentLength: item.content.length,
        agents: [],
      });
    }
    const g = groups.get(groupKey);
    if (!g.agents.some(a => a.agentId === item.agentId)) {
      g.agents.push({
        agentId: item.agentId,
        label: item.agentLabel,
        skillDir: item.skillDir,
        skillPath: item.skillPath,
        skillRoot: item.skillRoot,
      });
    }
    // 优先用 scanKey 指向第一个 Agent
    if (!g.scanKey) g.scanKey = item.scanKey;
  }

  return Array.from(groups.values()).sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'));
}

/** 仅扫描可投射 Agent（不含 agents-hub / aweskill），供分 Agent Tab 使用 */
function buildAgentSkillScanIndex() {
  const index = {};
  for (const target of Object.values(AGENT_RESOURCE_TARGETS)) {
    index[target.id] = new Map();
    for (const item of scanSkillRoot(target.getSkillRoot(), target.id, target.label)) {
      let isSymlink = false;
      let linkTarget = null;
      try {
        // 目录级软链：检查 skills/<name>/ 本身
        const st = fs.lstatSync(item.skillDir);
        isSymlink = st.isSymbolicLink();
        if (isSymlink) linkTarget = fs.realpathSync(item.skillDir);
      } catch {}
      index[target.id].set(item.name, { ...item, isSymlink, linkTarget });
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

function findScanEntry(scanKey) {
  const flat = scanAllAgentSkills();
  const direct = flat.find(i => i.scanKey === scanKey);
  if (direct) return direct;

  // scanKey 可能是分组键，取同名首条
  const name = scanKey.includes('::') ? scanKey.split('::')[1] : scanKey;
  return flat.find(i => i.name === name) || null;
}

/** 按 name 查找扫描到的全部 Agent 副本（同 hash） */
function findScanGroupByScanKey(scanKey) {
  const entry = findScanEntry(scanKey);
  if (!entry) return null;
  const grouped = groupDiscoveredSkills(scanAllAgentSkills());
  return grouped.find(g => g.name === entry.name && g.hash === entry.hash) || null;
}

module.exports = {
  EXTRA_SKILL_ROOTS,
  parseSkillFrontmatter,
  scanAllAgentSkills,
  buildAgentSkillScanIndex,
  removeRawAgentSkill,
  groupDiscoveredSkills,
  findScanEntry,
  findScanGroupByScanKey,
  hashContent,
};
