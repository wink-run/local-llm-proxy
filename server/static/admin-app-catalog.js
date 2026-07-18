/** Admin 应用实体 — handler + 用户可选能力 */
window.initAppCatalogAdmin = function (api, lang, ref) {
  const acEntities = ref([])
  const acHandlers = ref([])
  const acVarSchema = ref({})
  const acCapabilityCatalog = ref({})
  const acMsg = ref('')
  const acSaving = ref(false)
  const acModalOpen = ref(false)
  const acEditId = ref(null)
  const acForm = ref(emptyEntityForm())

  const CAP_KEYS = ['gateway_proxy', 'session_trace', 'session_usage_import', 'resource_project']

  function emptyCapabilities() {
    return {
      gateway_proxy: false,
      session_trace: false,
      session_usage_import: false,
      resource_project: false,
    }
  }

  function emptyEntityForm() {
    return {
      sort_order: '', id: '', name: '', icon: '🔧', handler: '',
      capabilities: emptyCapabilities(), route_multi_select: false,
    }
  }

  const acSorted = () => [...(acEntities.value || [])].sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0))

  function handlerMeta(hid) {
    return (acHandlers.value || []).find(h => h.id === hid) || {}
  }

  /** handler 能力项（全部可勾选，由运营自主决定） */
  function selectedHandlerCapabilities() {
    const h = handlerMeta(acForm.value.handler)
    const chosen = acForm.value.capabilities || {}
    const catalog = acCapabilityCatalog.value || {}
    return CAP_KEYS.map(id => {
      const meta = catalog[id] || {}
      return {
        id,
        label_zh: meta.label_zh || id,
        label_en: meta.label_en || id,
        supported: true,
        enabled: !!chosen[id],
      }
    })
  }

  function capabilityLabel(item) {
    return lang.value === 'zh' ? (item.label_zh || item.id) : (item.label_en || item.id)
  }

  /** 表格列标题（与编辑弹窗勾选一致） */
  function capColumnTitle(capId) {
    const cat = acCapabilityCatalog.value[capId] || {}
    if (lang.value === 'zh') {
      if (capId === 'gateway_proxy') return '网关路由代理'
      if (capId === 'session_trace') return '会话 trace'
      if (capId === 'session_usage_import') return '用量导入'
      if (capId === 'resource_project') return '可投射智能体'
      return cat.label_zh || capId
    }
    if (capId === 'gateway_proxy') return 'Gateway proxy'
    if (capId === 'session_trace') return 'Session trace'
    if (capId === 'session_usage_import') return 'Usage import'
    if (capId === 'resource_project') return 'Project assistants'
    return cat.label_en || capId
  }

  /**
   * 能力展示：与服务端 resolve_user_capabilities 一致。
   * 旧库 vars.capabilities 可能缺新键（如 resource_project），缺键时回落 handler 默认，
   * 不能直接用 raw vars（否则整列显示「—」）。
   */
  function entityCapabilities(e) {
    const resolved = e?.capabilities && typeof e.capabilities === 'object' ? e.capabilities : null
    const fromVars = e?.vars?.capabilities && typeof e.vars.capabilities === 'object'
      ? e.vars.capabilities : null
    const defs = defaultCapabilitiesForHandler(e?.handler)
    const out = emptyCapabilities()
    for (const k of CAP_KEYS) {
      if (resolved && k in resolved) out[k] = !!resolved[k]
      else if (fromVars && k in fromVars) out[k] = !!fromVars[k]
      else out[k] = !!defs[k]
    }
    return out
  }

  function capEnabled(e, capId) {
    return !!entityCapabilities(e)[capId]
  }

  function capCell(e, capId) {
    return capEnabled(e, capId) ? '✓' : '—'
  }

  function defaultCapabilitiesForHandler(hid) {
    const h = handlerMeta(hid)
    const out = emptyCapabilities()
    if (h.default_capabilities) {
      for (const k of CAP_KEYS) out[k] = !!h.default_capabilities[k]
      return out
    }
    return out
  }

  function onHandlerChange() {
    const f = acForm.value
    const h = handlerMeta(f.handler)
    if (!h.id) return
    if (!f.name) f.name = h.default_name || ''
    if (!f.icon || f.icon === '🔧') f.icon = h.default_icon || '🔧'
    f.capabilities = defaultCapabilitiesForHandler(f.handler)
    if (h.has_patch_route) f.route_multi_select = !!h.default_route_multi_select
    else f.route_multi_select = false
  }

  async function fetchAppCatalog() {
    acMsg.value = ''
    try {
      const r = await api('/admin/apps/catalog')
      if (!r.ok) { acMsg.value = (await r.json().catch(() => ({}))).detail || `HTTP ${r.status}`; return }
      const d = await r.json()
      acEntities.value = d.entities || []
      acHandlers.value = d.handlers || []
      acVarSchema.value = d.var_schema || {}
      acCapabilityCatalog.value = d.capability_catalog || {}
    } catch (e) { acMsg.value = e.message }
  }

  function openAcModal(item) {
    acEditId.value = item ? item.id : null
    if (item) {
      const vars = item.vars || {}
      const caps = item.capabilities || vars.capabilities || {}
      const defs = defaultCapabilitiesForHandler(item.handler)
      const hmeta = handlerMeta(item.handler)
      acForm.value = {
        sort_order: item.sort_order ?? '',
        id: item.id,
        name: item.name || '',
        icon: item.icon || '🔧',
        handler: item.handler || '',
        capabilities: Object.fromEntries(
          CAP_KEYS.map(k => [k, k in caps ? !!caps[k] : !!defs[k]])
        ),
        route_multi_select: 'route_multi_select' in vars
          ? !!vars.route_multi_select
          : !!hmeta.default_route_multi_select,
      }
    } else {
      const max = acEntities.value.reduce((m, s) => Math.max(m, Number(s.sort_order) || 0), 0)
      const first = acHandlers.value[0]
      acForm.value = {
        ...emptyEntityForm(),
        sort_order: max + 10,
        handler: first?.id || '',
        name: first?.default_name || '',
        icon: first?.default_icon || '🔧',
        capabilities: defaultCapabilitiesForHandler(first?.id),
        route_multi_select: !!first?.default_route_multi_select,
      }
    }
    acModalOpen.value = true
  }

  function closeAcModal() { acModalOpen.value = false; acEditId.value = null }

  function buildPayload() {
    const f = acForm.value
    const vars = { capabilities: { ...f.capabilities } }
    if (showRouteMultiSelect()) vars.route_multi_select = !!f.route_multi_select
    return {
      sort_order: f.sort_order !== '' && f.sort_order != null ? Number(f.sort_order) : 0,
      id: (f.id || '').trim(),
      name: (f.name || '').trim(),
      icon: f.icon || '🔧',
      handler: (f.handler || '').trim(),
      vars,
    }
  }

  async function saveAcEntity() {
    const payload = buildPayload()
    if (!payload.id) { acMsg.value = lang.value === 'zh' ? '请填写 ID' : 'ID required'; return }
    if (!payload.handler) { acMsg.value = lang.value === 'zh' ? '请选择 Handler' : 'Handler required'; return }
    const caps = payload.vars.capabilities || {}
    if (!CAP_KEYS.some(k => caps[k])) {
      acMsg.value = lang.value === 'zh' ? '请至少启用一项 Handler 能力' : 'Enable at least one capability'
      return
    }
    acSaving.value = true; acMsg.value = ''
    try {
      const path = acEditId.value
        ? `/admin/apps/catalog/entities/${encodeURIComponent(acEditId.value)}`
        : '/admin/apps/catalog/entities'
      const r = await api(path, {
        method: acEditId.value ? 'PUT' : 'POST',
        body: JSON.stringify({ entity: payload }),
      })
      if (!r.ok) { acMsg.value = (await r.json().catch(() => ({}))).detail || 'Error'; return }
      closeAcModal()
      await fetchAppCatalog()
      acMsg.value = lang.value === 'zh' ? '✓ 已保存' : '✓ Saved'
    } catch (e) { acMsg.value = e.message }
    finally { acSaving.value = false }
  }

  async function deleteAcEntity(item) {
    const tip = lang.value === 'zh' ? `删除 ${item.name || item.id}？` : `Delete ${item.id}?`
    if (!confirm(tip)) return
    try {
      await api(`/admin/apps/catalog/entities/${encodeURIComponent(item.id)}`, { method: 'DELETE' })
      await fetchAppCatalog()
    } catch (e) { acMsg.value = e.message }
  }

  async function importAcDefaults() {
    acSaving.value = true
    try {
      const d = await (await api('/admin/apps/catalog/import-defaults', { method: 'POST' })).json()
      await fetchAppCatalog()
      acMsg.value = lang.value === 'zh' ? `✓ 已导入 ${d.count} 个应用实体` : `✓ Imported ${d.count} entities`
    } catch (e) { acMsg.value = e.message }
    finally { acSaving.value = false }
  }

  async function publishAcCatalog() {
    acSaving.value = true
    try {
      const d = await (await api('/admin/apps/catalog/publish', { method: 'POST' })).json()
      acMsg.value = lang.value === 'zh'
        ? `✓ 已发布 ${d.entities_count} 实体 → app_entities ${d.app_entities_count}`
        : `✓ Published ${d.entities_count} entities → app_entities ${d.app_entities_count}`
    } catch (e) { acMsg.value = e.message }
    finally { acSaving.value = false }
  }

  function handlerLabel(h) {
    return lang.value === 'zh' ? (h.label_zh || h.label) : (h.label || h.id)
  }

  /** handler 声明了 patch_route 时展示「路由写入多选」 */
  function showRouteMultiSelect() {
    const h = handlerMeta(acForm.value.handler)
    return !!h.has_patch_route && !!(acForm.value.capabilities && acForm.value.capabilities.gateway_proxy)
  }

  return {
    acEntities, acHandlers, acVarSchema, acCapabilityCatalog, acMsg, acSaving, acModalOpen, acEditId, acForm,
    acSorted, handlerLabel, handlerMeta, CAP_KEYS,
    capColumnTitle, capEnabled, capCell, capabilityLabel,
    selectedHandlerCapabilities,
    fetchAppCatalog, openAcModal, closeAcModal, saveAcEntity, deleteAcEntity,
    importAcDefaults, publishAcCatalog, onHandlerChange, showRouteMultiSelect,
  }
}
