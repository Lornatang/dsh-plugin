---
description: "A security-audit skill inside a dsh profile: guided reviews, coverage-led audits, structured findings, and report validators."
kind: "package-bundle"
---

# @lornatang/dsh-security-audit

English | [中文](README.zh.md)

## Summary

`dsh-security-audit` registers a security-audit skill in a dsh profile. The skill guides focused security questions and, when explicitly requested, a six-phase codebase audit with a coverage ledger, independently checked findings, and reports. Add it with the `add` command and restart the profile; invoke `/security-audit` or ask for a security review. The boundary: the package supplies instructions and validators, while the host supplies the agent, delegation, tools, and any sandbox needed to execute target-controlled code.

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

The layer contributes one skill and its files. The active agent decides how to follow those instructions, the profile controls tool permissions and available subagents, and the host provides the execution environment. Install it into the profile whose sessions should use the skill.

### Install into a profile

```text
dsh plugin --profile <name> add @lornatang/dsh-security-audit
dsh plugin --profile <name> remove @lornatang/dsh-security-audit
```

To install the GitHub release tarball instead, use `dsh plugin --profile <name> add https://github.com/Lornatang/dsh-security-audit/releases/download/v0.1.6/lornatang-dsh-security-audit-0.1.6.tgz`.

The `add` command composes the bundle into the profile. `package.json` declares `cordis.patch.yml` through `dsh.bundle.patch`; the patch inserts the `security-audit` row and loads the host entry. Restart DSH after `add` or `remove` so the profile is composed again. Node.js 22.19 or newer and a profile with a compatible `skills` service are required.

In a session opened on the target codebase, ask a focused security question, request a full audit, or invoke `/security-audit`. The skill uses guidance mode for focused questions and investigations. It starts the complete workflow only for an explicit audit, penetration test, comprehensive review, or request for report artifacts; loading the skill alone does not start an audit or create files.

### What you get

| Surface | Provided by |
|---|---|
| `security-audit` skill for model and user invocation | host entry and provider, `src/index.ts` and `src/skills.ts` |
| Audit instructions and domain-specific hunting guides | `skills/security-audit/*.md` |
| Structured findings schema | `skills/security-audit/report-schema.json` |
| Findings and coverage-ledger validators | `skills/security-audit/validate-findings.cjs` and `validate-coverage-ledger.cjs` |
| Windows safe input reader for the validators | `skills/security-audit/windows-safe-input.cjs` |

The full workflow proceeds through reconnaissance, coverage-led hunting, candidate validation, structured output, independent record verification, and reporting. It distinguishes `confirmed`, `needs_validation`, and `rejected` findings; a confirmed finding needs a concrete trust-boundary violation and demonstrated result. A blocked source-grounded lead remains `needs_validation` with the missing fact and a validation plan.

The default output directory is `~/security-audit-skill/<repo-name>/run-<N>`, outside the target repository. The parent owns `run-metadata.json`, `architecture.md`, `coverage-ledger.json`, `findings.json`, `REPORT.md`, `FINDINGS-DETAIL.md`, and `NEEDS-VALIDATION.md`; each delegated worker receives separate scratch and artifact directories. An output directory inside the target is allowed only when the user explicitly chooses it and the parent verifies that version control ignores it.

The `quick`, `standard`, and `deep` profiles change the breadth and redundancy of a full audit; `standard` is the default. A scoped or `quick` run reports partial coverage. The agent records the selected profile, scope, and any invocation budget, then reports either completed artifacts with both validators passing or an incomplete status with its reason and coverage gaps.

The validators can also be run directly from the installed skill directory:

```text
node <skill-dir>/validate-findings.cjs <output-dir>/findings.json
node <skill-dir>/validate-coverage-ledger.cjs <output-dir>/coverage-ledger.json
```

Both accept UTF-8 JSON input up to 5 MiB and bound nesting and validation errors. The coverage ledger also limits the number of units and nested collection entries. A passing validator checks the structure and recorded invariants; it does not independently prove a security finding.

### Credentials

The package has no account connection, credential store, API endpoint, or settings page. It does not register a network service or collect credentials. Any tools used by an agent during a review remain subject to the host profile's configuration and permissions.

### Configuration

The bundle ships this patch; no plugin-specific configuration fields are declared:

```yaml
# cordis.patch.yml
- insert:
    - id: security-audit
      name: '@lornatang/dsh-security-audit'
```

The row requires the host's `skills` service. Its provider contributes the `security-audit` name, description, invocation policy, and skill-directory resource base. If another provider supplies the same skill name, DSH's registry precedence determines which definition is selected.

### Troubleshooting

- **The skill is missing** — restart the profile after installation, verify that the profile includes the `skills` service, and check the DSH log for a failed provider or missing `SKILL.md`.
- **A different skill with the same name loads** — inspect the other providers and the registry's precedence rules for the active workspace and scope.
- **A Windows validator cannot open the input** — use a direct local volume path without substituted drives, network paths, device names, or reparse points in the path. Confirm that optional dependencies were installed for the host architecture.
- **A validator rejects the document** — check its reported error, UTF-8 encoding, 5 MiB input limit, and the expected findings or coverage-ledger structure. A UTF-8 byte-order mark is rejected.
- **A local reproduction cannot meet the sandbox controls** — do not execute target-controlled code; retain the affected lead as `needs_validation` and record the missing control and a safe validation plan.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The bundle declares one host entry in `package.json` and mounts it with `cordis.patch.yml`. The module registers as `security-audit` and injects `skills`. `apply` locates the packaged `skills/` directory relative to `lib/index.js` and registers a provider for the lifetime of the plugin.

