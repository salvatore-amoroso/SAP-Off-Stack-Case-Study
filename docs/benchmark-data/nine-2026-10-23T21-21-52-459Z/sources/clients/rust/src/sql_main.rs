use sap_order_poller::{
    sql::{live_scan, SqlClient, SqlConfig, Transport, FETCH_SIZE},
    ScanResult,
};
use serde::Serialize;
use std::{
    collections::HashSet,
    env,
    io::{self, Write},
    process::ExitCode,
    thread,
    time::{Duration, Instant},
};

#[derive(PartialEq, Eq, Debug)]
struct Options {
    transport: String,
    benchmark: bool,
    duration_seconds: u64,
    warmup_scans: u64,
}

fn options(args: &[String]) -> Result<Options, ()> {
    let mut options = Options {
        transport: String::new(),
        benchmark: false,
        duration_seconds: 180,
        warmup_scans: 5,
    };
    let mut args = args.iter();
    let mut seen = HashSet::new();
    while let Some(option) = args.next() {
        if !seen.insert(option.as_str()) {
            return Err(());
        }
        if option == "--benchmark" {
            options.benchmark = true;
            continue;
        }
        let value = args.next().ok_or(())?;
        match option.as_str() {
            "--transport" if matches!(value.as_str(), "hana" | "odbc") => {
                options.transport = value.clone()
            }
            "--duration-seconds" | "--warmup-scans" => {
                if value.is_empty() || !value.bytes().all(|byte| byte.is_ascii_digit()) {
                    return Err(());
                }
                let number = value.parse::<u64>().map_err(|_| ())?;
                if option == "--duration-seconds" && (1..=3600).contains(&number) {
                    options.duration_seconds = number;
                } else if option == "--warmup-scans" && (1..=1000).contains(&number) {
                    options.warmup_scans = number;
                } else {
                    return Err(());
                }
            }
            _ => return Err(()),
        }
    }
    if options.transport.is_empty()
        || (!options.benchmark
            && (seen.contains("--duration-seconds") || seen.contains("--warmup-scans")))
    {
        return Err(());
    }
    Ok(options)
}

fn emit(value: &impl Serialize) {
    let stdout = io::stdout();
    let mut out = stdout.lock();
    serde_json::to_writer(&mut out, value).expect("stdout write failed");
    writeln!(out).expect("stdout write failed");
    out.flush().expect("stdout write failed");
}

#[derive(Serialize)]
struct BenchmarkRecord {
    kind: &'static str,
    phase: &'static str,
    #[serde(flatten)]
    result: ScanResult,
}

fn benchmark(config: &SqlConfig, options: &Options) -> ExitCode {
    let mut client = SqlClient::default();
    let mut records = Vec::new();
    let mut index = 0;
    let mut warmup_count = 0;
    let mut measured_count = 0;
    let mut failed = false;
    for _ in 0..options.warmup_scans {
        let result = live_scan(config, &mut client, index);
        index += 1;
        warmup_count += 1;
        failed = result.outcome != "ok";
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
            let result = live_scan(config, &mut client, index);
            index += 1;
            measured_count += 1;
            failed = result.outcome != "ok";
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
    for record in records {
        emit(&record);
    }
    emit(&serde_json::json!({ "kind": "summary", "schema_version": 1,
        "outcome": if failed { "error" } else { "ok" }, "measured_wall_ms": measured_wall_ms,
        "measured_scans": measured_count, "warmup_scans": warmup_count,
        "transport": config.transport.name(), "client_policy": "persistent", "fetch_size": FETCH_SIZE }));
    if failed {
        ExitCode::from(1)
    } else {
        ExitCode::SUCCESS
    }
}

fn main() -> ExitCode {
    let args = env::args().skip(1).collect::<Vec<_>>();
    let settings = options(&args).and_then(|options| {
        let transport = if options.transport == "hana" {
            Transport::Hana
        } else {
            Transport::Odbc
        };
        SqlConfig::environment(transport).map(|config| (options, config))
    });
    let Ok((options, config)) = settings else {
        emit(&ScanResult::config_failure(0));
        return ExitCode::from(2);
    };
    if options.benchmark {
        return benchmark(&config, &options);
    }
    let origin = Instant::now();
    let mut current_slot = 0;
    let mut all_ok = true;
    let mut client = SqlClient::default();
    for index in 0..config.core.scans {
        let mut result = live_scan(&config, &mut client, index);
        let next_slot =
            (origin.elapsed().as_millis() / u128::from(config.core.interval_ms) + 1) as u64;
        result.metrics.missed_slots = next_slot.saturating_sub(current_slot + 1);
        all_ok &= result.outcome == "ok";
        let terminal = result.terminates_run();
        emit(&result);
        if terminal || index + 1 == config.core.scans {
            break;
        }
        current_slot = next_slot;
        let next_at = origin + Duration::from_millis(current_slot * config.core.interval_ms);
        if let Some(wait) = next_at.checked_duration_since(Instant::now()) {
            thread::sleep(wait);
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
    fn args(values: &[&str]) -> Vec<String> {
        values.iter().map(|value| value.to_string()).collect()
    }

    #[test]
    fn finite_and_benchmark_modes_are_bounded_and_unambiguous() {
        assert_eq!(
            options(&args(&["--transport", "hana"])).unwrap(),
            Options {
                transport: "hana".into(),
                benchmark: false,
                duration_seconds: 180,
                warmup_scans: 5
            }
        );
        assert!(options(&args(&[
            "--transport",
            "odbc",
            "--benchmark",
            "--warmup-scans",
            "1",
            "--duration-seconds",
            "3"
        ]))
        .is_ok());
        for invalid in [
            vec![],
            vec!["--transport", "http"],
            vec!["--transport", "hana", "--duration-seconds", "3"],
            vec![
                "--transport",
                "hana",
                "--benchmark",
                "--duration-seconds",
                "0",
            ],
            vec![
                "--transport",
                "hana",
                "--benchmark",
                "--warmup-scans",
                "1.5",
            ],
            vec!["--transport", "hana", "--transport", "odbc"],
        ] {
            assert!(options(&args(&invalid)).is_err());
        }
    }
}
