use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::{collections::HashSet, time::Instant};
use url::Url;

#[cfg(feature = "sql")]
pub mod sql;

const FIELDS: [&str; 9] = [
    "OrderId",
    "PositionNumber",
    "CustomerId",
    "OrderDate",
    "MaterialId",
    "Quantity",
    "Unit",
    "NetAmount",
    "Currency",
];
const SELECT: &str =
    "OrderId,PositionNumber,CustomerId,OrderDate,MaterialId,Quantity,Unit,NetAmount,Currency";

#[derive(Clone, Debug)]
pub struct Config {
    pub service_root: String,
    pub sap_client: String,
    pub expected_rows: u64,
    pub expected_digest: String,
    pub scans: u64,
    pub interval_ms: u64,
    pub request_timeout_seconds: u64,
    pub scan_timeout_seconds: u64,
    pub page_size: u64,
    pub max_body_bytes: usize,
    pub max_pages: usize,
}

impl Default for Config {
    fn default() -> Self {
        Self {
            service_root: String::new(),
            sap_client: "001".into(),
            expected_rows: u64::MAX,
            expected_digest: String::new(),
            scans: 1,
            interval_ms: 1000,
            request_timeout_seconds: 10,
            scan_timeout_seconds: 120,
            page_size: 500,
            max_body_bytes: 8_388_608,
            max_pages: 10_000,
        }
    }
}

impl<'de> Deserialize<'de> for Config {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let source = Value::deserialize(deserializer)?;
        let defaults = Self::default();
        let string = |name: &str, fallback: String| match source.get(name) {
            None => fallback,
            Some(value) => value.as_str().unwrap_or("").to_owned(),
        };
        let number = |name: &str, fallback: u64| match source.get(name) {
            None => fallback,
            Some(value) => value.as_u64().unwrap_or(u64::MAX),
        };
        Ok(Self {
            service_root: string("service_root", defaults.service_root),
            sap_client: string("sap_client", defaults.sap_client),
            expected_digest: string("expected_digest", defaults.expected_digest),
            expected_rows: number("expected_rows", defaults.expected_rows),
            scans: number("scans", defaults.scans),
            interval_ms: number("interval_ms", defaults.interval_ms),
            request_timeout_seconds: number(
                "request_timeout_seconds",
                defaults.request_timeout_seconds,
            ),
            scan_timeout_seconds: number("scan_timeout_seconds", defaults.scan_timeout_seconds),
            page_size: number("page_size", defaults.page_size),
            max_body_bytes: number("max_body_bytes", defaults.max_body_bytes as u64)
                .try_into()
                .unwrap_or(usize::MAX),
            max_pages: number("max_pages", defaults.max_pages as u64)
                .try_into()
                .unwrap_or(usize::MAX),
        })
    }
}

impl Config {
    pub fn validate(&self) -> Result<Url, ScanError> {
        let root = Url::parse(&self.service_root).map_err(|_| ScanError::new("CONFIG", 0, None))?;
        let positive = (1..=1_000_000).contains(&self.scans)
            && (1..=3_600_000).contains(&self.interval_ms)
            && (1..=3_600).contains(&self.request_timeout_seconds)
            && (1..=86_400).contains(&self.scan_timeout_seconds)
            && (1..=10_000).contains(&self.page_size)
            && (1..=67_108_864).contains(&self.max_body_bytes)
            && (1..=1_000_000).contains(&self.max_pages)
            && self.expected_rows <= 2_147_483_647;
        let digest_valid = self.expected_digest.len() == 64
            && self
                .expected_digest
                .bytes()
                .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c));
        if !positive
            || !digest_valid
            || self.sap_client.len() != 3
            || !self.sap_client.bytes().all(|c| c.is_ascii_digit())
            || !matches!(root.scheme(), "http" | "https")
            || root.host_str().is_none()
            || !root.username().is_empty()
            || root.password().is_some()
            || root.query().is_some()
            || root.fragment().is_some()
            || !self.service_root.ends_with('/')
            || unsafe_reference(&self.service_root)
        {
            return Err(ScanError::new("CONFIG", 0, None));
        }
        Ok(root)
    }

    pub fn first_url(&self) -> Result<Url, ScanError> {
        let root = self.validate()?;
        let mut url = root
            .join("OrderPositions")
            .map_err(|_| ScanError::new("CONFIG", 0, None))?;
        url.query_pairs_mut()
            .append_pair("$select", SELECT)
            .append_pair("$orderby", "OrderId,PositionNumber")
            .append_pair("sap-client", &self.sap_client);
        Ok(url)
    }
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct ScanError {
    pub code: String,
    pub page_index: usize,
    pub http_status: Option<u16>,
}

