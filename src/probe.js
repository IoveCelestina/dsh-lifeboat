import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { delimiter, extname, isAbsolute, join } from 'node:path'

const SENSITIVE_ENV_NAME = /(KEY|SECRET|TOKEN|PASSWORD|CREDENTIAL|COOKIE|AUTH)/i
const DEFAULT_OUTPUT_LIMIT = 128 * 1024
const TERMINATION_GRACE_MS = 250

/** Validate and materialize the timing contract shared by every probe entry point. */
export function validateProbeTiming(options = {}) {
  const mode = options.mode ?? 'config'
  if (!['config', 'boot'].includes(mode)) {
    throw new Error('Probe mode must be "config" or "boot".')
  }
  const timeoutMs = options.timeoutMs ?? (mode === 'config' ? 60_000 : 20_000)
  const successWindowMs = options.successWindowMs ?? 8_000
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1) {
    throw new Error('timeoutMs must be a positive integer.')
  }
  if (!Number.isInteger(successWindowMs) || successWindowMs < 1) {
    throw new Error('successWindowMs must be a positive integer.')
  }
  if (mode === 'boot' && successWindowMs + TERMINATION_GRACE_MS > timeoutMs) {
    throw new Error(`successWindowMs must leave at least ${TERMINATION_GRACE_MS}ms before timeoutMs for probe termination.`)
  }
  return { mode, timeoutMs, successWindowMs }
}

/** Remove ambient credential-like variables before running untrusted plugins. */
export function scrubEnvironment(env = process.env) {
  return Object.fromEntries(
    Object.entries(env).filter(([name, value]) => value !== undefined && !SENSITIVE_ENV_NAME.test(name)),
  )
}

