# Blinded review quality benchmark

Five toy state contracts exercise the review workflow's evidence decisions. Two matched pairs each include one violation and one clean control. One case needs evidence beyond the supplied source. The cases use static inspection of ordinary JavaScript snippets.

The benchmark uses `source_supported` for contract violations established by source inspection. A `confirmed` finding in the full audit workflow requires an independently observed result.

From the repository root, prepare the packets in a new folder.

```sh
node scripts/benchmark-review-quality.mjs prepare /path/to/new-review-inputs
```

For each configuration under comparison, open a fresh reviewer session for each case and provide only that case's packet and the review guidance under test. Keep the benchmark checkout, answer key, tests, other cases, and prior responses outside the reviewer's context. Save the responses before scoring.

Combine the response objects into a `decisions` array with one object per case. Record the model or reviewer, skill revision, and any settings that vary in the optional `reviewer` string. Include any observed totals in the optional `cost` object with integer fields `elapsedMs`, `agentInvocations`, `inputTokens`, and `outputTokens`. Omit unavailable fields.

```json
{
  "reviewer": "model/version with skill commit abc123",
  "decisions": [],
  "cost": { "elapsedMs": 8200, "agentInvocations": 5 }
}
```

Fill the array and score the results.

```sh
node scripts/benchmark-review-quality.mjs score /path/to/results.json
```

- Known-case recall is the share of violations marked `source_supported`.
- Clean-control rates show the shares marked `source_supported` (false positives) and `rejected`.
- Unresolved handling reports the share retained as `needs_validation` and the count marked `source_supported`.
- The decisive citation rate credits a case when the verdict matches, the response includes every decisive source line, and all cited lines exist.
- Citation precision measures the share of unique cited lines that match decisive source lines, regardless of verdict. Repeated lines count once per case. Precision is `null` when the response cites no lines. Read the per-case explanations to assess whether the reasoning supports the verdict.

Use the same fixture revision and reviewer setup across runs. The score describes this small source-review sample. Full-audit performance and independent model quality require separate evidence. The test suite uses authored responses to check the packet generator and scoring arithmetic. Run those checks with `node --test tests/review-quality.test.mjs`.
