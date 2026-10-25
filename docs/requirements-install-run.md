# Requirements, installation and running

This guide covers the existing local SAP trial and the nine application paths.
The [system design](system-design-governance.md), [performance comparison](nine-comparison.md)
and [conclusions](conclusions.md) complete the case study. Commands run from
the repository root in PowerShell unless another directory is named.

## Requirements

| Requirement | Recorded lab / reason |
| --- | --- |
| SAP backend | Existing SAP ABAP Trial 2025, SAP_BASIS 816, client `001`, with its HANA tenant. A 7.52 trial is not an equivalent target for these CDS entities, bindings and SQL service. |
| Host | Windows with WSL2 and Docker Desktop using Linux x86-64 containers. The recorded host has 32 GiB RAM and a 24 GiB WSL limit; leave other large workloads closed and maintain at least 2 GiB free host RAM during measurement. |
| Storage | Enough space for the SAP image and data volume, Docker build cache and benchmark evidence. |
| Tools | Git, Node.js 24, Docker CLI; Eclipse ADT and abapGit for SAP installation. Rust can compile inside Docker. Python plus Matplotlib is required only to regenerate charts. |
| Kubernetes | Optional kind and compatible kubectl for the six finite external Jobs. SAP/ABAP remains in the existing SAP container. The controlled performance runner uses Docker directly. |
| SAP client libraries | SAP's Linux x86-64 ODBC Driver for ABAP, compatible CommonCryptoLib/SAPCRYPTOLIB and companion libraries, acquired separately; SAPCAR to extract SAR archives. unixODBC is installed in the SQL images. |
| Access | An authorized SAP runtime identity, permission to publish the lab services and configure SQL access, and a separate SELECT-only HANA benchmark account. No passwords belong in Git or command arguments. |

The measured Node runtime is recorded in the run manifest; the fixed images use
Node 24.22.1. Exact Rust/compiler, image, driver and source identities belong to
each run's immutable inputs, rather than an unpinned “latest” toolchain claim.
The SAP trial, driver and crypto libraries have their own terms and access
requirements; this repository does not distribute them or grant usage rights.

## 1. Start the existing SAP trial

From the containing host workspace, if its independent SAP launcher is installed:

```powershell
& '.\Tools\sap-local\outputs\Start-SAP.cmd'
```

The launcher starts Docker independently through the existing Windows task
`SAP-Local-Docker-Desktop`, then starts `a4h` and `sap-local-ports`. Do not create
a replacement SAP container or move its data as an installation shortcut.
Wait for SAP's dispatcher, gateway and ICM to report GREEN:

```powershell
docker exec --user a4hadm a4h /usr/sap/hostctrl/exe/sapcontrol -nr 00 -function GetProcessList
```

The verified host OData root is
`https://127.0.0.1/sap/opu/odata4/sap/zui_bl_orders_o4/srvd_a2x/sap/zui_bl_orders/0001/`.
The SQL service uses the existing SAP HTTPS port 50001 on the private Docker
network. Native HANA uses tenant port 30215 there. Keep database access private.

## 2. Import and activate the SAP backend

Use [the SAP installation guide](../sap/README.md) for the exact objects and
target-specific steps:

1. Check for name collisions, then import the repository's `/sap/src/` through
   abapGit into a lab package. The recorded installation uses `$ZBACKEND_LAB`
   under `$TMP`; a governed landscape needs an appropriate transportable package.
2. Activate `ZBL_ORD_HDR`, `ZBL_ORD_POS`, their two CDS entities, the service
   definition, the OData V4 Web API binding, SQL binding and ABAP classes.
3. Publish/verify `ZUI_BL_ORDERS_O4`. A read-only CDS service needs no transactional
   behavior implementation merely to expose its reads.
4. Activate `ZUI_BL_ORDERS_SQL` in ADT to regenerate the SQL runtime object.
   Installed abapGit 1.134 does not serialize the generated `SQL1` object.
   Exported repository metadata alone is not proof of a successful clean import.
5. Run `ZCL_BL_SEED_ORDERS` once in client `001`. **It replaces the two lab
   tables' data in that client.** Do this only when intending to reset the fixture;
   never reseed during a benchmark.