impl ScanError {
    pub fn new(code: &str, page_index: usize, http_status: Option<u16>) -> Self {
        Self {
            code: code.into(),
            page_index,
            http_status,
        }
    }
}

#[derive(Clone, Debug, Default, Serialize)]
pub struct Metrics {
    pub elapsed_ms: u128,
    pub body_bytes: usize,
    pub missed_slots: u64,
}

#[derive(Clone, Debug, Serialize)]
pub struct ScanResult {
    pub schema_version: u8,
    pub scan_index: u64,
    pub outcome: &'static str,
    pub rows: u64,
    pub pages: usize,
    pub digest: Option<String>,
    pub error: Option<ScanError>,
    pub metrics: Metrics,
}

impl ScanResult {
    pub fn config_failure(scan_index: u64) -> Self {
        Self {
            schema_version: 1,
            scan_index,
            outcome: "error",
            rows: 0,
            pages: 0,
            digest: None,
            error: Some(ScanError::new("CONFIG", 0, None)),
            metrics: Metrics::default(),
        }
    }

    pub fn terminates_run(&self) -> bool {
        self.error.as_ref().is_some_and(|e| {
            !matches!(e.code.as_str(), "TRANSPORT" | "TIMEOUT" | "HTTP_STATUS")
                || (e.code == "HTTP_STATUS" && matches!(e.http_status, Some(400 | 401 | 403 | 404)))
        })
    }
}

pub struct Scan {
    config: Config,
    root: Url,
    hash: Sha256,
    last_key: Option<(String, String)>,
    visited: HashSet<String>,
    pub rows: u64,
    pub pages: usize,
    pub body_bytes: usize,
    start: Instant,
}

pub(crate) struct PreparedRow {
    fields: Vec<String>,
    key: (String, String),
}

impl Scan {
    pub fn new(config: Config) -> Result<Self, ScanError> {
        let root = config.validate()?;
        let mut hash = Sha256::new();
        hash.update(b"sap-polling-lab\t1\n");
        Ok(Self {
            config,
            root,
            hash,
            last_key: None,
            visited: HashSet::new(),
            rows: 0,
            pages: 0,
            body_bytes: 0,
            start: Instant::now(),
        })
    }

    pub fn elapsed(&self) -> std::time::Duration {
        self.start.elapsed()
    }

    pub fn remaining(&self) -> Option<std::time::Duration> {
        std::time::Duration::from_secs(self.config.scan_timeout_seconds).checked_sub(self.elapsed())
    }

    pub fn check_deadline(&self, status: Option<u16>) -> Result<(), ScanError> {
        if self.remaining().is_none_or(|d| d.is_zero()) {
            Err(self.failure("TIMEOUT", status))
        } else {
            Ok(())
        }
    }

    pub fn failure(&self, code: &str, status: Option<u16>) -> ScanError {
        let status = if matches!(code, "TIMEOUT" | "TRANSPORT") {
            None
        } else {
            status
        };
        ScanError::new(code, self.pages, status)
    }

    pub fn begin_page(&mut self, url: &Url) -> Result<(), ScanError> {
        self.check_deadline(None)?;
        if self.pages >= self.config.max_pages || !self.visited.insert(url.to_string()) {
            return Err(ScanError::new("LIMIT", self.pages + 1, None));
        }
        self.pages += 1;
        Ok(())
    }

