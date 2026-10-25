use sap_order_poller::{sql::{profile::{self, Mode, Replay}, SqlClient, SqlConfig, Transport}, ScanResult};
use serde::Serialize;
use std::{collections::HashSet, env, io::{self, Write}, process::ExitCode, time::{Duration, Instant}};

struct Options { mode: Mode, duration_seconds: u64, warmup_scans: u64, rows_file: Option<String> }

fn options(args: &[String]) -> Result<Options, ()> {
    let mut result = Options { mode: Mode::Full, duration_seconds: 20, warmup_scans: 5, rows_file: None };
    let mut seen = HashSet::new();
    let mut args = args.iter();
    while let Some(name) = args.next() {
        if !seen.insert(name) { return Err(()); }
        let value = args.next().ok_or(())?;
        match name.as_str() {
            "--mode" => result.mode = Mode::parse(value).ok_or(())?,
            "--rows-file" if !value.is_empty() => result.rows_file = Some(value.clone()),
            "--duration-seconds" | "--warmup-scans" if !value.is_empty() && value.bytes().all(|b| b.is_ascii_digit()) => {
                let value: u64 = value.parse().map_err(|_| ())?;
                if name == "--duration-seconds" && (1..=3600).contains(&value) { result.duration_seconds = value; }
                else if name == "--warmup-scans" && (1..=1000).contains(&value) { result.warmup_scans = value; }
                else { return Err(()); }
            }
            _ => return Err(()),
        }
    }
    if result.mode.replay() != result.rows_file.is_some() { return Err(()); }
    Ok(result)
}

fn emit(value: &impl Serialize) {
    let stdout = io::stdout();
    let mut output = stdout.lock();
    serde_json::to_writer(&mut output, value).expect("stdout write failed");
    writeln!(output).expect("stdout write failed");
}

#[derive(Serialize)]
struct Record {
    kind: &'static str, phase: &'static str, implementation: &'static str, mode: &'static str,
    instrumentation: bool,
    #[serde(flatten)] result: ScanResult,
    timings: profile::Timings,
}

fn main() -> ExitCode {
    let args = env::args().skip(1).collect::<Vec<_>>();
    let Ok((options, config, replay)) = (|| {
        let options = options(&args)?;
        let config = SqlConfig::environment(Transport::Hana)?;
        let replay = options.rows_file.as_ref().map(|path| Replay::load(path, &config)).transpose()?;
        Ok::<_, ()>((options, config, replay))
    })() else { emit(&ScanResult::config_failure(0)); return ExitCode::from(2); };
    let mut client = SqlClient::default();
    let mut records = Vec::new();
    let mut index = 0;
    let mut failed = false;
    let mut run_one = |phase: &'static str| {
        let profile = match &replay {
            Some(replay) => replay.scan(&config, index, options.mode),
            None => profile::live(&config, &mut client, index, options.mode),
        };
        index += 1;
        let failed = profile.result.outcome != "ok";
        records.push(Record { kind: "scan", phase, implementation: "rust", mode: options.mode.name(),
            instrumentation: options.mode != Mode::Control, result: profile.result, timings: profile.timings });
        failed
    };
    for _ in 0..options.warmup_scans { failed = run_one("warmup"); if failed { break; } }
    let started = Instant::now();
    let mut measured = 0;
    while !failed && started.elapsed() < Duration::from_secs(options.duration_seconds) {
        failed = run_one("measured"); measured += 1;
    }
    let measured_wall_ms = started.elapsed().as_secs_f64() * 1000.0;
    drop(run_one);
    let warmups = records.len() - measured;
    for record in records { emit(&record); }
    emit(&serde_json::json!({ "kind":"summary", "schema_version":1, "implementation":"rust",
        "mode":options.mode.name(), "outcome":if failed { "error" } else { "ok" },
        "measured_scans":measured, "warmup_scans":warmups, "measured_wall_ms":measured_wall_ms,
        "client_policy":"persistent", "fetch_size":100, "transport":if replay.is_some() { "replay" } else { "hana" },
        "expected_rows":config.core.expected_rows, "expected_digest":config.core.expected_digest,
        "preflight_digest":replay.as_ref().map(|r| &r.digest), "query_sha256":replay.as_ref().map(|r| &r.query_sha256),
        "phase_clock":"std::time::Instant", "phase_clock_unit":"fractional milliseconds",
        "residual_includes":"timer dispatch/accounting, scan config, deadlines outside phases, row-state commit/drop, result gates",
        "database_includes":"driver calls, socket I/O/server wait, driver decoding, nine SQL string extraction; not pure HANA execution",
        "replay_materialization":"captured strings are cloned into the existing contract-object mapping inside validation timing",
        "hashing_includes":"prefix, original per-field UTF-8 byte updates with tabs/newline, SHA-256 finalization/hex; strings already UTF-8" }));
    if failed { ExitCode::from(1) } else { ExitCode::SUCCESS }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn diagnostic_modes_are_explicit_and_bounded() {
        let parse = |values: &[&str]| options(&values.iter().map(|v| v.to_string()).collect::<Vec<_>>());
        assert!(parse(&[]).is_ok());
        assert!(parse(&["--mode", "control", "--duration-seconds", "3"]).is_ok());
        assert!(parse(&["--mode", "replay-full", "--rows-file", "/input/rows.json"]).is_ok());
        for invalid in [vec!["--mode", "unknown"], vec!["--duration-seconds", "0"], vec!["--warmup-scans", "1.5"],
            vec!["--mode", "replay-full"], vec!["--rows-file", "/input/rows.json"], vec!["--mode", "full", "--mode", "control"]] {
            assert!(parse(&invalid).is_err());
        }
    }
}
