import { mkdirSync, readFileSync, writeFileSync, copyFileSync } from 'node:fs';
import { resolve, relative, dirname, isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import os from 'node:os';
import { performance } from 'node:perf_hooks';
import { isDeepStrictEqual } from 'node:util';
import { sapSettings, pollerEnvironment } from './sap-runtime.mjs';
import { benchmarkServiceRoot, runAbapBenchmark, runCdsBenchmark } from './benchmark-control.mjs';
import { runNativeAbapBenchmark } from './native-benchmark-control.mjs';
import { benchmarkCommand as httpCommand } from '../deploy/benchmark-client.mjs';
import { projectRoot, loadRuntime, nativeEnvironment, nativeDockerCommand, invoke, dockerProgram } from '../deploy/sql/native-runtime.mjs';
import { loadOdbcRuntime, odbcEnvironment, odbcDockerCommand, servicePath, sapCertificateHost, driverDirectory } from '../deploy/sql/odbc-runtime.mjs';
import { controlTimingValid } from './benchmark-timing.mjs';
import { validateNineReadiness } from './nine-readiness.mjs';
import { assertEvidenceSafe } from './evidence-safety.mjs';
import { assertHostMemory, hostMemorySamplesValid, minimumHostFreeMemoryBytes } from './benchmark-memory.mjs';
export { assertHostMemory } from './benchmark-memory.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');
const languages = ['node', 'rust', 'abap'];
const approaches = ['http', 'cds', 'native'];
export const applications = languages.flatMap(language => approaches.map(approach => ({ app_id: `${language}-${approach}`, language, implementation: language, approach })));

export function nineImageTag(tag) {
  return typeof tag === 'string' && !/\s/.test(tag) && /^sap-polling-(node|rust):nine-(fixed-)?(http|sql)$/.test(tag);
}

export function assertReadinessRuntime(readiness, inputs) {
  for (const app of applications.filter(app => app.language !== 'abap')) {
    if (!readiness.images?.[app.app_id]?.id || inputs.images?.[app.app_id]?.id !== readiness.images[app.app_id].id) throw new Error('READINESS_IMAGE_CHANGED');
  }
  for (const field of ['sap_container', 'driver_files', 'topology']) {
    if (!readiness[field] || !isDeepStrictEqual(inputs[field], readiness[field])) throw new Error(`READINESS_${field.toUpperCase()}_CHANGED`);
  }
}

// Each application occupies every third of the round and every slot in a trio once.
export function nineSchedule(rounds = 3) {
  if (![1, 3].includes(rounds)) throw new Error('INVALID_ROUND_COUNT');
  return Array.from({ length: rounds }, (_, round) => Array.from({ length: 9 }, (_, position) => {
    const third = Math.floor(position / 3), slot = position % 3;
    return `${languages[(slot + round) % 3]}-${approaches[(third + slot + 2 * round) % 3]}`;
  }));
}

export function nineCommand(app, { name, durationSeconds, warmupScans, address, image }) {
  if (!applications.some(value => value.app_id === app.app_id && value.language === app.language && value.approach === app.approach) || app.language === 'abap') throw new Error('INVALID_EXTERNAL_APPLICATION');
  if (!/^sha256:[a-f0-9]{64}$/.test(image)) throw new Error('PINNED_IMAGE_ID_REQUIRED');
  let command;
  if (app.approach === 'http') command = httpCommand(app.language, { name, durationSeconds, warmupScans });
  else {
    command = app.approach === 'native' ? nativeDockerCommand(app.language, { name }) : odbcDockerCommand(app.language, address, { name });
    if (app.language === 'node') command.args[command.args.indexOf('/app/src/sql-cli.mjs')] = '/app/src/sql-benchmark.mjs';
    else command.args.push('--benchmark');
    command.args.push('--duration-seconds', String(durationSeconds), '--warmup-scans', String(warmupScans));
  }
  const imageIndex = command.args.findIndex(value => value.startsWith(`sap-polling-${app.language}:`));
  if (imageIndex < 0) throw new Error('IMAGE_ARGUMENT_NOT_FOUND');
  command.args[imageIndex] = image;
  return command;
}

