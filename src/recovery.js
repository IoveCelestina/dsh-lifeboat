import { randomUUID } from 'node:crypto'
import { lstat, mkdir, open, readFile, realpath, rename, unlink } from 'node:fs/promises'
import { basename, dirname, join, relative, sep } from 'node:path'
import {
  PROFILES_DIR, readProfile, resolveDshHome, sha256, validateProfileName,
} from './manifest.js'

const BACKUP_DIRNAME = '.lifeboat-backups'
const LOCK_FILENAME = '.dsh-lifeboat-recovery.lock'
const LOCK_INITIALIZATION_GRACE_MS = 30_000
const SHA256_PATTERN = /^[a-f0-9]{64}$/
const BACKUP_NAME_PATTERN = /^package\.[A-Za-z0-9-]+\.([a-f0-9]{12}|[a-f0-9]{64})\.json$/

function httpError(message, statusCode) {
  const error = new Error(message)
  error.statusCode = statusCode
  return error
}

function conflict(message) {
  return httpError(message, 409)
}

function badRequest(message) {
  return httpError(message, 400)
}

function assertChild(parent, target) {
  const rel = relative(parent, target)
  if (rel === '' || rel === '..' || rel.startsWith(`..${sep}`)) {
    throw conflict(`Recovery target escapes the selected profile: ${target}`)
  }
}

async function unlinkIfPresent(path) {
  try {
    await unlink(path)
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
  }
}

async function writeExclusive(path, content, mode = 0o600) {
  let handle
  try {
    handle = await open(path, 'wx', mode)
    await handle.writeFile(content, 'utf8')
    await handle.sync()
    await handle.close()
    handle = undefined
  } catch (error) {
    try {
      await handle?.close()
    } catch (closeError) {
      error.message += ` Closing the partial file also failed: ${closeError.message}`
    }
    if (handle) {
      try {
        await unlinkIfPresent(path)
      } catch (cleanupError) {
        error.message += ` Removing the partial file also failed: ${cleanupError.message}`
      }
    }
    throw error
  }
}

async function safeProfileLocation(homeValue, profileName) {
  const home = resolveDshHome(homeValue)
  const profile = validateProfileName(profileName)
  const profilesDir = join(home, PROFILES_DIR)
  const profileDir = join(profilesDir, profile)
  const [profilesStat, profileStat] = await Promise.all([lstat(profilesDir), lstat(profileDir)])
  if (!profilesStat.isDirectory() || profilesStat.isSymbolicLink()) {
    throw conflict('The Harness profiles directory must be a real directory, not a symbolic link or junction.')
  }
  if (!profileStat.isDirectory() || profileStat.isSymbolicLink()) {
    throw conflict('The selected profile must be a real directory, not a symbolic link or junction.')
  }
  const [profilesReal, profileReal] = await Promise.all([realpath(profilesDir), realpath(profileDir)])
  if (dirname(profileReal) !== profilesReal) {
    throw conflict('The selected profile resolves outside the Harness profiles directory.')
  }
  return { home, profile, profileDir, profileReal }
}

async function assertSafeManifest(profile, profileReal) {
  const stat = await lstat(profile.manifestPath)
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw conflict('The profile manifest must be a real file, not a symbolic link.')
  }
  const resolved = await realpath(profile.manifestPath)
  if (dirname(resolved) !== profileReal || basename(resolved) !== 'package.json') {
    throw conflict('The profile manifest resolves outside the selected profile.')
  }
  return stat
}

async function ensureBackupDirectory(location, create = true) {
  const backupPath = join(location.profileDir, BACKUP_DIRNAME)
  assertChild(location.profileDir, backupPath)
  if (create) {
    try {
      await mkdir(backupPath, { mode: 0o700 })
    } catch (error) {
      if (error.code !== 'EEXIST') throw error
    }
  }
  let stat
  try {
    stat = await lstat(backupPath)
  } catch (error) {
    if (!create && error.code === 'ENOENT') throw conflict('The Lifeboat backup directory does not exist.')
    throw error
  }
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw conflict('The Lifeboat backup path must be a real directory, not a symbolic link or junction.')
  }
  const resolved = await realpath(backupPath)
  if (dirname(resolved) !== location.profileReal) {
    throw conflict('The Lifeboat backup directory resolves outside the selected profile.')
  }
  return { path: backupPath, real: resolved }
}

