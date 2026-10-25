# Final benchmark evidence

The repository retains one measured cohort:
[`nine-2026-10-23T21-21-52-459Z/`](nine-2026-10-23T21-21-52-459Z/manifest.json).
It contains 27 passing blocks, 89,189 measured scans and zero measured failures
across the nine applications. Earlier exploratory runs are outside this edition.

Start with the [findings](../nine-comparison.md),
[measurement protocol](../nine-benchmark-protocol.md) and
[sources and evidence](../sources-and-evidence.md). The cohort directory is an
audit archive, not another setup directory:

| Path | Purpose |
| --- | --- |
| `manifest.json`, `inputs.json` | Run configuration, ordering, identities and frozen inputs. |
| `block-*` | Raw scan records, block summaries and sparse resource observations. |
| `sources/` | Captured measured source files, including historical tools required to identify that implementation. |
| `evidence/` | Readiness, correctness and diagnostic records captured for the run. |
| `evidence-files.json`, `checksums.sha256` | The 265 retained archive entries and checksums for this redacted edition. |
| `privacy-redaction.json` | Removed metadata categories, original/published hashes and unchanged-measurement checks. |

This is a **privacy-redacted evidence export**. Personal workstation paths,
activity details and paging configuration were removed from incidental metadata
and narrative copies. All 54 raw block JSON/NDJSON files, recorded runtime
implementations and all nine numerical result summaries are unchanged. The
[redaction receipt](nine-2026-10-23T21-21-52-459Z/privacy-redaction.json) records
the changed files and integrity references; updated checksums validate this
published edition. Later analysis and post-run records are separate additions.
The three explicitly labelled
navigation companions in `sources/docs/` repair links in captured documents;
they are not measured inputs. Paths recorded under `work/` refer to sanitized
snapshots in this archive, not a requirement to restore old working directories.

Verify the retained evidence from the repository root:

```powershell
node scripts/audit-nine-run.mjs --check-only docs/benchmark-data/nine-2026-10-23T21-21-52-459Z docs/nine-comparison.json
```

For a fresh measurement, follow the [run guide](../requirements-install-run.md).
New operational output stays in ignored `results/` and `work/` directories.
