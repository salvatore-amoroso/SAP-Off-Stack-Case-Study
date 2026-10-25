# Native HANA access

All three native clients query the same read-only view over the synthetic order
tables in tenant `HDB`, SAP client `001`. ABAP uses its primary ADBC session;
Node.js uses the SAP HANA client; Rust uses `hdbconnect`. The [main architecture
diagram](../README.md#architecture) shows their shared database.

This guide covers the final setup and correctness controls. The
[nine-application performance assessment](nine-comparison.md) retains the
measured results and source/build provenance. Current builds and checks do not
replace that historical cohort. A clean second-system SAP import remains
unverified.

## Shared work

The exact ordered SELECT is [contracts/native-hana.sql](../contracts/native-hana.sql). The ABAP method embeds the same query, checked by readiness capture. The view joins header and position keys, explicitly filters client `001`, removes ABAP CHAR padding, formats the date as ISO text, and projects decimal values as text. Drivers never convert quantities or money through floating point numbers.

Each scan streams nine fields in fixed order, checks identifier/date/decimal rules and strict composite-key order, and uses the common canonical SHA-256 implementation. The Node and Rust HTTP paths call the same row-processing routines as their SQL paths. ABAP `SCAN_NATIVE` calls the common private `VALIDATE_VALUES` and digest helpers.

The frozen fixture remains 1,000 headers and 5,000 positions. Its canonical digest is:

```text
df57de597e919adb10ae5365201b999788e86b39219ad040ffbc305539180bc7
```

Application batches contain at most 100 rows. SQL `pages` counts attempted logical batches, including an empty terminal fetch when the row count is an exact multiple of 100: this fixture takes 51. These are application counts; physical protocol fetches and driver buffering differ. Node uses the SAP driver's bounded 128 KiB cursor cache; disabling that cache can add per-row driver work and is excluded from the final configuration. `metrics.body_bytes=0` means there is no HTTP response body; SQL wire bytes are unknown.

## Prepare and run

From the project root, while the existing SAP trial is running:

```powershell
node scripts/setup-native-hana.mjs
docker build -f clients/node/Dockerfile.sql -t sap-polling-node:sql clients/node
docker build -f clients/rust/Dockerfile.sql -t sap-polling-rust:sql clients/rust
node scripts/run-native-abap.mjs
node scripts/run-native-clients.mjs
```

The setup script is restricted to the existing `a4h` trial, tenant `HDB`, schema `SAPA4H`, and frozen 5,000-row fixture. It creates a separate benchmark schema/view and a generated restricted account `ZBL_BENCH_RO`, with SELECT granted only on that view. It refuses an initial object collision and never reseeds the tables. Privileged trial credentials are consumed inside the SAP container. External runtime credentials stay under ignored `work/native-hana/`; do not copy them into source, images, reports, or command arguments.

ABAP runs through `ZCL_BL_BENCH_NATIVE` after importing the active native scanner and wrapper via abapGit. Follow the [SAP installation guide](sap-installation.md); HANA view/user provisioning is a separate setup-script step. The finite host control submits the expected count/hash and captures three scans. `run-native-clients.mjs` runs Node.js and Rust sequentially under equal Docker limits, then compares functional fields against the captured ABAP result. Missing ABAP evidence remains pending. The raw correctness records are saved under `work/native-hana/`.

For suspended finite Kubernetes Jobs and the runtime Secret/configuration helper, see [deploy/sql/README.md](../deploy/sql/README.md). The existing HTTP deployment remains available.

## Timing policy and limits

All SQL clients reuse a connection across scans. ABAP uses SAP's primary database session as `SAPA4H`; external clients use the restricted benchmark account. No secondary SAP connection or DBCON password is needed. Node.js and Rust establish their connection during the first warmup. Measured scans include query/cursor construction, fetch, validation, canonical hashing and cursor cleanup. Node.js and Rust explicitly prepare each native query; ADBC's kernel preparation/cache behavior is not observable through the public API used here.

Node.js and Rust expose continuous SQL benchmark entry points with
`--duration-seconds` and `--warmup-scans`; the ABAP wrapper accepts corresponding
class-run JSON fields. Use the [nine-path runner](requirements-install-run.md#7-run-the-full-nine-application-benchmark)
for balanced, sequential measurement with frozen data. Finite correctness
timings are not a performance study.

This removes the HTTP/OData stack from the native path, but it remains a comparison of the complete implementations and drivers. ABAP shares SAP's runtime and resources; its primary database identity, session settings, network path, driver, and cancellation capabilities differ from external containers. The local native adapters use plain TCP on the private Docker network. They are configured for this local trial.

The shared validation/hash behavior is the same. Transport failure timing is not identical: the available public ADBC APIs have no query timeout/cancel operation, so ABAP checks the scan deadline around blocking calls and recognizes HANA timeout code 613. Node.js requests cancellation; Rust uses socket read timeouts. A stuck driver or database call may exceed a requested deadline. Retain the finite process/container deadline. No equivalence claim covers every driver-specific failure or cancellation race.

Native SQL bypasses ABAP CDS authorization and automatic client handling. The explicit client filter and limited view are therefore essential. SAP documents these differences in [Rules for Accessing ABAP-Managed Database Objects](https://help.sap.com/docs/abap-cloud/abap-keywords-standard-abap/rules-for-accessing-abap-managed-database-objects?locale=en-US&state=PRODUCTION&version=classic_2025).

## CDS SQL service

The [CDS ODBC applications](cds-odbc.md) provide a separate route through the ABAP application server. `ZUI_BL_ORDERS_SQL` is now active, with SELECT enabled; the installed Linux SAP driver lets Node.js and Rust query the existing CDS entity. The two approved SQL service parameters are enabled and persisted in the local trial.

The CDS route has its own query, credentials, image tags and finite Kubernetes Jobs. See the [nine application paths](applications.md) and the CDS guide for setup, verification and the generated `SQL1` import limitation.
