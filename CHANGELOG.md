# Changelog

## 0.1.3

- Skip impossible findings-schema branches for parsed JSON while preserving validation diagnostics.
- Reduce copying during bounded Windows input reads and exclude development tests from the published package.
- Detect the Windows desktop host for the DSH integration check without launching a shell.
- Add a reproducible validator benchmark and compatibility checks for branch selection and multi-chunk input.

## 0.1.2

- Align the English and Chinese READMEs with the package documentation structure, including configuration, troubleshooting, implementation, and model experience.

## 0.1.1

- Run the findings and coverage-ledger validators on native Windows with bounded, handle-based input reads.
- Reject Windows device, network, substituted-drive, and reparse-point paths and fail closed when native support is unavailable.
- Organize the skill and its resources under `skills/security-audit/`.

## 0.1.0

- Add the `security-audit` skill and companion files to DeepSeek Harness.
- Add npm bundle metadata, bilingual documentation, and DSH integration checks.
