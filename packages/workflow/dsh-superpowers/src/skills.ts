import { readFileSync, readdirSync } from 'node:fs'
import { join, sep } from 'node:path'
import type { SkillCandidate, SkillDefinition, SkillProvider } from '@deepseek-ai/dsh-skill'
import { parse } from 'yaml'

const provider = 'dsh-superpowers'
const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u

export function loadSkills(root: string): { provider: SkillProvider; introduction: string } {
  const candidates: SkillCandidate[] = []
  const definitions = new Map<string, SkillDefinition>()
  let introduction: string | undefined

  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const directory = join(root, entry.name)
    const path = join(directory, 'SKILL.md')
    const markdown = readFileSync(path, 'utf8')
    const header = frontmatter.exec(markdown)
    const metadata = header?.[1] ? parse(header[1]) as Record<string, unknown> | null : null
    if (!header || typeof metadata !== 'object' || metadata === null ||
        metadata.name !== entry.name || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(entry.name) ||
        typeof metadata.description !== 'string' || !metadata.description.trim()) {
      throw new Error(`dsh-superpowers: invalid skill metadata in ${path}`)
    }
    const definition: SkillDefinition = {
      name: entry.name,
      description: metadata.description.trim().replace(/\s+/gu, ' '),
      path,
      provider,
      source: 'bundled',
      resourceBase: { kind: 'directory', path: directory.split(sep).join('/') },
      invocation: {
        modelInvocable: metadata['disable-model-invocation'] !== true,
        userInvocable: metadata['user-invocable'] !== false,
      },
      content: markdown.slice(header[0].length),
    }
    definitions.set(entry.name, definition)
    const { content: _content, ...summary } = definition
    candidates.push({ ...summary, rank: 600, locator: entry.name })
    if (entry.name === 'using-superpowers') introduction = markdown.trimEnd()
  }

  if (!introduction) throw new Error('dsh-superpowers: missing using-superpowers bootstrap skill')
  return {
    introduction,
    provider: {
      name: provider,
      async list({ signal }) {
        signal?.throwIfAborted()
        return candidates
      },
      async get(candidate, { signal }) {
        signal?.throwIfAborted()
        return candidate.locator === candidate.name ? definitions.get(candidate.name) : undefined
      },
    },
  }
}
