import assert from 'node:assert/strict'
import { basename, join } from 'node:path'
import { mkdir, readFile, readdir, symlink, writeFile } from 'node:fs/promises'
import { test } from 'node:test'
import { readProfile, sha256 } from '../src/manifest.js'
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
    assert.equal(applied.backupHash, before.hash)
    assert.match(basename(applied.backupPath), new RegExp(`${before.hash}\\.json$`))
    assert.equal(JSON.parse(await readFile(applied.backupPath, 'utf8')).dsh.profile.bundles.includes('beta'), true)

    const restored = await restoreRecovery({
      home: fixture.home,
      profile: fixture.profile,
      backupName: basename(applied.backupPath),
      expectedBackupHash: applied.backupHash,
      expectedManifestHash: after.hash,
    })
    assert.deepEqual((await readProfile(fixture.home, fixture.profile)).bundles, before.bundles)
    assert.equal(restored.currentManifestHash, before.hash)
    assert.equal(restored.restoreGuardHash, after.hash)
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

test('restore refuses a backup whose contents changed after recovery', async () => {
  const fixture = await profileFixture()
  try {
    const before = await readProfile(fixture.home, fixture.profile)
    const applied = await applyRecovery({
      home: fixture.home,
      profile: fixture.profile,
      disableBundles: ['beta'],
      expectedManifestHash: before.hash,
    })
    await writeFile(applied.backupPath, 'tampered-backup\n')
    await assert.rejects(restoreRecovery({
      home: fixture.home,
      profile: fixture.profile,
      backupName: basename(applied.backupPath),
      expectedBackupHash: applied.backupHash,
      expectedManifestHash: applied.currentManifestHash,
    }), /integrity check failed/)
    assert.deepEqual((await readProfile(fixture.home, fixture.profile)).bundles, ['@deepseek-ai/dsh-base', 'alpha', 'gamma'])
  } finally {
    await fixture.cleanup()
  }
})

test('restore rejects hash-matching content that is not a valid profile manifest', async () => {
  const fixture = await profileFixture()
  try {
    const before = await readProfile(fixture.home, fixture.profile)
    const applied = await applyRecovery({
      home: fixture.home,
      profile: fixture.profile,
      disableBundles: ['beta'],
      expectedManifestHash: before.hash,
    })
    const invalid = 'not-json\n'
    const invalidHash = sha256(invalid)
    const invalidName = `package.2026-01-01T00-00-00-000Z.${invalidHash}.json`
    await writeFile(join(fixture.profileDir, '.lifeboat-backups', invalidName), invalid)
    await assert.rejects(restoreRecovery({
      home: fixture.home,
      profile: fixture.profile,
      backupName: invalidName,
      expectedBackupHash: invalidHash,
      expectedManifestHash: applied.currentManifestHash,
    }), /not valid JSON/)
  } finally {
    await fixture.cleanup()
  }
})

test('restore accepts a legacy short-hash backup only with its full expected hash', async () => {
  const fixture = await profileFixture()
  try {
    const before = await readProfile(fixture.home, fixture.profile)
    const applied = await applyRecovery({
      home: fixture.home,
      profile: fixture.profile,
      disableBundles: ['beta'],
      expectedManifestHash: before.hash,
    })
    const legacyName = `package.2026-01-01T00-00-00-000Z.${before.hash.slice(0, 12)}.json`
    await writeFile(join(fixture.profileDir, '.lifeboat-backups', legacyName), before.raw)
    await assert.rejects(restoreRecovery({
      home: fixture.home,
      profile: fixture.profile,
      backupName: legacyName,
      expectedManifestHash: applied.currentManifestHash,
    }), /full expectedBackupHash/)
    const restored = await restoreRecovery({
      home: fixture.home,
      profile: fixture.profile,
      backupName: legacyName,
      expectedBackupHash: before.hash,
      expectedManifestHash: applied.currentManifestHash,
    })
    assert.equal(restored.backupHash, before.hash)
  } finally {
    await fixture.cleanup()
  }
})

test('recovery refuses a linked backup directory before writing outside the profile', async () => {
  const fixture = await profileFixture()
  const outside = join(fixture.root, 'outside-backups')
  try {
    await mkdir(outside)
    await symlink(
      outside,
      join(fixture.profileDir, '.lifeboat-backups'),
      process.platform === 'win32' ? 'junction' : 'dir',
    )
    const before = await readProfile(fixture.home, fixture.profile)
    await assert.rejects(applyRecovery({
      home: fixture.home,
      profile: fixture.profile,
      disableBundles: ['beta'],
      expectedManifestHash: before.hash,
    }), /real directory, not a symbolic link or junction/)
    assert.deepEqual(await readdir(outside), [])
    assert.equal((await readProfile(fixture.home, fixture.profile)).hash, before.hash)
  } finally {
    await fixture.cleanup()
  }
})

test('recovery serializes mutations with an owned per-profile lock', async () => {
  const fixture = await profileFixture()
  try {
    const before = await readProfile(fixture.home, fixture.profile)
    await writeFile(join(fixture.profileDir, '.dsh-lifeboat-recovery.lock'), `${JSON.stringify({
      schema: 'dsh-lifeboat-recovery-lock/v1',
      pid: process.pid,
      token: 'test-active-lock',
      createdAt: new Date().toISOString(),
    })}\n`)
    await assert.rejects(applyRecovery({
      home: fixture.home,
      profile: fixture.profile,
      disableBundles: ['beta'],
      expectedManifestHash: before.hash,
    }), error => {
      assert.equal(error.statusCode, 409)
      assert.match(error.message, /already running/)
      return true
    })
    assert.equal((await readProfile(fixture.home, fixture.profile)).hash, before.hash)
  } finally {
    await fixture.cleanup()
  }
})

test('recovery retires a lock owned by a process that no longer exists', async () => {
  const fixture = await profileFixture()
  const lockPath = join(fixture.profileDir, '.dsh-lifeboat-recovery.lock')
  try {
    const before = await readProfile(fixture.home, fixture.profile)
    await writeFile(lockPath, `${JSON.stringify({
      schema: 'dsh-lifeboat-recovery-lock/v1',
      pid: 2_147_483_647,
      token: 'test-stale-lock',
      createdAt: new Date(0).toISOString(),
    })}\n`)
    const applied = await applyRecovery({
      home: fixture.home,
      profile: fixture.profile,
      disableBundles: ['beta'],
      expectedManifestHash: before.hash,
    })
    assert.deepEqual(applied.disabledBundles, ['beta'])
    await assert.rejects(readFile(lockPath), error => error.code === 'ENOENT')
  } finally {
    await fixture.cleanup()
  }
})

test('concurrent recoveries cannot both commit from the same manifest snapshot', async () => {
  const fixture = await profileFixture()
  try {
    const before = await readProfile(fixture.home, fixture.profile)
    const results = await Promise.allSettled([
      applyRecovery({
        home: fixture.home,
        profile: fixture.profile,
        disableBundles: ['beta'],
        expectedManifestHash: before.hash,
      }),
      applyRecovery({
        home: fixture.home,
        profile: fixture.profile,
        disableBundles: ['gamma'],
        expectedManifestHash: before.hash,
      }),
    ])
    assert.equal(results.filter(result => result.status === 'fulfilled').length, 1)
    assert.equal(results.filter(result => result.status === 'rejected').length, 1)
    assert.equal(results.find(result => result.status === 'rejected').reason.statusCode, 409)
    const after = await readProfile(fixture.home, fixture.profile)
    assert.equal(after.bundles.length, before.bundles.length - 1)
  } finally {
    await fixture.cleanup()
  }
})
