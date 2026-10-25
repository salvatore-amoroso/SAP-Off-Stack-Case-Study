# SAP backend and ABAP paths

Target: local SAP ABAP Trial 2025, SAP_BASIS 816, client `001`. These are classic
ABAP implementations, not an ABAP Cloud package. Follow the [SAP installation
and administrator handoff](../docs/sap-installation.md) for prerequisites,
collision checks, import/activation order, publication and SQL-service approval.
A clean import on a second compatible system remains unverified.

## Objects

| Objects | Purpose |
| --- | --- |
| `ZBL_ORD_HDR`, `ZBL_ORD_POS` | Client-dependent synthetic order tables. |
| `ZI_BL_ORDERHEADER`, `ZI_BL_ORDERPOSITION` | Header/position CDS entities and associations. |
| `ZUI_BL_ORDERS` | Shared service definition exposing `Orders` and `OrderPositions`. |
| `ZUI_BL_ORDERS_O4` | Read-only OData V4 Web API binding. |
| `ZUI_BL_ORDERS_SQL` | SELECT-only SQL binding for external CDS consumers. |
| `ZCL_BL_POLL_ORDERS` | Common validation, canonicalization, incremental SHA-256 and transport cores. |
| `ZCL_BL_BENCH_ORDERS` | Authenticated real HTTP socket benchmark. |
| `ZCL_BL_BENCH_CDS` | Internal Open SQL CDS benchmark. |
| `ZCL_BL_BENCH_NATIVE` | ADBC native HANA benchmark. |
| `ZCL_BL_TEST_ORDERS`, `ZCL_BL_TEST_HTTP` | Generated shared-fixture and socket-test runners. |
| `ZCL_BL_SEED_ORDERS` | Deliberately replaces the two lab tables in the selected client. |
| `ZCL_BL_SETUP_SQL` | Administrator-authorized dynamic SQL-service parameter setup. |
| `ZCL_BL_RUN_ORDERS` | Internal ICF-dispatch correctness demonstration. |

Read-only CDS exposure needs no transactional behavior definition. Activate
and publish the OData Web API binding in ADT. Activate the SQL binding there to
regenerate its `SQL1` runtime object, which the installed abapGit serializer
does not export. Use ordinary abapGit import/export; the optional exporter
classes in `src/` are development helpers.

## Three measured ABAP data paths

- **HTTP:** `ZCL_BL_BENCH_ORDERS` calls the common scanner through authenticated
  sockets, using the same literal local HTTP endpoint as Node.js and Rust.
  It creates/closes a client per scan and reuses connections within its pages.
- **CDS:** `ZCL_BL_BENCH_CDS` reads `ZI_BL_OrderPosition` directly using ordered
  Open SQL packages. HTTPS ADT starts the runner and collects output; the
  measured data read makes no HTTP request.
- **HANA:** `ZCL_BL_BENCH_NATIVE` uses ADBC and SAP's primary database identity
  to read the same explicitly client-filtered native view as the external
  clients. It reuses the common validation and hashing core.

`ZCL_BL_RUN_ORDERS` uses `create_internal`, bypassing network sockets and HTTP
login. Its demonstration timings are **not** used in the performance comparison.
The [nine-path protocol](../docs/nine-benchmark-protocol.md) defines timers,
connection lifecycles and limits; the [final results](../docs/nine-comparison.md)
retain every measured repetition.

External Rust/Node.js CDS access uses the ABAP SQL service and retains SAP-side
identity and service/entity authorization. The recorded lab uses privileged
access, which bypasses DCL row conditions. The synthetic CDS entities declare
`#NOT_REQUIRED` and have no business-row policy. See [governance](../docs/system-design-governance.md#authorization-is-part-of-the-design)
and [ODBC setup](../docs/cds-odbc.md); matching hashes do not establish authorization equivalence.

## Shared fixtures and HTTP tests

From the repository root, regenerate the fixture runner after a contract change:

```powershell
node sap/setup/generate-fixtures.mjs
```

For ABAP socket tests, keep the fault server running in another terminal and
replace `PORT` with its announced port reachable from SAP:

```powershell
node scripts/check-http-conformance.mjs --serve
node sap/setup/generate-fixtures.mjs --http-origin=http://host.docker.internal:PORT
```

Activate generated classes in ADT. They invoke the common scanner and emit
per-case NDJSON plus a summary. Capture current active sources, fixture/Unit
results and the native view; add `--http` only after activating the HTTP runner:

```powershell
node scripts/capture-sap-readiness.mjs --output work/NEW-PREFLIGHT --http
```

After fresh external socket checks, compare the captured ABAP results:

```powershell
node scripts/check-http-results.mjs --abap-results work/NEW-PREFLIGHT/http.ndjson
```

Follow the [run guide](../docs/requirements-install-run.md#7-run-the-full-nine-application-benchmark)
for clean builds, readiness preparation and the nine-path smoke before timing.
Do not reseed during checks or benchmarks. Every successful scan must validate
5,000 positions and match the [seed manifest](../contracts/seed-manifest.json).
Credentials and proprietary drivers stay outside Git. [Sources and evidence](../docs/sources-and-evidence.md)
distinguishes measured-source checks from later implementation verification.
