import { createHash, randomBytes } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { chmod, mkdir, open, readFile, rename, rm } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

const MAX_BINARY_BYTES = 120 * 1024 * 1024
const manifestUrl = new URL('./learn-checksums.json', import.meta.url)
const packageUrl = new URL('../package.json', import.meta.url)

async function fileDigest(path) {
  try {
    const hash = createHash('sha256')
    for await (const chunk of createReadStream(path)) hash.update(chunk)
    return hash.digest('hex')
  } catch (error) {
    if (error?.code === 'ENOENT') return undefined
    throw error
  }
}

/** Download and verify the executable once for the current platform and version. */
export async function resolveLearnBinary(options = {}) {
  const { env = process.env, platform = process.platform, arch = process.arch } = options
  if (env.DSH_CAVEMAN_LEARN_BINARY) return env.DSH_CAVEMAN_LEARN_BINARY
  const manifest = options.manifest ?? JSON.parse(await readFile(manifestUrl, 'utf8'))
  const version = JSON.parse(await readFile(packageUrl, 'utf8')).version
  if (manifest.version !== version || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u.test(version)) throw new Error('Invalid analyzer version manifest')
  const os = { linux: 'linux', darwin: 'darwin', win32: 'win32' }[platform]
  const cpu = { x64: 'amd64', arm64: 'arm64' }[arch]
  const entry = manifest.binaries?.[`${platform}-${arch}`]
  const expectedName = os && cpu ? `dsh-caveman-learn_${os}_${cpu}` : undefined
  if (!expectedName || entry?.name !== expectedName || !/^[a-f0-9]{64}$/u.test(entry.sha256 ?? '')) {
    throw new Error(`No verified analyzer is available for ${platform}/${arch}`)
  }
  const directory = join(options.cacheRoot ?? join(homedir(), '.dsh', 'cache', 'dsh-caveman', 'learn'), version)
  const target = join(directory, `${expectedName}${platform === 'win32' ? '.exe' : ''}`)
  if (await fileDigest(target) === entry.sha256) return target
  await mkdir(directory, { recursive: true, mode: 0o700 })
  const temporary = join(directory, `.${expectedName}.${randomBytes(12).toString('hex')}.tmp`)
  let handle
  let dispatcher
  try {
    const url = `https://github.com/Lornatang/dsh-plugin/releases/download/dsh-caveman-v${version}/${expectedName}`
    let fetcher = options.fetcher ?? fetch
    if (!options.fetcher && (env.https_proxy || env.HTTPS_PROXY || env.http_proxy || env.HTTP_PROXY)) {
      const { EnvHttpProxyAgent, fetch: proxyFetch } = await import('undici')
      dispatcher = new EnvHttpProxyAgent({
        httpProxy: env.http_proxy ?? env.HTTP_PROXY ?? '',
        httpsProxy: env.https_proxy ?? env.HTTPS_PROXY ?? '',
        noProxy: env.no_proxy ?? env.NO_PROXY ?? '',
      })
      fetcher = (input, init) => proxyFetch(input, { ...init, dispatcher })
    }
    const response = await fetcher(url, { signal: AbortSignal.timeout(120_000) })
    if (!response.ok || !response.body) throw new Error(`Analyzer download failed (HTTP ${response.status})`)
    const advertised = Number(response.headers.get('content-length'))
    if (advertised > MAX_BINARY_BYTES) throw new Error('Analyzer download exceeds the size limit')
    handle = await open(temporary, 'wx', 0o700)
    const hash = createHash('sha256')
    let size = 0
    for await (const chunk of response.body) {
      size += chunk.length
      if (size > MAX_BINARY_BYTES) throw new Error('Analyzer download exceeds the size limit')
      hash.update(chunk)
      await handle.writeFile(chunk)
    }
    await handle.close()
    handle = undefined
    if (hash.digest('hex') !== entry.sha256) throw new Error('Analyzer checksum mismatch')
    await chmod(temporary, 0o700)
    try { await rename(temporary, target) } catch (error) {
      // Another invocation may have finished the same verified download.
      if (await fileDigest(target) !== entry.sha256) throw error
    }
    return target
  } finally {
    await handle?.close().catch(() => {})
    await rm(temporary, { force: true }).catch(() => {})
    await dispatcher?.destroy().catch(() => {})
  }
}
