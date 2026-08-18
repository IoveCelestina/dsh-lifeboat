import { randomUUID } from 'node:crypto'
import { mkdir, readFile, readdir, rename, stat, unlink, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'

const REPORT_ID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i

function assertReportId(id) {
  if (!REPORT_ID.test(id)) throw new Error('Invalid Lifeboat report id.')
  return id
}

function summarize(value) {
  return {
    id: value.id,
    status: value.status,
    createdAt: value.createdAt,
    startedAt: value.startedAt,
    finishedAt: value.finishedAt,
    profile: value.report?.options?.profile,
    mode: value.report?.options?.mode,
    finding: value.report?.finding,
  }
}

/** Atomic storage for terminal diagnosis jobs and their recovery receipts. */
export function createReportStore(stateDir) {
  const root = resolve(stateDir)
  const reportsDir = join(root, 'reports')

  const reportPath = id => join(reportsDir, `${assertReportId(id)}.json`)

  return {
    root,
    reportsDir,
    async persist(value) {
      assertReportId(value.id)
      await mkdir(reportsDir, { recursive: true })
      const target = reportPath(value.id)
      const temporary = join(reportsDir, `.${value.id}.${randomUUID()}.tmp`)
      const body = `${JSON.stringify(value, null, 2)}\n`
      await writeFile(temporary, body, { encoding: 'utf8', flag: 'wx', mode: 0o600 })
      try {
        await rename(temporary, target)
      } catch (error) {
        try {
          await unlink(temporary)
        } catch (cleanupError) {
          if (cleanupError.code !== 'ENOENT') throw cleanupError
        }
        throw error
      }
      return target
    },
    async get(id) {
      const body = await readFile(reportPath(id), 'utf8')
      return JSON.parse(body)
    },
    async list(limit = 20) {
      let entries
      try {
        entries = await readdir(reportsDir, { withFileTypes: true })
      } catch (error) {
        if (error.code === 'ENOENT') return []
        throw error
      }
      const candidates = entries
        .filter(entry => entry.isFile() && REPORT_ID.test(entry.name.replace(/\.json$/, '')) && entry.name.endsWith('.json'))
      const withTimes = await Promise.all(candidates.map(async entry => ({
        entry,
        modified: (await stat(join(reportsDir, entry.name))).mtimeMs,
      })))
      withTimes.sort((left, right) => right.modified - left.modified)
      const values = []
      for (const { entry } of withTimes.slice(0, limit)) {
        try {
          values.push(summarize(JSON.parse(await readFile(join(reportsDir, entry.name), 'utf8'))))
        } catch {
          // A corrupt report should not prevent the service from listing healthy ones.
        }
      }
      return values
    },
  }
}
