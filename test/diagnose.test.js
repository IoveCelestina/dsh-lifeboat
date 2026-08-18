import assert from 'node:assert/strict'
import { test } from 'node:test'
import { diagnoseProfile } from '../src/diagnose.js'
import { fakeProbe, profileFixture } from './helpers.js'

test('diagnosis isolates one failing community bundle', async () => {
  const fixture = await profileFixture()
  try {
    const report = await diagnoseProfile({ home: fixture.home, profile: fixture.profile }, {
      probeRunner: fakeProbe(({ bundles }) => bundles.includes('beta')),
    })
    assert.equal(report.status, 'completed')
    assert.equal(report.finding.code, 'plugin-set')
    assert.deepEqual(report.finding.bundles, ['beta'])
    assert.deepEqual(report.recovery.bundles, ['beta'])
  } finally {
    await fixture.cleanup()
  }
})

test('diagnosis preserves a minimal pair conflict', async () => {
  const fixture = await profileFixture()
  try {
    const report = await diagnoseProfile({ home: fixture.home, profile: fixture.profile }, {
      probeRunner: fakeProbe(({ bundles }) => bundles.includes('alpha') && bundles.includes('gamma')),
    })
    assert.equal(report.finding.code, 'plugin-set')
    assert.deepEqual(report.finding.bundles, ['alpha', 'gamma'])
  } finally {
    await fixture.cleanup()
  }
})

test('diagnosis distinguishes a failing profile patch', async () => {
  const fixture = await profileFixture({ profilePatch: 'BROKEN_PROFILE\n' })
  try {
    const report = await diagnoseProfile({ home: fixture.home, profile: fixture.profile }, {
      probeRunner: fakeProbe(({ profilePatch }) => profilePatch.includes('BROKEN_PROFILE')),
    })
    assert.equal(report.finding.code, 'profile-patch')
    assert.equal(report.recovery, undefined)
  } finally {
    await fixture.cleanup()
  }
})

test('runtime diagnosis requires explicit code-execution acknowledgement', async () => {
  await assert.rejects(
    diagnoseProfile({ mode: 'boot', profile: 'web' }),
    /allowRuntimeCodeExecution/,
  )
})

test('runtime diagnosis refuses recovery when fresh confirmation attempts disagree', async () => {
  const fixture = await profileFixture()
  const homes = []
  let attempt = 0
  try {
    const report = await diagnoseProfile({
      home: fixture.home,
      profile: fixture.profile,
      mode: 'boot',
      bootConfirmations: 2,
      allowRuntimeCodeExecution: true,
    }, {
      probeRunner: async options => {
        homes.push(options.home)
        attempt += 1
        const failed = attempt % 2 === 1
        return {
          command: 'fake-dsh',
          args: [],
          mode: 'boot',
          status: failed ? 'fail' : 'pass',
          reason: failed ? 'fixture-failure' : 'boot-window-survived',
          durationMs: 1,
          stdout: '',
          stderr: '',
          outputTruncated: false,
        }
      },
    })
    assert.equal(report.status, 'completed')
    assert.equal(report.finding.code, 'unstable-probe')
    assert.equal(report.recovery, undefined)
    assert.equal(report.probes[0].status, 'unstable')
    assert.equal(new Set(homes).size, 2)
  } finally {
    await fixture.cleanup()
  }
})

test('stops before probing when the candidate set exceeds the configured limit', async () => {
  const fixture = await profileFixture()
  let calls = 0
  try {
    const report = await diagnoseProfile({
      home: fixture.home,
      profile: fixture.profile,
      maxCandidateBundles: 2,
    }, {
      probeRunner: async () => { calls += 1 },
    })
    assert.equal(report.status, 'completed')
    assert.equal(report.finding.code, 'candidate-limit')
    assert.equal(report.recovery, undefined)
    assert.equal(calls, 0)
  } finally {
    await fixture.cleanup()
  }
})
