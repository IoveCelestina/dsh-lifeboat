import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { test } from 'node:test'

class FakeElement {
  constructor() {
    this.children = []
    this.dataset = {}
    this.listeners = new Map()
    this.hidden = false
    this.disabled = false
    this.textContent = ''
    this.value = ''
  }

  addEventListener(name, listener) {
    this.listeners.set(name, listener)
  }

  append(...children) {
    this.children.push(...children)
  }

  replaceChildren(...children) {
    this.children = children
  }

  setAttribute(name, value) {
    this[name] = value
  }
}

async function waitFor(predicate) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return
    await new Promise(resolve => setImmediate(resolve))
  }
  throw new Error('Timed out waiting for the client bootstrap.')
}

test('recent reports reopen and replace stale evidence with explicit empty states', async () => {
  const originalDocument = globalThis.document
  const originalFetch = globalThis.fetch
  const originalSessionStorage = globalThis.sessionStorage
  const elements = new Map()
  const element = selector => {
    if (!elements.has(selector)) elements.set(selector, new FakeElement())
    return elements.get(selector)
  }
  const form = element('#diagnose-form')
  form.elements = { mode: { value: 'config' } }
  element('#trace-list').children = [{ textContent: 'stale trace' }]
  element('#evidence-body').children = [{ textContent: 'stale evidence' }]
  element('#warning-list').children = [{ textContent: 'stale warning' }]
  element('#recovery-panel').hidden = false

  const id = randomUUID()
  const recent = {
    id,
    status: 'failed',
    savedAt: '2026-08-19T01:00:00.000Z',
    profile: 'web',
    finding: undefined,
    recoveryPending: false,
  }
  const job = {
    id,
    status: 'failed',
    events: [],
    error: 'The service restarted before the diagnosis finished.',
  }
  const session = new Map()
  try {
    globalThis.document = {
      querySelector: element,
      querySelectorAll: () => [],
      createElement: () => new FakeElement(),
    }
    globalThis.sessionStorage = {
      getItem: key => session.get(key) ?? null,
      setItem: (key, value) => session.set(key, value),
      removeItem: key => session.delete(key),
    }
    globalThis.fetch = async path => {
      let body
      if (path === '/api/bootstrap') {
        body = { token: 'test-token', defaultHome: 'C:\\fixture', profiles: ['web'], recentReports: [recent] }
      } else if (path === `/api/jobs/${id}`) {
        body = job
      } else if (path === '/api/reports') {
        body = { reports: [recent] }
      } else {
        throw new Error(`Unexpected client request: ${path}`)
      }
      return { ok: true, status: 200, json: async () => body }
    }

    await import(`../client/app.js?test=${randomUUID()}`)
    await waitFor(() => element('#recent-reports').children.length === 1)
    const recentButton = element('#recent-reports').children[0]
    assert.equal(recentButton.className, 'recent-report')
    await recentButton.listeners.get('click')()

    assert.equal(element('#trace-list').children[0].className, 'empty-trace')
    assert.equal(element('#evidence-body').children[0].children[0].textContent, '暂无探测记录')
    assert.equal(element('#finding-title').textContent, '诊断没有完成')
    assert.equal(element('#finding-summary').textContent, job.error)
    assert.equal(element('#recovery-panel').hidden, true)
    assert.equal(element('#warning-list').hidden, true)
    assert.equal(element('#warning-list').children.length, 0)
    assert.equal(element('#download-button').disabled, true)
    assert.equal(session.get('dsh-lifeboat-active-job'), id)
  } finally {
    if (originalDocument === undefined) delete globalThis.document
    else globalThis.document = originalDocument
    globalThis.fetch = originalFetch
    if (originalSessionStorage === undefined) delete globalThis.sessionStorage
    else globalThis.sessionStorage = originalSessionStorage
  }
})
