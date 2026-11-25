import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { after, before, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import SkillRegistry from '@deepseek-ai/dsh-skill'
import plugin from '../lib/index.js'

let context
let root
let skillDirectory

before(async () => {
  root = await mkdtemp(join(tmpdir(), 'dsh-security-validator-'))
  context = new Context()
  await context.plugin(SkillRegistry)
  await context.plugin(plugin)
  const skill = await context.skills.get('security-audit')
  assert.equal(skill?.resourceBase?.kind, 'directory')
  skillDirectory = skill.resourceBase.path
})

after(async () => {
  await context?.fiber.dispose()
  if (root) {
    assert.equal(dirname(resolve(root)), resolve(tmpdir()))
    assert.ok(root.includes('dsh-security-validator-'))
    await rm(root, { recursive: true, force: true })
  }
})

function invoke(script, file, extra = []) {
  const result = spawnSync(process.execPath, [...extra, join(skillDirectory, script), file], { encoding: 'utf8', timeout: 8000 })
  assert.notEqual(result.error?.code, 'ETIMEDOUT', 'validator must not block on the input')
  return result
}

test('Windows bounded reads preserve multi-chunk UTF-8 and the exact byte limit', { skip: process.platform !== 'win32' }, async () => {
  const { readFileWithinLimit } = createRequire(import.meta.url)('../skills/security-audit/windows-safe-input.cjs')
  const file = join(root, 'multi-chunk-utf8.json')
  const contents = `${'a'.repeat(65535)}€${'b'.repeat(65536)}`
  const bytes = Buffer.byteLength(contents)
  await writeFile(file, contents)
  assert.equal(readFileWithinLimit(file, bytes), contents)
  assert.throws(() => readFileWithinLimit(file, bytes - 1), /input exceeds .* byte limit/u)
})

test('POSIX bounded reads handle growth after stat without passing the byte limit', {
  skip: process.platform === 'win32' || !fs.constants.O_NOFOLLOW || !fs.constants.O_NONBLOCK,
}, async (t) => {
  const { readFileWithinLimit } = createRequire(import.meta.url)('../skills/security-audit/bounded-input.cjs')
  const file = join(root, 'growing-input.json')
  const initial = 'a'.repeat(65535)
  const suffix = '€\n'
  const bytes = Buffer.byteLength(initial + suffix)
  const statFile = fs.fstatSync
  let grow = true
  t.mock.method(fs, 'fstatSync', descriptor => {
    const stat = statFile(descriptor)
    if (grow) {
      grow = false
      fs.appendFileSync(file, suffix)
    }
    return stat
  })
  await writeFile(file, initial)
  assert.equal(readFileWithinLimit(file, bytes), initial + suffix)
  await writeFile(file, initial)
  grow = true
  assert.throws(() => readFileWithinLimit(file, bytes - 1), /input exceeds .* byte limit/u)
})

for (const script of ['validate-findings.cjs', 'validate-coverage-ledger.cjs']) {
  test(`${script} accepts an ordinary valid JSON file`, async () => {
    const file = join(root, `${script}.json`)
    await writeFile(file, '[]')
    const result = invoke(script, file)
    assert.equal(result.status, 0, result.stderr)
    assert.match(result.stdout, /PASS:/u)
  })

  test(`${script} rejects invalid UTF-8 input`, async () => {
    const file = join(root, `${script}.bad`)
    await writeFile(file, Buffer.from([0xff, 0xfe]))
    const result = invoke(script, file)
    assert.equal(result.status, 1)
    assert.match(result.stderr, /not valid UTF-8/u)
  })

  test(`${script} rejects malformed JSON`, async () => {
    const file = join(root, `${script}.malformed`)
    await writeFile(file, '[}')
    const result = invoke(script, file)
    assert.equal(result.status, 1)
    assert.match(result.stderr, /(?:parse|JSON)/iu)
  })

  test(`${script} rejects a UTF-8 byte-order mark consistently across platforms`, async () => {
    const file = join(root, `${script}.bom`)
    await writeFile(file, Buffer.from([0xef, 0xbb, 0xbf, 0x5b, 0x5d]))
    const result = invoke(script, file)
    assert.equal(result.status, 1, result.stdout)
    assert.match(result.stderr, /(?:parse|JSON)/iu)
  })

  test(`${script} rejects oversized input`, async () => {
    const file = join(root, `${script}.large`)
    await writeFile(file, Buffer.alloc(5 * 1024 * 1024 + 1, 0x20))
    const result = invoke(script, file)
    assert.equal(result.status, 1)
    assert.match(result.stderr, /input exceeds .* byte limit/u)
  })

  test(`${script} rejects Windows device and pipe paths`, { skip: process.platform !== 'win32' }, () => {
    for (const path of ['NUL', '\\\\.\\pipe\\dsh-security-audit-test', '\\\\localhost\\share\\data.json']) {
      const result = invoke(script, path)
      assert.equal(result.status, 1)
      assert.match(result.stderr, /input.*(?:path|device)/iu)
    }
  })

  test(`${script} rejects reparse-point parent directories`, { skip: process.platform !== 'win32' }, async () => {
    const target = join(root, `${script}-target`)
    const link = join(root, `${script}-junction`)
    await mkdir(target)
    await writeFile(join(target, 'data.json'), '[]')
    await symlink(target, link, 'junction')
    const result = invoke(script, join(link, 'data.json'))
    assert.equal(result.status, 1)
    assert.match(result.stderr, /(?:reparse|symlink)/iu)
  })

  test(`${script} rejects a substituted drive that hides a reparse point`, { skip: process.platform !== 'win32' }, async t => {
    const target = join(root, `${script}-subst-target`)
    const link = join(root, `${script}-subst-junction`)
    await mkdir(join(target, 'sub'), { recursive: true })
    await writeFile(join(target, 'sub', 'data.json'), '[]')
    await symlink(target, link, 'junction')
    const native = createRequire(import.meta.url)(`@koromix/koffi-win32-${process.arch}`)
    const query = native.load('kernel32.dll').func('uint32_t __stdcall QueryDosDeviceW(const char16_t *, _Out_ void *, uint32_t)')
    const mapping = drive => {
      const buffer = Buffer.alloc(65536)
      const length = query(drive, buffer, buffer.length / 2)
      return length ? buffer.toString('utf16le', 0, length * 2).split('\0')[0] : null
    }
    const drive = ['Z:', 'Y:', 'X:', 'W:', 'V:'].find(letter => mapping(letter) === null)
    if (!drive) { t.skip('no unused drive letter is available'); return }
    const expected = `\\??\\${join(link, 'sub')}`
    const created = spawnSync('subst', [drive, join(link, 'sub')], { encoding: 'utf8', timeout: 5000 })
    if (created.status !== 0) { t.skip('subst is unavailable'); return }
    try {
      assert.equal(mapping(drive)?.toLowerCase(), expected.toLowerCase())
      const result = invoke(script, `${drive}\\data.json`)
      assert.equal(result.status, 1, result.stdout)
      assert.match(result.stderr, /(?:local drive|redirected|substituted)/iu)
    } finally {
      if (mapping(drive)?.toLowerCase() === expected.toLowerCase()) {
        const removed = spawnSync('subst', [drive, '/d'], { encoding: 'utf8', timeout: 5000 })
        assert.equal(removed.status, 0, 'temporary substituted drive must be removed')
      }
    }
  })

  test(`${script} rejects leaf symlinks`, { skip: process.platform !== 'win32' }, async t => {
    const target = join(root, `${script}-link-target.json`)
    const link = join(root, `${script}-link.json`)
    await writeFile(target, '[]')
    try { await symlink(target, link, 'file') } catch (error) {
      if (error.code === 'EPERM' || error.code === 'EACCES') { t.skip('file symlink creation is unavailable'); return }
      throw error
    }
    const result = invoke(script, link)
    assert.equal(result.status, 1)
    assert.match(result.stderr, /(?:reparse|symlink|opened safely)/iu)
  })

  test(`${script} fails closed if native Windows support is missing`, { skip: process.platform !== 'win32' }, async () => {
    const file = join(root, `${script}.native.json`)
    await writeFile(file, '[]')
    const fixture = fileURLToPath(new URL('./fixtures/block-native.cjs', import.meta.url))
    const result = invoke(script, file, ['--require', fixture])
    assert.equal(result.status, 1)
    assert.match(result.stderr, /native Windows input protection is unavailable/u)
  })
}
