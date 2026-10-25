use crate::{Config, Scan, ScanError, ScanResult, FIELDS};
use serde_json::{Map, Value};
use std::{
    env, fs,
    time::{Duration, Instant},
};

#[cfg(feature = "native-hana")]
pub mod profile;

pub const FETCH_SIZE: usize = 100;
const COLUMNS: [&str; 9] = [
    "ORDERID",
    "POSITIONNUMBER",
    "CUSTOMERID",
    "ORDERDATE",
    "MATERIALID",
    "QUANTITY",
    "UNIT",
    "NETAMOUNT",
    "CURRENCY",
];

#[derive(Clone, Copy, PartialEq, Eq)]
pub enum Transport {
    Hana,
    Odbc,
}

impl Transport {
    pub fn name(self) -> &'static str {
        match self {
            Self::Hana => "hana",
            Self::Odbc => "odbc",
        }
    }
}

struct HanaSettings {
    host: String,
    port: u16,
    database: String,
    user: String,
    password: String,
}

// Deliberately no Debug: connection parameters are runtime secrets.
pub struct SqlConfig {
    pub core: Config,
    pub transport: Transport,
    query: String,
    hana: Option<HanaSettings>,
    odbc: Option<String>,
}

#[derive(Default)]
pub struct SqlClient {
    #[cfg(feature = "native-hana")]
    hana: Option<hdbconnect::Connection>,
    #[cfg(feature = "abap-odbc")]
    odbc: Option<odbc_api::Connection<'static>>,
}

fn required(name: &str) -> Result<String, ()> {
    env::var(name)
        .ok()
        .filter(|value| !value.is_empty())
        .ok_or(())
}

fn number(name: &str, fallback: u64) -> Result<u64, ()> {
    match env::var(name) {
        Err(env::VarError::NotPresent) => Ok(fallback),
        Ok(value) if !value.is_empty() && value.bytes().all(|byte| byte.is_ascii_digit()) => {
            value.parse().map_err(|_| ())
        }
        _ => Err(()),
    }
}

impl SqlConfig {
    pub fn environment(transport: Transport) -> Result<Self, ()> {
        if (transport == Transport::Hana && !cfg!(feature = "native-hana"))
            || (transport == Transport::Odbc && !cfg!(feature = "abap-odbc"))
        {
            return Err(());
        }
        let defaults = Config::default();
        if number("PAGE_SIZE", FETCH_SIZE as u64)? != FETCH_SIZE as u64 {
            return Err(());
        }
        let core = Config {
            service_root: "http://sql.invalid/".into(),
            expected_rows: number("EXPECTED_ROWS", u64::MAX)?,
            expected_digest: required("EXPECTED_DIGEST")?,
            scans: number("SCANS", defaults.scans)?,
            interval_ms: number("POLL_INTERVAL_MS", defaults.interval_ms)?,
            request_timeout_seconds: number(
                "REQUEST_TIMEOUT_SECONDS",
                defaults.request_timeout_seconds,
            )?,
            scan_timeout_seconds: number("SCAN_TIMEOUT_SECONDS", defaults.scan_timeout_seconds)?,
            page_size: FETCH_SIZE as u64,
            max_pages: number("MAX_PAGES", defaults.max_pages as u64)?
                .try_into()
                .map_err(|_| ())?,
            ..defaults
        };
        core.validate().map_err(|_| ())?;
        let path = required("SQL_QUERY_FILE")?;
        let query = fs::read_to_string(path).map_err(|_| ())?;
        if !read_only_query(&query) {
            return Err(());
        }
        let hana = if transport == Transport::Hana {
            let server = required("HANA_SERVER")?;
            let (host, port) = server.rsplit_once(':').ok_or(())?;
            let host = host.trim_start_matches('[').trim_end_matches(']');
            if host.is_empty()
                || host.contains(['/', '@', '?', '#'])
                || host.chars().any(char::is_whitespace)
                || port.is_empty()
                || !port.bytes().all(|byte| byte.is_ascii_digit())
            {
                return Err(());
            }
            let port = port
                .parse::<u16>()
                .ok()
                .filter(|port| *port > 0)
                .ok_or(())?;
            Some(HanaSettings {
                host: host.into(),
                port,
                database: required("HANA_DATABASE")?,
                user: required("HANA_USER")?,
                password: required("HANA_PASSWORD")?,
            })
        } else {
            None
        };
        let odbc = if transport == Transport::Odbc {
            Some(required("ABAP_ODBC_CONNECTION_STRING")?)
        } else {
            None
        };
        Ok(Self {
            core,
            transport,
            query,
            hana,
            odbc,
        })
    }
}

