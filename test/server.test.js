import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createLifeboatServer } from '../src/server.js'
import { profileFixture } from './helpers.js'

test('serves the rescue UI and completes a token-protected diagnosis job', async () => {
  const fixture = await profileFixture({ bundles: ['@deepseek-ai/dsh-base'], dependencies: {} })
  const lifeboat = await createLifeboatServer({ home: fixture.home, port: 0 })
  try {
    const page = await fetch(lifeboat.url)
    assert.equal(page.status, 200)
    assert.match(page.headers.get('content-security-policy'), /default-src 'self'/)
    assert.match(await page.text(), /DSH Lifeboat/)

    const bootstrap = await (await fetch(`${lifeboat.url}api/bootstrap`)).json()
    const denied = await fetch(`${lifeboat.url}api/jobs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    })
    assert.equal(denied.status, 403)

    const crossOriginDenied = await fetch(`${lifeboat.url}api/jobs`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Lifeboat-Token': bootstrap.token,
        Origin: 'http://example.invalid',
      },
      body: '{}',
    })
    assert.equal(crossOriginDenied.status, 403)

    const runtimeDenied = await fetch(`${lifeboat.url}api/jobs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Lifeboat-Token': bootstrap.token },
      body: JSON.stringify({ home: fixture.home, profile: fixture.profile, mode: 'boot' }),
    })
    assert.equal(runtimeDenied.status, 400)

    const createdResponse = await fetch(`${lifeboat.url}api/jobs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Lifeboat-Token': bootstrap.token },
      body: JSON.stringify({
        home: fixture.home,
        profile: fixture.profile,
        command: process.execPath,
        commandArgs: ['-e', 'process.exit(0)', '--'],
      }),
    })
    assert.equal(createdResponse.status, 202)
    let job = await createdResponse.json()
    for (let attempt = 0; attempt < 80 && ['queued', 'running'].includes(job.status); attempt += 1) {
      await new Promise(resolve => setTimeout(resolve, 25))
      job = await (await fetch(`${lifeboat.url}api/jobs/${job.id}`)).json()
    }
    assert.equal(job.status, 'completed')
    assert.equal(job.report.finding.code, 'healthy')
    assert.equal(job.reportSaved, true)

    const health = await (await fetch(`${lifeboat.url}api/health`)).json()
    assert.equal(health.status, 'ok')
    assert.equal(health.runningJobs, 0)

    const reports = await (await fetch(`${lifeboat.url}api/reports`)).json()
    assert.ok(reports.reports.some(report => report.id === job.id))
    const stored = await (await fetch(`${lifeboat.url}api/reports/${job.id}`)).json()
    assert.equal(stored.report.finding.code, 'healthy')
  } finally {
    await lifeboat.close()
    await fixture.cleanup()
  }
})

test('runs diagnoses through a bounded queue and cancels a queued job without starting it', async () => {
  const fixture = await profileFixture({ bundles: ['@deepseek-ai/dsh-base'], dependencies: {} })
  let releaseFirst
  const firstGate = new Promise(resolve => { releaseFirst = resolve })
  const started = []
  const diagnose = async options => {
    started.push(options.command)
    if (options.command === 'first') await firstGate
    return {
      schema: 'dsh-lifeboat/v1',
      status: 'completed',
      options,
      probes: [],
      warnings: [],
      finding: { code: 'healthy', title: 'Healthy', summary: 'Fixture passed.' },
    }
  }
  const lifeboat = await createLifeboatServer({
    home: fixture.home,
    port: 0,
    diagnose,
    maxConcurrentJobs: 1,
  })
  try {
    const bootstrap = await (await fetch(`${lifeboat.url}api/bootstrap`)).json()
    const create = command => fetch(`${lifeboat.url}api/jobs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Lifeboat-Token': bootstrap.token },
      body: JSON.stringify({ home: fixture.home, profile: fixture.profile, command }),
    }).then(response => response.json())

    const first = await create('first')
    for (let attempt = 0; attempt < 40 && started.length === 0; attempt += 1) {
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    const second = await create('second')
    assert.equal(second.status, 'queued')
    assert.equal(second.queuePosition, 1)
    assert.deepEqual(started, ['first'])

    const cancelled = await fetch(`${lifeboat.url}api/jobs/${second.id}/cancel`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Lifeboat-Token': bootstrap.token },
      body: '{}',
    }).then(response => response.json())
    assert.equal(cancelled.status, 'cancelled')
    assert.deepEqual(started, ['first'])

    releaseFirst()
    let completed
    for (let attempt = 0; attempt < 80; attempt += 1) {
      completed = await fetch(`${lifeboat.url}api/jobs/${first.id}`).then(response => response.json())
      if (completed.status === 'completed') break
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    assert.equal(completed.status, 'completed')
    assert.deepEqual(started, ['first'])
  } finally {
    releaseFirst()
    await lifeboat.close()
    await fixture.cleanup()
  }
})

test('closes promptly with an idle keep-alive connection', async () => {
  const { Agent, get } = await import('node:http')
  const fixture = await profileFixture({ bundles: ['@deepseek-ai/dsh-base'], dependencies: {} })
  const lifeboat = await createLifeboatServer({ home: fixture.home, port: 0 })
  const agent = new Agent({ keepAlive: true })
  try {
    await new Promise((resolve, reject) => {
      get(lifeboat.url, { agent }, response => {
        response.resume()
        response.once('end', resolve)
      }).once('error', reject)
    })
    const startedAt = Date.now()
    await lifeboat.close()
    assert.ok(Date.now() - startedAt < 2_000)
  } finally {
    agent.destroy()
    await lifeboat.close()
    await fixture.cleanup()
  }
})

test('aborts a diagnosis that exceeds its service deadline', async () => {
  const fixture = await profileFixture({ bundles: ['@deepseek-ai/dsh-base'], dependencies: {} })
  const diagnose = options => new Promise((resolve, reject) => {
    options.signal.addEventListener('abort', () => reject(new Error('diagnosis aborted')), { once: true })
  })
  const lifeboat = await createLifeboatServer({
    home: fixture.home,
    port: 0,
    diagnose,
    defaultJobTimeoutMs: 1_000,
  })
  try {
    const bootstrap = await fetch(`${lifeboat.url}api/bootstrap`).then(response => response.json())
    let job = await fetch(`${lifeboat.url}api/jobs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Lifeboat-Token': bootstrap.token },
      body: JSON.stringify({ home: fixture.home, profile: fixture.profile }),
    }).then(response => response.json())
    for (let attempt = 0; attempt < 80 && ['queued', 'running'].includes(job.status); attempt += 1) {
      await new Promise(resolve => setTimeout(resolve, 25))
      job = await fetch(`${lifeboat.url}api/jobs/${job.id}`).then(response => response.json())
    }
    assert.equal(job.status, 'failed')
    assert.equal(job.error, 'diagnosis aborted')
    assert.ok(job.events.some(event => event.type === 'diagnosis-deadline-exceeded'))
    assert.equal(job.reportSaved, true)
  } finally {
    await lifeboat.close()
    await fixture.cleanup()
  }
})
