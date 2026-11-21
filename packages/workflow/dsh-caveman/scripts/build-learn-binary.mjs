import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { releaseGoBuild, writeDarwinLinkStubs } from '../vendor/caveman/scripts/build-release-binaries.mjs'

const [goos, arch, destination] = process.argv.slice(2)
if (!['linux', 'darwin', 'windows'].includes(goos) || !['amd64', 'arm64'].includes(arch) || !destination || !process.env.ZIG) {
  throw new Error('usage: build-learn-binary.mjs linux|darwin|windows amd64|arm64 OUTPUT (ZIG is required)')
}
const root = fileURLToPath(new URL('../vendor/caveman/', import.meta.url))
const version = readFileSync(join(root, 'packages', 'cli', 'BINARY_RELEASE'), 'utf8').trim()
let darwinStubs = ''
if (goos === 'darwin') {
  const goroot = execFileSync('go', ['env', 'GOROOT'], { encoding: 'utf8' }).trim()
  darwinStubs = mkdtempSync(join(tmpdir(), 'dsh-caveman-darwin-stubs-'))
  writeDarwinLinkStubs(goroot, darwinStubs)
}
const { env, args } = releaseGoBuild('caveman-proxy', goos, arch, { zig: process.env.ZIG, darwinStubs, version })
execFileSync('go', ['build', ...args, '-o', resolve(destination), './proxy/cmd/caveman-proxy'], {
  cwd: root, stdio: 'inherit', env: { ...process.env, ...env },
})
