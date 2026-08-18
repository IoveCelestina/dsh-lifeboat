import { randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { copyFile, mkdir, rename, unlink, writeFile } from 'node:fs/promises'
import { basename, dirname, join, relative, sep } from 'node:path'
import { readProfile, sha256 } from './manifest.js'

function assertChild(parent, target) {
  const rel = relative(parent, target)
  if (rel === '' || rel === '..' || rel.startsWith(`..${sep}`)) {
    throw new Error(`Recovery target escapes the selected profile: ${target}`)
  }
}

/** Disable diagnosed bundles with a timestamped backup and manifest hash check. */
export async function applyRecovery(options) {
  const profile = await readProfile(options.home, options.profile)
  if (profile.hash !== options.expectedManifestHash) {
    throw new Error('Profile manifest changed after diagnosis. Run the diagnosis again before applying recovery.')
  }
  const disabled = [...new Set(options.disableBundles ?? [])]
  if (disabled.length === 0) throw new Error('No diagnosed bundles were supplied for recovery.')
  if (disabled.some(bundle => !profile.bundles.includes(bundle))) {
    throw new Error('The recovery set contains a bundle that is not active in this profile.')
  }

  const next = structuredClone(profile.manifest)
  next.dsh.profile.bundles = profile.bundles.filter(bundle => !disabled.includes(bundle))
  const backupDir = join(profile.dir, '.lifeboat-backups')
  assertChild(profile.dir, backupDir)
  await mkdir(backupDir, { recursive: true })
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const backupPath = join(backupDir, `package.${stamp}.${profile.hash.slice(0, 12)}.json`)
  const temporaryPath = join(profile.dir, `.package.lifeboat-${randomUUID()}.tmp`)
  const serialized = `${JSON.stringify(next, null, 2)}\n`
  assertChild(profile.dir, backupPath)
  assertChild(profile.dir, temporaryPath)

  await copyFile(profile.manifestPath, backupPath, constants.COPYFILE_EXCL)
  try {
    await writeFile(temporaryPath, serialized, { encoding: 'utf8', flag: 'wx' })
    await rename(temporaryPath, profile.manifestPath)
  } catch (error) {
    try {
      await unlink(temporaryPath)
    } catch (cleanupError) {
      if (cleanupError.code !== 'ENOENT') throw cleanupError
    }
    throw error
  }
  return {
    profile: profile.profile,
    disabledBundles: disabled,
    backupPath,
    manifestPath: profile.manifestPath,
    currentManifestHash: sha256(serialized),
  }
}

/** Restore one backup created inside the selected profile's backup directory. */
export async function restoreRecovery(options) {
  const profile = await readProfile(options.home, options.profile)
  const backupDir = join(profile.dir, '.lifeboat-backups')
  const backupName = basename(options.backupName ?? '')
  if (backupName !== options.backupName || !/^package\..+\.[a-f0-9]{12}\.json$/.test(backupName)) {
    throw new Error('Invalid Lifeboat backup name.')
  }
  const backupPath = join(backupDir, backupName)
  assertChild(backupDir, backupPath)
  const currentHash = profile.hash
  if (options.expectedManifestHash && currentHash !== options.expectedManifestHash) {
    throw new Error('Profile manifest changed after recovery. Refusing to overwrite newer changes.')
  }
  const restoreGuard = join(backupDir, `pre-restore.${new Date().toISOString().replace(/[:.]/g, '-')}.${currentHash.slice(0, 12)}.json`)
  const temporaryPath = join(profile.dir, `.package.lifeboat-restore-${randomUUID()}.tmp`)
  assertChild(profile.dir, temporaryPath)
  await copyFile(profile.manifestPath, restoreGuard, constants.COPYFILE_EXCL)
  try {
    await copyFile(backupPath, temporaryPath, constants.COPYFILE_EXCL)
    await rename(temporaryPath, profile.manifestPath)
  } catch (error) {
    try {
      await unlink(temporaryPath)
    } catch (cleanupError) {
      if (cleanupError.code !== 'ENOENT') throw cleanupError
    }
    throw error
  }
  return { profile: profile.profile, restoredFrom: backupPath, restoreGuard }
}
