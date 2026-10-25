# SAP installation and administrator handoff

The supported local target is classic ABAP Trial 2025, SAP_BASIS 816, client
`001`, tenant `HDB`, application schema `SAPA4H`. The pollers are classic ABAP;
this is not an ABAP Cloud installation. The repository supplies the lab objects
and checks, not a SAP licence, the SAP image/data disk or licensed client drivers.

The first installation must use an independently provisioned compatible trial.
Use the vendor's [trial installation instructions](https://hub.docker.com/r/sapse/abap-cloud-developer-trial/)
and applicable terms. If a trial already exists, preserve it and start it through
its existing launcher. Before import, check for collisions with the global
`ZBL_*`, `ZI_BL_*`, `ZUI_BL_*` and `ZCL_BL_*` names; never reset an existing
instance to simulate a clean import.

## Runtime contract on a new local host

The current controllers deliberately target one local topology. Before importing,
the SAP administrator must provide and verify these endpoints:

| Component | Required configuration |
| --- | --- |
| SAP container | Existing compatible installation named `a4h`; no script recreates it. |
| Docker network | `sap-local-ports`, with SAP alias `sap-a4h`; only the lab kind node is additionally attached when using Kubernetes. |
| Host ADT/control | HTTPS origin in private `SAP_URL`, normally `https://127.0.0.1`; class-run and source-read authorization in client `001`. |
| HTTP benchmark route | The same `http://host.docker.internal/sap/...` route used by all three HTTP adapters, reachable from SAP and client containers. Host forwarding is the installation owner's responsibility. |
| SQL service | Private SAP HTTPS port `50001`, certificate hostname `a4h.wdf.sap.corp`, verified CA chain. |
| Native HANA | Private tenant endpoint `sap-a4h:30215`, primary `hdbsql -U DEFAULT` access for OS user `a4hadm`. |

