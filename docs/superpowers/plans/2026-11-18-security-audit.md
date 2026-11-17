# DSH security audit integration plan

> **For agentic workers:** Execute the tasks inline, preserving the upstream snapshot and verifying behavior against the actual DSH skill registry.

**Goal:** Ship `@lornatang/dsh-security-audit`, exposing the complete Cloudflare skill in a DSH profile.

**Architecture:** Keep every upstream Git blob under `upstream/` and record its commit and blob IDs. A small DSH skill provider reads the unchanged metadata and body and resolves companion files from that directory. Follow `dsh-notion` for packaging, bilingual documentation, CI, and `dsh.bundle` installation.

**Tech stack:** Node.js, TypeScript, Cordis, `@deepseek-ai/dsh-skill`, YAML, npm.

**Spec:** The user's request in this chat, the upstream source at commit `c1c8a8c1471069fb0e188eeaff69b8e8db6564a8`, and the DSH registry's provider contract.

## Global constraints

- Preserve every upstream file and MIT notice byte for byte.
- Register `security-audit` as both model-invocable and user-invocable, with a directory resource base pointing to the shipped files.
- Package the full snapshot and all validators; do not claim the wrapper runs an audit itself or supplies a sandbox.
- Publish a public npm package and submit the marketplace PR only after the repository has existed for 24 hours.

## Review focus

- The installed package, not just the checkout, must contain every companion file and the original license.
- Skills must load through a real DSH registry and disappear after plugin disposal.
- Missing files and cancellation must not silently produce stale skill content.
- Windows line endings must not alter the pinned snapshot.
- Full audits depend on the host's subagent and OS sandbox capabilities.

### Task 1: Skill provider and upstream snapshot

**Files:** `upstream/**`, `upstream.lock.json`, `src/index.ts`, `src/skills.ts`, `tests/skills.test.mjs`, `scripts/verify-upstream.mjs`, `package.json`.

- [ ] Write a registry test asserting discovery, original body, resource path and disposal; run it before the implementation and confirm the expected failure.
- [ ] Export all Git blobs from the pinned upstream commit unchanged; verify the full file set and each blob hash.
- [ ] Implement `createSkillProvider(root, control)` and a Cordis plugin that registers it with `ctx.skills.registerProvider`.
- [ ] Run the provider tests and both unmodified upstream validator test suites.

### Task 2: Distribution and integration

**Files:** `cordis.patch.yml`, `README.md`, `README.zh.md`, `CHANGELOG.md`, `LICENSE`, `NOTICE`, `.github/workflows/ci.yml`, `scripts/verify-dsh.mjs`.

- [ ] Add the bundle manifest, package files and attributed license; document installation, modes, output and host prerequisites in both languages.
- [ ] Build, typecheck, run all tests, inspect the npm tarball, and install and boot it in an isolated DSH profile where available.
- [ ] Commit and push the tested result, publish on npm, then independently verify the public registry and GitHub repository.
- [ ] After the 24-hour gate, verify the market's current rules and submit one accurate catalog entry if no duplicate exists.
