import { randomUUID } from 'node:crypto'
import { classifyBundles, readProfile } from './manifest.js'
import { runProbe, validateProbeTiming } from './probe.js'
import { findRecoveryPlans } from './recovery-search.js'
import { createProbeSnapshot } from './workspace.js'

function abortError() {
  const error = new Error('Diagnosis cancelled.')
  error.name = 'AbortError'
  return error
}

function inconclusiveError(record) {
  const error = new Error(`Probe produced inconsistent results: ${record.label}`)
  error.name = 'InconclusiveProbeError'
  error.record = record
  return error
}

function validateOptions(options) {
  const mode = options.mode ?? 'config'
  if (!['config', 'boot'].includes(mode)) {
    throw new Error('Probe mode must be "config" or "boot".')
  }
  if (mode === 'boot' && options.allowRuntimeCodeExecution !== true) {
    throw new Error('Runtime boot probes execute installed plugin code. Pass allowRuntimeCodeExecution: true to continue.')
  }
  for (const [name, value] of [['commandArgs', options.commandArgs], ['bootArgs', options.bootArgs]]) {
    if (value !== undefined && (!Array.isArray(value) || value.some(item => typeof item !== 'string'))) {
      throw new Error(`${name} must be an array of strings.`)
    }
  }
  if (options.command !== undefined && (typeof options.command !== 'string' || options.command === '')) {
    throw new Error('command must be a non-empty executable name or path.')
  }
  if (options.bootConfirmations !== undefined
    && (!Number.isInteger(options.bootConfirmations) || options.bootConfirmations < 1 || options.bootConfirmations > 5)) {
    throw new Error('bootConfirmations must be an integer between 1 and 5.')
  }
  if (options.maxCandidateBundles !== undefined
    && (!Number.isInteger(options.maxCandidateBundles) || options.maxCandidateBundles < 1 || options.maxCandidateBundles > 512)) {
    throw new Error('maxCandidateBundles must be an integer between 1 and 512.')
  }
  if (options.maxExactRemovalSize !== undefined
    && (!Number.isInteger(options.maxExactRemovalSize) || options.maxExactRemovalSize < 1 || options.maxExactRemovalSize > 8)) {
    throw new Error('maxExactRemovalSize must be an integer between 1 and 8.')
  }
  if (options.maxRecoveryProbes !== undefined
    && (!Number.isInteger(options.maxRecoveryProbes) || options.maxRecoveryProbes < 1 || options.maxRecoveryProbes > 4_096)) {
    throw new Error('maxRecoveryProbes must be an integer between 1 and 4096.')
  }
  return validateProbeTiming({
    mode,
    timeoutMs: options.timeoutMs,
    successWindowMs: options.successWindowMs,
  })
}

function patchFinding(profileOnlyFailed, homeOnlyFailed) {
  if (profileOnlyFailed && homeOnlyFailed) {
    return {
      code: 'both-user-layers',
      title: 'Both user patch layers fail independently',
      summary: 'The profile patch and the Harness-home patch each reproduce the failure without relying on the other.',
    }
  }
  if (profileOnlyFailed) {
    return {
      code: 'profile-patch',
      title: 'Profile patch is the failing layer',
      summary: 'The bundle stack passes when user patches are removed; the profile cordis.patch.yml fails on its own.',
    }
  }
  if (homeOnlyFailed) {
    return {
      code: 'home-patch',
      title: 'Harness-home patch is the failing layer',
      summary: 'The bundle stack passes when user patches are removed; the home-level cordis.patch.yml fails on its own.',
    }
  }
  return {
    code: 'patch-interaction',
    title: 'The two user patch layers conflict',
    summary: 'Each patch layer passes alone, but the profile and home patches fail when composed together.',
  }
}

