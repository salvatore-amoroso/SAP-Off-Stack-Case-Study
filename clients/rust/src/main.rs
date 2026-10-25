use reqwest::{header, redirect, Client};
use sap_order_poller::{run_fixture, Config, FixtureFile, Scan, ScanResult};
use serde::Serialize;
use std::{
    env,
    io::{self, Write},
    process::ExitCode,
    time::{Duration, Instant},
};

fn environment() -> Option<(Config, Option<(String, String)>, bool)> {
    fn number(name: &str, fallback: u64) -> Option<u64> {
        match env::var(name) {
            Ok(value) if !value.is_empty() && value.bytes().all(|b| b.is_ascii_digit()) => {
                value.parse().ok()
            }
            Ok(_) => None,
            Err(env::VarError::NotPresent) => Some(fallback),
            Err(_) => None,
        }
    }
    let defaults = Config::default();
    let expected = env::var("EXPECTED_ROWS").ok()?;
    if expected.is_empty() || !expected.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    let config = Config {
        service_root: env::var("SAP_SERVICE_ROOT").ok()?,
        sap_client: env::var("SAP_CLIENT").unwrap_or(defaults.sap_client),
        expected_rows: expected.parse().ok()?,
        expected_digest: env::var("EXPECTED_DIGEST").ok()?,
        scans: number("SCANS", defaults.scans)?,
        interval_ms: number("POLL_INTERVAL_MS", defaults.interval_ms)?,
        request_timeout_seconds: number(
            "REQUEST_TIMEOUT_SECONDS",
            defaults.request_timeout_seconds,
        )?,
        scan_timeout_seconds: number("SCAN_TIMEOUT_SECONDS", defaults.scan_timeout_seconds)?,
        page_size: number("PAGE_SIZE", defaults.page_size)?,
        max_body_bytes: number("MAX_BODY_BYTES", defaults.max_body_bytes as u64)?
            .try_into()
            .ok()?,
        max_pages: number("MAX_PAGES", defaults.max_pages as u64)?
            .try_into()
            .ok()?,
    };
    config.validate().ok()?;
    let credentials = match (env::var("SAP_USERNAME"), env::var("SAP_PASSWORD")) {
        (Ok(user), Ok(password)) => Some((user, password)),
        (Err(env::VarError::NotPresent), Err(env::VarError::NotPresent)) => None,
        _ => return None,
    };
    let insecure = match env::var("SAP_TLS_INSECURE") {
        Err(env::VarError::NotPresent) => false,
        Ok(value) if value == "false" => false,
        Ok(value) if value == "true" => true,
        _ => return None,
    };
    Some((config, credentials, insecure))
}

fn emit(result: &ScanResult) {
    let stdout = io::stdout();
    let mut out = stdout.lock();
    serde_json::to_writer(&mut out, result).expect("stdout write failed");
    writeln!(out).expect("stdout write failed");
    out.flush().expect("stdout write failed");
}

fn http_client(insecure: bool) -> reqwest::Result<Client> {
    Client::builder()
        .redirect(redirect::Policy::none())
        .retry(reqwest::retry::never())
        .no_proxy()
        .danger_accept_invalid_certs(insecure)
        .pool_max_idle_per_host(1)
        .build()
}

#[derive(Debug, PartialEq)]
struct BenchmarkOptions {
    duration_seconds: u64,
    warmup_scans: u64,
}

fn benchmark_options(args: &[String]) -> Result<BenchmarkOptions, ()> {
    let mut options = BenchmarkOptions {
        duration_seconds: 180,
        warmup_scans: 5,
    };
    let mut seen = std::collections::HashSet::new();
    if args.len() % 2 != 0 {
        return Err(());
    }
    for pair in args.chunks_exact(2) {
        if !seen.insert(pair[0].as_str())
            || pair[1].is_empty()
            || !pair[1].bytes().all(|byte| byte.is_ascii_digit())
        {
            return Err(());
        }
        let value: u64 = pair[1].parse().map_err(|_| ())?;
        match pair[0].as_str() {
            "--duration-seconds" if (1..=3600).contains(&value) => options.duration_seconds = value,
            "--warmup-scans" if (1..=1000).contains(&value) => options.warmup_scans = value,
            _ => return Err(()),
        }
    }
    Ok(options)
}

#[derive(Serialize)]
struct BenchmarkRecord {
    kind: &'static str,
    phase: &'static str,
    #[serde(flatten)]
    result: ScanResult,
}

async fn benchmark_scan(
    config: &Config,
    credentials: &Option<(String, String)>,
    insecure: bool,
    index: u64,
) -> ScanResult {
    let started = Instant::now();
    let mut result = match http_client(insecure) {
        Ok(client) => {
            let result = live_scan(config, &client, credentials, index).await;
            drop(client);
            result
        }
        Err(_) => ScanResult::config_failure(index),
    };
    result.metrics.elapsed_ms = started.elapsed().as_millis();
    result
}

