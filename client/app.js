const elements = {
  form: document.querySelector('#diagnose-form'),
  home: document.querySelector('#home-input'),
  profile: document.querySelector('#profile-input'),
  profileList: document.querySelector('#profile-list'),
  command: document.querySelector('#command-input'),
  commandArgs: document.querySelector('#command-args'),
  bootArgs: document.querySelector('#boot-args'),
  timeout: document.querySelector('#timeout-input'),
  window: document.querySelector('#window-input'),
  confirmations: document.querySelector('#confirmations-input'),
  maxCandidates: document.querySelector('#max-candidates-input'),
  maxExactRemovals: document.querySelector('#max-exact-removals-input'),
  maxRecoveryProbes: document.querySelector('#max-recovery-probes-input'),
  keepArtifacts: document.querySelector('#keep-artifacts'),
  runtimeAck: document.querySelector('#runtime-ack'),
  start: document.querySelector('#start-button'),
  cancel: document.querySelector('#cancel-button'),
  runState: document.querySelector('#run-state'),
  sonar: document.querySelector('#sonar'),
  scanKicker: document.querySelector('#scan-kicker'),
  scanCount: document.querySelector('#scan-count'),
  scanLabel: document.querySelector('#scan-label'),
  suspectCount: document.querySelector('#suspect-count'),
  probeCount: document.querySelector('#probe-count'),
  currentSize: document.querySelector('#current-size'),
  trace: document.querySelector('#trace-list'),
  findingCard: document.querySelector('#finding-card'),
  findingCode: document.querySelector('#finding-code'),
  findingTitle: document.querySelector('#finding-title'),
  findingSummary: document.querySelector('#finding-summary'),
  bundleList: document.querySelector('#bundle-list'),
  evidence: document.querySelector('#evidence-body'),
  download: document.querySelector('#download-button'),
  recovery: document.querySelector('#recovery-panel'),
  recoverySummary: document.querySelector('#recovery-summary'),
  recoveryPlans: document.querySelector('#recovery-plans'),
  apply: document.querySelector('#apply-button'),
  restore: document.querySelector('#restore-button'),
  warnings: document.querySelector('#warning-list'),
  dialog: document.querySelector('#confirm-dialog'),
  dialogBundles: document.querySelector('#dialog-bundles'),
  confirmApply: document.querySelector('#confirm-apply'),
  recentReports: document.querySelector('#recent-reports'),
  toast: document.querySelector('#toast'),
}

const state = { token: '', job: null, pollTimer: null, toastTimer: null, selectedPlanId: null }

function lines(value) {
  return value.split(/\r?\n/).map(item => item.trim()).filter(Boolean)
}

function showToast(message) {
  clearTimeout(state.toastTimer)
  elements.toast.textContent = message
  elements.toast.hidden = false
  state.toastTimer = setTimeout(() => { elements.toast.hidden = true }, 5_000)
}

async function api(path, options = {}) {
  const headers = { ...(options.headers ?? {}) }
  if (options.method === 'POST') {
    headers['Content-Type'] = 'application/json'
    headers['X-Lifeboat-Token'] = state.token
  }
  const response = await fetch(path, { ...options, headers })
  const body = await response.json()
  if (!response.ok) {
    const error = new Error(body.error || `Request failed with ${response.status}`)
    error.status = response.status
    throw error
  }
  return body
}

function setProfiles(profiles) {
  elements.profileList.replaceChildren(...profiles.map(profile => {
    const option = document.createElement('option')
    option.value = profile
    return option
  }))
  if (profiles.length > 0 && !profiles.includes(elements.profile.value)) elements.profile.value = profiles[0]
}

function updateMode() {
  const boot = elements.form.elements.mode.value === 'boot'
  document.querySelectorAll('.boot-only').forEach(element => { element.hidden = !boot })
  elements.timeout.value = boot ? '20000' : '60000'
  elements.maxRecoveryProbes.value = boot ? '64' : '256'
}

function statusLabel(status) {
  return ({ queued: '等待执行', running: '正在隔离', completed: '诊断完成', failed: '诊断失败', cancelled: '已停止' })[status] ?? status
}

function traceItem(event) {
  const item = document.createElement('li')
  const dot = document.createElement('span')
  const label = document.createElement('p')
  const meta = document.createElement('small')
  if (event.type === 'probe-started') {
    label.textContent = event.label
    meta.textContent = `${event.bundles.length} bundle`
    item.dataset.status = 'running'
  } else if (event.type === 'probe-finished') {
    label.textContent = event.label
    meta.textContent = `${event.status} · ${event.reason}`
    item.dataset.status = event.status
  } else if (event.type === 'diagnosis-finished') {
    label.textContent = event.finding?.title ?? '诊断结束'
    meta.textContent = 'finding'
    item.dataset.status = 'pass'
  } else {
    label.textContent = event.error || event.type.replaceAll('-', ' ')
    meta.textContent = ''
  }
  item.append(dot, label, meta)
  return item
}

