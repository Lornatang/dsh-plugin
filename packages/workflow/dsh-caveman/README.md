---
description: "Caveman voice, recoverable compression, browser tools, and delegation for DeepSeek Harness."
kind: "package-bundle"
---

# @lornatang/dsh-caveman

English | [中文](README.zh.md)

## Summary

`dsh-caveman` brings Caveman skills and tools to DeepSeek Harness. It provides session-specific response styles, recoverable tool-result compression, Auto model routing, Blocks suggestions, Browse tools, and Cavecrew delegation. Install the bundle into a profile to make these capabilities available to its sessions.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations](#known-limitations)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Node.js 22.19 or newer and DSH are required. Install the bundle into the profile whose sessions should use Caveman.

### Install into a profile

Install and remove the package with:

```text
dsh plugin --profile <name> add @lornatang/dsh-caveman
dsh plugin --profile <name> remove @lornatang/dsh-caveman
```

To install a package built from the repository:

```sh
git clone https://github.com/Lornatang/dsh-caveman.git
cd dsh-caveman
npm ci
npm pack
dsh plugin --profile <name> add ./lornatang-dsh-caveman-0.1.5.tgz
```

The `add` command composes the bundle into the profile. Its patches insert the `caveman` row, three Cavecrew presets, and their delegation tools. Restart DSH after `add` or `remove` so the profile reloads its composition.

### What you get

| Surface | Provided by |
|---|---|
| Caveman skills and session-specific response styles | `src/skills.ts`, `src/mode.ts` |
| Native coding policy | `src/index.ts` |
| `/caveman-stats` for recorded session and historical usage | `src/stats.ts` |
| Recoverable tool-result compression and `caveman_retrieve` | `src/compression.ts` and the middleware runtime |
| Compression, recovery, statistics, and TOON MCP tools | DSH MCP manager and `caveman-mcp` |
| Local memory and exact recovery | DSH MCP manager and `cavemem` |
| Auto model selection | DSH pi-ai provider and Caveman proxy |
| Shell suggestions | `src/blocks.ts` and Blocks |
| `mcp__caveman_browse__*` browser tools | DSH MCP manager and Browse |
| `cavecrew-investigator`, `cavecrew-builder`, `cavecrew-reviewer` | `presets/cavecrew.patch.yml` and `src/cavecrew.ts` |
| `dsh-caveman` command when installed as a Node package | `scripts/caveman-cli.mjs` and `@caveman-ai/cli` |

### Configuration

The bundle supplies a `caveman` row. Override only the fields you want to change in the profile's `cordis.patch.yml`:

```yaml
# $DSH_HOME/profiles/<name>/cordis.patch.yml
- id: caveman
  config:
    defaultMode: manual
```

| Field | Default | Meaning |
|---|---|---|
| `defaultMode` | Configuration-derived, otherwise `caveman` | Starting voice for a session. |
| `inputCompression` | auto | Use a verified local runtime when available; set `false` to disable or `true` to use the configured endpoint. |
| `middlewareEndpoint` | `http://127.0.0.1:8787` | Loopback middleware address. |
| `blocksBinary` | auto-detected | Override the absolute path to `caveman-blocks`. |
| `browseBinary` | auto-detected | Override the absolute path to `caveman-browse`; requires the DSH MCP manager. |
| `mcpBinary` | auto-detected | Override the absolute path to `caveman-mcp`; requires the DSH MCP manager. |
| `memoryBinary` | auto-detected | Override the absolute path to `cavemem`; enables its local memory tools. |

### Voice and usage

Use `/caveman`, `/ultracave`, `/megacave`, `/caveman ultra`, `/caveman wenyan`, `/caveman status`, or `stop caveman`. Mode changes belong to the current session. All 22 Caveman skills are available for explicit invocation; the model can also invoke the skills whose metadata permits it.

`defaultMode` accepts `caveman`, `ultracave`, `megacave`, `manual`, or `off`. An explicit profile value wins; otherwise the resolver checks `CAVEMAN_DEFAULT_MODE`, project configuration, and user configuration before falling back to `caveman`.

The native coding policy is included in the system prompt when the output module and Core are active. When the local runtime is running, it also supplies task-specific rules, maintains state across compaction, and can suggest reusing a verified unchanged file observation. Recovery references are shown only when the recovery MCP tool is available. `CAVEMAN_CORE=off`, record mode, or the `record-only` native profile disables the active rules; restart DSH after changing these settings. The `core-lean-build` profile adds the lean-build policy.

`/caveman-stats` reports usage recorded on committed assistant messages, with output attributed to response modes when recorded. Use `--all` for live and stored sessions, `--since 7d` or `--since 24h` for usage within that window, and `--share` for a concise report of the selected scope. Historical totals exclude fork-inherited events and identify unavailable records. Savings remain unknown without a comparison.

### Usage analysis

Run `npx @lornatang/dsh-caveman learn --json` for a local report, or add `--sources dsh` to focus on DSH sessions. Add `--retro` for the retrospective compression analysis. The first run downloads the platform's analyzer and verifies it against the package's SHA-256 manifest; later runs reuse the verified local copy. The `caveman-learn` skill can review findings and guide individual fixes with consent.

DSH sessions are read from `$DSH_HOME/sessions` or `~/.dsh/sessions`. Set `CAVEMAN_DSH_SESSION_ROOT` when the session persistence backend uses a different directory.

### Recoverable compression

Install the signed runtime components, select compression, and start the local middleware:

```sh
npx @lornatang/dsh-caveman setup --install
npx @lornatang/dsh-caveman tools config set think.mode compress
npx @lornatang/dsh-caveman start
```

Keep the last command running. With the `input` module enabled, the plugin detects its loopback listener and verifies it against the runtime's local run-state before sending tool content. Set `inputCompression: false` to turn this off. To explicitly use a configured middleware endpoint, set:

```yaml
- id: caveman
  config:
    inputCompression: true
    middlewareEndpoint: 'http://127.0.0.1:8787'
```

Text blocks of at least 2048 UTF-16 code units in successful tool results are eligible, including `run_code` results; other blocks remain intact. The model receives a recovery handle only when `caveman_retrieve` is callable directly or through the program SDK. The original remains in the session log and is restored to the visible session after the model request is prepared. If the runtime becomes unavailable, the session can still return exact original pages.

### Auto model selection

Sign in with `npx @lornatang/dsh-caveman login`, enable the `routing` module, and start the local proxy as shown above. Make an OpenAI credential available to DSH as `OPENAI_API_KEY`.

Merge the `caveman-auto` provider from [examples/caveman-auto.patch.yml](examples/caveman-auto.patch.yml) into the existing `llm-pi-ai` provider configuration, preserving other providers, and select its `caveman-auto` model. The example is an excerpt; replacing the entire provider map with it would remove other routes.

When Auto is selected and routing is enabled, the proxy sends the latest and previous user asks, the tail of the last assistant response, and request facts to Caveman Cloud to select a model. The Free plan may retain that information to improve routing. When routing is off, the proxy falls back to its OpenAI default model; provider billing still applies. See the [privacy details](https://github.com/JuliusBrussee/caveman/blob/main/docs/technical/security-and-privacy.md).

For Anthropic API traffic, merge [examples/caveman-anthropic.patch.yml](examples/caveman-anthropic.patch.yml) into the provider map and choose an available model. The local proxy can then apply its cache-warming policy when the request and provider cache are eligible; warm requests are recorded as usage.

### MCP, Blocks and Browse

When `caveman-mcp` is installed, the DSH MCP manager exposes the `mcp__caveman__*` tools `caveman_compress`, `caveman_retrieve`, `caveman_stats`, `caveman_toon_encode`, and `caveman_toon_decode`. The server uses the local Caveman recovery store for its handles. Set `CAVEMAN_MCP=off` to disable automatic registration.

When `cavemem` is installed, the MCP manager exposes `mcp__cavemem__*` tools for remembering, recalling, revising, inspecting, and forgetting local facts. `cavemem_recover` returns the exact original behind a recall handle and requires the DSH subprocess and working-directory services. Memories persist in the local Caveman home.

When `caveman-blocks` is installed, `bash` and `pwsh` calls can receive Blocks suggestions. Suggestions accompany the result and do not change the command. Blocks reads the local `.blocks` directory and may save scrubbed script observations and usage data; see its [telemetry settings](https://github.com/caveman-ai/blocks/blob/main/docs/TELEMETRY.md).

When `caveman-browse` is installed, the DSH MCP manager registers `mcp__caveman_browse__browser_snapshot`, `browser_act`, `browser_eval`, and `browser_recover`. Browse starts a dedicated headless Chrome by default. Its tools share the server's browser state and can navigate and run JavaScript.

The plugin looks for each binary in its `CAVEMAN_MCP_BIN`, `CAVEMAN_BLOCKS_BIN`, `CAVEMAN_BROWSE_BIN`, or `CAVEMEM_BIN` override, on `PATH`, then in `$CAVEMAN_HOME/bin` (or `~/.caveman/bin`). Profile paths take precedence. Module switches are read on startup; restart DSH after changing them.

### Cavecrew

The bundle defines the `cavecrew-investigator`, `cavecrew-builder`, and `cavecrew-reviewer` presets and corresponding delegation tools. The investigator and reviewer can read and search files and inspect Git through `cavecrew_git`; the builder can read and edit up to two file paths. The Git tool provides the read-only operations relevant to each role. They require the profile's agent-preset registry and in-process subagent provider.

Each role inherits its parent provider and model. Set `CAVECREW_INVESTIGATOR_MODEL`, `CAVECREW_BUILDER_MODEL`, or `CAVECREW_REVIEWER_MODEL` before starting DSH to select another model on that provider for the corresponding role.

### Command-line interface

When installed as a Node package, `dsh-caveman` forwards arguments and exit status to `@caveman-ai/cli`. In a checkout, run `node scripts/caveman-cli.mjs --help`.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals</summary>

| Path | Responsibility |
|---|---|
| `cordis.patch.yml` and `presets/cavecrew.patch.yml` | Compose the host plugin, presets, and delegation tools. |
| `src/index.ts` | Register skills, session voice instructions, and optional integrations. |
| `src/skills.ts` and `src/mode.ts` | Provide skill content and resolve session mode changes. |
| `src/stats.ts` | Report recorded session usage. |
| `src/compression.ts` | Prepare recoverable tool-result projections and restore the session surface. |
| `src/blocks.ts` | Supply Blocks suggestions for shell calls. |
| `src/cavecrew.ts` | Install Cavecrew personas and scope their tools. |
| `scripts/caveman-cli.mjs` | Forward command-line arguments. |
| `tests/` | Verify DSH services, runtime integrations, and package installation. |

Mode changes use direct user messages. Compression keeps the original session event and restores any pending projection during cleanup. Recovery handles are scoped to a session.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [CHANGELOG.md](CHANGELOG.md) — package changes.
- [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) — profile and plugin configuration.
- [NOTICE](NOTICE) and [LICENSE](LICENSE) — licensing and attribution.

-----

<a id="model-experience"></a>
## Model Experience

The selected voice is supplied to the model on user turns. Eligible tool results can be shortened in model requests with a `caveman_retrieve` handle. User prompts are not rewritten. Savings and quality depend on the workload and have not been measured for this integration.

#### KV Cache effect

Changing voice or replacing and restoring a tool-result surface can change the cached prefix. Cache behavior depends on the provider.

<a id="known-limitations"></a>
## Known Limitations

- Auto requires a configured pi-ai provider, Caveman proxy, Cloud login, and OpenAI credential. The integration tests use local mock services.
- Browse requires the MCP manager, `caveman-browse`, and Chrome. Blocks requires `caveman-blocks` and a local workspace.
- Compression handles text blocks in tool results. Offline recovery returns exact pages; text-query recovery requires the middleware.
- Some skills require additional CLI, account, or agent setup.
- Cavecrew's inspection roles use read, search, and read-only Git tools; the builder can edit existing files and is limited to two file paths.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Maintainer context</summary>

`npm run typecheck` checks TypeScript; `npm test` builds and runs the tests. Set `CAVEMAN_PROXY_BINARY`, `CAVEMAN_MCP_BINARY`, `CAVEMEM_BINARY`, `CAVEMAN_BLOCKS_BINARY`, and `CAVEMAN_BROWSE_BINARY` to compatible executables and `CAVEMAN_BROWSE_CHROME` to Chrome to run the runtime integration tests. Set `DSH_CAVEMAN_LEARN_BINARY` to a built analyzer to test session analysis. Auto's test also requires OpenSSL. `npm run test:dsh` installs, boots, and removes the pack in an isolated profile. `npm pack` runs the test suite through `prepack`. `npm run benchmark` measures skill discovery and incremental session processing on synthetic input.

</details>
