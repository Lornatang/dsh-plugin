import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

const [directory] = process.argv.slice(2)
if (!directory) throw new Error('Usage: node scripts/write-learn-checksums.mjs ASSET_DIRECTORY')

const { version } = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
const binaries = {}
for (const platform of ['linux', 'darwin', 'win32']) {
  for (const [arch, suffix] of [['x64', 'amd64'], ['arm64', 'arm64']]) {
    const name = `dsh-caveman-learn_${platform}_${suffix}`
    const hash = createHash('sha256')
    for await (const chunk of createReadStream(join(directory, name))) hash.update(chunk)
    binaries[`${platform}-${arch}`] = { name, sha256: hash.digest('hex') }
  }
}

const checksums = new URL('./learn-checksums.json', import.meta.url)
await writeFile(checksums, JSON.stringify({ version, binaries }, null, 2) + '\n')
