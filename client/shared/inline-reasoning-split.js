// 从混在一起的 assistant 文本中拆分内部推理与用户可见回复
// 参考 Anthropic stream-json：thinking 块(thinking_delta) 与 text 块(text_delta) 分离

const REASONING_START = /^(The user (is|has|just|wants|said|asked|mentioned|is just|is saying)|I'll respond|I should (respond|reply|answer|keep|provide|be|not)|This is (a |an )?(simple|straightforward|basic|quick|casual)|No need for any)/i;

const REASONING_MARKERS = /\b(CLAUDE\.md|without any fluff|simple greeting|casual greeting|as per (their|the|user)|I should respond|match their tone|match their language|respond in (Chinese|English|briefly)|concise(?:ly)? without|No need for any tools)/i;

const REASONING_BOUNDARY = /(?:instructions\.?|without any fluff\.?|simple greeting\.?|complex responses\.?|CLAUDE\.md instructions\.?)(?=[\u4e00-\u9fffA-Z「"'(!?]|$)/i;

const EN_REPLY_START = /^(Hi|Hello|Hey|Sure|OK|Yes|No)\b/i;

/** 英文 meta 片段（含 thinking 截断后的续写） */
const REASONING_META = /\b(The user|which means|Let me (?:write|respond|help|create|introduce|give)|I'll (?:write|respond|help|introduce)|in Chinese|in English|write a (?:poem|short)|for them|for the user|I should|They said|asking me to|system prompt|This is (?:a |an )?(?:simple|straightforward)|my identity|concise answer|Who are you)\b/i;

/** thinking 是否仍停在用户原话引号未闭合处（含 …saying "hi — …） */
function hasOpenUserQuote(text) {
  const t = String(text || '');
  return /(?:asking|said|saying|asked|They said|user (?:said|asked|saying))\s+"[^"]*$/i.test(t)
    || /(?:asking|said|saying|asked|They said|user (?:said|asked|saying))\s+'[^']*$/i.test(t)
    || /(?:asking|said|saying|asked|They said)\s*「[^」]*$/i.test(t);
}

/** thinking 是否在词中/句中被截断（应用后续 output 拼回） */
export function isTruncatedThinking(text) {
  const t = String(text || '').trim();
  if (!t) return false;
  if (hasOpenUserQuote(t)) return true;
  // 词中截断：…whatever t / …hel
  if (/[a-z]$/i.test(t) && !/[.!?…"」')\]]$/.test(t)) return true;
  if (/\b(whatever|ready to help|I should|Let me|respond with|be ready)\s*$/i.test(t)) return true;
  return false;
}

/** 拼回被截断的 thinking + output（单词拆开时不加空格） */
export function joinThinkingOutput(thinking, output) {
  const t = String(thinking || '');
  const o = String(output || '');
  if (!t) return o.trim();
  if (!o) return t.trim();
  const tt = t.trimEnd();
  const oo = o.trimStart();
  if (/[a-z]$/i.test(tt) && /^[a-z]/i.test(oo)) return `${tt}${oo}`;
  if (/[.!?,;:]$/.test(tt) && !/^\s/.test(o)) return `${tt} ${oo}`.replace(/\s{2,}/g, ' ');
  return `${tt} ${oo}`.replace(/\s{2,}/g, ' ').trim();
}

/**
 * 常见中文回复起句。
 * 「行」不可裸匹配：会误切路径里的「行业/银行/行程」等词。
 */
const CJK_REPLY_START = /^(我是|你好|您好|好的|当然|没问题|可以|嗯|行([，。！？\s]|$)|行啊|行吧|行的|抱歉|对不起)/;

/** 行内/代码块内容是否像本地绝对路径 */
function looksLikeCodePathBody(body) {
  const t = String(body || '').trim();
  return /^(?:file:\/\/)?(?:\/(?:Users|home|tmp|var|opt|private|Volumes)|~\/|[A-Za-z]:[\\/])/i.test(t);
}

/**
 * 下标是否落在 Markdown 行内代码 `...` 或围栏 ```...``` 内。
 * `` `/Users/.../储能行业发展报告.pptx` `` 整段视为不可分割路径。
 */
function isInsideInlineCode(text, idx) {
  const s = String(text || '');
  if (idx < 0 || idx >= s.length) return false;
  let i = 0;
  while (i < s.length) {
    if (s[i] !== '`') {
      i += 1;
      continue;
    }
    // 围栏代码块 ```
    if (s.slice(i, i + 3) === '```') {
      const end = s.indexOf('```', i + 3);
      if (end < 0) return idx >= i;
      if (idx >= i && idx < end + 3) return true;
      i = end + 3;
      continue;
    }
    const end = s.indexOf('`', i + 1);
    if (end < 0) {
      // 未闭合反引号：内容像路径则整段保护到文末
      if (looksLikeCodePathBody(s.slice(i + 1)) && idx > i) return true;
      return false;
    }
    if (idx > i && idx < end) return true;
    i = end + 1;
  }
  return false;
}

/** CJK 是否落在本地绝对路径中间（含反引号包裹的完整路径、中文文件名） */
function isCjkInsideLocalPath(text, cjkIdx) {
  // Markdown 代码路径 `...` 内任意中文均不可切
  if (isInsideInlineCode(text, cjkIdx)) return true;
  const before = String(text || '').slice(0, cjkIdx);
  // 裸路径 `/Users/...中文`（无反引号）
  return /(?:file:\/\/)?(?:\/(?:Users|home|tmp|var|opt|private|Volumes)|~\/|[A-Za-z]:[\\/])[^\s'"<>|\n]*$/i.test(before);
}

export function hasReasoningMeta(text) {
  return REASONING_META.test(String(text || ''));
}

export function normalizeLoose(s) {
  return String(s).replace(/\s+/g, ' ').replace(/[.,!?;:]/g, '').trim().toLowerCase();
}

export function looksLikeInlineReasoning(text) {
  const t = String(text || '').trim();
  if (!t || t.length < 20) return false;
  return REASONING_START.test(t)
    || (REASONING_MARKERS.test(t) && /The user\b|I'll respond|No need for/i.test(t));
}

export function dedupeRepeatedText(text) {
  let raw = String(text || '');
  if (raw.length < 30) return raw;

  if (/^The user\b/i.test(raw)) {
    const second = raw.indexOf('The user', 10);
    if (second > 20) {
      const first = raw.slice(0, second).trim();
      const rest = raw.slice(second).trim();
      if (normalizeLoose(first) === normalizeLoose(rest)) return first;
      if (normalizeLoose(rest).startsWith(normalizeLoose(first))) {
        return dedupeRepeatedText(rest);
      }
    }
  }

  const half = Math.floor(raw.length / 2);
  const a = raw.slice(0, half);
  const b = raw.slice(half);
  if (a === b || normalizeLoose(a) === normalizeLoose(b)) return a;
  if (b.startsWith(a) || normalizeLoose(b).startsWith(normalizeLoose(a))) return b;
  if (a.startsWith(b)) return a;

  return raw;
}

/** 输出中去掉与已有 thinking 重复的前缀（stream_event + assistant 快照重复时） */
export function stripDuplicateThinkingPrefix(output, thinking) {
  let o = dedupeRepeatedText(String(output || '')).trim();
  const t = String(thinking || '').trim();
  if (!o || !t) return o;

  const looseO = normalizeLoose(o);
  const looseT = normalizeLoose(t);
  if (looseO.startsWith(looseT)) {
    o = o.slice(t.length).replace(/^[\s.]+/, '').trim();
  } else if (looksLikeInlineReasoning(o)) {
    const parts = splitInlineReasoning(o);
    const outputs = parts.filter(p => p.stepType === 'output').map(p => p.content).join('').trim();
    if (outputs) o = outputs;
  }

  return o;
}

/** CJK 是否落在「用户原话」未闭合引号内（asking/said "…"），不能当回复起点 */
function isCjkInsideUserQuote(text, cjkIdx) {
  const prefix = String(text || '').slice(0, cjkIdx);
  if (/(?:asking|said|saying|asked|They said|user (?:said|asked|saying))\s*"[^"]*$/i.test(prefix)) return true;
  if (/(?:asking|said|saying|asked|They said|user (?:said|asked|saying))\s*'[^']*$/i.test(prefix)) return true;
  if (/(?:asking|said|saying|asked|They said)\s*「[^」]*$/i.test(prefix)) return true;
  return false;
}

/**
 * 真正的中文回复起点：跳过引号内用户原话，以及推理段里夹带的中文产品名
 * @returns {number} 下标；-1 表示尚未出现用户可见中文回复
 */
export function findUserFacingCjkIndex(text) {
  const raw = String(text || '');
  if (!raw) return -1;

  // 无句号的 meta→中文；英文段不得吞掉汉字（否则会切到「官方」的「官」）
  const metaThenCjk = raw.match(
    /(?:which means[^\u4e00-\u9fff《「.]*\.|Let me (?:write|respond|help|create|introduce|give)[^\u4e00-\u9fff《「.!?\n]*[.!]?|I'll (?:write|respond|help|introduce)[^\u4e00-\u9fff《「.!?\n]*[.!]?|I should (?:respond|reply|answer|introduce)[^\u4e00-\u9fff《「.!?\n]*[.!]?|This is (?:a |an )?(?:simple|straightforward)[^\u4e00-\u9fff《「.!?\n]*[.!]?|in Chinese\.|for them\.|for the user\.|a poem for them\.|a short poem for them\.|system prompt[^\u4e00-\u9fff《「.]*\.|concise answer)\s*(?=[\u4e00-\u9fff《「])/i,
  );
  if (metaThenCjk) {
    const idx = metaThenCjk.index + metaThenCjk[0].length;
    // 不可切进 Markdown 代码路径 / 本地路径中的中文
    if (!isCjkInsideUserQuote(raw, idx) && !isCjkInsideLocalPath(raw, idx) && !isInsideInlineCode(raw, idx)) {
      return idx;
    }
  }

  const re = /[\u4e00-\u9fff《「]/g;
  let m;
  while ((m = re.exec(raw)) !== null) {
    const idx = m.index;
    if (idx <= 6) continue;
    if (isCjkInsideUserQuote(raw, idx)) continue;
    // `` `/path/中文名.pptx` `` 与裸路径中的中文文件名均不可当回复起点
    if (isCjkInsideLocalPath(raw, idx)) continue;
    if (isInsideInlineCode(raw, idx)) continue;
    const prefix = raw.slice(0, idx);
    if (!REASONING_META.test(prefix) && !looksLikeInlineReasoning(prefix)) continue;
    // 推理里夹的中文词：后面紧跟着英文 meta 续写 → 跳过
    const early = raw.slice(idx, idx + 96);
    if (/\b(I should|The user|system prompt|which means|Let me|I'll respond|This is (?:a )?simple)\b/i.test(early)) continue;
    const suffix = raw.slice(idx);
    const punctOk = /[.!?"'」。)）\]]\s*$/.test(prefix.trim());
    // 无句号也可切：前缀像推理且后缀是常见中文起句（answer我是…）
    if (!punctOk && !CJK_REPLY_START.test(suffix)) continue;
    return idx;
  }
  return -1;
}

/**
 * 英文用户可见回复起点（Hi/Hello），含 helpHi 无空格粘连
 * @returns {number} 下标；-1 表示未找到
 */
export function findUserFacingEnIndex(text) {
  const raw = String(text || '');
  if (!raw) return -1;

  // helpHi! / need.Hi / concelyHi / respond concelyHi（含拼写截断）
  const glued = raw.match(/\b(?:help|need|briefly|concisely|concely|fluff|tools|responses|language|tone|answer|greeting|respond\s+\w+)\.?((?:Hi|Hello|Hey)\b)/i);
  if (glued) return glued.index + glued[0].length - glued[1].length;

  const metaHi = raw.match(
    /(?:I should (?:respond|reply|answer)[^\u4e00-\u9fff.!?\n]*[.!]?|Let me respond[^\u4e00-\u9fff.!?\n]*[.!]?|respond briefly[^\u4e00-\u9fff.!?\n]*[.!]?|ask how (?:I )?can help\.?|simple greeting\.?|without any fluff\.?)\s*(?=(?:Hi|Hello|Hey)\b)/i,
  );
  if (metaHi) return metaHi.index + metaHi[0].length;

  if (hasReasoningMeta(raw) || /simple greeting|I should respond|respond briefly|how (?:I )?can help/i.test(raw)) {
    // 必须带左词界，避免匹配 They 里的 hey
    const re = /\b(?:Hi|Hello|Hey)\b/g;
    let m;
    while ((m = re.exec(raw)) !== null) {
      if (m.index < 8) continue;
      const prefix = raw.slice(0, m.index);
      if (hasReasoningMeta(prefix) || /simple greeting|I should|respond briefly|can help/i.test(prefix)) {
        return m.index;
      }
    }
  }
  return -1;
}

/** 定位用户可见回复的起点（中文或英文 Hi，跳过 thinking 续写） */
export function findUserFacingStart(text) {
  const raw = String(text || '');
  if (!raw) return 0;
  const candidates = [findUserFacingCjkIndex(raw), findUserFacingEnIndex(raw)]
    .filter((n) => n > 0)
    // Markdown 代码路径 / 围栏内禁止切开
    .filter((n) => !isInsideInlineCode(raw, n) && !isCjkInsideLocalPath(raw, n));
  return candidates.length ? Math.min(...candidates) : 0;
}

/**
 * 是否存在足够清晰的推理/回复分界（可安全拆成推理卡 + 回复气泡）
 * 分界不清时不应单独展示推理，整段当输出即可
 */
export function hasClearReasoningBoundary(text) {
  const raw = String(text || '').trim();
  if (!raw) return false;
  const start = findUserFacingStart(raw);
  if (start <= 8) return false;
  const after = raw.slice(start).trim();
  if (!after) return false;
  // 回复侧必须以常见起句开始，且前缀像推理
  if (!EN_REPLY_START.test(after) && !CJK_REPLY_START.test(after)) return false;
  const before = raw.slice(0, start).trim();
  return looksLikeInlineReasoning(before) || hasReasoningMeta(before) || /\bThe user\b/i.test(before);
}

/** output 含推理泄漏（含 thinking 在句中被截断后的续写） */
export function looksLikeLeakedReasoning(text) {
  const t = String(text || '').trim();
  if (!t) return false;
  if (looksLikeInlineReasoning(t)) return true;
  // 引号闭合续写 / 身份类 meta 起头（常接在 thinking 截断之后）
  if (/^["']\s*\(/i.test(t) && /\b(Who are you|simple question|my identity|Let me)\b/i.test(t)) return true;
  if (/^(This is (?:a |an )?(?:simple|straightforward)|Let me give)\b/i.test(t)) return true;
  // 列表续写：• a simple greeting. I should respond…
  if (/^[•\-*·]\s/.test(t) && /\b(I should|simple greeting|respond briefly|how (?:I )?can help)\b/i.test(t)) {
    return true;
  }
  if (/\bhow (?:I )?can help(?:Hi|Hello|Hey)\b/i.test(t)) return true;
  // 词中续写 + 粘连 Hi：hey need.Hi What are you…
  if (/^[a-z]{2,16}\b/i.test(t) && /\bneed\.?(?:Hi|Hello|Hey)\b/i.test(t)) return true;
  if (/^[a-z]{2,16}\b/i.test(t) && findUserFacingEnIndex(t) > 0) return true;
  return (hasReasoningMeta(t) || /simple greeting|respond briefly/i.test(t)) && findUserFacingStart(t) > 0;
}

/** 结合已有 thinking，剥离 output 中所有推理泄漏 */
export function stripReasoningLeakage(output, thinking) {
  let o = dedupeRepeatedText(String(output || '')).trim();
  const t = String(thinking || '').trim();
  if (!o) return o;

  // 引号未闭合：thinking='…asking "你是谁' + output='" (Who are you?)…我是…'
  if (t && hasOpenUserQuote(t)) {
    const combined = `${t}${o}`;
    const cut = findUserFacingStart(combined);
    if (cut > 0) return combined.slice(cut).trim();
    if (hasReasoningMeta(o) || looksLikeLeakedReasoning(o) || looksLikeInlineReasoning(combined)) return '';
  }

  if (t) o = stripDuplicateThinkingPrefix(o, t);

  const thinkingIncomplete = !t || hasOpenUserQuote(t)
    || /["'`]\s*$|\bsaid\s+"?$|They said\s+"?$/i.test(t)
    || /\b(to|me to)\s+\w+\.\s*They\b/i.test(t);
  // 即使 thinking 已闭合，output 前半仍可能是英文 meta 续写
  const start = findUserFacingStart(o);
  if (start > 0 && (thinkingIncomplete || hasReasoningMeta(o.slice(0, start)) || looksLikeLeakedReasoning(o))) {
    o = o.slice(start).trim();
  }

  return o;
}

/**
 * thinking 末尾停在本地路径 / Markdown 代码路径中间，output 以中文或路径续写续上
 * 例：`…/储能` + `行业发展报告.pptx`
 */
function isPathSplitAcrossBoundary(thinking, output) {
  const t = String(thinking || '').trimEnd();
  const o = String(output || '').trimStart();
  if (!t || !o) return false;

  // 未闭合的 Markdown 代码路径：thinking 含奇数个 ` 且最后一段像路径
  const tickCount = (t.match(/`/g) || []).length;
  if (tickCount % 2 === 1) {
    const afterTick = t.slice(t.lastIndexOf('`') + 1);
    if (looksLikeCodePathBody(afterTick) || looksLikeCodePathBody(`${afterTick}${o}`)) {
      return true;
    }
  }

  if (!/^[\u4e00-\u9fff./~`]/.test(o)) return false;
  // thinking 末尾已落在绝对路径段内，且以中文结尾（扩展名尚未出现）
  if (!/(?:`|file:\/\/)?(?:\/(?:Users|home|tmp|var|opt|private|Volumes)|~\/|[A-Za-z]:[\\/])[^\s'"<>|\n]*[\u4e00-\u9fff]$/i.test(t)) {
    return false;
  }
  // 拼回后应能看到常见文件扩展名，确认是路径续写而非两段无关中文
  const joinedTail = `${t.slice(-120)}${o.slice(0, 120)}`;
  return /\.[A-Za-z0-9]{1,12}(?:[`'"\s]|$)/.test(joinedTail);
}

/**
 * 修复 thinking 末尾与 output 开头之间的 Markdown/书名号截断
 * 例：think="…fresh one.** 《" + out="无题》 **\n诗…" → "**《无题》**\n诗…"
 */
export function repairThinkingOutputBoundary(thinking, output) {
  let t = String(thinking || '').trim();
  let o = String(output || '').trim();
  if (!t || !o) return { thinking: t, output: o };

  const tailOpen = t.match(/^(.*?)(\*\*\s*[《「]?)\s*$/)
    || t.match(/^(.*?)(\*\s*[《「]?)\s*$/);
  if (tailOpen) {
    const [, english, openFrag] = tailOpen;
    const closeMatch = o.match(/^([^》\n]+》)\s*(\*{1,2})\s*([\s\S]*)$/);
    if (closeMatch && /[\u4e00-\u9fff]/.test(closeMatch[1])) {
      const titleInner = closeMatch[1].replace(/》$/, '');
      const rest = closeMatch[3] || '';
      const openBracket = openFrag.includes('《') ? '《' : openFrag.includes('「') ? '「' : '《';
      o = `**${openBracket}${titleInner}》**${rest.startsWith('\n') ? rest : (rest ? `\n${rest}` : '')}`;
      t = english.trim();
      return { thinking: t, output: o.trim() };
    }
    if (/[》」]/.test(o)) {
      t = english.trim();
      o = openFrag.replace(/\s/g, '') + o;
      return { thinking: t, output: o };
    }
  }

  // thinking 不应以 markdown/书名号碎片结尾
  if (/(\*\*\s*[《「]?|\*\s*[《「]?)\s*$/.test(t)) {
    t = t.replace(/(\*\*\s*[《「]?|\*\s*[《「]?)\s*$/, '').trim();
  }

  // 本地路径在中文文件名处被切开：…/储能 + 行业发展报告.pptx → 拼回
  if (isPathSplitAcrossBoundary(t, o)) {
    const combined = `${t}${o}`;
    const cut = findUserFacingStart(combined);
    if (cut > 0 && hasClearReasoningBoundary(combined)) {
      return {
        thinking: combined.slice(0, cut).trim(),
        output: combined.slice(cut).trim(),
      };
    }
    // 分界不清时整段当输出，避免路径继续残缺
    return { thinking: '', output: combined.trim() };
  }

  // 词中/引号截断：拼回后能清晰切开才保留推理，否则整段当输出
  if (isTruncatedThinking(t) || looksLikeLeakedReasoning(o)) {
    const combined = joinThinkingOutput(t, o);
    if (hasClearReasoningBoundary(combined)) {
      const cut = findUserFacingStart(combined);
      return {
        thinking: combined.slice(0, cut).trim(),
        output: combined.slice(cut).trim(),
      };
    }
    return { thinking: '', output: combined };
  }

  // 重绘修正：output 前半是推理续写（含 • a simple greeting…helpHi!）→ 并回 thinking
  const leakish = looksLikeLeakedReasoning(o)
    || hasReasoningMeta(o)
    || /^[•\-*·]\s/.test(o)
    || /said\s+["'][^"']+["']\s*$/i.test(t);
  const start = findUserFacingStart(o);
  if (leakish && start > 0) {
    const nextThink = `${t} ${o.slice(0, start).trim()}`.trim();
    const nextOut = o.slice(start).trim();
    // 切开后回复侧仍不像干净起句 → 放弃推理卡
    if (!hasClearReasoningBoundary(`${nextThink} ${nextOut}`) && !EN_REPLY_START.test(nextOut) && !CJK_REPLY_START.test(nextOut)) {
      return { thinking: '', output: `${t} ${o}`.trim() };
    }
    return { thinking: nextThink, output: nextOut };
  }
  if (leakish && start === 0) {
    // 无清晰分界：整段输出，不展示推理
    return { thinking: '', output: `${t} ${o}`.trim() };
  }

  return { thinking: t, output: o };
}

/** 逐步修复相邻 thinking → output 边界 */
export function sanitizeThinkingOutputPairs(steps) {
  if (!steps?.length) return steps;
  const out = steps.map(s => ({ ...s }));
  for (let i = 0; i < out.length - 1; i++) {
    if (out[i].stepType !== 'thinking' || out[i + 1].stepType !== 'output') continue;
    const repaired = repairThinkingOutputBoundary(out[i].content, out[i + 1].content);
    out[i] = { ...out[i], content: repaired.thinking };
    out[i + 1] = { ...out[i + 1], content: repaired.output };
  }
  return out.filter((s) => String(s.content || '').trim());
}

function splitAtUserFacingBoundary(text) {
  const raw = String(text || '').trim();
  if (!looksLikeInlineReasoning(raw)) return null;

  // 仅在分界清晰时拆分；否则交给上层整段当输出
  if (!hasClearReasoningBoundary(raw)) return null;

  const cut = findUserFacingStart(raw);
  if (cut > 8) {
    const thinking = raw.slice(0, cut).replace(/[.\s]+$/, '').trim();
    const output = raw.slice(cut).trim();
    if (thinking && output) {
      return [
        { stepType: 'thinking', content: thinking },
        { stepType: 'output', content: output },
      ];
    }
  }

  return null;
}

export function splitInlineReasoning(text) {
  let raw = dedupeRepeatedText(String(text || '')).trim();
  if (!raw) return [];

  if (!looksLikeInlineReasoning(raw)) {
    return [{ stepType: 'output', content: raw }];
  }

  const atBoundary = splitAtUserFacingBoundary(raw);
  if (atBoundary) {
    const out = [];
    for (const part of atBoundary) {
      if (part.stepType === 'output' && looksLikeInlineReasoning(part.content) && hasClearReasoningBoundary(part.content)) {
        out.push(...splitInlineReasoning(part.content));
      } else {
        out.push(part);
      }
    }
    return out;
  }

  // 无清晰分界：不展示推理，整段当输出
  return [{ stepType: 'output', content: raw }];
}

export function expandMixedOutputSteps(steps) {
  if (!steps?.length) return steps;
  const out = [];
  for (const s of steps) {
    if (s.stepType === 'output' && s.content && looksLikeInlineReasoning(s.content)) {
      for (const part of splitInlineReasoning(s.content)) {
        out.push({ ...s, stepType: part.stepType, content: part.content });
      }
    } else {
      out.push(s);
    }
  }
  return dedupeConsecutiveSteps(out);
}

export function dedupeConsecutiveSteps(steps) {
  if (!steps?.length) return steps;
  const out = [];
  for (const s of steps) {
    const last = out[out.length - 1];
    const type = s.stepType || 'output';
    if (last && last.stepType === type && (type === 'thinking' || type === 'output')) {
      if (normalizeLoose(last.content) === normalizeLoose(s.content)) continue;
      const merged = String(s.content).startsWith(last.content) ? s.content : last.content + s.content;
      if (normalizeLoose(merged) === normalizeLoose(last.content)) continue;
      out[out.length - 1] = { ...last, ...s, content: merged };
    } else {
      out.push(s);
    }
  }
  return out;
}
