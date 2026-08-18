import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
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
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
