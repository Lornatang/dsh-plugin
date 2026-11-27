---
description: "Superpowers engineering skills, workflow resources, and session guidance inside a dsh profile."
kind: "package-bundle"
---

# @lornatang/dsh-superpowers

English | [中文](README.zh.md)

## Summary

`dsh-superpowers` brings 15 skills from obra/superpowers v7.0.2 to DeepSeek Harness. The skills cover brainstorming, planning, test-driven development, debugging, code review, and verification. The bundle registers the skills and their original resources and adds Superpowers guidance to the controller session's system prompt.

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

Use Node.js 22.19 or newer and DeepSeek Harness 0.2.3-alpha.2 or a compatible newer version below 0.3.0. Install the bundle into the profile whose sessions should use Superpowers.

### Install into a profile

```text
dsh plugin --profile <name> add @lornatang/dsh-superpowers
dsh plugin --profile <name> remove @lornatang/dsh-superpowers
```

Prebuilt tarballs are available under `dsh-superpowers-v<version>` tags. [GitHub Releases](https://github.com/Lornatang/dsh-plugin/releases)

To build and install from a repository checkout, run these commands from the repository root.

```sh
cd packages/workflow/dsh-superpowers
npm ci
npm pack
dsh plugin --profile <name> add ./lornatang-dsh-superpowers-<version>.tgz
```

The `add` command composes the bundle into the profile and inserts the `superpowers` row. Restart DSH after adding or removing the bundle. For the Desktop profile, quit the app before running its bundled `dsh` CLI with `--profile desktop`, then reopen it. [Desktop plugin commands](https://github.com/deepseek-ai/deepseek-harness/blob/master/apps/desktop/README.md#bundled-command-runtime)

### What you get

| Surface | Provided by |
|---|---|
| 15 skills available to users and models | `src/skills.ts` and `vendor/superpowers/skills/` |
| Controller session guidance and DSH tool mapping | `src/index.ts` and the upstream `using-superpowers` skill |
| Skill references, prompt templates, and workflow scripts | resources alongside each upstream `SKILL.md` |
| Optional visual companion for brainstorming | `vendor/superpowers/skills/brainstorming/` |

### Use the skills

Ask for a development task so the agent can select a relevant skill, or invoke one by name in the DSH skill picker, such as `/brainstorming`, `/systematic-debugging`, or `/writing-plans`. Use the unprefixed names shown in the DSH catalog. When a skill refers to a script or template, resolve its relative path from the resource directory returned by the host.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals</summary>

`package.json` declares `cordis.patch.yml` through `dsh.bundle.patch`. The host entry uses the profile's `skills` and `systemPrompt` services. It registers a bundled provider with skill names, descriptions, invocation policies, and resource directories taken from the packaged files.

`apply` registers the `superpowers:bootstrap` system prompt section. DSH assembles it for the controller session, including after context compaction. The section contains the full `using-superpowers` skill and the tool mapping. Delegated workers receive their assigned task prompts.

| Path | Responsibility |
|---|---|
| `cordis.patch.yml` | Insert the `superpowers` row into the profile. |
| `src/index.ts` | Register the provider and assemble controller guidance. |
| `src/skills.ts` | Read and validate skill metadata and supply the bodies and resource directories. |
| `vendor/superpowers/skills/` | Store the pinned upstream skills and companion resources. |
| `tests/plugin.test.mjs` | Check catalog completeness, resource loading, prompt assembly, and disposal. |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- Package release history. [CHANGELOG.md](CHANGELOG.md)
- Upstream release and workflow guides. [Superpowers v7.0.2](https://github.com/obra/superpowers/releases/tag/v7.0.2)
- Instructions for using the optional brainstorming companion. [Visual companion guide](vendor/superpowers/skills/brainstorming/visual-companion.md)
- Upstream revision, attribution, and licensing. [NOTICE](NOTICE) · [MIT license](vendor/superpowers/LICENSE)

-----

<a id="model-experience"></a>
## Model Experience

The controller sees `using-superpowers` at the start of the session. Other skill bodies are loaded through DSH's `skill` tool or supplied by the host when the user invokes a skill. The profile controls which planning, shell, and delegation tools the model can use to carry out the workflow.

#### KV Cache effect

The controller's bootstrap stays the same across turns while the bundle is loaded. Loading a skill adds its body to the session context. Prefix reuse depends on the model provider.

<a id="known-limitations-and-deferred-work"></a>
## Known Limitations and Deferred Work

- Workflows depend on the active profile's model, tools, and permissions. Use the inline `executing-plans` workflow when delegation is unavailable.
- The brainstorming companion requires Bash and Node.js in the environment that runs the script. It starts only when requested through the brainstorming workflow.
- Host-specific adapters for other coding agents are maintained upstream. [Superpowers](https://github.com/obra/superpowers)

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Maintainer context</summary>

`npm run typecheck` checks TypeScript. `npm test` builds `lib` and tests the native DSH registry and prompt assembly. `npm pack` runs the tests through `prepack`. The compiled files in `lib` are tracked, and CI checks them against a fresh build.

</details>
