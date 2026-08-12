// client/electron/resource-description.js
// 安装/纳管时从正文提炼卡片简介（避免把「You are…」角色指令直接当说明）
'use strict';

const MAX_DESC = 180;

function clipDesc(text, max = MAX_DESC) {
  let s = String(text || '').replace(/\s+/g, ' ').trim();
  if (s.length > max) s = `${s.slice(0, max - 1)}…`;
  return s;
}

/** 像系统角色设定、不宜直接当卡片简介 */
function isRawRoleBlurb(text) {
  const t = String(text || '').trim();
  if (!t) return true;
  return /^(you are|you're|your job|your role|i am an?|as an? ai|作为一名?|你是一位?|你的(任务|职责|工作)|角色[：:])/i.test(t);
}

function firstHeading(body) {
  const m = String(body || '').match(/^#\s+(.+)$/m);
  return m ? m[1].trim().replace(/^#+\s*/, '') : '';
}

/**
 * 把 “You are X. Your job: Y” 收成短简介；有标题时优先用标题。
 */
function refineRolePromptBlurb(text, title = '') {
  const raw = String(text || '').replace(/\s+/g, ' ').trim();
  if (!raw) return '';

  const jobOnly = raw.match(/\byour job\s*[:：]\s*(.+)$/i);
  if (jobOnly) {
    const head = title || raw.match(/^you are (?:a |an |the )?(.+?)[.。]/i)?.[1] || '';
    return clipDesc(head ? `${head}：${jobOnly[1]}` : jobOnly[1]);
  }

  const youAre = raw.match(/^you are (?:a |an |the )?(.+?)[.。]\s*(.+)$/i);
  if (youAre) {
    const head = title || youAre[1];
    return clipDesc(`${head}：${youAre[2]}`);
  }

  const cn = raw.match(/^(?:你是一位?|作为一名?)(.+?)[。.!！]\s*(.+)$/);
  if (cn) {
    const head = title || cn[1].trim();
    return clipDesc(`${head}：${cn[2]}`);
  }

  if (title && isRawRoleBlurb(raw)) {
    // 角色句无法拆时，至少用标题，避免整段 You are 上屏
    return clipDesc(title);
  }
  return '';
}

function collectProseLines(body, { skipRole = true } = {}) {
  const buf = [];
  for (const line of String(body || '').split(/\r?\n/)) {
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
    if (/^\*\*[^*]+\*\*/.test(t) && !buf.length) continue;
    if (skipRole && isRawRoleBlurb(t)) {
      // 单行角色设定：尝试提炼后收下，不再继续拼正文
      const refined = refineRolePromptBlurb(t, firstHeading(body));
      if (refined) return [refined];
      continue;
    }
    buf.push(t);
    if (buf.join(' ').length >= 48) break;
  }
  return buf;
}

function parseFrontmatterLite(content) {
  const text = String(content || '');
  const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) return {};
  const meta = {};
  for (const line of match[1].split(/\r?\n/)) {
    const m = line.match(/^([A-Za-z0-9_-]+)\s*:\s*(.+)$/);
    if (!m) continue;
    let val = m[2].trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    meta[m[1].toLowerCase()] = val;
  }
  return meta;
}

/**
 * Skill：优先 YAML description；否则从正文提炼（跳过/改写 You are…）。
 * @param {string} content
 * @param {object} [fm] frontmatter
 */
function extractSkillDescription(content, fm = null) {
  const text = String(content || '');
  const meta = fm || parseFrontmatterLite(text);

  const fromFm = String(meta.description || '').trim();
  if (fromFm && !isRawRoleBlurb(fromFm)) return clipDesc(fromFm);
  if (fromFm && isRawRoleBlurb(fromFm)) {
    const body = text.replace(/^---\r?\n[\s\S]*?\r?\n---\s*/, '');
    const refined = refineRolePromptBlurb(fromFm, firstHeading(body) || meta.name || '');
    if (refined) return refined;
  }

  const body = text.replace(/^---\r?\n[\s\S]*?\r?\n---\s*/, '');
  const title = firstHeading(body) || String(meta.name || '').trim();
  const lines = collectProseLines(body, { skipRole: true });
  if (lines.length === 1 && !isRawRoleBlurb(lines[0]) && lines[0].includes('：')) {
    return clipDesc(lines[0]);
  }
  let desc = lines.join(' ').replace(/\s+/g, ' ').trim();
  if (isRawRoleBlurb(desc)) {
    const refined = refineRolePromptBlurb(desc, title);
    if (refined) return refined;
  }
  if (!desc && title) return clipDesc(title);
  return clipDesc(desc);
}

/** Prompt：取正文首段有意义句子 */
function extractPromptDescription(content) {
  const text = String(content || '').replace(/^---\r?\n[\s\S]*?\r?\n---\s*/, '');
  const lines = collectProseLines(text, { skipRole: false });
  let desc = lines.join(' ').trim();
  if (isRawRoleBlurb(desc)) {
    const refined = refineRolePromptBlurb(desc, firstHeading(text));
    if (refined) return refined;
  }
  return clipDesc(desc);
}

/** Assistant：从 soul 提炼一句 */
function extractAssistantDescription(content) {
  let soul = '';
  try {
    const { parseAssistantConfig } = require('./resource-assistant');
    soul = String(parseAssistantConfig(content)?.soul || '').trim();
  } catch {
    soul = String(content || '').trim();
  }
  if (!soul) return '';
  // 取首句（中英文句号后可不跟空格）
  const m = soul.match(/^[\s\S]+?[。.!！]/);
  const one = (m ? m[0] : soul).trim();
  if (isRawRoleBlurb(one)) {
    const refined = refineRolePromptBlurb(one);
    if (refined) return refined;
  }
  return clipDesc(one);
}

/**
 * 按类型提炼简介；已有「像样」的说明则原样返回。
 * @param {'skill'|'prompt'|'assistant'|string} type
 * @param {string} content
 * @param {{ description?: string, name?: string, fm?: object }} [opts]
 */
function extractResourceDescription(type, content, opts = {}) {
  const existing = String(opts.description || '').trim();
  if (existing && !isRawRoleBlurb(existing)) return clipDesc(existing);

  const t = type === 'agent' ? 'assistant' : type;
  let next = '';
  if (t === 'skill') next = extractSkillDescription(content, opts.fm || null);
  else if (t === 'assistant') next = extractAssistantDescription(content);
  else next = extractPromptDescription(content);

  if (next) return next;
  if (existing) {
    const refined = refineRolePromptBlurb(existing, opts.name || '');
    if (refined) return refined;
  }
  return clipDesc(opts.name || existing || '');
}

/** 是否应用提炼结果覆盖旧说明 */
function shouldReplaceDescription(oldDesc, nextDesc) {
  const next = String(nextDesc || '').trim();
  if (!next) return false;
  const old = String(oldDesc || '').trim();
  if (!old) return true;
  if (isRawRoleBlurb(old) && !isRawRoleBlurb(next)) return true;
  return false;
}

module.exports = {
  MAX_DESC,
  clipDesc,
  isRawRoleBlurb,
  refineRolePromptBlurb,
  extractSkillDescription,
  extractPromptDescription,
  extractAssistantDescription,
  extractResourceDescription,
  shouldReplaceDescription,
};
