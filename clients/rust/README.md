# Rust poller

The reusable `Scan` core in `src/lib.rs` validates, orders, normalizes and hashes one page at a time. The HTTP CLI adds pooled transport and scan scheduling. SQL adapters and offline fixtures reuse the same row validation and canonical hashing core.

From this folder:

```sh
cargo test --locked
cargo run --locked -- --fixtures ../../contracts/fixtures.json
cargo build --release --locked
docker build -t sap-polling-rust:local .
```

Fixture mode writes one JSON array and exits zero when the fixture file was executed. Expected error cases remain visible in that array. Normal mode writes one JSON object per scan. Its exit code is zero when every scan succeeded, one for a scan failure, or two for invalid configuration.

## Runtime environment

Required: `SAP_SERVICE_ROOT` (absolute service URL ending `/`), `EXPECTED_ROWS`, `EXPECTED_DIGEST` (64 lowercase hex characters). Supply `SAP_USERNAME` and `SAP_PASSWORD` together for HTTP Basic authentication. Omit both for a public local fault server. Do not place real credentials in the image, repository or command history.

| Variable | Default | Valid range |
| --- | --- | --- |
| `SAP_CLIENT` | `001` | Exactly three digits |
| `EXPECTED_ROWS` | Required | 0–2147483647 |
| `SCANS` | 1 | 1–1000000 |
| `POLL_INTERVAL_MS` | 1000 | 1–3600000 |
| `REQUEST_TIMEOUT_SECONDS` | 10 | 1–3600 |
| `SCAN_TIMEOUT_SECONDS` | 120 | 1–86400 |
| `PAGE_SIZE` | 500 | 1–10000 |
| `MAX_BODY_BYTES` | 8388608 | 1–67108864 |
| `MAX_PAGES` | 10000 | 1–1000000 |
| `SAP_TLS_INSECURE` | `false` | `true` or `false` |

Certificates are verified by default. `SAP_TLS_INSECURE=true` is an explicit exception for the local SAP trial with a self-signed certificate; it changes only this client's TLS validation. Use trusted certificates elsewhere.

Transport disables redirects, retries, cookie persistence, automatic decompression and environment proxies. Requests ask for identity encoding and OData decimal strings. A timeout covers the complete response body. No floating point values enter the canonical data or hash. For a service on the Windows host, containers use `host.docker.internal` and its exposed port in `SAP_SERVICE_ROOT`.

URI inputs contain printable ASCII without raw spaces; use percent encoding for spaces or UTF-8 path/query data. The HTTP adapter retains a bounded page buffer and drains oversized responses within the deadline before deciding `LIMIT`, matching ABAP's completed-receive semantics. `TIMEOUT` and `TRANSPORT` always report a null HTTP status.

The [shared contract](../../docs/implementation-contract.md) defines the functional behavior and error precedence. The shared fixture suite checks the same core used by live HTTP. Running the fixtures does not establish parity against an activated SAP service; that also requires the shared live integration checks.

Supported OData JSON uses Unicode scalar values, at most 128 levels of nesting, and no duplicate property names. Unpaired surrogate escapes and deeper JSON are outside the cross-language input contract. Unknown numeric properties are parsed without floating point conversion and ignored.

## Benchmark adapter

Build the same Dockerfile as `sap-polling-rust:benchmark`, then invoke `poller --benchmark --duration-seconds 180 --warmup-scans 5` with the normal service/identity environment. The benchmark uses one Tokio worker and the same live scan core. It keeps the process alive, creates a fresh HTTP client for each scan, reuses its connection across pages, and includes client construction and drop in scan elapsed time.

After five validated warmup scans, complete scans run continuously until at least 180 seconds have elapsed. A scan already started finishes completely. Scan records remain buffered until the measured window ends, followed by a summary containing actual measured wall time. Any failed scan invalidates the block and returns exit code 1. The shared Docker command builder in `../../deploy/benchmark-client.mjs` applies equal client resource limits.

## SQL adapters

