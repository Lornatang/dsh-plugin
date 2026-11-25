---
name: cloud-findings
description: Read existing OpenAI Codex Security Cloud findings and scan status using a connected official read tool.
---

# Read existing Cloud findings

Discover the available official Codex Security Cloud integration and use its current tool schemas. Resolve the signed-in account, selected repository and exact record identifiers before reading. For account or scope ambiguity, ask the user to select the relevant account or repository.

Use only read operations for this workflow. Preserve requested filters and cursors, report partial results, and inspect a selected finding before summarizing its recorded evidence or status. Keep scan completion, validation and assignment separate in the report. If no authenticated official reader is available, explain that dependency and analyze any existing export the user provides. Never infer Cloud data from a local scan or request credentials in chat.
