import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync, copyFileSync } from 'node:fs';
import { resolve, relative } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import os from 'node:os';
import { pathToFileURL } from 'node:url';
import { performance } from 'node:perf_hooks';
import { sapSettings } from './sap-runtime.mjs';
import { runNativeAbapBenchmark } from './native-benchmark-control.mjs';
import { projectRoot, loadRuntime, nativeEnvironment, nativeDockerCommand, invoke, dockerProgram } from '../deploy/sql/native-runtime.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');
const read = path => JSON.parse(readFileSync(resolve(projectRoot, path), 'utf8'));

export function benchmarkCommand(implementation, { name, durationSeconds, warmupScans }) {
  const command = nativeDockerCommand(implementation, { name });
  if (implementation === 'node') command.args[command.args.indexOf('/app/src/sql-cli.mjs')] = '/app/src/sql-benchmark.mjs';
  else command.args.push('--benchmark');
  command.args.push('--duration-seconds', String(durationSeconds), '--warmup-scans', String(warmupScans));
  return command;
}

export function validateRecords(records, implementation, { durationSeconds, warmupScans, seed }) {
  const scans = records.filter(record => record.kind === 'scan');
  const summaries = records.filter(record => record.kind === 'summary');
  if (summaries.length !== 1 || records.length !== scans.length + 1 || records.at(-1) !== summaries[0]) throw new Error('INVALID_NATIVE_OUTPUT');
  const summary = summaries[0], warmup = scans.filter(scan => scan.phase === 'warmup'), measured = scans.filter(scan => scan.phase === 'measured');
  const transport = implementation === 'abap' ? 'native_hana_adbc' : 'hana';
  const failures = scans.filter(scan => scan.schema_version !== 1 || scan.outcome !== 'ok' || scan.error !== null ||
    scan.rows !== seed.expected_rows || scan.pages !== 51 || scan.digest !== seed.expected_digest ||
    scan.metrics?.body_bytes !== 0 || !Number.isFinite(scan.metrics?.elapsed_ms) || scan.metrics.elapsed_ms < 0 ||
    (implementation === 'abap' && (scan.transport !== transport || scan.logical_fetches !== 51 || scan.http_requests !== 0)));
  const valid = failures.length === 0 && warmup.length === warmupScans && measured.length > 0 &&
    scans.slice(0, warmupScans).every((scan, index) => scan.phase === 'warmup' && scan.scan_index === index) &&
    scans.slice(warmupScans).every((scan, index) => scan.phase === 'measured' && scan.scan_index === index + (implementation === 'abap' ? 0 : warmupScans)) &&
    summary.warmup_scans === warmupScans && summary.measured_scans === measured.length &&
    Number.isFinite(summary.measured_wall_ms) && summary.measured_wall_ms >= durationSeconds * 1000 &&
    measured.reduce((sum, scan) => sum + scan.metrics.elapsed_ms, 0) <= summary.measured_wall_ms + 2 &&
    summary.transport === transport && (implementation === 'abap'
      ? summary.failed_scans === 0 && summary.measured_valid_rows === measured.length * 5000 &&
        summary.measured_logical_fetches === measured.length * 51 && summary.http_requests === 0 && summary.sap_client === '001' &&
        summary.entity === 'ZBL_BENCH_SQL.ORDER_POSITIONS_001' && summary.db_package_size === 100
      : summary.outcome === 'ok' && summary.client_policy === 'persistent' && summary.fetch_size === 100);
  return { passed: valid, failures: failures.length, warmup_scans: warmup.length, measured_scans: measured.length, measured_wall_ms: summary.measured_wall_ms };
}

function command(program, args) {
  const result = spawnSync(program, args, { cwd: projectRoot, encoding: 'utf8', windowsHide: true, timeout: 30000, maxBuffer: 4194304 });
  if (result.status !== 0) throw new Error(`PROVENANCE_COMMAND_FAILED:${program}`);
  return result.stdout.trim();
}

async function snapshot(names) {
  const result = await invoke(dockerProgram, ['stats', '--no-stream', '--format', '{{json .}}', ...names], { timeout: 20000 });
  if (result.status !== 0 || result.timed_out) return { passed: false, timed_out: result.timed_out, samples: [] };
  try { return { passed: true, samples: result.stdout.split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line)) }; }
  catch { return { passed: false, samples: [] }; }
}