export function validateNineRecords(records, app, { durationSeconds, warmupScans, seed, control }) {
  if (!Array.isArray(records) || !app || !applications.some(value => value.app_id === app.app_id && value.language === app.language && value.approach === app.approach)) throw new Error('INVALID_APPLICATION_RECORDS');
  const scans = records.filter(record => record?.kind === 'scan'), summaries = records.filter(record => record?.kind === 'summary');
  if (summaries.length !== 1 || records.length !== scans.length + 1 || records.at(-1) !== summaries[0]) throw new Error('INVALID_BENCHMARK_OUTPUT');
  const summary = summaries[0], warmup = scans.filter(record => record.phase === 'warmup'), measured = scans.filter(record => record.phase === 'measured');
  const isAbap = app.language === 'abap', isHttp = app.approach === 'http', isCds = app.approach === 'cds';
  const pages = isAbap && isCds ? 50 : 51, bodyBytes = isHttp ? 1074741 : 0;
  const transport = isHttp ? (isAbap ? 'classic_socket' : 'socket') : isCds ? (isAbap ? 'direct_cds' : 'odbc') : (isAbap ? 'native_hana_adbc' : 'hana');
  const metric = value => typeof value === 'number' && Number.isFinite(value) && value >= 0;
  const failures = scans.flatMap((scan, index) => {
    const valid = scan.schema_version === 1 && scan.outcome === 'ok' && scan.error === null && scan.rows === seed.expected_rows &&
      scan.pages === pages && scan.digest === seed.expected_digest && scan.metrics?.body_bytes === bodyBytes &&
      metric(scan.metrics?.elapsed_ms) && Number.isSafeInteger(scan.metrics?.missed_slots) && scan.metrics.missed_slots >= 0 &&
      (!(isAbap && !isHttp) || (scan.transport === transport && scan.http_requests === 0 && (isCds ? scan.application_batches === 50 : scan.logical_fetches === 51)));
    return valid ? [] : [index];
  });
  const sequence = warmup.length === warmupScans && measured.length > 0 &&
    scans.slice(0, warmupScans).every((scan, index) => scan.phase === 'warmup' && scan.scan_index === index) &&
    scans.slice(warmupScans).every((scan, index) => scan.phase === 'measured' && scan.scan_index === index + (isAbap ? 0 : warmupScans));
  const timing = metric(summary.measured_wall_ms) && summary.measured_wall_ms >= durationSeconds * 1000 &&
    measured.reduce((sum, scan) => sum + (scan.metrics?.elapsed_ms ?? NaN), 0) <= summary.measured_wall_ms + 2 &&
    controlTimingValid(control, summary, warmup);
  let summaryValid = summary.transport === transport && summary.warmup_scans === warmupScans && summary.measured_scans === measured.length;
  if (isAbap) {
    summaryValid &&= summary.duration_seconds === durationSeconds && summary.failed_scans === 0 && summary.measured_valid_rows === measured.length * seed.expected_rows && summary.measured_body_bytes === measured.length * bodyBytes;
    if (isHttp) summaryValid &&= summary.service_root === benchmarkServiceRoot && summary.authentication === 'preemptive_basic';
    else summaryValid &&= summary.http_requests === 0 && summary.sap_client === '001' && summary.db_package_size === 100 &&
      summary.entity === (isCds ? 'ZI_BL_OrderPosition' : 'ZBL_BENCH_SQL.ORDER_POSITIONS_001') &&
      (isCds ? summary.measured_application_batches === measured.length * 50 : summary.measured_logical_fetches === measured.length * 51);
  } else {
    summaryValid &&= summary.outcome === 'ok' && summary.client_policy === (isHttp ? 'fresh_per_scan' : 'persistent');
    if (!isHttp) summaryValid &&= summary.fetch_size === 100;
  }
  return { passed: failures.length === 0 && sequence && timing && summaryValid, failures: failures.length, failing_scan_records: failures,
    sequence_valid: sequence, timing_valid: timing, summary_valid: summaryValid, warmup_scans: warmup.length, measured_scans: measured.length,
    measured_wall_ms: summary.measured_wall_ms, expected_pages: pages, expected_body_bytes: bodyBytes };
}

