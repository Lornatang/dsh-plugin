---
description: "A security-audit skill, domain guides, and report validators for DeepSeek Harness."
kind: "package-bundle"
---

# @lornatang/dsh-security-audit

English | [中文](README.zh.md)

## Summary

`dsh-security-audit` provides a security-audit skill for DeepSeek Harness. It supplies audit instructions, domain guides, a report schema, and validators for findings and coverage records. The agent performs the review; the host must provide any subagents and sandbox required by the workflow.

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

Restart DSH after adding or removing the package. The bundle inserts a `security-audit` row into the profile and registers the skill with the host's skill registry. It requires Node.js 22.19 or later and a DSH profile with the compatible `skills` service.

Open a session on the codebase you want to review. Ask a focused security question, request a full audit, or invoke `/security-audit` explicitly. The skill distinguishes guidance for focused questions from its full workflow, which is used for explicit audits, penetration tests, comprehensive reviews, or requested report artifacts.

### What you get

| Surface | Provided by |
|---|---|
| `security-audit` skill, available for model and user invocation | DSH skill provider, `src/skills.ts` |
| Audit instructions and specialized hunting guides | `skills/security-audit/` |
| Findings schema and findings / coverage-ledger validators | `skills/security-audit/` |
| Windows safe input reader | `skills/security-audit/windows-safe-input.cjs` |

In a full audit the workflow covers reconnaissance, coverage-led hunting, candidate validation, structured findings, independent record verification, and reporting. Its default output is `~/security-audit-skill/<repo-name>/run-<N>`, outside the target repository. Outputs include the coverage ledger, `findings.json`, and Markdown reports. The skill instructs the agent to keep uncertain findings distinct from confirmed findings and to record coverage gaps.

## Understand the implementation

`cordis.patch.yml` installs the host entry. The entry registers a provider with the `skills` service; the provider reads the skill's metadata and body and points DSH at the skill directory for relative resources. It introduces no audit tools, user interface, background service, or sandbox. DSH's ordinary precedence rules apply if another provider offers a skill with the same name.

The validators accept UTF-8 JSON files up to 5 MiB. On Windows they use native file handles to inspect local paths, reject reparse points, device paths, and network paths, and limit the number of bytes read. If the native binding is unavailable, they fail closed. On systems with `O_NOFOLLOW` and `O_NONBLOCK`, the validators use those flags to open the input.

## Further Exploration

- [Skill instructions](skills/security-audit/SKILL.md) specify audit modes, profiles, safety boundaries, and evidence requirements.
- [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) documents profiles and plugin installation.

## Model Experience

The skill is discoverable by the model and can also be invoked explicitly by the user. Installing this package does not itself run an audit. A full audit depends on the host's ability to delegate work and on the agent following the workflow. Results require human review and depend on the selected scope, available evidence, and environment.

## Known Limitations and Deferred Work

- Full audits require parallel subagents and an OS-enforced sandbox meeting the controls in the skill. The package does not provide either capability; if the controls are unavailable, target-controlled code must not be executed and affected leads remain `needs_validation`.
- The Windows validator reader accepts local drives and rejects network paths, device names, and reparse points, including reparse-point parent directories. It requires the packaged native binding for the host architecture.

## Dev Note

```bash
npm ci --ignore-scripts
npm run typecheck
npm test
npm run test:dsh
```

`npm test` exercises the DSH skill registry and validator suites, including Windows path and input-safety checks. `test:dsh` packs and installs the bundle into a temporary profile, runs the installed validators, and boots DSH; `DSH_TEST_EXECUTABLE` and `DSH_TEST_ENTRY` can point it at a specific host. See [LICENSE](LICENSE) for the license and copyright notices.
