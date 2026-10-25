# Sources and evidence

Prepared 25 October 2026. Local records support claims about this experiment;
external documentation supports interface and language semantics. Neither kind
of source establishes a universal runtime ranking or measured maintenance cost.
This index does not represent a new benchmark or live authorization check.

## Local experimental evidence

### M1 Recorded performance

**Supports:** the recorded latency, throughput, counts and trial variation for
run `nine-2026-10-23T21-21-52-459Z`, measured on 23 October 2026.

- [Machine-readable report](nine-comparison.json): `summaries[].p50_ms.median`,
  `p95_ms.median` and `useful_rows_per_second.median` are medians of the three
  trial statistics, not statistics of one pooled set of scans.
- [Full report and repetitions](nine-comparison.md),
  [measurement protocol](nine-benchmark-protocol.md),
  [run manifest](benchmark-data/nine-2026-10-23T21-21-52-459Z/manifest.json)
  and [frozen inputs](benchmark-data/nine-2026-10-23T21-21-52-459Z/inputs.json).
- [Independent arithmetic/evidence audit](nine-comparison-audit.json) and
  [post-run source checks](nine-postrun-proof.json).

**Limits:** correlated scans are not independent experimental repetitions.
Placement, drivers, connection lifecycles and encryption differ between access
approaches. Resource coverage is incomplete. Measured active-source checks
covered six main ABAP/CDS definitions; later readiness captures bind all active
source parts, including local and test includes. The [redaction receipt](benchmark-data/nine-2026-10-23T21-21-52-459Z/privacy-redaction.json)
identifies personal metadata removed from the published export; measured runtime
sources and raw scan records are unchanged. Later fixes do not create new timing evidence.

### M2 Derived comparisons

**Supports:** arithmetic comparisons calculated from M1's trial-median p50s.

- Latency reduction from Node.js to Rust:
  `100 × (1 − Rust p50 / Node.js p50)` for the same access approach.
- Latency ratio between approaches: `baseline p50 / alternative p50`.
- Absolute saving: `baseline p50 − alternative p50`.

