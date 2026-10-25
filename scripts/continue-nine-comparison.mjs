import { mkdirSync, readFileSync, writeFileSync, copyFileSync } from 'node:fs';
import { dirname, resolve, relative, isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { isDeepStrictEqual } from 'node:util';
import os from 'node:os';
import { applications, nineSchedule, nineCommand, validateNineRecords } from './run-nine-comparison.mjs';
import { controlTimingValid } from './benchmark-timing.mjs';
import { sapSettings, pollerEnvironment } from './sap-runtime.mjs';
import { benchmarkServiceRoot, runAbapBenchmark, runCdsBenchmark } from './benchmark-control.mjs';
import { runNativeAbapBenchmark } from './native-benchmark-control.mjs';
import { projectRoot, loadRuntime, nativeEnvironment, invoke, dockerProgram } from '../deploy/sql/native-runtime.mjs';
import { loadOdbcRuntime, odbcEnvironment, driverDirectory } from '../deploy/sql/odbc-runtime.mjs';
import { assertEvidenceSafe } from './evidence-safety.mjs';
import { assertHostMemory, hostMemorySamplesValid } from './benchmark-memory.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');
const jsonBytes = path => readFileSync(path);
const read = path => JSON.parse(jsonBytes(path));
function relativePath(path) {
  if (typeof path !== 'string' || !path || isAbsolute(path) || path.split(/[\\/]/).includes('..')) throw new Error('PROJECT_RELATIVE_PATH_REQUIRED');
  return path;
}

export function continuationPlan(manifest, inputs, blocks) {
  const config = inputs.configuration;
  if (manifest.status !== 'failed' || inputs.protocol !== 'sap-nine-path-benchmark-v1' || manifest.failure !== 'NINE_BENCHMARK_CORRECTNESS_GATE_FAILED' ||
    config.duration_seconds !== 180 || config.warmup_scans !== 5 || config.rounds !== 3 || config.cooldown_seconds !== 5 ||
    config.expected_rows !== 5000 || config.sap_client !== '001' || config.concurrency !== 1 || config.retries !== 0 ||
    !isDeepStrictEqual(inputs.schedule, nineSchedule()) || !isDeepStrictEqual(manifest.schedule, inputs.schedule) ||
    !Array.isArray(blocks) || blocks.length !== manifest.blocks.length || blocks.length < 1 || blocks.length > 27) throw new Error('UNSUPPORTED_CONTINUATION_PARENT');
  const schedule = inputs.schedule.flat(), seed = { expected_rows: config.expected_rows, expected_digest: config.expected_digest };
  for (let index = 0; index < blocks.length; index++) {
    const block = blocks[index], entry = manifest.blocks[index], app = applications.find(app => app.app_id === schedule[index]);
    if (block.block_index !== index + 1 || block.app_id !== app.app_id || entry.app_id !== app.app_id ||
      block.round !== Math.floor(index / 9) + 1 || block.language !== app.language || block.approach !== app.approach) throw new Error('PARENT_BLOCK_SCHEDULE_MISMATCH');
    const verification = validateNineRecords(block.records, app, { durationSeconds: 180, warmupScans: 5, seed, control: block });
    const passed = verification.passed && block.exit_code === 0 && !block.timed_out && !block.oversized;
    if (index < blocks.length - 1 && (!passed || entry.passed !== true || !hostMemorySamplesValid(block.resource_samples))) throw new Error('PARENT_ADOPTED_BLOCK_INVALID');
    if (index === blocks.length - 1 && (passed || entry.passed !== false || verification.measured_scans !== 0 ||
      block.records.some(record => record.kind === 'scan' && record.phase === 'measured'))) throw new Error('ONLY_FAILED_WARMUP_CAN_BE_RETRIED');
    if (index === blocks.length - 1) {
      const scans = block.records.filter(record => record.kind === 'scan'), failure = scans.at(-1), summary = block.records.at(-1);
      if (!scans.length || scans.some((scan, index) => scan.phase !== 'warmup' || scan.scan_index !== index) ||
        failure.outcome !== 'error' || typeof failure.error?.code !== 'string' || failure.digest !== null ||
        scans.slice(0, -1).some(scan => scan.outcome !== 'ok' || scan.error !== null || scan.rows !== config.expected_rows || scan.digest !== config.expected_digest) ||
        summary.outcome !== 'error' || summary.warmup_scans !== scans.length || !controlTimingValid(block, summary, scans)) throw new Error('ONLY_FAILED_WARMUP_CAN_BE_RETRIED');
    }
  }
  return { adopted_count: blocks.length - 1, retry_block_index: blocks.length, failed_block: blocks.at(-1), remaining_app_ids: schedule.slice(blocks.length - 1) };
}

