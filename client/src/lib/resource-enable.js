/**
 * 启用包：纳管后默认投射 + 生成点将口令（反笔记「藏而不用」）
 */

/** 默认可写主公优先序 */
export const DEFAULT_LORD_IDS = ['cursor', 'claude-code', 'codex', 'workbuddy'];

/** 生成点将/取兵器口令 */
export function buildInvokeText(resource, lang = 'zh') {
  const name = resource?.display_name || resource?.name || '';
  const type = resource?.type || '';
  if (!name) return '';
  if (lang === 'en') {
    if (type === 'assistant') {
      return `Use the "${name}" agent from Token Bank for this task. Call tb_list_resources(type=assistant) then tb_get_resource to load its playbook, then follow it in this session.`;
    }
    if (type === 'prompt') {
      return `Use the "${name}" prompt from Token Bank (tb_get_prompt) for this task.`;
    }
    return `Use the "${name}" skill from Token Bank for this task.`;
  }
  if (type === 'assistant') {
    return `用「${name}」智能体处理当前任务。先 tb_list_resources(type=assistant) 再 tb_get_resource 取回出战正文，在本会话按正文执行。`;
  }
  if (type === 'prompt') {
    return `使用 Token Bank 提示词「${name}」完成当前任务（tb_get_prompt）。`;
  }
  return `按 Token Bank 技能「${name}」完成本任务。`;
}

/**
 * 纳管成功后：投射到可用主公，返回口令与投射结果
 * @returns {{ agentIds: string[], invokeText: string, projected: boolean }}
 */
export async function completeEnablePackage(resource, { lang = 'zh' } = {}) {
  if (!resource?.id || !window.electronAPI?.resource?.project) {
    return { agentIds: [], invokeText: buildInvokeText(resource, lang), projected: false };
  }

  let candidates = [...DEFAULT_LORD_IDS];
  try {
    const res = await window.electronAPI.resource.listAgentTargets();
    const targets = (res && (res.agents || res.targets || res.items)) || [];
    const ids = targets
      .map((a) => a.id || a.agentId || a.agent_id)
      .filter(Boolean);
    if (ids.length) {
      const preferred = DEFAULT_LORD_IDS.filter((id) => ids.includes(id));
      candidates = preferred.length ? preferred : ids.slice(0, 4);
    }
  } catch {
    /* 用默认优先序 */
  }

  // 已有投射则不再强行改
  const existing = (resource.projections || [])
    .map((p) => p.agentId || p.agent_id)
    .filter(Boolean);
  const need = candidates.filter((id) => !existing.includes(id));
  let projected = existing.length > 0;
  let usedIds = existing.slice();

  if (need.length) {
    try {
      const proj = await window.electronAPI.resource.project({
        resourceId: resource.id,
        agentIds: need,
      });
      if (proj && proj.success) {
        projected = true;
        usedIds = [...new Set([...existing, ...need])];
      }
    } catch {
      /* 投射失败仍返回口令，便于用户手动投 */
    }
  }

  return {
    agentIds: usedIds,
    invokeText: buildInvokeText(resource, lang),
    projected,
  };
}

export async function copyText(text) {
  const s = String(text || '');
  if (!s) return false;
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(s);
      return true;
    }
  } catch { /* ignore */ }
  return false;
}