`sql-poller` adds a native HANA adapter using the synchronous [`hdbconnect`](https://docs.rs/hdbconnect/0.33.0/hdbconnect/) driver and an ABAP SQL service adapter using [`odbc-api`](https://docs.rs/odbc-api/29.2.0/odbc_api/). The HTTP build remains the default and requires no ODBC libraries. Enable `native-hana`, `abap-odbc`, or both explicitly:

```sh
cargo build --locked --release --features native-hana,abap-odbc --bin sql-poller
cargo test --locked --features native-hana,abap-odbc
docker build -f Dockerfile.sql -t sap-polling-rust:sql .
docker build -f Dockerfile.sql --build-arg SQL_FEATURES=native-hana,abap-odbc -t sap-polling-rust:sql-odbc .
sql-poller --transport hana
sql-poller --transport odbc --benchmark --duration-seconds 180 --warmup-scans 5
```

The default SQL image enables both `native-hana` and `abap-odbc`. Use `--build-arg SQL_FEATURES=native-hana` for a native-only build; ODBC development headers are installed only when that adapter is enabled. The ODBC dependency requests the ODBC 3 API for SAP driver compatibility. For the supported four-image build, runtime aliases and live checks, follow the [installation and run guide](../../docs/requirements-install-run.md). The [final comparison](../../docs/nine-comparison.md) contains the recorded performance and parity evidence.

Both SQL transports require `SQL_QUERY_FILE`, `EXPECTED_ROWS` and `EXPECTED_DIGEST`. The query file is the shared, read-only, ordered SELECT maintained by the benchmark controller. It must return exactly these uppercase column aliases, in this order: `ORDERID,POSITIONNUMBER,CUSTOMERID,ORDERDATE,MATERIALID,QUANTITY,UNIT,NETAMOUNT,CURRENCY`. Cast date and decimal values to strings in SQL: dates use `YYYY-MM-DD`, Quantity has three fractional digits, and NetAmount has two. No floating point conversion is used. Runtime database principals must have SELECT-only privileges.

Native HANA also requires `HANA_SERVER` (`host:port`), `HANA_DATABASE`, `HANA_USER` and `HANA_PASSWORD`. This local lab adapter uses a plain TCP HANA connection. ODBC requires the complete runtime secret `ABAP_ODBC_CONNECTION_STRING` and the ordered CDS projection in `../../contracts/abap-cds-odbc.sql` through `SQL_QUERY_FILE`. The licensed SAP ABAP ODBC driver must be mounted separately at `/opt/sap/abap-odbc`; its full `.so` path can be supplied by `Driver=` in the connection string without a system DSN. `Dockerfile.sql` includes unixODBC; it does not include or download SAP's licensed driver. Mount its supporting libraries and configuration read-only, accessible to container UID 10001. No credentials or connection strings belong in images, source, logs or command history.

SQL scans use the same `Scan::process_row`, normalization, ordering and SHA-256 code as HTTP and the shared fixtures. Both drivers stream at most 100 rows per fetch; native HANA uses fetch size 100 and row iteration, and ODBC binds a reusable 100-row text buffer with truncation detection. The adapter never materializes the complete result set. `pages` counts attempted logical fetch batches, including an empty final fetch for an exact multiple of 100 rows (5,000 rows means 51 pages). `body_bytes` is zero because SQL has no HTTP response body and these drivers do not report comparable wire byte counts. Error HTTP status is always null, and native diagnostic messages are discarded.

Finite SQL mode supports the existing `SCANS`, `POLL_INTERVAL_MS`, `REQUEST_TIMEOUT_SECONDS`, `SCAN_TIMEOUT_SECONDS` and `MAX_PAGES` bounds. `PAGE_SIZE`, if present, must be `100`. SQL benchmark mode uses the same continuous warmup/measurement policy as HTTP. SQL modes reuse one connection across scans to match ABAP ADBC session reuse. The first warmup includes connection setup; measured scans include per-scan native preparation, query/cursor construction, fetch, validation, hashing and cursor/statement cleanup. A failed connection is discarded before finite-mode recovery. SQL benchmark summaries report `client_policy: persistent`, identify `transport` as `hana` or `odbc` and report `fetch_size: 100`.

Native HANA read timeouts are limited by the remaining scan deadline before each batch. ODBC login and statement timeouts are requested from the driver. Both adapters check the scan deadline around driver calls and processing; synchronous native connection setup and ODBC cancellation remain driver/OS dependent, so a stuck driver cannot be claimed to have the HTTP adapter's strict cancellation guarantee. The controller must retain its process/container deadline. Offline fixtures establish canonical row parity; live SQL equality still requires the selected service/view, driver, grants and frozen SAP dataset to be available.