function emptyTraceItem() {
  const item = document.createElement('li')
  const dot = document.createElement('span')
  const message = document.createElement('p')
  item.className = 'empty-trace'
  message.textContent = '这个诊断还没有探测事件。'
  item.append(dot, message)
  return item
}

function renderTrace(events = []) {
  const relevant = events.filter(event => ['probe-started', 'probe-finished', 'diagnosis-finished', 'diagnosis-failed'].includes(event.type)).slice(-9)
  elements.trace.replaceChildren(...(relevant.length > 0 ? relevant.map(traceItem) : [emptyTraceItem()]))
}

function emptyEvidenceRow() {
  const row = document.createElement('tr')
  const cell = document.createElement('td')
  cell.colSpan = 3
  cell.className = 'table-empty'
  cell.textContent = '暂无探测记录'
  row.append(cell)
  return row
}

function renderEvidence(probes = []) {
  elements.evidence.replaceChildren(...(probes.length > 0 ? probes.map(probe => {
    const row = document.createElement('tr')
    const label = document.createElement('td')
    const size = document.createElement('td')
    const result = document.createElement('td')
    const tag = document.createElement('span')
    label.textContent = probe.label
    size.textContent = String(probe.bundles.length)
    tag.className = `result-tag ${probe.status}`
    tag.textContent = probe.status
    result.append(tag)
    row.append(label, size, result)
    return row
  }) : [emptyEvidenceRow()]))
}

function availableRecoveryPlans(recovery) {
  if (Array.isArray(recovery?.plans) && recovery.plans.length > 0) return recovery.plans
  if (recovery?.bundles?.length) {
    return [{
      id: recovery.selectedPlanId ?? 'legacy-recovery',
      bundles: recovery.bundles,
      optimality: 'verified',
    }]
  }
  return []
}

function renderRecovery(recovery) {
  const plans = availableRecoveryPlans(recovery)
  if (!plans.some(plan => plan.id === state.selectedPlanId)) {
    const preferred = plans.find(plan => plan.id === recovery?.selectedPlanId)
    state.selectedPlanId = preferred?.id ?? plans[0]?.id ?? null
  }
  elements.recoverySummary.textContent = plans.length > 1
    ? `找到 ${plans.length} 个相同删除数量的恢复方案；选择希望保留另一侧插件的方案。`
    : '该方案已经在全新临时 Home 中使用完整 Profile 独立复验通过。'
  elements.recoveryPlans.replaceChildren(...plans.map((plan, index) => {
    const label = document.createElement('label')
    const radio = document.createElement('input')
    const content = document.createElement('span')
    const title = document.createElement('strong')
    const detail = document.createElement('small')
    const badge = document.createElement('span')
    label.className = 'recovery-plan'
    radio.type = 'radio'
    radio.name = 'recovery-plan'
    radio.value = plan.id
    radio.checked = plan.id === state.selectedPlanId
    radio.disabled = Boolean(state.job?.recoveryApplied)
    radio.setAttribute('aria-label', `停用 ${plan.bundles.join('、')}`)
    radio.addEventListener('change', () => { state.selectedPlanId = plan.id })
    title.textContent = `停用 ${plan.bundles.join('、')}`
    detail.textContent = plan.verificationProbeId
      ? `完整 Profile 复验：${plan.verificationProbeId}`
      : '兼容旧版已验证恢复报告'
    badge.className = 'recovery-plan-badge'
    badge.textContent = plan.optimality === 'exact'
      ? '精确最小'
      : plan.optimality === 'one-minimal' ? '不可再缩减' : '已验证'
    content.append(title, detail)
    label.append(radio, content, badge)
    label.dataset.index = String(index)
    return label
  }))
  elements.apply.disabled = plans.length === 0 || Boolean(state.job?.recoveryApplied)
}

