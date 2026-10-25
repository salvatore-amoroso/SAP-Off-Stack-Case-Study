//! Opt-in diagnostic adapter. Official SQL/HTTP entrypoints do not call this module.
use super::*;
use crate::PreparedRow;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::HashSet;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Mode {
    Full,
    Control,
    FetchOnly,
    ReplayFull,
    ReplayValidation,
    ReplayHash,
}

impl Mode {
    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "full" => Some(Self::Full),
            "control" => Some(Self::Control),
            "fetch-only" => Some(Self::FetchOnly),
            "replay-full" => Some(Self::ReplayFull),
            "replay-validation" => Some(Self::ReplayValidation),
            "replay-hash" => Some(Self::ReplayHash),
            _ => None,
        }
    }

    pub fn name(self) -> &'static str {
        match self {
            Self::Full => "full",
            Self::Control => "control",
            Self::FetchOnly => "fetch-only",
            Self::ReplayFull => "replay-full",
            Self::ReplayValidation => "replay-validation",
            Self::ReplayHash => "replay-hash",
        }
    }

    pub fn replay(self) -> bool {
        matches!(self, Self::ReplayFull | Self::ReplayValidation | Self::ReplayHash)
    }
}

#[derive(Default, Serialize)]
pub struct Timings {
    pub database_ms: f64,
    pub validation_ms: f64,
    pub hashing_ms: f64,
    pub cleanup_ms: f64,
    pub residual_ms: f64,
    pub total_ms: f64,
}

impl Timings {
    fn finish(&mut self, started: Instant) {
        self.total_ms = milliseconds(started.elapsed());
        self.residual_ms = self.total_ms
            - self.database_ms - self.validation_ms - self.hashing_ms - self.cleanup_ms;
    }
}

pub struct ProfileResult {
    pub result: ScanResult,
    pub timings: Timings,
}

fn milliseconds(duration: Duration) -> f64 {
    duration.as_secs_f64() * 1000.0
}

fn timed<T>(destination: &mut f64, operation: impl FnOnce() -> T) -> T {
    let started = Instant::now();
    let result = operation();
    *destination += milliseconds(started.elapsed());
    result
}

fn new_scan(config: Config, timings: &mut Timings) -> Result<Scan, ScanError> {
    let root = config.validate()?;
    let hash = timed(&mut timings.hashing_ms, || {
        let mut hash = Sha256::new();
        hash.update(b"sap-polling-lab\t1\n");
        hash
    });
    Ok(Scan {
        config, root, hash, last_key: None, visited: HashSet::new(),
        rows: 0, pages: 0, body_bytes: 0, start: Instant::now(),
    })
}

fn contract_object(fields: Vec<String>) -> Value {
    Value::Object(FIELDS.iter().zip(fields)
        .map(|(field, value)| ((*field).into(), Value::String(value))).collect())
}

fn process_profiled(scan: &mut Scan, fields: Vec<String>, timings: &mut Timings) -> Result<(), ScanError> {
    let prepared = timed(&mut timings.validation_ms, || {
        if fields.len() != FIELDS.len() {
            return Err(scan.failure("SCHEMA", None));
        }
        scan.prepare_row(&contract_object(fields), None)
    })?;
    timed(&mut timings.hashing_ms, || scan.hash_prepared_row(&prepared));
    scan.accept_prepared_row(prepared);
    Ok(())
}

fn finish_scan(scan: Scan, index: u64, error: Option<ScanError>, timings: &mut Timings, hash: bool) -> ScanResult {
    let error = error.or_else(|| scan.check_deadline(None).err());
    let digest = if hash {
        timed(&mut timings.hashing_ms, || scan.finalized_digest())
    } else {
        scan.config.expected_digest.clone()
    };
    let mut result = scan.finish_from_digest(index, error, digest);
    if !hash { result.digest = None; }
    if let Some(error) = &mut result.error { error.http_status = None; }
    result
}

