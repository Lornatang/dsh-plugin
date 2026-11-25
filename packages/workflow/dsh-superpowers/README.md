# DeepSeek Harness Superpowers

[简体中文](README.zh.md)

`@lornatang/dsh-superpowers` ports the 15 engineering skills from
[obra/superpowers v7.0.2](https://github.com/obra/superpowers/releases/tag/v7.0.2)
to DeepSeek Harness. The package includes the original skill bodies, references,
prompt templates, visual companion, and workflow scripts.

## Install

Use DSH 0.2.3-alpha.2 or a compatible newer version and Node.js 22.19 or newer.
From this directory, build a tarball and install it in the desired profile.

```sh
npm ci
npm pack
dsh plugin --profile web add ./lornatang-dsh-superpowers-0.1.0.tgz --registry=https://registry.npmjs.org/
```

Restart the profile. Ask for a development task to let the agent select a skill,
or select an explicit `/brainstorming`, `/systematic-debugging`, or
`/writing-plans` entry in the Web skill picker.

## DSH integration

The bundle registers the packaged skills with the DSH skill registry. The
controller prompt includes `using-superpowers` and a DSH tool mapping at assembly
time, including after context compaction. Delegated worker prompts omit the
controller bootstrap. DSH's skill catalog uses unprefixed names and exposes
the installed resource directory with each loaded skill.

Workflow execution uses the active profile's model, plan tools, shell,
permissions, and subagents. The package includes the upstream visual companion
scripts for Bash and Node.js. The companion starts when requested through the
brainstorming workflow. This bundle implements the DSH entry points. Other
harness integrations live in the upstream project.

Upstream source, pinned revision, and MIT attribution are recorded in [NOTICE](NOTICE).
