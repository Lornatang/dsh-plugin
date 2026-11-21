import { readFile } from 'node:fs/promises';
import { isAbsolute, join, sep } from 'node:path';
import { parse as parseYaml } from 'yaml';
const PROVIDER = 'dsh-security-audit';
const NAME = 'security-audit';
const RANK = 600;
async function readSkill(root, signal) {
    const path = join(root, NAME, 'SKILL.md');
    const text = await readFile(path, { encoding: 'utf8', signal });
    const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u.exec(text);
    if (!frontmatter?.[1])
        throw new Error(`dsh-security-audit: missing metadata in ${path}`);
    const metadata = parseYaml(frontmatter[1]);
    if (typeof metadata !== 'object' || metadata === null || !('name' in metadata) || metadata.name !== NAME ||
        !('description' in metadata) || typeof metadata.description !== 'string' || !metadata.description.trim()) {
        throw new Error(`dsh-security-audit: invalid metadata in ${path}`);
    }
    return { description: metadata.description.trim().replace(/\s+/gu, ' '), content: text.slice(frontmatter[0].length) };
}
function isMissing(error) {
    return typeof error === 'object' && error !== null && 'code' in error && (error.code === 'ENOENT' || error.code === 'ENOTDIR');
}
/** Expose the security-audit skill and its companion files to DSH. */
export function createSkillProvider(root, control) {
    if (!isAbsolute(root))
        throw new Error('dsh-security-audit: skill root must be absolute');
    const directory = join(root, NAME);
    return {
        name: PROVIDER,
        async list({ signal }) {
            try {
                const { description } = await readSkill(root, signal);
                const candidate = {
                    name: NAME,
                    description,
                    source: 'bundled',
                    provider: PROVIDER,
                    path: join(directory, 'SKILL.md'),
                    resourceBase: { kind: 'directory', path: directory.split(sep).join('/') },
                    invocation: { modelInvocable: true, userInvocable: true },
                    rank: RANK,
                    locator: NAME,
                };
                return { candidates: [candidate], complete: true };
            }
            catch (error) {
                if (signal?.aborted || !isMissing(error))
                    throw error;
                return { candidates: [], complete: false };
            }
        },
        async get(candidate, { signal }) {
            if (candidate.name !== NAME || candidate.locator !== NAME)
                return undefined;
            try {
                const { content } = await readSkill(root, signal);
                const { rank: _rank, locator: _locator, ...summary } = candidate;
                return { ...summary, content };
            }
            catch (error) {
                if (signal?.aborted)
                    throw error;
                // The registry calls get() unguarded: a skill that stopped being loadable
                // (permissions, partial write, malformed YAML) must read as absent, not
                // crash the caller. Invalidate so the next list() re-scans the directory.
                control?.invalidate();
                return undefined;
            }
        },
    };
}
