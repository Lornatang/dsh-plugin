# Codex Security compatibility

The reference is [OpenAI Codex Security CLI and SDK 0.11.0](https://github.com/openai/codex-security/tree/npm-v0.11.0) and its bundled plugin 0.1.95. DSH implements the workflows through its own host services and `codex_security_*` tools.

| Area | DSH behavior | Remaining difference |
| --- | --- | --- |
| Skills | DSH registers all 20 reference skill names. Instructions are adapted to available DSH tools. | Cloud findings and publication use authenticated official integrations supplied by the host. Live account access, publication and Cloud validation need the corresponding account and integrations. |
| Findings and seal | New scans use the Codex v1 target and finding identities, coverage and evidence references, and the canonical threat-model projection. The workbench verifies the saved threat-model digest before displaying it. | The reference validator can check Standard and Deep fixtures when `CODEX_SECURITY_REFERENCE_ROOT` is supplied. This verifies the tested contract and the selected artifacts. |
| Patch risk | DSH validates an assessment against the schema shipped by the official 0.11.0 release. | Assessment and merge authority remain separate from schema validation. |
| Drafts and candidates | Drafts accept `coverage` or DSH `reviewState`. Discovery, validation and attack-path records accept the Codex-style nested data as well as DSH's flat forms and retain the nested evidence. | Tool names and several arguments differ. DSH candidate submission appends and deduplicates rather than replacing the complete candidate set; Codex pagination and handoff claims are not implemented. |
| Deep scan | A durable coordinator launches isolated independent DSH workers, seals Standard child scans, merges findings conservatively and enforces worker, attempt, no-new and time limits. | DSH uses its own model provider and source-only worker tools; it does not reproduce the Codex SDK implementation or enforce token/dollar budgets. Automatic diff scans are unsupported. |
| Lifecycle and state | SQLite locks serialize campaign ownership, scans and indexes across processes. A hashed recovery claim permits authorized takeover. | Resume is explicit and requires a live DSH agent; SQLite locking requires trusted local storage. The claim is not a Codex handoff token. |
| Host integrations | DSH offers its own web workbench, formats and tools. | Codex desktop preflight, SDK worker orchestration, account-specific Daybreak access, and issue-provider integrations depend on the host and are not supplied by this package. |

DSH seals the evidence submitted by an agent and checks its structural consistency. It cannot independently guarantee the agent reviewed every claimed surface or followed skill instructions. `complete` describes the submitted coverage, not a proof that no vulnerabilities exist.


DSH `startActivation` uses a dedicated persistent worker preset and native tool guard. A successful full-file receipt verifies delivery through the DSH tool pipeline, not that a model understood every file or found every issue.
