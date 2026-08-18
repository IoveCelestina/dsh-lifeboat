import { randomUUID } from 'node:crypto'
import { classifyBundles, readProfile } from './manifest.js'
import { minimizeFailingSet } from './minimize.js'
import { runProbe } from './probe.js'
import { createProbeWorkspace } from './workspace.js'

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
  validateOptions(options)
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
      bootConfirmations: options.mode === 'boot' ? options.bootConfirmations ?? 2 : 1,
      maxCandidateBundles: options.maxCandidateBundles ?? 128,
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

  const cache = new Map()
  let probeIndex = 0
  const confirmations = options.mode === 'boot' ? options.bootConfirmations ?? 2 : 1

  const warn = message => {
    if (!report.warnings.includes(message)) report.warnings.push(message)
  }

  const compose = selected => {
    const active = new Set([...protectedBundles, ...selected])
    return profile.bundles.filter(bundle => active.has(bundle))
  }

  const probe = async ({ bundles, profilePatch, homePatch, label }) => {
    if (options.signal?.aborted) throw abortError()
    const key = JSON.stringify([bundles, profilePatch, homePatch, options.mode ?? 'config'])
    const cached = cache.get(key)
    if (cached) {
      emit({ type: 'probe-cache-hit', label, probeId: cached.id })
      return cached
    }
    const id = `probe-${String(++probeIndex).padStart(3, '0')}`
    emit({ type: 'probe-started', id, label, bundles, profilePatch, homePatch })
    const attempts = []
    for (let attempt = 1; attempt <= confirmations; attempt += 1) {
      if (options.signal?.aborted) throw abortError()
      const workspace = await createProbeWorkspace(profile, options)
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
          timeoutMs: options.timeoutMs,
          successWindowMs: options.successWindowMs,
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
    cache.set(key, record)
    report.probes.push(record)
    emit({ type: 'probe-finished', id, label, status: result.status, reason: result.reason })
    return record
  }

  const fails = result => {
    if (result.status === 'unstable') throw inconclusiveError(result)
    return result.status === 'fail'
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
          const minimum = await minimizeFailingSet(
            suspects,
            async selected => fails(await probe({
              bundles: compose(selected),
              profilePatch: false,
              homePatch: false,
              label: `Candidate set: ${selected.join(', ') || '(none)'}`,
            })),
            step => emit({ type: 'minimize-step', ...step }),
          )
          report.finding = {
            code: 'plugin-set',
            title: minimum.length === 1 ? 'One bundle reproduces the failure' : 'Minimal bundle combination found',
            summary: minimum.length === 1
              ? `${minimum[0]} fails without either user patch layer.`
              : `These ${minimum.length} bundles fail together; removing any one from this set made the tested subset pass.`,
            bundles: minimum,
          }
          report.recovery = {
            action: 'disable-bundles',
            bundles: minimum,
            manifestHash: profile.hash,
            note: 'This removes the bundles from dsh.profile.bundles but keeps their installed dependencies.',
          }
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
          const minimum = await minimizeFailingSet(
            suspects,
            async selected => fails(await probe({
              bundles: compose(selected),
              profilePatch: true,
              homePatch: true,
              label: `Patch interaction candidate: ${selected.join(', ') || '(none)'}`,
            })),
            step => emit({ type: 'minimize-step', ...step }),
          )
          report.finding = {
            code: 'plugin-patch-interaction',
            title: 'Bundle and user-patch interaction found',
            summary: `The bundles pass without user patches. The smallest reproduced interaction contains ${minimum.length} bundle(s).`,
            bundles: minimum,
          }
          report.recovery = {
            action: 'disable-bundles',
            bundles: minimum,
            manifestHash: profile.hash,
            note: 'This is a recovery action, not proof that the bundle alone is defective.',
          }
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
  }
}
