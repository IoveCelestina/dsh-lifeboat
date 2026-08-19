import {
  copyFile, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, unlink, writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join, relative, resolve, sep } from 'node:path'

const EMPTY_PATCH = '[]\n'
const EXCLUDED_PROFILE_ENTRIES = new Set([
  '.dsh-lifeboat-recovery.lock', '.git', '.lifeboat-backups', 'node_modules', 'package.json', 'cordis.patch.yml',
])
const EXCLUDED_NESTED_ENTRIES = new Set(['.git', '.lifeboat-backups', 'node_modules'])
const SENSITIVE_ASSET_NAME = /^(?:\.env(?:\..*)?|\.npmrc|\.yarnrc(?:\.yml)?|\.credentials(?:\..*)?|credentials(?:\..*)?|settings\.ya?ml|auth(?:entication)?(?:\..*)?|tokens?(?:\..*)?|secrets?(?:\..*)?)$/i

async function readOptional(path, fallback = EMPTY_PATCH) {
  try {
    return await readFile(path, 'utf8')
  } catch (error) {
    if (error.code === 'ENOENT') return fallback
    throw error
  }
}

async function linkPackageDirectory(source, target, ownedLinks, warnings) {
  try {
    const sourceStat = await lstat(source)
    if (!sourceStat.isDirectory() && !sourceStat.isSymbolicLink()) return
  } catch (error) {
    if (error.code === 'ENOENT') return
    throw error
  }
  await mkdir(dirname(target), { recursive: true })
  try {
    // Resolve pnpm's relative package link before placing it under the temporary
    // profile. Reusing the relative link below a different parent would point at
    // the temporary tree instead of the package that the real profile loads.
    const resolvedSource = await realpath(source)
    await symlink(resolvedSource, target, process.platform === 'win32' ? 'junction' : 'dir')
    ownedLinks.push(target)
  } catch (error) {
    warnings.push(`Could not link ${source}: ${error.message}`)
  }
}

async function mirrorNodeModules(source, target, ownedLinks, warnings) {
  try {
    const sourceStat = await lstat(source)
    if (!sourceStat.isDirectory() && !sourceStat.isSymbolicLink()) return
  } catch (error) {
    if (error.code === 'ENOENT') return
    throw error
  }
  await mkdir(target, { recursive: true })
  for (const entry of await readdir(source, { withFileTypes: true })) {
    if (entry.name === '.bin' || entry.name === '.pnpm' || entry.name.startsWith('.')) continue
    const sourcePath = join(source, entry.name)
    const targetPath = join(target, entry.name)
    if (entry.name.startsWith('@') && entry.isDirectory() && !entry.isSymbolicLink()) {
      await mkdir(targetPath, { recursive: true })
      for (const scopedEntry of await readdir(sourcePath, { withFileTypes: true })) {
        await linkPackageDirectory(
          join(sourcePath, scopedEntry.name),
          join(targetPath, scopedEntry.name),
          ownedLinks,
          warnings,
        )
      }
      continue
    }
    await linkPackageDirectory(sourcePath, targetPath, ownedLinks, warnings)
  }
}

async function copyAssets(source, target, state, relativePath = '', depth = 0) {
  if (state.remainingBytes <= 0) return
  const entries = await readdir(source, { withFileTypes: true })
  for (const entry of entries) {
    if (state.remainingEntries <= 0) {
      if (!state.entryLimitWarned) {
        state.warnings.push(`Stopped copying profile assets after ${state.entryLimit} entries.`)
        state.entryLimitWarned = true
      }
      return
    }
    state.remainingEntries -= 1
    if (relativePath === '' && EXCLUDED_PROFILE_ENTRIES.has(entry.name)) continue
    if (EXCLUDED_NESTED_ENTRIES.has(entry.name)) continue
    if (SENSITIVE_ASSET_NAME.test(entry.name)) {
      state.warnings.push(`Skipped credential-bearing profile asset: ${join(relativePath, entry.name)}`)
      continue
    }
    const sourcePath = join(source, entry.name)
    const targetPath = join(target, entry.name)
    const displayPath = join(relativePath, entry.name)
    const stat = await lstat(sourcePath)
    if (stat.isSymbolicLink()) {
      state.warnings.push(`Skipped linked profile asset: ${displayPath}`)
      continue
    }
    if (stat.isDirectory()) {
      if (depth >= state.maxDepth) {
        state.warnings.push(`Skipped profile asset directory beyond depth ${state.maxDepth}: ${displayPath}`)
        continue
      }
      await mkdir(targetPath, { recursive: true })
      await copyAssets(sourcePath, targetPath, state, displayPath, depth + 1)
      continue
    }
    if (!stat.isFile()) continue
    if (stat.size > state.remainingBytes) {
      state.warnings.push(`Skipped profile asset beyond copy budget: ${displayPath}`)
      continue
    }
    await copyFile(sourcePath, targetPath)
    state.remainingBytes -= stat.size
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

/** Temporary DSH_HOME with copied config inputs and package-resolution links to the installed profile. */
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

/** Create an isolated probe home and copy bounded non-link profile assets into it. */
export async function createProbeWorkspace(profile, options = {}) {
  const prefix = join(resolve(tmpdir()), 'dsh-lifeboat-')
  const root = await mkdtemp(prefix)
  const home = join(root, 'home')
  const profileDir = join(home, 'profiles', profile.profile)
  const warnings = []
  const ownedLinks = []
  try {
    await mkdir(profileDir, { recursive: true })

    const profilePatch = await readOptional(join(profile.dir, 'cordis.patch.yml'))
    const homePatch = await readOptional(join(profile.home, 'cordis.patch.yml'))
    const entryLimit = options.assetEntryLimit ?? 2_000
    await copyAssets(profile.dir, profileDir, {
      remainingBytes: options.assetBudgetBytes ?? 32 * 1024 * 1024,
      remainingEntries: entryLimit,
      entryLimit,
      entryLimitWarned: false,
      maxDepth: options.assetMaxDepth ?? 12,
      warnings,
    })
    await mirrorNodeModules(join(profile.dir, 'node_modules'), join(profileDir, 'node_modules'), ownedLinks, warnings)
    await mirrorNodeModules(
      join(profile.home, 'profiles', 'node_modules'),
      join(home, 'profiles', 'node_modules'),
      ownedLinks,
      warnings,
    )

    const workspace = new ProbeWorkspace({
      root,
      home,
      profile: profile.profile,
      profileDir,
      original: profile,
      profilePatch,
      homePatch,
      warnings,
      ownedLinks,
    })
    await workspace.stage({ bundles: profile.bundles })
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
