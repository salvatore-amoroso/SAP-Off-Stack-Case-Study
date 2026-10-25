# Conclusions

## What this study can decide

The nine paths let a team compare a SAP-native implementation, a familiar BTP
side-by-side runtime and a compiled alternative while checking the same data,
validation and canonical hash. The meaningful unit of comparison is the
**complete access path**: runtime, driver, conversion, service work and placement.
It is not an isolated language microbenchmark.

The conclusion has two axes: **performance**, supported by the measured
cohort, and **governance / maintainability**, assessed from access controls,
contracts, dependencies and change ownership. Correctness and reproducibility
support both. The study is complete as a comparative read-workload experiment;
production deployment is not an acceptance criterion.

The current [performance report](nine-comparison.md) contains every measured
repetition, p50/p95, useful throughput, ranges and latency sequence. All **27 blocks passed**, with **89,189 measured scans**, zero measured
failures and **445,945,000 reported validated positions** across
repeated reads of the same frozen dataset. Warmup comprises another 135 scans
and is excluded from the measured statistics.

## Observed results

| Language | HTTP median p50 ms | CDS median p50 ms | Native HANA median p50 ms |
| --- | ---: | ---: | ---: |
| ABAP | 1,556 | 76 | 72 |
| Node.js | 1,427.28 | 55.1 | 41.16 |
| Rust | 1,395 | 29 | 16 |

CDS means internal Open SQL for ABAP and the ABAP SQL service through ODBC for
Node.js/Rust. Each cell is the median of three trial p50 values; full p95,
throughput and observed ranges remain in the performance chapter.

HTTP median p50 values span **1,395–1,556 ms**. The
SQL paths complete this full-scan workload with much lower latency. That
access-path difference includes pagination, service/driver work, conversion,
network and encryption differences; it does not isolate HTTP protocol cost.
The highest observed native-HANA median throughput is **Rust · Direct HANA**, at
**295,965.65 positions/s**. This is a descriptive
result for these implementations and conditions, not a statistical winner or
universal language ranking.

All three patched Node.js CDS blocks passed. The earlier failed warmups remain
historical availability evidence, not discarded samples from this run. Success
here does not estimate production reliability or prove behavior under severe
resource pressure. Shared-host placement limits how closely the experiment
represents a fully isolated machine.

## Takeaways from the recorded experiment

The following comparisons use the **median of three trial p50 latencies**
from the [recorded cohort](nine-comparison.md). Percentage reductions describe
scan latency, not throughput increases. They are descriptive observations,
not language-only effects or estimates of statistical significance.

### Runtime gains depend on the access path

Moving from the Node.js implementation to Rust reduced HTTP median scan
latency by **2.3%**, from **1,427.28 to 1,395 ms**, and CDS latency by **47.4%**,
from **55.1 to 29 ms**. The runtime difference was much more visible in these
SQL implementations. This pattern motivates profiling; it does not identify
which layer caused the difference or establish a database bottleneck.

### In-system execution does not guarantee the lowest latency

External **Rust + CDS recorded 29 ms**, compared with **76 ms for internal
ABAP + CDS**. Proximity alone did not determine the observed result. These
paths also differ in runtime, retrieval/conversion, resource allocation and
placement, so the comparison does not show that external placement itself
caused the improvement.

### CDS can combine a large performance improvement with SAP-side governance

