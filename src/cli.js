#!/usr/bin/env node
import { createLifeboatServer } from './server.js'
import { diagnoseProfile } from './diagnose.js'

function help() {
  return `dsh-lifeboat — out-of-process recovery for DeepSeek Harness

Usage:
  dsh-lifeboat serve [--home PATH] [--port NUMBER] [--state-dir PATH] [--job-timeout MS]
  dsh-lifeboat diagnose [options]

Diagnose options:
  --home PATH                 Harness home (defaults to DSH_HOME or ~/.dsh)
  --profile NAME              Profile to inspect (default: web)
  --mode config|boot          Config dump or runtime survival probe
  --command EXECUTABLE        dsh executable (default: dsh)
  --command-arg VALUE         Prefix argument; repeat as needed
  --boot-arg VALUE            Runtime argument; repeat as needed
  --timeout MS                Per-probe timeout
  --success-window MS         Runtime duration considered a healthy boot
  --boot-confirmations N      Fresh isolated attempts per runtime probe (default: 2)
  --max-candidates N          Maximum automatic isolation candidates (default: 128)
  --max-exact-removals N      Exact recovery search depth (default: 2)
  --max-recovery-probes N     Recovery-search budget (config: 256; boot: 64)
  --allow-runtime-code-execution
                               Required for --mode boot
  --keep-artifacts            Preserve the isolated probe home
  --json                      Print only the final JSON report
`
}

function parse(argv) {
  const commandName = argv[0]?.startsWith('-') ? 'serve' : (argv.shift() ?? 'serve')
  const options = { commandName, commandArgs: [], bootArgs: [] }
  const take = name => {
    const value = argv.shift()
    if (value === undefined) throw new Error(`${name} requires a value.`)
    return value
  }
  while (argv.length > 0) {
    const flag = argv.shift()
    if (flag === '--help' || flag === '-h') options.help = true
    else if (flag === '--home') options.home = take(flag)
    else if (flag === '--profile') options.profile = take(flag)
    else if (flag === '--mode') options.mode = take(flag)
    else if (flag === '--command') options.command = take(flag)
    else if (flag === '--command-arg') options.commandArgs.push(take(flag))
    else if (flag === '--boot-arg') options.bootArgs.push(take(flag))
    else if (flag === '--timeout') options.timeoutMs = Number(take(flag))
    else if (flag === '--success-window') options.successWindowMs = Number(take(flag))
    else if (flag === '--boot-confirmations') options.bootConfirmations = Number(take(flag))
    else if (flag === '--max-candidates') options.maxCandidateBundles = Number(take(flag))
    else if (flag === '--max-exact-removals') options.maxExactRemovalSize = Number(take(flag))
    else if (flag === '--max-recovery-probes') options.maxRecoveryProbes = Number(take(flag))
    else if (flag === '--port') options.port = Number(take(flag))
    else if (flag === '--state-dir') options.stateDir = take(flag)
    else if (flag === '--max-concurrent') options.maxConcurrentJobs = Number(take(flag))
    else if (flag === '--job-timeout') options.defaultJobTimeoutMs = Number(take(flag))
    else if (flag === '--keep-artifacts') options.keepArtifacts = true
    else if (flag === '--allow-runtime-code-execution') options.allowRuntimeCodeExecution = true
    else if (flag === '--json') options.json = true
    else throw new Error(`Unknown option: ${flag}`)
  }
  return options
}

function printSummary(report) {
  console.log(`\n${report.finding?.title ?? 'Diagnosis did not finish'}`)
  if (report.finding?.summary) console.log(report.finding.summary)
  console.log(`Probes: ${report.probes.length}`)
  if (report.finding?.bundles?.length) console.log(`Bundles: ${report.finding.bundles.join(', ')}`)
  if (report.artifactPaths?.length) console.log(`Artifacts: ${report.artifactPaths.join(', ')}`)
  for (const warning of report.warnings) console.warn(`Warning: ${warning}`)
}

async function main() {
  const options = parse(process.argv.slice(2))
  if (options.help) {
    console.log(help())
    return
  }
  if (options.commandName === 'serve') {
    if (options.port !== undefined && (!Number.isInteger(options.port) || options.port < 0 || options.port > 65_535)) {
      throw new Error('--port must be an integer from 0 to 65535.')
    }
    if (options.maxConcurrentJobs !== undefined
      && (!Number.isInteger(options.maxConcurrentJobs) || options.maxConcurrentJobs < 1 || options.maxConcurrentJobs > 4)) {
      throw new Error('--max-concurrent must be an integer from 1 to 4.')
    }
    const lifeboat = await createLifeboatServer({
      home: options.home,
      port: options.port,
      stateDir: options.stateDir,
      maxConcurrentJobs: options.maxConcurrentJobs,
      defaultJobTimeoutMs: options.defaultJobTimeoutMs,
    })
    console.log(`Lifeboat is ready at ${lifeboat.url}`)
    console.log('The rescue console is bound to 127.0.0.1 and does not modify a profile until you confirm Apply recovery.')
    let closing = false
    const close = signal => {
      if (closing) return
      closing = true
      console.error(`Stopping Lifeboat after ${signal}...`)
      void lifeboat.close().catch(error => {
        console.error(`dsh-lifeboat: shutdown failed: ${error.message}`)
        process.exitCode = 1
      })
    }
    process.once('SIGINT', () => close('SIGINT'))
    process.once('SIGTERM', () => close('SIGTERM'))
    return
  }
  if (options.commandName !== 'diagnose') throw new Error(`Unknown command: ${options.commandName}`)
  const report = await diagnoseProfile({
    home: options.home,
    profile: options.profile ?? 'web',
    mode: options.mode ?? 'config',
    command: options.command ?? 'dsh',
    commandArgs: options.commandArgs,
    bootArgs: options.bootArgs,
    timeoutMs: options.timeoutMs,
    successWindowMs: options.successWindowMs,
    bootConfirmations: options.bootConfirmations,
    maxCandidateBundles: options.maxCandidateBundles,
    maxExactRemovalSize: options.maxExactRemovalSize,
    maxRecoveryProbes: options.maxRecoveryProbes,
    keepArtifacts: options.keepArtifacts,
    allowRuntimeCodeExecution: options.allowRuntimeCodeExecution,
  }, {
    emit: event => {
      if (!options.json && event.type === 'probe-started') console.error(`→ ${event.label}`)
      if (!options.json && event.type === 'probe-finished') console.error(`  ${event.status}: ${event.reason}`)
    },
  })
  if (options.json) console.log(JSON.stringify(report, null, 2))
  else printSummary(report)
  if (report.status !== 'completed') process.exitCode = 1
}

main().catch(error => {
  console.error(`dsh-lifeboat: ${error.message}`)
  process.exitCode = 1
})