function processIsAlive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error.code !== 'ESRCH'
  }
}

async function inspectExistingLock(lockPath) {
  let stat
  try {
    stat = await lstat(lockPath)
  } catch (error) {
    if (error.code === 'ENOENT') return { missing: true }
    throw error
  }
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw conflict('The recovery lock path is not a safe regular file; inspect it manually before retrying.')
  }
  try {
    const metadata = JSON.parse(await readFile(lockPath, 'utf8'))
    if (!Number.isInteger(metadata.pid) || metadata.pid < 1 || typeof metadata.token !== 'string') {
      throw new Error('invalid lock metadata')
    }
    return processIsAlive(metadata.pid) ? { active: true, metadata } : { stale: true, metadata }
  } catch (error) {
    if (Date.now() - stat.mtimeMs < LOCK_INITIALIZATION_GRACE_MS) {
      return { active: true, metadata: undefined }
    }
    return { stale: true, metadata: undefined }
  }
}

async function acquireRecoveryLock(location) {
  const lockPath = join(location.profileDir, LOCK_FILENAME)
  assertChild(location.profileDir, lockPath)
  const token = randomUUID()
  for (let attempt = 0; attempt < 4; attempt += 1) {
    let handle
    try {
      handle = await open(lockPath, 'wx', 0o600)
    } catch (error) {
      if (error.code !== 'EEXIST') throw error
      const existing = await inspectExistingLock(lockPath)
      if (existing.missing) continue
      if (existing.active) {
        throw conflict('Another recovery operation is already running for this profile.')
      }
      const stalePath = join(location.profileDir, `.dsh-lifeboat-stale-lock-${randomUUID()}`)
      assertChild(location.profileDir, stalePath)
      try {
        await rename(lockPath, stalePath)
        await unlink(stalePath)
      } catch (replaceError) {
        if (replaceError.code === 'ENOENT') continue
        throw conflict(`Could not retire a stale recovery lock: ${replaceError.message}`)
      }
      continue
    }

    try {
      await handle.writeFile(`${JSON.stringify({
        schema: 'dsh-lifeboat-recovery-lock/v1',
        pid: process.pid,
        token,
        createdAt: new Date().toISOString(),
      })}\n`, 'utf8')
      await handle.sync()
    } catch (error) {
      try {
        await handle.close()
      } finally {
        await unlinkIfPresent(lockPath)
      }
      throw error
    }

    return {
      async release() {
        try {
          await handle.close()
        } catch (error) {
          return `Recovery lock handle could not be closed: ${error.message}`
        }
        try {
          const stat = await lstat(lockPath)
          if (!stat.isFile() || stat.isSymbolicLink()) {
            return 'Recovery lock ownership was lost before cleanup; the lock entry was left untouched.'
          }
          const current = JSON.parse(await readFile(lockPath, 'utf8'))
          if (current.token !== token) {
            return 'Recovery lock ownership was lost before cleanup; the replacement lock was left untouched.'
          }
          await unlink(lockPath)
          return undefined
        } catch (error) {
          if (error.code === 'ENOENT') return 'Recovery lock disappeared before cleanup.'
          return `Recovery lock cleanup failed: ${error.message}`
        }
      },
    }
  }
  throw conflict('Could not acquire the recovery lock after retiring stale entries.')
}

