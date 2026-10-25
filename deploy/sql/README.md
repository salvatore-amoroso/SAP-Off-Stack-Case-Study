# Native HANA clients

These facilities run the finite Node and Rust native HANA consumers against
the frozen 5000-row read-only view in tenant HDB, client 001. SAP remains in
its existing `a4h` container. The query is always read from
`contracts/native-hana.sql`; the SQL text is never duplicated here. Native
HANA uses the included native client libraries and needs no external SAP ABAP
ODBC driver. The separate CDS applications use ABAP SQL service through ODBC.

The setup controller creates private `work/native-hana/runtime.json` with the
restricted lab principal. The runner and Kubernetes helper read it in memory.
Credentials are passed using environment names or Secret JSON through stdin;
they are never command arguments or report content. Keep the ignored runtime
directory private.

Build each image from the project root, one at a time:

```powershell
docker build -f clients/node/Dockerfile.sql -t sap-polling-node:sql clients/node
docker build -f clients/rust/Dockerfile.sql -t sap-polling-rust:sql clients/rust
```

Run both clients sequentially, each with one CPU, 256 MiB memory, one scan and
the same query mounted read-only:

```powershell
node scripts/run-native-clients.mjs
```

`--implementation node` or `--implementation rust` selects one client for an
initial driver check. The other client remains pending in that report. Docker
uses the existing `sap-local-ports` network and `sap-a4h:30215` endpoint.
The runner imposes a 150-second process deadline and removes only its own
uniquely named client container if that deadline or the output cap is exceeded.

For a Node driver check during an unavailable image builder, add
`--implementation node --source-mount`. It uses the existing SQL image's
installed drivers and mounts the current `clients/node/src` read-only over
`/app/src`. The report records a deterministic hash and file list for that
mounted code. Rebuild the image before deploying that updated code to Jobs.

Results are saved to `work/native-hana/node-result.json`, `rust-result.json`
and `native-client-parity-report.json`. ABAP evidence requires `abap-result.json`
and `abap-proof.json`: proof must pass, identify the current shared query hash,
and contain a first scan matching the saved result. Its functional fields are
then compared with both clients: schema, scan index, outcome,
row count, fetch count, digest and error. Each successful scan must have 5000
rows, 51 logical fetches and the manifest digest. Metrics are excluded from
equality. Missing ABAP result/proof produces `status: pending`, never a passing
three-way comparison. Exit codes are 0 for a complete pass, 1 for failure and
2 for pending evidence. A single selected client cannot complete parity.

The native consumers reuse a connection within a run and close cursors and
statements per scan. This finite deployment does not produce benchmark
conclusions; controlled continuous runs use the separate SQL benchmark modes.

## Kubernetes

The existing isolated kind cluster and kubeconfig are used. Only the lab's
`sap-polling-lab-control-plane` container may be attached to the existing SAP
Docker network. If it is not already attached, the operator runs this once:

```powershell
docker network connect --gw-priority -1 sap-local-ports sap-polling-lab-control-plane
```

The configuration helper only inspects network membership; it never attaches
containers or changes SAP. It reads `a4h`'s actual IP on `sap-local-ports` and
sets the pod `HANA_SERVER` to that IP and port 30215. Docker DNS aliases are
not used inside Kubernetes. Gateway priority -1 preserves the kind network's
default route at priority 0. Reconfigure after an SAP network IP change.

```powershell
node deploy/sql/configure-runtime.mjs
.\work\bin\kind.exe load docker-image sap-polling-node:sql sap-polling-rust:sql --name sap-polling-lab
kubectl --kubeconfig work/kind-kubeconfig.yaml --context kind-sap-polling-lab --namespace sap-polling-lab apply -k deploy/sql
```

The helper creates only the lab namespace, `native-hana-config`,
`native-hana-query` and `native-hana-credentials`. Query ConfigMap content comes
directly from the shared SQL file. Its proof record contains the query hash
and endpoint, with no credentials. The two Jobs use distinct native HANA names,
remain suspended on apply, and have zero retries, one worker, a 150-second
deadline, one CPU and 256 MiB memory. Each mounts the same ConfigMap read-only.
Run them sequentially:

Use the shared JSON patch file from the repository root so the same commands
work in Windows PowerShell 5.1 and PowerShell 7.

```powershell
kubectl --kubeconfig work/kind-kubeconfig.yaml --context kind-sap-polling-lab --namespace sap-polling-lab patch job poller-node-hana --type=merge --patch-file=deploy/unsuspend-job.json
kubectl --kubeconfig work/kind-kubeconfig.yaml --context kind-sap-polling-lab --namespace sap-polling-lab wait --for=condition=complete job/poller-node-hana --timeout=180s
kubectl --kubeconfig work/kind-kubeconfig.yaml --context kind-sap-polling-lab --namespace sap-polling-lab logs job/poller-node-hana
kubectl --kubeconfig work/kind-kubeconfig.yaml --context kind-sap-polling-lab --namespace sap-polling-lab patch job poller-rust-hana --type=merge --patch-file=deploy/unsuspend-job.json
kubectl --kubeconfig work/kind-kubeconfig.yaml --context kind-sap-polling-lab --namespace sap-polling-lab wait --for=condition=complete job/poller-rust-hana --timeout=180s
kubectl --kubeconfig work/kind-kubeconfig.yaml --context kind-sap-polling-lab --namespace sap-polling-lab logs job/poller-rust-hana
```

Preserve logs before another run. Recreate only these two completed native HANA
Jobs when another finite check is needed. Existing HTTP Jobs and configuration
are separate resources.

## CDS through ABAP ODBC

The two additional Jobs are `poller-node-cds` and `poller-rust-cds`. Their
separate images use the `:sql-odbc` tag. First run
`node scripts/run-cds-odbc-clients.mjs` successfully and load those exact
images into kind. `node deploy/sql/configure-odbc-runtime.mjs` then checks
that parity record, local driver inventory and loaded image identities before
creating missing Jobs suspended.

Each flat driver bundle must contain only regular files. Configuration copies
it into a fresh staging directory, verifies every filename, size and SHA-256,
and publishes it without overwriting under
`/opt/sap/abap-odbc-bundles/<inventory-sha256>`. Reuse requires the exact same
complete inventory; extra, missing, changed or linked files fail. Existing
versions and the legacy `/opt/sap/abap-odbc` node directory remain untouched.
Pods still mount their selected bundle read-only at `/opt/sap/abap-odbc`.

Versioned immutable ConfigMaps bind the query, public environment and input
manifest to the Job. Credentials use a separate immutable Secret revision;
their values never enter public hashes or proofs. An existing matching Job
is retained. An incompatible Job fails before staging or API writes; preserve
its Job/pod/logs and explicitly recreate only that completed CDS Job to rerun.
Active Jobs are never deleted or reset by the helper.

Follow the [CDS ODBC guide](../../docs/cds-odbc.md) for builds, image loading,
sequential execution and reruns. After both Jobs complete, run
`node scripts/check-cds-odbc-kubernetes.mjs` to verify their exit status,
exact executed templates, image identities, immutable inputs, and functional
results against the successful Docker/ABAP parity record. The POSIX wrapper
hashes actual mounted driver files, query, public environment and wrapper
before and after the client. Its bounded JSON goes to `/dev/termination-log`,
read from the terminated container status; stdout remains one functional JSON
scan. Both attestations must pass. The full proof is
`work/abap-odbc/kubernetes-verification.json`; no credential values enter it.
