import React, { useEffect, useState, useCallback, useRef } from 'react';
import { useLang } from '../store/lang';
import { isElectron } from '../api/adapter';
import emblemAssistant from '../assets/hit-toast/hit-emblem-assistant.png';
import emblemSkill from '../assets/hit-toast/hit-emblem-skill.png';
import emblemPrompt from '../assets/hit-toast/hit-emblem-prompt.png';

const DISMISS_KEY = 'tokenbank.resourceHitToast.dismissed';
/** 淡入 → 停留 → 自动淡出 */
const FADE_IN_MS = 480;
const HOLD_MS = 5600;
const FADE_OUT_MS = 900;
/** 文件轮询间隔（秒） */
const POLL_MS = 800;

/** 按资源类型：徽记 + 入场动画 + 氛围色 */
const HIT_FX = {
  assistant: {
    emblem: emblemAssistant,
    enter: 'tb-hit-enter-stamp',
    accent: 'tb-hit-accent-assistant',
    emblemFx: 'tb-hit-emblem-stamp',
    titleKey: 'resources.hitToast.title.assistant',
  },
  skill: {
    emblem: emblemSkill,
    enter: 'tb-hit-enter-slash',
    accent: 'tb-hit-accent-skill',
    emblemFx: 'tb-hit-emblem-slash',
    titleKey: 'resources.hitToast.title.skill',
  },
  prompt: {
    emblem: emblemPrompt,
    enter: 'tb-hit-enter-ink',
    accent: 'tb-hit-accent-prompt',
    emblemFx: 'tb-hit-emblem-ink',
    titleKey: 'resources.hitToast.title.prompt',
  },
};

function resolveHitFx(type) {
  // agent 为未完成改名残留；统一走武将盖章特效
  const key = type === 'agent' ? 'assistant' : type;
  return HIT_FX[key] || {
    emblem: emblemSkill,
    enter: 'tb-hit-enter',
    accent: 'tb-hit-accent-skill',
    emblemFx: 'tb-hit-emblem-slash',
    titleKey: 'resources.hitToast.title',
  };
}

function isDismissed() {
  try { return localStorage.getItem(DISMISS_KEY) === '1'; } catch { return false; }
}

/**
 * 点将/取用命中：IPC + CustomEvent + 文件轮询三路收事件，保证息票能出。
 */