async function main(smoke) {
  const durationSeconds = smoke ? 3 : 180, warmupScans = smoke ? 1 : 5;
  const schedule = smoke ? [['node', 'rust', 'abap']] : [['node', 'rust', 'abap'], ['rust', 'abap', 'node'], ['abap', 'node', 'rust']];
  const identifier = new Date().toISOString().replace(/[:.]/g, '-');
  const runDirectory = resolve(projectRoot, smoke ? 'work/benchmark' : 'results', `${smoke ? 'native-smoke' : 'native-hana'}-${identifier}`);
  mkdirSync(runDirectory, { recursive: true });
  const json = (path, value) => writeFileSync(resolve(runDirectory, path), JSON.stringify(value, null, 2) + '\n');
  const { settings, manifest: seed, query_sha256 } = await loadRuntime();
  const sap = sapSettings();
  const environment = { ...process.env, ...nativeEnvironment(settings, seed) };
  const sensitive = [settings.HANA_PASSWORD, sap.password, `Basic ${Buffer.from(`${sap.username}:${sap.password}`).toString('base64')}`].filter(Boolean);
  const checkOutput = text => { if (sensitive.some(value => text.includes(value))) throw new Error('OUTPUT_REDACTION_FAILED'); return text; };
  const readiness = read('work/native-benchmark-readiness/readiness.json');
  const parity = read('work/native-hana/native-client-parity-report.json');
  const verified = read('docs/native-sql-verification.json');
  if (!readiness.ready || !parity.all_passed || parity.query_sha256 !== query_sha256 || verified.status !== 'validated') throw new Error('NATIVE_READINESS_FAILED');
  for (const [path, digest] of Object.entries(verified.source_sha256)) if (hash(readFileSync(resolve(projectRoot, path))) !== digest) throw new Error(`VERIFIED_SOURCE_CHANGED:${path}`);
  const baseline = path => {
    const bytes = readFileSync(resolve(projectRoot, path));
    const data = JSON.parse(bytes);
    if (data.status !== 'validated' || data.configuration.expected_digest !== seed.expected_digest) throw new Error('BASELINE_DATA_CHANGED');
    return { path, sha256: hash(bytes), source_revision: data.provenance.source_revision,
      report_revision: command('git', ['log', '-1', '--format=%H', '--', path]), run_id: data.run_id,
      manifest_path: data.source.manifest_file, manifest_sha256: data.source.manifest_sha256 };
  };
  const sourceFiles = ['contracts/native-hana.sql', 'contracts/seed-manifest.json', 'sap/setup/native-hana-view.sql',
    'sap/src/zcl_bl_poll_orders.clas.abap', 'sap/src/zcl_bl_poll_orders.clas.locals_def.abap', 'sap/src/zcl_bl_poll_orders.clas.locals_imp.abap', 'sap/src/zcl_bl_bench_native.clas.abap',
    'clients/node/src/sql-benchmark.mjs', 'clients/node/src/sql-poller.mjs', 'clients/node/src/sql-transport.mjs', 'clients/node/src/sql-config.mjs',
    'clients/node/src/poller.mjs', 'clients/node/src/config.mjs', 'clients/node/src/benchmark.mjs', 'clients/node/package-lock.json',
    'clients/rust/src/sql.rs', 'clients/rust/src/sql_main.rs', 'clients/rust/src/lib.rs', 'clients/rust/Cargo.toml', 'clients/rust/Cargo.lock',
    'scripts/run-native-comparison.mjs', 'scripts/native-benchmark-control.mjs', 'deploy/sql/native-runtime.mjs', 'docs/native-benchmark-protocol.md'];
  const sourceInputs = sourceFiles.map(path => ({ path, sha256: hash(readFileSync(resolve(projectRoot, path))), snapshot: `sources/${path}` }));
  for (const source of sourceInputs) { const target = resolve(runDirectory, source.snapshot); mkdirSync(resolve(target, '..'), { recursive: true }); copyFileSync(resolve(projectRoot, source.path), target); }
  const inspect = name => JSON.parse(command(dockerProgram, ['inspect', '--format', '{"image":{{json .Config.Image}},"memory_limit":{{json .HostConfig.Memory}},"memory_swap_limit":{{json .HostConfig.MemorySwap}},"nano_cpus":{{json .HostConfig.NanoCpus}},"started_at":{{json .State.StartedAt}}}', name]));
  const inspectImage = name => JSON.parse(command(dockerProgram, ['image', 'inspect', '--format', '{"id":{{json .Id}},"repo_digests":{{json .RepoDigests}},"architecture":{{json .Architecture}},"os":{{json .Os}}}', name]));
  const manifest = {
    protocol: smoke ? 'sap-native-hana-benchmark-smoke-v1' : 'sap-native-hana-benchmark-v1', run_id: identifier,
    status: 'running', started_utc: new Date().toISOString(), duration_seconds: durationSeconds, warmup_scans: warmupScans,
    rounds: schedule.length, schedule, cooldown_seconds: smoke ? 0 : 5,
    expected_rows: seed.expected_rows, expected_pages: 51, expected_digest: seed.expected_digest, expected_body_bytes: 0,
    query_path: 'contracts/native-hana.sql', query_sha256, query: { path: 'contracts/native-hana.sql', sha256: query_sha256,
      view: 'ZBL_BENCH_SQL.ORDER_POSITIONS_001', actual_view_definition_sha256: hash(readFileSync(resolve(projectRoot, 'work/native-benchmark-readiness/view-definition.csv'))) },
    view: 'ZBL_BENCH_SQL.ORDER_POSITIONS_001', tenant: 'HDB', sap_client: '001',
    continuous: true, output_buffered_until_after_timing: true, resource_sample_interval_seconds: 30,
    connection_lifecycle: { policy: 'persistent', warmup: 'First Node/Rust warmup includes connection; ABAP primary session already connected',
      per_scan: 'New query/cursor; fetch; validate; canonical hash; cursor/statement cleanup', final_disconnect: 'outside block timer',
      node_cache_limit_kib: 128, node_prefetch: false, rust_fetch_rows: 100, abap_package_rows: 100 },
    client_resources: { cpu_limit: 1, memory_bytes: 268435456, memory_swap_bytes: 268435456, node_uv_threads: 1, node_hana_threads: 1, node_v8_pool: 1 },
    topology: { external_network: 'sap-local-ports', external_endpoint: settings.HANA_SERVER, abap_connection: 'SAP primary ADBC',
      external_identity_sha256: hash(settings.HANA_USER), sap_identity_sha256: hash(sap.username), identities_equal: false },
    source_revision: command('git', ['rev-parse', 'HEAD']), working_tree_status: command('git', ['status', '--short']), source_inputs: sourceInputs,
    host: { platform: os.platform(), release: os.release(), cpu_model: os.cpus()[0].model, logical_cpus: os.cpus().length, ram_bytes: os.totalmem() },
    docker: JSON.parse(command(dockerProgram, ['info', '--format', '{"version":{{json .ServerVersion}},"cpus":{{json .NCPU}},"memory_bytes":{{json .MemTotal}}}'])),
    sap_container: inspect('a4h'), images: { node: inspectImage('sap-polling-node:sql'), rust: inspectImage('sap-polling-rust:sql') },
    http_baseline: baseline('docs/performance-comparison.json'), cds_baseline: baseline('docs/cds-comparison.json'),
    readiness, live_parity: parity, runtime_versions: { node: readiness.node, rust: readiness.rust }, build: read('docs/native-sql-build.json'),
    baseline_resources: await snapshot(['a4h', 'sap-local-ports', 'sap-polling-lab-control-plane']), blocks: [],
  };
  mkdirSync(resolve(runDirectory, 'readiness'), { recursive: true });
  copyFileSync(resolve(projectRoot, 'work/native-benchmark-readiness/view-definition.csv'), resolve(runDirectory, 'readiness/view-definition.csv'));
  copyFileSync(resolve(projectRoot, 'work/native-benchmark-readiness/vm-before.txt'), resolve(runDirectory, 'readiness/vm-before.txt'));
  checkOutput(JSON.stringify(manifest));
  json('manifest.json', manifest);
  console.log(JSON.stringify({ event: 'started', directory: relative(projectRoot, runDirectory), blocks: schedule.flat().length, duration_seconds: durationSeconds }));
  let currentBlock = 0;
  try {
    for (let round = 0; round < schedule.length; round++) for (const implementation of schedule[round]) {
      for (const source of sourceInputs) if (hash(readFileSync(resolve(projectRoot, source.path))) !== source.sha256) throw new Error('SOURCE_CHANGED_DURING_RUN');
      currentBlock++;
      const path = `block-${String(currentBlock).padStart(2, '0')}-${implementation}.json`;
      const name = `native-hana-${implementation}-${identifier.replace(/\D/g, '').slice(0, 14)}-${currentBlock}`;
      const started = performance.now(), startedUtc = new Date().toISOString(), resourceSamples = [], pendingSamples = [];
      console.log(JSON.stringify({ event: 'block_started', block: currentBlock, round: round + 1, implementation }));
      const heartbeat = setInterval(() => {
        const progress = { status: 'running', block: currentBlock, round: round + 1, implementation, elapsed_seconds: Math.round((performance.now() - started) / 1000) };
        json('progress.json', progress); console.log(JSON.stringify({ event: 'progress', ...progress }));
        const names = ['a4h', 'sap-local-ports', ...(implementation === 'abap' ? [] : [name])];
        pendingSamples.push(snapshot(names).then(data => resourceSamples.push({ at_utc: new Date().toISOString(), ...data })));
      }, 30000);
      let execution;
      try {
        if (implementation === 'abap') execution = { status: 0, stdout: await runNativeAbapBenchmark({ durationSeconds, warmupScans, manifest: seed }), timed_out: false };
        else {
          const run = benchmarkCommand(implementation, { name, durationSeconds, warmupScans });
          execution = await invoke(run.program, run.args, { env: environment, timeout: (durationSeconds + 180) * 1000, maxBytes: 33554432 });
          if (execution.timed_out || execution.oversized) await invoke(dockerProgram, ['rm', '--force', name]);
        }
      } finally { clearInterval(heartbeat); }
      await Promise.all(pendingSamples);
      const output = checkOutput(execution.stdout);
      writeFileSync(resolve(runDirectory, path.replace('.json', '.ndjson')), output);
      let records, verification;
      try { records = output.split(/\r?\n/).filter(line => line.trim()).map(line => JSON.parse(line)); verification = validateRecords(records, implementation, { durationSeconds, warmupScans, seed }); }
      catch { records = []; verification = { passed: false, failures: null, reason: 'Malformed or incomplete benchmark output' }; }
      json(path, { block_index: currentBlock, round: round + 1, implementation, started_utc: startedUtc, finished_utc: new Date().toISOString(),
        control_wall_ms: performance.now() - started, exit_code: execution.status, timed_out: execution.timed_out, verification, resource_samples: resourceSamples, records });
      const passed = verification.passed && execution.status === 0 && !execution.timed_out;
      manifest.blocks.push({ path, round: round + 1, implementation, passed }); json('manifest.json', manifest);
      console.log(JSON.stringify({ event: 'block_finished', block: currentBlock, implementation, ...verification }));
      if (!passed) throw new Error('NATIVE_BENCHMARK_CORRECTNESS_GATE_FAILED');
      if (!smoke && currentBlock < schedule.flat().length) await new Promise(accept => setTimeout(accept, 5000));
    }
    for (const source of sourceInputs) if (hash(readFileSync(resolve(projectRoot, source.path))) !== source.sha256) throw new Error('SOURCE_CHANGED_DURING_RUN');
    manifest.status = 'complete'; manifest.finished_utc = new Date().toISOString();
    manifest.final_images = { node: inspectImage('sap-polling-node:sql'), rust: inspectImage('sap-polling-rust:sql') };
    if (JSON.stringify(manifest.final_images) !== JSON.stringify(manifest.images)) throw new Error('RUNTIME_IMAGES_CHANGED');
    manifest.final_resources = await snapshot(['a4h', 'sap-local-ports', 'sap-polling-lab-control-plane']);
    json('manifest.json', manifest); json('progress.json', { status: 'complete', blocks: currentBlock });
    console.log(JSON.stringify({ event: 'complete', directory: relative(projectRoot, runDirectory), blocks: currentBlock }));
  } catch (error) {
    manifest.status = 'failed'; manifest.finished_utc = new Date().toISOString(); manifest.failure = error.message;
    json('manifest.json', manifest); json('progress.json', { status: 'failed', block: currentBlock, error: error.message });
    throw error;
  }
}