fn read_only_query(query: &str) -> bool {
    // The operator supplies the shared SELECT, and the database principal must have SELECT-only grants.
    let query = query.trim();
    let query = query.strip_suffix(';').unwrap_or(query).trim_end();
    query.len() <= 65_536
        && query
            .get(..6)
            .is_some_and(|prefix| prefix.eq_ignore_ascii_case("SELECT"))
        && query.as_bytes().get(6).is_some_and(u8::is_ascii_whitespace)
        && !query.contains(';')
        && !query
            .split(|c: char| !c.is_ascii_alphanumeric() && c != '_')
            .any(|word| {
                [
                    "INTO", "INSERT", "UPDATE", "DELETE", "UPSERT", "CREATE", "DROP", "ALTER",
                    "CALL", "MERGE",
                ]
                .iter()
                .any(|keyword| word.eq_ignore_ascii_case(keyword))
            })
}

fn begin_batch(scan: &mut Scan, max_pages: usize) -> Result<(), ScanError> {
    scan.check_deadline(None)?;
    if scan.pages >= max_pages {
        return Err(ScanError::new("LIMIT", scan.pages + 1, None));
    }
    scan.pages += 1;
    Ok(())
}

fn process_strings(scan: &mut Scan, fields: Vec<String>) -> Result<(), ScanError> {
    if fields.len() != FIELDS.len() {
        return Err(scan.failure("SCHEMA", None));
    }
    let row: Map<String, Value> = FIELDS
        .iter()
        .zip(fields)
        .map(|(name, value)| ((*name).into(), Value::String(value)))
        .collect();
    scan.process_row(&Value::Object(row), None)
}

