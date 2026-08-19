import { randomUUID } from 'node:crypto'
import {
  lstat, mkdir, open, readFile, readdir, realpath, rename, stat, unlink,
} from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'

const REPORT_ID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i
const JOB_SCHEMA = 'dsh-lifeboat-job/v1'
const JOB_STATUSES = new Set(['queued', 'running', 'completed', 'failed', 'cancelled'])
const DEFAULT_MAX_REPORTS = 500

function assertReportId(id) {
  if (typeof id !== 'string' || !REPORT_ID.test(id)) {
    const error = new Error('Invalid Lifeboat report id.')
    error.code = 'EINVALREPORTID'
    throw error
  }
  return id
}

function assertStoredJob(value, expectedId = value?.id) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || value.schema !== JOB_SCHEMA
    || value.id !== expectedId
    || !REPORT_ID.test(value.id)
    || !JOB_STATUSES.has(value.status)) {
    const error = new Error('Invalid persisted Lifeboat job.')
    error.code = 'EINVALIDREPORT'
    throw error
  }
  return value
}

function reportLimit(value) {
  const normalized = value ?? DEFAULT_MAX_REPORTS
  if (!Number.isInteger(normalized) || normalized < 0 || normalized > 10_000) {
    throw new Error('maxReports must be an integer from 0 to 10000.')
  }
  return normalized
}

function listLimit(value) {
  if (!Number.isInteger(value) || value < 0 || value > 10_000) {
    throw new Error('Report list limit must be an integer from 0 to 10000.')
  }
  return value
}

function summarize(value) {
  return {
    id: value.id,
    status: value.status,
    createdAt: value.createdAt,
    startedAt: value.startedAt,
    finishedAt: value.finishedAt,
    savedAt: value.savedAt,
    profile: value.report?.options?.profile,
    mode: value.report?.options?.mode,
    finding: value.report?.finding,
    recoveryPending: Boolean(value.recoveryApplied && !value.recoveryRestored),
  }
}

function storedTime(value, fallback) {
  for (const candidate of [value?.savedAt, value?.finishedAt, value?.startedAt, value?.createdAt]) {
    const timestamp = Date.parse(candidate)
    if (Number.isFinite(timestamp)) return timestamp
  }
  return fallback
}

function unsafeDirectory(message) {
  const error = new Error(message)
  error.code = 'EUNSAFEREPORTDIR'
  return error
}

function missingReportDirectory() {
  const error = new Error('Lifeboat report directory does not exist.')
  error.code = 'ENOENT'
  return error
}