pub fn live(config: &SqlConfig, client: &mut SqlClient, index: u64, mode: Mode) -> ProfileResult {
    let started = Instant::now();
    let mut timings = Timings::default();
    if mode == Mode::Control {
        let result = live_scan(config, client, index);
        timings.finish(started);
        return ProfileResult { result, timings };
    }
    let mut scan = new_scan(config.core.clone(), &mut timings).expect("validated SQL config");
    let error = hana(config, client, &mut scan, &mut timings, mode).err();
    let mut result = finish_scan(scan, index, error, &mut timings, mode != Mode::FetchOnly);
    if result.error.as_ref().is_some_and(|error| matches!(error.code.as_str(), "TRANSPORT" | "TIMEOUT")) {
        client.hana = None;
    }
    timings.finish(started);
    result.metrics.elapsed_ms = started.elapsed().as_millis();
    ProfileResult { result, timings }
}

fn hana(config: &SqlConfig, client: &mut SqlClient, scan: &mut Scan, timings: &mut Timings, mode: Mode) -> Result<(), ScanError> {
    use hdbconnect::{ConnectParams, Connection, ConnectionConfiguration, HdbValue};
    if client.hana.is_none() {
        client.hana = Some(timed(&mut timings.database_ms, || {
            let settings = config.hana.as_ref().expect("validated HANA settings");
            let params = ConnectParams::builder().hostname(&settings.host).port(settings.port)
                .dbname(&settings.database).dbuser(&settings.user).password(&settings.password)
                .build().map_err(|_| scan.failure("CONFIG", None))?;
            let options = ConnectionConfiguration::default().with_auto_commit(true)
                .with_fetch_size(FETCH_SIZE as u32).with_read_timeout(Some(Duration::from_secs(
                    config.core.request_timeout_seconds.min(config.core.scan_timeout_seconds))));
            Connection::with_configuration(params, &options).map_err(|error| driver_error(scan, &error))
        })?);
    }
    let connection = client.hana.as_ref().expect("connected HANA client");
    scan.check_deadline(None)?;
    let mut statement = timed(&mut timings.database_ms, || {
        connection.set_read_timeout(Some(scan.remaining().unwrap_or_default()
            .min(Duration::from_secs(config.core.request_timeout_seconds))))
            .map_err(|error| driver_error(scan, &error))?;
        connection.prepare(config.query.trim().trim_end_matches(';'))
            .map_err(|error| driver_error(scan, &error))
    })?;
    scan.check_deadline(None)?;
    let mut cursor = timed(&mut timings.database_ms, || {
        connection.set_read_timeout(Some(scan.remaining().unwrap_or_default()
            .min(Duration::from_secs(config.core.request_timeout_seconds))))
            .map_err(|error| driver_error(scan, &error))?;
        let cursor = statement.execute(&()).and_then(|response| response.into_result_set())
            .map_err(|error| driver_error(scan, &error))?;
        let metadata = cursor.metadata();
        if metadata.len() != COLUMNS.len() || metadata.iter().zip(COLUMNS)
            .any(|(field, name)| field.displayname() != name) {
            return Err(scan.failure("SCHEMA", None));
        }
        Ok(cursor)
    })?;
    'batches: loop {
        scan.check_deadline(None)?;
        begin_batch(scan, config.core.max_pages)?;
        timed(&mut timings.database_ms, || connection.set_read_timeout(Some(scan.remaining()
            .unwrap_or_default().min(Duration::from_secs(config.core.request_timeout_seconds)))))
            .map_err(|error| driver_error(scan, &error))?;
        for _ in 0..FETCH_SIZE {
            let fields = timed(&mut timings.database_ms, || {
                let Some(mut row) = cursor.next_row().map_err(|error| driver_error(scan, &error))? else {
                    return Ok(None);
                };
                let mut fields = Vec::with_capacity(FIELDS.len());
                for _ in FIELDS {
                    match row.next_value() {
                        Some(HdbValue::STRING(value)) => fields.push(value),
                        _ => return Err(scan.failure("SCHEMA", None)),
                    }
                }
                Ok(Some(fields))
            })?;
            let Some(fields) = fields else { break 'batches; };
            if mode == Mode::FetchOnly {
                timed(&mut timings.database_ms, || { drop(fields); scan.rows += 1; });
            } else {
                process_profiled(scan, fields, timings)?;
            }
        }
    }
    timed(&mut timings.cleanup_ms, || { drop(cursor); drop(statement); });
    scan.check_deadline(None)
}

