import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { apply } from '../src/plugin.js'

test('writes the health marker only after Loader settlement', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-lifeboat-marker-'))
  const previousHome = process.env.DSH_HOME
  let settle
  const settled = new Promise(resolve => { settle = resolve })
  const loader = { await: () => settled }
  const ctx = { get: name => name === 'loader' ? loader : undefined }
  process.env.DSH_HOME = root
  try {
    apply(ctx)
    await assert.rejects(readFile(join(root, 'lifeboat', 'last-healthy.json'), 'utf8'))
    settle()
    let marker
    for (let attempt = 0; attempt < 40; attempt += 1) {
      try {
        marker = JSON.parse(await readFile(join(root, 'lifeboat', 'last-healthy.json'), 'utf8'))
        break
      } catch {
        await new Promise(resolve => setTimeout(resolve, 5))
      }
    }
    assert.equal(marker.schema, 'dsh-lifeboat-health/v1')
    assert.equal(marker.pid, process.pid)
  } finally {
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
    await rm(root, { recursive: true, force: true })
  }
})
