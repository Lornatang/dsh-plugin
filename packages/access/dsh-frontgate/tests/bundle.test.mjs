import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const root = new URL('..', import.meta.url)
const manifest = JSON.parse(readFileSync(new URL('package.json', root), 'utf8'))

test('the DSH bundle loads the published package name', () => {
  const patch = readFileSync(new URL('cordis.patch.yml', root), 'utf8')
  assert.ok(patch.includes("name: '" + manifest.name + "'"))
  assert.equal(manifest.dsh.bundle.patch, './cordis.patch.yml')
})
