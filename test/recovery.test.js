import assert from 'node:assert/strict'
import { basename, join } from 'node:path'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'
import { readProfile } from '../src/manifest.js'
import { applyRecovery, restoreRecovery } from '../src/recovery.js'
import { profileFixture } from './helpers.js'

test('recovery creates a backup, disables only findings, and can be restored', async () => {
  const fixture = await profileFixture()
  try {
    const before = await readProfile(fixture.home, fixture.profile)
    const applied = await applyRecovery({
      home: fixture.home,
      profile: fixture.profile,
      disableBundles: ['beta'],
      expectedManifestHash: before.hash,
    })
    const after = await readProfile(fixture.home, fixture.profile)
    assert.deepEqual(after.bundles, ['@deepseek-ai/dsh-base', 'alpha', 'gamma'])
    assert.equal(applied.currentManifestHash, after.hash)
    assert.equal(JSON.parse(await readFile(applied.backupPath, 'utf8')).dsh.profile.bundles.includes('beta'), true)

    await restoreRecovery({
      home: fixture.home,
      profile: fixture.profile,
      backupName: basename(applied.backupPath),
      expectedManifestHash: after.hash,
    })
    assert.deepEqual((await readProfile(fixture.home, fixture.profile)).bundles, before.bundles)
    assert.equal(join(fixture.profileDir, '.lifeboat-backups'), applied.backupPath.slice(0, applied.backupPath.lastIndexOf('\\') > -1 ? applied.backupPath.lastIndexOf('\\') : applied.backupPath.lastIndexOf('/')))
  } finally {
    await fixture.cleanup()
  }
})

test('recovery refuses a stale diagnosis hash', async () => {
  const fixture = await profileFixture()
  try {
    await assert.rejects(applyRecovery({
      home: fixture.home,
      profile: fixture.profile,
      disableBundles: ['beta'],
      expectedManifestHash: '0'.repeat(64),
    }), /changed after diagnosis/)
  } finally {
    await fixture.cleanup()
  }
})
