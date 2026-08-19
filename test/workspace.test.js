import assert from 'node:assert/strict'
import { access, mkdir, readFile, symlink, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'
import { readProfile } from '../src/manifest.js'
import { createProbeSnapshot, createProbeWorkspace } from '../src/workspace.js'
import { profileFixture } from './helpers.js'

test('probe workspace skips credential assets and resolves linked packages from their real target', async () => {
  const fixture = await profileFixture({ bundles: ['@deepseek-ai/dsh-base', 'demo'], dependencies: { demo: 'link:demo' } })
  const packageDir = join(fixture.root, 'demo-package')
  await mkdir(packageDir, { recursive: true })
  await writeFile(join(packageDir, 'package.json'), '{"name":"demo","version":"0.0.0"}\n')
  await writeFile(join(fixture.profileDir, '.env'), 'API_KEY=must-not-copy\n')
  await writeFile(join(fixture.profileDir, 'safe.txt'), 'safe\n')
  await mkdir(join(fixture.profileDir, 'node_modules'), { recursive: true })
  await symlink(packageDir, join(fixture.profileDir, 'node_modules', 'demo'), process.platform === 'win32' ? 'junction' : 'dir')

  const profile = await readProfile(fixture.home, fixture.profile)
  const workspace = await createProbeWorkspace(profile)
  try {
    assert.equal(await readFile(join(workspace.profileDir, 'safe.txt'), 'utf8'), 'safe\n')
    await assert.rejects(access(join(workspace.profileDir, '.env')))
    assert.match(workspace.warnings.join('\n'), /credential-bearing profile asset/)
    assert.equal(
      JSON.parse(await readFile(join(workspace.profileDir, 'node_modules', 'demo', 'package.json'), 'utf8')).name,
      'demo',
    )
  } finally {
    await workspace.cleanup()
    await fixture.cleanup()
  }
})

test('one diagnosis snapshot keeps patches, assets, and package targets stable across fresh workspaces', async () => {
  const fixture = await profileFixture({
    bundles: ['@deepseek-ai/dsh-base', 'demo'],
    dependencies: { demo: 'link:demo' },
    profilePatch: 'ORIGINAL_PROFILE_PATCH\n',
    homePatch: 'ORIGINAL_HOME_PATCH\n',
  })
  const firstPackage = join(fixture.root, 'demo-package-one')
  const secondPackage = join(fixture.root, 'demo-package-two')
  const liveLink = join(fixture.profileDir, 'node_modules', 'demo')
  let snapshot
  let firstWorkspace
  let secondWorkspace
  try {
    await mkdir(firstPackage)
    await mkdir(secondPackage)
    await writeFile(join(firstPackage, 'package.json'), '{"name":"demo","version":"1.0.0"}\n')
    await writeFile(join(secondPackage, 'package.json'), '{"name":"demo","version":"2.0.0"}\n')
    await writeFile(join(fixture.profileDir, 'safe.txt'), 'snapshot-value\n')
    await mkdir(join(fixture.profileDir, 'node_modules'))
    await symlink(firstPackage, liveLink, process.platform === 'win32' ? 'junction' : 'dir')

    const profile = await readProfile(fixture.home, fixture.profile)
    snapshot = await createProbeSnapshot(profile)
    await writeFile(join(fixture.profileDir, 'safe.txt'), 'live-value\n')
    await writeFile(join(fixture.profileDir, 'cordis.patch.yml'), 'CHANGED_PROFILE_PATCH\n')
    await writeFile(join(fixture.home, 'cordis.patch.yml'), 'CHANGED_HOME_PATCH\n')
    await unlink(liveLink)
    await symlink(secondPackage, liveLink, process.platform === 'win32' ? 'junction' : 'dir')

    firstWorkspace = await snapshot.createWorkspace()
    assert.equal(await readFile(join(firstWorkspace.profileDir, 'safe.txt'), 'utf8'), 'snapshot-value\n')
    assert.equal(await readFile(join(firstWorkspace.profileDir, 'cordis.patch.yml'), 'utf8'), 'ORIGINAL_PROFILE_PATCH\n')
    assert.equal(await readFile(join(firstWorkspace.home, 'cordis.patch.yml'), 'utf8'), 'ORIGINAL_HOME_PATCH\n')
    assert.equal(
      JSON.parse(await readFile(join(firstWorkspace.profileDir, 'node_modules', 'demo', 'package.json'), 'utf8')).version,
      '1.0.0',
    )

    await writeFile(join(firstWorkspace.profileDir, 'safe.txt'), 'attempt-local-change\n')
    secondWorkspace = await snapshot.createWorkspace()
    assert.equal(await readFile(join(secondWorkspace.profileDir, 'safe.txt'), 'utf8'), 'snapshot-value\n')
    const current = await snapshot.readCurrentFingerprint()
    assert.notEqual(current.fingerprint.hash, snapshot.fingerprint.hash)
    assert.notEqual(current.fingerprint.assetHash, snapshot.fingerprint.assetHash)
    assert.notEqual(current.fingerprint.packageHash, snapshot.fingerprint.packageHash)
  } finally {
    await firstWorkspace?.cleanup()
    await secondWorkspace?.cleanup()
    await snapshot?.cleanup()
    await fixture.cleanup()
  }
})
