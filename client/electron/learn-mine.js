// client/electron/learn-mine.js
// 只读的「跨会话 learn 式挖掘」验证原型：翻聚合会话，抽出疑似「用户纠正/长期偏好」
// 信号，跨会话按频次聚合，打印候选。不写任何文件。
//
// 用法： node electron/learn-mine.js [最多扫描的会话数，默认 300]
'use strict';

// 暗示「纠正 / 长期指令」的模式（中英）。命中其一即视为候选信号。
const SIGNAL_PATTERNS = [
  /(^|[\s,，。、])(不要|别|不能|不应|不是|应该|应当|改成|记住|务必|必须|请用|请改|不准|严禁)/,
  /(用|换成).{0,12}(不要|而不是|别用)/,
  /\b(do ?n['’]?t|do not|instead|should(?:n['’]?t)?|always|never|stop|prefer|use\b.{0,20}\bnot\b|rather than)\b/i,
  /^(no|nope|不对|不是这样|别这样)[,，\s]/i,
];

// 明显不是「偏好」的噪声（纯问句、寒暄）——降低误报。
const NEGATIVE_PATTERNS = [
  /^(谢谢|thanks|thank you|ok|好的|可以|继续|go on)\b/i,
];

// agent/harness 注入的系统前言（以 user 角色混入，非用户本人措辞）。
const BOILERPLATE_PREFIXES = [
  /^Caveat:/i,
  /^If the available MCP tools/i,
  /^Briefly inform the user/i,
  /^You are/i,
  /^<system-reminder>/i,
  /^The user (opened|sent|has)/i,
  /^Here (is|are) the/i,
  /DO NOT respond to these messages/i,
  /Implement the plan as specified/i,
  /it is attached for your reference/i,
];

// 不具泛化性：指向某次任务/某处 UI/某个具体值的一次性纠正，写进规则文件没意义。
const NON_GENERALIZABLE = [
  /[\/\\][\w.\-]+\.[a-z]{1,5}\b/i,          // 文件名/扩展名
  /\/Users\/|~\/|[A-Za-z]:\\/,             // 绝对路径
  /https?:\/\//,                            // URL
  /chunk-[A-Za-z0-9]{4,}|\.js\?v=/,         // 构建产物
  /(这里|这个页面|这块|此处|这条|这部分|改这|这版|当前页面|该页面|上面的|下面的|这行)/, // 指代当前会话上下文
  /(不正确|有问题|为空|不对劲|错位|没有显示|没显示|加载不出|显示不|对不上)/,  // bug 症状描述（非规则）
  /^改成?\s*[\d.]+\s*$/,                    // 纯改某个数值
  /\bsk-[a-z0-9-]+/i,                        // 凭证片段（具体 key 值）
];

function _isNonGeneralizable(text) {
  for (const p of NON_GENERALIZABLE) if (p.test(text)) return true;
  return false;
}

// 纯澄清式更正（"不是A，是/应该B" 纠正某次具体判断）且无祈使动作 → 一次性，非长期规则。
const _CLARIFY = [/不是.{0,24}[，,].{0,12}(是|应该)/, /是.{0,18}[，,].{0,8}不是/];
const _IMPERATIVE = /(不要|别|必须|请|始终|总是|每次)/;
function _isOneOffClarification(text) {
  if (_IMPERATIVE.test(text)) return false; // 含祈使 → 可能是规则，保留
  return _CLARIFY.some(p => p.test(text));
}

