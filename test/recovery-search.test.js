import assert from 'node:assert/strict'
import { test } from 'node:test'
import { findRecoveryPlans } from '../src/recovery-search.js'

const ITEMS = ['alpha', 'beta', 'gamma']

function recoveryPredicate(fails, items = ITEMS) {
  return async removed => {
    const removedSet = new Set(removed)
    const active = items.filter(item => !removedSet.has(item))
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
  const items = ['alpha', 'beta', 'gamma', 'delta']
  const result = await findRecoveryPlans(
    items,
    recoveryPredicate(
      active => active.includes('alpha') || active.includes('gamma') || active.includes('delta'),
      items,
    ),
    { allRemovedRecovers: true, maxExactRemovalSize: 1 },
  )
  assert.deepEqual(result.plans[0].bundles, ['alpha', 'gamma', 'delta'])
  assert.equal(result.plans[0].optimality, 'one-minimal')
  assert.equal(result.search.alternativesComplete, false)
})

test('promotes a minimized pair to exact after exhausting every singleton', async () => {
  const result = await findRecoveryPlans(
    ITEMS,
    recoveryPredicate(active => active.includes('alpha') || active.includes('gamma')),
    { allRemovedRecovers: true, maxExactRemovalSize: 1 },
  )
  assert.deepEqual(result.plans[0].bundles, ['alpha', 'gamma'])
  assert.equal(result.plans[0].optimality, 'exact')
  assert.equal(result.search.exactThrough, 1)
  assert.equal(result.search.minimumRemovalSize, 2)
})

test('finds and proves a sparse pair without enumerating exact pairs first', async () => {
  const items = Array.from({ length: 16 }, (_, index) => `plugin-${index}`)
  let calls = 0
  const result = await findRecoveryPlans(
    items,
    async removed => {
      calls += 1
      const removedSet = new Set(removed)
      return removedSet.has('plugin-14') && removedSet.has('plugin-15')
    },
    { allRemovedRecovers: true, maxExactRemovalSize: 2, maxTests: 256 },
  )
  assert.deepEqual(result.plans[0].bundles, ['plugin-14', 'plugin-15'])
  assert.equal(result.plans[0].optimality, 'exact')
  assert.equal(result.search.exactThrough, 1)
  assert.equal(result.search.strategy, 'upper-bound-first')
  assert.ok(calls <= 40, `expected at most 40 probes, received ${calls}`)
  assert.equal(result.search.alternativeTests, result.search.alternativeBudget)
})

test('keeps exact optimality when the alternative cap stops same-size enumeration', async () => {
  const result = await findRecoveryPlans(
    ITEMS,
    recoveryPredicate(active => active.length === ITEMS.length),
    { allRemovedRecovers: true, maxAlternatives: 2 },
  )
  assert.equal(result.plans.length, 2)
  assert.ok(result.plans.every(plan => plan.optimality === 'exact'))
  assert.equal(result.search.alternativesComplete, false)
  assert.equal(result.search.alternativesStopReason, 'alternative-limit')
})

test('returns a completed one-minimal upper bound when only the exact proof exhausts its budget', async () => {
  const items = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h']
  const result = await findRecoveryPlans(
    items,
    async removed => {
      const removedSet = new Set(removed)
      return removedSet.has('f') && removedSet.has('g') && removedSet.has('h')
    },
    {
      allRemovedRecovers: true,
      maxExactRemovalSize: 2,
      maxTests: 22,
      maxAlternativeTests: 0,
    },
  )
  assert.deepEqual(result.plans[0].bundles, ['f', 'g', 'h'])
  assert.equal(result.plans[0].optimality, 'one-minimal')
  assert.equal(result.search.upperBoundComplete, true)
  assert.equal(result.search.proofExhausted, true)
  assert.equal(result.search.exhausted, false)
})

test('exact proof can salvage a minimum plan from an incomplete upper bound', async () => {
  const items = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h']
  const result = await findRecoveryPlans(
    items,
    async removed => removed.includes('a'),
    { allRemovedRecovers: true, maxExactRemovalSize: 1, maxTests: 4 },
  )
  assert.deepEqual(result.plans[0].bundles, ['a'])
  assert.equal(result.plans[0].optimality, 'exact')
  assert.equal(result.search.upperBoundComplete, false)
  assert.equal(result.search.minimumRemovalSize, 1)
  assert.equal(result.search.exhausted, false)
})

test('handles empty candidates and an all-removed baseline that still fails', async () => {
  let calls = 0
  const empty = await findRecoveryPlans([], async () => { calls += 1 })
  assert.deepEqual(empty.plans, [])
  assert.equal(empty.search.reason, 'no-candidates')
  assert.equal(calls, 0)

  const unrecoverable = await findRecoveryPlans(ITEMS, async () => {
    calls += 1
    return false
  })
  assert.deepEqual(unrecoverable.plans, [])
  assert.equal(unrecoverable.search.reason, 'all-removed-still-fails')
  assert.equal(unrecoverable.search.exhausted, false)
  assert.equal(calls, 1)
})

test('marks the only singleton plan and its alternatives as complete without probing', async () => {
  let calls = 0
  const result = await findRecoveryPlans(['only-plugin'], async () => {
    calls += 1
    return true
  }, { allRemovedRecovers: true, maxAlternatives: 1 })
  assert.deepEqual(result.plans[0].bundles, ['only-plugin'])
  assert.equal(result.plans[0].optimality, 'exact')
  assert.equal(result.search.alternativesComplete, true)
  assert.equal(calls, 0)
})

test('matches brute minimum cardinality across deterministic monotone recovery predicates', async () => {
  const items = ['a', 'b', 'c', 'd', 'e', 'f']
  let state = 0x5eed1234
  const random = maximum => {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0
    return state % maximum
  }
  for (let scenario = 0; scenario < 20; scenario += 1) {
    const requirements = []
    for (let index = 0; index < 1 + random(3); index += 1) {
      const size = 1 + random(4)
      const shuffled = [...items]
      for (let position = shuffled.length - 1; position > 0; position -= 1) {
        const selected = random(position + 1)
        const held = shuffled[position]
        shuffled[position] = shuffled[selected]
        shuffled[selected] = held
      }
      requirements.push(shuffled.slice(0, size))
    }
    const expectedSize = Math.min(...requirements.map(requirement => requirement.length))
    const result = await findRecoveryPlans(
      items,
      async removed => {
        const removedSet = new Set(removed)
        return requirements.some(requirement => requirement.every(item => removedSet.has(item)))
      },
      {
        allRemovedRecovers: true,
        maxExactRemovalSize: 5,
        maxTests: 4_096,
        maxAlternativeTests: 256,
        maxAlternatives: 32,
      },
    )
    assert.ok(result.plans.length > 0, `scenario ${scenario} returned no plan`)
    assert.ok(result.plans.every(plan => plan.optimality === 'exact'))
    assert.ok(result.plans.every(plan => plan.removalSize === expectedSize))
  }
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