async function checked(args) {
  const result = await invoke(dockerProgram, args, { timeout: 30000, maxBytes: 4194304 });
  if (result.status !== 0 || result.timed_out || result.oversized) throw new Error('PROVENANCE_COMMAND_FAILED');
  return result.stdout.trim();
}
const image = async tag => JSON.parse(await checked(['image', 'inspect', '--format', '{"id":{{json .Id}},"repo_digests":{{json .RepoDigests}},"architecture":{{json .Architecture}},"os":{{json .Os}}}', tag]));
const sapContainer = async () => JSON.parse(await checked(['inspect', '--format', '{"image":{{json .Config.Image}},"memory_limit":{{json .HostConfig.Memory}},"memory_swap_limit":{{json .HostConfig.MemorySwap}},"nano_cpus":{{json .HostConfig.NanoCpus}},"started_at":{{json .State.StartedAt}}}', 'a4h']));
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

export async function continueNineComparison(parentPath) {
  assertHostMemory(os.freemem());
  const parentRelative = relativePath(parentPath), parent = resolve(projectRoot, parentRelative);
  const parentManifestBytes = jsonBytes(resolve(parent, 'manifest.json')), originalInputsBytes = jsonBytes(resolve(parent, 'inputs.json'));
  const originalManifest = JSON.parse(parentManifestBytes), inputs = JSON.parse(originalInputsBytes);
  if (hash(originalInputsBytes) !== originalManifest.inputs_sha256) throw new Error('PARENT_INPUT_HASH_MISMATCH');
  const blocks = originalManifest.blocks.map(entry => {
    const bytes = jsonBytes(resolve(parent, relativePath(entry.path)));
    if (hash(bytes) !== entry.sha256) throw new Error('PARENT_BLOCK_HASH_MISMATCH');
    const block = JSON.parse(bytes), rawBytes = jsonBytes(resolve(parent, relativePath(block.raw_file)));
    if (hash(rawBytes) !== block.raw_sha256) throw new Error('PARENT_RAW_HASH_MISMATCH');
    return block;
  });
  const plan = continuationPlan(originalManifest, inputs, blocks);
  const proofPath = resolve(process.env.NINE_CONTINUATION_PROOF || resolve(projectRoot, 'work/nine-readiness/continuation-proof.json'));
  const proofBytes = jsonBytes(proofPath), proof = JSON.parse(proofBytes);
  if (proof.ready !== true || proof.unchanged_workload !== true || proof.unchanged_runtime_configuration !== true || proof.sap_not_restarted !== true ||
    !Array.isArray(proof.diagnostics) || proof.diagnostics.length < 1 || typeof proof.explanation !== 'string' || !proof.explanation.trim()) throw new Error('EXPLICIT_CONTINUATION_PROOF_REQUIRED');
  const [native, odbc] = await Promise.all([loadRuntime(), loadOdbcRuntime()]);
  const settings = sapSettings(), seed = native.manifest;
  if (!settings.local || settings.client !== '001' || seed.expected_rows !== inputs.configuration.expected_rows || seed.expected_digest !== inputs.configuration.expected_digest ||
    odbc.manifest.expected_digest !== seed.expected_digest || native.query_sha256 !== inputs.queries.native.sha256 || odbc.query_sha256 !== inputs.queries.cds.sha256 ||
    hash(settings.username) !== inputs.topology.sap_identity_sha256 || hash(native.settings.HANA_USER) !== inputs.topology.hana_identity_sha256 ||
    native.settings.HANA_SERVER !== inputs.topology.native_server || !isDeepStrictEqual(odbc.driver_files, inputs.driver_files)) throw new Error('WORKLOAD_IDENTITY_OR_RUNTIME_CHANGED');
  const secrets = [settings.password, native.settings.HANA_PASSWORD, `Basic ${Buffer.from(`${settings.username}:${settings.password}`).toString('base64')}`, odbcEnvironment(settings, seed).ABAP_ODBC_CONNECTION_STRING].filter(Boolean);
  const safe = text => { if (secrets.some(secret => text.includes(secret))) throw new Error('OUTPUT_REDACTION_FAILED'); return text; };
  const assertInputs = async () => {
    assertHostMemory(os.freemem());
    if (hash(jsonBytes(resolve(parent, 'manifest.json'))) !== hash(parentManifestBytes) || hash(jsonBytes(resolve(parent, 'inputs.json'))) !== hash(originalInputsBytes)) throw new Error('PARENT_RUN_CHANGED');
    if (hash(jsonBytes(proofPath)) !== hash(proofBytes)) throw new Error('CONTINUATION_PROOF_CHANGED');
    for (const source of inputs.source_inputs) {
      if (hash(jsonBytes(resolve(projectRoot, relativePath(source.path)))) !== source.sha256 ||
        hash(jsonBytes(resolve(parent, relativePath(source.snapshot)))) !== source.sha256) throw new Error('ORIGINAL_SOURCE_CHANGED');
    }
    for (const evidence of inputs.evidence_files) if (hash(jsonBytes(resolve(parent, relativePath(evidence.snapshot)))) !== evidence.sha256) throw new Error('ORIGINAL_EVIDENCE_CHANGED');
    for (const file of inputs.driver_files) if (hash(jsonBytes(resolve(driverDirectory, file.name))) !== file.sha256) throw new Error('ORIGINAL_DRIVER_CHANGED');
    for (const pinned of Object.values(inputs.images)) if ((await image(pinned.tag)).id !== pinned.id) throw new Error('ORIGINAL_IMAGE_CHANGED');
    if (!isDeepStrictEqual(await sapContainer(), inputs.sap_container)) throw new Error('SAP_RESTARTED_OR_ALLOCATION_CHANGED');
    const docker = JSON.parse(await checked(['info', '--format', '{"version":{{json .ServerVersion}},"cpus":{{json .NCPU}},"memory_bytes":{{json .MemTotal}}}']));
    if (!isDeepStrictEqual(docker, inputs.docker)) throw new Error('DOCKER_CONFIGURATION_CHANGED');
  };
  await assertInputs();
  const identifier = new Date().toISOString().replace(/[:.]/g, '-'), directory = resolve(projectRoot, 'results', `nine-continued-${identifier}`);
  mkdirSync(directory);
  const json = (file, value, immutable = false) => writeFileSync(resolve(directory, file), safe(JSON.stringify(value, null, 2) + '\n'), { flag: immutable ? 'wx' : 'w' });
  const copy = (source, target) => {
    const bytes = jsonBytes(source); safe(bytes.toString('utf8'));
    assertEvidenceSafe(target, bytes, { secrets });
    const destination = resolve(directory, relativePath(target)); mkdirSync(dirname(destination), { recursive: true }); copyFileSync(source, destination);
  };
  copy(resolve(parent, 'inputs.json'), 'inputs.json'); copy(resolve(parent, 'readiness-input.json'), 'readiness-input.json');
  for (const entry of [...inputs.source_inputs, ...inputs.evidence_files]) copy(resolve(parent, relativePath(entry.snapshot)), entry.snapshot);
  const adopted = originalManifest.blocks.slice(0, plan.adopted_count);
  for (const [index, entry] of adopted.entries()) {
    const block = blocks[index];
    copy(resolve(parent, entry.path), entry.path); copy(resolve(parent, block.raw_file), block.raw_file);
  }
  copy(resolve(parent, 'manifest.json'), 'prior-attempts/manifest.failed.json');
  const failedEntry = originalManifest.blocks.at(-1), failedBlock = plan.failed_block;
  copy(resolve(parent, failedEntry.path), `prior-attempts/${failedEntry.path}`); copy(resolve(parent, failedBlock.raw_file), `prior-attempts/${failedBlock.raw_file}`);
  copy(proofPath, 'continuation-proof.json');
  const diagnostics = proof.diagnostics.map(entry => {
    const path = relativePath(entry.path), bytes = jsonBytes(resolve(projectRoot, path));
    if (hash(bytes) !== entry.sha256) throw new Error('DIAGNOSTIC_HASH_MISMATCH');
    const snapshot = `continuation-evidence/${path}`; copy(resolve(projectRoot, path), snapshot);
    return { ...entry, snapshot };
  });
  const controllerPath = 'scripts/continue-nine-comparison.mjs', controllerBytes = jsonBytes(resolve(projectRoot, controllerPath));
  copy(resolve(projectRoot, controllerPath), `controller/${controllerPath}`);
  const resumedAt = new Date();
  const amendment = {
    schema_version: 1, execution_mode: 'continued', clean_run: false, created_utc: new Date().toISOString(),
    original_run_directory: parentRelative, original_run_id: originalManifest.run_id, original_inputs_sha256: originalManifest.inputs_sha256,
    original_failed_manifest: { path: 'prior-attempts/manifest.failed.json', sha256: hash(parentManifestBytes) },
    failed_attempt: { planned_block_index: plan.retry_block_index, app_id: failedBlock.app_id, path: `prior-attempts/${failedEntry.path}`, sha256: failedEntry.sha256,
      raw_path: `prior-attempts/${failedBlock.raw_file}`, raw_sha256: failedBlock.raw_sha256, measured_scans: 0 },
    adopted_blocks: adopted.map(entry => ({ path: entry.path, sha256: entry.sha256 })), first_continued_block_index: plan.retry_block_index,
    paused_at_utc: originalManifest.finished_utc, resumed_at_utc: resumedAt.toISOString(),
    gap_before_resume_ms: resumedAt.valueOf() - Date.parse(originalManifest.finished_utc),
    proof: { path: 'continuation-proof.json', sha256: hash(proofBytes) }, diagnostics,
    controller: { path: controllerPath, sha256: hash(controllerBytes), snapshot: `controller/${controllerPath}` },
    amendment: 'Explicitly retry the failed warmup once, then continue the original planned slots. Five fresh warmups and 180 measured seconds per continued block; any further failure stops the run. Original workload and settings remain frozen.',
    limitations: ['Interrupted comparison in two temporal segments; the gap and diagnosis can affect cache and host conditions.',
      'Capacity statistics are conditional on successful warmup; the failed Node CDS warmup remains an availability failure.',
      'The 27 successful measured blocks must be reported alongside all 28 benchmark attempts.'],
  };
  json('continuation-inputs.json', amendment, true);
  const attempts = blocks.map((block, index) => ({ planned_block_index: index + 1, attempt_index: 1, app_id: block.app_id,
    status: index < plan.adopted_count ? 'passed' : 'failed', path: index < plan.adopted_count ? originalManifest.blocks[index].path : `prior-attempts/${failedEntry.path}`,
    sha256: originalManifest.blocks[index].sha256, started_utc: block.started_utc, finished_utc: block.finished_utc, adopted: index < plan.adopted_count }));
  json('attempts-initial.json', attempts, true); json('attempts.json', attempts);
  const manifest = { ...originalManifest, run_id: identifier, execution_mode: 'continued', clean_run: false, status: 'running',
    started_utc: inputs.started_utc, continuation_started_utc: new Date().toISOString(), original_run_id: originalManifest.run_id,
    continuation_inputs_file: 'continuation-inputs.json', continuation_inputs_sha256: hash(jsonBytes(resolve(directory, 'continuation-inputs.json'))),
    blocks: [...adopted], attempts_file: 'attempts.json', attempts_sha256: hash(jsonBytes(resolve(directory, 'attempts.json'))),
    continuation_baseline_resources: await snapshot(['a4h', 'sap-local-ports', 'sap-polling-lab-control-plane']) };
  delete manifest.failure; delete manifest.finished_utc;
  json('manifest.json', manifest);
  console.log(JSON.stringify({ event: 'continuation_started', directory: relative(projectRoot, directory), adopted_blocks: plan.adopted_count, explicit_retry_slot: plan.retry_block_index, remaining_blocks: plan.remaining_app_ids.length }));
  let blockIndex = plan.adopted_count;
  try {
    for (const appId of plan.remaining_app_ids) {
      await assertInputs(); blockIndex++;
      if (hash(jsonBytes(resolve(projectRoot, controllerPath))) !== amendment.controller.sha256) throw new Error('CONTINUATION_CONTROLLER_CHANGED');
      const app = applications.find(value => value.app_id === appId), round = Math.floor((blockIndex - 1) / 9) + 1;
      const path = `block-${String(blockIndex).padStart(2, '0')}-${appId}.json`, rawPath = path.replace('.json', '.ndjson');
      const prefix = app.approach === 'native' ? 'native-hana' : app.approach === 'cds' ? 'cds-odbc' : 'nine-http';
      const name = `${prefix}-${app.language}-${identifier.replace(/\D/g, '').slice(0, 14)}-${blockIndex}`;
      const started = performance.now(), startedUtc = new Date().toISOString(), resources = [], pending = [];
      const attemptIndex = blockIndex === plan.retry_block_index ? 2 : 1;
      console.log(JSON.stringify({ event: 'block_started', block: blockIndex, round, app_id: appId, attempt_index: attemptIndex, started_utc: startedUtc }));
      json('progress.json', { status: 'running', block: blockIndex, round, app_id: appId, attempt_index: attemptIndex, elapsed_seconds: 0 });
      const heartbeat = setInterval(() => {
        const progress = { status: 'running', block: blockIndex, round, app_id: appId, attempt_index: attemptIndex, elapsed_seconds: Math.round((performance.now() - started) / 1000) };
        json('progress.json', progress); console.log(JSON.stringify({ event: 'progress', ...progress }));
        pending.push(snapshot(['a4h', 'sap-local-ports', ...(app.language === 'abap' ? [] : [name])]).then(data => resources.push({ at_utc: new Date().toISOString(), ...data })));
      }, 30000);
      let execution;
      try {
        if (app.language === 'abap') {
          const run = app.approach === 'http' ? runAbapBenchmark : app.approach === 'cds' ? runCdsBenchmark : runNativeAbapBenchmark;
          execution = { status: 0, stdout: await run({ durationSeconds: 180, warmupScans: 5, manifest: seed }), timed_out: false, oversized: false };
        } else {
          const command = nineCommand(app, { name, durationSeconds: 180, warmupScans: 5, address: odbc.address, image: inputs.images[appId].id });
          const environment = app.approach === 'http' ? { ...pollerEnvironment(settings, seed), SAP_SERVICE_ROOT: benchmarkServiceRoot, SAP_TLS_INSECURE: 'false', PAGE_SIZE: '500', REQUEST_TIMEOUT_SECONDS: '10', SCAN_TIMEOUT_SECONDS: '120', MAX_BODY_BYTES: '8388608', MAX_PAGES: '10000' }
            : { ...process.env, ...(app.approach === 'cds' ? odbcEnvironment(settings, seed) : nativeEnvironment(native.settings, seed)), REQUEST_TIMEOUT_SECONDS: '10' };
          execution = await invoke(command.program, command.args, { env: environment, timeout: 480000, maxBytes: 67108864 });
          if (execution.timed_out || execution.oversized) await invoke(dockerProgram, ['rm', '--force', name]);
        }
      } catch (error) { execution = { status: null, stdout: '', timed_out: error.message === 'CONTROL_TIMEOUT', oversized: false, failure: safe(error.message) }; }
      finally { clearInterval(heartbeat); }
      const finishedUtc = new Date().toISOString(), controlWall = performance.now() - started;
      await Promise.all(pending);
      const output = safe(execution.stdout); writeFileSync(resolve(directory, rawPath), output, { flag: 'wx' });
      let records, verification;
      try { records = output.split(/\r?\n/).filter(line => line.trim()).map(line => JSON.parse(line)); verification = validateNineRecords(records, app, { durationSeconds: 180, warmupScans: 5, seed,
        control: { started_utc: startedUtc, finished_utc: finishedUtc, control_wall_ms: controlWall } }); }
      catch { records = []; verification = { passed: false, failures: null, reason: 'Malformed or incomplete benchmark output' }; }
      verification.host_memory_valid = hostMemorySamplesValid(resources);
      verification.passed &&= verification.host_memory_valid;
      const block = { block_index: blockIndex, round, ...app, started_utc: startedUtc, finished_utc: finishedUtc, control_wall_ms: controlWall,
        exit_code: execution.status, timed_out: execution.timed_out, oversized: execution.oversized, execution_failure: execution.failure || null,
        raw_file: rawPath, raw_sha256: hash(output), verification, resource_samples: resources, records };
      json(path, block, true);
      const passed = verification.passed && execution.status === 0 && !execution.timed_out && !execution.oversized, blockHash = hash(jsonBytes(resolve(directory, path)));
      manifest.blocks.push({ path, sha256: blockHash, round, ...app, passed });
      attempts.push({ planned_block_index: blockIndex, attempt_index: attemptIndex, app_id: appId, status: passed ? 'passed' : 'failed', path, sha256: blockHash, started_utc: startedUtc, finished_utc: finishedUtc, adopted: false });
      json('attempts.json', attempts); manifest.attempts_sha256 = hash(jsonBytes(resolve(directory, 'attempts.json'))); json('manifest.json', manifest);
      console.log(JSON.stringify({ event: 'block_finished', block: blockIndex, app_id: appId, attempt_index: attemptIndex, exit_code: execution.status, ...verification }));
      if (!passed) throw new Error('CONTINUED_BENCHMARK_CORRECTNESS_GATE_FAILED');
      if (blockIndex < 27) await new Promise(accept => setTimeout(accept, 5000));
    }
    await assertInputs();
    if (hash(jsonBytes(resolve(projectRoot, controllerPath))) !== amendment.controller.sha256) throw new Error('CONTINUATION_CONTROLLER_CHANGED');
    manifest.final_images = {};
    for (const [appId, pinned] of Object.entries(inputs.images)) manifest.final_images[appId] = { tag: pinned.tag, ...await image(pinned.tag) };
    manifest.final_resources = await snapshot(['a4h', 'sap-local-ports', 'sap-polling-lab-control-plane']);
    manifest.total_attempts = attempts.length; manifest.successful_measured_blocks = manifest.blocks.filter(block => block.passed).length;
    manifest.failed_attempts = attempts.filter(attempt => attempt.status === 'failed').length;
    manifest.status = 'complete'; manifest.finished_utc = new Date().toISOString(); json('manifest.json', manifest);
    json('progress.json', { status: 'complete', blocks: blockIndex, attempts: attempts.length, execution_mode: 'continued', clean_run: false });
    console.log(JSON.stringify({ event: 'complete', directory: relative(projectRoot, directory), blocks: blockIndex, attempts: attempts.length, execution_mode: 'continued', clean_run: false }));
  } catch (error) {
    manifest.status = 'failed'; manifest.finished_utc = new Date().toISOString(); manifest.failure = safe(error.message);
    json('manifest.json', manifest); json('progress.json', { status: 'failed', block: blockIndex, error: manifest.failure }); throw error;
  }
  return relative(projectRoot, directory);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  if (args.length !== 1 || args[0].startsWith('--')) throw new Error('Provide the project-relative failed run directory');
  await continueNineComparison(args[0]).catch(error => { console.error(JSON.stringify({ event: 'failed', error: error.message })); process.exitCode = 1; });
}