function renderFinding(report) {
  elements.findingCode.textContent = 'NOT RUN'
  elements.findingTitle.textContent = '还没有证据'
  elements.findingSummary.textContent = '运行一次隔离诊断后，这里会说明问题来自 Bundle、用户 Patch，还是基础环境。'
  elements.findingCard.dataset.kind = 'empty'
  elements.bundleList.replaceChildren()
  elements.download.disabled = true
  elements.recovery.hidden = true
  elements.recoveryPlans.replaceChildren()
  elements.apply.disabled = true
  elements.apply.textContent = '应用所选恢复方案'
  elements.restore.hidden = true
  elements.restore.disabled = false
  elements.restore.textContent = '撤销本次恢复'
  elements.warnings.hidden = true
  elements.warnings.replaceChildren()
  const finding = report?.finding
  if (!finding) return
  elements.findingCode.textContent = finding.code.toUpperCase().replaceAll('-', ' / ')
  elements.findingTitle.textContent = finding.title
  elements.findingSummary.textContent = finding.summary
  elements.bundleList.replaceChildren(...(finding.bundles ?? []).map(bundle => {
    const chip = document.createElement('span')
    chip.className = 'bundle-chip'
    chip.textContent = bundle
    return chip
  }))
  elements.findingCard.dataset.kind = finding.code === 'healthy'
    ? 'healthy'
    : report.recovery ? 'recovery' : 'failure'
  elements.recovery.hidden = !report.recovery
  if (report.recovery) renderRecovery(report.recovery)
  elements.download.disabled = false
  if (report.warnings?.length) {
    elements.warnings.hidden = false
    elements.warnings.replaceChildren(...report.warnings.map(warning => {
      const line = document.createElement('div')
      line.textContent = `• ${warning}`
      return line
    }))
  }
}

function renderJobError(error) {
  if (!error) return
  elements.findingCode.textContent = 'JOB / FAILED'
  elements.findingTitle.textContent = '诊断没有完成'
  elements.findingSummary.textContent = error
  elements.findingCard.dataset.kind = 'failure'
}

function formatReportTime(report) {
  const value = report.savedAt ?? report.finishedAt ?? report.createdAt
  const timestamp = Date.parse(value)
  return Number.isFinite(timestamp)
    ? new Intl.DateTimeFormat('zh-CN', { dateStyle: 'short', timeStyle: 'short' }).format(timestamp)
    : '时间未知'
}

function renderRecentReports(reports = []) {
  if (reports.length === 0) {
    const empty = document.createElement('p')
    empty.className = 'recent-empty'
    empty.textContent = '还没有保存的诊断。'
    elements.recentReports.replaceChildren(empty)
    return
  }
  elements.recentReports.replaceChildren(...reports.slice(0, 10).map(report => {
    const button = document.createElement('button')
    const heading = document.createElement('span')
    const title = document.createElement('strong')
    const status = document.createElement('small')
    const meta = document.createElement('span')
    button.type = 'button'
    button.className = 'recent-report'
    title.textContent = report.finding?.title ?? statusLabel(report.status)
    status.textContent = report.recoveryPending ? '可撤销恢复' : statusLabel(report.status)
    meta.textContent = `${report.profile ?? '未知 Profile'} · ${formatReportTime(report)}`
    heading.append(title, status)
    button.append(heading, meta)
    button.addEventListener('click', async () => {
      button.disabled = true
      await pollJob(report.id)
      button.disabled = false
    })
    return button
  }))
}

async function refreshRecentReports() {
  const value = await api('/api/reports')
  renderRecentReports(value.reports)
}

function renderJob(job) {
  state.job = job
  sessionStorage.setItem('dsh-lifeboat-active-job', job.id)
  state.selectedPlanId = job.recoveryApplied?.planId ?? null
  const running = ['queued', 'running'].includes(job.status)
  elements.start.disabled = running
  elements.cancel.hidden = !running
  elements.runState.textContent = job.status === 'queued' && job.queuePosition
    ? `${statusLabel(job.status)} · ${job.queuePosition}`
    : statusLabel(job.status)
  elements.runState.dataset.state = job.status
  elements.sonar.dataset.state = job.status
  const report = job.report
  const probes = report?.probes ?? []
  const events = Array.isArray(job.events) ? job.events : []
  const started = [...events].reverse().find(event => event.type === 'probe-started')
  elements.probeCount.textContent = String(probes.length)
  elements.scanCount.textContent = String(probes.length)
  elements.scanKicker.textContent = running ? 'ACTIVE PROBES' : job.status.toUpperCase()
  elements.scanLabel.textContent = started?.label ?? report?.finding?.title ?? statusLabel(job.status)
  elements.currentSize.textContent = started ? String(started.bundles.length) : '—'
  elements.suspectCount.textContent = report?.profile?.suspectBundles?.length ?? '—'
  renderTrace(events)
  renderEvidence(probes)
  renderFinding(report)
  if (!report?.finding) renderJobError(job.error)
  if (job.recoveryApplied) {
    elements.apply.disabled = true
    elements.apply.textContent = '已应用所选恢复方案'
    elements.restore.hidden = false
  }
  if (job.recoveryRestored) {
    elements.restore.disabled = true
    elements.restore.textContent = '已撤销本次恢复'
  }
}

async function pollJob(id) {
  clearTimeout(state.pollTimer)
  try {
    const job = await api(`/api/jobs/${id}`)
    renderJob(job)
    if (['queued', 'running'].includes(job.status)) state.pollTimer = setTimeout(() => pollJob(id), 650)
    else await refreshRecentReports()
  } catch (error) {
    if (error.status === 404) sessionStorage.removeItem('dsh-lifeboat-active-job')
    showToast(error.message)
  }
}

