import { randomBytes, randomUUID } from 'node:crypto'
import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { applyRecovery, restoreRecovery } from './recovery.js'
import { diagnoseProfile } from './diagnose.js'
import { listProfiles, resolveDshHome } from './manifest.js'
import { validateProbeTiming } from './probe.js'
import { createReportStore } from './report-store.js'
import { VERSION } from './version.js'

const CLIENT_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'client')
const MAX_BODY_BYTES = 64 * 1024
const STATIC_FILES = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/styles.css', ['styles.css', 'text/css; charset=utf-8']],
  ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
])

function securityHeaders(response) {
  response.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; object-src 'none'; frame-ancestors 'none'; base-uri 'none'")
  response.setHeader('Cross-Origin-Resource-Policy', 'same-origin')
  response.setHeader('Cross-Origin-Opener-Policy', 'same-origin')
  response.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()')
  response.setHeader('Referrer-Policy', 'no-referrer')
  response.setHeader('X-Content-Type-Options', 'nosniff')
  response.setHeader('X-Frame-Options', 'DENY')
  response.setHeader('Cache-Control', 'no-store')
}

function sendJson(response, status, value) {
  const body = JSON.stringify(value)
  response.statusCode = status
  response.setHeader('Content-Type', 'application/json; charset=utf-8')
  response.setHeader('Content-Length', Buffer.byteLength(body))
  response.end(body)
}

function sendError(response, status, message) {
  sendJson(response, status, { error: message })
}

async function readJson(request) {
  if (!request.headers['content-type']?.toLowerCase().startsWith('application/json')) {
    const error = new Error('Content-Type must be application/json.')
    error.statusCode = 415
    throw error
  }
  const chunks = []
  let size = 0
  for await (const chunk of request) {
    size += chunk.length
    if (size > MAX_BODY_BYTES) {
      const error = new Error('Request body is too large.')
      error.statusCode = 413
      throw error
    }
    chunks.push(chunk)
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
  } catch {
    const error = new Error('Request body is not valid JSON.')
    error.statusCode = 400
    throw error
  }
}