/** Remove terminal control codes and common credential literals from captured output. */
export function sanitizeOutput(value) {
  return value
    .replace(/\u001B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g, '')
    .replace(/(Bearer\s+)[A-Za-z0-9._~+/=-]+/gi, '$1<redacted>')
    .replace(/((?:api[_-]?key|token|password|secret)\s*[:=]\s*)[^\s'"`]+/gi, '$1<redacted>')
    .replace(/\bgh[pousr]_[A-Za-z0-9]{20,}\b/g, '<redacted-github-token>')
    .replace(/\bsk-[A-Za-z0-9_-]{16,}\b/g, '<redacted-api-key>')
    .replace(/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g, '<redacted-private-key>')
}

function appendOutput(state, chunk, limit) {
  const next = Buffer.concat([state.buffer, Buffer.from(chunk)])
  if (next.length <= limit) {
    state.buffer = next
    return
  }
  state.truncated = true
  state.buffer = next.subarray(next.length - limit)
}

function windowsPathValue(env) {
  const key = Object.keys(env).find(name => name.toLowerCase() === 'path')
  return key ? env[key] : ''
}

function resolveWindowsExecutable(command, env) {
  const extensions = (env.PATHEXT || '.COM;.EXE;.BAT;.CMD')
    .split(';')
    .filter(Boolean)
    .map(value => value.toLowerCase())
  const hasPath = isAbsolute(command) || command.includes('/') || command.includes('\\')
  const directories = hasPath
    ? ['']
    : windowsPathValue(env).split(delimiter).map(value => value.replace(/^"|"$/g, '')).filter(Boolean)
  // Windows command lookup follows PATHEXT; package managers often place an
  // extensionless POSIX shim beside the executable .CMD shim.
  const suffixes = extname(command) ? [''] : [...extensions, '']
  for (const directory of directories) {
    for (const suffix of suffixes) {
      const candidate = directory ? join(directory, `${command}${suffix}`) : `${command}${suffix}`
      try {
        if (existsSync(candidate) && statSync(candidate).isFile()) return candidate
      } catch {
        // A PATH entry can be unreadable. Continue to the next exact candidate.
      }
    }
  }
  return command
}

function prepareLaunch(command, args, cwd, home, env) {
  if (process.platform !== 'win32') {
    return { command, args, env, cleanup() {} }
  }
  const resolved = resolveWindowsExecutable(command, env)
  const extension = extname(resolved).toLowerCase()
  if (extension !== '.cmd' && extension !== '.bat') {
    return { command: resolved, args, env, cleanup() {} }
  }
  if (args.some(value => /["\r\n]/.test(value))) {
    throw new Error('Windows .cmd probes do not accept quote or newline characters in individual arguments.')
  }

  const wrapperPath = join(home, `.dsh-lifeboat-probe-${randomUUID()}.cmd`)
  const launchEnv = { ...env, DSH_LIFEBOAT_EXECUTABLE: resolved }
  const references = args.map((value, index) => {
    const name = `DSH_LIFEBOAT_ARG_${index}`
    launchEnv[name] = value
    return `"%${name}%"`
  })
  const wrapper = `@echo off\r\nsetlocal DisableDelayedExpansion\r\n"%DSH_LIFEBOAT_EXECUTABLE%" ${references.join(' ')}\r\n`
  writeFileSync(wrapperPath, wrapper, { encoding: 'utf8', flag: 'wx', mode: 0o600 })
  const commandProcessor = env.ComSpec || join(env.SystemRoot || 'C:\\Windows', 'System32', 'cmd.exe')
  return {
    command: commandProcessor,
    args: ['/d', '/q', '/c', wrapperPath],
    env: launchEnv,
    cleanup() {
      try {
        unlinkSync(wrapperPath)
      } catch (error) {
        if (error.code !== 'ENOENT') throw error
      }
    },
  }
}

function waitForExit(child, timeoutMs) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true)
  return new Promise(resolve => {
    const onExit = () => {
      clearTimeout(timer)
      resolve(true)
    }
    const timer = setTimeout(() => {
      child.off('exit', onExit)
      resolve(false)
    }, timeoutMs)
    timer.unref?.()
    child.once('exit', onExit)
  })
}

function processGroupIsAlive(pid) {
  try {
    process.kill(-pid, 0)
    return true
  } catch (error) {
    if (error.code === 'ESRCH') return false
    throw error
  }
}

function signalProcessGroup(pid, signal) {
  try {
    process.kill(-pid, signal)
    return true
  } catch (error) {
    if (error.code === 'ESRCH') return false
    throw error
  }
}

async function waitForProcessGroupExit(pid, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (processGroupIsAlive(pid)) {
    const remaining = deadline - Date.now()
    if (remaining <= 0) return false
    await new Promise(resolve => setTimeout(resolve, Math.min(25, remaining)))
  }
  return true
}

async function terminateChild(child) {
  if (!child.pid) return
  if (process.platform === 'win32') {
    if (child.exitCode !== null || child.signalCode !== null) return
    const killer = spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], {
      stdio: 'ignore',
      windowsHide: true,
    })
    await waitForExit(killer, 2_000)
    if (!await waitForExit(child, 500)) {
      child.kill('SIGKILL')
      await waitForExit(child, 1_500)
    }
  } else {
    if (processGroupIsAlive(child.pid)) {
      signalProcessGroup(child.pid, 'SIGTERM')
      if (!await waitForProcessGroupExit(child.pid, 1_500)) {
        signalProcessGroup(child.pid, 'SIGKILL')
        if (!await waitForProcessGroupExit(child.pid, 1_500)) {
          throw new Error(`Could not terminate owned probe process group ${child.pid}.`)
        }
      }
    }
    // The kernel can report that the process group is gone before Node has
    // delivered the child's exit event and populated exitCode/signalCode.
    // Always give that event a bounded opportunity to settle, even when the
    // initial process-group liveness check already returned false.
    await waitForExit(child, 500)
  }
  if (child.exitCode === null && child.signalCode === null) {
    child.stdout?.destroy()
    child.stderr?.destroy()
    child.unref()
    throw new Error(`Could not terminate owned probe process ${child.pid}.`)
  }
}