async fn benchmark(
    config: &Config,
    credentials: &Option<(String, String)>,
    insecure: bool,
    options: BenchmarkOptions,
) -> ExitCode {
    let mut records = Vec::new();
    let mut index = 0;
    let mut warmup_count = 0;
    let mut measured_count = 0;
    let mut failed = false;
    for _ in 0..options.warmup_scans {
        let result = benchmark_scan(config, credentials, insecure, index).await;
        index += 1;
        warmup_count += 1;
        failed |= result.outcome != "ok";
        records.push(BenchmarkRecord {
            kind: "scan",
            phase: "warmup",
            result,
        });
        if failed {
            break;
        }
    }
    let mut measured_wall_ms = 0;
    if !failed {
        let started = Instant::now();
        while started.elapsed() < Duration::from_secs(options.duration_seconds) {
            let result = benchmark_scan(config, credentials, insecure, index).await;
            index += 1;
            measured_count += 1;
            failed |= result.outcome != "ok";
            records.push(BenchmarkRecord {
                kind: "scan",
                phase: "measured",
                result,
            });
            if failed {
                break;
            }
        }
        measured_wall_ms = started.elapsed().as_millis();
    }
    let stdout = io::stdout();
    let mut out = stdout.lock();
    for record in records {
        serde_json::to_writer(&mut out, &record).expect("stdout write failed");
        writeln!(out).expect("stdout write failed");
    }
    let summary = serde_json::json!({ "kind": "summary", "schema_version": 1,
        "outcome": if failed { "error" } else { "ok" }, "measured_wall_ms": measured_wall_ms,
        "measured_scans": measured_count, "warmup_scans": warmup_count,
        "transport": "socket", "client_policy": "fresh_per_scan" });
    serde_json::to_writer(&mut out, &summary).expect("stdout write failed");
    writeln!(out).expect("stdout write failed");
    out.flush().expect("stdout write failed");
    if failed {
        ExitCode::from(1)
    } else {
        ExitCode::SUCCESS
    }
}

async fn live_scan(
    config: &Config,
    client: &Client,
    credentials: &Option<(String, String)>,
    index: u64,
) -> ScanResult {
    let mut scan = Scan::new(config.clone()).expect("config was validated");
    let mut next = config.first_url().expect("config was validated");
    loop {
        if let Err(error) = scan.begin_page(&next) {
            return scan.finish(index, Some(error));
        }
        let remaining = scan.remaining().unwrap_or_default();
        if remaining.is_zero() {
            let error = scan.failure("TIMEOUT", None);
            return scan.finish(index, Some(error));
        }
        let mut request = client
            .get(next.clone())
            .header(
                header::ACCEPT,
                "application/json;odata.metadata=minimal;IEEE754Compatible=true",
            )
            .header("Prefer", format!("odata.maxpagesize={}", config.page_size))
            .header(header::ACCEPT_ENCODING, "identity")
            .timeout(remaining.min(Duration::from_secs(config.request_timeout_seconds)));
        if let Some((user, password)) = credentials {
            request = request.basic_auth(user, Some(password));
        }
        let mut response = match request.send().await {
            Ok(response) => response,
            Err(e) => {
                let code = if e.is_timeout() || scan.remaining().is_none_or(|d| d.is_zero()) {
                    "TIMEOUT"
                } else {
                    "TRANSPORT"
                };
                let error = scan.failure(code, None);
                return scan.finish(index, Some(error));
            }
        };
        let status = response.status().as_u16();
        if let Err(error) = scan.check_deadline(Some(status)) {
            return scan.finish(index, Some(error));
        }
        let mut oversized = response
            .content_length()
            .is_some_and(|length| length > config.max_body_bytes as u64);
        let response_url = response.url().clone();
        let mut body = Vec::new();
        let mut received = 0usize;
        loop {
            match response.chunk().await {
                Ok(Some(chunk)) => {
                    received = received.saturating_add(chunk.len());
                    oversized |= received > config.max_body_bytes;
                    if oversized || status != 200 {
                        body.clear();
                    } else {
                        body.extend_from_slice(&chunk);
                    }
                }
                Ok(None) => break,
                Err(e) => {
                    scan.body_bytes = scan.body_bytes.saturating_add(received);
                    let code = if e.is_timeout() || scan.remaining().is_none_or(|d| d.is_zero()) {
                        "TIMEOUT"
                    } else {
                        "TRANSPORT"
                    };
                    let error = scan.failure(code, Some(status));
                    return scan.finish(index, Some(error));
                }
            }
            if let Err(error) = scan.check_deadline(Some(status)) {
                return scan.finish(index, Some(error));
            }
        }
        if let Err(error) = scan.check_deadline(Some(status)) {
            scan.body_bytes = scan.body_bytes.saturating_add(received);
            return scan.finish(index, Some(error));
        }
        if status != 200 {
            scan.body_bytes = scan.body_bytes.saturating_add(received);
            let error = scan.failure("HTTP_STATUS", Some(status));
            return scan.finish(index, Some(error));
        }
        // Match ABAP's completed-body limit decision. Keep a bounded buffer here
        // while draining oversized data so deadlines/transport errors win first.
        if oversized {
            scan.body_bytes = scan.body_bytes.saturating_add(received);
            let error = scan.failure("LIMIT", Some(status));
            return scan.finish(index, Some(error));
        }
        match scan.process_page(status, &body, &response_url) {
            Ok(Some(url)) => next = url,
            Ok(None) => return scan.finish(index, None),
            Err(error) => return scan.finish(index, Some(error)),
        }
    }
}

