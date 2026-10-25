# Node.js poller

Requires Node.js 24 or newer. Requests use built-in `fetch`; a pinned Undici
Agent supplies one reusable connection pool and the optional per-client TLS
setting. No global TLS setting is changed. The shared behavior specification
is [the implementation contract](../../docs/implementation-contract.md).

```powershell
npm ci
npm test
node src/cli.mjs --fixtures ../../contracts/fixtures.json
node src/cli.mjs --config local-run.json
```

`--fixtures` prints a JSON array of `{id, ...functionalResult}`. It uses the
same `scan(config, fetcher)` core as live HTTP. A live run prints one scan JSON
object per line; stdout contains no diagnostics. Secrets are never included in
output. Exit codes: 0 when all requested scans succeed, 1 on scan failure,
2 on invalid configuration.

Configuration files contain snake_case names from the shared contract.
Environment settings override the corresponding file values:

| Environment | Configuration field |
| --- | --- |
| SAP_SERVICE_ROOT | service_root |
| SAP_CLIENT | sap_client |
| EXPECTED_ROWS | expected_rows |
| EXPECTED_DIGEST | expected_digest |
| SCANS | scans |
| POLL_INTERVAL_MS | interval_ms |
| REQUEST_TIMEOUT_SECONDS | request_timeout_seconds |
| SCAN_TIMEOUT_SECONDS | scan_timeout_seconds |
| PAGE_SIZE | page_size |
| MAX_BODY_BYTES | max_body_bytes |
| MAX_PAGES | max_pages |
| SAP_TLS_INSECURE | tls_insecure; literal true or false |

Provide `SAP_USERNAME` and `SAP_PASSWORD` together through the environment.
They generate HTTP Basic authorization for the configured service only.
Do not put credentials in configuration files. No credentials are needed for
the local fault-server tests. Plain HTTP is available for the local lab.
HTTPS verifies certificates by default. `SAP_TLS_INSECURE=true` is an explicit
local-trial exception scoped to this client's pool and configured service
origin; use it only with the local trial's self-signed certificate.

The first URL uses the fixed selected fields, ordering, and SAP client; it does
not add `$top`. Cookies and redirects are disabled. Every deadline covers the
complete response body. Scans process one bounded page at a time, compare
ASCII keys across pages, and stream canonical row bytes into SHA-256.

Error locations follow the shared rules: unsafe continuations and cycles
refer to the current page/status; a max_pages failure refers to the unattempted
next page, retaining the actual request count and a null status. A wrong-typed
continuation fails the page schema before row processing. An empty string
continuation fails as NEXTLINK after valid rows are processed.

Build from this directory with `docker build -t sap-polling-node:local .`. Run with
the same environment names; do not bake credentials into the image.

## Benchmark adapter

Build the normal Dockerfile as `sap-polling-node:benchmark`, then invoke `node --v8-pool-size=1 /app/src/benchmark.mjs --duration-seconds 180 --warmup-scans 5` with `UV_THREADPOOL_SIZE=1` and the normal service/identity environment. The shared Docker command builder in `../../deploy/benchmark-client.mjs` supplies equal client CPU/memory limits and passes credentials through environment names.

The process stays alive while each scan creates and closes a fresh HTTP Agent. Connections are reused across pages within that scan. Scan elapsed time includes Agent creation and close. After five validated warmup scans, complete scans run continuously for at least 180 seconds, finishing the scan in flight. Scan records are buffered until the measured window ends; the final summary reports actual measured wall time. Any failed scan invalidates the block and returns exit code 1. Validation, ordering, normalization, paging and checksums use the existing scan core.

## Native HANA and ABAP SQL Service

The optional SQL consumers use SAP's official `@sap/hana-client` 2.30.27 or
the `odbc` 2.6.0 UnixODBC adapter. The HTTP image omits these packages. Install
SQL dependencies with `npm ci --include=optional`; UnixODBC and its development
headers, a C++ compiler, make and Python are required to build `odbc` on Linux.
The ABAP SQL Service additionally needs SAP's ABAP ODBC driver installed or
mounted at runtime. An SAP HANA ODBC driver cannot replace that driver.

```powershell
node src/sql-cli.mjs --transport hana
node src/sql-cli.mjs --transport odbc
npm run start:cds
node src/sql-benchmark.mjs --transport hana --duration-seconds 180 --warmup-scans 5
node src/sql-benchmark.mjs --transport odbc --duration-seconds 180 --warmup-scans 5
```

`--config` accepts the common nonsecret JSON settings. `SQL_TRANSPORT` may supply
`hana` or `odbc` instead of `--transport`. Set `EXPECTED_ROWS` and
`EXPECTED_DIGEST` from the frozen manifest. `SCANS`, `POLL_INTERVAL_MS`,
`REQUEST_TIMEOUT_SECONDS`, `SCAN_TIMEOUT_SECONDS` and `MAX_PAGES` retain their
common bounds and scheduling rules. SQL fetch size is fixed at 100; leave
`PAGE_SIZE` unset or set it to 100. SQL does not use OData body-size settings.

