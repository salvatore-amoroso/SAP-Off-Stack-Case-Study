import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve, relative } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { projectRoot, sapSettings } from './sap-runtime.mjs';
import { runCdsBenchmark } from './benchmark-control.mjs';

const smoke = process.argv.includes('--smoke');
if (process.argv.slice(2).some(arg => arg !== '--smoke')) throw new Error('Only --smoke is supported');
const durationSeconds = smoke ? 3 : 180, warmupScans = smoke ? 1 : 5, rounds = smoke ? 1 : 3;
const identifier = new Date().toISOString().replace(/[:.]/g, '-');
const runDirectory = resolve(projectRoot, smoke ? 'work/benchmark' : 'results', `${smoke ? 'cds-smoke' : 'cds'}-${identifier}`);
mkdirSync(runDirectory, { recursive: true });
const read = path => JSON.parse(readFileSync(resolve(projectRoot, path), 'utf8'));
const hash = value => createHash('sha256').update(value).digest('hex');
const seed = read('contracts/seed-manifest.json');
const settings = sapSettings();
const baselinePath = 'docs/performance-comparison.json';
const baseline = read(baselinePath), baselineRaw = read(baseline.source.manifest_file);
if (baseline.status !== 'validated' || baseline.configuration.expected_digest !== seed.expected_digest
    || baselineRaw.sap_client !== settings.client || baselineRaw.identity_sha256 !== hash(settings.username)) throw new Error('BASELINE_DATA_OR_IDENTITY_CHANGED');
const readiness = read('work/cds-readiness/summary.json');
if (readiness.all_passed !== true || readiness.source_activation_succeeded !== true
    || readiness.offline_cases !== 68 || readiness.offline_passed !== 68
    || readiness.socket_cases !== 70 || readiness.socket_passed !== 70
    || readiness.unit_cases !== 9 || readiness.unit_passed !== 9 || readiness.unit_alerts !== 0
    || readiness.authenticated_http_proof?.outcome !== 'ok' || readiness.authenticated_http_proof?.rows !== 5000
    || readiness.authenticated_http_proof?.digest !== seed.expected_digest
    || readiness.native_proof?.outcome !== 'ok' || readiness.native_proof?.digest !== seed.expected_digest
    || readiness.sources?.some(source => hash(readFileSync(resolve(projectRoot, source.path))) !== source.sha256)) {
  throw new Error('POST_REFACTOR_READINESS_FAILED');
}
const sensitive = [settings.password, `Basic ${Buffer.from(`${settings.username}:${settings.password}`).toString('base64')}`].filter(Boolean);
const json = (path, value) => writeFileSync(resolve(runDirectory, path), JSON.stringify(value, null, 2) + '\n');
function command(program, args) {
  const result = spawnSync(program, args, { cwd: projectRoot, encoding: 'utf8', windowsHide: true, timeout: 15000 });
  if (result.status !== 0) throw new Error(`PROVENANCE_COMMAND_FAILED:${program}`);
  return result.stdout.trim();
}
function parseRecords(output) {
  if (sensitive.some(value => output.includes(value))) throw new Error('OUTPUT_REDACTION_FAILED');
  return output.split(/\r?\n/).filter(line => line.trim()).map(line => JSON.parse(line));
}
function validate(records) {
  const scans = records.filter(record => record.kind === 'scan'), summaries = records.filter(record => record.kind === 'summary');
  if (summaries.length !== 1 || records.length !== scans.length + 1) throw new Error('INVALID_CDS_OUTPUT');
  const summary = summaries[0], warmup = scans.filter(scan => scan.phase === 'warmup'), measured = scans.filter(scan => scan.phase === 'measured');
  const failures = scans.filter(scan => scan.schema_version !== 1 || scan.outcome !== 'ok' || scan.error !== null || scan.rows !== 5000
    || scan.pages !== 50 || scan.application_batches !== 50 || scan.transport !== 'direct_cds' || scan.http_requests !== 0
    || scan.digest !== seed.expected_digest || scan.metrics?.body_bytes !== 0
    || !Number.isFinite(scan.metrics?.elapsed_ms) || scan.metrics.elapsed_ms <= 0);
  const passed = failures.length === 0 && summary.transport === 'direct_cds' && summary.http_requests === 0
    && warmup.length === warmupScans && summary.warmup_scans === warmupScans && measured.length > 0
    && scans.length === warmup.length + measured.length && records.at(-1) === summary
    && scans.slice(0, warmupScans).every(scan => scan.phase === 'warmup')
    && scans.slice(warmupScans).every((scan, index) => scan.phase === 'measured' && scan.scan_index === index)
    && summary.entity === 'ZI_BL_OrderPosition' && summary.sap_client === settings.client && summary.db_package_size === 100
    && summary.failed_scans === 0 && summary.measured_valid_rows === measured.length * 5000
    && summary.measured_application_batches === measured.length * 50 && summary.measured_body_bytes === 0
    && summary.measured_scans === measured.length && summary.measured_wall_ms >= durationSeconds * 1000
    && measured.reduce((sum, scan) => sum + scan.metrics.elapsed_ms, 0) <= summary.measured_wall_ms + 1;
  return { passed, failures: failures.length, warmup_scans: warmup.length, measured_scans: measured.length, measured_wall_ms: summary.measured_wall_ms };
}
async function snapshot() {
  return new Promise(resolveStats => {
    const child = spawn('docker', ['stats', '--no-stream', '--format', '{{json .}}', 'a4h', 'sap-local-ports', 'sap-polling-lab-control-plane'], { windowsHide: true });
    let output = '';
    child.stdout.on('data', bytes => { output += bytes; }); child.stderr.resume();
    child.on('error', () => resolveStats([]));
    child.on('exit', () => { try { resolveStats(output.trim().split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line))); } catch { resolveStats([]); } });
  });
}
const files = ['sap/src/zcl_bl_poll_orders.clas.abap', 'sap/src/zcl_bl_poll_orders.clas.locals_def.abap',
  'sap/src/zcl_bl_poll_orders.clas.locals_imp.abap', 'sap/src/zcl_bl_bench_cds.clas.abap',
  'sap/src/zi_bl_orderposition.ddls.asddls', 'sap/src/zi_bl_orderheader.ddls.asddls',
  'contracts/seed-manifest.json', 'scripts/benchmark-control.mjs', 'scripts/run-cds-comparison.mjs', 'docs/cds-benchmark-protocol.md'];
