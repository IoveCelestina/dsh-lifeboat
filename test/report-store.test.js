import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import {
  mkdir, mkdtemp, readFile, rm, rmdir, symlink, unlink, writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createReportStore } from '../src/report-store.js'

test('persists, lists, and atomically updates a diagnosis report', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-lifeboat-reports-'))
  const store = createReportStore(root)
  const id = randomUUID()
  try {
    await store.persist({
      schema: 'dsh-lifeboat-job/v1',
      id,
      status: 'completed',
      createdAt: '2026-08-18T00:00:00.000Z',
      finishedAt: '2026-08-18T00:00:01.000Z',
      report: { options: { profile: 'web', mode: 'config' }, finding: { code: 'healthy' } },
    })
    assert.equal((await store.get(id)).status, 'completed')
    assert.equal((await store.list())[0].finding.code, 'healthy')
    assert.match((await store.get(id)).savedAt, /^\d{4}-\d{2}-\d{2}T/)

    await store.persist({
      schema: 'dsh-lifeboat-job/v1',
      id,
      status: 'completed',
      createdAt: '2026-08-18T00:00:00.000Z',
      finishedAt: '2026-08-18T00:00:02.000Z',
      recoveryApplied: { disabledBundles: ['broken'] },
      report: { options: { profile: 'web', mode: 'config' }, finding: { code: 'plugin-set' } },
    })
    assert.deepEqual((await store.get(id)).recoveryApplied.disabledBundles, ['broken'])
    assert.equal((await store.list())[0].recoveryPending, true)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('serializes writes and prunes only the oldest report JSON files', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-lifeboat-retention-'))
  const store = createReportStore(root, { maxReports: 2 })
  const ids = [randomUUID(), randomUUID(), randomUUID()]
  try {
    for (const id of ids) {
      await store.persist({
        schema: 'dsh-lifeboat-job/v1',
        id,
        status: 'completed',
        createdAt: new Date().toISOString(),
        report: { options: { profile: 'web', mode: 'config' }, finding: { code: 'healthy' } },
      })
      await new Promise(resolve => setTimeout(resolve, 5))
    }
    assert.deepEqual((await store.list()).map(report => report.id), [ids[2], ids[1]])
    await assert.rejects(store.get(ids[0]), error => error.code === 'ENOENT')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('rejects mismatched persisted job envelopes instead of trusting state files', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-lifeboat-invalid-report-'))
  const store = createReportStore(root, { maxReports: 0 })
  const filenameId = randomUUID()
  try {
    await mkdir(store.reportsDir, { recursive: true })
    await writeFile(join(store.reportsDir, `${filenameId}.json`), JSON.stringify({
      schema: 'dsh-lifeboat-job/v1',
      id: randomUUID(),
      status: 'completed',
    }))
    assert.deepEqual(await store.list(), [])
    await assert.rejects(store.get(filenameId), error => error.code === 'EINVALIDREPORT')
    await assert.rejects(store.persist({ id: randomUUID(), status: 'completed' }), /Invalid persisted Lifeboat job/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('refuses to prune through a linked report directory', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-lifeboat-linked-reports-'))
  const stateDir = join(root, 'state')
  const outside = join(root, 'outside')
  const store = createReportStore(stateDir, { maxReports: 1 })
  const marker = join(outside, `${randomUUID()}.json`)
  try {
    await mkdir(stateDir)
    await mkdir(outside)
    await writeFile(marker, 'must remain')
    await symlink(outside, store.reportsDir, process.platform === 'win32' ? 'junction' : 'dir')
    await assert.rejects(store.prune(), error => error.code === 'EUNSAFEREPORTDIR')
    assert.equal(await readFile(marker, 'utf8'), 'must remain')
  } finally {
    try {
      await unlink(store.reportsDir)
    } catch (error) {
      if (process.platform === 'win32' && ['EISDIR', 'EPERM'].includes(error.code)) await rmdir(store.reportsDir)
      else if (error.code !== 'ENOENT') throw error
    }
    await rm(root, { recursive: true, force: true })
  }
})
