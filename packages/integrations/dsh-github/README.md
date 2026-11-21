---
description: "GitHub's official MCP server inside a dsh profile: browser authorization, encrypted credentials, agent tools, write approval, and a connection settings page."
kind: "package-bundle"
---

# @lornatang/dsh-github

English | [中文](README.zh.md)

## Summary

`dsh-github` connects a DeepSeek Harness profile to GitHub's hosted MCP server. It registers the server's tools for repository files, issues, pull requests and Actions, and adds a GitHub connection page to the Web client. Connect by authorizing in a browser, with an already authenticated GitHub CLI, or with a personal access token; the bridge asks DSH for approval before calls that are not marked read-only by the server. The package includes the public Client ID of its GitHub OAuth app. Available tools and account permissions are defined by GitHub.

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

The bridge owns the connection and registration; GitHub supplies the tool definitions and enforces the account's repository permissions. DSH's existing tool policies also apply. Install into the profile whose sessions should use GitHub:

```text
dsh plugin --profile <name> add @lornatang/dsh-github
dsh plugin --profile <name> remove @lornatang/dsh-github
```

Versioned tarballs, when available, are listed in [GitHub Releases](https://github.com/Lornatang/dsh-github/releases). Restart DSH after adding or removing the bundle, then open Settings → GitHub in a Web profile.

### Connect GitHub

Choose **Connect with GitHub** to open GitHub in a browser. Enter the one-time code shown in DSH, review the requested permissions, and approve the application; DSH completes the connection automatically. This does not require `gh` or a manually created token. GitHub's device flow requires the short code; it is not a personal access token. Cancelling a pending authorization preserves and restores the previous connection.

Choose **Connect with GitHub CLI** after installing `gh` and running `gh auth login` on the DSH host. The bridge reads the active `github.com` token through `gh auth token`; the token is not written to the profile. A saved connection remembers only that it should use `gh` again. This is GitHub CLI authentication, not an OAuth flow implemented by this plugin.

Alternatively, paste a GitHub personal access token into the password field and choose **Connect with token**. The bridge tests the connection before replacing the saved credential. It stores the token in an encrypted profile file; the settings page never returns it. Give the token the repository access and permissions needed for the requested work. If the connection fails, the previous saved credential is retained.

For a headless host, configure `credentialSource: env` and provide `GITHUB_TOKEN` to the DSH process, or set `credentialSource: gh` to use an already authenticated `gh`. The configured source takes precedence over the saved connection at startup.

### What you get

| Surface | Provided by |
|---|---|
| `mcp__github__<tool>` for each tool GitHub advertises in the selected toolsets | host entry, `src/bridge.ts` |
| Approval request for a tool without `readOnlyHint: true` | host entry, `src/index.ts` |
| Settings → GitHub page with connection status and credential controls | client entry, `src/client/index.tsx` |
| `GET /plugins/github/status`, `POST /plugins/github/connect`, `POST /plugins/github/cancel` and `POST /plugins/github/disconnect` | host entry, `src/routes.ts` |
| `<profile>/data/dsh-github-<serverName>-<hash>.json` | host entry, `src/store.ts` |

The default toolsets are `repos,issues,pull_requests,actions`. Their actual tools can change on GitHub's side and are also affected by account permissions and GitHub policies. With suitable permissions, an agent can read files, create or update files, push a group of files, create a pull request, or inspect an issue and its checks. For large local repositories, normal Git operations may be a better fit than passing file contents through MCP tools.

Tools are named `mcp__github__<name>`. Characters outside letters, digits, hyphen and underscore become underscores; a changed or overlong name is shortened and receives a twelve-character SHA-256 suffix. The bridge uses the server's descriptions and input schemas. It validates declared structured output, renders text blocks as text, and represents other content blocks by type. A server error fails the call. Active GitHub credentials are redacted from tool output and error messages in a single pass when their exact values appear.

The bridge delegates to DSH's approval service for a tool unless the server marks it `readOnlyHint: true`; a missing hint is treated as requiring approval. Existing DSH policy decisions still apply. Read-only hints are provided by the configured MCP server, so use a trusted endpoint. The plugin does not grant GitHub permissions or approve calls on the user's behalf.

### Credentials

The saved source and, when applicable, personal access or OAuth access and refresh tokens are stored in an AES-256-GCM envelope under `<profile>/data/`. Expiring OAuth access tokens are refreshed when needed. The file path is authenticated data. Decrypted sessions are type-checked on load and malformed fields are dropped. The 32-byte key comes from the operating-system credential store through `@napi-rs/keyring`, or from `DSH_GITHUB_ENCRYPTION_KEY` as standard Base64 for exactly 32 bytes. There is no plaintext fallback. On POSIX the file is restricted to `0600`, the data directory to `0700`, and symlinks, unsafe ownership and hard links are checked. On Windows, restrict the profile directory with ACLs On Windows the reader also verifies that the opened file still matches the checked file, rejecting a swap between check and open.

For a headless host without an available credential store, set a persistent `DSH_GITHUB_ENCRYPTION_KEY` before saving a connection; keep the key and profile path across restarts. Disconnect removes the local encrypted file and keyring entry and unregisters tools; it does not revoke a GitHub token or sign out of `gh`. Use one DSH process per profile because this package does not coordinate concurrent writers.

### Configuration

The bundled row sets the defaults below. A profile can override them in its patch:

```yaml
# $DSH_HOME/profiles/web/cordis.patch.yml
- id: github
  config:
    serverName: github
    url: 'https://api.githubcopilot.com/mcp/'
    toolsets: 'repos,issues,pull_requests,actions'
    readOnly: false
    credentialSource: saved
    oauthClientId: 'Ov23liyuutYTU29KMjVg'
    oauthScopes: ''
```

| Field | Default | Meaning |
|---|---|---|
| `serverName` | `github` | Tool namespace and credential identity; 1–64 letters, numbers, hyphens or underscores. |
| `url` | `https://api.githubcopilot.com/mcp/` | GitHub MCP endpoint. HTTPS is required except for loopback HTTP. |
| `toolCallTimeoutMs` | `60000` | Connection, discovery and tool-call timeout in milliseconds. |
| `toolsets` | `repos,issues,pull_requests,actions` | Comma-separated toolsets passed in `X-MCP-Toolsets`. |
| `readOnly` | `false` | Send `X-MCP-Readonly: true` to request only read tools. |
| `credentialSource` | `saved` | `saved`, `env` (`GITHUB_TOKEN`), or `gh` (GitHub CLI). |
| `oauthClientId` | bundled app ID | Public client ID of the device-flow-enabled GitHub OAuth app. `DSH_GITHUB_OAUTH_CLIENT_ID` is used when this field is empty. |
| `oauthScopes` | `''` | Extra OAuth scopes requested on top of the defaults, comma- or space-separated (for example `project, read:packages`). Must be valid GitHub OAuth scope names. |

#### Browser sign-in setup for maintainers

The package includes the public Client ID of its registered OAuth app, so ordinary users do not need to register an app. To use a different app, register an OAuth app in GitHub Developer Settings, with this repository as its homepage and `http://127.0.0.1/callback` as its required callback URL, and enable **Device Flow**. The callback URL is not used by device flow. Override `oauthClientId` with that app's public Client ID, or set it to an empty string and provide `DSH_GITHUB_OAUTH_CLIENT_ID` to the DSH process. No client secret is needed for this flow. See [GitHub's device-flow documentation](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/authorizing-oauth-apps#device-flow).

The browser flow initially requests the OAuth scopes `repo`, `read:org`, `workflow`, `read:user`, `notifications`, `read:project`, `gist`, and `security_events`; `workflow` is required to create or update files under `.github/workflows`, `read:user` covers profile tools such as `get_me`, `notifications` covers the notifications toolset, `read:project` covers the projects toolset, `gist` covers the gists toolset, and `security_events` covers code-scanning, Dependabot, and secret-protection alerts. Set `oauthScopes` to request additional scopes such as `project`, `read:packages`, or `user:email`. Sessions authorized before a scope was requested must connect again once to grant it, and a refused workflow write shows the same reconnect guidance. These can grant broad access, including private repositories, subject to GitHub account and organization policies. GitHub shows the requested permissions before the user authorizes them. The settings page shows the credential source and the granted scopes while connected. If a tool needs another scope, the tool call fails with a message and the settings page shows the requested scopes with a **Reconnect now** button. Reconnect to review them on GitHub, then retry the operation. The plugin does not automatically retry writes, and DSH approval still applies.

Every request stays on the configured origin, with redirects not followed automatically. MCP responses are limited to 16 MiB and discovery to 8 MiB, 100 pages and 1,000 tools. Connection-route request bodies are limited to 8 KiB and must arrive within 5 seconds. Structured output is validated in a bounded pool of isolated workers; a validator that cannot be stopped is abandoned without blocking later calls.

### Troubleshooting

- **Browser sign-in is unavailable** — check that the configured OAuth app client ID is present and device flow is enabled. Restart DSH after changing the profile configuration or process environment.
- **Refreshed credentials could not be saved** — keep DSH running and restore access to the profile's secure storage; the plugin retries saving on the next request. Closing DSH before the save succeeds may require browser authorization again.
- **GitHub CLI is unavailable or not authenticated** — install `gh` on the DSH host and run `gh auth login`, or use a personal access token.
- **Connection fails or tools are missing** — check network access to GitHub's MCP endpoint, account and organization policies, token permissions, selected toolsets, and the DSH log. Select a Connect button to retry.
- **Secure key storage is unavailable** — unlock the system credential store or set `DSH_GITHUB_ENCRYPTION_KEY` to a persistent Base64-encoded 32-byte key.
- **Stored credentials cannot be decrypted** — restore the original key and profile path, or remove the saved credential and reconnect.
- **A write is denied** — check DSH's approval channel and policies as well as the GitHub account or token permissions.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The `dsh.bundle.patch` manifest inserts a host row; `dsh.client` exposes the Web settings section. `apply` creates a profile-specific store and bridge, binds the fenced routes, listens for DSH's pre-execution policy event, and starts the configured credential source. The bridge opens a Streamable HTTP MCP connection, discovers all tool pages, and registers one DSH tool per server definition. A failed or cancelled connection removes its registrations. Disconnect aborts outstanding requests before deleting saved state; unloading preserves state for the next start. The settings page polls connection status every three seconds while its tab is visible.

| Source | Contents |
|---|---|
| `cordis.patch.yml` | Profile row and defaults. |
| `src/index.ts` | Host entry, route binding and approval policy. |
| `src/config.ts` | Configuration schema and defaults. |
| `src/bridge.ts` | Credentials, MCP lifecycle, discovery and registered tools. |
| `src/oauth.ts` | GitHub device authorization and access-token refresh. |
| `src/transport.ts`, `src/response-limit.ts` | Origin restriction, headers and response limits. |
| `src/store.ts` | Encrypted credential file and host keyring. |
| `src/routes.ts` | Fenced connection routes. |
| `src/output-validator.ts`, `src/output-validator-worker.ts` | Pooled, worker-isolated validation of structured output with bounded cleanup. |
| `src/client/index.tsx` | GitHub settings page. |
| `tests/*.test.mjs` | Mock MCP, credential, lifecycle and approval tests. |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [GitHub MCP Server](https://github.com/github/github-mcp-server) and [remote server configuration](https://github.com/github/github-mcp-server/blob/main/docs/remote-server.md).
- [GitHub personal access tokens](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens).
- [DeepSeek Harness configuration catalog](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/config-catalog.md).
- [CHANGELOG.md](CHANGELOG.md), [NOTICE](NOTICE), and [Apache-2.0 license](LICENSE).

-----

<a id="model-experience"></a>
## Model Experience

The model sees the registered GitHub tool names, descriptions and input schemas. Results are returned as tool content; the settings page and credentials are not part of the model prompt. Requests to change GitHub can trigger DSH approval.

#### KV Cache effect

Connecting adds the discovered tool definitions to the request prefix; disconnecting removes them. A changed toolset or server catalog changes that prefix and can invalidate cached tokens after the first changed definition.

<a id="known-limitations-and-deferred-work"></a>
## Known Limitations and Deferred Work

- **GitHub authorization policies** — GitHub may impose account, organization or MCP access restrictions on the bundled OAuth app.
- **One connection per profile row** — the Web routes use a fixed prefix, so the settings page assumes one GitHub bridge per profile.
- **Server-defined capabilities** — tool names, schemas and read-only hints can change; server hints are not a security boundary for an untrusted endpoint.
- **No automatic recovery guarantee** — if the connection closes or a request fails, reconnect from Settings or restart the configured headless source.
- **Credentials are tied to profile path and key** — moving the profile or changing the key makes saved state unreadable. Disconnect does not revoke upstream credentials.
- **Plain-text rendering** — non-text MCP content is represented by a type placeholder, not displayed as native media.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

`npm run build` cleans and compiles the host and client, then bundles the client into `lib/client.js`. `lib` is committed. `npm run typecheck` checks both TypeScript projects; `npm test` builds and runs the mock-backed tests. `npm run test:dsh` installs the packed bundle into a temporary real DSH profile, checks its request fence and encrypted credential file, and exercises the settings page in Chrome when available. Set `DSH_TEST_BINARY` and `CHROME_PATH` for non-default locations. Node.js 22.19 or newer is required.

</details>
