/** Admin 个人源目录表单 — 供 admin.html Vue setup 调用 */
window.initBillingSourcesAdmin = function (api, lang, ref) {
  const bsSources = ref([])
  const bsFilter = ref('all') // all | payg | app_sub | api_sub
  const bsMsg = ref('')
  const bsSaving = ref(false)
  const bsModalOpen = ref(false)
  const bsEditId = ref(null)
  const bsForm = ref(emptyForm())

  function emptyForm() {
    return {
      sort_order: '',
      id: '', category: 'payg', label: '', icon: '🔧', tier: 'paid',
      base_url: '', auth: 'api_key', api_format: 'openai', handler: 'openai',
      hint: '', keyless: false, key_prefix: '', signup_url: '', aliases: '',
      enabled_default: false, subscription_to_api: false,
      agent_id: '', source_id: '', plan_provider_id: '',
      oauth_provider: '', oauth_label: '',
      models: [], plans: [],
    }
  }

  const bsFiltered = () => {
    const list = [...(bsSources.value || [])]
    // 仅按序号；相等时保持接口返回顺序（自然顺序）
    list.sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0))
    if (bsFilter.value === 'all') return list
    return list.filter(s => s.category === bsFilter.value)
  }

  const catLabel = (c) => {
    const zh = lang.value === 'zh'
    if (c === 'payg') return zh ? '按量付费' : 'PAYG'
    if (c === 'app_sub') return zh ? 'APP 订阅' : 'App Sub'
    if (c === 'api_sub') return zh ? 'API 订阅' : 'API Sub'
    return c
  }

  async function fetchBillingSources() {
    bsMsg.value = ''
    try {
      const r = await api('/admin/billing/sources')
      if (!r.ok) {
        const d = await r.json().catch(() => ({}))
        bsMsg.value = d.detail || `HTTP ${r.status}`
        bsSources.value = []
        return
      }
      const d = await r.json()
      bsSources.value = d.sources || []
    } catch (e) { bsMsg.value = e.message; bsSources.value = [] }
  }

  function openBsModal(source) {
    bsEditId.value = source ? source.id : null
    if (source) {
      bsForm.value = {
        sort_order: source.sort_order ?? '',
        id: source.id,
        category: source.category || 'payg',
        label: source.label || '',
        icon: source.icon || '🔧',
        tier: source.tier || 'paid',
        base_url: source.base_url || '',
        auth: source.auth || 'api_key',
        api_format: source.api_format || 'openai',
        handler: source.handler || 'openai',
        hint: source.hint || '',
        keyless: !!source.keyless,
        key_prefix: (source.key_prefix || []).join(', '),
        signup_url: source.signup_url || '',
        aliases: (source.aliases || []).join(', '),
        enabled_default: !!source.enabled_default,
        subscription_to_api: !!source.subscription_to_api,
        agent_id: source.agent_id || '',
        source_id: source.source_id || source.id || '',
        plan_provider_id: source.plan_provider_id || '',
        oauth_provider: source.oauth?.provider || '',
        oauth_label: source.oauth?.label || '',
        models: (source.models || []).map(m => ({
          id: m.id, modality: m.modality || 'chat',
          in: m.pricing?.in ?? '', out: m.pricing?.out ?? '',
          cacheRead: m.pricing?.cacheRead ?? '',
          image: m.pricing?.image ?? '',
        })),
        plans: (source.plans || []).map(p => ({
          id: p.id, label: p.label || p.id, monthly_usd: p.monthly_usd ?? '',
        })),
      }
    } else {
      const maxOrder = (bsSources.value || []).reduce((m, s) => Math.max(m, Number(s.sort_order) || 0), 0)
      bsForm.value = { ...emptyForm(), sort_order: maxOrder + 1 }
    }
    bsModalOpen.value = true
  }

  function closeBsModal() { bsModalOpen.value = false; bsEditId.value = null }

  function bsAddModel() {
    bsForm.value.models.push({ id: '', modality: 'chat', in: '', out: '', cacheRead: '', image: '' })
  }
  function bsRemoveModel(i) { bsForm.value.models.splice(i, 1) }
  function bsAddPlan() {
    bsForm.value.plans.push({ id: '', label: '', monthly_usd: '' })
  }
  function bsRemovePlan(i) { bsForm.value.plans.splice(i, 1) }

  function buildPayload() {
    const f = bsForm.value
    const isPayg = f.category === 'payg'
    // 按量付费、API 订阅、可转 API 的 APP 订阅均需保存 base_url 与模型刊例
    const needsModels = isPayg || f.category === 'api_sub'
      || (f.category === 'app_sub' && f.subscription_to_api)
    const models = needsModels ? (f.models || []).filter(m => m.id?.trim()).map(m => {
      const modality = m.modality || 'chat'
      let pricing = {}
      if (modality === 'image') {
        if (m.image !== '' && m.image != null) pricing = { image: Number(m.image) }
      } else {
        pricing = {
          ...(m.in !== '' && m.in != null ? { in: Number(m.in) } : {}),
          ...(m.out !== '' && m.out != null ? { out: Number(m.out) } : {}),
          ...(modality === 'chat' && m.cacheRead !== '' && m.cacheRead != null ? { cacheRead: Number(m.cacheRead) } : {}),
        }
      }
      return { id: m.id.trim(), modality, pricing }
    }) : []
    const plans = (f.plans || []).filter(p => p.id?.trim()).map(p => ({
      id: p.id.trim(),
      label: (p.label || p.id).trim(),
      monthly_usd: p.monthly_usd !== '' && p.monthly_usd != null ? Number(p.monthly_usd) : null,
    }))
    const payload = {
      sort_order: f.sort_order !== '' && f.sort_order != null ? Number(f.sort_order) : 0,
      id: (f.id || '').trim(),
      category: f.category,
      source_id: (f.source_id || f.id || '').trim(),
      label: f.label.trim(),
      icon: f.icon || '🔧',
      tier: f.tier,
      base_url: f.base_url.trim(),
      auth: f.auth,
      api_format: f.api_format,
      handler: f.handler,
      hint: f.hint.trim(),
      keyless: !!f.keyless,
      key_prefix: f.key_prefix.split(',').map(s => s.trim()).filter(Boolean),
      signup_url: f.signup_url.trim(),
      aliases: f.aliases.split(',').map(s => s.trim()).filter(Boolean),
      enabled_default: !!f.enabled_default,
      subscription_to_api: !!f.subscription_to_api,
      agent_id: f.agent_id.trim(),
      plan_provider_id: f.plan_provider_id.trim() || null,
      models, plans,
    }
    if (f.oauth_provider) {
      payload.oauth = { provider: f.oauth_provider.trim(), label: (f.oauth_label || f.oauth_provider).trim() }
      payload.auth = 'oauth'
    }
    return payload
  }

  async function saveBsSource() {
    const payload = buildPayload()
    if (!payload.id) { bsMsg.value = lang.value === 'zh' ? '请填写 ID' : 'ID required'; return }
    bsSaving.value = true; bsMsg.value = ''
    try {
      const path = bsEditId.value
        ? `/admin/billing/sources/${encodeURIComponent(bsEditId.value)}`
        : '/admin/billing/sources'
      const r = await api(path, {
        method: bsEditId.value ? 'PUT' : 'POST',
        body: JSON.stringify({ source: payload }),
      })
      if (!r.ok) { const d = await r.json(); bsMsg.value = d.detail || 'Error'; return }
      closeBsModal()
      await fetchBillingSources()
      bsMsg.value = lang.value === 'zh' ? '✓ 已保存' : '✓ Saved'
    } catch (e) { bsMsg.value = e.message }
    finally { bsSaving.value = false }
  }

  async function deleteBsSource(s) {
    const tip = lang.value === 'zh' ? `删除 ${s.label}？` : `Delete ${s.label}?`
    if (!confirm(tip)) return
    try {
      await api(`/admin/billing/sources/${encodeURIComponent(s.id)}`, { method: 'DELETE' })
      await fetchBillingSources()
    } catch (e) { bsMsg.value = e.message }
  }

  async function importBsLegacy() {
    bsSaving.value = true
    try {
      const r = await api('/admin/billing/sources/import-legacy', { method: 'POST' })
      const d = await r.json()
      if (!r.ok) { bsMsg.value = d.detail || 'Error'; return }
      // 优先用导入响应中的列表，再读库确认
      bsSources.value = d.sources || []
      if (!bsSources.value.length) await fetchBillingSources()
      bsMsg.value = lang.value === 'zh' ? `✓ 已导入 ${d.count} 条` : `✓ Imported ${d.count}`
    } catch (e) { bsMsg.value = e.message }
    finally { bsSaving.value = false }
  }

  async function publishBsSources() {
    bsSaving.value = true
    try {
      const d = await (await api('/admin/billing/sources/publish', { method: 'POST' })).json()
      bsMsg.value = lang.value === 'zh'
        ? `✓ 已发布：${d.sources_count} 源 → config.providers ${d.registry_bytes ?? d.sources_bytes ?? d.apps_bytes}B / ${d.registry_count} 供给源`
        : `✓ Published: ${d.sources_count} sources → config.providers ${d.registry_bytes ?? d.sources_bytes ?? d.apps_bytes}B / ${d.registry_count} providers`
    } catch (e) { bsMsg.value = e.message }
    finally { bsSaving.value = false }
  }

  async function exportBsDefaults() {
    const tip = lang.value === 'zh'
      ? '将当前目录写入 providers.registry.yaml（服务端 + 客户端），确认？'
      : 'Write current catalog to providers.registry.yaml (server + client). Continue?'
    if (!confirm(tip)) return
    bsSaving.value = true; bsMsg.value = ''
    try {
      const r = await api('/admin/billing/export-defaults', { method: 'POST' })
      const d = await r.json()
      if (!r.ok) { bsMsg.value = d.detail || `HTTP ${r.status}`; return }
      const paths = (d.files || []).filter(f => f.ok).map(f => f.path).join(', ')
      const failed = (d.files || []).filter(f => !f.ok)
      bsMsg.value = lang.value === 'zh'
        ? `✓ 已导出 ${d.files_written} 个文件：${paths}${failed.length ? '；失败：' + failed.map(f => f.path).join(', ') : ''}`
        : `✓ Exported ${d.files_written} file(s): ${paths}${failed.length ? '; failed: ' + failed.map(f => f.path).join(', ') : ''}`
    } catch (e) { bsMsg.value = e.message }
    finally { bsSaving.value = false }
  }

  return {
    bsSources, bsFilter, bsMsg, bsSaving, bsModalOpen, bsEditId, bsForm,
    bsFiltered, catLabel,
    fetchBillingSources, openBsModal, closeBsModal,
    bsAddModel, bsRemoveModel, bsAddPlan, bsRemovePlan,
    saveBsSource, deleteBsSource, importBsLegacy, publishBsSources, exportBsDefaults,
  }
}