#[derive(Deserialize)]
struct Capture {
    schema_version: u8,
    rows: Vec<std::collections::BTreeMap<String, String>>,
    expected_rows: u64,
    expected_digest: String,
    query_sha256: String,
}

pub struct Replay {
    rows: Vec<Vec<String>>,
    prepared: Vec<PreparedRow>,
    pub digest: String,
    pub query_sha256: String,
}

impl Replay {
    pub fn load(path: &str, config: &SqlConfig) -> Result<Self, ()> {
        let bytes = fs::read(path).map_err(|_| ())?;
        if bytes.len() > 16 * 1024 * 1024 { return Err(()); }
        let capture: Capture = serde_json::from_slice(&bytes).map_err(|_| ())?;
        if capture.schema_version != 1 || capture.expected_rows != config.core.expected_rows
            || capture.expected_digest != config.core.expected_digest
            || capture.rows.len() as u64 != capture.expected_rows
            || capture.query_sha256 != format!("{:x}", Sha256::digest(config.query.as_bytes())) {
            return Err(());
        }
        let mut rows = Vec::with_capacity(capture.rows.len());
        let mut prepared = Vec::with_capacity(capture.rows.len());
        let mut gate = Scan::new(config.core.clone()).map_err(|_| ())?;
        for raw in capture.rows {
            if raw.len() != COLUMNS.len() { return Err(()); }
            let fields = COLUMNS.iter().map(|column| raw.get(*column).cloned())
                .collect::<Option<Vec<_>>>().ok_or(())?;
            let value = contract_object(fields.clone());
            let row = gate.prepare_row(&value, None).map_err(|_| ())?;
            prepared.push(PreparedRow { fields: row.fields.clone(), key: row.key.clone() });
            gate.hash_prepared_row(&row);
            gate.accept_prepared_row(row);
            rows.push(fields);
        }
        let result = gate.finish(0, None);
        if result.outcome != "ok" { return Err(()); }
        Ok(Self { rows, prepared, digest: result.digest.ok_or(())?, query_sha256: capture.query_sha256 })
    }

