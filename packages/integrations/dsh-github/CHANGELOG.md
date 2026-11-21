# Changelog

## 0.1.9

- Keep older status polls from overwriting the latest connection action and retry stalled polls.
- Scan streaming responses and redact tool output in a single pass.

## 0.1.8

- Assign stable ids to output schemas so warm validation workers skip re-sending and re-cloning an unchanged schema, and retire a worker when its compiled-schema cache is full.
- Replace the redaction set on a new connection and cap it, and skip rebuilding a tool result that contains no credential.
- Cap buffered upstream error bodies at 1 MiB, keeping the same reject-on-overflow behavior.

## 0.1.7

- Remove unused credential-store helpers, the unused end-of-stream callback plumbing and a write-only token field; limits and cancellation behavior are unchanged.

## 0.1.6

- Fail closed when the host does not expose the tool approval hook: only tools marked read-only register, so a host without `tools/pre-execute` cannot run writes without approval.
- Bound tool discovery with one overall deadline derived from `toolCallTimeoutMs` (30 seconds to 10 minutes) instead of only per-page timeouts.
- Detect a credential file swapped between the security check and the open on Windows, and refuse to share credentials when the active profile is unknown.
- Truncate upstream connection errors before they reach the settings page.
- Parse the settings API response only after checking the HTTP status, so an empty 401 or 403 body no longer shows a JSON syntax error.
- Reject `toolCallTimeoutMs` values above the 32-bit signed millisecond limit.
- Preserve cancellation and MCP error identity when a failure passes through credential redaction.
- Cover the new behavior with tests for the approval-hook failure path, credential swaps, profile refusal, and cancellation identity.

## 0.1.5

- Request the `read:project`, `gist`, and `security_events` OAuth scopes by default so the projects, gists, and security-alert toolsets work after browser sign-in. Existing sessions need one reconnect to grant them.

## 0.1.4

- Request the `read:user` and `notifications` OAuth scopes by default so profile and notification tools work after browser sign-in. Existing sessions need one reconnect to grant them.
- Add an `oauthScopes` configuration field for requesting extra device-flow scopes such as `gist` or `read:packages`; invalid scope names are rejected at startup.
- Settings page: show the credential source and granted scopes while connected, add a one-click **Reconnect now** button to the additional-permissions banner, and add a **Copy code** button for the device authorization code.

## 0.1.3

- Request the `workflow` OAuth scope by default so browser-authorized tokens can create and update files under `.github/workflows`.
- Detect GitHub's workflow-scope refusal in tool errors (which arrive as tool results, not HTTP scope challenges) and show the same reconnect-with-permissions guidance for OAuth sessions. Existing sessions need one reconnect to grant the new scope.

## 0.1.2

- Speed up credential redaction with a cached single-pass pattern instead of per-string secret scans, and reuse pooled validation workers instead of spawning one per structured tool call.
- Harden structured-output validation: a stuck validator can no longer hold a worker slot past its timeout, and abandoned workers are capped.
- Enforce a 5-second deadline on connection-route request bodies and skip responses on destroyed sockets.
- Drop malformed fields when loading an encrypted credential session, and forward only plain-object tool arguments.
- Scan SSE chunks without line breaks in bulk while keeping per-event byte accounting identical.
- Pause settings-page status polling while the browser tab is hidden, and report the package version in the MCP client identity.

## 0.1.1

- Add GitHub browser authorization using the bundled OAuth app, with cancellation, encrypted token storage, refresh and additional-permission prompts.

## 0.1.0

- Connect a DSH profile to GitHub's hosted MCP server using a personal access token, GitHub CLI, or an environment token.
- Register discovered repository, issue, pull request, and Actions tools, with DSH approval for calls not marked read-only.
- Add a GitHub settings page, encrypted profile credentials, request limits, and mock and real-DSH integration checks.
