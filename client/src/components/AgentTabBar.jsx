// Agent 左侧竖排列表：聚合入口 + 各 Agent；可指定主 Agent（编排层）
// 选中态遵循材料层次：侧栏偏重、Hub 用实心强调色、条目用抬升面（非描边）
import React from 'react';
import { resolveBrandIcon } from '../lib/brandIcons';
import KimiAvatar from './KimiAvatar';
import { useLang } from '../store/lang';

/** 未命中品牌时的文字回退 */
const FALLBACK_ICON = {
  'claude-code': 'CC',
  codex: 'CX',
  cursor: 'CR',
  'kimi-code': 'KM',
  assistant: 'AG',
};

/** 内置 Agent 用品牌 logo；自定义智能体保持文字回退 */
function AgentBrandIcon({ agent, isCustom }) {
  if (isCustom) {
    return <span className="text-[9px] font-mono leading-none text-zinc-500">{FALLBACK_ICON.assistant}</span>;
  }
  // Kimi 用组件渲染（与 @lobehub/icons Kimi.Avatar 同构），避免 img 裂图
  if (/kimi|moonshot/i.test(`${agent.id || ''} ${agent.name || ''}`)) {
    return <KimiAvatar size={14} />;
  }
  const brand = resolveBrandIcon(`${agent.id || ''} ${agent.name || ''}`);
  if (brand) {
    return (
      <img
        src={brand}
        alt=""
        className="w-3.5 h-3.5 object-contain"
        draggable={false}
      />
    );
  }
  return <span className="text-[9px] font-mono leading-none text-zinc-500">{FALLBACK_ICON[agent.id] || 'AG'}</span>;
}

/** 运行中提示：实心绿点（无 ping，避免监控态抢注意力） */
function RunningDot({ label }) {
  return (
    <span className="tb-live-dot" title={label} aria-label={label} />
  );
}

/** 按下即时反馈；颜色变化短、无弹跳 */
const pressCls = 'tb-press';

