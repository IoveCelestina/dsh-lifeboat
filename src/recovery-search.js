function partition(items, count) {
  const groups = []
  for (let index = 0; index < count; index += 1) {
    const start = Math.floor(index * items.length / count)
    const end = Math.floor((index + 1) * items.length / count)
    groups.push(items.slice(start, end))
  }
  return groups.filter(group => group.length > 0)
}

function * combinations(items, size, start = 0, prefix = []) {
  if (prefix.length === size) {
    yield [...prefix]
    return
  }
  const remaining = size - prefix.length
  for (let index = start; index <= items.length - remaining; index += 1) {
    prefix.push(items[index])
    yield * combinations(items, size, index + 1, prefix)
    prefix.pop()
  }
}

function combinationCount(itemCount, size) {
  const selected = Math.min(size, itemCount - size)
  let result = 1n
  for (let index = 1; index <= selected; index += 1) {
    result = result * BigInt(itemCount - selected + index) / BigInt(index)
  }
  return result
}

function integerOption(value, fallback, minimum, maximum, name) {
  const selected = value ?? fallback
  if (!Number.isInteger(selected) || selected < minimum || selected > maximum) {
    throw new Error(`${name} must be an integer between ${minimum} and ${maximum}.`)
  }
  return selected
}

function normalizeSet(items, order) {
  return [...items].sort((left, right) => order.get(left) - order.get(right))
}

function setKey(items, order) {
  return JSON.stringify(normalizeSet(items, order))
}

function compareSets(left, right, order) {
  for (let index = 0; index < Math.min(left.length, right.length); index += 1) {
    const difference = order.get(left[index]) - order.get(right[index])
    if (difference !== 0) return difference
  }
  return left.length - right.length
}

async function minimizeRecoveringSet(initial, evaluate, onStep) {
  let current = [...initial]
  if (current.length <= 1) return { bundles: current, completed: true }
  let granularity = 2

  while (current.length >= 2) {
    const subsets = partition(current, granularity)
    let reduced = false

    for (const subset of subsets) {
      onStep({ phase: 'upper-bound', kind: 'subset', size: subset.length, total: current.length })
      const result = await evaluate(subset, 'upper-bound')
      if (result.exhausted) {
        return { bundles: current, completed: false, reason: result.reason }
      }
      if (result.recovers) {
        current = subset
        granularity = Math.max(2, granularity - 1)
        reduced = true
        break
      }
    }
    if (reduced) continue

    for (const subset of subsets) {
      const excluded = new Set(subset)
      const complement = current.filter(item => !excluded.has(item))
      if (complement.length === 0) continue
      onStep({ phase: 'upper-bound', kind: 'complement', size: complement.length, total: current.length })
      const result = await evaluate(complement, 'upper-bound')
      if (result.exhausted) {
        return { bundles: current, completed: false, reason: result.reason }
      }
      if (result.recovers) {
        current = complement
        granularity = Math.max(2, granularity - 1)
        reduced = true
        break
      }
    }
    if (reduced) continue
    if (granularity >= current.length) break
    granularity = Math.min(current.length, granularity * 2)
  }
  return { bundles: current, completed: true }
}

function materializePlans(bundleSets, optimality, order) {
  return [...bundleSets]
    .map(bundles => normalizeSet(bundles, order))
    .sort((left, right) => compareSets(left, right, order))
    .map((bundles, index) => ({
      id: `recovery-${index + 1}`,
      bundles,
      optimality,
      removalSize: bundles.length,
    }))
}

/**
 * Find verified bundle-removal plans with an upper-bound-first strategy.
 *
 * Delta debugging first finds a small known-recovering set under a bounded
 * share of the budget. Exact enumeration then only needs to disprove smaller
 * cardinalities. A plan is labelled exact iff every smaller cardinality was
 * exhausted; an incomplete upper bound is never returned as one-minimal.
 */
