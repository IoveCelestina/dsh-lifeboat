import { constants } from 'node:fs'
import {
  copyFile, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, unlink, writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join, relative, resolve, sep } from 'node:path'
import { readProfile, sha256 } from './manifest.js'

const EMPTY_PATCH = '[]\n'
const EXCLUDED_PROFILE_ENTRIES = new Set([
  '.dsh-lifeboat-recovery.lock', '.git', '.lifeboat-backups', 'node_modules', 'package.json', 'cordis.patch.yml',
])
const EXCLUDED_NESTED_ENTRIES = new Set(['.git', '.lifeboat-backups', 'node_modules'])
const SENSITIVE_ASSET_NAME = /^(?:\.env(?:\..*)?|\.npmrc|\.yarnrc(?:\.yml)?|\.credentials(?:\..*)?|credentials(?:\..*)?|settings\.ya?ml|auth(?:entication)?(?:\..*)?|tokens?(?:\..*)?|secrets?(?:\..*)?)$/i

function finiteInteger(value, fallback, minimum, maximum, name) {
  if (value === undefined) return fallback
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be an integer between ${minimum} and ${maximum}.`)
  }
  return value
}

function normalizeSnapshotPolicy(options = {}) {
  return {
    assetBudgetBytes: finiteInteger(options.assetBudgetBytes, 32 * 1024 * 1024, 1, 256 * 1024 * 1024, 'assetBudgetBytes'),
    assetEntryLimit: finiteInteger(options.assetEntryLimit, 2_000, 1, 20_000, 'assetEntryLimit'),
    assetMaxDepth: finiteInteger(options.assetMaxDepth, 12, 0, 32, 'assetMaxDepth'),
  }
}

async function readOptional(path, fallback = EMPTY_PATCH) {
  try {
    return await readFile(path, 'utf8')
  } catch (error) {
    if (error.code === 'ENOENT') return fallback
    throw error
  }
}

function portablePath(value) {
  return value.split(sep).join('/')
}

function sortedEntries(entries) {
  return entries.sort((left, right) => left.name.localeCompare(right.name))
}

async function collectAssets(source, policy, copyTarget) {
  const state = {
    remainingBytes: policy.assetBudgetBytes,
    remainingEntries: policy.assetEntryLimit,
    entryLimitWarned: false,
    warnings: [],
    entries: [],
  }

  const visit = async (directory, relativePath = '', depth = 0) => {
    for (const entry of sortedEntries(await readdir(directory, { withFileTypes: true }))) {
      if (state.remainingEntries <= 0) {
        if (!state.entryLimitWarned) {
          state.warnings.push(`Stopped copying profile assets after ${policy.assetEntryLimit} entries.`)
          state.entryLimitWarned = true
        }
        return
      }
      state.remainingEntries -= 1
      if (relativePath === '' && EXCLUDED_PROFILE_ENTRIES.has(entry.name)) continue
      if (EXCLUDED_NESTED_ENTRIES.has(entry.name)) continue
      const displayPath = join(relativePath, entry.name)
      if (SENSITIVE_ASSET_NAME.test(entry.name)) {
        state.warnings.push(`Skipped credential-bearing profile asset: ${displayPath}`)
        continue
      }
      const sourcePath = join(directory, entry.name)
      const stat = await lstat(sourcePath)
      if (stat.isSymbolicLink()) {
        state.warnings.push(`Skipped linked profile asset: ${displayPath}`)
        continue
      }
      if (stat.isDirectory()) {
        if (depth >= policy.assetMaxDepth) {
          state.warnings.push(`Skipped profile asset directory beyond depth ${policy.assetMaxDepth}: ${displayPath}`)
          continue
        }
        if (copyTarget) await mkdir(join(copyTarget, displayPath), { recursive: true })
        await visit(sourcePath, displayPath, depth + 1)
        continue
      }
      if (!stat.isFile()) continue
      const content = await readFile(sourcePath)
      const currentStat = await lstat(sourcePath)
      if (!currentStat.isFile() || currentStat.isSymbolicLink()
        || currentStat.dev !== stat.dev || currentStat.ino !== stat.ino
        || currentStat.size !== stat.size || currentStat.mtimeMs !== stat.mtimeMs) {
        state.warnings.push(`Skipped profile asset that changed type while being captured: ${displayPath}`)
        continue
      }
      if (content.length > state.remainingBytes) {
        state.warnings.push(`Skipped profile asset beyond copy budget: ${displayPath}`)
        continue
      }
      if (copyTarget) {
        await writeFile(join(copyTarget, displayPath), content, { flag: 'wx', mode: stat.mode & 0o777 })
      }
      state.entries.push({
        path: portablePath(displayPath),
        bytes: content.length,
        hash: sha256(content),
      })
      state.remainingBytes -= content.length
    }
  }

  await visit(source)
  return {
    entries: state.entries,
    warnings: state.warnings,
    bytes: policy.assetBudgetBytes - state.remainingBytes,
  }
}

async function packageManifestHash(directory) {
  try {
    return sha256(await readFile(join(directory, 'package.json')))
  } catch (error) {
    if (error.code === 'ENOENT') return undefined
    throw error
  }
}

async function addPackageLink(source, targetRelative, links, warnings) {
  try {
    const stat = await lstat(source)
    if (!stat.isDirectory() && !stat.isSymbolicLink()) return
    const sourceReal = await realpath(source)
    links.push({
      target: portablePath(targetRelative),
      sourceReal,
      manifestHash: await packageManifestHash(sourceReal),
    })
  } catch (error) {
    if (error.code === 'ENOENT') return
    warnings.push(`Could not capture package link ${source}: ${error.message}`)
  }
}

async function collectNodeModules(source, targetRelative, links, warnings) {
  try {
    const stat = await lstat(source)
    if (!stat.isDirectory() && !stat.isSymbolicLink()) return
  } catch (error) {
    if (error.code === 'ENOENT') return
    throw error
  }
  for (const entry of sortedEntries(await readdir(source, { withFileTypes: true }))) {
    if (entry.name === '.bin' || entry.name === '.pnpm' || entry.name.startsWith('.')) continue
    const sourcePath = join(source, entry.name)
    const targetPath = join(targetRelative, entry.name)
    if (entry.name.startsWith('@') && entry.isDirectory() && !entry.isSymbolicLink()) {
      for (const scopedEntry of sortedEntries(await readdir(sourcePath, { withFileTypes: true }))) {
        await addPackageLink(
          join(sourcePath, scopedEntry.name),
          join(targetPath, scopedEntry.name),
          links,
          warnings,
        )
      }
      continue
    }
    await addPackageLink(sourcePath, targetPath, links, warnings)
  }
}

async function collectPackages(profile) {
  const links = []
  const warnings = []
  await collectNodeModules(
    join(profile.dir, 'node_modules'),
    join('profiles', profile.profile, 'node_modules'),
    links,
    warnings,
  )
  await collectNodeModules(
    join(profile.home, 'profiles', 'node_modules'),
    join('profiles', 'node_modules'),
    links,
    warnings,
  )
  links.sort((left, right) => left.target.localeCompare(right.target))
  return { links, warnings }
}

function createInputFingerprint(profile, policy, profilePatch, homePatch, assets, packages) {
  const schema = 'dsh-lifeboat-inputs/v1'
  const assetHash = sha256(JSON.stringify(assets.entries))
  const packageIdentity = packages.links.map(link => ({
    target: link.target,
    sourceReal: link.sourceReal,
    manifestHash: link.manifestHash,
  }))
  const packageHash = sha256(JSON.stringify(packageIdentity))
  const components = {
    manifestHash: profile.hash,
    profilePatchHash: sha256(profilePatch),
    homePatchHash: sha256(homePatch),
    assetHash,
    packageHash,
  }
  return {
    schema,
    hash: sha256(JSON.stringify({ schema, policy, ...components })),
    ...components,
    assetCount: assets.entries.length,
    assetBytes: assets.bytes,
    packageLinkCount: packages.links.length,
    policy,
  }
}

async function collectProbeInputs(profile, policy, copyTarget) {
  const [profilePatch, homePatch, assets, packages] = await Promise.all([
    readOptional(join(profile.dir, 'cordis.patch.yml')),
    readOptional(join(profile.home, 'cordis.patch.yml')),
    collectAssets(profile.dir, policy, copyTarget),
    collectPackages(profile),
  ])
  return {
    profilePatch,
    homePatch,
    assets,
    packages,
    warnings: [...assets.warnings, ...packages.warnings],
    fingerprint: createInputFingerprint(profile, policy, profilePatch, homePatch, assets, packages),
  }
}

/** Re-read every configuration input represented by a probe snapshot. */
export async function fingerprintProbeInputs(profile, options = {}) {
  const policy = normalizeSnapshotPolicy(options)
  const inputs = await collectProbeInputs(profile, policy)
  return { fingerprint: inputs.fingerprint, warnings: inputs.warnings }
}

async function cloneAssetTree(source, target) {
  await mkdir(target, { recursive: true })
  for (const entry of sortedEntries(await readdir(source, { withFileTypes: true }))) {
    const sourcePath = join(source, entry.name)
    const targetPath = join(target, entry.name)
    const stat = await lstat(sourcePath)
    if (stat.isSymbolicLink()) throw new Error(`Probe snapshot unexpectedly contains a link: ${sourcePath}`)
    if (stat.isDirectory()) {
      await cloneAssetTree(sourcePath, targetPath)
    } else if (stat.isFile()) {
      await copyFile(sourcePath, targetPath, constants.COPYFILE_FICLONE)
    }
  }
}

async function createPackageLinks(home, links, warnings, ownedLinks) {
  for (const link of links) {
    const target = join(home, ...link.target.split('/'))
    await mkdir(dirname(target), { recursive: true })
    try {
      await symlink(link.sourceReal, target, process.platform === 'win32' ? 'junction' : 'dir')
      ownedLinks.push(target)
    } catch (error) {
      warnings.push(`Could not link ${link.sourceReal}: ${error.message}`)
    }
  }
}

function assertOwnedTemporaryRoot(root) {
  const temp = resolve(tmpdir())
  const candidate = resolve(root)
  const rel = relative(temp, candidate)
  if (rel === '' || rel.startsWith(`..${sep}`) || rel === '..'
    || dirname(candidate) !== temp || !basename(candidate).startsWith('dsh-lifeboat-')) {
    throw new Error(`Refusing to clean an unowned temporary path: ${candidate}`)
  }
}

async function unlinkIfLink(path) {
  try {
    const stat = await lstat(path)
    if (stat.isSymbolicLink()) await unlink(path)
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
  }
}

/** Temporary DSH_HOME with copied config inputs and captured package-resolution links. */
export class ProbeWorkspace {
  constructor(options) {
    this.root = options.root
    this.home = options.home
    this.profile = options.profile
    this.profileDir = options.profileDir
    this.original = options.original
    this.profilePatch = options.profilePatch
    this.homePatch = options.homePatch
    this.warnings = options.warnings
    this.ownedLinks = options.ownedLinks
  }

  /** Stage one ordered bundle candidate and selected user patch layers. */
  async stage({ bundles, profilePatch = true, homePatch = true }) {
    const manifest = structuredClone(this.original.manifest)
    manifest.dsh ??= {}
    manifest.dsh.profile ??= {}
    manifest.dsh.profile.bundles = [...bundles]
    await writeFile(join(this.profileDir, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
    await writeFile(join(this.profileDir, 'cordis.patch.yml'), profilePatch ? this.profilePatch : EMPTY_PATCH, 'utf8')
    await writeFile(join(this.home, 'cordis.patch.yml'), homePatch ? this.homePatch : EMPTY_PATCH, 'utf8')
  }

  /** Remove only this instance's direct child under the operating-system temp directory. */
  async cleanup() {
    assertOwnedTemporaryRoot(this.root)
    for (const link of [...this.ownedLinks].reverse()) await unlinkIfLink(link)
    await rm(this.root, { recursive: true, force: true, maxRetries: 2 })
  }
}

/** One immutable configuration template reused by every fresh probe attempt in a diagnosis. */
export class ProbeSnapshot {
  constructor(options) {
    Object.assign(this, options)
  }

  async createWorkspace() {
    const root = await mkdtemp(join(resolve(tmpdir()), 'dsh-lifeboat-probe-'))
    const home = join(root, 'home')
    const profileDir = join(home, 'profiles', this.profile.profile)
    const warnings = [...this.warnings]
    const ownedLinks = []
    try {
      await cloneAssetTree(this.assetTemplate, profileDir)
      await createPackageLinks(home, this.packageLinks, warnings, ownedLinks)
      const workspace = new ProbeWorkspace({
        root,
        home,
        profile: this.profile.profile,
        profileDir,
        original: this.profile,
        profilePatch: this.profilePatch,
        homePatch: this.homePatch,
        warnings,
        ownedLinks,
      })
      await workspace.stage({ bundles: this.profile.bundles })
      return workspace
    } catch (error) {
      try {
        assertOwnedTemporaryRoot(root)
        for (const link of [...ownedLinks].reverse()) await unlinkIfLink(link)
        await rm(root, { recursive: true, force: true, maxRetries: 2 })
      } catch (cleanupError) {
        error.message += ` Temporary workspace cleanup also failed: ${cleanupError.message}`
      }
      throw error
    }
  }

  async readCurrentFingerprint() {
    const currentProfile = await readProfile(this.profile.home, this.profile.profile)
    return fingerprintProbeInputs(currentProfile, this.policy)
  }

  async cleanup() {
    assertOwnedTemporaryRoot(this.root)
    await rm(this.root, { recursive: true, force: true, maxRetries: 2 })
  }
}

/** Capture patches, bounded profile assets, and package-resolution identities once per diagnosis. */
export async function createProbeSnapshot(profile, options = {}) {
  const policy = normalizeSnapshotPolicy(options)
  const root = await mkdtemp(join(resolve(tmpdir()), 'dsh-lifeboat-snapshot-'))
  const assetTemplate = join(root, 'profile-assets')
  try {
    await mkdir(assetTemplate, { recursive: true })
    const inputs = await collectProbeInputs(profile, policy, assetTemplate)
    return new ProbeSnapshot({
      root,
      assetTemplate,
      profile,
      policy,
      profilePatch: inputs.profilePatch,
      homePatch: inputs.homePatch,
      packageLinks: inputs.packages.links,
      warnings: inputs.warnings,
      fingerprint: inputs.fingerprint,
    })
  } catch (error) {
    try {
      assertOwnedTemporaryRoot(root)
      await rm(root, { recursive: true, force: true, maxRetries: 2 })
    } catch (cleanupError) {
      error.message += ` Probe snapshot cleanup also failed: ${cleanupError.message}`
    }
    throw error
  }
}

/** Compatibility helper for callers that need only one isolated workspace. */
export async function createProbeWorkspace(profile, options = {}) {
  const snapshot = await createProbeSnapshot(profile, options)
  let workspace
  try {
    workspace = await snapshot.createWorkspace()
  } catch (error) {
    await snapshot.cleanup()
    throw error
  }
  const cleanupWorkspace = workspace.cleanup.bind(workspace)
  workspace.cleanup = async () => {
    let workspaceError
    try {
      await cleanupWorkspace()
    } catch (error) {
      workspaceError = error
    }
    try {
      await snapshot.cleanup()
    } catch (error) {
      if (workspaceError) workspaceError.message += ` Probe snapshot cleanup also failed: ${error.message}`
      else workspaceError = error
    }
    if (workspaceError) throw workspaceError
  }
  return workspace
}