async function withRecoveryLock(options, operation) {
  const location = await safeProfileLocation(options.home, options.profile)
  const lock = await acquireRecoveryLock(location)
  let result
  let operationError
  try {
    result = await operation(location)
  } catch (error) {
    operationError = error
  }
  const lockWarning = await lock.release()
  if (operationError) {
    if (lockWarning) operationError.message += ` ${lockWarning}`
    throw operationError
  }
  if (lockWarning) result.warnings = [...(result.warnings ?? []), lockWarning]
  return result
}

function validateManifestBackup(raw) {
  let manifest
  try {
    manifest = JSON.parse(raw)
  } catch (error) {
    throw conflict(`Lifeboat backup is not valid JSON: ${error.message}`)
  }
  if (manifest === null || typeof manifest !== 'object' || Array.isArray(manifest)) {
    throw conflict('Lifeboat backup must contain a JSON object.')
  }
  const bundles = manifest.dsh?.profile?.bundles
  if (!Array.isArray(bundles) || bundles.some(bundle => typeof bundle !== 'string' || bundle === '')) {
    throw conflict('Lifeboat backup has an invalid dsh.profile.bundles value.')
  }
}

async function readVerifiedBackup(backupDirectory, backupPath, expectedHash) {
  let stat
  try {
    stat = await lstat(backupPath)
  } catch (error) {
    if (error.code === 'ENOENT') throw conflict('The selected Lifeboat backup does not exist.')
    throw error
  }
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw conflict('The selected Lifeboat backup must be a real file, not a symbolic link.')
  }
  const resolved = await realpath(backupPath)
  if (dirname(resolved) !== backupDirectory.real) {
    throw conflict('The selected Lifeboat backup resolves outside the backup directory.')
  }
  const raw = await readFile(backupPath, 'utf8')
  if (sha256(raw) !== expectedHash) {
    throw conflict('Lifeboat backup integrity check failed; the file has changed since it was created.')
  }
  validateManifestBackup(raw)
  return raw
}

async function writeAtomicManifest({ profile, profileReal, manifestMode, serialized, expectedCurrentHash, prefix }) {
  const temporaryPath = join(profile.dir, `.${prefix}-${randomUUID()}.tmp`)
  assertChild(profile.dir, temporaryPath)
  await writeExclusive(temporaryPath, serialized, manifestMode)
  try {
    await assertSafeManifest(profile, profileReal)
    const currentRaw = await readFile(profile.manifestPath, 'utf8')
    if (sha256(currentRaw) !== expectedCurrentHash) {
      throw conflict('Profile manifest changed during recovery. Refusing to overwrite newer changes.')
    }
    await rename(temporaryPath, profile.manifestPath)
  } catch (error) {
    try {
      await unlinkIfPresent(temporaryPath)
    } catch (cleanupError) {
      error.message += ` Temporary manifest cleanup also failed: ${cleanupError.message}`
    }
    throw error
  }
  const updated = await readProfile(profile.home, profile.profile)
  const expectedResultHash = sha256(serialized)
  if (updated.hash !== expectedResultHash) {
    throw conflict('Recovery write completed but the resulting manifest failed verification.')
  }
  return updated
}

function requireExpectedHash(value, name) {
  if (typeof value !== 'string' || !SHA256_PATTERN.test(value)) {
    throw badRequest(`${name} must be a full lowercase SHA-256 digest.`)
  }
  return value
}

