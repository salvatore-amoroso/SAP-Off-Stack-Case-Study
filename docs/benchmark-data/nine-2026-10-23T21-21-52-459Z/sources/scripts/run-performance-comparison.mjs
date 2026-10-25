import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve, relative } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import os from 'node:os';
import { performance } from 'node:perf_hooks';
import { projectRoot, sapSettings, pollerEnvironment } from './sap-runtime.mjs';
import { benchmarkServiceRoot, runAbapBenchmark } from './benchmark-control.mjs';
import { benchmarkCommand } from '../deploy/benchmark-client.mjs';

const smoke = process.argv.includes('--smoke');
if (process.argv.some(arg => ![process.argv[0], process.argv[1], '--smoke'].includes(arg))) throw new Error('Only --smoke is supported');
const durationSeconds = smoke ? 3 : 180;
const warmupScans = smoke ? 1 : 5;
const schedule = smoke ? [['node', 'rust', 'abap']] : [['node', 'rust', 'abap'], ['rust', 'abap', 'node'], ['abap', 'node', 'rust']];
const identifier = new Date().toISOString().replace(/[:.]/g, '-');
const runDirectory = resolve(projectRoot, smoke ? 'work/benchmark' : 'results', `${smoke ? 'smoke' : 'performance'}-${identifier}`);
mkdirSync(runDirectory, { recursive: true });
const read = path => JSON.parse(readFileSync(resolve(projectRoot, path), 'utf8'));
const seed = read('contracts/seed-manifest.json');
const settings = sapSettings();
const environment = { ...pollerEnvironment(settings, seed), SAP_SERVICE_ROOT: benchmarkServiceRoot, SAP_TLS_INSECURE: 'false',
  PAGE_SIZE: '500', REQUEST_TIMEOUT_SECONDS: '10', SCAN_TIMEOUT_SECONDS: '120', MAX_BODY_BYTES: '8388608', MAX_PAGES: '10000' };
const sensitive = [settings.password, `Basic ${Buffer.from(`${settings.username}:${settings.password}`).toString('base64')}`].filter(Boolean);
const json = (path, value) => writeFileSync(resolve(runDirectory, path), JSON.stringify(value, null, 2) + '\n');
function command(program, args) {
  const result = spawnSync(program, args, { cwd: projectRoot, encoding: 'utf8', windowsHide: true, timeout: 15000 });
  if (result.status !== 0) throw new Error(`PROVENANCE_COMMAND_FAILED:${program}`);
  return result.stdout.trim();
}
function inspectImage(name) {
  return JSON.parse(command('docker', ['image', 'inspect', '--format', '{"id":{{json .Id}},"repo_digests":{{json .RepoDigests}},"architecture":{{json .Architecture}},"os":{{json .Os}}}', name]));
}
function parseRecords(output) {
  if (sensitive.some(value => output.includes(value))) throw new Error('OUTPUT_REDACTION_FAILED');
  return output.split(/\r?\n/).filter(line => line.trim()).map(line => JSON.parse(line));
}
function validate(records) {
  const scans = records.filter(record => record.kind === 'scan');
  const summaries = records.filter(record => record.kind === 'summary');
  if (summaries.length !== 1 || records.length !== scans.length + 1) throw new Error('INVALID_BENCHMARK_OUTPUT');
  const summary = summaries[0];
  const warmup = scans.filter(scan => scan.phase === 'warmup');
  const measured = scans.filter(scan => scan.phase === 'measured');
  const failures = scans.filter(scan => scan.outcome !== 'ok' || scan.rows !== seed.expected_rows || scan.pages !== 51
    || scan.digest !== seed.expected_digest || scan.metrics?.body_bytes !== 1074741 || scan.error !== null);
  const configurationValid = warmup.length === warmupScans && summary.warmup_scans === warmupScans
    && summary.measured_scans === measured.length && measured.length > 0 && summary.measured_wall_ms >= durationSeconds * 1000;
  return { passed: configurationValid && failures.length === 0, failures: failures.length,
    warmup_scans: warmup.length, measured_scans: measured.length, measured_wall_ms: summary.measured_wall_ms };
}
function executeExternal(implementation, name) {
  const { program, args } = benchmarkCommand(implementation, { durationSeconds, warmupScans, name });
  return new Promise((resolveRun, reject) => {
    const child = spawn(program, args, { cwd: projectRoot, env: environment, windowsHide: true });
    let output = ''; let errorBytes = 0;
    child.stdout.on('data', bytes => { output += bytes; });
    child.stderr.on('data', bytes => { errorBytes += bytes.length; });
    child.on('error', () => reject(new Error('EXTERNAL_RUNNER_FAILURE')));
    child.on('exit', code => resolveRun({ code, output, stderr_bytes: errorBytes }));
  });
}
async function resourceSnapshot(names) {
  return new Promise(resolveStats => {
    const child = spawn('docker', ['stats', '--no-stream', '--format', '{{json .}}', ...names], { windowsHide: true });
    let output = '';
    child.stdout.on('data', bytes => { output += bytes; });
    child.stderr.resume();
    child.on('error', () => resolveStats([]));
    child.on('exit', () => {
      try { resolveStats(output.trim().split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line))); }
      catch { resolveStats([]); }
    });
  });
}

const files = ['clients/node/src/benchmark.mjs', 'clients/node/src/config.mjs', 'clients/node/src/poller.mjs', 'clients/node/src/transport.mjs', 'clients/node/package-lock.json',
  'clients/rust/src/main.rs', 'clients/rust/src/lib.rs', 'clients/rust/Cargo.lock',
  'sap/src/zcl_bl_bench_orders.clas.abap', 'sap/src/zcl_bl_poll_orders.clas.abap', 'contracts/seed-manifest.json', 'docs/benchmark-protocol.md',
  'scripts/run-performance-comparison.mjs', 'scripts/benchmark-control.mjs', 'deploy/benchmark-client.mjs'];
