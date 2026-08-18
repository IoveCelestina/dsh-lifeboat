import assert from 'node:assert/strict'
import { test } from 'node:test'
import { findRecoveryPlans } from '../src/recovery-search.js'

const ITEMS = ['alpha', 'beta', 'gamma']

function recoveryPredicate(fails) {
  return async removed => {
    const removedSet = new Set(removed)
    const active = ITEMS.filter(item => !removedSet.has(item))
    return !fails(active)
  }
}

test('returns each exact singleton alternative for a pair interaction', async () => {
  const result = await findRecoveryPlans(
    ITEMS,
    recoveryPredicate(active => active.includes('alpha') && active.includes('gamma')),
    { allRemovedRecovers: true },
  )
  assert.deepEqual(result.plans.map(plan => plan.bundles), [['alpha'], ['gamma']])
  assert.ok(result.plans.every(plan => plan.optimality === 'exact'))
  assert.equal(result.search.alternativesComplete, true)
})

test('returns an exact pair when two bundles fail independently', async () => {
  const result = await findRecoveryPlans(
    ITEMS,
    recoveryPredicate(active => active.includes('alpha') || active.includes('gamma')),
    { allRemovedRecovers: true },
  )
  assert.deepEqual(result.plans.map(plan => plan.bundles), [['alpha', 'gamma']])
  assert.equal(result.plans[0].removalSize, 2)
  assert.equal(result.plans[0].optimality, 'exact')
})

test('falls back to a one-minimal verified removal set', async () => {
  const result = await findRecoveryPlans(
    ITEMS,
    recoveryPredicate(active => active.includes('alpha') || active.includes('gamma')),
    { allRemovedRecovers: true, maxExactRemovalSize: 1 },
  )
  assert.deepEqual(result.plans[0].bundles, ['alpha', 'gamma'])
  assert.equal(result.plans[0].optimality, 'one-minimal')
})

test('does not return a recovery when the search budget expires', async () => {
  const result = await findRecoveryPlans(
    ITEMS,
    recoveryPredicate(active => active.includes('alpha') || active.includes('gamma')),
    { allRemovedRecovers: true, maxTests: 1 },
  )
  assert.deepEqual(result.plans, [])
  assert.equal(result.search.exhausted, true)
  assert.equal(result.search.reason, 'budget-exhausted')
})
