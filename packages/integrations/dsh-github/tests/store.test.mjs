import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { SessionStore, sessionFileFor } from '../lib/store.js'

const keyA = Buffer.alloc(32, 23).toString('base64')
const keyB = Buffer.alloc(32, 24).toString('base64')
process.env.DSH_GITHUB_ENCRYPTION_KEY = keyA

async function tempFile() {
  const root = await mkdtemp(join(tmpdir(), 'dsh-github-store-'))
  return { root, file: sessionFileFor('github', 'https://api.githubcopilot.com/mcp/', join(root, 'cordis.patch.yml')) }
}

test('roundtrips an encrypted session without plaintext on disk', async () => {
  const { root, file } = await tempFile()
  try {
    await new SessionStore(file).patch({ source: 'token', token: 'roundtrip', oauthScopes: ['repo'] })
    const session = await new SessionStore(file).load()
    assert.equal(session.source, 'token')
    assert.equal(session.token, 'roundtrip')
    assert.deepEqual(session.oauthScopes, ['repo'])
    assert.ok(!(await readFile(file, 'utf8')).includes('roundtrip'))
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('drops malformed fields from a decrypted session', async () => {
  const { root, file } = await tempFile()
  try {
    const store = new SessionStore(file)
    await store.patch({ source: 'oauth', token: 'goodtoken', oauthScopes: ['repo'], oauthExpiresAt: 123, oauthRefreshToken: 'refresh' })
    // Corrupt fields through the same encrypted write path a compromised writer would use.
    await store.patch({ source: 'bogus', token: 42, oauthScopes: 'repo', oauthExpiresAt: 'soon', oauthClientId: { evil: true } })
    const session = await new SessionStore(file).load()
    assert.equal(session.version, 1)
    assert.equal(session.source, undefined)
    assert.equal(session.token, undefined)
    assert.equal(session.oauthScopes, undefined)
    assert.equal(session.oauthExpiresAt, undefined)
    assert.equal(session.oauthClientId, undefined)
    assert.equal(session.oauthRefreshToken, 'refresh')
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('rejects a file encrypted with a different key', async () => {
  const { root, file } = await tempFile()
  try {
    await new SessionStore(file).patch({ token: 'secret' })
    process.env.DSH_GITHUB_ENCRYPTION_KEY = keyB
    try {
      await assert.rejects(new SessionStore(file).load(), /cannot decrypt/)
    } finally { process.env.DSH_GITHUB_ENCRYPTION_KEY = keyA }
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('rejects a tampered ciphertext', async () => {
  const { root, file } = await tempFile()
  try {
    await new SessionStore(file).patch({ token: 'secret' })
    const envelope = JSON.parse(await readFile(file, 'utf8'))
    const ciphertext = Buffer.from(envelope.ciphertext, 'base64')
    ciphertext[0] ^= 0xff
    envelope.ciphertext = ciphertext.toString('base64')
    await writeFile(file, JSON.stringify(envelope))
    await assert.rejects(new SessionStore(file).load(), /cannot decrypt/)
  } finally { await rm(root, { recursive: true, force: true }) }
})
