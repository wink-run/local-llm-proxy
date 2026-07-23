import { useEffect, useRef } from 'react';

/** 距底部多少像素内视为「仍贴底」 */
const NEAR_BOTTOM_PX = 96;

/** 向上查找可滚动父节点（overflow-y: auto/scroll） */
function findScrollParent(el) {
  let node = el?.parentElement;
  while (node && node !== document.documentElement) {
    const style = window.getComputedStyle(node);
    const oy = style.overflowY;
    if (oy === 'auto' || oy === 'scroll' || oy === 'overlay') return node;
    node = node.parentElement;
  }
  return null;
}

/**
 * 仅在用户贴底时跟随滚动；上滑阅读时不再强行滚到底。
 * @param {React.RefObject<HTMLElement|null>} endRef 列表末尾锚点
 * @param {unknown} watch 内容变化监视（任意可比较引用/值，勿传可变长度的 hooks deps 展开）
 * @param {{ forcePinKey?: unknown }} [options] forcePinKey 变化时重新钉住底部（如用户新发消息）
 */
export function usePinBottomScroll(endRef, watch, options = {}) {
  const pinnedRef = useRef(true);
  const parentRef = useRef(null);
  const { forcePinKey } = options;

  // 用户主动发新消息 / 切会话：重新钉住底部
  useEffect(() => {
    if (forcePinKey === undefined) return;
    pinnedRef.current = true;
  }, [forcePinKey]);

  // 绑定滚动父容器（内容从空到有时 endRef 才挂载）
  useEffect(() => {
    const end = endRef.current;
    if (!end) return undefined;
    const parent = findScrollParent(end);
    if (!parent) return undefined;
    parentRef.current = parent;

    const onScroll = () => {
      const dist = parent.scrollHeight - parent.scrollTop - parent.clientHeight;
      pinnedRef.current = dist <= NEAR_BOTTOM_PX;
    };
    onScroll();
    parent.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      parent.removeEventListener('scroll', onScroll);
      if (parentRef.current === parent) parentRef.current = null;
    };
  }, [endRef, watch]);

  // 内容更新：仅贴底时滚到底
  useEffect(() => {
    if (!pinnedRef.current) return;
    const end = endRef.current;
    if (!end) return;
    // auto：流式高频更新时避免 smooth 动画队列把用户拽回去
    end.scrollIntoView({ behavior: 'auto', block: 'end' });
  }, [endRef, watch]);
}
