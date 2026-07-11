// Debug 输入框 @tbp 自动补全的纯逻辑（ESM，供 Vite 与 node 单测共用）

// 光标左侧若正在输入 @tbp 触发词，返回 { active, query, start }
// 触发形态：@tbp、@tbp:、@tbp:<部分名字>；token 后一旦出现空白即视为结束。
export function detectTbpQuery(text, caret) {
  const left = String(text || '').slice(0, Math.max(0, caret | 0));
  const m = left.match(/@tbp(?::([^\s@]*))?$/);
  if (!m) return { active: false, query: '', start: caret };
  return { active: true, query: m[1] || '', start: m.index };
}

// 按 name / display_name 大小写不敏感过滤，限制数量
export function filterPromptSuggestions(prompts, query, limit = 8) {
  const q = String(query || '').toLowerCase();
  const out = [];
  for (const p of prompts || []) {
    const name = String(p.name || '').toLowerCase();
    const disp = String(p.display_name || '').toLowerCase();
    if (!q || name.includes(q) || disp.includes(q)) {
      out.push(p);
      if (out.length >= limit) break;
    }
  }
  return out;
}
