import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join, resolve } from 'node:path'
import { test } from 'node:test'
import { findDesktopHost } from '../scripts/find-dsh.mjs'

test('desktop discovery respects earlier PATH commands and explicit selection', { skip: process.platform !== 'win32' }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-launch-test-'))
  try {
    const standalone = join(root, 'standalone')
    const desktop = join(root, 'desktop')
    const bin = join(desktop, 'resources', 'runtime', 'cli', 'bin')
    await mkdir(standalone, { recursive: true })
    await mkdir(bin, { recursive: true })
    await writeFile(join(standalone, 'dsh.exe'), '')
    await writeFile(join(desktop, 'DeepSeek Harness.exe'), '')
    await writeFile(join(desktop, 'resources', 'app.asar'), '')
    await writeFile(join(bin, 'dsh.cmd'), '')

    const expected = {
      executable: join(desktop, 'DeepSeek Harness.exe'),
      entry: join(desktop, 'resources', 'app.asar', 'dsh', 'node_modules', '@deepseek-ai', 'dsh-desktop-host', 'lib', 'cli.js'),
    }
    assert.deepEqual(findDesktopHost({ PATH: bin }), expected)
    assert.equal(findDesktopHost({ PATH: [standalone, bin].join(delimiter) }), null)
    assert.equal(findDesktopHost({ PATH: bin, DSH_TEST_EXECUTABLE: 'custom' }), null)

    await rm(join(standalone, 'dsh.exe'))
    await writeFile(join(standalone, 'dsh.cmd'), '')
    assert.equal(findDesktopHost({ PATH: [standalone, bin].join(delimiter) }), null)
  } finally {
    assert.equal(dirname(resolve(root)), resolve(tmpdir()))
    assert.ok(root.includes('dsh-launch-test-'))
    await rm(root, { recursive: true, force: true })
  }
})