async function checked(program, args) {
  const result = await invoke(program, args, { timeout: 30000, maxBytes: 4194304 });
  if (result.status !== 0 || result.timed_out || result.oversized) throw new Error('PROVENANCE_COMMAND_FAILED');
  return result.stdout.trim();
}
async function inspectImage(tag) {
  return JSON.parse(await checked(dockerProgram, ['image', 'inspect', '--format', '{"id":{{json .Id}},"repo_digests":{{json .RepoDigests}},"architecture":{{json .Architecture}},"os":{{json .Os}}}', tag]));
}
async function snapshot(names) {
  const cpuTimes = Object.values(os.cpus().reduce((total, cpu) => {
    for (const [key, value] of Object.entries(cpu.times)) total[key] = (total[key] || 0) + value;
    return total;
  }, {}));
  const host = { free_memory_bytes: os.freemem(), total_memory_bytes: os.totalmem(), cpu_time_ms: cpuTimes.reduce((total, value) => total + value, 0),
    cpu_idle_ms: os.cpus().reduce((total, cpu) => total + cpu.times.idle, 0) };
  const result = await invoke(dockerProgram, ['stats', '--no-stream', '--format', '{{json .}}', ...names], { timeout: 20000 });
  if (result.status !== 0 || result.timed_out) return { passed: false, timed_out: result.timed_out, samples: [], host };
  try { return { passed: true, samples: result.stdout.split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line)), host }; }
  catch { return { passed: false, samples: [], host }; }
}