// 粘贴的报错日志 / 控制台输出 / 堆栈，不是偏好。
const PASTED_LOG_HINTS = [
  /\.js\?v=/,                       // vite 模块 URL
  /Warning: Encountered/i,
  /\n\s*at\s+\S+\s+\(/,             // JS 堆栈帧
  /\b(TypeError|ReferenceError|Uncaught|Traceback|chunk-[A-Z0-9]{6})\b/,
  /https?:\/\/\S{40,}/,             // 超长 URL 粘贴
];

function _looksLikeBoilerplate(text) {
  for (const p of BOILERPLATE_PREFIXES) if (p.test(text)) return true;
  for (const p of PASTED_LOG_HINTS) if (p.test(text)) return true;
  // 大段英文 + 无中文，且较长：多为注入前言而非用户简短指令
  if (text.length > 120 && !/[一-龥]/.test(text) && /\b(you|the|tool|user|task)\b/i.test(text)) return true;
  return false;
}

function isSignal(text) {
  if (!text) return false;
  if (_looksLikeBoilerplate(text)) return false;
  if (_isNonGeneralizable(text)) return false;
  if (_isOneOffClarification(text)) return false;
  for (const n of NEGATIVE_PATTERNS) if (n.test(text)) return false;
  for (const p of SIGNAL_PATTERNS) if (p.test(text)) return true;
  return false;
}

// 归一化成聚合 key：小写、压空白、去尾标点、截断（粗粒度合并相似指令）。
function normalizeKey(text) {
  return String(text).toLowerCase().replace(/\s+/g, ' ').replace(/[。.!！?？,，；;\s]+$/g, '').trim().slice(0, 80);
}

/**
 * 从多个会话 trace 里挖纠正/偏好候选。纯函数，可单测。
 * @param {Array<{agent_id, project, steps}>} traces
 * @returns 候选数组：{ key, text, count, agents:[], projects:[], examples:[] } 按 count 降序
 */
function mineSignals(traces, { maxLen = 200, minLen = 4 } = {}) {
  const buckets = new Map();
  for (const tr of traces || []) {
    const steps = Array.isArray(tr.steps) ? tr.steps : [];
    const seenInThisSession = new Set(); // 同一会话内同一指令只计一次
    for (const s of steps) {
      if (!s || s.kind !== 'user') continue;
      const t = (s.text || '').trim();
      if (t.length < minLen || t.length > maxLen) continue; // 太短无意义；太长多是任务描述非纠正
      if (!isSignal(t)) continue;
      const key = normalizeKey(t);
      if (!key || seenInThisSession.has(key)) continue;
      seenInThisSession.add(key);
      let b = buckets.get(key);
      if (!b) { b = { key, text: t, count: 0, agents: new Set(), projects: new Set(), examples: [] }; buckets.set(key, b); }
      b.count += 1;
      if (tr.agent_id) b.agents.add(tr.agent_id);
      if (tr.project) b.projects.add(tr.project);
      if (b.examples.length < 3 && !b.examples.includes(t)) b.examples.push(t);
    }
  }
  return [...buckets.values()]
    .map(b => ({ ...b, agents: [...b.agents], projects: [...b.projects] }))
    .sort((a, b) => b.count - a.count);
}

// 语料清洗用：明显的噪声（注入前言 / 粘贴日志 / 路径/凭证/bug 症状）。比 isSignal 宽松，
// 保留概念/术语/最佳实践等非祈使句，只去掉确定的垃圾。
function looksLikeNoise(text) {
  return _looksLikeBoilerplate(text) || _isNonGeneralizable(text);
}

module.exports = { isSignal, normalizeKey, mineSignals, looksLikeNoise, SIGNAL_PATTERNS };

// ── CLI 运行：扫真实会话并打印候选 ──────────────────────────────────────────
if (require.main === module) {
  const sb = require('./session-browser');
  const limit = parseInt(process.argv[2], 10) || 300;

  const rows = sb.listAllSessions();
  console.log(`聚合到 ${rows.length} 个会话，扫描最近 ${Math.min(limit, rows.length)} 个…\n`);

  const traces = [];
  let scanned = 0, withSteps = 0;
  for (const r of rows.slice(0, limit)) {
    try {
      const tr = sb.getTrace(r.agent_id, r.session_id);
      if (tr && Array.isArray(tr.steps) && tr.steps.length) {
        traces.push({ agent_id: r.agent_id, project: tr.project || r.project, steps: tr.steps });
        withSteps += 1;
      }
    } catch { /* 跳过坏会话 */ }
    scanned += 1;
  }

  const signals = mineSignals(traces);
  const totalUserMsgs = traces.reduce((n, t) => n + t.steps.filter(s => s.kind === 'user').length, 0);

  console.log(`扫描 ${scanned} 会话（${withSteps} 有内容），共 ${totalUserMsgs} 条 user 消息。`);
  console.log(`命中纠正/偏好候选 ${signals.length} 类。\n`);
  console.log('Top 候选（按跨会话出现次数）：');
  console.log('─'.repeat(72));
  for (const s of signals.slice(0, 30)) {
    const agents = s.agents.join(',');
    console.log(`[×${s.count}] (${agents}) ${s.examples[0].replace(/\s+/g, ' ').slice(0, 90)}`);
  }
  if (!signals.length) console.log('（没挖到候选——可能会话量少，或纠正措辞不在当前模式里）');
}