The existing host-workspace launcher is optional installation-specific tooling;
a standalone checkout does not need its MCP package. Supply SAP credentials via
the project `.env`, `SAP_ENV_PATH`, or process environment as described in the
[installation guide](requirements-install-run.md#3-configure-runtime-credentials-and-access).
Use a private directory with appropriate Windows ACLs for credentials and drivers.
Unix file modes alone do not configure Windows ACLs.

## Import into an empty compatible SAP installation

1. Record SID, client, SAP_BASIS version, trial image identity and the chosen
   package. Check all names in `sap/src/` for existing repository/TADIR objects,
   including the service bindings and generated authorization defaults. Stop on
   collisions; do not overwrite another package's objects.
2. In abapGit, import this Git repository at the intended commit into a new lab
   package. The repository's `.abapgit.xml` starts at `/sap/src/`; do not import
   the containing workspace. `$ZBACKEND_LAB` under `$TMP` is the recorded local
   package. A governed target requires its own transportable package and owner.
3. Keep the abapGit import and activation logs. Activate the two DDIC tables,
   both associated CDS entities (jointly if needed), service definition, OData
   binding and ABAP classes. Verify there are no inactive dependent objects.
   Source includes, XML class metadata and test includes all belong to the import.
4. In ADT, publish the OData V4 **Web API** binding `ZUI_BL_ORDERS_O4`. Verify its
   actual service-group assignment and Web API URL. Check `$metadata` and a
   selected `OrderPositions` response with the intended runtime identity.
5. Activate SQL binding `ZUI_BL_ORDERS_SQL` in ADT and verify SELECT is enabled.
   The installed abapGit 1.134 serializer does not export its generated `SQL1`
   runtime object. Activation must regenerate it; copying SRVB/SUSH metadata
   alone is insufficient. If binding creation needs repair, the original ADT
   creation payload and SQL details are in `sap/setup/`; review their package/SID
   values for the target rather than submitting them blindly.
6. In client `001`, deliberately run `ZCL_BL_SEED_ORDERS` once. It replaces both
   lab tables in that client. Confirm 1,000 headers, 5,000 positions and the
   [frozen digest](../contracts/seed-manifest.json). Do not seed during checks or
   measurements. Verify the header expansion contains its five positions.
7. Provision the separate native view/account with
   `node scripts/setup-native-hana.mjs`. This is restricted to the topology above,
   refuses initial collisions and does not seed data. Keep its ignored runtime
   files private. It grants the generated restricted account SELECT on the one
   explicitly client-filtered lab view.

`ZCL_BL_EXPORT_GIT` and `ZCL_BL_EXPORT_ODBC` are optional development exporters
for the recorded standalone abapGit program/package. Their dynamic report-local
class references are installation-specific; ordinary abapGit import/export is the
portable path. They need not be executed to install or validate the lab.

## Administrator approval for the SQL service

The recorded lab uses privileged SQL-service access, not end-user DCL filtering.
Enabling it changes system-wide SAP parameters. An administrator must approve
the target, access scenario and rollback before applying the following steps.

1. Record the current runtime values and persistent profile values of
   `wssql/active` and `wssql/privileged/active`. Save a timestamped profile backup
   outside Git. Confirm the active instance profile path for this target; the
   recorded trial uses `/sapmnt/A4H/profile/A4H_D00_vhcala4hci`.
2. On the intended trial/client, run `ZCL_BL_SETUP_SQL` with parameter-administration
   authorization. It changes only those two dynamic runtime parameters to `1`,
   prints their before/after values and return codes, and performs the SQL-service
   authorization checks. Any nonzero return code or value other than `1` is a
   failed setup. The class does **not** persist profile changes.
3. Through the target's approved SAP profile administration procedure, set exactly
   these assignments in the correct active instance profile, avoiding duplicate
   contradictory entries:

   ```text
   wssql/active = 1
   wssql/privileged/active = 1
   ```

4. Record the approved backup/profile paths and both runtime readings. At a later
   administrator-controlled restart, verify the settings persist and repeat the
   SQL service check. Do not restart SAP during a benchmark or as part of an
   offline verification command.
5. Grant the consumer only the intended `S_START` SQL-service access and
   `S_SQL_VIEW` SELECT scope for `ZUI_BL_ORDERS_SQL`/`ZI_BL_OrderPosition`.
   Run `scripts/run-cds-odbc-clients.mjs` with the intended identity. Do not grant
   broad roles to make a denied connection pass. Privileged mode bypasses DCL;
   the [governance boundary](system-design-governance.md#authorization-is-part-of-the-design)
   remains applicable even when SELECT succeeds.

For rollback, the administrator restores the recorded prior runtime values and
profile contents using the same approved procedure, then verifies the resulting
service behavior. Preserve the receipt and do not silently disable another
consumer's SQL service. No repository command edits the instance profile.

## Driver and certificate handoff

Acquire the Linux x86-64 ABAP ODBC driver and compatible CommonCryptoLib through
authorized SAP channels. Extract with SAPCAR, retaining the required companion
libraries. Supply only the trusted **public** issuing certificate chain as
`sap-trial-ca.pem`, obtain its fingerprint from a trusted administrator and verify
the hostname/expiry. A downloaded certificate is not trusted merely because it
was presented by the endpoint. Keep `TrustAll=false`; never copy a server private
key into the driver directory.

Set `ABAP_ODBC_DRIVER_DIR` to that private extracted directory, preferably an
absolute path (single-quote Windows paths in `.env`). Both process environment
and the standard private settings file are supported. The old sibling driver
path is an optional fallback. The helper hashes the files and mounts them read-only;
the repository does not distribute the driver or crypto binaries.

## Verification receipt and second-system boundary

After clean client builds and SAP activation, run
`scripts/capture-sap-readiness.mjs --output work/NEW-PREFLIGHT` and the readiness
workflow in [the run guide](requirements-install-run.md#prepare-fresh-evidence-before-timing).
For socket conformance, serve/regenerate/activate the HTTP fixture class before
capturing with `--http`. Raw ABAP NDJSON is accepted directly by the conformance
checkers through `--abap-results`; no hand-written JSON wrapper is needed.

The current source-binding contract is version 2. It verifies 27 active source
parts (32 with `--http`), including main sources, local definitions,
implementations, macros and test includes for the poller, three benchmark
adapters and fixture runner, and both DDL definitions. The optional HTTP runner
adds five parts. Empty include slots are checked for comment-only placeholders;
unexpected active code cannot hide behind an absent repository file. Activate
changed production/test includes and the generated fixture runner before capture,
even when the number of Unit methods or fixtures stays unchanged.

Retain the import/activation/publication logs, administrator approval and
persistence receipt, build receipt, captured source/fixture/Unit/view proof,
parity reports and smoke output. The automated capture reads active sources and
the view, binds all active source parts before tests and executes the harmless
fixture/Unit tests; it does not import,
activate, seed, grant roles, change profiles or start/stop containers.

The new capture and readiness code has offline regression coverage. A fresh SAP
import and administrator persistence/restart verification on a second compatible
installation have **not** been performed by this revision. Existing measured
archives retain their original source bytes and verification boundaries.