The fixture must contain **1,000 headers and 5,000 positions**, with digest:

```text
df57de597e919adb10ae5365201b999788e86b39219ad040ffbc305539180bc7
```

Verify `$metadata`, one ordered `OrderPositions` response and a full scan.
This server returns 100-row pages despite the preference of 500, so the recorded
full HTTP scan makes 51 requests. All clients follow the actual continuation.

## 3. Configure runtime credentials and access

The controllers use Node 24's built-in environment parser. Copy `.env.example`
to the ignored project `.env` and enter your settings locally, or supply
`SAP_URL`, `SAP_CLIENT`, `SAP_USERNAME` and `SAP_PASSWORD` in the process
environment. `SAP_URL` is the HTTP(S) origin, without a path or embedded login.
`SAP_ENV_PATH` selects another private file. Process environment values override
the file. The adjacent `Tools/mcp-abap-adt/.env` is an optional legacy fallback
when the project has no `.env`; no MCP installation or dotenv dependency is needed.
Do not paste credentials into terminal commands or commit the private file.

For native HANA, `node scripts/setup-native-hana.mjs` provisions the restricted
lab view/account on the configured trial and writes private runtime configuration
under ignored `work/native-hana/`. It refuses initial object collisions; do not
rerun it to reset a working installation. Follow [native HANA setup](native-sql.md)
when provisioning a new compatible target. The external account is
`ZBL_BENCH_RO`, granted SELECT only on `ZBL_BENCH_SQL.ORDER_POSITIONS_001`.

