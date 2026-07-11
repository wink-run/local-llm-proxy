/** Admin 场景路由目录表单 */
window.initRoutingCatalogAdmin = function (api, lang, ref) {
  const rcRoutes = ref([])
  const rcMsg = ref('')
  const rcSaving = ref(false)
  const rcModalOpen = ref(false)
  const rcEditId = ref(null)
  const rcForm = ref(emptyRouteForm())
  // 已移除「全局路由策略」——无全局默认概念

  function emptyRouteForm() {
    return { sort_order: '', id: '', scene_name: '', icon: '🔀', model_key: '', scope: '', tier: '', flow: '', steps: [{ model: '', tier: 'paid' }] }
  }

  const rcSorted = () => [...(rcRoutes.value || [])].sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0))

  async function fetchRoutingCatalog() {
    rcMsg.value = ''
    try {
      const r = await api('/admin/routing/catalog')
      if (!r.ok) { rcMsg.value = (await r.json().catch(() => ({}))).detail || `HTTP ${r.status}`; return }
      const d = await r.json()
      rcRoutes.value = d.routes || []
    } catch (e) { rcMsg.value = e.message }
  }

  function openRcModal(route) {
    rcEditId.value = route ? route.id : null
    if (route) {
      rcForm.value = {
        sort_order: route.sort_order ?? '',
        id: route.id,
        scene_name: route.scene_name || '',
        icon: route.icon || '🔀',
        model_key: route.model_key || '',
        scope: route.scope || '',      // 路由级来源(personal/community)
        tier: route.tier || '',        // 路由级价格(free/paid)
        flow: route.flow || '',        // 流转策略
        steps: (route.steps || []).map(s => ({ model: s.model || '', tier: s.tier || 'paid' })),
        _orig: route,                  // 保留高级字段(rules/classifier/caveman/步内 scope/strategy/sharer/when)不丢
      }
      if (!rcForm.value.steps.length) rcForm.value.steps.push({ model: '', tier: 'paid' })
    } else {
      const max = rcRoutes.value.reduce((m, s) => Math.max(m, Number(s.sort_order) || 0), 0)
      rcForm.value = { ...emptyRouteForm(), sort_order: max + 1 }
    }
    rcModalOpen.value = true
  }

  function closeRcModal() { rcModalOpen.value = false; rcEditId.value = null }

  function rcAddStep() { rcForm.value.steps.push({ model: '', tier: 'paid' }) }
  function rcRemoveStep(i) { rcForm.value.steps.splice(i, 1) }

  function buildRoutePayload() {
    const f = rcForm.value
    const orig = f._orig || {}
    const origSteps = Array.isArray(orig.steps) ? orig.steps : []
    // 表单只编辑 model/tier；按 index 合并回原步骤的高级字段(scope/strategy/provider/sharer/when)不丢
    const steps = (f.steps || []).filter(s => s.model?.trim()).map((s, i) => {
      const os = origSteps[i]
      const adv = (os && os.model === s.model.trim()) ? {
        ...(os.scope ? { scope: os.scope } : {}),
        ...(os.strategy ? { strategy: os.strategy } : {}),
        ...(os.provider ? { provider: os.provider } : {}),
        ...(os.sharer ? { sharer: os.sharer } : {}),
        ...(os.when ? { when: os.when } : {}),
      } : {}
      return { model: s.model.trim(), tier: s.tier || 'paid', ...adv }
    })
    const payload = {
      sort_order: f.sort_order !== '' && f.sort_order != null ? Number(f.sort_order) : 0,
      id: (f.id || '').trim(),
      scene_name: (f.scene_name || '').trim(),
      icon: f.icon || '🔀',
      model_key: (f.model_key || '').trim(),
      steps,
    }
    // 路由级来源/价格/流转（与客户端一致）
    if (f.scope) payload.scope = f.scope
    if (f.tier) payload.tier = f.tier
    if (f.flow) payload.flow = f.flow
    // 保留高级路由字段（不在表单里，但编辑时不丢）
    if (orig.rules) payload.rules = orig.rules
    if (orig.classifier) payload.classifier = orig.classifier
    if (orig.caveman_level) payload.caveman_level = orig.caveman_level
    return payload
  }

  async function saveRcRoute() {
    const payload = buildRoutePayload()
    if (!payload.id) { rcMsg.value = lang.value === 'zh' ? '请填写 ID' : 'ID required'; return }
    if (!payload.model_key) { rcMsg.value = lang.value === 'zh' ? '请填写 model_key' : 'model_key required'; return }
    rcSaving.value = true; rcMsg.value = ''
    try {
      const path = rcEditId.value
        ? `/admin/routing/catalog/routes/${encodeURIComponent(rcEditId.value)}`
        : '/admin/routing/catalog/routes'
      const r = await api(path, {
        method: rcEditId.value ? 'PUT' : 'POST',
        body: JSON.stringify({ route: payload }),
      })
      if (!r.ok) { rcMsg.value = (await r.json().catch(() => ({}))).detail || 'Error'; return }
      closeRcModal()
      await fetchRoutingCatalog()
      rcMsg.value = lang.value === 'zh' ? '✓ 已保存' : '✓ Saved'
    } catch (e) { rcMsg.value = e.message }
    finally { rcSaving.value = false }
  }

  async function deleteRcRoute(route) {
    const tip = lang.value === 'zh' ? `删除路由 ${route.scene_name}？` : `Delete route ${route.id}?`
    if (!confirm(tip)) return
    try {
      await api(`/admin/routing/catalog/routes/${encodeURIComponent(route.id)}`, { method: 'DELETE' })
      await fetchRoutingCatalog()
    } catch (e) { rcMsg.value = e.message }
  }

  async function importRcDefaults() {
    rcSaving.value = true
    try {
      const d = await (await api('/admin/routing/catalog/import-defaults', { method: 'POST' })).json()
      await fetchRoutingCatalog()
      rcMsg.value = lang.value === 'zh' ? `✓ 已导入 ${d.count} 条路由` : `✓ Imported ${d.count} routes`
    } catch (e) { rcMsg.value = e.message }
    finally { rcSaving.value = false }
  }

  async function publishRcCatalog() {
    rcSaving.value = true
    try {
      const d = await (await api('/admin/routing/catalog/publish', { method: 'POST' })).json()
      rcMsg.value = lang.value === 'zh'
        ? `✓ 已发布 ${d.routes_count} 条路由 → config.scenes (${d.scenes_bytes}B)`
        : `✓ Published ${d.routes_count} routes`
    } catch (e) { rcMsg.value = e.message }
    finally { rcSaving.value = false }
  }

  return {
    rcRoutes, rcMsg, rcSaving, rcModalOpen, rcEditId, rcForm, rcSorted,
    fetchRoutingCatalog, openRcModal, closeRcModal, saveRcRoute, deleteRcRoute,
    rcAddStep, rcRemoveStep, importRcDefaults, publishRcCatalog,
  }
}