/** Run one config or runtime boot probe against an isolated Harness home. */
export function runProbe(options) {
  const {
    command = 'dsh',
    commandArgs = [],
    home,
    profile,
    cwd,
    mode = 'config',
    bootArgs = [],
    timeoutMs = mode === 'config' ? 60_000 : 20_000,
    successWindowMs = 8_000,
    outputLimit = DEFAULT_OUTPUT_LIMIT,
    signal,
  } = options
  validateProbeTiming({ mode, timeoutMs, successWindowMs })
  const args = mode === 'config'
    ? [...commandArgs, '--profile', profile, '--dump-config']
    : [...commandArgs, '--profile', profile, ...bootArgs]
  const startedAt = Date.now()
  const probeEnv = {
    ...scrubEnvironment(),
    DSH_HOME: home,
    NO_COLOR: '1',
  }
  const launch = prepareLaunch(command, args, cwd, home, probeEnv)

  return new Promise(resolve => {
    const stdout = { buffer: Buffer.alloc(0), truncated: false }
    const stderr = { buffer: Buffer.alloc(0), truncated: false }
    let finalizing = false
    let overallTimer
    let successTimer

    const child = spawn(launch.command, launch.args, {
      cwd,
      detached: process.platform !== 'win32',
      env: launch.env,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    })

    child.stdout?.on('data', chunk => appendOutput(stdout, chunk, outputLimit))
    child.stderr?.on('data', chunk => appendOutput(stderr, chunk, outputLimit))

    const finish = async (partial, stop = false) => {
      if (finalizing) return
      finalizing = true
      clearTimeout(overallTimer)
      clearTimeout(successTimer)
      signal?.removeEventListener('abort', onAbort)
      let terminationError
      if (stop) {
        try {
          await terminateChild(child)
        } catch (error) {
          terminationError = error.message
        }
      }
      try {
        launch.cleanup()
      } catch (error) {
        terminationError ??= `Probe launcher cleanup failed: ${error.message}`
      }
      resolve({
        command,
        args,
        mode,
        status: terminationError ? 'fail' : partial.status,
        reason: terminationError ? 'termination-failed' : partial.reason,
        exitCode: partial.exitCode ?? child.exitCode,
        signal: partial.signal ?? child.signalCode,
        timedOut: partial.timedOut ?? false,
        durationMs: Date.now() - startedAt,
        stdout: sanitizeOutput(stdout.buffer.toString('utf8')),
        stderr: sanitizeOutput(stderr.buffer.toString('utf8')),
        outputTruncated: stdout.truncated || stderr.truncated,
        terminationError,
      })
    }

    const onAbort = () => void finish({ status: 'cancelled', reason: 'cancelled' }, true)
    signal?.addEventListener('abort', onAbort, { once: true })
    if (signal?.aborted) {
      onAbort()
      return
    }

    child.once('error', error => {
      void finish({ status: 'fail', reason: `spawn-error: ${error.message}` }, true)
    })
    child.once('exit', (code, childSignal) => {
      if (finalizing) return
      const passed = mode === 'config' && code === 0
      void finish({
        status: passed ? 'pass' : 'fail',
        reason: passed ? 'clean-exit' : (mode === 'boot' && code === 0 ? 'early-exit' : 'nonzero-exit'),
        exitCode: code,
        signal: childSignal,
      }, process.platform !== 'win32')
    })

    overallTimer = setTimeout(() => {
      void finish({ status: 'fail', reason: 'timeout', timedOut: true }, true)
    }, timeoutMs)
    overallTimer.unref?.()

    if (mode === 'boot') {
      successTimer = setTimeout(() => {
        void finish({ status: 'pass', reason: 'boot-window-survived' }, true)
      }, successWindowMs)
      successTimer.unref?.()
    }
  })
}
