import { readFile } from 'node:fs/promises'
import { isAbsolute, join, sep } from 'node:path'
import type { SkillCandidate, SkillDefinition, SkillProvider, SkillProviderControl } from '@deepseek-ai/dsh-skill'
import { parse as parseYaml } from 'yaml'

const PROVIDER = 'dsh-caveman'
const RANK = 600
const NAMES = [
  'caveman', 'ultracave', 'megacave', 'caveman-help',
  'caveman-commit', 'caveman-review', 'caveman-compress', 'caveman-stats',
  'cavecrew', 'caveman-discover', 'caveman-explore', 'caveman-learn',
  'caveman-manage', 'caveman-optimize', 'caveman-evidence-review', 'caveman-setup',
  'investigate-first', 'lean-build', 'migration', 'safe-refactor', 'surgical-patch', 'verify-and-stop',
] as const
const knownNames: ReadonlySet<string> = new Set(NAMES)
type SkillRead = { description: string; content: string; modelInvocable: boolean; userInvocable: boolean }

async function readSkill(root: string, name: string, signal?: AbortSignal): Promise<SkillRead> {
  const path = join(root, name, 'SKILL.md')
  const raw = await readFile(path, { encoding: 'utf8', signal })
  const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u.exec(raw)
  if (!frontmatter?.[1]) throw new Error(`dsh-caveman: missing skill metadata in ${path}`)
  const metadata: unknown = parseYaml(frontmatter[1])
  const description = typeof metadata === 'object' && metadata !== null && 'description' in metadata
    ? metadata.description : undefined
  if (typeof description !== 'string' || !description.trim()) {
    throw new Error(`dsh-caveman: missing skill description in ${path}`)
  }
  const fields = metadata as Record<string, unknown>
  return {
    description: description.trim().replace(/\s+/g, ' '), content: raw.slice(frontmatter[0].length).trim(),
    modelInvocable: fields['disable-model-invocation'] !== true,
    userInvocable: fields['user-invocable'] !== false,
  }
}

/** Expose skills through the DSH provider registry. */
export function createSkillProvider(root: string, control?: SkillProviderControl): SkillProvider {
  if (!isAbsolute(root)) throw new Error('dsh-caveman: skill root must be absolute')
  return {
    name: PROVIDER,
    async list({ signal }) {
      const results = await Promise.allSettled(NAMES.map(async (name): Promise<SkillCandidate> => {
        const { description, modelInvocable, userInvocable } = await readSkill(root, name, signal)
        const directory = join(root, name)
        return {
          name, description, source: 'bundled', provider: PROVIDER,
          invocation: { modelInvocable, userInvocable },
          rank: RANK, locator: name,
          resourceBase: { kind: 'directory', path: directory.split(sep).join('/') },
        }
      }))
      signal?.throwIfAborted()
      return {
        candidates: results.flatMap(result => result.status === 'fulfilled' ? [result.value] : []),
        complete: results.every(result => result.status === 'fulfilled'),
      }
    },
    async get(candidate, { signal }): Promise<SkillDefinition | undefined> {
      if (!knownNames.has(candidate.name) || candidate.locator !== candidate.name) return undefined
      try {
        const { content } = await readSkill(root, candidate.name, signal)
        const { rank: _rank, locator: _locator, ...summary } = candidate
        return { ...summary, content }
      } catch (error) {
        if (signal?.aborted) throw error
        if (typeof error === 'object' && error !== null && 'code' in error && (error.code === 'ENOENT' || error.code === 'ENOTDIR')) {
          control?.invalidate()
          return undefined
        }
        throw error
      }
    },
  }
}
