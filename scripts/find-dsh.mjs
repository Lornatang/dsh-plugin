import { existsSync } from 'node:fs'
import { delimiter, join, resolve } from 'node:path'

export function findDesktopHost(env = process.env) {
  if (process.platform !== 'win32' || env.DSH_TEST_EXECUTABLE) return null
  for (const directory of (env.PATH || '').split(delimiter).filter(Boolean)) {
    // Do not silently choose a later desktop host over an earlier command.
    if (['dsh.com', 'dsh.exe', 'dsh.bat'].some(name => existsSync(join(directory, name)))) return null
    if (!existsSync(join(directory, 'dsh.cmd'))) continue
    const root = resolve(directory, '../../../..')
    const executable = join(root, 'DeepSeek Harness.exe')
    const asar = join(root, 'resources', 'app.asar')
    if (existsSync(executable) && existsSync(asar)) {
      return { executable, entry: join(asar, 'dsh', 'node_modules', '@deepseek-ai', 'dsh-desktop-host', 'lib', 'cli.js') }
    }
    return null
  }
  return null
}
