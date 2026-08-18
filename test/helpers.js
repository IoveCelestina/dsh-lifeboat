import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** Create a disposable Harness home with one initialized profile. */
export async function profileFixture(options = {}) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-lifeboat-test-'))
  const home = join(root, '.dsh')
  const profile = options.profile ?? 'web'
  const profileDir = join(home, 'profiles', profile)
  await mkdir(profileDir, { recursive: true })
  const bundles = options.bundles ?? ['@deepseek-ai/dsh-base', 'alpha', 'beta', 'gamma']
  const dependencies = options.dependencies ?? Object.fromEntries(
    bundles.filter(name => !name.startsWith('@deepseek-ai/')).map(name => [name, '1.0.0']),
  )
  await writeFile(join(profileDir, 'package.json'), `${JSON.stringify({
    name: `dsh-profile-${profile}`,
    private: true,
    dependencies,
    dsh: { profile: { bundles } },
  }, null, 2)}\n`)
  await writeFile(join(profileDir, 'cordis.patch.yml'), options.profilePatch ?? '[]\n')
  await writeFile(join(home, 'cordis.patch.yml'), options.homePatch ?? '[]\n')
  return {
    root,
    home,
    profile,
    profileDir,
    async cleanup() { await rm(root, { recursive: true, force: true }) },
  }
}

/** Return a deterministic probe runner based on the staged candidate manifest and patch files. */
export function fakeProbe(predicate) {
  return async options => {
    const { readFile } = await import('node:fs/promises')
    const { join } = await import('node:path')
    const profileDir = join(options.home, 'profiles', options.profile)
    const manifest = JSON.parse(await readFile(join(profileDir, 'package.json'), 'utf8'))
    const profilePatch = await readFile(join(profileDir, 'cordis.patch.yml'), 'utf8')
    const homePatch = await readFile(join(options.home, 'cordis.patch.yml'), 'utf8')
    const failed = predicate({
      bundles: manifest.dsh.profile.bundles,
      profilePatch,
      homePatch,
    })
    return {
      command: 'fake-dsh',
      args: [],
      mode: 'config',
      status: failed ? 'fail' : 'pass',
      reason: failed ? 'fixture-failure' : 'clean-exit',
      exitCode: failed ? 1 : 0,
      signal: null,
      timedOut: false,
      durationMs: 1,
      stdout: '',
      stderr: failed ? 'fixture failed' : '',
      outputTruncated: false,
    }
  }
}