export async function runNineComparison(smoke) {
  const inputPath = resolve(process.env.NINE_INPUTS_FILE || resolve(projectRoot, 'work/nine-readiness/inputs.json'));
  const providedBytes = readFileSync(inputPath), provided = JSON.parse(providedBytes);
  if (!provided.images || (!smoke && provided.readiness?.ready !== true)) throw new Error('NINE_READINESS_REQUIRED');
  const readiness = smoke ? null : await validateNineReadiness(provided, { root: projectRoot });
  const durationSeconds = smoke ? 3 : 180, warmupScans = smoke ? 1 : 5, schedule = nineSchedule(smoke ? 1 : 3);
  const [native, odbc] = await Promise.all([loadRuntime(), loadOdbcRuntime()]);
  const seed = native.manifest, settings = sapSettings();
  if (seed.expected_rows !== 5000 || seed.expected_digest !== odbc.manifest.expected_digest || !settings.local || settings.client !== '001') throw new Error('FROZEN_LOCAL_DATA_REQUIRED');
  const sensitive = [settings.password, native.settings.HANA_PASSWORD, `Basic ${Buffer.from(`${settings.username}:${settings.password}`).toString('base64')}`, odbcEnvironment(settings, seed).ABAP_ODBC_CONNECTION_STRING].filter(Boolean);
  const safe = value => { if (sensitive.some(secret => value.includes(secret))) throw new Error('OUTPUT_REDACTION_FAILED'); return value; };
  safe(providedBytes.toString('utf8'));
  assertEvidenceSafe('readiness-input.json', providedBytes, { secrets: sensitive });
  const identifier = new Date().toISOString().replace(/[:.]/g, '-');
  const directory = resolve(projectRoot, 'results', `nine-${smoke ? 'smoke-' : ''}${identifier}`);
  mkdirSync(directory, { recursive: true });
  const json = (file, value, immutable = false) => writeFileSync(resolve(directory, file), safe(JSON.stringify(value, null, 2) + '\n'), { flag: immutable ? 'wx' : 'w' });
  const sourceFiles = [...new Set(['scripts/run-nine-comparison.mjs', 'scripts/benchmark-control.mjs', 'scripts/native-benchmark-control.mjs',
    'deploy/benchmark-client.mjs', 'deploy/sql/native-runtime.mjs', 'deploy/sql/odbc-runtime.mjs',
    'contracts/seed-manifest.json', 'contracts/fixtures.json', 'contracts/native-hana.sql', 'contracts/abap-cds-odbc.sql', ...(provided.source_files || [])])];
  const archive = (path, prefix) => {
    if (isAbsolute(path) || path.split(/[\\/]/).includes('..')) throw new Error('PROJECT_RELATIVE_EVIDENCE_REQUIRED');
    const bytes = readFileSync(resolve(projectRoot, path));
    assertEvidenceSafe(path, bytes, { secrets: sensitive });
    safe(bytes.toString('utf8'));
    const target = `${prefix}/${path}`, absoluteTarget = resolve(directory, target);
    mkdirSync(dirname(absoluteTarget), { recursive: true }); copyFileSync(resolve(projectRoot, path), absoluteTarget);
    return { path, sha256: hash(bytes), snapshot: target };
  };
  const sources = sourceFiles.map(path => archive(path, 'sources'));
  const evidence = (provided.evidence_files || []).map(path => archive(path, 'evidence'));
  const images = {};
  for (const app of applications.filter(app => app.language !== 'abap')) {
    const tag = provided.images[app.app_id] || provided.images[`${app.language}_${app.approach}`];
    if (!nineImageTag(tag)) throw new Error('DEDICATED_NINE_IMAGE_REQUIRED');
    images[app.app_id] = { tag, ...await inspectImage(tag) };
  }
  const assertInputs = async () => {
    if (!smoke) assertHostMemory(os.freemem());
    for (const source of sources) if (hash(readFileSync(resolve(projectRoot, source.path))) !== source.sha256) throw new Error('SOURCE_CHANGED_DURING_RUN');
    for (const driver of odbc.driver_files) if (hash(readFileSync(resolve(driverDirectory, driver.name))) !== driver.sha256) throw new Error('ODBC_DRIVER_CHANGED_DURING_RUN');
    if (hash(readFileSync(inputPath)) !== hash(providedBytes)) throw new Error('READINESS_INPUT_CHANGED_DURING_RUN');
    for (const image of Object.values(images)) if ((await inspectImage(image.tag)).id !== image.id) throw new Error('RUNTIME_IMAGE_CHANGED_DURING_RUN');
    const sap = JSON.parse(await checked(dockerProgram, ['inspect', '--format', '{"image":{{json .Config.Image}},"memory_limit":{{json .HostConfig.Memory}},"memory_swap_limit":{{json .HostConfig.MemorySwap}},"nano_cpus":{{json .HostConfig.NanoCpus}},"started_at":{{json .State.StartedAt}}}', 'a4h']));
    const docker = JSON.parse(await checked(dockerProgram, ['info', '--format', '{"version":{{json .ServerVersion}},"cpus":{{json .NCPU}},"memory_bytes":{{json .MemTotal}}}']));
    if (!isDeepStrictEqual(sap, inputs.sap_container) || !isDeepStrictEqual(docker, inputs.docker)) throw new Error('SAP_RESTARTED_OR_RESOURCE_CONFIGURATION_CHANGED');
  };
  const inputs = {
    schema_version: 1, protocol: smoke ? 'sap-nine-path-benchmark-smoke-v1' : 'sap-nine-path-benchmark-v1', run_id: identifier, started_utc: new Date().toISOString(),
    configuration: { duration_seconds: durationSeconds, warmup_scans: warmupScans, rounds: schedule.length, cooldown_seconds: smoke ? 0 : 5, sap_client: '001',
      expected_rows: seed.expected_rows, expected_digest: seed.expected_digest, continuous: true, concurrency: 1, output_buffered_until_after_timing: true,
      resource_sample_interval_seconds: 30, external_resources: { cpus: 1, memory_bytes: 268435456, memory_swap_bytes: 268435456, workers: 1 },
      deadlines: { external_request_seconds: 10, scan_seconds: 120, external_process_seconds: durationSeconds + 300 }, retries: 0,
      minimum_host_free_memory_bytes: smoke ? 0 : minimumHostFreeMemoryBytes },
    apps: applications, schedule, images, source_inputs: sources, evidence_files: evidence, readiness_input: { sha256: hash(providedBytes), path: relative(projectRoot, inputPath) },
    readiness: provided.readiness, provenance: provided.provenance || {}, source_revision: await checked('git', ['rev-parse', 'HEAD']), working_tree_status: await checked('git', ['status', '--short']),
    queries: { native: { path: 'contracts/native-hana.sql', sha256: native.query_sha256 }, cds: { path: 'contracts/abap-cds-odbc.sql', sha256: odbc.query_sha256 } },
    driver_files: odbc.driver_files, topology: { network: 'sap-local-ports', http_endpoint: benchmarkServiceRoot, cds_host: sapCertificateHost, cds_service_path: servicePath,
      cds_tls_verified: true, cds_driver_mount_read_only: true, native_server: native.settings.HANA_SERVER, sap_client: '001',
      sap_identity_sha256: hash(settings.username), hana_identity_sha256: hash(native.settings.HANA_USER), identities_equal: false },
    host: { platform: os.platform(), release: os.release(), cpu_model: os.cpus()[0].model, logical_cpus: os.cpus().length, ram_bytes: os.totalmem() },
    docker: JSON.parse(await checked(dockerProgram, ['info', '--format', '{"version":{{json .ServerVersion}},"cpus":{{json .NCPU}},"memory_bytes":{{json .MemTotal}}}'])),
    sap_container: JSON.parse(await checked(dockerProgram, ['inspect', '--format', '{"image":{{json .Config.Image}},"memory_limit":{{json .HostConfig.Memory}},"memory_swap_limit":{{json .HostConfig.MemorySwap}},"nano_cpus":{{json .HostConfig.NanoCpus}},"started_at":{{json .State.StartedAt}}}', 'a4h'])),
    access_differences: { http: 'All three use the same OData HTTP endpoint, 51 requests and 1074741 response body bytes; fresh HTTP client per scan.',
      cds: 'ABAP uses internal Open SQL against CDS (50 nonempty packages); external clients use SAP ABAP ODBC over verified HTTPS (51 logical fetch attempts).',
      native: 'ABAP uses its existing primary HANA ADBC connection; external clients use a separate read-only HANA principal. All use 51 logical fetch attempts.',
      resource_limits: 'The 1 CPU/256 MiB limits apply to external clients. ABAP runs inside the shared SAP container and is not isolated to these limits.',
      sql_connection_lifecycle: 'Persistent block connection, new cursor per scan. First connection is in warmup; final session teardown is outside the measured window.',
      deadlines: 'External requests and ABAP HTTP use 10 seconds; every scan uses 120 seconds. ABAP CDS/ADBC cannot enforce the same per-call cancellation as external drivers.',
      byte_metrics: 'SQL body_bytes=0 means no HTTP application response body metric, not zero network traffic.' },
  };
  if (readiness) assertReadinessRuntime(readiness, inputs);
  json('inputs.json', inputs, true); writeFileSync(resolve(directory, 'readiness-input.json'), safe(providedBytes.toString('utf8')), { flag: 'wx' });
  const manifest = { schema_version: 1, protocol: inputs.protocol, run_id: identifier, inputs_file: 'inputs.json', inputs_sha256: hash(readFileSync(resolve(directory, 'inputs.json'))),
    status: 'running', started_utc: inputs.started_utc, duration_seconds: durationSeconds, warmup_scans: warmupScans, rounds: schedule.length, schedule, blocks: [], baseline_resources: await snapshot(['a4h', 'sap-local-ports', 'sap-polling-lab-control-plane']) };
  json('manifest.json', manifest);
  console.log(JSON.stringify({ event: 'started', directory: relative(projectRoot, directory), blocks: schedule.flat().length, duration_seconds: durationSeconds }));
  let blockIndex = 0;
  try {
    for (let round = 0; round < schedule.length; round++) for (const appId of schedule[round]) {
      await assertInputs();
      const app = applications.find(value => value.app_id === appId); blockIndex++;
      const path = `block-${String(blockIndex).padStart(2, '0')}-${appId}.json`, rawPath = path.replace('.json', '.ndjson');
      const prefix = app.approach === 'native' ? 'native-hana' : app.approach === 'cds' ? 'cds-odbc' : 'nine-http';
      const name = `${prefix}-${app.language}-${identifier.replace(/\D/g, '').slice(0, 14)}-${blockIndex}`;
      const started = performance.now(), startedUtc = new Date().toISOString(), resources = [], pending = [];
      console.log(JSON.stringify({ event: 'block_started', block: blockIndex, round: round + 1, app_id: appId, started_utc: startedUtc }));
      json('progress.json', { status: 'running', block: blockIndex, round: round + 1, app_id: appId, elapsed_seconds: 0 });
      const heartbeat = setInterval(() => {
        const progress = { status: 'running', block: blockIndex, round: round + 1, app_id: appId, elapsed_seconds: Math.round((performance.now() - started) / 1000) };
        json('progress.json', progress); console.log(JSON.stringify({ event: 'progress', ...progress }));
        pending.push(snapshot(['a4h', 'sap-local-ports', ...(app.language === 'abap' ? [] : [name])]).then(data => resources.push({ at_utc: new Date().toISOString(), ...data })));
      }, 30000);
      let execution;
      try {
        if (app.language === 'abap') {
          const run = app.approach === 'http' ? runAbapBenchmark : app.approach === 'cds' ? runCdsBenchmark : runNativeAbapBenchmark;
          execution = { status: 0, stdout: await run({ durationSeconds, warmupScans, manifest: seed }), timed_out: false, oversized: false };
        } else {
          const command = nineCommand(app, { name, durationSeconds, warmupScans, address: odbc.address, image: images[appId].id });
          const environment = app.approach === 'http' ? { ...pollerEnvironment(settings, seed), SAP_SERVICE_ROOT: benchmarkServiceRoot, SAP_TLS_INSECURE: 'false', PAGE_SIZE: '500', REQUEST_TIMEOUT_SECONDS: '10', SCAN_TIMEOUT_SECONDS: '120', MAX_BODY_BYTES: '8388608', MAX_PAGES: '10000' }
            : { ...process.env, ...(app.approach === 'cds' ? odbcEnvironment(settings, seed) : nativeEnvironment(native.settings, seed)), REQUEST_TIMEOUT_SECONDS: '10' };
          execution = await invoke(command.program, command.args, { env: environment, timeout: (durationSeconds + 300) * 1000, maxBytes: 67108864 });
          if (execution.timed_out || execution.oversized) await invoke(dockerProgram, ['rm', '--force', name]);
        }
      } catch (error) {
        execution = { status: null, stdout: '', timed_out: error.message === 'CONTROL_TIMEOUT', oversized: false, failure: safe(error.message) };
      } finally { clearInterval(heartbeat); }
      const finishedUtc = new Date().toISOString(), controlWall = performance.now() - started;
      await Promise.all(pending);
      const output = safe(execution.stdout); writeFileSync(resolve(directory, rawPath), output, { flag: 'wx' });
      let records, verification;
      try { records = output.split(/\r?\n/).filter(line => line.trim()).map(line => JSON.parse(line)); verification = validateNineRecords(records, app, { durationSeconds, warmupScans, seed,
        control: { started_utc: startedUtc, finished_utc: finishedUtc, control_wall_ms: controlWall } }); }
      catch { records = []; verification = { passed: false, failures: null, reason: 'Malformed or incomplete benchmark output' }; }
      verification.host_memory_valid = smoke || hostMemorySamplesValid(resources);
      verification.passed &&= verification.host_memory_valid;
      const block = { block_index: blockIndex, round: round + 1, ...app, started_utc: startedUtc, finished_utc: finishedUtc, control_wall_ms: controlWall,
        exit_code: execution.status, timed_out: execution.timed_out, oversized: execution.oversized, execution_failure: execution.failure || null,
        raw_file: rawPath, raw_sha256: hash(output), verification, resource_samples: resources, records };
      json(path, block, true);
      const passed = verification.passed && execution.status === 0 && !execution.timed_out && !execution.oversized;
      manifest.blocks.push({ path, sha256: hash(readFileSync(resolve(directory, path))), round: round + 1, ...app, passed }); json('manifest.json', manifest);
      console.log(JSON.stringify({ event: 'block_finished', block: blockIndex, app_id: appId, exit_code: execution.status, ...verification }));
      if (!passed) throw new Error('NINE_BENCHMARK_CORRECTNESS_GATE_FAILED');
      if (!smoke && blockIndex < schedule.flat().length) await new Promise(accept => setTimeout(accept, 5000));
    }
    await assertInputs();
    manifest.final_images = {};
    for (const [appId, image] of Object.entries(images)) manifest.final_images[appId] = { tag: image.tag, ...await inspectImage(image.tag) };
    manifest.final_resources = await snapshot(['a4h', 'sap-local-ports', 'sap-polling-lab-control-plane']);
    manifest.status = 'complete'; manifest.finished_utc = new Date().toISOString();
    json('manifest.json', manifest); json('progress.json', { status: 'complete', blocks: blockIndex });
    console.log(JSON.stringify({ event: 'complete', directory: relative(projectRoot, directory), blocks: blockIndex }));
  } catch (error) {
    manifest.status = 'failed'; manifest.finished_utc = new Date().toISOString(); manifest.failure = safe(error.message);
    json('manifest.json', manifest); json('progress.json', { status: 'failed', block: blockIndex, error: manifest.failure });
    throw error;
  }
  return relative(projectRoot, directory);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  if (args.length > 1 || (args.length === 1 && args[0] !== '--smoke')) throw new Error('Use --smoke or no arguments');
  await runNineComparison(args[0] === '--smoke').catch(error => { console.error(JSON.stringify({ event: 'failed', error: error.message })); process.exitCode = 1; });
}