/** Disable diagnosed bundles under a per-profile lock with a verified backup and manifest CAS. */
export async function applyRecovery(options) {
  const expectedManifestHash = requireExpectedHash(options.expectedManifestHash, 'expectedManifestHash')
  if (!Array.isArray(options.disableBundles)
    || options.disableBundles.some(bundle => typeof bundle !== 'string' || bundle === '')) {
    throw badRequest('disableBundles must be an array of non-empty bundle names.')
  }
  const disabled = [...new Set(options.disableBundles)]
  if (disabled.length === 0) throw badRequest('No diagnosed bundles were supplied for recovery.')

  return withRecoveryLock(options, async location => {
    const profile = await readProfile(location.home, location.profile)
    const manifestStat = await assertSafeManifest(profile, location.profileReal)
    if (profile.hash !== expectedManifestHash) {
      throw conflict('Profile manifest changed after diagnosis. Run the diagnosis again before applying recovery.')
    }
    if (disabled.some(bundle => !profile.bundles.includes(bundle))) {
      throw conflict('The recovery set contains a bundle that is not active in this profile.')
    }

    const next = structuredClone(profile.manifest)
    next.dsh.profile.bundles = profile.bundles.filter(bundle => !disabled.includes(bundle))
    const serialized = `${JSON.stringify(next, null, 2)}\n`
    const backupDirectory = await ensureBackupDirectory(location)
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    const backupPath = join(backupDirectory.path, `package.${stamp}.${profile.hash}.json`)
    assertChild(backupDirectory.path, backupPath)
    await writeExclusive(backupPath, profile.raw, manifestStat.mode & 0o777)
    await readVerifiedBackup(backupDirectory, backupPath, profile.hash)

    const updated = await writeAtomicManifest({
      profile,
      profileReal: location.profileReal,
      manifestMode: manifestStat.mode & 0o777,
      serialized,
      expectedCurrentHash: profile.hash,
      prefix: 'package.lifeboat',
    })
    return {
      profile: profile.profile,
      disabledBundles: disabled,
      backupPath,
      backupHash: profile.hash,
      manifestPath: profile.manifestPath,
      currentManifestHash: updated.hash,
    }
  })
}

/** Restore one hash-verified backup created inside the selected profile's backup directory. */
export async function restoreRecovery(options) {
  const expectedManifestHash = requireExpectedHash(options.expectedManifestHash, 'expectedManifestHash')
  if (typeof options.backupName !== 'string') throw badRequest('Invalid Lifeboat backup name.')
  const backupName = basename(options.backupName)
  const match = BACKUP_NAME_PATTERN.exec(backupName)
  if (backupName !== options.backupName || !match) throw badRequest('Invalid Lifeboat backup name.')
  const embeddedHashFragment = match[1]
  const expectedBackupHash = options.expectedBackupHash === undefined
    ? embeddedHashFragment.length === 64
      ? embeddedHashFragment
      : undefined
    : requireExpectedHash(options.expectedBackupHash, 'expectedBackupHash')
  if (!expectedBackupHash) {
    throw badRequest('A full expectedBackupHash is required to restore a legacy Lifeboat backup name.')
  }
  if (!expectedBackupHash.startsWith(embeddedHashFragment)) {
    throw conflict('The selected backup does not match the recovery record.')
  }

  return withRecoveryLock(options, async location => {
    const profile = await readProfile(location.home, location.profile)
    const manifestStat = await assertSafeManifest(profile, location.profileReal)
    if (profile.hash !== expectedManifestHash) {
      throw conflict('Profile manifest changed after recovery. Refusing to overwrite newer changes.')
    }
    const backupDirectory = await ensureBackupDirectory(location, false)
    const backupPath = join(backupDirectory.path, backupName)
    assertChild(backupDirectory.path, backupPath)
    const backupRaw = await readVerifiedBackup(backupDirectory, backupPath, expectedBackupHash)

    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    const restoreGuard = join(backupDirectory.path, `pre-restore.${stamp}.${profile.hash}.json`)
    assertChild(backupDirectory.path, restoreGuard)
    await writeExclusive(restoreGuard, profile.raw, manifestStat.mode & 0o777)
    await readVerifiedBackup(backupDirectory, restoreGuard, profile.hash)

    const restored = await writeAtomicManifest({
      profile,
      profileReal: location.profileReal,
      manifestMode: manifestStat.mode & 0o777,
      serialized: backupRaw,
      expectedCurrentHash: profile.hash,
      prefix: 'package.lifeboat-restore',
    })
    return {
      profile: profile.profile,
      restoredFrom: backupPath,
      backupHash: expectedBackupHash,
      restoreGuard,
      restoreGuardHash: profile.hash,
      currentManifestHash: restored.hash,
    }
  })
}
