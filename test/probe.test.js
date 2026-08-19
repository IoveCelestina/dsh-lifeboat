import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { runProbe, sanitizeOutput, scrubEnvironment } from '../src/probe.js'

test('config probe reports clean and nonzero exits independently', async () => {
  const pass = await runProbe({
    command: process.execPath,
    commandArgs: ['-e', 'process.exit(0)', '--'],
    home: process.cwd(),
    profile: 'fixture',
    cwd: process.cwd(),
    mode: 'config',
    timeoutMs: 4_000,
  })
  const fail = await runProbe({
    command: process.execPath,
    commandArgs: ['-e', 'process.exit(7)', '--'],
    home: process.cwd(),
    profile: 'fixture',
    cwd: process.cwd(),
    mode: 'config',
    timeoutMs: 4_000,
  })
  assert.equal(pass.status, 'pass')
  assert.equal(pass.exitCode, 0)
  assert.equal(fail.status, 'fail')
  assert.equal(fail.exitCode, 7)
})

test('runtime probe accepts a process that survives the startup window', async () => {
  const result = await runProbe({
    command: process.execPath,
    commandArgs: ['-e', 'setInterval(() => {}, 1000)', '--'],
    home: process.cwd(),
    profile: 'fixture',
    cwd: process.cwd(),
    mode: 'boot',
    timeoutMs: 4_000,
    successWindowMs: 350,
  })
  assert.equal(result.status, 'pass')
  assert.equal(result.reason, 'boot-window-survived')
})

test('runtime probe rejects a clean exit before the startup window', async () => {
  const result = await runProbe({
    command: process.execPath,
    commandArgs: ['-e', 'process.exit(0)', '--'],
    home: process.cwd(),
    profile: 'fixture',
    cwd: process.cwd(),
    mode: 'boot',
    timeoutMs: 4_000,
    successWindowMs: 500,
  })
  assert.equal(result.status, 'fail')
  assert.equal(result.reason, 'early-exit')
  assert.equal(result.exitCode, 0)
})

test('runtime probe refuses to shorten an impossible startup window', () => {
  assert.throws(() => runProbe({
    command: process.execPath,
    home: process.cwd(),
    profile: 'fixture',
    cwd: process.cwd(),
    mode: 'boot',
    timeoutMs: 1_000,
    successWindowMs: 751,
  }), /leave at least 250ms/)
})

test('Windows batch shims run without enabling an interpolating shell command', { skip: process.platform !== 'win32' }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-lifeboat-cmd-test-'))
  const shim = join(root, 'mock-dsh.cmd')
  const oldPath = process.env.PATH
  await writeFile(join(root, 'mock-dsh'), 'POSIX shim that CreateProcess cannot execute\n')
  await writeFile(shim, '@echo off\r\nexit /b 0\r\n')
  try {
    process.env.PATH = `${root};${oldPath}`
    const result = await runProbe({
      command: 'mock-dsh',
      commandArgs: ['literal&exit /b 9'],
      home: root,
      profile: 'fixture',
      cwd: root,
      mode: 'config',
      timeoutMs: 4_000,
    })
    assert.equal(result.status, 'pass')
    assert.equal(result.exitCode, 0)
  } finally {
    process.env.PATH = oldPath
    await rm(root, { recursive: true, force: true })
  }
})

test('scrubs ambient secrets and redacts captured literals', () => {
  assert.deepEqual(scrubEnvironment({ PATH: 'ok', API_KEY: 'no', SESSION_TOKEN: 'no' }), { PATH: 'ok' })
  assert.equal(sanitizeOutput('Authorization: Bearer abc.def token=secret-value'), 'Authorization: Bearer <redacted> token=<redacted>')
  assert.equal(sanitizeOutput('ghp_abcdefghijklmnopqrstuvwxyz123456'), '<redacted-github-token>')
  assert.equal(
    sanitizeOutput('-----BEGIN PRIVATE KEY-----\nfixture\n-----END PRIVATE KEY-----'),
    '<redacted-private-key>',
  )
})

test('caps captured output by bytes', async () => {
  const result = await runProbe({
    command: process.execPath,
    commandArgs: ['-e', "process.stdout.write('x'.repeat(10000))", '--'],
    home: process.cwd(),
    profile: 'fixture',
    cwd: process.cwd(),
    mode: 'config',
    timeoutMs: 4_000,
    outputLimit: 1_024,
  })
  assert.equal(result.status, 'pass')
  assert.equal(result.outputTruncated, true)
  assert.equal(Buffer.byteLength(result.stdout), 1_024)
})
