# Node.js CDS failure at block 26

## Finding

The saved run `nine-continued-2026-10-23T16-45-15-388Z` failed during the
**second warmup**, after validating 1,900 rows and attempting fetch 20. It
returned `TIMEOUT`, no completed digest and **zero measured scans**. The first
warmup had returned all 5,000 rows with the correct digest in 4,823.83 ms. The
failed scan, including cancellation and cleanup, took 98,098.95 ms despite its
10-second operation deadline.

This was not a row-count, validation, ordering or hash mismatch. The official
controller stopped on the failure and never ran slot 27.

## Host pressure and limits of the evidence

During the failed block, sampled host free physical memory fell to 554,168,320
bytes (about 528.5 MiB). The subsequent Windows observation at 17:35 UTC recorded
74,615,357,440 committed bytes against a 76,064,043,008-byte limit: **98.10%**.
Rust CDS and ABAP HTTP had already slowed in the preceding blocks. The entire third round was excluded because its host conditions did not meet the comparison protocol.

These observations support host memory and paging pressure as a contributor
to the stall. They do not prove the exact native operation or server-side
cause: the failed process did not retain a per-call native trace. No stress
test was used to recreate severe host paging.

Original evidence is preserved in the failed block JSON/NDJSON, its resource
samples, and `work/nine-readiness/postrun-proof.json`. The previous two-round
[comparison](nine-comparison.md) remains a separate historical result.

## Confirmed cancellation defect and fix

Pinned `node-odbc` 2.6.0 registers executing queries in its connection's active
statement registry. Its cursor-fetch worker omitted that registration.
`connection.cancel()` only calls `SQLCancel` for registered handles, so it
missed an in-flight cursor fetch. The poller waited for the native operation
to return before reporting its timeout and cleaning up.

The compatibility patch now registers the fetch's statement immediately before
`fetch_and_store` and unregisters it immediately after that call returns,
before processing either errors or rows. Existing cursor cleanup, connection
retirement, shared validation and canonical SHA-256 are preserved. The SAP
driver advertises `SQLCancel` support (`SQLGetFunctions` returned success and
supported=1).

Cancellation and cleanup still depend on the driver and OS scheduling. This
fix does not turn the application deadline into a guaranteed wall-clock limit
during paging or a blocked native driver call.

## Verification

- **139 Node checks passed**, including all shared fixtures and ODBC recovery
  checks. One new check covers native fetch registration and patch guards.
- **12 benchmark-controller checks passed**, covering the original continuation
  behavior, workload gates, image pins, balanced order and new memory gate.
- The report analyzer's synthetic self-test passed, including rejection of
  corrupt evidence and correct three-round report text. Synthetic timings
  remain outside real reports.
- A controlled native-call interposition test used the real Node addon and a
  live SAP cursor. It stalled a client-side fetch for five seconds, releasing
  it when `SQLCancel` reached the matching handle. The original addon missed
  cancellation (5,007.33 ms); the patched addon reached it (503.50 ms).
- An end-to-end injected stall at **fetch 20 of scan 2** reproduced the saved
  error shape: 1,900 rows, 20 attempted fetches, `TIMEOUT`, null digest. With a
  one-second diagnostic deadline, the original scan took 5,031.55 ms; the fixed
  scan took 1,029.96 ms. Both retained the failed outcome. The next scan opened
  a fresh connection and validated all 5,000 rows with the golden hash.
- Two ordinary fixed-image CDS scans and two native HANA scans returned the
  correct count and hash and closed successfully. A fresh internal ABAP CDS
  scan and Rust ODBC scan matched them. Six active ABAP/CDS definitions matched
  the local source files after line-ending normalization.

The injected tests model successful cancellation; they do not establish SAP
driver cancellation latency under memory pressure. An initial test-shim
attempt exited 139 because its dynamic symbol lookup was invalid. After
correcting that test harness, both native regression tests passed. No official
benchmark ran during these diagnostics, and their timings are not performance
results.

Local evidence is under `work/node-cds-fix/`: `node-tests.tap`,
`cancel-proof.json`, `timeout-proof.json`, `cancel-capabilities.json`,
`live-parity.json`, `abap-parity.json`, and the corresponding test sources.
The fixed image is `sap-polling-node:nine-fixed-sql`, ID
`sha256:3221921974e44b13334f012a793e021174f8b6d52249cfa16b0eaba289fe605d`.
The matching HTTP image is `sap-polling-node:nine-fixed-http`.
The native addon changed from SHA-256
`fb116f56f565556edf61f1adade19e0abeb0476fc07a4d743ddc1c0fffec2d33` to
`10140cdafac3d6d56bcaf948710db36d51d2bd5395be819a190b2ed79fcb5e11`.
Both images use the existing external read-only SAP driver mount.

## Fresh benchmark preparation

The existing SAP trial was started through the independent Windows launcher;
no SAP container was recreated. The new native patch adds work around each
ODBC fetch. A **new 27-block run** is therefore required; old timings will not
be combined with the fixed-image results.

The controller now checks free host RAM before each official block and after
completion. If any 30-second block resource sample has less than **2 GiB**
free, that block fails the environment gate and the comparison stops while
retaining its evidence. SAP start time and Docker/SAP resource configuration
must also remain fixed throughout the run. The memory gate is a practical
screen, not proof that all background interference is absent.

The original workload, five warmups, 180-second measurement window, three
balanced rounds, timeouts and external client limits remain the same. Fresh
nine-path smoke/readiness checks are required before the official run.

**Status: fixed image prepared and functional checks passed. Performance
measurement is on hold at the user's request until they confirm the machine
is idle.** The prepared input file deliberately has `readiness.ready=false`.
No new performance results have been produced or pushed to GitHub.