    // Both adapters pass through this method so offline results use the live row/URL rules.
    pub fn process_page(
        &mut self,
        status: u16,
        body: &[u8],
        response_url: &Url,
    ) -> Result<Option<Url>, ScanError> {
        self.check_deadline(Some(status))?;
        if status != 200 {
            return Err(self.failure("HTTP_STATUS", Some(status)));
        }
        self.body_bytes = self.body_bytes.saturating_add(body.len());
        if body.len() > self.config.max_body_bytes {
            return Err(self.failure("LIMIT", Some(status)));
        }
        let text = std::str::from_utf8(body).map_err(|_| self.failure("SCHEMA", Some(status)))?;
        let value: Value =
            serde_json::from_str(text).map_err(|_| self.failure("SCHEMA", Some(status)))?;
        let object = value
            .as_object()
            .ok_or_else(|| self.failure("SCHEMA", Some(status)))?;
        let rows = object
            .get("value")
            .and_then(Value::as_array)
            .ok_or_else(|| self.failure("SCHEMA", Some(status)))?;
        if object
            .get("@odata.nextLink")
            .is_some_and(|link| !link.is_string())
        {
            return Err(self.failure("SCHEMA", Some(status)));
        }
        for row in rows {
            self.process_row(row, Some(status))?;
        }
        self.check_deadline(Some(status))?;
        match object.get("@odata.nextLink") {
            None => Ok(None),
            Some(Value::String(link)) if !link.is_empty() => {
                let next =
                    resolve_next_link(&self.root, response_url, link, &self.config.sap_client)
                        .ok_or_else(|| self.failure("NEXTLINK", Some(status)))?;
                if self.visited.contains(next.as_str()) {
                    return Err(self.failure("LIMIT", Some(status)));
                }
                Ok(Some(next))
            }
            Some(_) => Err(self.failure("NEXTLINK", Some(status))),
        }
    }

    // HTTP, SQL and fixtures share the same validation, ordering and canonical bytes.
    pub fn process_row(&mut self, row: &Value, status: Option<u16>) -> Result<(), ScanError> {
        let prepared = self.prepare_row(row, status)?;
        self.hash_prepared_row(&prepared);
        self.accept_prepared_row(prepared);
        Ok(())
    }

    pub(crate) fn prepare_row(&self, row: &Value, status: Option<u16>) -> Result<PreparedRow, ScanError> {
        self.check_deadline(status)?;
        let fields = normalize_row(row).ok_or_else(|| self.failure("SCHEMA", status))?;
        let key = (fields[0].clone(), fields[1].clone());
        if self
            .last_key
            .as_ref()
            .is_some_and(|previous| previous >= &key)
        {
            return Err(self.failure("ORDER", status));
        }
        Ok(PreparedRow { fields, key })
    }

    pub(crate) fn hash_prepared_row(&mut self, row: &PreparedRow) {
        for (index, field) in row.fields.iter().enumerate() {
            if index > 0 {
                self.hash.update(b"\t");
            }
            self.hash.update(field.as_bytes());
        }
        self.hash.update(b"\n");
    }

    pub(crate) fn accept_prepared_row(&mut self, row: PreparedRow) {
        self.last_key = Some(row.key);
        self.rows += 1;
    }

    pub fn finish(self, scan_index: u64, error: Option<ScanError>) -> ScanResult {
        let mut error = error;
        if error.is_none() {
            if let Err(deadline) = self.check_deadline(Some(200)) {
                error = Some(deadline);
            }
        }
        let digest = self.finalized_digest();
        self.finish_from_digest(scan_index, error, digest)
    }

    pub(crate) fn finalized_digest(&self) -> String {
        format!("{:x}", self.hash.clone().finalize())
    }

    pub(crate) fn finish_from_digest(self, scan_index: u64, mut error: Option<ScanError>, digest: String) -> ScanResult {
        if error.is_none() && self.rows != self.config.expected_rows {
            error = Some(self.failure("COUNT", Some(200)));
        }
        if error.is_none() && digest != self.config.expected_digest {
            error = Some(self.failure("DIGEST", Some(200)));
        }
        ScanResult {
            schema_version: 1,
            scan_index,
            outcome: if error.is_none() { "ok" } else { "error" },
            rows: self.rows,
            pages: self.pages,
            digest: if error.is_none() { Some(digest) } else { None },
            error,
            metrics: Metrics {
                elapsed_ms: self.elapsed().as_millis(),
                body_bytes: self.body_bytes,
                missed_slots: 0,
            },
        }
    }
}

fn identifier(value: &str, max: usize) -> bool {
    !value.is_empty()
        && value.len() <= max
        && value
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || c == b'_' || c == b'-')
}

fn uppercase(value: &str, min: usize, max: usize) -> bool {
    value.len() >= min && value.len() <= max && value.bytes().all(|c| c.is_ascii_uppercase())
}