export default function AgentTabBar({
  agents,
  selectedAgent,
  mainAgentId,
  onSelect,
  onSetMainAgent,
  loading,
  /** Set / 数组：正在执行的 session key（含 __hub__） */
  runningKeys,
}) {
  const { t } = useLang();
  const running = runningKeys instanceof Set
    ? runningKeys
    : new Set(Array.isArray(runningKeys) ? runningKeys : []);
  if (loading) {
    return (
      <aside className="w-44 shrink-0 border-r border-zinc-200/80 dark:border-zinc-800 bg-zinc-100 dark:bg-zinc-950/80 p-2 space-y-1.5 animate-pulse">
        {[1, 2, 3].map(i => (
          <div key={i} className="h-8 w-full bg-zinc-200/80 dark:bg-zinc-800 rounded-lg" />
        ))}
      </aside>
    );
  }

  if (!agents?.length) {
    return (
      <aside className="w-44 shrink-0 border-r border-zinc-200/80 dark:border-zinc-800 bg-zinc-100 dark:bg-zinc-950/80 p-3">
        <p className="text-[11px] leading-relaxed text-zinc-500 dark:text-zinc-400">
          {t('debug.tabs.noAgents')}
        </p>
      </aside>
    );
  }

  const mainAgent = agents.find(a => a.id === mainAgentId && !a.custom && a.type !== 'assistant');
  const hubActive = !selectedAgent;

  return (
    /* 侧栏：偏重材料，与主内容玻璃顶栏分层，避免轻材质叠轻材质 */
    <aside className="w-44 shrink-0 border-r border-zinc-200/80 dark:border-zinc-800 bg-zinc-100 dark:bg-zinc-950/80 flex flex-col min-h-0">
      <div className="shrink-0 px-3 pt-4 pb-2">
        <p className="text-[10px] font-semibold tracking-[0.04em] text-zinc-500 dark:text-zinc-400">
          {t('debug.tabs.agents')}
        </p>
      </div>

      <div className="flex-1 overflow-y-auto px-2 pb-2 space-y-0.5">
        {/* Hub：选中用实心强调色（清晰主入口），闲置仍保持可点可读 */}
        <button
          type="button"
          onClick={() => onSelect(null)}
          className={`
            w-full flex items-center gap-1.5 text-left px-2.5 py-1.5 text-[12px] rounded-lg ${pressCls}
            ${hubActive
              ? 'bg-blue-600 text-white font-medium shadow-sm'
              : 'text-zinc-800 dark:text-zinc-200 font-medium hover:bg-black/[0.05] dark:hover:bg-white/[0.06]'
            }
          `}
        >
          <span className="min-w-0 flex-1 truncate">{t('debug.tabs.hub')}</span>
          {running.has('__hub__') && <RunningDot label={t('debug.tabs.orchestrating')} />}
        </button>
        {mainAgent && hubActive && (
          <p className="px-2.5 pt-1 pb-2 text-[10px] text-zinc-500 dark:text-zinc-400 leading-snug">
            {t('debug.tabs.mainDispatch', { name: mainAgent.name })}
          </p>
        )}

        {/* 分隔用留白+细线，弱化硬分割 */}
        <div className="mx-1.5 my-2.5 border-t border-zinc-200/90 dark:border-zinc-800" />

        {agents.map(agent => {
          const active = selectedAgent?.id === agent.id;
          const isMain = agent.id === mainAgentId && !agent.custom;
          const isCustom = agent.custom || agent.type === 'assistant';
          const isRunning = running.has(agent.id);
          return (
            <div key={agent.id} className="relative group">
              <button
                type="button"
                onClick={() => onSelect(agent)}
                title={
                  isCustom && agent.runtimeName
                    ? (agent.execRuntimeName && agent.execRuntimeName !== agent.runtimeName
                      ? t('debug.tabs.projectExec', { name: agent.runtimeName, exec: agent.execRuntimeName })
                      : t('debug.tabs.projectTo', { name: agent.runtimeName }))
                    : agent.description
                }
                className={`
                  w-full flex items-center gap-1.5 px-2.5 py-1.5 text-[12px] rounded-lg ${pressCls}
                  ${active
                    ? 'bg-white dark:bg-zinc-800 text-zinc-900 dark:text-zinc-100 font-medium shadow-sm'
                    : 'text-zinc-600 dark:text-zinc-400 font-medium hover:bg-black/[0.05] dark:hover:bg-white/[0.06] hover:text-zinc-900 dark:hover:text-zinc-200'
                  }
                `}
              >
                <span className="relative shrink-0 flex items-center justify-center w-3.5 h-3.5">
                  <AgentBrandIcon agent={agent} isCustom={isCustom} />
                </span>
                <span className="min-w-0 flex-1 text-left">
                  <span className="flex items-center gap-1 min-w-0 leading-tight">
                    <span className="truncate">{agent.name}</span>
                    {isMain && (
                      <span className="shrink-0 text-[10px] text-amber-500" title={t('debug.tabs.mainAgent')}>★</span>
                    )}
                  </span>
                  {(isCustom && agent.runtimeName) || (!isCustom && agent.version) ? (
                    <span className={`block text-[10px] font-normal truncate mt-0.5 leading-tight ${
                      active ? 'text-zinc-500 dark:text-zinc-400' : 'text-zinc-400 dark:text-zinc-500'
                    }`}>
                      {isCustom && agent.runtimeName ? `→ ${agent.runtimeName}` : `v${agent.version}`}
                    </span>
                  ) : null}
                </span>
                {isRunning && <RunningDot label={t('debug.tabs.runningNamed', { name: agent.name })} />}
              </button>
              {!isMain && !isCustom && onSetMainAgent && (
                <button
                  type="button"
                  title={t('debug.tabs.setMain', { name: agent.name })}
                  onClick={(e) => {
                    e.stopPropagation();
                    onSetMainAgent(agent);
                  }}
                  className={`absolute top-1.5 right-1.5 w-5 h-5 text-[10px] leading-none rounded-md
                    bg-zinc-50 dark:bg-zinc-900 border border-zinc-200/80 dark:border-zinc-700
                    text-zinc-400 hover:text-amber-500 hover:border-amber-400
                    opacity-0 group-hover:opacity-100 ${pressCls}`}
                >
                  ☆
                </button>
              )}
            </div>
          );
        })}
      </div>

      {/* 底栏：结构区轻提示，无抢戏 */}
      {mainAgent && selectedAgent && (
        <div className="shrink-0 px-3 py-2.5 border-t border-zinc-200/90 dark:border-zinc-800 text-[10px] text-zinc-500 dark:text-zinc-400 leading-snug">
          {t('debug.tabs.mainFooter', { name: mainAgent.name })}
        </div>
      )}
    </aside>
  );
}