/** Diagnose one profile entirely through an isolated temporary DSH_HOME. */
export async function diagnoseProfile(options, dependencies = {}) {
  const probeTiming = validateOptions(options)
  const emit = dependencies.emit ?? (() => {})
  const probeRunner = dependencies.probeRunner ?? runProbe
  const profile = await readProfile(options.home, options.profile ?? 'web')
  const { protectedBundles, suspects } = classifyBundles(profile)
  const report = {
    schema: 'dsh-lifeboat/v1',
    id: randomUUID(),
    status: 'running',
    startedAt: new Date().toISOString(),
    finishedAt: undefined,
    options: {
      home: profile.home,
      profile: profile.profile,
      mode: options.mode ?? 'config',
      command: options.command ?? 'dsh',
      commandArgs: options.commandArgs ?? [],
      bootArgs: options.bootArgs ?? [],
      timeoutMs: probeTiming.timeoutMs,
      successWindowMs: probeTiming.mode === 'boot' ? probeTiming.successWindowMs : undefined,
      bootConfirmations: options.mode === 'boot' ? options.bootConfirmations ?? 2 : 1,
      maxCandidateBundles: options.maxCandidateBundles ?? 128,
      maxExactRemovalSize: options.maxExactRemovalSize ?? 2,
      maxRecoveryProbes: options.maxRecoveryProbes ?? (options.mode === 'boot' ? 64 : 256),
      allowRuntimeCodeExecution: options.allowRuntimeCodeExecution === true,
    },
    profile: {
      dir: profile.dir,
      manifestHash: profile.hash,
      bundles: profile.bundles,
      protectedBundles,
      suspectBundles: suspects,
    },
    probes: [],
    warnings: [],
    finding: undefined,
    recovery: undefined,
  }
  emit({ type: 'diagnosis-started', reportId: report.id, profile: profile.profile })
  const warn = message => {
    if (!report.warnings.includes(message)) report.warnings.push(message)
  }
  const maxCandidateBundles = options.maxCandidateBundles ?? 128
  if (suspects.length > maxCandidateBundles) {
    report.status = 'completed'
    report.finishedAt = new Date().toISOString()
    report.finding = {
      code: 'candidate-limit',
      title: 'Candidate set exceeds the automatic isolation limit',
      summary: `This profile has ${suspects.length} candidate bundles; the configured limit is ${maxCandidateBundles}. Raise the limit deliberately or narrow the profile before probing.`,
    }
    emit({ type: 'diagnosis-finished', finding: report.finding })
    return report
  }

  let snapshot
  try {
    snapshot = await createProbeSnapshot(profile, options)
    report.profile.inputFingerprint = snapshot.fingerprint
    for (const warning of snapshot.warnings) warn(warning)
  } catch (error) {
    report.status = 'failed'
    report.finishedAt = new Date().toISOString()
    report.error = error.message
    emit({ type: 'diagnosis-failed', status: report.status, error: error.message })
    throw Object.assign(error, { report })
  }

  const cache = new Map()
  let probeIndex = 0
  const confirmations = options.mode === 'boot' ? options.bootConfirmations ?? 2 : 1

  const compose = selected => {
    const active = new Set([...protectedBundles, ...selected])
    return profile.bundles.filter(bundle => active.has(bundle))
  }

  const probe = async ({ bundles, profilePatch, homePatch, label, force = false }) => {
    if (options.signal?.aborted) throw abortError()
    const key = JSON.stringify([bundles, profilePatch, homePatch, options.mode ?? 'config'])
    const cached = cache.get(key)
    if (cached && !force) {
      emit({ type: 'probe-cache-hit', label, probeId: cached.id })
      return cached
    }
    const id = `probe-${String(++probeIndex).padStart(3, '0')}`
    emit({ type: 'probe-started', id, label, bundles, profilePatch, homePatch })
    const attempts = []
    for (let attempt = 1; attempt <= confirmations; attempt += 1) {
      if (options.signal?.aborted) throw abortError()
      const workspace = await snapshot.createWorkspace()
      for (const warning of workspace.warnings) warn(warning)
      if (options.keepArtifacts) {
        report.artifactPaths ??= []
        report.artifactPaths.push(workspace.root)
      }
      let result
      try {
        await workspace.stage({ bundles, profilePatch, homePatch })
        result = await probeRunner({
          command: options.command ?? 'dsh',
          commandArgs: options.commandArgs ?? [],
          home: workspace.home,
          profile: profile.profile,
          cwd: workspace.profileDir,
          mode: options.mode ?? 'config',
          bootArgs: options.bootArgs ?? [],
          timeoutMs: probeTiming.timeoutMs,
          successWindowMs: probeTiming.successWindowMs,
          signal: options.signal,
        })
      } finally {
        if (!options.keepArtifacts) {
          try {
            await workspace.cleanup()
          } catch (error) {
            warn(`Temporary cleanup failed: ${error.message}`)
          }
        }
      }
      if (result.status === 'cancelled') throw abortError()
      attempts.push({ attempt, ...result })
      if (confirmations > 1) {
        emit({ type: 'probe-attempt-finished', id, label, attempt, status: result.status, reason: result.reason })
      }
    }
    const statuses = new Set(attempts.map(attempt => attempt.status))
    const first = attempts[0]
    const result = attempts.length === 1
      ? first
      : {
          command: first.command,
          args: first.args,
          mode: first.mode,
          status: statuses.size === 1 ? first.status : 'unstable',
          reason: statuses.size === 1 ? `confirmed-${first.status}` : 'inconsistent-results',
          durationMs: attempts.reduce((total, attempt) => total + attempt.durationMs, 0),
          outputTruncated: attempts.some(attempt => attempt.outputTruncated),
          attempts,
        }
    const record = { id, label, bundles: [...bundles], profilePatch, homePatch, ...result }
    if (!force) cache.set(key, record)
    report.probes.push(record)
    emit({ type: 'probe-finished', id, label, status: result.status, reason: result.reason })
    return record
  }

  const fails = result => {
    if (result.status === 'unstable') throw inconclusiveError(result)
    return result.status === 'fail'
  }

  const findVerifiedRecovery = async ({ profilePatch, homePatch, interaction }) => {
    const searchResult = await findRecoveryPlans(
      suspects,
      async removed => {
        const removedSet = new Set(removed)
        const remaining = suspects.filter(bundle => !removedSet.has(bundle))
        const result = await probe({
          bundles: compose(remaining),
          profilePatch,
          homePatch,
          label: `Recovery search: disable ${removed.join(', ') || '(none)'}`,
        })
        return !fails(result)
      },
      {
        allRemovedRecovers: true,
        maxExactRemovalSize: options.maxExactRemovalSize ?? 2,
        maxTests: options.maxRecoveryProbes ?? (options.mode === 'boot' ? 64 : 256),
        onStep: step => emit({ type: 'recovery-search-step', ...step }),
      },
    )

    const plans = []
    for (const plan of searchResult.plans) {
      const removedSet = new Set(plan.bundles)
      const remaining = suspects.filter(bundle => !removedSet.has(bundle))
      const verification = await probe({
        bundles: compose(remaining),
        profilePatch,
        homePatch,
        label: `Recovery verification: disable ${plan.bundles.join(', ')}`,
        force: true,
      })
      if (!fails(verification)) plans.push({ ...plan, verificationProbeId: verification.id })
    }

    if (plans.length === 0) {
      report.finding = {
        code: searchResult.search.exhausted ? 'recovery-search-exhausted' : 'recovery-verification-failed',
        title: searchResult.search.exhausted
          ? 'Recovery search reached its probe budget'
          : 'No recovery plan passed independent verification',
        summary: searchResult.search.exhausted
          ? 'Lifeboat reproduced a bundle-related failure but will not apply an unverified or incompletely minimized removal set. Raise the recovery probe budget or narrow the profile.'
          : 'Candidate removals did not pass a fresh full-profile verification, so Lifeboat will not modify the profile.',
      }
      report.recoverySearch = searchResult.search
      return
    }

    const primary = plans[0]
    const exact = primary.optimality === 'exact'
    report.finding = {
      code: interaction ? 'plugin-patch-interaction' : 'plugin-set',
      title: exact ? 'Minimum-cardinality bundle recovery verified' : 'One-minimal bundle recovery verified',
      summary: interaction
        ? `Disabling ${primary.bundles.join(', ')} made the complete profile pass with both user patch layers enabled.`
        : `Disabling ${primary.bundles.join(', ')} made the complete bundle composition pass without either user patch layer.`,
      bundles: primary.bundles,
    }
    report.recovery = {
      action: 'disable-bundles',
      bundles: primary.bundles,
      selectedPlanId: primary.id,
      plans,
      search: searchResult.search,
      manifestHash: profile.hash,
      inputFingerprintHash: snapshot.fingerprint.hash,
      note: exact
        ? 'Every smaller removal cardinality was tested. Installed dependencies are retained.'
        : 'This verified plan is 1-minimal but may not be the globally smallest removal. Installed dependencies are retained.',
    }
  }

  try {
    const baseline = await probe({
      bundles: profile.bundles,
      profilePatch: true,
      homePatch: true,
      label: 'Original composition',
    })
    report.baselineProbeId = baseline.id
    if (!fails(baseline)) {
      report.finding = {
        code: 'healthy',
        title: 'Profile passed the selected probe',
        summary: 'Lifeboat did not reproduce a configuration or startup failure in the isolated environment.',
      }
    } else {
      const cleanFull = await probe({
        bundles: profile.bundles,
        profilePatch: false,
        homePatch: false,
        label: 'All bundles without user patches',
      })

      if (fails(cleanFull)) {
        const protectedClean = await probe({
          bundles: protectedBundles,
          profilePatch: false,
          homePatch: false,
          label: 'Installation bundles only',
        })
        if (!fails(protectedClean) && suspects.length > 0) {
          await findVerifiedRecovery({ profilePatch: false, homePatch: false, interaction: false })
        } else {
          report.finding = {
            code: 'core-or-environment',
            title: 'Installation bundles or probe environment still fail',
            summary: suspects.length === 0
              ? 'The profile has no out-of-tree bundle to bisect.'
              : 'The installation-owned bundle baseline failed, so blaming a community plugin would be unsafe.',
          }
        }
      } else {
        const protectedPatched = await probe({
          bundles: protectedBundles,
          profilePatch: true,
          homePatch: true,
          label: 'Installation bundles with both user patches',
        })
        if (!fails(protectedPatched) && suspects.length > 0) {
          await findVerifiedRecovery({ profilePatch: true, homePatch: true, interaction: true })
        } else {
          const profileOnly = await probe({
            bundles: profile.bundles,
            profilePatch: true,
            homePatch: false,
            label: 'Profile patch only',
          })
          const homeOnly = await probe({
            bundles: profile.bundles,
            profilePatch: false,
            homePatch: true,
            label: 'Harness-home patch only',
          })
          report.finding = patchFinding(fails(profileOnly), fails(homeOnly))
        }
      }
    }
    try {
      const current = await snapshot.readCurrentFingerprint()
      if (current.fingerprint.hash !== snapshot.fingerprint.hash) {
        report.profile.currentInputFingerprint = current.fingerprint
        warn('Profile inputs changed while diagnosis was running; automatic recovery was withheld.')
        report.finding = {
          code: 'inputs-changed',
          title: 'Profile inputs changed during diagnosis',
          summary: 'The manifest, user patches, copied profile assets, or package-resolution identity no longer matches the immutable probe snapshot. Run a fresh diagnosis before applying recovery.',
        }
        report.recovery = undefined
      }
    } catch (error) {
      warn(`Could not revalidate live Profile inputs after diagnosis: ${error.message}`)
      report.finding = {
        code: 'inputs-changed',
        title: 'Profile inputs could not be revalidated',
        summary: 'Lifeboat could not prove that the live Profile still matches the probe snapshot, so automatic recovery was withheld.',
      }
      report.recovery = undefined
    }
    report.status = 'completed'
    report.finishedAt = new Date().toISOString()
    emit({ type: 'diagnosis-finished', finding: report.finding })
    return report
  } catch (error) {
    if (error.name === 'InconclusiveProbeError') {
      report.status = 'completed'
      report.finishedAt = new Date().toISOString()
      report.finding = {
        code: 'unstable-probe',
        title: 'Runtime probe was not reproducible',
        summary: `${error.record.label} changed result across ${error.record.attempts.length} isolated attempts. Lifeboat will not offer an automatic recovery from unstable evidence.`,
      }
      report.recovery = undefined
      emit({ type: 'diagnosis-finished', finding: report.finding })
      return report
    }
    report.status = error.name === 'AbortError' ? 'cancelled' : 'failed'
    report.finishedAt = new Date().toISOString()
    report.error = error.message
    emit({ type: 'diagnosis-failed', status: report.status, error: error.message })
    if (error.name === 'AbortError') return report
    throw Object.assign(error, { report })
  } finally {
    try {
      await snapshot.cleanup()
    } catch (error) {
      warn(`Probe snapshot cleanup failed: ${error.message}`)
    }
  }
}