fn date(value: &str) -> bool {
    let bytes = value.as_bytes();
    if bytes.len() != 10
        || bytes[4] != b'-'
        || bytes[7] != b'-'
        || !bytes
            .iter()
            .enumerate()
            .all(|(i, b)| i == 4 || i == 7 || b.is_ascii_digit())
    {
        return false;
    }
    let year: u32 = value[0..4].parse().unwrap();
    let month: usize = value[5..7].parse().unwrap();
    let day: u32 = value[8..10].parse().unwrap();
    let leap = year % 4 == 0 && (year % 100 != 0 || year % 400 == 0);
    let days = [
        31,
        if leap { 29 } else { 28 },
        31,
        30,
        31,
        30,
        31,
        31,
        30,
        31,
        30,
        31,
    ];
    year > 0 && (1..=12).contains(&month) && day > 0 && day <= days[month - 1]
}

fn decimal(value: &str, scale: usize, integer_digits: usize) -> Option<String> {
    let mut parts = value.split('.');
    let integer = parts.next()?;
    let fraction = parts.next();
    if parts.next().is_some() || integer.is_empty() || !integer.bytes().all(|c| c.is_ascii_digit())
    {
        return None;
    }
    let fraction = match fraction {
        Some(f) if f.is_empty() || f.len() > scale || !f.bytes().all(|c| c.is_ascii_digit()) => {
            return None
        }
        Some(f) => f,
        None => "",
    };
    let integer = integer.trim_start_matches('0');
    let integer = if integer.is_empty() { "0" } else { integer };
    if integer.len() > integer_digits {
        return None;
    }
    Some(format!(
        "{integer}.{fraction}{}",
        "0".repeat(scale - fraction.len())
    ))
}

pub fn normalize_row(row: &Value) -> Option<Vec<String>> {
    let object = row.as_object()?;
    let mut fields: Vec<String> = FIELDS
        .iter()
        .map(|field| object.get(*field)?.as_str().map(str::to_owned))
        .collect::<Option<_>>()?;
    if !identifier(&fields[0], 20)
        || fields[1].len() != 6
        || !fields[1].bytes().all(|c| c.is_ascii_digit())
        || !identifier(&fields[2], 10)
        || !date(&fields[3])
        || !identifier(&fields[4], 18)
        || !uppercase(&fields[6], 1, 3)
        || !uppercase(&fields[8], 3, 3)
    {
        return None;
    }
    fields[5] = decimal(&fields[5], 3, 10)?;
    fields[7] = decimal(&fields[7], 2, 13)?;
    Some(fields)
}

fn unsafe_reference(reference: &str) -> bool {
    if reference.trim_start().starts_with("//")
        || reference.contains('\\')
        || reference.contains('#')
        || reference.bytes().any(|c| !c.is_ascii_graphic())
    {
        return true;
    }
    let without_query = reference.split('?').next().unwrap_or(reference);
    let path = if let Some((_, remainder)) = without_query.split_once("://") {
        let authority = remainder.split('/').next().unwrap_or(remainder);
        if authority.contains('@') {
            return true;
        }
        remainder.find('/').map_or("", |index| &remainder[index..])
    } else {
        without_query
    };
    let lower = path.to_ascii_lowercase();
    if lower.contains("%2f") || lower.contains("%5c") {
        return true;
    }
    path.split('/').any(|segment| {
        let lower = segment.to_ascii_lowercase();
        let decoded = lower.replace("%2e", ".");
        lower.contains("%2e") && matches!(decoded.as_str(), "." | "..")
    })
}

pub fn resolve_next_link(
    root: &Url,
    current: &Url,
    reference: &str,
    sap_client: &str,
) -> Option<Url> {
    if unsafe_reference(reference) {
        return None;
    }
    let next = current.join(reference).ok()?;
    if !next.username().is_empty()
        || next.password().is_some()
        || next.fragment().is_some()
        || next.origin() != root.origin()
        || !next.path().starts_with(root.path())
        || next
            .query_pairs()
            .any(|(key, value)| key == "sap-client" && value != sap_client)
    {
        return None;
    }
    Some(next)
}

#[derive(Deserialize)]
pub struct FixtureFile {
    pub schema_version: u8,
    pub cases: Vec<FixtureCase>,
}

#[derive(Deserialize)]
pub struct FixtureCase {
    pub id: String,
    pub config: Config,
    pub pages: Vec<FixturePage>,
}

#[derive(Deserialize)]
pub struct FixturePage {
    pub status: u16,
    pub body_json: String,
    pub url: String,
}

#[derive(Serialize)]
pub struct FixtureResult {
    pub id: String,
    #[serde(flatten)]
    pub result: ScanResult,
}

