import { createHash } from 'node:crypto'
import { readdir, readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'

/** Default profile directory name inside a Harness home. */
export const PROFILES_DIR = 'profiles'

/** Resolve the Harness home from an explicit value, DSH_HOME, or ~/.dsh. */
export function resolveDshHome(value, env = process.env) {
  const selected = value || env.DSH_HOME
  if (selected) return resolve(selected)
  const userHome = env.USERPROFILE || env.HOME
  if (!userHome) throw new Error('Cannot resolve the Harness home: pass --home or set DSH_HOME.')
  return resolve(userHome, '.dsh')
}

/** Reject profile names that could escape the Harness profiles directory. */
export function validateProfileName(name) {
  if (typeof name !== 'string' || name === '' || name === '.' || name === '..'
    || name === 'node_modules' || name.includes('/') || name.includes('\\')) {
    throw new Error(`Invalid profile name: ${JSON.stringify(name)}`)
  }
  return name
}

/** Return a stable SHA-256 digest for optimistic concurrency checks. */
export function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** Read and validate the profile fields Lifeboat needs without changing them. */
export async function readProfile(homeValue, profileName) {
  const home = resolveDshHome(homeValue)
  const profile = validateProfileName(profileName)
  const dir = join(home, PROFILES_DIR, profile)
  const manifestPath = join(dir, 'package.json')
  let raw
  try {
    raw = await readFile(manifestPath, 'utf8')
  } catch (error) {
    throw new Error(`Cannot read profile manifest ${manifestPath}: ${error.message}`)
  }

  let manifest
  try {
    manifest = JSON.parse(raw)
  } catch (error) {
    throw new Error(`Profile manifest is not valid JSON: ${error.message}`)
  }
  if (!isRecord(manifest)) throw new Error('Profile manifest must contain a JSON object.')

  const bundles = manifest.dsh?.profile?.bundles ?? []
  if (!Array.isArray(bundles) || bundles.some(item => typeof item !== 'string' || item === '')) {
    throw new Error('Profile manifest dsh.profile.bundles must be an array of non-empty package names.')
  }
  const dependencies = isRecord(manifest.dependencies) ? manifest.dependencies : {}
  return {
    home,
    profile,
    dir,
    manifestPath,
    raw,
    hash: sha256(raw),
    manifest,
    bundles: [...bundles],
    dependencies: { ...dependencies },
  }
}

/** Split installation bundles from out-of-tree bundles managed by the profile. */
export function classifyBundles(profile) {
  const dependencyNames = new Set(Object.keys(profile.dependencies))
  const suspects = profile.bundles.filter(bundle => dependencyNames.has(bundle))
  const protectedBundles = profile.bundles.filter(bundle => !dependencyNames.has(bundle))
  return { protectedBundles, suspects }
}

/** List initialized Harness profiles under one home. */
export async function listProfiles(homeValue) {
  const home = resolveDshHome(homeValue)
  const profilesDir = join(home, PROFILES_DIR)
  let entries
  try {
    entries = await readdir(profilesDir, { withFileTypes: true })
  } catch (error) {
    if (error.code === 'ENOENT') return []
    throw error
  }
  return entries
    .filter(entry => entry.isDirectory() && entry.name !== 'node_modules')
    .map(entry => entry.name)
    .sort((left, right) => left.localeCompare(right))
}
