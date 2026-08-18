import { randomUUID } from 'node:crypto'
import { mkdir, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { resolveDshHome } from './manifest.js'

export const name = 'lifeboat-health-marker'

async function writeHealthMarker() {
  const root = join(resolveDshHome(), 'lifeboat')
  const target = join(root, 'last-healthy.json')
  const temporary = join(root, `.last-healthy-${process.pid}-${randomUUID()}.tmp`)
  await mkdir(root, { recursive: true })
  await writeFile(temporary, `${JSON.stringify({
    schema: 'dsh-lifeboat-health/v1',
    recordedAt: new Date().toISOString(),
    pid: process.pid,
    node: process.version,
  }, null, 2)}\n`, { encoding: 'utf8', flag: 'w' })
  await rename(temporary, target)
}

/** Record a healthy Loader settlement without hosting the rescue UI in-process. */
export function apply(ctx) {
  const settled = ctx.get('loader')?.await()
  const record = () => void writeHealthMarker().catch(error => {
    console.warn(`[dsh-lifeboat] health marker not written: ${error.message}`)
  })
  if (settled === undefined) record()
  else void settled.then(() => {
    if (ctx.get('loader') !== undefined) record()
  }, () => {})
}