async function refreshProfiles() {
  try {
    const value = await api(`/api/profiles?home=${encodeURIComponent(elements.home.value)}`)
    setProfiles(value.profiles)
  } catch (error) {
    showToast(error.message)
  }
}

elements.form.addEventListener('change', event => {
  if (event.target.name === 'mode') updateMode()
})
elements.home.addEventListener('change', refreshProfiles)

elements.form.addEventListener('submit', async event => {
  event.preventDefault()
  elements.start.disabled = true
  state.selectedPlanId = null
  elements.apply.disabled = false
  elements.apply.textContent = '应用所选恢复方案'
  elements.recovery.hidden = true
  elements.restore.hidden = true
  elements.restore.disabled = false
  elements.restore.textContent = '撤销本次恢复'
  elements.warnings.hidden = true
  try {
    const mode = elements.form.elements.mode.value
    if (mode === 'boot' && !elements.runtimeAck.checked) {
      throw new Error('启动探测前，需要确认会执行已安装的插件代码。')
    }
    const job = await api('/api/jobs', {
      method: 'POST',
      body: JSON.stringify({
        home: elements.home.value,
        profile: elements.profile.value,
        mode,
        command: elements.command.value,
        commandArgs: lines(elements.commandArgs.value),
        bootArgs: lines(elements.bootArgs.value),
        timeoutMs: Number(elements.timeout.value),
        successWindowMs: Number(elements.window.value),
        bootConfirmations: Number(elements.confirmations.value),
        maxCandidateBundles: Number(elements.maxCandidates.value),
        maxExactRemovalSize: Number(elements.maxExactRemovals.value),
        maxRecoveryProbes: Number(elements.maxRecoveryProbes.value),
        keepArtifacts: elements.keepArtifacts.checked,
        allowRuntimeCodeExecution: mode === 'boot' && elements.runtimeAck.checked,
      }),
    })
    renderJob(job)
    await pollJob(job.id)
  } catch (error) {
    elements.start.disabled = false
    showToast(error.message)
  }
})

elements.cancel.addEventListener('click', async () => {
  if (!state.job) return
  try {
    await api(`/api/jobs/${state.job.id}/cancel`, { method: 'POST', body: '{}' })
    showToast('正在停止当前探测。')
  } catch (error) { showToast(error.message) }
})

elements.download.addEventListener('click', () => {
  if (!state.job?.report) return
  const blob = new Blob([`${JSON.stringify(state.job.report, null, 2)}\n`], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = `dsh-lifeboat-${state.job.report.options.profile}-${state.job.id}.json`
  link.click()
  URL.revokeObjectURL(url)
})

elements.apply.addEventListener('click', () => {
  const recovery = state.job?.report?.recovery
  const plan = availableRecoveryPlans(recovery).find(candidate => candidate.id === state.selectedPlanId)
  if (!plan) {
    showToast('请先选择一个经过验证的恢复方案。')
    return
  }
  const bundles = plan.bundles
  elements.dialogBundles.replaceChildren(...bundles.map(bundle => {
    const chip = document.createElement('div')
    chip.className = 'bundle-chip'
    chip.textContent = bundle
    return chip
  }))
  elements.dialog.showModal()
})

elements.dialog.addEventListener('close', async () => {
  if (elements.dialog.returnValue !== 'confirm' || !state.job) return
  elements.apply.disabled = true
  try {
    const result = await api(`/api/jobs/${state.job.id}/apply`, {
      method: 'POST',
      body: JSON.stringify({ planId: state.selectedPlanId }),
    })
    showToast(`已创建备份并停用 ${result.disabledBundles.length} 个 Bundle。`)
    await pollJob(state.job.id)
  } catch (error) {
    elements.apply.disabled = false
    showToast(error.message)
  }
})

elements.restore.addEventListener('click', async () => {
  if (!state.job) return
  elements.restore.disabled = true
  try {
    await api(`/api/jobs/${state.job.id}/restore`, { method: 'POST', body: '{}' })
    showToast('已从备份恢复原 Profile manifest。')
    await pollJob(state.job.id)
  } catch (error) {
    elements.restore.disabled = false
    showToast(error.message)
  }
})

async function bootstrap() {
  try {
    const value = await api('/api/bootstrap')
    state.token = value.token
    elements.home.value = value.defaultHome
    setProfiles(value.profiles)
    renderRecentReports(value.recentReports)
    updateMode()
    const activeJob = sessionStorage.getItem('dsh-lifeboat-active-job')
    if (activeJob) await pollJob(activeJob)
  } catch (error) {
    document.querySelector('#server-status').textContent = '本地服务不可用'
    showToast(error.message)
  }
}

void bootstrap()
