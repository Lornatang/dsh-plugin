import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import test from 'node:test'
import { resolveLearnBinary } from '../scripts/learn-binary.mjs'

test('the analyzer download is verified, cached, and repaired after modification', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-caveman-download-'))
  const bytes = Buffer.from('test executable')
  const sha256 = createHash('sha256').update(bytes).digest('hex')
  const version = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')).version
  const manifest = { version, binaries: { 'linux-x64': { name: 'dsh-caveman-learn_linux_amd64', sha256 } } }
  let downloads = 0
  const fetcher = async url => {
    downloads++
    assert.equal(url, `https://github.com/Lornatang/dsh-caveman/releases/download/v${version}/dsh-caveman-learn_linux_amd64`)
    return new Response(bytes)
  }
  try {
    const options = { env: {}, platform: 'linux', arch: 'x64', cacheRoot: directory, manifest, fetcher }
    const path = await resolveLearnBinary(options)
    assert.deepEqual(await readFile(path), bytes)
    assert.equal(downloads, 1)
    assert.equal(await resolveLearnBinary(options), path)
    assert.equal(downloads, 1, 'a verified cached binary does not download again')
    await writeFile(path, 'tampered')
    assert.equal(await resolveLearnBinary(options), path)
    assert.deepEqual(await readFile(path), bytes)
    assert.equal(downloads, 2)
    await assert.rejects(resolveLearnBinary({ ...options, cacheRoot: join(directory, 'bad'), fetcher: async () => new Response('wrong bytes') }), /checksum/u)
    assert.equal(await resolveLearnBinary({ env: { DSH_CAVEMAN_LEARN_BINARY: '/explicit/binary' } }), '/explicit/binary')
  } finally {
    if (dirname(resolve(directory)) !== resolve(tmpdir()) || !directory.includes('dsh-caveman-download-')) throw new Error('unexpected test directory')
    await rm(directory, { recursive: true, force: true, maxRetries: 3 })
  }
})

test('the analyzer download uses the configured HTTPS proxy', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-caveman-proxy-download-'))
  const version = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')).version
  const manifest = { version, binaries: { 'linux-x64': { name: 'dsh-caveman-learn_linux_amd64', sha256: '0'.repeat(64) } } }
  const proxy = createServer()
  const connected = []
  proxy.on('connect', (request, socket) => {
    connected.push(request.url)
    socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n')
  })
  const originalFetch = globalThis.fetch
  try {
    await new Promise((resolve, reject) => proxy.listen(0, '127.0.0.1', resolve).on('error', reject))
    globalThis.fetch = async () => { throw new Error('unexpected direct download') }
    for (const variable of ['HTTPS_PROXY', 'http_proxy']) {
      await assert.rejects(resolveLearnBinary({ env: { [variable]: `http://127.0.0.1:${proxy.address().port}` }, platform: 'linux', arch: 'x64', cacheRoot: directory, manifest }), /fetch failed/u)
    }
    assert.deepEqual(connected, ['github.com:443', 'github.com:443'])
  } finally {
    globalThis.fetch = originalFetch
    if (proxy.listening) await new Promise(resolve => proxy.close(resolve))
    if (dirname(resolve(directory)) !== resolve(tmpdir()) || !directory.includes('dsh-caveman-proxy-download-')) throw new Error('unexpected test directory')
    await rm(directory, { recursive: true, force: true, maxRetries: 3 })
  }
})
