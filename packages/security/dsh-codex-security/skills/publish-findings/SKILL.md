---
name: publish-findings
description: Prepare existing security findings for a reviewed import into an authorized Codex Security destination.
---

# Prepare findings for publication

Select the completed DSH scan or user-supplied scanner output. Record its repository, revision, scope, finding IDs and exclusions. Use `codex_security_export_findings` for an approved local export of a DSH scan. Review the intended selection and remove secrets before transferring any data.

For Cloud, use the connected official import or publication workflow when it supports the source format. Resolve the signed-in account and repository, then preview the selection, destination, evidence and exclusions. Obtain approval for that preview before any upload. Use the official workflow's returned receipts to report success or partial results, and refresh the preview if the selection changes. If an authenticated connector or compatible importer is unavailable, return the local export and report the remaining dependency.