Both transports read the SQL text from `SQL_QUERY_FILE`. Native HANA defaults
to `contracts/native-hana.sql` relative to the repository. The `node-cds`
application (`npm run start:cds`, or `sql-cli.mjs --transport odbc`) requires an
explicit `SQL_QUERY_FILE`; use the shared `contracts/abap-cds-odbc.sql` query,
mounted at `/run/sql-query.sql` in its container. This prevents the CDS client
from accidentally using the native HANA query. Each shared query must return
the nine selected fields as SQL character values with
uppercase aliases (`ORDERID`, `POSITIONNUMBER`, `CUSTOMERID`, `ORDERDATE`,
`MATERIALID`, `QUANTITY`, `UNIT`, `NETAMOUNT`, `CURRENCY`) in canonical order.
The provisioned read-only view supplies client 001 and the query orders by
the composite key. No SQL is constructed from connection settings. Native
Number, Date, null and missing values fail validation; the consumer never
converts them to strings or uses floating point for decimal values.

Supply runtime connection settings through the environment:

| Transport | Required environment |
| --- | --- |
| hana | `HANA_SERVER` (`host:port`), `HANA_DATABASE`, `HANA_USER`, `HANA_PASSWORD` |
| odbc | `ABAP_ODBC_CONNECTION_STRING` (complete secret connection string, including the installed SAP ABAP ODBC driver) |

For `node-cds`, mount the extracted Linux driver directory read-only at
`/opt/sap/abap-odbc` and include its `ODBC_driver_for_ABAP.so` path in the
connection string. Set `LD_LIBRARY_PATH=/opt/sap/abap-odbc` so its companion
libraries can be loaded. The complete connection string supplies SAP's server,
client 001, authentication and crypto configuration; keep it in the runtime
environment. The image already includes UnixODBC. SAP driver files and
credentials are not baked into the image.

The SQL image applies compatibility fixes to pinned `odbc` 2.6.0 and
rebuilds its native addon. Its `node-addon-api` headers are pinned to 8.5.0
because the upstream 3.x headers do not compile with Node.js 24's C++ standard.
Upstream closes every connection with a rollback;
SAP's ABAP driver advertises no transaction support and rejects that call.
The patch checks `SQL_TXN_CAPABLE`, retains rollback for transactional drivers,
and proceeds to `SQLDisconnect` and handle cleanup for this read-only driver.
Cleanup errors still fail the run. HTTP and the existing native HANA image
are unaffected.

The cursor fix also registers each active native fetch with the connection's
cancellation registry. Upstream registers query execution but omits cursor
fetches, so `connection.cancel()` otherwise misses a blocked fetch. The handle
is unregistered immediately after the fetch returns, before processing errors
or rows. Cancellation remains dependent on the SAP driver; this is not a hard
wall-clock deadline during host paging or driver cleanup.

The CLI and benchmark reuse one connection for the run. Each scan opens one
cursor, fetches at most 100 rows per application batch, and closes its cursor
and statement. The connection closes after the run.
ODBC operation, cancellation and cleanup failures retire the connection before
another scan can connect. A transport error or deadline expiry also retires it;
the next scan opens a fresh connection. Healthy scans retain their connection.
Native HANA uses autocommit, with implicit pooling, reconnect and SELECT retry
disabled explicitly. The query guard accepts one SELECT of at most 65536 bytes
and rejects mutating keywords; the database principal still has SELECT-only
grants.
HANA result prefetch is disabled. Its additional native `ResultSet.next()` row
cache uses SAP's standard bounded 128 KiB limit; `nextCanBlock()` selects the
asynchronous API only when needed. Application batches remain capped at 100;
physical fetches and buffers inside each driver may differ.
ODBC uses `cursor: true, fetchSize: 100`. Both call the exact HTTP row
validation, ordering and incremental SHA-256 accumulator. `pages` counts
attempted cursor fetches, including an empty final fetch for an exact multiple
of 100 (5000 rows gives 51). `http_status` is always null and `body_bytes` is
zero because the drivers do not expose wire-byte metrics. Connection/query
failures refer to page 0. Output and exit codes follow the HTTP JSON contract;
driver errors and connection strings are never printed.

The SQL benchmark has the HTTP benchmark's warmup/measured phases. The first
warmup establishes the connection; measured scans reuse it. Scan elapsed time
includes statement preparation, execution, fetches, validation, hashing and
cursor/statement cleanup. Final connection close occurs after the measured
loop. Driver connection/query timeouts and scan deadline checks
request cancellation; actual cancellation and cleanup latency depend on the
native driver. The next scan waits for the previous operation and cleanup to
finish, including after cancellation.

Build SQL support with `docker build -f Dockerfile.sql -t sap-polling-node:sql .`.
Mount the shared query read-only at `/run/sql-query.sql` (the image's default
`SQL_QUERY_FILE`) and mount the installed SAP ABAP ODBC driver and configuration
read-only at the paths named by the runtime connection string. Supply all
connection secrets with environment names. Use the normal single-worker Node
and CPU/memory limits for comparisons; the repository's deployment runner
coordinates those settings.

The adapter APIs follow [SAP's cursor guidance](https://help.sap.com/docs/SAP_HANA_CLIENT/f1b440ded6144a54ada97ff95dac7adf/31a8c93a574b4f8fb6a8366d2c758f21.html),
[SAP's connection properties](https://help.sap.com/docs/SAP_HANA_CLIENT/f1b440ded6144a54ada97ff95dac7adf/4fe9978ebac44f35b9369ef5a4a26f4c.html)
and the [ODBC package's cursor and timeout APIs](https://github.com/IBM/node-odbc).
