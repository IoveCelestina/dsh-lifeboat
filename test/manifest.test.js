import assert from 'node:assert/strict'
import { test } from 'node:test'
import { classifyBundles, listProfiles, readProfile, validateProfileName } from '../src/manifest.js'
import { profileFixture } from './helpers.js'

test('reads a profile and classifies only dependency-backed bundles as suspects', async () => {
  const fixture = await profileFixture()
  try {
    const profile = await readProfile(fixture.home, fixture.profile)
    assert.deepEqual(classifyBundles(profile), {
      protectedBundles: ['@deepseek-ai/dsh-base'],
      suspects: ['alpha', 'beta', 'gamma'],
    })
    assert.deepEqual(await listProfiles(fixture.home), ['web'])
    assert.match(profile.hash, /^[a-f0-9]{64}$/)
  } finally {
    await fixture.cleanup()
  }
})

test('rejects profile names that can escape the profile root', () => {
  for (const name of ['', '.', '..', 'node_modules', '../web', 'a/b', 'a\\b']) {
    assert.throws(() => validateProfileName(name), /Invalid profile name/)
  }
})