    pub fn scan(&self, config: &SqlConfig, index: u64, mode: Mode) -> ProfileResult {
        let started = Instant::now();
        let mut timings = Timings::default();
        let mut scan = new_scan(config.core.clone(), &mut timings).expect("validated replay config");
        let error = (|| {
            match mode {
                Mode::ReplayHash => {
                    timed(&mut timings.hashing_ms, || {
                        for row in &self.prepared { scan.hash_prepared_row(row); }
                    });
                    scan.rows = self.rows.len() as u64;
                }
                Mode::ReplayFull | Mode::ReplayValidation => {
                    // Replay clones captured input strings; live HANA owns its newly decoded strings.
                    for fields in &self.rows {
                        let row = timed(&mut timings.validation_ms, || {
                            scan.prepare_row(&contract_object(fields.clone()), None)
                        })?;
                        if mode == Mode::ReplayFull {
                            timed(&mut timings.hashing_ms, || scan.hash_prepared_row(&row));
                        }
                        scan.accept_prepared_row(row);
                    }
                }
                _ => return Err(scan.failure("CONFIG", None)),
            }
            scan.pages = self.rows.len() / FETCH_SIZE + 1;
            Ok(())
        })().err();
        let result = finish_scan(scan, index, error, &mut timings, mode != Mode::ReplayValidation);
        if mode == Mode::ReplayValidation { timings.hashing_ms = 0.0; }
        timings.finish(started);
        ProfileResult { result, timings }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn profile_row_uses_shared_core_and_exclusive_phases() {
        let manifest: Value = serde_json::from_str(include_str!("../../../../contracts/seed-manifest.json")).unwrap();
        let config = Config { service_root: "http://sql.invalid/".into(), expected_rows: 5000,
            expected_digest: manifest["expected_digest"].as_str().unwrap().into(), ..Config::default() };
        let started = Instant::now();
        let mut timing = Timings::default();
        let mut scan = new_scan(config.clone(), &mut timing).unwrap();
        for order in 1..=1000 {
            for position in 1..=5 {
                if scan.rows % FETCH_SIZE as u64 == 0 { begin_batch(&mut scan, 10_000).unwrap(); }
                process_profiled(&mut scan, vec![format!("{order:020}"), format!("{:06}", position * 10),
                    format!("C{order:09}"), "2026-01-01".into(), format!("M{position:017}"),
                    format!("{position}.000"), "EA".into(), format!("{}.00", order + position), "CHF".into()],
                    &mut timing).unwrap();
            }
        }
        begin_batch(&mut scan, 10_000).unwrap();
        let result = finish_scan(scan, 0, None, &mut timing, true);
        timing.finish(started);
        assert_eq!(result.outcome, "ok");
        assert_eq!(result.pages, 51);
        assert_eq!(result.digest.as_deref(), Some(config.expected_digest.as_str()));
        assert!(timing.validation_ms > 0.0 && timing.hashing_ms > 0.0 && timing.residual_ms >= 0.0);
        assert!((timing.total_ms - timing.validation_ms - timing.hashing_ms - timing.residual_ms).abs() < 0.000001);
    }

    #[test]
    fn replay_modes_gate_the_same_capture_and_keep_hash_omission_explicit() {
        let manifest: Value = serde_json::from_str(include_str!("../../../../contracts/seed-manifest.json")).unwrap();
        let core = Config { service_root: "http://sql.invalid/".into(), expected_rows: 5000,
            expected_digest: manifest["expected_digest"].as_str().unwrap().into(), ..Config::default() };
        let config = SqlConfig { core, transport: Transport::Hana,
            query: include_str!("../../../../contracts/native-hana.sql").into(), hana: None, odbc: None };
        let rows = (1..=1000).flat_map(|order| (1..=5).map(move |position| {
            COLUMNS.into_iter().zip([format!("{order:020}"), format!("{:06}", position * 10),
                format!("C{order:09}"), "2026-01-01".into(), format!("M{position:017}"),
                format!("{position}.000"), "EA".into(), format!("{}.00", order + position), "CHF".into()])
                .collect::<std::collections::BTreeMap<_, _>>()
        })).collect::<Vec<_>>();
        let mut capture = serde_json::json!({ "schema_version":1, "rows":rows,
            "expected_rows":config.core.expected_rows, "expected_digest":config.core.expected_digest,
            "query_sha256":format!("{:x}", Sha256::digest(config.query.as_bytes())) });
        let path = std::env::temp_dir().join(format!("sap-profile-replay-{}.json", std::process::id()));
        fs::write(&path, serde_json::to_vec(&capture).unwrap()).unwrap();
        let replay = Replay::load(path.to_str().unwrap(), &config).unwrap();
        for mode in [Mode::ReplayFull, Mode::ReplayValidation, Mode::ReplayHash] {
            let actual = replay.scan(&config, 0, mode);
            assert_eq!(actual.result.outcome, "ok");
            assert_eq!(actual.result.rows, 5000);
            assert_eq!(actual.result.pages, 51);
            assert_eq!(actual.timings.database_ms, 0.0);
            if mode == Mode::ReplayValidation {
                assert_eq!(actual.result.digest, None);
                assert_eq!(actual.timings.hashing_ms, 0.0);
            } else { assert_eq!(actual.result.digest.as_deref(), Some(config.core.expected_digest.as_str())); }
        }
        capture["rows"][0]["QUANTITY"] = Value::String("1.0000".into());
        fs::write(&path, serde_json::to_vec(&capture).unwrap()).unwrap();
        assert!(Replay::load(path.to_str().unwrap(), &config).is_err());
        fs::remove_file(path).unwrap();
    }
}
