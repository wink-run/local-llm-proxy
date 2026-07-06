/** Admin 场景路由目录表单 */
window.initRoutingCatalogAdmin = function (api, lang, ref) {
  const rcRoutes = ref([])
  const rcMsg = ref('')
  const rcSaving = ref(false)
  const rcModalOpen = ref(false)
  const rcEditId = ref(null)
  const rcForm = ref(emptyRouteForm())
  const rcDefaultStrategy = ref('')      // 全局默认路由策略（空=客户端回落 cost）
  const rcStrategies = ref([])           // 可选策略名（服务端下发）
  const rcStrategiesMeta = ref([])       // 策略目录：[{name,label_zh/en,description_zh/en}]，来自 routing-strategies.yaml

  const _strategyMeta = (s) => (rcStrategiesMeta.value || []).find(x => x.name === s) || null
  const strategyLabel = (s) => { const m = _strategyMeta(s); return m ? ((lang.value === 'zh' ? m.label_zh : m.label_en) || s) : s }
  const strategyDesc = (s) => { const m = _strategyMeta(s); return m ? ((lang.value === 'zh' ? m.description_zh : m.description_en) || '') : '' }

  async function saveRcStrategy() {
    rcMsg.value = ''
    try {
      const r = await api('/admin/routing/catalog/settings', {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ default_strategy: rcDefaultStrategy.value || null }),
      })
      if (!r.ok) { rcMsg.value = (await r.json().catch(() => ({}))).detail || `HTTP ${r.status}`; return }
      rcMsg.value = lang.value === 'zh' ? '✓ 已保存（发布后下发客户端）' : '✓ Saved (publish to deliver)'
    } catch (e) { rcMsg.value = e.message }
  }

  function emptyRouteForm() {
    return { sort_order: '', id: '', scene_name: '', icon: '🔀', model_key: '', steps: [{ model: '', tier: 'paid' }] }
  }

  const rcSorted = () => [...(rcRoutes.value || [])].sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0))

  async function fetchRoutingCatalog() {
    rcMsg.value = ''
    try {
      const r = await api('/admin/routing/catalog')
      if (!r.ok) { rcMsg.value = (await r.json().catch(() => ({}))).detail || `HTTP ${r.status}`; return }
      const d = await r.json()
      rcRoutes.value = d.routes || []
      rcDefaultStrategy.value = d.default_strategy || ''
      rcStrategies.value = d.strategies || []
      rcStrategiesMeta.value = d.strategies_meta || []
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
        steps: (route.steps || []).map(s => ({ model: s.model || '', tier: s.tier || 'paid' })),
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
    return {
      sort_order: f.sort_order !== '' && f.sort_order != null ? Number(f.sort_order) : 0,
      id: (f.id || '').trim(),
      scene_name: (f.scene_name || '').trim(),
      icon: f.icon || '🔀',
      model_key: (f.model_key || '').trim(),
      steps: (f.steps || []).filter(s => s.model?.trim()).map(s => ({
        model: s.model.trim(), tier: s.tier || 'paid',
      })),
    }
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
    rcDefaultStrategy, rcStrategies, rcStrategiesMeta, strategyLabel, strategyDesc, saveRcStrategy,
    fetchRoutingCatalog, openRcModal, closeRcModal, saveRcRoute, deleteRcRoute,
    rcAddStep, rcRemoveStep, importRcDefaults, publishRcCatalog,
  }
}