`createSkillProvider` reads the skill frontmatter for the name and description and advertises one candidate with source `bundled`, provider `dsh-security-audit`, rank 600, and both model and user invocation enabled. Loading the candidate reads the body and exposes the skill directory as the base for relative files. A missing file makes discovery incomplete; if the file disappears after discovery, the provider invalidates the catalog and returns no definition. Disposing the plugin unregisters its provider.

The two CLI validators check JSON structure and security-audit-specific invariants. On POSIX systems their input reader uses `O_NOFOLLOW`, `O_NONBLOCK`, a regular-file check, and a bounded read; the no-follow flag covers the final path component only, so parent directories are not constrained. On Windows the reader verifies a direct local volume, pins directory and file handles, rejects reparse points and non-disk inputs, and enforces the same byte limit and UTF-8 decoding. It fails closed when the platform's native binding or safe path checks are unavailable.

| Source | Contents |
|---|---|
| `cordis.patch.yml` | The layer: one insert entry, row id `security-audit`. |
| `src/index.ts` | `apply`: locate the skill directory and register the provider. |
| `src/skills.ts` | Skill metadata parsing, discovery, loading, resource base, and invalidation. |
| `skills/security-audit/SKILL.md` | Operating modes, audit setup, safety rules, profiles, and workflow. |
| `skills/security-audit/RECONNAISSANCE.md`, `HUNTING.md` | Coverage planning, hunter assignments, and review waves. |
| `skills/security-audit/*-*.md` | Domain-specific hunting guides and reporting instructions. |
| `skills/security-audit/report-schema.json` | Structured findings schema and verdict branches. |
| `skills/security-audit/validate-*.cjs` | Findings and coverage validation, limits, and CLI entry points. |
| `skills/security-audit/windows-safe-input.cjs` | Native Windows path and bounded-read checks. |
| `tests/*.test.mjs` | Registry lifecycle, platform behavior, and Windows validator regression tests. |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [CHANGELOG.md](CHANGELOG.md) — package release history.
- [scripts/verify-dsh.mjs](scripts/verify-dsh.mjs) — installs the packed bundle into a temporary profile, runs its validators, and boots DSH.
- [Skill instructions](skills/security-audit/SKILL.md) — modes, execution boundary, profiles, evidence rules, and outputs.
- [DeepSeek Harness configuration catalog](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/config-catalog.md) — the loader semantics the bundle row follows.
- [NOTICE](NOTICE) and [MIT license](LICENSE) — package notices and license.

-----

<a id="model-experience"></a>
## Model Experience

Through the host's skill catalog: when the `skill` tool is visible, the model can see the `security-audit` name and description and load its instructions. A user can invoke the same skill directly with `/security-audit`; the host supplies the instructions and their resource base to the session. The package adds no separate tool definitions.

#### KV Cache effect

The skill catalog is part of session context. Adding or removing the provider, changing its summary, or loading the skill body changes the affected context. A model provider that supports prompt caching may reuse an unchanged prefix; reuse and invalidation depend on that provider and on the resulting session messages. This package does not configure or measure the cache.

<a id="known-limitations-and-deferred-work"></a>
## Known Limitations and Deferred Work

These limits describe what the skill needs from the profile and what its validators can establish.

- **The package supplies instructions, not an audit engine** — the agent, available tools, and host delegation determine how the workflow can be carried out.
- **Full audits need independent subagents** — the workflow assigns separate hunters and verifiers; a host without the required delegation cannot complete those steps as written.
- **Target-controlled execution needs a sandbox** — the host must enforce the network, environment, filesystem, and resource controls in the skill. Missing controls block that execution and leave affected leads to be validated.
- **Coverage is bounded** — a `quick` or scoped run is partial, and a budget may leave work deferred or a run incomplete. A report must state those gaps.
- **Windows input paths are restricted** — validators accept direct local volume paths and reject substituted drives, network paths, device names, and reparse points, including reparse-point parent directories.
- **Windows requires its native binding** — if the optional binding for the host architecture is missing or cannot load, the validators reject input rather than falling back to an unsafe open.
- **Validation is structural** — the schema and ledger checks cannot establish that a finding is true, that an audit covered every path, or that the host supplied an adequate sandbox.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

`npm run build` cleans `lib` and compiles the host entry and declarations with TypeScript. `lib` is committed and CI runs `git diff --exit-code -- lib`, so rebuild and commit it with source changes. `npm run typecheck` checks without emitting. `npm test` builds first, then runs the registry, validator, and platform tests; `prepack` runs that suite. `npm run test:dsh` packs the bundle, installs it into an isolated profile, runs both installed validators, and boots DSH. On Windows it detects the desktop host from `dsh.cmd` on `PATH`. Set `DSH_TEST_EXECUTABLE` and, for the desktop host, `DSH_TEST_ENTRY` to select a different executable.

`node scripts/benchmark-validation.mjs` measures the findings CLI with 1,000 records and, on Windows, a bounded 4 MiB read. Pass another checkout's `skills/security-audit` directory to compare implementations on the same machine.

Node.js 22.19 or newer is required. The package declares the `skills` service and Cordis as peers, uses `yaml` to read frontmatter, and ships platform-specific Windows native bindings as optional dependencies. The package declares no DSH version constraint.

</details>