export default function ResourceHitToast() {
  const { t } = useLang();
  const [toast, setToast] = useState(null);
  const [hidden, setHidden] = useState(() => isDismissed());
  const [leaving, setLeaving] = useState(false);
  const leaveTimerRef = useRef(0);
  const lastSeenTsRef = useRef(0);

  const clearLeaveTimers = useCallback(() => {
    if (leaveTimerRef.current) {
      window.clearTimeout(leaveTimerRef.current);
      leaveTimerRef.current = 0;
    }
  }, []);

  const finishHide = useCallback(() => {
    setToast(null);
    setLeaving(false);
  }, []);

  /** 开始淡出，结束后卸掉节点 */
  const startFadeOut = useCallback((forever = false) => {
    if (forever) {
      try { localStorage.setItem(DISMISS_KEY, '1'); } catch { /* ignore */ }
      setHidden(true);
    }
    setLeaving(true);
    clearLeaveTimers();
    leaveTimerRef.current = window.setTimeout(finishHide, FADE_OUT_MS);
  }, [clearLeaveTimers, finishHide]);

  /** 统一入队一条命中（去重：同 ts 不重复播） */
  const showHit = useCallback((evt) => {
    if (!evt?.id) return;
    if (isDismissed()) return;
    const ts = Number(evt.ts || evt.at || Date.now()) || Date.now();
    if (ts && ts <= lastSeenTsRef.current) return;
    lastSeenTsRef.current = ts;
    clearLeaveTimers();
    setHidden(false);
    setLeaving(false);
    setToast({
      id: evt.id,
      name: evt.displayName || evt.name || evt.id,
      type: evt.type === 'agent' ? 'assistant' : (evt.type || ''),
      useCount: Number(evt.useCount || 0) || 0,
      clientId: evt.clientId || '',
      at: Date.now(),
    });
  }, [clearLeaveTimers]);

  // ① preload IPC
  useEffect(() => {
    if (!isElectron()) return undefined;
    const api = window.electronAPI?.resource;
    const subscribe = api?.onHit || api?.onResourceHit;
    if (typeof subscribe !== 'function') return undefined;
    return subscribe((evt) => showHit(evt));
  }, [showHit]);

  // ② 主进程 executeJavaScript 注入的 CustomEvent
  useEffect(() => {
    const onCustom = (e) => showHit(e?.detail || {});
    window.addEventListener('tb-resource-hit', onCustom);
    return () => window.removeEventListener('tb-resource-hit', onCustom);
  }, [showHit]);

  // ③ 轮询 latest 文件（MCP 写盘成功但 IPC 未达时兜底）
  useEffect(() => {
    if (!isElectron() || typeof window.electronAPI?.resource?.pollHit !== 'function') {
      return undefined;
    }
    let ready = false;
    const tick = async () => {
      try {
        const evt = await window.electronAPI.resource.pollHit();
        if (!evt?.id) return;
        const ts = Number(evt.ts || 0) || 0;
        // 首次只同步水位，避免把历史命中当成新召唤
        if (!ready) {
          lastSeenTsRef.current = Math.max(lastSeenTsRef.current, ts, Date.now() - 2000);
          ready = true;
          return;
        }
        showHit(evt);
      } catch { /* ignore */ }
    };
    tick();
    const id = window.setInterval(tick, POLL_MS);
    return () => window.clearInterval(id);
  }, [showHit]);

  // 自动：淡入后停留，再自动淡出
  useEffect(() => {
    if (!toast) return undefined;
    clearLeaveTimers();
    const autoOut = window.setTimeout(() => startFadeOut(false), FADE_IN_MS + HOLD_MS);
    return () => window.clearTimeout(autoOut);
  }, [toast?.at, clearLeaveTimers, startFadeOut]);

  useEffect(() => () => clearLeaveTimers(), [clearLeaveTimers]);

  if (hidden || !toast) return null;

  const fx = resolveHitFx(toast.type);
  const typeLabelKey = toast.type ? `resources.type.${toast.type}` : '';
  const typeLabel = typeLabelKey ? t(typeLabelKey) : '';

  return (
    <div
      key={toast.at}
      className={`fixed inset-0 z-[99999] flex items-center justify-center pointer-events-none px-4 ${fx.accent} ${
        leaving ? 'tb-hit-root-leave' : 'tb-hit-root-enter'
      }`}
      aria-live="polite"
    >
      <div className="absolute inset-0 tb-hit-scrim-tint" aria-hidden />
      {!leaving && (
        <div className="tb-hit-burst" aria-hidden>
          <span className="tb-hit-burst-ring tb-hit-burst-ring-a" />
          <span className="tb-hit-burst-ring tb-hit-burst-ring-b" />
          <span className="tb-hit-burst-flash" />
          <span className="tb-hit-burst-ray tb-hit-burst-ray-1" />
          <span className="tb-hit-burst-ray tb-hit-burst-ray-2" />
          <span className="tb-hit-burst-ray tb-hit-burst-ray-3" />
        </div>
      )}

      <div
        className={`tb-hit-toast pointer-events-auto relative w-full max-w-md rounded-2xl px-5 py-5 bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-700 ${
          leaving ? '' : fx.enter
        }`}
        role="status"
      >
        {!leaving && <span className="tb-hit-fx-layer" aria-hidden />}

        <div className="relative flex gap-4 items-center">
          <div className={`tb-hit-emblem ${leaving ? '' : fx.emblemFx} shrink-0 relative`}>
            <img
              src={fx.emblem}
              alt=""
              className="w-[4.5rem] h-[4.5rem] object-contain select-none drop-shadow-md"
              draggable={false}
            />
          </div>
          <div className="min-w-0 flex-1">
            {typeLabel && typeLabel !== typeLabelKey && (
              <p className="tb-hit-type-chip text-[11px] font-semibold tracking-wide mb-1">
                {typeLabel}
              </p>
            )}
            <p className="text-[16px] font-semibold tracking-tight text-zinc-900 dark:text-zinc-50 leading-snug">
              {t(fx.titleKey, { name: toast.name, type: typeLabel })}
            </p>
            <p className="mt-1.5 text-[12px] text-zinc-500 dark:text-zinc-400 tabular-nums">
              {t('resources.hitToast.detail', {
                n: toast.useCount,
                client: toast.clientId || '—',
              })}
            </p>
          </div>
        </div>

        <div className="relative mt-4 flex gap-2 electron-no-drag">
          <button
            type="button"
            onClick={() => startFadeOut(false)}
            className="tb-press text-[12px] font-medium px-3.5 py-1.5 rounded-lg bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-900"
          >
            {t('resources.hitToast.dismiss')}
          </button>
          <button
            type="button"
            onClick={() => startFadeOut(true)}
            className="tb-press text-[12px] px-2.5 py-1.5 rounded-lg text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-200"
          >
            {t('resources.hitToast.disable')}
          </button>
        </div>
      </div>
    </div>
  );
}
