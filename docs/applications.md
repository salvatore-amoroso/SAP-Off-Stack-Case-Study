# Nine application paths

Each cell is an independently runnable application path. The Node.js and Rust
paths share language libraries so validation, ordering and canonical SHA-256
cannot drift between transports. ABAP uses the same validation class for all
three paths.

| Language | HTTP / OData | CDS | Direct HANA |
| --- | --- | --- | --- |
| ABAP | `ZCL_BL_BENCH_ORDERS` (authenticated HTTP sockets) | `ZCL_BL_BENCH_CDS` (internal Open SQL on CDS) | `ZCL_BL_BENCH_NATIVE` (ADBC) |
| Node.js | `src/cli.mjs` | `src/sql-cli.mjs --transport odbc` | `src/sql-cli.mjs --transport hana` |
| Rust | `poller` | `sql-poller --transport odbc` | `sql-poller --transport hana` |

ABAP stays in the existing SAP trial. Node.js and Rust run in client containers.
The external CDS applications query CDS through the ABAP SQL service, using
ABAP credentials; direct HANA applications use a separate restricted database
account.

The CDS Jobs are `poller-node-cds` and `poller-rust-cds`, with separate image tags
`sap-polling-node:sql-odbc` and `sap-polling-rust:sql-odbc`.

## Shared correctness contract

All paths read the frozen 5,000 positions and apply the same nine-field
validation, exact decimal normalization, composite-key ordering and canonical
SHA-256. The expected digest is in `contracts/seed-manifest.json`.

Access-specific metrics differ: internal ABAP CDS counts nonempty packages;
ODBC counts logical fetch attempts including the final empty fetch. These
counts and transport timing are not row-validation or hashing differences.

The ODBC runtime uses the shared query `contracts/abap-cds-odbc.sql`. Driver
libraries are supplied through the private `ABAP_ODBC_DRIVER_DIR` setting,
mounted read-only at `/opt/sap/abap-odbc`. Credentials
are supplied at runtime and are never embedded in images or reports.

See the [CDS ODBC setup and verification guide](cds-odbc.md) for deployment and current proof.
