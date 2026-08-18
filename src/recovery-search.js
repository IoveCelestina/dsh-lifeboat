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

function integerOption(value, fallback, minimum, maximum, name) {
  const selected = value ?? fallback
  if (!Number.isInteger(selected) || selected < minimum || selected > maximum) {
    throw new Error(`${name} must be an integer between ${minimum} and ${maximum}.`)
  }
  return selected
}

function setKey(items, order) {
  return JSON.stringify([...items].sort((left, right) => order.get(left) - order.get(right)))
}

async function minimizeRecoveringSet(initial, evaluate, onStep) {
  let current = [...initial]
  if (current.length <= 1) return { bundles: current, completed: true }
  let granularity = 2

  while (current.length >= 2) {
    const subsets = partition(current, granularity)
    let reduced = false

    for (const subset of subsets) {
      onStep({ phase: 'fallback', kind: 'subset', size: subset.length, total: current.length })
      const result = await evaluate(subset, 'fallback')
      if (result.exhausted) return { bundles: current, completed: false }
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
      onStep({ phase: 'fallback', kind: 'complement', size: complement.length, total: current.length })
      const result = await evaluate(complement, 'fallback')
      if (result.exhausted) return { bundles: current, completed: false }
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

/**
 * Find bundle removals that make the complete profile pass.
 *
 * Small removal cardinalities are searched exactly. If that bounded search
 * does not find a plan, delta debugging minimizes a known-recovering removal
 * set. An incomplete fallback is evidence only and is never returned as an
 * applicable recovery plan.
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
  const onStep = options.onStep ?? (() => {})
  const cache = new Map()
  cache.set(setKey([], order), false)
  if (options.allRemovedRecovers === true) cache.set(setKey(candidates, order), true)
  let tests = 0
  let exactThrough = 0
  const exactBudget = Math.min(maxTests, Math.max(Math.min(candidates.length, maxTests), Math.floor(maxTests / 2)))

  const evaluate = async (removed, phase) => {
    const normalized = [...removed].sort((left, right) => order.get(left) - order.get(right))
    const key = setKey(normalized, order)
    if (cache.has(key)) return { recovers: cache.get(key), cached: true, exhausted: false }
    if (tests >= maxTests) return { exhausted: true }
    tests += 1
    onStep({ phase, kind: 'probe', removed: normalized, test: tests, budget: maxTests })
    const value = await recovers(normalized)
    cache.set(key, value)
    return { recovers: value, cached: false, exhausted: false }
  }

  const exactLimit = Math.min(maxExactRemovalSize, candidates.length)
  for (let size = 1; size <= exactLimit; size += 1) {
    const plans = []
    let completed = true
    for (const removed of combinations(candidates, size)) {
      if (tests >= exactBudget) {
        completed = false
        break
      }
      const result = await evaluate(removed, 'exact')
      if (result.exhausted) {
        completed = false
        break
      }
      if (result.recovers) {
        plans.push({
          id: `recovery-${plans.length + 1}`,
          bundles: [...removed],
          optimality: 'exact',
          removalSize: size,
        })
        if (plans.length >= maxAlternatives) {
          completed = false
          break
        }
      }
    }
    if (plans.length > 0) {
      return {
        plans,
        search: {
          tests,
          budget: maxTests,
          exactBudget,
          exactThrough: size - 1,
          alternativesComplete: completed,
          exhausted: false,
        },
      }
    }
    if (!completed) break
    exactThrough = size
  }

  let allRemovedRecovers = options.allRemovedRecovers === true
  if (!allRemovedRecovers) {
    const result = await evaluate(candidates, 'fallback-baseline')
    if (result.exhausted || !result.recovers) {
      return {
        plans: [],
        search: {
          tests,
          budget: maxTests,
          exactBudget,
          exactThrough,
          alternativesComplete: false,
          exhausted: result.exhausted,
          reason: result.exhausted ? 'budget-exhausted' : 'all-removed-still-fails',
        },
      }
    }
    allRemovedRecovers = true
  }

  const fallback = await minimizeRecoveringSet(candidates, evaluate, onStep)
  if (!fallback.completed) {
    return {
      plans: [],
      search: {
        tests,
        budget: maxTests,
        exactBudget,
        exactThrough,
        alternativesComplete: false,
        exhausted: true,
        reason: 'budget-exhausted',
        boundedCandidate: fallback.bundles,
      },
    }
  }
  return {
    plans: [{
      id: 'recovery-1',
      bundles: fallback.bundles,
      optimality: 'one-minimal',
      removalSize: fallback.bundles.length,
    }],
    search: {
      tests,
      budget: maxTests,
      exactBudget,
      exactThrough,
      alternativesComplete: true,
      exhausted: false,
    },
  }
}
