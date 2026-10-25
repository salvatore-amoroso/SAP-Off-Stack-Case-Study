# CDS access from Node.js and Rust through ABAP ODBC

These two [application paths](applications.md) query `ZI_BL_OrderPosition`
through SQL binding `ZUI_BL_ORDERS_SQL`. This guide covers their final build,
runtime and deployment configuration. The [performance report](nine-comparison.md)
retains the measured cohort and its historical source identities.

**Rust + CDS preserves SAP-side access control**, just as Node.js through the same
binding does: the ABAP SQL service remains the access boundary. This is not a
direct HANA login. The [authorization mode](system-design-governance.md#authorization-is-part-of-the-design)
determines whether CDS row-level controls apply; the recorded lab uses privileged
access. Performance and governance/maintenance are separate axes of the study.

The deployment flow binds each Job to immutable inputs and captures actual
mounted-file attestations before and after both clients. The [latest setup
verification receipt](setup-evidence/kubernetes-input-verification.json) is
separate from the measured performance evidence. See [Kubernetes deployment](#run-the-two-kubernetes-jobs)
for the supported checks.

## Installed prerequisites

- Linux x86-64 ABAP ODBC driver patch 33, its libraries, compatible `libsapcrypto.so`, and public trial certificate `sap-trial-ca.pem` are supplied outside the repository. Set `ABAP_ODBC_DRIVER_DIR` in the private environment file; the existing workspace's `Tools/abap-odbc/driver` is an optional fallback. The bundle must be flat and contain regular files only, with no directories or symlinks. Runtime helpers mount it read-only at `/opt/sap/abap-odbc`; licensed binaries remain external to client images and the repository.
- Containers use unixODBC and load the SAP library through their language adapter. The shared query is mounted read-only from [contracts/abap-cds-odbc.sql](../contracts/abap-cds-odbc.sql).
- HTTPS uses `a4h.wdf.sap.corp:50001`, client `001`, `UidType=uid`, and `/sap/bc/sql/sql1/sap/S_PRIVILEGED`. The helpers resolve the existing SAP container's address and add the certificate hostname. `TrustAll=false` and the trusted certificate file enable certificate verification.
- Runtime credentials come from the private environment file selected by `SAP_ENV_PATH` (or the documented local fallback). Helpers supply them in memory to Docker or through stdin to a Kubernetes Secret; images, command arguments, public input hashes and result reports contain no credential values. Follow the [installation runbook](requirements-install-run.md) for standalone configuration.

The lab's SELECT-only SQL binding uses privileged access, with `wssql/active=1` and `wssql/privileged/active=1` enabled. Follow the [administrator setup](sap-installation.md#administrator-approval-for-the-sql-service) to enable and persist these settings. Consumers need appropriate `S_START` and `S_SQL_VIEW` authorizations. Privileged access bypasses CDS DCL and retains SQL service authorization checks.

## Build and verify locally

Run from the project root with the existing SAP trial running:

```powershell
npm run build:clients
docker tag sap-polling-node:nine-sql sap-polling-node:sql-odbc
docker tag sap-polling-rust:nine-sql sap-polling-rust:sql-odbc
node scripts/run-cds-odbc-clients.mjs
```

The controller runs one internal ABAP CDS reference scan, then one Node.js and one Rust ODBC scan sequentially. Each external client container has one CPU, 256 MiB memory, bounded 100-row fetches, no retries, and a process deadline. ABAP shares the existing SAP runtime. Its report is `work/abap-odbc/parity.json`; exit code 0 requires both client processes to finish successfully and match the reference payload.

Node's pinned `odbc` 2.6 dependency needs guarded native build patches: SAP advertises no transaction support, so close must skip rollback and still disconnect/free the connection; cursor fetches must register their active statement so connection cancellation reaches them. The SQL Dockerfile applies and compiles both fixes; genuine cleanup errors still fail. Both clients keep a healthy connection across scans and discard it after transport failures or timeouts. The investigation records mocked recovery checks and native fault-injection checks; ordinary live checks exercise successful scans and cleanup.

The build command executes all four pinned Dockerfiles and records a fresh
clean-build receipt under ignored `work/builds/`. The measured images retain
their own provenance in the [frozen run inputs](benchmark-data/nine-2026-10-23T21-21-52-459Z/inputs.json);
current builds do not change that evidence.

## Run the two Kubernetes Jobs

Use the existing `sap-polling-lab` kind cluster, namespace, kubeconfig, and shared SAP network described in [deploy/sql/README.md](../deploy/sql/README.md). Configure after building the images:

```powershell
.\work\bin\kind.exe load docker-image sap-polling-node:sql-odbc sap-polling-rust:sql-odbc --name sap-polling-lab
node deploy/sql/configure-odbc-runtime.mjs
```

Configuration requires a passing `work/abap-odbc/parity.json` for the current
query, complete local driver inventory and both exact Docker images. The
helper verifies those images are loaded into kind before staging. It copies
the driver into a fresh directory, checks every regular file's name, size
and SHA-256, and publishes without overwriting at
`/opt/sap/abap-odbc-bundles/<inventory-sha256>`. An existing addressed bundle
must match exactly; missing, extra, changed and linked files are refused.
Old versions and the legacy node directory remain available to existing pods.

Versioned immutable ConfigMaps hold the query, public environment, expected
inventory and wrapper. The query mounts as a read-only regular subPath file;
the driver mounts read-only at the existing `/opt/sap/abap-odbc` pod path.
Credentials use a separate immutable Secret with an opaque revision name.
The Job binds these references and the public input identity, which includes
the actual SAP address, image IDs and execution policy. New Jobs start
suspended. Reconfigure after changing any input; first refresh Docker/ABAP
parity if driver, query or images changed.

Start the Jobs sequentially and inspect their results:

```powershell
$taskCdsKubectl = @('--kubeconfig', 'work/kind-kubeconfig.yaml', '--context', 'kind-sap-polling-lab', '--namespace', 'sap-polling-lab')
foreach ($taskCdsJob in @('poller-node-cds', 'poller-rust-cds')) {
  kubectl @taskCdsKubectl patch job $taskCdsJob --type=merge --patch-file=deploy/unsuspend-job.json
  kubectl @taskCdsKubectl wait --for=condition=complete "job/$taskCdsJob" --timeout=180s
  kubectl @taskCdsKubectl logs "job/$taskCdsJob"
}
node scripts/check-cds-odbc-kubernetes.mjs
```

Configuration reuses compatible Jobs without resetting their completion or
suspension state. An incompatible existing Job causes failure before staging
or API writes. For another finite run, first verify the named CDS Jobs have
completed and preserve their Job JSON, pod JSON, logs and verification proof.
Explicitly delete only those completed `poller-node-cds` / `poller-rust-cds`
Jobs, rerun configuration, then run the sequential commands above. Never
delete an active Job or the old driver directories to make configuration pass.
Configuration provenance is `work/abap-odbc/kubernetes-configuration.json`;
the public Job definitions in `work/abap-odbc/jobs.json` contain no Secret
values.

The wrapper hashes the actual complete mounted driver tree, query bytes,
public runtime environment and wrapper before starting the client and again
after it exits. Extra, missing, changed or linked driver files and a linked
query fail. Both compact attestations and the client exit code go only to
`/dev/termination-log` using the `File` policy, below Kubernetes' 4096-byte
limit. Client stdout remains exactly one functional JSON scan.

The verifier reads both attestations from each real terminated container's
status, checks its executed template and immutable resource contents against
current local inputs, and verifies the actual image through filesystem layers,
runtime configuration and the pod image identity. kind may rewrite manifest
digests during loading, so a tag alone is insufficient. Success also requires
zero restarts, successful Job completion and the same functional result as
Docker parity. The complete proof, including both actual attestations, is
`work/abap-odbc/kubernetes-verification.json`.

## What equivalence means

Successful scans must validate the same 5,000 rows, preserve strict key ordering, and produce SHA-256 `df57de597e919adb10ae5365201b999788e86b39219ad040ffbc305539180bc7`. Both clients reuse their existing validation and hashing core; the SQL query supplies exact decimal strings and ISO dates without floating point conversion.

Internal ABAP CDS reports 50 nonempty packages; ODBC reports 51 logical fetch attempts including the final empty fetch. Transport timing and these counters are excluded from payload equality. Zero HTTP body bytes does not mean zero network traffic. This is a conformance check, not a controlled performance study.

## Deploying the SAP objects elsewhere

The abapGit `.srvb.xml`, generated `.sush.xml`, and helper metadata are under
`sap/src/`. Installed abapGit 1.134 cannot serialize the generated `SQL1`
runtime object; activate the SQL binding in ADT to regenerate it. The ADT
creation payload and server-generated details are retained in `sap/setup/`.
[SAP configuration evidence](setup-evidence/cds-odbc-sap.json) records the
approved profile changes and authorization checks. Follow the [SAP installation
guide](sap-installation.md) for a compatible new target. A clean second-system
import remains unverified.
