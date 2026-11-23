# Changelog

## 0.1.11 - 2026-11-23

- Keep native events local to DSH on Windows and enforce resource limits on crew operations.
- Update the TypeScript and DSH development dependencies.
- Publish from the shared repository using npm Trusted Publishing.

## 0.1.10 - 2026-11-21

- Move the source and release metadata to the shared dsh-plugin repository.
- Download the session analyzer and its platform-specific binaries from the same repository as the bundle.

## 0.1.9 - 2026-11-19

- Recheck the runtime record before reusing cached health verification, so changed runtime identities cannot accept observations.
- Record fresh reads for native reuse when their file fingerprints still match.
- Preserve UTF-8 bytes and advance offline recovery by the exact byte range returned.

## 0.1.8 - 2026-11-19

- Record fresh reads for native reuse when their file fingerprints still match.
- Preserve UTF-8 bytes and advance offline recovery by the exact byte range returned.

## 0.1.7 - 2026-11-19

- Re-release of 0.1.6: the registry staged the 0.1.6 upload without exposing an approval record, so 0.1.6 could never be published. No code changed after 0.1.6.
- Keep the verified analyzer binaries attached to this release under the new version.

## 0.1.6 - 2026-11-19

- Compare endpoint host names instead of URL substrings when detecting provider hosts, so a crafted URL cannot satisfy a provider check by embedding a domain in its path (clears the js/incomplete-url-substring-sanitization findings).
- Override undici to 8.12.4 and @modelcontextprotocol/client to 2.4.0, clearing six Dependabot advisories.
- Keep the verified analyzer binaries attached to this release under the new version.

## 0.1.5 - 2026-11-19

- Cache the verified local runtime identity for one second per endpoint, so a tool call performs one health check instead of two while a runtime restart still invalidates sessions.
- Skip the second read-and-hash of a read tool input when the runtime response carries no ccr:// recovery context.
- Cache per-session surface manifests by content generation and node count, so unchanged surfaces are not re-hashed on every agent step.
- Keep the verified analyzer binaries attached to this release under the new version.

## 0.1.4 - 2026-11-19

- Restore the POSIX native-socket retry: a socket the runtime has not created yet is retried instead of disabling the call, while a replaced or foreign-owned path is still refused before any request is sent.
- Keep the verified analyzer binaries attached to this release under the new version.

## 0.1.3 - 2026-11-19

- Simplify the system-prompt and request-header hooks by dropping unused handler parameters; behavior is unchanged.
- Keep the verified analyzer binaries attached to this release under the new version.

## 0.1.2 - 2026-11-18

- Settle the block hook promise on timeout or abort, so a hung analyzer cannot stall tool execution.
- Count only successful edits against the Cavecrew builder budget and match file identities with platform-aware case folding.
- Bound retained compression originals to 64 entries and 8 MiB, and drop an entry once it has been restored.
- Report inherited-event statistics from the current session's own events instead of replaying the whole log.
- Require a configured analyzer binary to be executable, and require the native bridge socket to be a socket owned by the service user on POSIX.
- Open input-state files non-blocking so a FIFO cannot stall the pre-execution check.

## 0.1.1 - 2026-11-18

- Republish the DSH plugin with the verified analyzer binaries attached to the matching GitHub release.

## 0.1.0 - 2026-11-18

- Honor HTTP and HTTPS proxy settings when downloading verified analyzers.

- Keep native child-session observations available after transient hook failures.
- Read native responses promptly and allow bounded transport scheduling slack.
- Provide Caveman skills and session-specific response styles.
- Register Cavecrew investigator, builder, and reviewer presets and delegation tools.
- Support recoverable native tool-result compression and session usage reports.
- Analyze DSH session history and recover verified input from diagnostic locators.
- Merge child-agent observations into their parent session.
- Reduce repeated session scans and batch recoverable compression requests.
- Offer Blocks suggestions and Browse MCP tools.
- Provide an Auto model routing configuration and command-line entry.