fn driver_error(scan: &Scan, error: &(dyn std::error::Error + 'static)) -> ScanError {
    let mut cause = Some(error);
    while let Some(error) = cause {
        #[cfg(feature = "native-hana")]
        if error
            .downcast_ref::<hdbconnect::HdbError>()
            .and_then(hdbconnect::HdbError::server_error)
            .is_some_and(|error| error.code() == 613)
        {
            return scan.failure("TIMEOUT", None);
        }
        #[cfg(feature = "abap-odbc")]
        if let Some(odbc_api::Error::Diagnostics { record, .. }) =
            error.downcast_ref::<odbc_api::Error>()
        {
            if matches!(record.state.as_str(), "HYT00" | "HYT01") {
                return scan.failure("TIMEOUT", None);
            }
            if record.state.as_str() == "01004" {
                return scan.failure("SCHEMA", None);
            }
        }
        #[cfg(feature = "abap-odbc")]
        if matches!(
            error.downcast_ref::<odbc_api::Error>(),
            Some(odbc_api::Error::TooLargeValueForBuffer { .. })
        ) {
            return scan.failure("SCHEMA", None);
        }
        if error.downcast_ref::<std::io::Error>().is_some_and(|error| {
            matches!(
                error.kind(),
                std::io::ErrorKind::TimedOut | std::io::ErrorKind::WouldBlock
            )
        }) {
            return scan.failure("TIMEOUT", None);
        }
        cause = error.source();
    }
    scan.check_deadline(None)
        .err()
        .unwrap_or_else(|| scan.failure("TRANSPORT", None))
}

pub fn live_scan(config: &SqlConfig, client: &mut SqlClient, index: u64) -> ScanResult {
    let started = Instant::now();
    let mut scan = Scan::new(config.core.clone()).expect("validated SQL config");
    let error = match config.transport {
        #[cfg(feature = "native-hana")]
        Transport::Hana => hana_scan(config, client, &mut scan).err(),
        #[cfg(feature = "abap-odbc")]
        Transport::Odbc => odbc_scan(config, client, &mut scan).err(),
        #[allow(unreachable_patterns)]
        _ => Some(scan.failure("CONFIG", None)),
    };
    let mut result = scan.finish(index, error);
    if let Some(error) = &mut result.error {
        error.http_status = None;
    }
    if result
        .error
        .as_ref()
        .is_some_and(|error| matches!(error.code.as_str(), "TRANSPORT" | "TIMEOUT"))
    {
        #[cfg(feature = "native-hana")]
        {
            client.hana = None;
        }
        #[cfg(feature = "abap-odbc")]
        {
            client.odbc = None;
        }
    }
    result.metrics.elapsed_ms = started.elapsed().as_millis();
    result
}

#[cfg(feature = "native-hana")]
fn hana_scan(config: &SqlConfig, client: &mut SqlClient, scan: &mut Scan) -> Result<(), ScanError> {
    use hdbconnect::{ConnectParams, Connection, ConnectionConfiguration, HdbValue};
    if client.hana.is_none() {
        let settings = config.hana.as_ref().expect("validated HANA settings");
        let params = ConnectParams::builder()
            .hostname(&settings.host)
            .port(settings.port)
            .dbname(&settings.database)
            .dbuser(&settings.user)
            .password(&settings.password)
            .build()
            .map_err(|_| scan.failure("CONFIG", None))?;
        let options = ConnectionConfiguration::default()
            // hdbconnect retries repeatable I/O failures only with auto-commit disabled.
            .with_auto_commit(true)
            .with_fetch_size(FETCH_SIZE as u32)
            .with_read_timeout(Some(Duration::from_secs(
                config
                    .core
                    .request_timeout_seconds
                    .min(config.core.scan_timeout_seconds),
            )));
        client.hana = Some(
            Connection::with_configuration(params, &options)
                .map_err(|error| driver_error(scan, &error))?,
        );
    }
    let connection = client.hana.as_ref().expect("connected HANA client");
    scan.check_deadline(None)?;
    connection
        .set_read_timeout(Some(
            scan.remaining()
                .unwrap_or_default()
                .min(Duration::from_secs(config.core.request_timeout_seconds)),
        ))
        .map_err(|error| driver_error(scan, &error))?;
    let mut statement = connection
        .prepare(config.query.trim().trim_end_matches(';'))
        .map_err(|error| driver_error(scan, &error))?;
    scan.check_deadline(None)?;
    connection
        .set_read_timeout(Some(
            scan.remaining()
                .unwrap_or_default()
                .min(Duration::from_secs(config.core.request_timeout_seconds)),
        ))
        .map_err(|error| driver_error(scan, &error))?;
    let mut cursor = statement
        .execute(&())
        .and_then(|response| response.into_result_set())
        .map_err(|error| driver_error(scan, &error))?;
    let metadata = cursor.metadata();
    if metadata.len() != COLUMNS.len()
        || metadata
            .iter()
            .zip(COLUMNS)
            .any(|(field, name)| field.displayname() != name)
    {
        return Err(scan.failure("SCHEMA", None));
    }
    'batches: loop {
        scan.check_deadline(None)?;
        begin_batch(scan, config.core.max_pages)?;
        connection
            .set_read_timeout(Some(
                scan.remaining()
                    .unwrap_or_default()
                    .min(Duration::from_secs(config.core.request_timeout_seconds)),
            ))
            .map_err(|error| driver_error(scan, &error))?;
        for _ in 0..FETCH_SIZE {
            let Some(mut row) = cursor
                .next_row()
                .map_err(|error| driver_error(scan, &error))?
            else {
                break 'batches;
            };
            let mut fields = Vec::with_capacity(FIELDS.len());
            for _ in FIELDS {
                match row.next_value() {
                    Some(HdbValue::STRING(value)) => fields.push(value),
                    _ => return Err(scan.failure("SCHEMA", None)),
                }
            }
            process_strings(scan, fields)?;
        }
    }
    drop(cursor);
    drop(statement);
    scan.check_deadline(None)
}

