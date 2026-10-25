# Nine-application benchmark protocol

This is a new experiment across all nine current applications. Earlier HTTP,
CDS and native HANA measurements are historical evidence and are not mixed into
its statistics. The question is how these complete access paths perform on
this local SAP trial with the same business workload.

## Frozen workload and correctness gate

- SAP Trial 2025, client `001`; the existing 1,000 headers and 5,000 positions.
- Same nine business fields in strict composite-key order. Each implementation
  uses its existing production validator, exact decimal normalization,
  canonical UTF-8 TSV encoding and incremental SHA-256.
- Every scan must return 5,000 validated rows and digest
  `df57de597e919adb10ae5365201b999788e86b39219ad040ffbc305539180bc7`.
- No local sort, dataset copy, precomputed digest substitution, data reseeding,
  concurrent scans, application retries or skipped validation/hash work.
- HTTP: the same literal service root, SAP identity, headers, selected fields,
  continuation handling, 51 requests and 1,074,741 response-body bytes.
- Internal ABAP CDS: `ZI_BL_OrderPosition`, 50 nonempty 100-row packages.
- External CDS ODBC: `contracts/abap-cds-odbc.sql`, the original CDS through
  `ZUI_BL_ORDERS_SQL`, 51 logical fetch attempts including empty EOF.
- Direct HANA: `contracts/native-hana.sql`, the same restricted view for all
  three languages, 51 logical fetch attempts including empty EOF.
- Access-specific counts are checked against their own contracts. They do not
  count identical physical network operations. SQL `body_bytes=0` is an unused
  HTTP instrumentation field, not a measurement of SQL network traffic.

The external SQL projections produce exact decimal strings and ISO dates;
internal ABAP CDS converts native values in ABAP. The nine validated business
values and canonical hash must still agree. The test concerns the frozen
CHF/EA fixture, not arbitrary SAP currency/unit conversion rules.

## Timing and connection boundaries

One process or SAP class-run invocation performs a block. Complete five warmup
scans, then continuously start scans for at least 180 seconds. Finish the scan
started before the boundary. Buffer records and serialize/transfer them after
timing; no per-scan console logging inside the measured window.

Per-scan timing includes query/request creation, retrieval, parsing or value
conversion, validation, canonical encoding/hash comparison, and cursor/client
cleanup. Exclude process startup, credential loading, ADT dispatch, warmup and
final report serialization. Actual measured block wall time includes loop and
bookkeeping overhead and is the throughput denominator.

| Approach | Connection lifecycle |
| --- | --- |
| HTTP in all three languages | Fresh client per scan; reuse within its requests; close/drop before the outer scan timer stops |
| External CDS ODBC | Persistent connection established in warmup; new query/cursor per scan; close cursor per scan; final disconnect outside block timing |
| Direct HANA | Persistent external connection or existing SAP primary session; new query/cursor per scan; cursor/statement cleanup timed |
| Internal ABAP CDS | Existing SAP database session; ordered Open SQL cursor opened/closed per scan |

The HTTP benchmark lifecycle is intentionally the same for its three clients.
It differs from the persistent SQL routes. Cross-approach ratios include that
choice and the complete service/query path; they do not isolate protocol cost.

## Resources and topology

Node.js and Rust run one at a time in containers, each capped at one CPU,
256 MiB RAM and 256 MiB total memory-plus-swap. One runtime worker/driver thread
is requested where the existing adapter exposes the setting. Driver buffering
and SAP kernel preparation/cache behavior remain implementation-specific.

ABAP runs inside the existing SAP container and shares its resources with the
service and HANA. It cannot receive an equivalent independent CPU/memory cap.
Do not restart SAP, clear caches or change its allocation between trials.

HTTP uses the common local host port-forwarding route. CDS ODBC uses the private
Docker network and SAP's HTTPS/WebSocket SQL endpoint, with certificate
verification enabled and the external SAP driver mounted read-only. Native
HANA uses private-network TCP. These are different network/security stacks.

All HTTP clients and external CDS clients use the configured SAP identity.
External HANA clients use the restricted view account; ABAP ADBC uses SAP's
primary database identity. Record identity fingerprints, not credentials.

Complete builds, conformance checks and the nine-path smoke run before official
measurement. No tests, builds, seeding, tracing or other pollers may run during
official trials. Leave the idle kind cluster consistently running. Record
host and Docker resource observations every 30 seconds; these are samples and
cannot establish per-client ABAP resource attribution.

## Prespecified sequence

Each cell is one complete 180-second block after its warmup.

| Round | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | Node HTTP | Rust CDS | ABAP HANA | Node CDS | Rust HANA | ABAP HTTP | Node HANA | Rust HTTP | ABAP CDS |
| 2 | Rust HANA | ABAP HTTP | Node CDS | Rust HTTP | ABAP CDS | Node HANA | Rust CDS | ABAP HANA | Node HTTP |
| 3 | ABAP CDS | Node HANA | Rust HTTP | ABAP HANA | Node HTTP | Rust CDS | ABAP HTTP | Node CDS | Rust HANA |

Every consecutive trio contains all three languages and all three approaches.
Every exact application appears once in the early, middle and late third of a
round, and in each within-trio position. Languages and approaches have equal
mean sequence positions. This reduces temporal-order bias; it is not complete
pairwise counterbalancing. Use a fixed five-second gap between blocks.

Never silently retry a failed official block. Retain its exit status, available
output and reason. A correctness failure invalidates capacity comparison;
investigate separately and identify any new run instead of overwriting it.

## Provenance and analysis

Before timing, pin the protocol, fixture/query/source bytes, active SAP source
checks, actual image identities and build provenance, runtime versions, host
allocation, routes, limits and readiness evidence. Copy raw source snapshots
and evidence into an immutable input archive. Verify source and image identity
again after measurement. Keep credentials and proprietary driver binaries out
of reports and source snapshots; record driver file hashes instead.

For each of 27 blocks, reconcile all warmup and measured records, count errors,
and calculate successful-scan p50 and p95 by nearest rank. Preserve every slow
scan, including any recurrence of the earlier late ABAP CDS slowdown. Useful
throughput is successful scans multiplied by 5,000 divided by the actual
measured block wall seconds; failure time remains in the denominator.

Report all three trial statistics, their median and observed range for each
application. The headline p95 is the median of three trial p95 values. Trials
are the experimental repetitions; correlated scans are not independent trials.
Three repetitions do not support strong statistical-significance or universal
language-ranking claims. Include sample counts and chronological latency plots.

Archive the complete run locally. The trial's bundled licence restricts
publication of benchmark results involving SAP; this task collects and shows
results in the local workspace.

## Addendum after the block 26 investigation

The [investigation](node-cds-block26-investigation.md) records a Node ODBC
cursor cancellation fix and host paging evidence. A run using the fixed image
starts a fresh 27-block comparison; it does not adopt older measured blocks.
Wait for the operator's idle-machine confirmation and pass fresh nine-path
smoke/readiness checks before starting official measurement.

Before every official block and at final verification, require at least 2 GiB
of free host RAM. Any 30-second resource sample below that threshold fails the
block's environment gate, retains its evidence and stops the run. Keep SAP's
start time and Docker/SAP resource configuration unchanged. This screen cannot
exclude every background-load or paging effect; report the resource samples.