const manifest = {
  protocol: smoke ? 'sap-cds-benchmark-smoke-v1' : 'sap-cds-benchmark-v1', run_id: identifier,
  started_utc: new Date().toISOString(), status: 'running', duration_seconds: durationSeconds, warmup_scans: warmupScans, rounds,
  implementation: 'abap_cds', cds_entity: 'ZI_BL_OrderPosition', db_package_size: 100, expected_application_batches: 50,
  expected_rows: seed.expected_rows, expected_digest: seed.expected_digest, expected_http_requests: 0, expected_body_bytes: 0,
  sap_client: settings.client, identity_sha256: hash(settings.username), identity_matches_http_baseline: true,
  http_baseline: { path: baselinePath, sha256: hash(readFileSync(resolve(projectRoot, baselinePath))),
    source_revision: baseline.provenance.source_revision,
    report_revision: command('git', ['log', '-1', '--format=%H', '--', baselinePath]),
    run_id: baseline.run_id },
  source_revision: command('git', ['rev-parse', 'HEAD']),
  source_inputs: files.map(path => ({ path, sha256: hash(readFileSync(resolve(projectRoot, path))) })),
  post_refactor_http_validation: readiness,
  docker: JSON.parse(command('docker', ['info', '--format', '{"version":{{json .ServerVersion}},"cpus":{{json .NCPU}},"memory_bytes":{{json .MemTotal}}}'])),
  sap_container: JSON.parse(command('docker', ['inspect', '--format', '{"image":{{json .Config.Image}},"memory_limit":{{json .HostConfig.Memory}},"nano_cpus":{{json .HostConfig.NanoCpus}}}', 'a4h'])),
  continuous: true, output_buffered_until_after_timing: true, resource_sample_interval_seconds: 30,
  baseline_resources: await snapshot(), blocks: [],
};
json('manifest.json', manifest);
console.log(JSON.stringify({ event: 'started', directory: relative(projectRoot, runDirectory), blocks: rounds, duration_seconds: durationSeconds }));
try {
  for (let round = 1; round <= rounds; round++) {
    const started = performance.now(), startedUtc = new Date().toISOString(), resourceSamples = [], pendingSamples = [];
    const path = `block-${String(round).padStart(2, '0')}-abap-cds.json`;
    console.log(JSON.stringify({ event: 'block_started', round, implementation: 'abap_cds' }));
    const ticker = setInterval(() => {
      const progress = { status: 'running', round, implementation: 'abap_cds', elapsed_seconds: Math.round((performance.now() - started) / 1000) };
      json('progress.json', progress); console.log(JSON.stringify({ event: 'progress', ...progress }));
      pendingSamples.push(snapshot().then(data => resourceSamples.push({ at_utc: new Date().toISOString(), data })));
    }, 30000);
    let output;
    try { output = await runCdsBenchmark({ durationSeconds, warmupScans, manifest: seed }); } finally { clearInterval(ticker); }
    await Promise.all(pendingSamples);
    const records = parseRecords(output), verification = validate(records);
    json(path, { block_index: round, round, implementation: 'abap_cds', started_utc: startedUtc, finished_utc: new Date().toISOString(),
      control_wall_ms: performance.now() - started, output_bytes: Buffer.byteLength(output), exit_code: 0, verification,
      resource_samples: resourceSamples, records });
    manifest.blocks.push({ path, round, implementation: 'abap_cds', passed: verification.passed });
    json('manifest.json', manifest); console.log(JSON.stringify({ event: 'block_finished', round, ...verification }));
    if (!verification.passed) throw new Error('CDS_CORRECTNESS_GATE_FAILED');
    if (round < rounds) await new Promise(resolveWait => setTimeout(resolveWait, 5000));
  }
  manifest.status = 'complete'; manifest.finished_utc = new Date().toISOString();
  json('manifest.json', manifest); json('progress.json', { status: 'complete', blocks: rounds });
  console.log(JSON.stringify({ event: 'complete', directory: relative(projectRoot, runDirectory) }));
} catch (error) {
  manifest.status = 'failed'; manifest.finished_utc = new Date().toISOString(); manifest.failure = error.message;
  json('manifest.json', manifest); json('progress.json', { status: 'failed', error: error.message });
  console.error(JSON.stringify({ event: 'failed', error: error.message })); process.exitCode = 1;
}