function selfTest() {
  for (const implementation of ['node', 'rust']) {
    const result = benchmarkCommand(implementation, { name: `native-hana-${implementation}-selftest`, durationSeconds: 180, warmupScans: 5 });
    assert(result.args.includes('256m')); assert(result.args.includes('hana'));
    assert(result.args.includes(implementation === 'node' ? '/app/src/sql-benchmark.mjs' : '--benchmark'));
  }
  const seed = { expected_rows: 5000, expected_digest: 'a'.repeat(64) };
  const scan = (phase, index) => ({ kind: 'scan', phase, schema_version: 1, scan_index: index, outcome: 'ok', error: null, rows: 5000, pages: 51, digest: seed.expected_digest, metrics: { elapsed_ms: 1000, body_bytes: 0 } });
  const records = [scan('warmup', 0), scan('measured', 1), { kind: 'summary', warmup_scans: 1, measured_scans: 1, measured_wall_ms: 1000, transport: 'hana', outcome: 'ok', client_policy: 'persistent', fetch_size: 100 }];
  assert(validateRecords(records, 'node', { durationSeconds: 1, warmupScans: 1, seed }).passed);
  records[1].digest = 'b'.repeat(64);
  assert(!validateRecords(records, 'node', { durationSeconds: 1, warmupScans: 1, seed }).passed);
  console.log('Native benchmark command and result guards passed');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  if (args.length > 1 || (args.length === 1 && !['--smoke', '--self-test'].includes(args[0]))) throw new Error('Use --smoke or --self-test, or no arguments');
  if (args[0] === '--self-test') selfTest();
  else await main(args[0] === '--smoke').catch(error => { console.error(JSON.stringify({ event: 'failed', error: error.message })); process.exitCode = 1; });
}