const manifest = {
  protocol: smoke ? 'sap-http-benchmark-smoke-v1' : 'sap-http-benchmark-v1', run_id: identifier,
  started_utc: new Date().toISOString(), duration_seconds: durationSeconds, warmup_scans: warmupScans, rounds: schedule.length,
  service_root: benchmarkServiceRoot, sap_client: settings.client, identity_sha256: createHash('sha256').update(settings.username).digest('hex'),
  expected_rows: seed.expected_rows, expected_pages: 51, expected_digest: seed.expected_digest, expected_body_bytes: 1074741,
  fresh_client_per_scan: true, continuous: true, schedule, cooldown_seconds: smoke ? 0 : 5,
  external_resources: { cpus: 1, memory_bytes: 268435456, memory_plus_swap_bytes: 268435456, workers: 1 },
  host: { platform: os.platform(), release: os.release(), cpu_model: os.cpus()[0].model, logical_cpus: os.cpus().length, ram_bytes: os.totalmem() },
  docker: JSON.parse(command('docker', ['info', '--format', '{"version":{{json .ServerVersion}},"cpus":{{json .NCPU}},"memory_bytes":{{json .MemTotal}}}'])),
  sap_container: JSON.parse(command('docker', ['inspect', '--format', '{"image":{{json .Config.Image}},"memory_limit":{{json .HostConfig.Memory}},"nano_cpus":{{json .HostConfig.NanoCpus}},"cpuset_cpus":{{json .HostConfig.CpusetCpus}}}', 'a4h'])),
  images: { node: inspectImage('sap-polling-node:benchmark'), rust: inspectImage('sap-polling-rust:benchmark') },
  source_revision: command('git', ['rev-parse', 'HEAD']),
  source_inputs: files.map(path => ({ path, sha256: createHash('sha256').update(readFileSync(resolve(projectRoot, path))).digest('hex') })),
  baseline_resources: await resourceSnapshot(['a4h', 'sap-local-ports', 'sap-polling-lab-control-plane']),
  blocks: [], status: 'running',
};
json('manifest.json', manifest);
console.log(JSON.stringify({ event: 'started', directory: relative(projectRoot, runDirectory), duration_seconds: durationSeconds, blocks: schedule.flat().length }));
let currentBlock = 0;
try {
  for (let round = 0; round < schedule.length; round++) {
    for (const implementation of schedule[round]) {
      currentBlock++;
      const path = `block-${String(currentBlock).padStart(2, '0')}-${implementation}.json`;
      const name = `sap-bench-${implementation}-${identifier.replace(/[^0-9]/g, '').slice(0, 14)}-${currentBlock}`;
      const started = performance.now();
      const startedUtc = new Date().toISOString();
      const resourceSamples = [];
      const pendingSamples = [];
      console.log(JSON.stringify({ event: 'block_started', block: currentBlock, round: round + 1, implementation, started_utc: startedUtc }));
      json('progress.json', { status: 'running', block: currentBlock, round: round + 1, implementation, elapsed_seconds: 0 });
      const heartbeat = setInterval(() => {
        const progress = { status: 'running', block: currentBlock, round: round + 1, implementation, elapsed_seconds: Math.round((performance.now() - started) / 1000) };
        json('progress.json', progress); console.log(JSON.stringify({ event: 'progress', ...progress }));
        const names = ['a4h', 'sap-local-ports', ...(implementation === 'abap' ? [] : [name])];
        pendingSamples.push(resourceSnapshot(names).then(data => { resourceSamples.push({ at_utc: new Date().toISOString(), data }); }));
      }, 30000);
      let execution;
      try {
        execution = implementation === 'abap'
          ? { code: 0, output: await runAbapBenchmark({ durationSeconds, warmupScans, manifest: seed }), stderr_bytes: 0 }
          : await executeExternal(implementation, name);
      } finally { clearInterval(heartbeat); }
      await Promise.all(pendingSamples);
      const records = parseRecords(execution.output);
      const verification = validate(records);
      const block = { block_index: currentBlock, round: round + 1, implementation, started_utc: startedUtc,
        finished_utc: new Date().toISOString(), control_wall_ms: performance.now() - started, exit_code: execution.code,
        stderr_bytes: execution.stderr_bytes, verification, resource_samples: resourceSamples, records };
      json(path, block);
      manifest.blocks.push({ path, round: round + 1, implementation, passed: verification.passed && execution.code === 0 });
      json('manifest.json', manifest);
      console.log(JSON.stringify({ event: 'block_finished', block: currentBlock, implementation, ...verification }));
      if (!verification.passed || execution.code !== 0) throw new Error('BENCHMARK_CORRECTNESS_GATE_FAILED');
      if (!smoke && currentBlock < schedule.flat().length) await new Promise(resolveWait => setTimeout(resolveWait, 5000));
    }
  }
  manifest.status = 'complete'; manifest.finished_utc = new Date().toISOString();
  json('manifest.json', manifest); json('progress.json', { status: 'complete', blocks: currentBlock });
  console.log(JSON.stringify({ event: 'complete', directory: relative(projectRoot, runDirectory), blocks: currentBlock }));
} catch (error) {
  manifest.status = 'failed'; manifest.finished_utc = new Date().toISOString(); manifest.failure = error.message;
  json('manifest.json', manifest); json('progress.json', { status: 'failed', block: currentBlock, error: error.message });
  console.error(JSON.stringify({ event: 'failed', block: currentBlock, error: error.message }));
  process.exitCode = 1;
}
