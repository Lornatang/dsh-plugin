---
description: "Cloudflare's original security-audit skill and its companion files inside a DeepSeek Harness profile."
kind: "package-bundle"
---

# @lornatang/dsh-security-audit

English | [中文](README.zh.md)

## Summary

`dsh-security-audit` makes [Cloudflare's security-audit skill](https://github.com/cloudflare/security-audit-skill) available in DeepSeek Harness. It registers the original skill and ships its instructions, domain guides, report schema, validators, and tests without changing their contents. The DSH integration supplies the skill to the host; the agent carries out the work, and the host must supply any subagents and sandbox required by the original workflow.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

### Install into a profile

```text
dsh plugin --profile <name> add @lornatang/dsh-security-audit
dsh plugin --profile <name> remove @lornatang/dsh-security-audit
```

Restart DSH after adding or removing the package. The bundle inserts a `security-audit` row into the profile and registers the skill with the host's skill registry. It requires Node.js 22.19 or later and DSH 0.2.2-rc.3 or a compatible later release with the `skills` service.

Open a session on the codebase you want to review. Ask a focused security question, request a full audit, or invoke `/security-audit` explicitly. The original skill distinguishes guidance for focused questions from its full workflow, which is used for explicit audits, penetration tests, comprehensive reviews, or requested report artifacts.

### What you get

| Surface | Provided by |
|---|---|
| `security-audit` skill, available for model and user invocation | DSH skill provider, `src/skills.ts` |
| Audit instructions and specialized hunting guides | Unmodified `upstream/skills/security-audit/` |
| Findings schema and findings / coverage-ledger validators | Unmodified `upstream/skills/security-audit/` |
| Pinned source and upstream license | `upstream.lock.json`, `upstream/LICENSE` |

In a full audit the upstream workflow covers reconnaissance, coverage-led hunting, candidate validation, structured findings, independent record verification, and reporting. Its default output is `~/security-audit-skill/<repo-name>/run-<N>`, outside the target repository. Outputs include the coverage ledger, `findings.json`, and Markdown reports. The skill instructs the agent to keep uncertain findings distinct from confirmed findings and to record coverage gaps.

## Understand the implementation

`cordis.patch.yml` installs the host entry. The entry registers a provider with the `skills` service; the provider reads the original skill's frontmatter and body and points DSH at the original skill directory for relative resources. It introduces no audit tools, user interface, background service, or sandbox. DSH's ordinary precedence rules apply if another provider offers a skill with the same name.

The complete upstream repository is stored under `upstream/` at commit [`c1c8a8c1471069fb0e188eeaff69b8e8db6564a8`](https://github.com/cloudflare/security-audit-skill/commit/c1c8a8c1471069fb0e188eeaff69b8e8db6564a8). `npm run verify:upstream` compares every file to its Git blob ID and rejects missing, changed, or extra files. The snapshot includes Cloudflare's original README and MIT license.

## Further Exploration

- [Upstream README](upstream/README.md) describes the original workflow and its files.
- [Upstream skill](upstream/skills/security-audit/SKILL.md) specifies the audit modes, safety boundary, profiles, and evidence requirements.
- [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) documents profiles and plugin installation.

## Model Experience

The skill is discoverable by the model and can also be invoked explicitly by the user. Its instructions are unchanged; installing this package does not itself run an audit. A full audit depends on the host's ability to delegate work and on the agent following the upstream workflow. Results require human review and depend on the selected scope, available evidence, and environment.

## Known Limitations and Deferred Work

- Full audits require parallel subagents and an OS-enforced sandbox meeting the controls in the upstream skill. The package does not provide either capability; if the controls are unavailable, target-controlled code must not be executed and affected leads remain `needs_validation`.
- The upstream command-line validators require Node's nonzero `O_NOFOLLOW` and `O_NONBLOCK` constants. On native Windows, those constants are unavailable and both validators refuse input. Use a compatible Linux environment for the full workflow and its validators; no Windows bypass is included.
- This is a pinned snapshot, not a live subscription to upstream changes. Updating it requires reviewing and refreshing the snapshot and lock file.
- This independent integration is not affiliated with or endorsed by Cloudflare.

## Dev Note

```bash
npm ci --ignore-scripts
npm run typecheck
npm test
npm run test:dsh
```

`npm test` checks the snapshot, exercises the real DSH skill registry, and runs the upstream validator tests. Where safe input opening is unavailable it skips upstream CLI tests and checks that both CLIs fail closed instead. `test:dsh` packs and installs the bundle into a temporary profile and boots DSH; `DSH_TEST_EXECUTABLE` and `DSH_TEST_ENTRY` can point it at a specific host. See [LICENSE](LICENSE), [NOTICE](NOTICE), and [upstream/LICENSE](upstream/LICENSE) for attribution.
