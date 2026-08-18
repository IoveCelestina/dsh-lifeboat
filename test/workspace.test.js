import assert from 'node:assert/strict'
import { access, mkdir, readFile, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'
import { readProfile } from '../src/manifest.js'
import { createProbeWorkspace } from '../src/workspace.js'
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