See [the conclusions](conclusions.md#takeaways-from-the-recorded-experiment).
These calculations describe latency, not percentage throughput increases,
statistical significance, isolated language effects or operating-cost savings.

### C1 Workload parity

**Supports:** the specified validation, key ordering and canonical bytes, plus
reported row-count/digest agreement for successful scans.

- [Behavior contract](implementation-contract.md),
  [seed manifest](../contracts/seed-manifest.json) and
  [canonical example](../contracts/canonical-example.tsv).
- [Measured cohort's fixtures](benchmark-data/nine-2026-10-23T21-21-52-459Z/sources/contracts/fixtures.json),
  [evidence inventory](benchmark-data/nine-2026-10-23T21-21-52-459Z/evidence-files.json)
  and [checksums](benchmark-data/nine-2026-10-23T21-21-52-459Z/checksums.sha256).
- [Arithmetic/evidence audit](nine-comparison-audit.json): the measured cohort
  used **68 shared fixtures and nine ABAP Unit methods**. The current
  [shared fixtures](../contracts/fixtures.json) and [ABAP Unit source](../sap/src/zcl_bl_poll_orders.clas.testclasses.abap)
  expand correctness coverage to **84 fixtures and 13 methods**, without a
  new performance cohort.

**Limits:** the audit reconciles reported hashes/counts and evidence files.
It cannot independently recompute every row hash: pollers did not emit complete
raw row traces. Matching output does not establish authorization equivalence,
concurrent-write consistency or behavior outside the tested contract.

### G1 CDS access

**Supports:** Rust and Node.js consume exposed CDS through the ABAP SQL service,
retaining SAP-side identity and service/entity authorization. They do not use
the direct HANA route for this scenario.

- [CDS configuration and verification](cds-odbc.md),
  [SAP readiness receipt](setup-evidence/cds-odbc-sap.json) from 23 October 2026 and
  [authorization interpretation](system-design-governance.md#authorization-is-part-of-the-design).
- The receipt records a SELECT-only binding, `S_PRIVILEGED` and successful
  `S_START` / `S_SQL_VIEW` checks. [S1](#s1-sql-service-exposure) and
  [S2](#s2-sql-access-scenarios) explain the service and authorization modes.

**Limits:** applicable DCL controls can be evaluated in business-user mode;
the recorded lab uses privileged access and has no synthetic business-row
policy. It does not demonstrate business-user row filtering or measure its
cost. Successful scans are not an authorization test suite.

### J1 Maintenance obligations

**Supports:** observed dependencies, reproducibility mechanisms and change
boundaries; their maintenance implications are qualitative judgments.

- [Governance and maintainability assessment](system-design-governance.md#maintainability-evidence).
- [Node dependencies](../clients/node/package-lock.json),
  [Rust dependencies](../clients/rust/Cargo.lock) and the shared
  [CDS query](../contracts/abap-cds-odbc.sql).
- [Driver/query input verification procedure](cds-odbc.md#run-the-two-kubernetes-jobs)
  and its [24 October receipt](setup-evidence/kubernetes-input-verification.json),
  explicitly separate from the historical performance cohort.

Both external CDS clients require the SAP ODBC driver. No comparative
developer-hour, staffing, build-time or long-term maintenance cost was measured.
Actual team familiarity can change the maintenance judgment.

### H1 Driver incident

**Supports:** one implementation investigation and the documented response.
The [captured Node.js CDS block-26 investigation](benchmark-data/nine-2026-10-23T21-21-52-459Z/sources/docs/node-cds-block26-investigation.md)
describes the cursor-cancellation gap alongside host memory pressure; the
[completed cohort](nine-comparison.md) records the subsequent successful run.

The committed [cancellation proof](benchmark-data/nine-2026-10-23T21-21-52-459Z/evidence/work/node-cds-fix/cancel-proof.json),
[timeout proof](benchmark-data/nine-2026-10-23T21-21-52-459Z/evidence/work/node-cds-fix/timeout-proof.json)
and [fix receipt](benchmark-data/nine-2026-10-23T21-21-52-459Z/evidence/work/node-cds-fix/fix-receipt.json)
provide the regression evidence without requiring ignored local working files.

**Limits:** an investigated failure is not a general Node.js/Rust reliability
ranking. Later [regression and integration checks](setup-evidence/kubernetes-input-verification.json)
are correctness evidence, not replacement timing observations.

## External technical references

These primary references support interface and language semantics. Check the
guide version and target-system applicability before using them for another
landscape. No vendor documentation, driver binary or credential has been copied
into this index.

### S1 SQL service exposure

[SAP: Creating and Exposing an SQL Service in the ABAP System](https://help.sap.com/docs/abap-cloud/abap-integration-connectivity/developing-and-exposing-sql-service-in-abap-system?version=sap_cross_product_abap).

**Supports:** exposing CDS through a service definition/SQL binding and
configuring authorized access. **Version:** cross-product ABAP guide selected
by the URL; target-system applicability still requires checking.
This reference does not certify the lab or another SAP landscape.

### S2 SQL access scenarios

[SAP: Access Scenarios](https://help.sap.com/docs/ABAP_PLATFORM_NEW/d28ccbeac239408eb37cd06d3de41ef6/3b914502fc3a42038addbd138821fb2f.html).

**Supports:** business-user access evaluates applicable CDS controls;
privileged access bypasses DCL conditions while retaining service/entity
authorization. **Version displayed on 25 October 2026:** ABAP Platform 2025
FPS02, October 2026. This SAP Help URL follows the current guide.
Configuration determines
which mode a consumer actually uses; the client language does not select it.

### S3 CAP runtime context

[SAP: Developing with CAP in SAP BTP](https://help.sap.com/docs/btp/btp-developers-guide/cloud-application-programming-model).

**Supports:** CAP's Node.js/Java runtime ecosystem as context for the language
choice. **Version:** live BTP guide, without an immutable revision identified.
The measured Node.js poller uses plain Node.js, not CAP; this
reference establishes neither BTP deployment nor a productivity advantage.

### S4 HTTP OData

- [RFC 9110: HTTP Semantics](https://www.rfc-editor.org/rfc/rfc9110).
- [OData Version 4.01, Part 1: Protocol](https://docs.oasis-open.org/odata/odata/v4.01/odata-v4.01-part1-protocol.html),
  OASIS Standard, 23 April 2020.

**Supports:** protocol semantics and terminology, not a prediction of protocol
performance. An HTTP endpoint is not automatically a released,
upgrade-stable or correctly authorized business API.

### S5 Rust FFI

[Rustonomicon: Foreign Function Interface](https://doc.rust-lang.org/nomicon/ffi.html).

**Supports:** foreign-library boundaries and the obligations of safe wrappers
around native calls. **Version:** rolling Rustonomicon chapter, no immutable
revision pinned. Rust language checks
do not certify SAP-driver internals, wrapper correctness or cancellation
behavior, and this reference supplies no comparative benchmark result.

Published checksums validate the privacy-redacted evidence edition;
numerical measurements remain intact. Credentials, private runtime settings
and proprietary SAP driver binaries are excluded.