export async function findRecoveryPlans(items, recovers, options = {}) {
  const candidates = [...new Set(items)]
  const order = new Map(candidates.map((item, index) => [item, index]))
  const maxTests = integerOption(options.maxTests, 256, 1, 4_096, 'maxTests')
  const maxExactRemovalSize = integerOption(
    options.maxExactRemovalSize,
    2,
    1,
    8,
    'maxExactRemovalSize',
  )
  const maxAlternatives = integerOption(options.maxAlternatives, 8, 1, 32, 'maxAlternatives')
  const alternativeBudget = Math.min(maxTests, integerOption(
    options.maxAlternativeTests,
    Math.min(32, Math.max(4, Math.floor(maxTests / 16))),
    0,
    1_024,
    'maxAlternativeTests',
  ))
  const onStep = options.onStep ?? (() => {})
  const upperBoundBudget = Math.max(1, Math.floor(maxTests / 2))
  const cache = new Map()
  let tests = 0
  let upperBoundTests = 0
  let alternativeTests = 0
  let exactThrough = 0
  let proofBudget = maxTests

  const searchMetadata = extra => ({
    strategy: 'upper-bound-first',
    tests,
    budget: maxTests,
    upperBoundTests,
    upperBoundBudget,
    proofTests: tests - upperBoundTests - alternativeTests,
    proofBudget,
    alternativeTests,
    alternativeBudget,
    exactThrough,
    ...extra,
  })

  if (candidates.length === 0) {
    return {
      plans: [],
      search: searchMetadata({
        alternativesComplete: true,
        exhausted: false,
        reason: 'no-candidates',
      }),
    }
  }

  cache.set(setKey([], order), false)
  if (options.allRemovedRecovers === true) cache.set(setKey(candidates, order), true)

  const evaluate = async (removed, phase) => {
    const normalized = normalizeSet(removed, order)
    const key = setKey(normalized, order)
    if (cache.has(key)) return { recovers: cache.get(key), cached: true, exhausted: false }
    if (tests >= maxTests) return { exhausted: true, reason: 'budget-exhausted' }
    if (phase.startsWith('upper-bound') && upperBoundTests >= upperBoundBudget) {
      return { exhausted: true, reason: 'upper-bound-budget-exhausted' }
    }
    if (phase === 'alternatives' && alternativeTests >= alternativeBudget) {
      return { exhausted: true, reason: 'alternative-budget-exhausted' }
    }
    tests += 1
    if (phase.startsWith('upper-bound')) upperBoundTests += 1
    if (phase === 'alternatives') alternativeTests += 1
    onStep({ phase, kind: 'probe', removed: normalized, test: tests, budget: maxTests })
    const value = await recovers(normalized)
    cache.set(key, value)
    return { recovers: value, cached: false, exhausted: false }
  }

  const enumerateCardinality = async (size, phase, knownPlans = []) => {
    const plans = new Map(knownPlans.map(plan => [setKey(plan, order), normalizeSet(plan, order)]))
    const total = combinationCount(candidates.length, size)
    if (BigInt(plans.size) === total) {
      return { plans: [...plans.values()], completed: true, visited: total, total }
    }
    let visited = 0n
    let stopReason
    for (const removed of combinations(candidates, size)) {
      if (plans.size >= maxAlternatives) {
        stopReason = 'alternative-limit'
        break
      }
      const result = await evaluate(removed, plans.size > 0 ? 'alternatives' : phase)
      if (result.exhausted) {
        stopReason = result.reason
        break
      }
      visited += 1n
      if (result.recovers) plans.set(setKey(removed, order), [...removed])
    }
    return {
      plans: [...plans.values()],
      completed: visited === total,
      stopReason,
      visited,
      total,
    }
  }

  if (options.allRemovedRecovers !== true) {
    const result = await evaluate(candidates, 'upper-bound-baseline')
    if (result.exhausted || !result.recovers) {
      return {
        plans: [],
        search: searchMetadata({
          alternativesComplete: false,
          exhausted: result.exhausted,
          reason: result.exhausted ? result.reason : 'all-removed-still-fails',
        }),
      }
    }
  }

  const upperBound = await minimizeRecoveringSet(candidates, evaluate, onStep)
  proofBudget = maxTests - tests
  const proofLimit = Math.min(
    maxExactRemovalSize,
    Math.max(0, upperBound.bundles.length - 1),
    candidates.length,
  )
  let proofExhausted = false
  let proofStopReason

  for (let size = 1; size <= proofLimit; size += 1) {
    const exact = await enumerateCardinality(size, 'proof')
    if (exact.plans.length > 0) {
      return {
        plans: materializePlans(exact.plans, 'exact', order),
        search: searchMetadata({
          upperBoundSize: upperBound.bundles.length,
          upperBoundComplete: upperBound.completed,
          minimumRemovalSize: size,
          alternativesComplete: exact.completed,
          alternativesStopReason: exact.stopReason,
          exhausted: false,
        }),
      }
    }
    if (!exact.completed) {
      proofExhausted = exact.stopReason === 'budget-exhausted'
      proofStopReason = exact.stopReason
      break
    }
    exactThrough = size
  }

  if (exactThrough >= upperBound.bundles.length - 1) {
    const alternatives = await enumerateCardinality(
      upperBound.bundles.length,
      'alternatives',
      [upperBound.bundles],
    )
    return {
      plans: materializePlans(alternatives.plans, 'exact', order),
      search: searchMetadata({
        upperBoundSize: upperBound.bundles.length,
        upperBoundComplete: upperBound.completed,
        minimumRemovalSize: upperBound.bundles.length,
        alternativesComplete: alternatives.completed,
        alternativesStopReason: alternatives.stopReason,
        proofExhausted,
        exhausted: false,
      }),
    }
  }

  if (upperBound.completed) {
    return {
      plans: materializePlans([upperBound.bundles], 'one-minimal', order),
      search: searchMetadata({
        upperBoundSize: upperBound.bundles.length,
        upperBoundComplete: true,
        alternativesComplete: false,
        proofExhausted,
        proofStopReason,
        exhausted: false,
      }),
    }
  }

  return {
    plans: [],
    search: searchMetadata({
      upperBoundSize: upperBound.bundles.length,
      upperBoundComplete: false,
      alternativesComplete: false,
      proofExhausted,
      exhausted: true,
      reason: proofStopReason ?? upperBound.reason ?? 'upper-bound-incomplete',
      boundedCandidate: upperBound.bundles,
    }),
  }
}