For CDS ODBC, follow [CDS ODBC setup](cds-odbc.md). The lab enables and persists
`wssql/active=1` and `wssql/privileged/active=1` and uses `S_PRIVILEGED`. Those
system-wide settings required explicit administrator approval. Production
authorization design must distinguish privileged and business-user access;
see [governance](system-design-governance.md#authorization-is-part-of-the-design).

### Installing the external SAP driver

A `.SAR` is a SAP archive, not a container image or executable installer.
Extract it with SAPCAR, for example on a compatible Linux host/container:

```sh
SAPCAR -xvf ODBCforABAP_<patch>-<platform>.SAR -R /path/to/extracted-driver
```

Use SAPCAR matching the OS where extraction runs, and download the **Linux
x86-64** driver for these Linux containers. Put the extracted files in a private
directory and set its absolute path as `ABAP_ODBC_DRIVER_DIR` in `.env` or the
process environment. The legacy sibling `Tools/abap-odbc/driver/` remains a fallback:

- `ODBC_driver_for_ABAP.so`, its required ICU/other companion libraries;
- compatible `libsapcrypto.so`;
- `sap-trial-ca.pem`, the trusted public certificate used by this local target.

The runtime helper checks required files and hashes them, mounts the directory
read-only at `/opt/sap/abap-odbc`, and sets `LD_LIBRARY_PATH`. The Node addon and
Rust ODBC adapter load the driver through unixODBC **inside the clients**.
The SAP server hosts the SQL service; it does not load the client-side driver.
Use `TrustAll=false` and the certificate hostname `a4h.wdf.sap.corp` on this lab.
Never publish private keys, driver archives or crypto libraries with the project.
SAP documents [the ABAP ODBC installation and required downloads](https://help.sap.com/docs/PRODUCT_ID/b5670aaaa2364a29935f40b16499972d/d71321fa61524686ac42cf0f4114d149.html?locale=en-US&state=PRODUCTION&version=202110.latest)
and [SAPCAR extraction syntax](https://help.sap.com/doc/9a4151ded172412a8a0581f53ddfcc03/CURRENT_VERSION_NZDM/en-US/nzdm_java_unix_me.pdf).

## 4. Build the clients

Use the pinned toolchains and run the offline checks before contacting SAP:

```powershell
npm ci
npm ci --prefix clients/node --omit=optional --ignore-scripts
npm run doctor
npm run verify:node
npm run build:clients
# With the pinned host Rust toolchain, npm run verify:offline checks both languages.
# Otherwise the preceding build creates the Docker test compiler:
npm run verify:offline -- --docker
```

The build helper builds all four Dockerfiles sequentially from source and writes
a clean-build receipt under ignored `work/builds/`. Keep the relative receipt
path printed by that command for section 7. Its dedicated benchmark image tags
are `sap-polling-node:nine-http`, `sap-polling-node:nine-sql` and the equivalent
Rust tags. The old measured images and archived results remain historical.

Finite demonstration controllers use these separate tags:

```powershell
docker tag sap-polling-node:nine-http sap-polling-node:local
docker tag sap-polling-rust:nine-http sap-polling-rust:local
docker tag sap-polling-node:nine-sql sap-polling-node:sql
docker tag sap-polling-rust:nine-sql sap-polling-rust:sql
docker tag sap-polling-node:sql sap-polling-node:sql-odbc
docker tag sap-polling-rust:sql sap-polling-rust:sql-odbc
```

SQL Rust builds enable `native-hana,abap-odbc`; both transports use the same
binary. Node's SQL build applies the pinned `odbc` 2.6.0 compatibility fixes
and rebuilds the native addon. These fixes handle unsupported rollback and
register cursor fetches for cancellation. Do not substitute an unpatched
cached image merely because its tag exists.

The recorded performance images used cached build inputs when registry/network
access was unavailable. Their immutable identities remain with those results.
The supplied Dockerfiles support clean source builds, including Rust SQL;
the [latest setup verification receipt](setup-evidence/kubernetes-input-verification.json)
is separate from the original measured image provenance. A clean SAP import on
a second compatible system remains unverified.

“Offline” verification contacts no SAP system and requires no proprietary ABAP
ODBC driver or credentials. Initial npm/Cargo/image/package downloads require
network access. The CI workflow uses the same offline commands and independently
builds all four source images. Build pins and the dated Debian package snapshot
are checked against `build-lock.json`; upgrade them deliberately together.

## 5. Run correctness checks

```powershell
npm ci --prefix clients/node --omit=optional --ignore-scripts
npm --prefix clients/node test
npm run doctor -- --live
node scripts/check-sap-service.mjs
node scripts/run-cds-odbc-clients.mjs
node scripts/run-native-abap.mjs
node scripts/run-native-clients.mjs
node scripts/check-hana-recovery.mjs
```

The HTTP CLI is `clients/node/src/cli.mjs` or Rust `poller`. SQL CLIs are
`clients/node/src/sql-cli.mjs --transport odbc|hana` or Rust
`sql-poller --transport odbc|hana`. Controllers supply the actual private
environment and fixed queries, so prefer them over typing connection strings.
Node/Rust native drivers return exact text projections; decimals never pass
through floating point. All three languages reuse their own common validator
and incremental canonical SHA-256 core across transports.

The reusable capture in section 7 runs `ZCL_BL_TEST_ORDERS` for every current
shared fixture and ABAP Unit for `ZCL_BL_POLL_ORDERS`, preserving raw evidence.
The fresh nine-path smoke then compares the final live paths against the frozen
count/digest. For ABAP socket tests, first serve/regenerate/activate the HTTP class using the
[SAP guide](../sap/README.md#shared-fixtures-and-http-tests), capture with `--http`,
then pass `--abap-results work/NEW-PREFLIGHT/http.ndjson` to
`scripts/check-http-results.mjs` after the external socket checks. The three
benchmark adapters are `ZCL_BL_BENCH_ORDERS`
(real HTTP sockets), `ZCL_BL_BENCH_CDS` (internal CDS) and `ZCL_BL_BENCH_NATIVE`
(ADBC). `ZCL_BL_RUN_ORDERS` is an internal-dispatch demonstration, not the
HTTP performance adapter. See [all nine applications](applications.md).

## 6. Run Kubernetes demonstrations

Follow [cluster setup](../deploy/README.md) and [SQL Jobs](../deploy/sql/README.md).
Use the explicit `kind-sap-polling-lab` context, namespace `sap-polling-lab` and
ignored `work/kind-kubeconfig.yaml`.

If the existing kind node was stopped during a deliberate host shutdown, start
it with `docker start sap-polling-lab-control-plane`; use cluster creation only
for a new cluster, rather than trying to replace an existing one.

The six external Jobs are:

| Access | Node.js Job | Rust Job |
| --- | --- | --- |
| HTTP | `poller-node` | `poller-rust` |
| Native HANA | `poller-node-hana` | `poller-rust-hana` |
| CDS ODBC | `poller-node-cds` | `poller-rust-cds` |

Configure Secrets through the supplied helpers, load current images into kind,
then unsuspend and wait for **one Job at a time**, using the guides' shared
`--patch-file=deploy/unsuspend-job.json` argument. This works in Windows
PowerShell 5.1 and PowerShell 7 without inline JSON quoting. Save logs before recreating
only a completed lab Job. Reconfigure the ODBC helper after a SAP IP, certificate
or driver change. Kubernetes correctness runs are not the controlled performance
measurements; they verify deployment of the same application paths.

The CDS Jobs use versioned driver bundles and immutable query/configuration
inputs. The [CDS deployment guide](cds-odbc.md#run-the-two-kubernetes-jobs)
describes mounted-file checks and how to migrate completed Jobs without
changing files underneath an existing Pod.

## 7. Run the full nine-application benchmark

### Prepare fresh evidence before timing

The saved `work/night-run/inputs.json` belongs to the historical experiment.
Create new receipts after any source, image, driver, SAP installation or runtime
configuration change. Do not reuse its check flags or old timestamps.

First complete the offline checks and clean image builds in section 4. Use the
new build receipt path printed by `npm run build:clients`. Activate the current
SAP sources, verify the frozen seed and run the read-only SAP capture:

```powershell
node scripts/capture-sap-readiness.mjs --output work/nine-readiness/preflight-NEW
node scripts/prepare-nine-readiness.mjs --preflight work/nine-readiness/preflight-NEW/preflight.json --build-receipt work/builds/NEW/build-receipt.json
$env:NINE_INPUTS_FILE = (Resolve-Path work/nine-readiness/inputs.json).Path
node scripts/run-nine-comparison.mjs --smoke
```

Replace `NEW` with the actual new capture/build directory names. The capture
refuses an existing output directory and never seeds data, activates sources,
changes SAP parameters or starts/stops containers. Source-binding contract v2
saves **27 active SAP source parts**, or **32 with `--http`**: every main source,
local definitions, implementations, macros and test include for the poller,
three benchmark adapters and fixture runner, plus both DDL definitions. An
optional HTTP capture also binds its fixture runner. All parts are compared
before tests execute; a repository-absent include must contain only placeholder
comments/whitespace in SAP. An unchanged Unit method count cannot substitute for
matching active test bodies. The capture also saves current `fixtures.ndjson`,
ABAP Unit `unit.xml` and native `view-definition.csv`, with hashes and the SAP
start/allocation snapshot. It rejects a changed native client filter or a
fixture/Unit mismatch. Older six-source receipts remain historical evidence and
cannot enable new official measurement; recapture them under contract v2.
A clean second-system import must be performed separately by the SAP operator.

The descriptor starts with `ready=false`. Its public-source inventory includes
hidden `.dockerignore` files, `sap/setup/`, the build lock and toolchain files.
A source-build receipt must describe passing clean builds with current source
hashes; retagging an old cached image does not produce that proof.

After the newly generated smoke has passed all nine paths, check the host is idle
and select that exact run directory. Enable the descriptor through the same
validator the official runner uses:

```powershell
node scripts/prepare-nine-readiness.mjs --preflight work/nine-readiness/preflight-NEW/preflight.json --build-receipt work/builds/NEW/build-receipt.json --smoke results/nine-smoke-NEW --confirm-idle
node scripts/run-nine-comparison.mjs
```

`--confirm-idle` records the operator's host-load attestation. The remaining gate
checks actual evidence before timing: required view/fixture/Unit/source records,
all 27/32 unique active source parts and mandatory source hashes,
all nine successful smoke outputs, current source hashes, clean-built image IDs
and unchanged SAP allocation. The runner also rejects image retags and changes
to the driver, routes or configured identities after smoke. Missing evidence or
`ready=true` alone cannot enable official measurement. Keep all referenced
inputs unchanged; never add private runtime JSON, `.env`, driver libraries or
keys to the descriptor's source/evidence file lists.

The run takes approximately **85–95 minutes**: three balanced rounds × nine
applications, five warmup scans and at least 180 measured seconds per block.
It includes the last scan crossing the time boundary. There are no silent
retries. Keep competing workloads off the host where possible. This local
shared-host experiment does not establish an isolated execution environment.
The runner rejects changed inputs, images, SAP start time/resource settings,
and sampled host memory below 2 GiB. A failure stops the comparison and retains
its failed evidence; do not remove slow scans or quietly rerun one slot.

Results appear under `results/nine-<UTC timestamp>/`: immutable inputs, source
and readiness snapshots, raw JSON/NDJSON, resource samples and a manifest.
`progress.json` reports the active block. Preserve the preceding generated
reports/charts before replacing them. For a complete passing 27-block run,
archive its evidence to a **new** directory, check the live source/view before
stopping SAP, then analyze, plot and audit that archive:

```powershell
node scripts/archive-nine-run.mjs results/NINE-RUN-DIRECTORY docs/benchmark-data/NINE-RUN-DIRECTORY
node scripts/check-nine-postrun.mjs docs/benchmark-data/NINE-RUN-DIRECTORY
node scripts/analyze-nine-comparison.mjs docs/benchmark-data/NINE-RUN-DIRECTORY
python scripts/plot-nine-comparison.py docs/benchmark-data/NINE-RUN-DIRECTORY
node scripts/audit-nine-run.mjs docs/benchmark-data/NINE-RUN-DIRECTORY docs/nine-comparison.json
```

Use a Python environment with Matplotlib installed.
The archive helper verifies copied hashes and excludes credentials and SAP
binaries. The audit reconciles every reported scan and the numerical analysis;
it does not independently reconstruct hashes from a full raw row trace.
These commands regenerate statistics and charts. For a later run, also refresh
the recorded conditions, README summary and conclusions from its own evidence,
then review those edits; the current narrative describes this specific cohort.
The [protocol](nine-benchmark-protocol.md) defines timing and analysis.
Credentials and SAP driver binaries remain excluded.

The timed HTTP adapter uses the same local plain-HTTP route for all languages;
the setup/control URL above is HTTPS. ODBC uses verified HTTPS/WebSocket and
native HANA uses the private database TCP route. See the design's transport
qualification before interpreting differences across approaches.

## Normal shutdown

Save logs/results first. When deliberately shutting down the SAP trial/host,
allow SAP HANA to persist its memory state before Windows stops Docker:

```powershell
docker stop --time 7200 a4h
```

This is SAP's [documented graceful shutdown procedure](https://hub.docker.com/r/sapse/abap-cloud-developer-trial/).
Wait for the container to stop; do not use a forced kill or shut Windows down
while its database is still flushing. Normal startup continues to use the
independent launcher. Do not stop SAP during a benchmark.

## Troubleshooting

| Symptom | Check / action |
| --- | --- |
| Docker/SAP endpoint unavailable | Start the independent launcher, wait for GREEN processes, check the existing port forwarder; do not recreate SAP. |
| ODBC library cannot load | Linux x86-64 archive, unixODBC, companion libraries and read-only mount/`LD_LIBRARY_PATH`. |
| SQL service denied | Activated SQL binding, service/client path, enabled parameters and proper service/view authorizations. Do not “fix” this by granting unrestricted roles. |
| TLS failure | Certificate chain/expiry and hostname mapping. Keep ODBC certificate verification enabled. |
| `TIMEOUT` or memory environment gate | Preserve the attempt; inspect SAP/driver and host paging/background load separately. Fresh diagnosis and a new declared run may be required. |
| `COUNT`, `DIGEST`, `SCHEMA` or `ORDER` | Stop timing. Verify frozen seed, text projection, client filter and shared contract. Never weaken a validator to obtain a timing result. |
| abapGit activation/import problem | Resolve dependency activation/publication in ADT; generated SQL runtime artifacts require target-specific activation. |

A clone alone does not recreate the SAP trial, private runtime configuration,
licensed driver directory, ignored build cache or readiness artifacts. Those
are explicit installation prerequisites and limitations of this local lab.