fn fixture_file(path: &str) -> Result<(), ()> {
    let bytes = std::fs::read(path).map_err(|_| ())?;
    let file: FixtureFile = serde_json::from_slice(&bytes).map_err(|_| ())?;
    if file.schema_version != 1 {
        return Err(());
    }
    let results: Vec<_> = file
        .cases
        .into_iter()
        .map(|case| {
            let mut result =
                serde_json::to_value(run_fixture(case)).expect("result is serializable");
            result.as_object_mut().unwrap().remove("metrics");
            result
        })
        .collect();
    serde_json::to_writer(io::stdout().lock(), &results).map_err(|_| ())?;
    println!();
    Ok(())
}

#[tokio::main(worker_threads = 1)]
async fn main() -> ExitCode {
    let args: Vec<String> = env::args().skip(1).collect();
    if let [option, path] = args.as_slice() {
        if option == "--fixtures" {
            return match fixture_file(path) {
                Ok(()) => ExitCode::SUCCESS,
                Err(()) => {
                    eprintln!("Cannot read a schema version 1 fixture file.");
                    ExitCode::from(2)
                }
            };
        }
    }
    let benchmark_mode = args.first().is_some_and(|arg| arg == "--benchmark");
    let benchmark_settings = if benchmark_mode {
        match benchmark_options(&args[1..]) {
            Ok(options) => Some(options),
            Err(()) => {
                emit(&ScanResult::config_failure(0));
                return ExitCode::from(2);
            }
        }
    } else {
        None
    };
    if !args.is_empty() && !benchmark_mode {
        emit(&ScanResult::config_failure(0));
        return ExitCode::from(2);
    }
    let Some((config, credentials, insecure)) = environment() else {
        emit(&ScanResult::config_failure(0));
        return ExitCode::from(2);
    };
    if let Some(options) = benchmark_settings {
        return benchmark(&config, &credentials, insecure, options).await;
    }
    let client = match http_client(insecure) {
        Ok(client) => client,
        Err(_) => {
            emit(&ScanResult::config_failure(0));
            return ExitCode::from(2);
        }
    };
    let origin = Instant::now();
    let mut current_slot = 0u64;
    let mut all_ok = true;
    for index in 0..config.scans {
        let mut result = live_scan(&config, &client, &credentials, index).await;
        let next_slot = (origin.elapsed().as_millis() / u128::from(config.interval_ms) + 1) as u64;
        result.metrics.missed_slots = next_slot.saturating_sub(current_slot + 1);
        all_ok &= result.outcome == "ok";
        let terminal = result.terminates_run();
        emit(&result);
        if terminal || index + 1 == config.scans {
            break;
        }
        current_slot = next_slot;
        let next_at = origin + Duration::from_millis(current_slot * config.interval_ms);
        if let Some(wait) = next_at.checked_duration_since(Instant::now()) {
            tokio::time::sleep(wait).await;
        }
    }
    if all_ok {
        ExitCode::SUCCESS
    } else {
        ExitCode::from(1)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn benchmark_flags_are_bounded_and_unambiguous() {
        assert_eq!(
            benchmark_options(&[]).unwrap(),
            BenchmarkOptions {
                duration_seconds: 180,
                warmup_scans: 5
            }
        );
        let arguments = |values: &[&str]| {
            values
                .iter()
                .map(|value| value.to_string())
                .collect::<Vec<_>>()
        };
        assert_eq!(
            benchmark_options(&arguments(&[
                "--duration-seconds",
                "3",
                "--warmup-scans",
                "1"
            ]))
            .unwrap(),
            BenchmarkOptions {
                duration_seconds: 3,
                warmup_scans: 1
            }
        );
        for invalid in [
            vec!["--duration-seconds"],
            vec!["--duration-seconds", "0"],
            vec!["--warmup-scans", "1.5"],
            vec!["--duration-seconds", "3", "--duration-seconds", "4"],
            vec!["--unknown", "1"],
        ] {
            assert!(benchmark_options(&arguments(&invalid)).is_err());
        }
    }
}