/** Atomic, serialized storage for terminal diagnosis jobs and recovery receipts. */
export function createReportStore(stateDir, options = {}) {
  const root = resolve(stateDir)
  const reportsDir = join(root, 'reports')
  const maxReports = reportLimit(options.maxReports)
  let mutationTail = Promise.resolve()

  const reportPath = (id, directory = reportsDir) => join(directory, `${assertReportId(id)}.json`)
  const serializeMutation = task => {
    const result = mutationTail.then(task, task)
    mutationTail = result.catch(() => {})
    return result
  }

  const safeReportsDirectory = async create => {
    if (create) await mkdir(root, { recursive: true, mode: 0o700 })
    let rootStat
    try {
      rootStat = await lstat(root)
    } catch (error) {
      if (!create && error.code === 'ENOENT') return undefined
      throw error
    }
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
      throw unsafeDirectory('The Lifeboat state directory must be a real directory, not a symbolic link or junction.')
    }
    const rootReal = await realpath(root)
    if (create) {
      try {
        await mkdir(reportsDir, { mode: 0o700 })
      } catch (error) {
        if (error.code !== 'EEXIST') throw error
      }
    }
    let reportsStat
    try {
      reportsStat = await lstat(reportsDir)
    } catch (error) {
      if (!create && error.code === 'ENOENT') return undefined
      throw error
    }
    if (!reportsStat.isDirectory() || reportsStat.isSymbolicLink()) {
      throw unsafeDirectory('The Lifeboat report directory must be a real directory, not a symbolic link or junction.')
    }
    const reportsReal = await realpath(reportsDir)
    if (dirname(reportsReal) !== rootReal) {
      throw unsafeDirectory('The Lifeboat report directory resolves outside the state directory.')
    }
    return reportsReal
  }

  const safeReportFile = async (directory, id) => {
    const path = reportPath(id, directory)
    const metadata = await lstat(path)
    if (!metadata.isFile() || metadata.isSymbolicLink()) {
      throw unsafeDirectory('A persisted Lifeboat report must be a real file, not a symbolic link.')
    }
    const reportReal = await realpath(path)
    if (dirname(reportReal) !== directory) {
      throw unsafeDirectory('A persisted Lifeboat report resolves outside the report directory.')
    }
    return reportReal
  }

  const candidates = async () => {
    const directory = await safeReportsDirectory(false)
    if (!directory) return []
    let entries
    try {
      entries = await readdir(directory, { withFileTypes: true })
    } catch (error) {
      if (error.code === 'ENOENT') return []
      throw error
    }
    const reportEntries = entries.filter(entry => {
      const id = entry.name.endsWith('.json') ? entry.name.slice(0, -5) : ''
      return entry.isFile() && REPORT_ID.test(id)
    })
    const values = await Promise.all(reportEntries.map(async entry => {
      const path = join(directory, entry.name)
      const metadata = await stat(path)
      try {
        const value = assertStoredJob(JSON.parse(await readFile(path, 'utf8')), entry.name.slice(0, -5))
        return { entry, path, value, modified: storedTime(value, metadata.mtimeMs) }
      } catch {
        return { entry, path, value: undefined, modified: metadata.mtimeMs }
      }
    }))
    values.sort((left, right) => right.modified - left.modified || right.entry.name.localeCompare(left.entry.name))
    return values
  }

  const pruneInternal = async keepId => {
    if (maxReports === 0) return []
    const entries = await candidates()
    const keep = []
    const remove = []
    for (const entry of entries) {
      if (entry.value?.id === keepId || keep.length < maxReports) keep.push(entry)
      else remove.push(entry)
    }
    while (keep.length > maxReports) {
      const index = keep.findLastIndex(entry => entry.value?.id !== keepId)
      if (index < 0) break
      remove.push(...keep.splice(index, 1))
    }
    for (const entry of remove) await unlink(entry.path)
    return remove.map(entry => entry.entry.name.slice(0, -5))
  }

  return {
    root,
    reportsDir,
    maxReports,
    async persist(value) {
      assertStoredJob(value)
      return serializeMutation(async () => {
        const directory = await safeReportsDirectory(true)
        const target = reportPath(value.id, directory)
        const temporary = join(directory, `.${value.id}.${randomUUID()}.tmp`)
        const body = `${JSON.stringify({ ...value, savedAt: new Date().toISOString() }, null, 2)}\n`
        let handle
        try {
          handle = await open(temporary, 'wx', 0o600)
          await handle.writeFile(body, 'utf8')
          await handle.sync()
          await handle.close()
          handle = undefined
          await rename(temporary, target)
        } catch (error) {
          try {
            await handle?.close()
          } catch (closeError) {
            error.message += ` Closing the partial report also failed: ${closeError.message}`
          }
          try {
            await unlink(temporary)
          } catch (cleanupError) {
            if (cleanupError.code !== 'ENOENT') error.message += ` Removing the partial report also failed: ${cleanupError.message}`
          }
          throw error
        }
        await pruneInternal(value.id)
        return target
      })
    },
    async get(id) {
      await mutationTail
      const expectedId = assertReportId(id)
      const directory = await safeReportsDirectory(false)
      if (!directory) throw missingReportDirectory()
      const body = await readFile(await safeReportFile(directory, expectedId), 'utf8')
      return assertStoredJob(JSON.parse(body), expectedId)
    },
    async list(limit = 20) {
      await mutationTail
      const entries = await candidates()
      return entries.filter(entry => entry.value).slice(0, listLimit(limit)).map(entry => summarize(entry.value))
    },
    async prune() {
      return serializeMutation(() => pruneInternal())
    },
  }
}
