function partition(items, count) {
  const groups = []
  for (let index = 0; index < count; index += 1) {
    const start = Math.floor(index * items.length / count)
    const end = Math.floor((index + 1) * items.length / count)
    groups.push(items.slice(start, end))
  }
  return groups.filter(group => group.length > 0)
}

/**
 * Find a 1-minimal failure-inducing subset with classic delta debugging.
 * The caller owns probe caching and must return true only for a reproduced failure.
 */
export async function minimizeFailingSet(items, fails, onStep = () => {}) {
  let current = [...items]
  if (current.length <= 1) return current
  let granularity = 2

  while (current.length >= 2) {
    const subsets = partition(current, granularity)
    let reduced = false

    for (const subset of subsets) {
      onStep({ kind: 'subset', size: subset.length, total: current.length })
      if (await fails(subset)) {
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
      onStep({ kind: 'complement', size: complement.length, total: current.length })
      if (await fails(complement)) {
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
  return current
}
