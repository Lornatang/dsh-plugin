import { createHash } from 'node:crypto'
import { readFile, readdir } from 'node:fs/promises'
import { dirname, join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const snapshot = join(root, 'upstream')
const lock = JSON.parse(await readFile(join(root, 'upstream.lock.json'), 'utf8'))
const actual = []
async function walk(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) await walk(path)
    else if (entry.isFile()) actual.push(relative(snapshot, path).split(sep).join('/'))
    else throw new Error(`Unexpected non-file in upstream snapshot: ${path}`)
  }
}
await walk(snapshot)
const expected = new Set(lock.files.map(file => file.path))
for (const path of actual) if (!expected.has(path)) throw new Error(`Unexpected upstream file: ${path}`)
for (const file of lock.files) {
  const bytes = await readFile(join(snapshot, file.path))
  const blob = createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex')
  if (blob !== file.blob) throw new Error(`Upstream blob differs: ${file.path}`)
}
console.log(`Verified ${lock.files.length} upstream blobs against ${lock.commit}.`)