#[cfg(feature = "abap-odbc")]
fn odbc_scan(config: &SqlConfig, client: &mut SqlClient, scan: &mut Scan) -> Result<(), ScanError> {
    use odbc_api::{buffers::TextRowSet, ConnectionOptions, Cursor, DataType, ResultSetMetadata};
    if client.odbc.is_none() {
        let environment = odbc_api::environment().map_err(|error| driver_error(scan, &error))?;
        let options = ConnectionOptions {
            login_timeout_sec: Some(config.core.request_timeout_seconds as u32),
            ..ConnectionOptions::default()
        };
        client.odbc = Some(
            environment
                .connect_with_connection_string(
                    config.odbc.as_ref().expect("validated ODBC settings"),
                    options,
                )
                .map_err(|error| driver_error(scan, &error))?,
        );
    }
    let connection = client.odbc.as_ref().expect("connected ODBC client");
    scan.check_deadline(None)?;
    let timeout = Some(
        config
            .core
            .request_timeout_seconds
            .min(scan.remaining().unwrap_or_default().as_secs().max(1)) as usize,
    );
    let mut cursor = connection
        .execute(config.query.trim().trim_end_matches(';'), (), timeout)
        .map_err(|error| driver_error(scan, &error))?
        .ok_or_else(|| scan.failure("SCHEMA", None))?;
    let names = cursor
        .column_names()
        .map_err(|error| driver_error(scan, &error))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| driver_error(scan, &error))?;
    if names != COLUMNS {
        return Err(scan.failure("SCHEMA", None));
    }
    for column in 1..=FIELDS.len() {
        let data_type = cursor
            .col_data_type(column as u16)
            .map_err(|error| driver_error(scan, &error))?;
        if !matches!(
            data_type,
            DataType::Char { .. }
                | DataType::WChar { .. }
                | DataType::Varchar { .. }
                | DataType::WVarchar { .. }
                | DataType::LongVarchar { .. }
                | DataType::WLongVarchar { .. }
        ) {
            return Err(scan.failure("SCHEMA", None));
        }
    }
    let buffer = TextRowSet::from_max_str_lens(FETCH_SIZE, [64; 9])
        .map_err(|_| scan.failure("LIMIT", None))?;
    let mut cursor = cursor
        .bind_buffer(buffer)
        .map_err(|error| driver_error(scan, &error))?;
    loop {
        scan.check_deadline(None)?;
        begin_batch(scan, config.core.max_pages)?;
        let Some(batch) = cursor
            .fetch_with_truncation_check(true)
            .map_err(|error| driver_error(scan, &error))?
        else {
            break;
        };
        for row in 0..batch.num_rows() {
            let fields = (0..FIELDS.len())
                .map(|column| {
                    batch
                        .at(column, row)
                        .and_then(|bytes| std::str::from_utf8(bytes).ok())
                        .map(str::to_owned)
                })
                .collect::<Option<Vec<_>>>()
                .ok_or_else(|| scan.failure("SCHEMA", None))?;
            process_strings(scan, fields)?;
        }
        if batch.num_rows() < FETCH_SIZE {
            break;
        }
    }
    drop(cursor);
    scan.check_deadline(None)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn all_http_fixtures_keep_their_expected_functional_results() {
        let fixtures: Value = serde_json::from_str(include_str!("../../../contracts/fixtures.json")).unwrap();
        for case in fixtures["cases"].as_array().unwrap() {
            let fixture = serde_json::from_value(case.clone()).unwrap();
            let actual = serde_json::to_value(crate::run_fixture(fixture).result).unwrap();
            for (field, expected) in case["expected"].as_object().unwrap() {
                assert_eq!(&actual[field], expected, "{}: {field}", case["id"].as_str().unwrap());
            }
        }
    }

    #[test]
    fn sql_rows_reuse_every_contract_fixture_row_and_digest() {
        let fixtures: crate::FixtureFile =
            serde_json::from_str(include_str!("../../../contracts/fixtures.json")).unwrap();
        let mut checked = 0;
        for case in fixtures.cases {
            let Ok(mut sql) = Scan::new(case.config.clone()) else {
                continue;
            };
            let mut error = None;
            let mut eligible = true;
            for page in &case.pages {
                let Ok(value) = serde_json::from_str::<Value>(&page.body_json) else {
                    eligible = false;
                    break;
                };
                let Some(rows) = value.get("value").and_then(Value::as_array) else {
                    eligible = false;
                    break;
                };
                if page.status != 200
                    || value
                        .get("@odata.nextLink")
                        .is_some_and(|link| !link.is_string() || link.as_str() == Some(""))
                {
                    eligible = false;
                    break;
                }
                for row in rows {
                    if let Err(failure) = sql.process_row(row, None) {
                        error = Some(failure);
                        break;
                    }
                }
                if error.is_some() {
                    break;
                }
            }
            if !eligible {
                continue;
            }
            let result = sql.finish(0, error);
            let http = crate::run_fixture(case).result;
            if !matches!(
                http.error.as_ref().map(|error| error.code.as_str()),
                None | Some("SCHEMA" | "ORDER" | "COUNT" | "DIGEST")
            ) {
                continue;
            }
            assert_eq!(result.rows, http.rows);
            assert_eq!(result.digest, http.digest);
            assert_eq!(
                result.error.map(|error| error.code),
                http.error.map(|error| error.code)
            );
            checked += 1;
        }
        assert!(checked >= 10, "must exercise actual shared row fixtures");
    }

    #[test]
    fn frozen_seed_streams_through_sql_mapping_in_100_row_batches() {
        let manifest: Value =
            serde_json::from_str(include_str!("../../../contracts/seed-manifest.json")).unwrap();
        let config = Config {
            service_root: "http://sql.invalid/".into(),
            expected_rows: manifest["expected_rows"].as_u64().unwrap(),
            expected_digest: manifest["expected_digest"].as_str().unwrap().into(),
            ..Config::default()
        };
        let mut scan = Scan::new(config).unwrap();
        for order in 1..=1000 {
            for position in 1..=5 {
                if scan.rows % FETCH_SIZE as u64 == 0 {
                    begin_batch(&mut scan, 10_000).unwrap();
                }
                process_strings(
                    &mut scan,
                    vec![
                        format!("{order:020}"),
                        format!("{:06}", position * 10),
                        format!("C{order:09}"),
                        "2026-01-01".into(),
                        format!("M{position:017}"),
                        format!("{position}.000"),
                        "EA".into(),
                        format!("{}.00", order + position),
                        "CHF".into(),
                    ],
                )
                .unwrap();
            }
        }
        begin_batch(&mut scan, 10_000).unwrap();
        let result = scan.finish(0, None);
        assert_eq!(result.outcome, "ok");
        assert_eq!(result.rows, 5000);
        assert_eq!(result.pages, 51);
        assert_eq!(result.metrics.body_bytes, 0);
    }

    #[test]
    fn driver_error_messages_are_not_exposed() {
        let scan = Scan::new(Config {
            service_root: "http://sql.invalid/".into(),
            expected_rows: 0,
            expected_digest: "0".repeat(64),
            ..Config::default()
        })
        .unwrap();
        let timeout = driver_error(
            &scan,
            &std::io::Error::new(std::io::ErrorKind::TimedOut, "secret connection data"),
        );
        assert_eq!(timeout.code, "TIMEOUT");
        assert_eq!(timeout.http_status, None);
        let transport = driver_error(&scan, &std::io::Error::other("secret connection data"));
        assert_eq!(transport.code, "TRANSPORT");
        assert!(!serde_json::to_string(&transport)
            .unwrap()
            .contains("secret"));
        #[cfg(feature = "abap-odbc")]
        assert_eq!(
            driver_error(
                &scan,
                &odbc_api::Error::TooLargeValueForBuffer {
                    indicator: Some(200),
                    buffer_index: 0
                }
            )
            .code,
            "SCHEMA"
        );
    }

    #[test]
    fn reject_mutating_or_multiple_statements() {
        assert!(read_only_query(include_str!(
            "../../../contracts/native-hana.sql"
        )));
        assert!(read_only_query("SELECT A FROM V ORDER BY A;\n"));
        for query in [
            "DELETE FROM V",
            "SELECT A FROM V; DROP TABLE V",
            "SELECT A INTO V FROM X",
            "SELECTOR",
            "SELECT A FROM V;;",
        ] {
            assert!(!read_only_query(query));
        }
    }
}
