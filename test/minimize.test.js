import assert from 'node:assert/strict'
import { test } from 'node:test'
import { minimizeFailingSet } from '../src/minimize.js'

test('isolates one independently failing item', async () => {
  const minimum = await minimizeFailingSet(['alpha', 'beta', 'gamma'], async items => items.includes('beta'))
  assert.deepEqual(minimum, ['beta'])
})

test('keeps a minimal interacting pair', async () => {
  const minimum = await minimizeFailingSet(
    ['alpha', 'beta', 'gamma', 'delta'],
    async items => items.includes('alpha') && items.includes('gamma'),
  )
  assert.deepEqual(minimum, ['alpha', 'gamma'])
})
