import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { readFile, stat, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'

const artifactRoot = process.argv[2] && resolve(process.argv[2])
if (!artifactRoot) throw new Error('usage: generate-learn-checksums.mjs ARTIFACT_DIRECTORY')
const version = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')).version
const binaries = {}
for (const os of ['linux', 'darwin', 'windows']) {
  for (const arch of ['amd64', 'arm64']) {
    const platform = os === 'windows' ? 'win32' : os
    const cpu = arch === 'amd64' ? 'x64' : arch
    const name = `dsh-caveman-learn_${platform}_${arch}`
    const path = join(artifactRoot, `analyzer-${os}-${arch}`, name)
    const info = await stat(path)
    if (!info.isFile() || info.size < 1 || info.size > 120 * 1024 * 1024) throw new Error(`Invalid analyzer artifact: ${path}`)
    const hash = createHash('sha256')
    for await (const chunk of createReadStream(path)) hash.update(chunk)
    binaries[`${platform}-${cpu}`] = { name, sha256: hash.digest('hex') }
  }
}
await writeFile(new URL('./learn-checksums.json', import.meta.url), `${JSON.stringify({ version, binaries }, null, 2)}\n`)