pub fn run_fixture(case: FixtureCase) -> FixtureResult {
    let result = match Scan::new(case.config.clone()) {
        Err(_) => ScanResult::config_failure(0),
        Ok(mut scan) => {
            let mut next = case.config.first_url().unwrap();
            let mut pages = case.pages.into_iter();
            let error = loop {
                if let Err(e) = scan.begin_page(&next) {
                    break e;
                }
                let Some(page) = pages.next() else {
                    break scan.failure("TRANSPORT", None);
                };
                let response_url = match Url::parse(&page.url) {
                    Ok(url) => url,
                    Err(_) => {
                        break scan.failure("SCHEMA", Some(page.status));
                    }
                };
                match scan.process_page(page.status, page.body_json.as_bytes(), &response_url) {
                    Ok(Some(url)) => {
                        next = url;
                    }
                    Ok(None) => {
                        return FixtureResult {
                            id: case.id,
                            result: scan.finish(0, None),
                        };
                    }
                    Err(e) => {
                        break e;
                    }
                }
            };
            scan.finish(0, Some(error))
        }
    };
    FixtureResult {
        id: case.id,
        result,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn exact_decimal_and_date_rules() {
        assert_eq!(decimal("000123.4", 3, 10), Some("123.400".into()));
        assert_eq!(decimal("000.000", 3, 10), Some("0.000".into()));
        for value in ["1.0000", "1.", ".5", "+1", "1e2", "10000000000"] {
            assert_eq!(decimal(value, 3, 10), None, "{value}");
        }
        assert!(date("2000-02-29"));
        assert!(!date("1900-02-29"));
        assert!(!date("0000-01-01"));
    }

    #[test]
    fn incomplete_transfers_never_expose_an_http_status() {
        let scan = Scan::new(Config {
            service_root: "http://fixture.invalid/odata/".into(),
            expected_rows: 0,
            expected_digest: "0".repeat(64),
            ..Config::default()
        })
        .unwrap();
        assert_eq!(scan.failure("TIMEOUT", Some(200)).http_status, None);
        assert_eq!(scan.failure("TRANSPORT", Some(503)).http_status, None);
        assert_eq!(
            scan.failure("HTTP_STATUS", Some(503)).http_status,
            Some(503)
        );
    }

    #[test]
    fn continuation_stays_inside_service_and_client() {
        let root = Url::parse("https://example.test/odata/").unwrap();
        let current = root.join("OrderPositions?old=1").unwrap();
        assert_eq!(
            resolve_next_link(&root, &current, "?$skiptoken=a%2Fb", "001")
                .unwrap()
                .as_str(),
            "https://example.test/odata/OrderPositions?$skiptoken=a%2Fb"
        );
        for link in [
            "//example.test/odata/x",
            "../outside",
            "%2e%2e/x",
            "x%2fy",
            "x\\y",
            "x#f",
            "https://user@example.test/odata/x",
            "x?sap-client=002",
        ] {
            assert!(
                resolve_next_link(&root, &current, link, "001").is_none(),
                "{link}"
            );
        }
    }

    #[test]
    fn uri_references_use_printable_ascii_without_raw_spaces() {
        let root = Url::parse("https://example.test/odata/").unwrap();
        let current = root.join("OrderPositions").unwrap();
        for link in [
            "Order Positions",
            "OrderäPositions",
            " https://example.test/odata/x",
        ] {
            assert!(resolve_next_link(&root, &current, link, "001").is_none());
        }
        for link in [
            "Order%20Positions",
            "Order%C3%A4Positions",
            "Order%2ePositions",
        ] {
            assert!(resolve_next_link(&root, &current, link, "001").is_some());
        }
        let config = Config {
            service_root: " https://example.test/odata/".into(),
            expected_rows: 0,
            expected_digest: "0".repeat(64),
            ..Config::default()
        };
        assert_eq!(config.validate().unwrap_err().code, "CONFIG");
    }

    #[test]
    fn shared_contract_fixtures() {
        let path =
            std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../contracts/fixtures.json");
        let source: Value = serde_json::from_slice(&std::fs::read(path).unwrap()).unwrap();
        let cases = source["cases"].as_array().unwrap();
        assert!(!cases.is_empty());
        for case in cases {
            let actual =
                serde_json::to_value(run_fixture(serde_json::from_value(case.clone()).unwrap()))
                    .unwrap();
            let expected = case["expected"].as_object().unwrap();
            for (key, value) in expected {
                assert_eq!(&actual[key], value, "case={} field={key}", case["id"]);
            }
        }
    }
}
