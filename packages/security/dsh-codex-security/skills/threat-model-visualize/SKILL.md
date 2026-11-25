---
name: threat-model-visualize
description: Inspect an existing sealed threat model and present its assets, trust boundaries and controls in the DSH workbench without running a new scan.
---

# Visualize a saved threat model

Identify the completed scan by its scan ID and target. If the target has several models, use the one requested or ask which revision to show. Retrieve the verified model with `codex_security_get_threat_model`. If there is no sealed model, report that status and preserve the original scan.

Use the Threat model panel in the selected scan's workbench to inspect structured fields or the original Markdown. Include the scan ID and verified SHA-256 in a report so readers can trace it to the saved artifact. Preserve the modeled scope, assumptions, boundaries and security objectives. Describe only relationships supported by the recorded model. Label hypotheses and confirmed findings separately, and keep source paths as evidence references.
