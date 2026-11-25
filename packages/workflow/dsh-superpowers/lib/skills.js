import { readFileSync, readdirSync } from 'node:fs';
import { join, sep } from 'node:path';
import { parse } from 'yaml';
const provider = 'dsh-superpowers';
const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u;
export function loadSkills(root) {
    const candidates = [];
    const definitions = new Map();
    let introduction;
    for (const entry of readdirSync(root, { withFileTypes: true })) {
        if (!entry.isDirectory())
            continue;
        const directory = join(root, entry.name);
        const path = join(directory, 'SKILL.md');
        const markdown = readFileSync(path, 'utf8');
        const header = frontmatter.exec(markdown);
        const metadata = header?.[1] && parse(header[1]);
        if (!header || typeof metadata !== 'object' || metadata === null ||
            !('name' in metadata) || metadata.name !== entry.name || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(entry.name) ||
            !('description' in metadata) || typeof metadata.description !== 'string' || !metadata.description.trim()) {
            throw new Error(`dsh-superpowers: invalid skill metadata in ${path}`);
        }
        const invocation = {
            modelInvocable: !('disable-model-invocation' in metadata) || metadata['disable-model-invocation'] !== true,
            userInvocable: !('user-invocable' in metadata) || metadata['user-invocable'] !== false,
        };
        const definition = {
            name: entry.name,
            description: metadata.description.trim().replace(/\s+/gu, ' '),
            path,
            provider,
            source: 'bundled',
            resourceBase: { kind: 'directory', path: directory.split(sep).join('/') },
            invocation,
            content: markdown.slice(header[0].length),
        };
        definitions.set(entry.name, definition);
        const { content: _content, ...summary } = definition;
        candidates.push({ ...summary, rank: 600, locator: entry.name });
        if (entry.name === 'using-superpowers')
            introduction = markdown.trimEnd();
    }
    if (!introduction)
        throw new Error('dsh-superpowers: missing using-superpowers bootstrap skill');
    return {
        introduction,
        provider: {
            name: provider,
            async list({ signal }) {
                signal?.throwIfAborted();
                return { candidates, complete: true };
            },
            async get(candidate, { signal }) {
                signal?.throwIfAborted();
                return candidate.locator === candidate.name ? definitions.get(candidate.name) : undefined;
            },
        },
    };
}
