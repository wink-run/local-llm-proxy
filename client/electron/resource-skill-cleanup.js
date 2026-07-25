// client/electron/resource-skill-cleanup.js
// 扫描闲置 Skill（默认 60 天未使用），供一键清理
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { resolveAuthorityDir } = require('./resource-canonical');

const DEFAULT_IDLE_DAYS = 60;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** 归一化 skill 名以便与 trace 中的 `plugin:name` / `name` 对齐 */
function normalizeSkillKey(name) {
  const s = String(name || '').trim();
  if (!s) return '';
  const parts = s.split(/[/:]/);
  return parts[parts.length - 1].toLowerCase();
}

/**
 * 读取 SKILL.md 的 mtime 作为弱活动信号。
 * 不用目录 mtime：Agent 更新附属文件（如 Cursor 刷 sdk/*.d.ts）会改目录时间，不等于「使用了 Skill」。
 */
function skillFsActivityMs(resource) {
  const dir = resolveAuthorityDir(resource);
  if (!dir) return 0;
  let latest = 0;
  for (const name of ['SKILL.md', 'skill.md']) {
    try {
      const st = fs.lstatSync(path.join(dir, name));
      latest = Math.max(latest, st.mtimeMs || 0);
    } catch { /* ignore */ }
  }
  return latest;
}

/**
 * 轻量扫描 Claude Code jsonl：仅处理 mtime ≥ sinceMs 的文件，
 * 提取 `"name":"Skill"` 的 tool_use 及时间戳。
 * @returns {Map<string, number>} normalizeSkillKey → lastUsedMs
 */
function scanClaudeSkillUsage(sinceMs) {
  const lastUsed = new Map();
  const root = path.join(os.homedir(), '.claude', 'projects');
  if (!fs.existsSync(root)) return lastUsed;

  const files = [];
  function walk(dir, depth = 0) {
    if (depth > 6) return;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const ent of entries) {
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        walk(full, depth + 1);
        continue;
      }
      if (!ent.isFile() || !ent.name.endsWith('.jsonl')) continue;
      try {
        const st = fs.statSync(full);
        if ((st.mtimeMs || 0) < sinceMs) continue;
        files.push({ path: full, mtimeMs: st.mtimeMs || 0 });
      } catch { /* ignore */ }
    }
  }
  walk(root);

  // 限制扫描量，避免超大历史拖垮 UI
  files.sort((a, b) => b.mtimeMs - a.mtimeMs);
  const capped = files.slice(0, 80);

  for (const { path: filePath, mtimeMs } of capped) {
    let text;
    try {
      // 大文件只读尾部（近期会话追加写入）
      const st = fs.statSync(filePath);
      const maxBytes = 2 * 1024 * 1024;
      if (st.size > maxBytes) {
        const fd = fs.openSync(filePath, 'r');
        try {
          const buf = Buffer.alloc(maxBytes);
          fs.readSync(fd, buf, 0, maxBytes, Math.max(0, st.size - maxBytes));
          text = buf.toString('utf8');
        } finally {
          fs.closeSync(fd);
        }
      } else {
        text = fs.readFileSync(filePath, 'utf8');
      }
    } catch {
      continue;
    }

    const lines = text.split(/\r?\n/);
    for (const line of lines) {
      if (!line.includes('"Skill"') && !line.includes("'Skill'")) continue;
      let data;
      try { data = JSON.parse(line); } catch { continue; }
      if (data?.type !== 'assistant') continue;
      const blocks = data.message?.content;
      if (!Array.isArray(blocks)) continue;

      let ts = 0;
      if (data.timestamp) {
        const parsed = Date.parse(data.timestamp);
        if (Number.isFinite(parsed)) ts = parsed;
      }
      if (!ts) ts = mtimeMs;

      for (const b of blocks) {
        if (b?.type !== 'tool_use' || b.name !== 'Skill') continue;
        const input = b.input || {};
        const raw = input.skill || input.command || input.name || '';
        const key = normalizeSkillKey(raw);
        if (!key) continue;
        const prev = lastUsed.get(key) || 0;
        if (ts > prev) lastUsed.set(key, ts);
      }
    }
  }

  return lastUsed;
}

/**
 * 列出闲置 Skill 候选
 * @param {object[]} resources type=skill 的已纳管列表（含 projections）
 * @param {{ days?: number, now?: number }} options
 */
function listIdleSkills(resources, options = {}) {
  const days = Math.max(1, Number(options.days) || DEFAULT_IDLE_DAYS);
  const now = Number(options.now) || Date.now();
  const cutoff = now - days * MS_PER_DAY;

  // 优先用入库的 skill_calls（Claude slash/Skill + Codex 路径）；无库时回退现场扫
  let usageMap = options.usageMap instanceof Map ? options.usageMap : null;
  if (!usageMap) {
    try {
      const localStats = require('./local-stats');
      if (typeof localStats.getSkillLastUsedMap === 'function') {
        usageMap = localStats.getSkillLastUsedMap();
      }
    } catch { /* ignore */ }
  }
  if (!usageMap || usageMap.size === 0) {
    usageMap = scanClaudeSkillUsage(cutoff);
  } else {
    // 合并现场 Claude 扫描，补尚未入库的近期调用
    const live = scanClaudeSkillUsage(cutoff);
    for (const [k, ts] of live) {
      const prev = usageMap.get(k) || 0;
      if (ts > prev) usageMap.set(k, ts);
    }
  }

  const items = [];
  for (const resource of resources || []) {
    if (!resource || resource.type !== 'skill') continue;

    const key = normalizeSkillKey(resource.name);
    const altKey = normalizeSkillKey(resource.display_name);
    const fsMs = skillFsActivityMs(resource);
    const traceMs = Math.max(usageMap.get(key) || 0, usageMap.get(altKey) || 0);
    // 闲置判定只看会话调用
    if (traceMs >= cutoff) continue;

    const lastActivityAt = traceMs || 0;
    const lastActivitySource = traceMs ? 'trace' : 'never';
    const idleDays = lastActivityAt
      ? Math.floor((now - lastActivityAt) / MS_PER_DAY)
      : days;

    items.push({
      id: resource.id,
      name: resource.name,
      display_name: resource.display_name || resource.name,
      description: resource.description || '',
      type: 'skill',
      authorityPath: resolveAuthorityDir(resource) || null,
      lastActivityAt,
      lastActivitySource,
      fileActivityAt: fsMs || 0,
      idleDays,
      projectionCount: (resource.projections || []).length,
      cleanupMode: 'delete',
    });
  }

  items.sort((a, b) => a.lastActivityAt - b.lastActivityAt);
  return {
    days,
    cutoff,
    scannedAt: now,
    totalManaged: (resources || []).filter(r => r?.type === 'skill').length,
    items,
  };
}

module.exports = {
  DEFAULT_IDLE_DAYS,
  normalizeSkillKey,
  skillFsActivityMs,
  scanClaudeSkillUsage,
  listIdleSkills,
};