function finiteInteger(value, fallback, minimum, maximum, name) {
  if (value === undefined || value === null || value === '') return fallback
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be an integer between ${minimum} and ${maximum}.`)
  }
  return value
}

function stringArray(value, name) {
  if (value === undefined) return []
  if (!Array.isArray(value) || value.length > 30
    || value.some(item => typeof item !== 'string' || item.length > 4_096)) {
    throw new Error(`${name} must be an array of at most 30 strings.`)
  }
  return value
}

function normalizeJobOptions(body, defaultHome, defaultJobTimeoutMs) {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) throw new Error('Job options must be an object.')
  const mode = body.mode ?? 'config'
  if (!['config', 'boot'].includes(mode)) throw new Error('mode must be config or boot.')
  if (mode === 'boot' && body.allowRuntimeCodeExecution !== true) {
    throw new Error('Runtime probes execute installed plugin code and require explicit acknowledgement.')
  }
  const command = body.command ?? 'dsh'
  if (typeof command !== 'string' || command === '' || command.length > 4_096) {
    throw new Error('command must be a non-empty executable name or path.')
  }
  const timeoutMs = finiteInteger(
    body.timeoutMs,
    mode === 'config' ? 60_000 : 20_000,
    1_000,
    300_000,
    'timeoutMs',
  )
  const successWindowMs = finiteInteger(body.successWindowMs, 8_000, 500, 60_000, 'successWindowMs')
  validateProbeTiming({ mode, timeoutMs, successWindowMs })
  return {
    home: resolveDshHome(body.home || defaultHome),
    profile: body.profile || 'web',
    mode,
    command,
    commandArgs: stringArray(body.commandArgs, 'commandArgs'),
    bootArgs: stringArray(body.bootArgs, 'bootArgs'),
    timeoutMs,
    successWindowMs,
    bootConfirmations: finiteInteger(body.bootConfirmations, 2, 1, 5, 'bootConfirmations'),
    maxCandidateBundles: finiteInteger(body.maxCandidateBundles, 128, 1, 512, 'maxCandidateBundles'),
    maxExactRemovalSize: finiteInteger(body.maxExactRemovalSize, 2, 1, 8, 'maxExactRemovalSize'),
    maxRecoveryProbes: finiteInteger(
      body.maxRecoveryProbes,
      mode === 'boot' ? 64 : 256,
      1,
      4_096,
      'maxRecoveryProbes',
    ),
    jobTimeoutMs: finiteInteger(body.jobTimeoutMs, defaultJobTimeoutMs, 1_000, 6 * 60 * 60 * 1_000, 'jobTimeoutMs'),
    keepArtifacts: body.keepArtifacts === true,
    allowRuntimeCodeExecution: body.allowRuntimeCodeExecution === true,
  }
}

function serializeJob(job, queuePosition) {
  return {
    id: job.id,
    status: job.status,
    queuePosition,
    createdAt: job.createdAt,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt,
    events: job.events,
    report: job.report,
    error: job.error,
    recoveryApplied: job.recoveryApplied,
    recoveryRestored: job.recoveryRestored,
    reportSaved: job.reportSaved === true,
  }
}

function selectRecoveryPlan(recovery, requestedPlanId) {
  const plans = Array.isArray(recovery?.plans) && recovery.plans.length > 0
    ? recovery.plans
    : recovery?.bundles?.length
      ? [{ id: recovery.selectedPlanId ?? 'legacy-recovery', bundles: recovery.bundles }]
      : []
  const planId = requestedPlanId ?? recovery?.selectedPlanId ?? plans[0]?.id
  if (typeof planId !== 'string' || planId.length === 0) {
    const error = new Error('A verified recovery plan must be selected.')
    error.statusCode = 400
    throw error
  }
  const plan = plans.find(candidate => candidate.id === planId)
  if (!plan) {
    const error = new Error('The selected recovery plan was not verified by this diagnosis.')
    error.statusCode = 409
    throw error
  }
  if (!Array.isArray(plan.bundles) || plan.bundles.length === 0) {
    const error = new Error('The selected recovery plan contains no bundles.')
    error.statusCode = 409
    throw error
  }
  return plan
}

function assertLocalHost(request) {
  const host = request.headers.host ?? ''
  const hostname = host.startsWith('[') ? host.slice(1, host.indexOf(']')) : host.split(':')[0]
  return hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '::1'
}

function assertSameOrigin(request) {
  const origin = request.headers.origin
  if (origin === undefined) return true
  try {
    const parsed = new URL(origin)
    return parsed.protocol === 'http:' && parsed.host.toLowerCase() === (request.headers.host ?? '').toLowerCase()
  } catch {
    return false
  }
}

function waitAtMost(promise, timeoutMs) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, timeoutMs)
    timer.unref?.()
    promise.then(
      value => {
        clearTimeout(timer)
        resolve(value)
      },
      error => {
        clearTimeout(timer)
        reject(error)
      },
    )
  })
}

/** Start the loopback-only Lifeboat recovery server. */
export async function createLifeboatServer(options = {}) {
  const defaultHome = resolveDshHome(options.home)
  const token = randomBytes(24).toString('base64url')
  const jobs = new Map()
  const queue = []
  const running = new Set()
  const tasks = new Set()
  const diagnose = options.diagnose ?? diagnoseProfile
  const maxConcurrentJobs = finiteInteger(options.maxConcurrentJobs, 1, 1, 4, 'maxConcurrentJobs')
  const maxRetainedJobs = finiteInteger(options.maxRetainedJobs, 100, 10, 1_000, 'maxRetainedJobs')
  const defaultJobTimeoutMs = finiteInteger(
    options.defaultJobTimeoutMs,
    30 * 60 * 1_000,
    1_000,
    6 * 60 * 60 * 1_000,
    'defaultJobTimeoutMs',
  )
  const reportStore = createReportStore(options.stateDir ?? join(defaultHome, 'lifeboat'))
  const startedAt = Date.now()
  let closing = false
  let closePromise

  const queuePosition = job => job.status === 'queued'
    ? queue.filter(candidate => candidate.status === 'queued').indexOf(job) + 1
    : undefined
  const publicJob = job => serializeJob(job, queuePosition(job) || undefined)

  const persistJob = async (job, status = job.status) => {
    try {
      await reportStore.persist({
        schema: 'dsh-lifeboat-job/v1',
        ...publicJob(job),
        status,
        reportSaved: true,
      })
      job.reportSaved = true
    } catch (error) {
      job.events.push({
        at: new Date().toISOString(),
        type: 'report-persist-failed',
        error: error.message,
      })
    }
  }

  const pruneJobs = () => {
    const removable = [...jobs.values()]
      .filter(job => !['queued', 'running'].includes(job.status))
      .sort((left, right) => Date.parse(left.finishedAt) - Date.parse(right.finishedAt))
    while (jobs.size >= maxRetainedJobs && removable.length > 0) {
      jobs.delete(removable.shift().id)
    }
    if (jobs.size >= maxRetainedJobs) {
      const error = new Error('The diagnosis queue is full. Wait for an active job to finish.')
      error.statusCode = 503
      throw error
    }
  }

  const runJob = async job => {
    job.status = 'running'
    job.startedAt = new Date().toISOString()
    running.add(job)
    const deadline = setTimeout(() => {
      job.events.push({ at: new Date().toISOString(), type: 'diagnosis-deadline-exceeded' })
      job.controller.abort()
    }, job.options.jobTimeoutMs)
    deadline.unref?.()
    let terminalStatus = 'failed'
    try {
      job.report = await diagnose(
        { ...job.options, signal: job.controller.signal },
        { emit: event => {
          job.events.push({ at: new Date().toISOString(), ...event })
          if (job.events.length > 400) job.events.splice(0, job.events.length - 400)
        } },
      )
      terminalStatus = job.report.status
    } catch (error) {
      terminalStatus = 'failed'
      job.error = error.message
      job.report = error.report
    } finally {
      clearTimeout(deadline)
      job.finishedAt = new Date().toISOString()
      await persistJob(job, terminalStatus)
      job.status = terminalStatus
      running.delete(job)
    }
  }

  const pumpQueue = () => {
    if (closing) return
    while (running.size < maxConcurrentJobs && queue.length > 0) {
      const job = queue.shift()
      if (job.status !== 'queued') continue
      const task = runJob(job).finally(() => {
        tasks.delete(task)
        pumpQueue()
      })
      tasks.add(task)
    }
  }

  const startJob = normalized => {
    if (closing) {
      const error = new Error('Lifeboat is shutting down and cannot accept new jobs.')
      error.statusCode = 503
      throw error
    }
    pruneJobs()
    const job = {
      id: randomUUID(),
      status: 'queued',
      createdAt: new Date().toISOString(),
      events: [],
      controller: new AbortController(),
      options: normalized,
    }
    jobs.set(job.id, job)
    queue.push(job)
    queueMicrotask(pumpQueue)
    return job
  }

  const server = createServer(async (request, response) => {
    securityHeaders(response)
    if (!assertLocalHost(request)) {
      sendError(response, 403, 'Lifeboat accepts loopback Host headers only.')
      return
    }
    const url = new URL(request.url ?? '/', 'http://127.0.0.1')
    try {
      if (request.method === 'GET' && STATIC_FILES.has(url.pathname)) {
        const [filename, contentType] = STATIC_FILES.get(url.pathname)
        const body = await readFile(join(CLIENT_DIR, filename))
        response.statusCode = 200
        response.setHeader('Content-Type', contentType)
        response.setHeader('Content-Length', body.length)
        response.end(body)
        return
      }
      if (request.method === 'GET' && url.pathname === '/api/bootstrap') {
        sendJson(response, 200, {
          version: VERSION,
          token,
          defaultHome,
          profiles: await listProfiles(defaultHome),
          recentReports: await reportStore.list(10),
          safety: 'Profile manifests and patches remain read-only until Apply recovery. Runtime probes execute installed plugin code with the current user permissions.',
        })
        return
      }
      if (request.method === 'GET' && url.pathname === '/api/health') {
        sendJson(response, closing ? 503 : 200, {
          status: closing ? 'stopping' : 'ok',
          version: VERSION,
          uptimeSeconds: Math.floor((Date.now() - startedAt) / 1_000),
          queueDepth: queue.filter(job => job.status === 'queued').length,
          runningJobs: running.size,
        })
        return
      }
      if (request.method === 'GET' && url.pathname === '/api/profiles') {
        const home = resolveDshHome(url.searchParams.get('home') || defaultHome)
        sendJson(response, 200, { home, profiles: await listProfiles(home) })
        return
      }
      if (request.method === 'GET' && url.pathname === '/api/reports') {
        sendJson(response, 200, { reports: await reportStore.list(50) })
        return
      }
      const reportMatch = url.pathname.match(/^\/api\/reports\/([a-f0-9-]+)$/)
      if (request.method === 'GET' && reportMatch) {
        try {
          sendJson(response, 200, await reportStore.get(reportMatch[1]))
        } catch (error) {
          if (error.code === 'ENOENT') sendError(response, 404, 'Diagnosis report not found.')
          else throw error
        }
        return
      }
      const jobMatch = url.pathname.match(/^\/api\/jobs\/([a-f0-9-]+)$/)
      if (request.method === 'GET' && jobMatch) {
        const job = jobs.get(jobMatch[1])
        if (!job) sendError(response, 404, 'Diagnosis job not found.')
        else sendJson(response, 200, publicJob(job))
        return
      }

      if (request.method === 'POST') {
        if (!assertSameOrigin(request)) {
          sendError(response, 403, 'Cross-origin write requests are not accepted.')
          return
        }
        if (request.headers['x-lifeboat-token'] !== token) {
          sendError(response, 403, 'Missing or invalid local session token.')
          return
        }
        if (url.pathname === '/api/jobs') {
          let normalized
          try {
            normalized = normalizeJobOptions(await readJson(request), defaultHome, defaultJobTimeoutMs)
          } catch (error) {
            error.statusCode ??= 400
            throw error
          }
          const job = startJob(normalized)
          sendJson(response, 202, publicJob(job))
          return
        }
        const actionMatch = url.pathname.match(/^\/api\/jobs\/([a-f0-9-]+)\/(cancel|apply|restore)$/)
        if (actionMatch) {
          const job = jobs.get(actionMatch[1])
          if (!job) {
            sendError(response, 404, 'Diagnosis job not found.')
            return
          }
          const action = actionMatch[2]
          if (action === 'cancel') {
            if (job.status === 'queued') {
              job.status = 'cancelled'
              job.finishedAt = new Date().toISOString()
              await persistJob(job)
              sendJson(response, 200, publicJob(job))
              return
            }
            if (job.status !== 'running') {
              sendJson(response, 200, publicJob(job))
              return
            }
            job.controller.abort()
            sendJson(response, 202, { status: 'cancelling' })
            return
          }
          const actionOptions = await readJson(request)
          if (job.mutating) {
            sendError(response, 409, 'A recovery operation is already running for this diagnosis.')
            return
          }
          job.mutating = true
          try {
            if (action === 'apply') {
              if (job.status !== 'completed' || !job.report?.recovery) {
                sendError(response, 409, 'This diagnosis has no applicable bundle recovery.')
                return
              }
              if (job.recoveryApplied) {
                sendError(response, 409, 'Recovery has already been applied for this diagnosis.')
                return
              }
              const plan = selectRecoveryPlan(job.report.recovery, actionOptions?.planId)
              job.recoveryApplied = await applyRecovery({
                home: job.report.options.home,
                profile: job.report.options.profile,
                disableBundles: plan.bundles,
                expectedManifestHash: job.report.recovery.manifestHash,
              })
              job.recoveryApplied.planId = plan.id
              job.recoveryApplied.optimality = plan.optimality
              job.recoveryApplied.verificationProbeId = plan.verificationProbeId
              await persistJob(job)
              sendJson(response, 200, job.recoveryApplied)
              return
            }
            if (!job.recoveryApplied) {
              sendError(response, 409, 'No recovery from this job is available to restore.')
              return
            }
            job.recoveryRestored = await restoreRecovery({
              home: job.report.options.home,
              profile: job.report.options.profile,
              backupName: basename(job.recoveryApplied.backupPath),
              expectedManifestHash: job.recoveryApplied.currentManifestHash,
            })
            await persistJob(job)
            sendJson(response, 200, job.recoveryRestored)
            return
          } finally {
            job.mutating = false
          }
        }
      }
      sendError(response, 404, 'Not found.')
    } catch (error) {
      sendError(response, error.statusCode ?? 500, error.message)
    }
  })

  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(options.port ?? 4317, '127.0.0.1', resolve)
  })
  const address = server.address()
  const port = typeof address === 'object' && address ? address.port : options.port ?? 4317
  return {
    server,
    token,
    url: `http://127.0.0.1:${port}/`,
    jobs,
    reportStore,
    async close() {
      if (closePromise) return closePromise
      closePromise = (async () => {
        closing = true
        for (const job of queue) {
          if (job.status !== 'queued') continue
          job.status = 'cancelled'
          job.finishedAt = new Date().toISOString()
          await persistJob(job)
        }
        for (const job of running) job.controller.abort()

        const serverClosed = new Promise((resolve, reject) => {
          server.close(error => error ? reject(error) : resolve())
        })
        server.closeIdleConnections?.()
        const forceTimer = setTimeout(() => server.closeAllConnections?.(), 250)
        forceTimer.unref?.()
        try {
          await waitAtMost(serverClosed, 5_000)
        } finally {
          clearTimeout(forceTimer)
          server.closeAllConnections?.()
        }
        await waitAtMost(Promise.allSettled([...tasks]), 5_000)
      })()
      return closePromise
    },
  }
}
