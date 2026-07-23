/**
 * 流式 Markdown 辅助（与 React 组件分离，避免 Fast Refresh 失效）
 */

/** 流式正文尚未闭合的 Markdown 标记会把后续字吃进 code/加粗；软化未闭合标记 */
export function softenStreamingMarkdown(text) {
  let s = String(text || '');
  if (!s) return s;

  // 未闭合 ``` 围栏:补一个收尾,避免整段被当成代码吞掉后续
  const fenceLines = s.split('\n').filter((ln) => ln.trim().startsWith('```'));
  if (fenceLines.length % 2 === 1) s = `${s}\n\`\`\``;

  // 行内反引号不成对:去掉末尾孤立 `,避免 `foo 吃到句末
  const ticks = (s.match(/`/g) || []).length;
  if (ticks % 2 === 1) {
    const idx = s.lastIndexOf('`');
    if (idx >= 0) s = `${s.slice(0, idx)}${s.slice(idx + 1)}`;
  }

  // 未闭合 ** / __ :去掉最后一个开标签星号对的一半,避免吞字
  const boldStars = (s.match(/\*\*/g) || []).length;
  if (boldStars % 2 === 1) {
    const idx = s.lastIndexOf('**');
    if (idx >= 0) s = `${s.slice(0, idx)}${s.slice(idx + 2)}`;
  }

  return s;
}

/** 是否适合立刻走 Markdown(闭合标记齐全);否则流式期用纯文本更稳 */
export function isMarkdownStable(text) {
  const s = String(text || '');
  if (!s) return true;
  const fences = s.split('\n').filter((ln) => ln.trim().startsWith('```')).length;
  if (fences % 2 === 1) return false;
  if (((s.match(/`/g) || []).length) % 2 === 1) return false;
  if (((s.match(/\*\*/g) || []).length) % 2 === 1) return false;
  return true;
}