Rust recorded **1,395 ms through HTTP, 29 ms through CDS and 16 ms through
native HANA**. Direct HANA was not necessary to obtain the substantial
HTTP-to-CDS improvement while retaining the SAP SQL-service access boundary.
Native HANA saved another **13 ms**, approximately **45%** of the CDS latency,
with a different authorization and ownership model. That is a concrete
performance/governance tradeoff rather than a universal architecture winner.
The [privileged lab mode](system-design-governance.md#authorization-is-part-of-the-design)
retains service/entity authorization; successful scans do not demonstrate
business-user CDS row filtering.

### Dependency behavior is part of maintainability

The [captured Node.js CDS investigation](benchmark-data/nine-2026-10-23T21-21-52-459Z/sources/docs/node-cds-block26-investigation.md) exposed a
cursor-cancellation gap alongside severe host memory pressure. The adapter
patch and recovery checks became part of the evidence behind the completed
run. Driver and adapter behavior therefore belong in the maintenance
assessment. Both external CDS implementations depend on the SAP ODBC driver;
this obligation should not be assigned solely to Rust. The incident does not
establish a comparative long-term reliability or maintenance-cost ranking.

### Reported throughput includes the agreed validation work

Every successful scan includes ordering checks, exact-value validation,
canonicalization and incremental hashing. Useful rows/s therefore describes
completed scans of the agreed workload, rather than raw driver retrieval
speed. It counts repeated validations of the same frozen positions, not
distinct business documents processed. This makes equivalent work central
to interpreting the performance comparison.

These takeaways apply to the recorded implementations and conditions. They
do not establish general reliability, lower operating cost or the performance
of later code revisions without a new experiment.

## Architecture recommendation

These are conditional interpretations of the two axes, not requirements to
deploy this lab or a universal ranking of integration architectures.

**Start with a suitable released SAP HTTP API for a general external business
integration.** It provides a service boundary that can be owned, versioned and
secured independently of physical database details. Where a suitable API does
not exist and a supported custom service is appropriate, the CDS/service-binding
route already exposes a straightforward read API inside SAP. Standard protocol
alone does not make a custom contract released, authorized or upgrade-stable.

Use **internal ABAP CDS** when SAP-local processing and the extension model fit
the requirement. It avoids an external data-service hop while keeping the
application in the SAP operational and change-management domain. Its consumption
of shared SAP work processes and database capacity remains part of the decision.

Use the **ABAP SQL service** when a governed tabular integration contract and SQL
capabilities are deliberate requirements. Treat exposed CDS entities, query
limits, identity/DCL policy, driver lifecycle and support as architecture choices.
**Rust + CDS preserves SAP-side access control**, as does Node.js through the
same service. This remains distinct from direct HANA access. The lab uses the
privileged mode described in the [authorization section](system-design-governance.md#authorization-is-part-of-the-design);
business-user CDS filtering is not demonstrated by its successful scans.

Treat **direct HANA access** as an approved database-level integration or a
diagnostic control, not the automatic next step after seeing a faster scan.
Read-only grants and a client-filtered custom view reduce exposure but do not
recreate SAP application authorization or business semantics. Assess target
deployment, data ownership, supported contracts and access rights first.

The strongest conclusion combines a measured benefit with the obligations of
the chosen path. A faster Rust + CDS result can be compatible with SAP-side
governance; the remaining judgment concerns the intended policy, SQL contract,
dependencies and team ownership. No numerical maintenance-cost ranking has
been measured. The [design chapter](system-design-governance.md) explains these
tradeoffs and links the SAP/standards sources.

## Runtime recommendation

- **ABAP** is the SAP-native reference and a practical choice for suitable
  SAP-local logic. These classic-ABAP examples still need adaptation and released
  interfaces where an ABAP Cloud/clean-core extension model is required.
- **Node.js** is a practical reference for a team using the SAP BTP/CAP ecosystem.
  Choose it when service-development speed, available skills and SAP integration
  tooling satisfy the required latency and cost budget. CAP is an ecosystem
  rationale here, not the framework used by the measured plain-Node poller.
- **Rust** is a credible choice when the measured complete-path improvement
  matters and the team can maintain its implementation and dependencies.
  Choosing Rust does not remove SAP-side access control from the CDS route.
  Driver provisioning is shared with Node.js CDS, while comparative learning
  and maintenance effort depends on the team and remains unmeasured. The study
  establishes no universal language or total-cost winner.

## When a Node.js/Rust REST façade makes sense

Add a separately deployed API when it owns a useful contract: composition across
systems, task-specific payloads, caching, independent scaling or substantial
non-SAP processing. If it merely re-exposes the same CDS rows, first compare that
benefit with the additional hop, serialization, credentials, patching and service
ownership. SAP can already expose CDS over OData.

An ODBC-backed façade must explicitly address user/tenant authorization rather
than forwarding a privileged technical identity as if it were an end user.
Neither proposed façade was built or timed in this study. Its production latency,
throughput, authentication cost and failure behavior require a separate test.

## Reliability and next experiments

The [captured driver investigation](benchmark-data/nine-2026-10-23T21-21-52-459Z/sources/docs/node-cds-block26-investigation.md) found a real
cursor-cancellation gap and evidence of severe host memory pressure. The patch,
fault-injection recovery checks and memory gate improve the experiment, but
native cancellation still depends on the driver and OS. Preserve failed attempts
and resource evidence alongside successful capacity results.

Optional follow-up performance experiments could vary query size/selectivity,
network placement or connection reuse. A maintenance exercise could trace a
contract or driver change. Those would add evidence for the study's two axes;
they are future work, not completed claims or prerequisites to finish this study.
Concurrent writes, production sizing and production reliability are outside
the current frozen CHF/EA, single-consumer full-scan experiment. Database
saturation is not established as the cause of its access-path differences.

Full row validation and hashing on every repeated read are intentional parts of
this benchmark contract. A production consumer using selective queries, deltas,
aggregates or a different validation policy has a different mix of server,
network and client costs and needs its own measurement.
