# Changelog

## 0.1.10

- Update the TypeScript and DSH development dependencies.
- Publish from the shared repository using npm Trusted Publishing.

## 0.1.9

- Move the source and release metadata to the shared dsh-plugin repository.

## 0.1.8

- Add a development-only blinded source-review benchmark with separate answer keys, known issues, clean controls, and an evidence-insufficient case.
- Score static support, false positives, unresolved decisions, and source citation precision.

## 0.1.7

- Allow checks in one archived attempt to share evidence while rejecting reuse across attempts.
- Share the bounded file reader across both CLI validators.

## 0.1.6

- Build JSON paths in the coverage-ledger preflight only when an error is reported, instead of for every visited value.
- Check JSON whitespace with a character-code set instead of a regular expression per byte.
- Pre-size the Windows bounded-read buffer from the file size and drop the per-chunk allocation and final copy.

## 0.1.5

- Stop exporting two validator helpers that only their own modules use; validator behavior and the published skill layout are unchanged.

## 0.1.4

- Load the report schema through the bounded, symlink-guarded reader and report a constant parse error, so a malformed schema cannot echo parser text or bypass the input limits.
- Print the output-capped note only when diagnostics were actually truncated, including when the error list saturates at its limit.
- Document that the array limit applies to every array, top-level and nested, and that POSIX symlink protection covers only the final path component.
- Remove the temporary verification directory before rethrowing, so a failed check cannot leak the directory or hide the original error.
- Treat an unloadable skill file as an absent skill and invalidate the provider cache instead of failing the registry call.

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
