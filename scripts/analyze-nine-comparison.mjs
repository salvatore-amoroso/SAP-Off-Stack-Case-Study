#!/usr/bin/env node
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { controlTimingValid } from './benchmark-timing.mjs';
import { hostMemorySamplesValid } from './benchmark-memory.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const defaultOutput = resolve(root, 'docs');
const digest = 'df57de597e919adb10ae5365201b999788e86b39219ad040ffbc305539180bc7';
const languages = ['abap', 'node', 'rust'], approaches = ['http', 'cds', 'native'];
const names = { abap: 'ABAP', node: 'Node.js', rust: 'Rust' };
const approachNames = { http: 'HTTP / OData', cds: 'CDS', native: 'Direct HANA' };
export const applications = approaches.flatMap(approach => languages.map(language => ({ app_id: `${language}-${approach}`, language, approach, label: `${names[language]} · ${approachNames[approach]}` })));
const finite = value => typeof value === 'number' && Number.isFinite(value);
const sum = values => values.reduce((total, value) => total + value, 0);
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const posix = path => path.split(sep).join('/');
const minimum = values => values.reduce((a, b) => Math.min(a, b), Infinity);
const maximum = values => values.reduce((a, b) => Math.max(a, b), -Infinity);
const repetitions = values => { const sorted = [...values].sort((a, b) => a - b), middle = Math.floor(sorted.length / 2); return { median: sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2, minimum: Math.min(...values), maximum: Math.max(...values), repetitions: values }; };
const readJson = async path => JSON.parse(await readFile(path, 'utf8'));

function nearestRank(values, fraction) {
  if (!values.length) throw new Error('A percentile needs at least one observation.');
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(fraction * sorted.length) - 1)];
}

function publicData(value) {
  if (Array.isArray(value)) return value.map(publicData);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value)
    .filter(([key]) => !/password|username|secret|token|authorization|credential|cookie|^env$|environment_variables/i.test(key))
    .map(([key, item]) => [key, publicData(item)]));
  if (typeof value === 'string' && /^[a-z][a-z0-9+.-]*:\/\//i.test(value)) {
    try { const url = new URL(value); if (url.username || url.password) return '[redacted URL]'; } catch { return '[invalid URL]'; }
  }
  return value;
}

async function childPath(directory, name) {
  if (typeof name !== 'string' || !name || isAbsolute(name)) throw new Error('Evidence paths must be relative.');
  const path = await realpath(resolve(directory, name));
  if (!path.startsWith(directory + sep)) throw new Error('Evidence path leaves its directory.');
  return path;
}

function slowSegments(values, threshold) {
  const segments = [];
  for (let index = 0; index < values.length; index++) {
    if (values[index] <= threshold) continue;
    const start = index;
    while (index + 1 < values.length && values[index + 1] > threshold) index++;
    const selected = values.slice(start, index + 1);
    segments.push({ first_measured_index: start, last_measured_index: index, scans: selected.length, summed_scan_ms: sum(selected), maximum_latency_ms: maximum(selected) });
  }
  return segments;
}

function expectedTransport(app) {
  if (app.approach === 'http') return app.language === 'abap' ? 'classic_socket' : 'socket';
  if (app.approach === 'cds') return app.language === 'abap' ? 'direct_cds' : 'odbc';
  return app.language === 'abap' ? 'native_hana_adbc' : 'hana';
}

async function checkedFile(directory, entry, check, label) {
  const bytes = await readFile(await childPath(directory, entry.path));
  check(sha(bytes) === entry.sha256, `${label}: evidence hash mismatch.`);
  return bytes;
}

function failedWarmup(block, app_id, check, label) {
  const scans = block.records.filter(record => record.kind === 'scan'), summaries = block.records.filter(record => record.kind === 'summary'), summary = summaries[0];
  const pages = app_id === 'abap-cds' ? 50 : 51, bodyBytes = app_id.endsWith('-http') ? 1074741 : 0;
  check(block.app_id === app_id && Number.isInteger(block.exit_code) && block.exit_code !== 0 && block.verification?.passed === false && block.verification?.failures === 1, `${label}: expected failed application attempt is missing.`);
  check(summaries.length === 1 && block.records.at(-1)?.kind === 'summary' && summary?.outcome === 'error' && summary?.measured_scans === 0 && summary?.measured_wall_ms === 0 && summary?.warmup_scans === scans.length, `${label}: failure must have no measured samples.`);
  check(scans.length > 0 && scans.every((scan, index) => scan.phase === 'warmup' && scan.scan_index === index && scan.schema_version === 1), `${label}: warmup scan sequence differs.`);
  check(scans.slice(0, -1).every(scan => scan.outcome === 'ok' && scan.error === null && scan.rows === 5000 && scan.pages === pages && scan.digest === digest && scan.metrics?.body_bytes === bodyBytes), `${label}: preceding warmup did not validate.`);
  const failure = scans.at(-1);
  check(failure?.outcome === 'error' && typeof failure?.error?.code === 'string' && failure.digest === null && finite(failure.metrics?.elapsed_ms), `${label}: failed warmup lacks a normalized failure.`);
  check(controlTimingValid(block, summary, scans), `${label}: warmup timing exceeds its independent controller interval.`);
  return { block_index: block.block_index, round: block.round, app_id, started_utc: block.started_utc, finished_utc: block.finished_utc, measured_scans: 0,
    successful_warmup_scans: scans.length - 1, failed_warmup_scan_index: failure.scan_index, rows_before_failure: failure.rows, attempted_pages: failure.pages,
    elapsed_ms: failure.metrics.elapsed_ms, error: failure.error, records: block.records };
}

async function auditContinuation(directory, inputs, manifest, check) {
  const amendmentBytes = await checkedFile(directory, { path: manifest.continuation_inputs_file, sha256: manifest.continuation_inputs_sha256 }, check, 'Continuation amendment');
  const amendment = JSON.parse(amendmentBytes), attemptsBytes = await checkedFile(directory, { path: manifest.attempts_file, sha256: manifest.attempts_sha256 }, check, 'Attempt ledger'), attempts = JSON.parse(attemptsBytes);
  check(manifest.execution_mode === 'continued' && manifest.clean_run === false && amendment.execution_mode === 'continued' && amendment.clean_run === false, 'The interrupted run must not be presented as clean.');
  const retry = amendment.first_continued_block_index;
  check(Number.isInteger(retry) && retry >= 1 && retry <= 27, 'Invalid continuation resume boundary.');
  check(amendment.original_inputs_sha256 === manifest.inputs_sha256 && amendment.failed_attempt.planned_block_index === retry && amendment.failed_attempt.measured_scans === 0, 'Continuation original input or resume boundary differs.');
  const originalBytes = await checkedFile(directory, amendment.original_failed_manifest, check, 'Original failed manifest'), original = JSON.parse(originalBytes);
  check(original.status === 'failed' && original.blocks.length === retry && original.blocks.at(-1).passed === false && original.inputs_sha256 === manifest.inputs_sha256, 'Original failed execution is not preserved.');
  check(amendment.adopted_blocks.length === retry - 1, 'Original successful blocks must all be adopted.');
  for (const [index, adopted] of amendment.adopted_blocks.entries()) {
    const bytes = await checkedFile(directory, adopted, check, `Adopted block ${index + 1}`);
    check(adopted.path === original.blocks[index].path && adopted.sha256 === original.blocks[index].sha256 && adopted.sha256 === manifest.blocks[index].sha256, `Adopted block ${index + 1} differs from its original immutable record.`);
    check(JSON.parse(bytes).block_index === index + 1 && original.blocks[index].passed === true, `Adopted block ${index + 1} identity differs.`);
  }
  const failedBytes = await checkedFile(directory, amendment.failed_attempt, check, 'Original failed warmup'), failedBlock = JSON.parse(failedBytes);
  const failedRaw = await checkedFile(directory, { path: amendment.failed_attempt.raw_path, sha256: amendment.failed_attempt.raw_sha256 }, check, 'Original failed warmup raw output');
  check(JSON.stringify(failedRaw.toString('utf8').trim().split(/\r?\n/).map(line => JSON.parse(line))) === JSON.stringify(failedBlock.records), 'Original failed warmup raw output differs.');
  check(original.blocks.at(-1).sha256 === amendment.failed_attempt.sha256, 'Original failed block differs from its original index.');
  const failedApp = inputs.schedule.flat()[retry - 1];
  check(amendment.failed_attempt.app_id === failedApp, 'Original failed application differs from schedule.');
  const failure = failedWarmup(failedBlock, failedApp, check, `Original slot ${retry} failure`);
  const proof = JSON.parse(await checkedFile(directory, amendment.proof, check, 'Pre-continuation proof'));
  check(proof.ready === true && proof.unchanged_workload === true && proof.unchanged_runtime_configuration === true && proof.sap_not_restarted === true && proof.changes_during_pause && Object.values(proof.changes_during_pause).every(value => value === false), 'Pre-continuation proof reports changed measured conditions.');
  await checkedFile(directory, { path: amendment.controller.snapshot, sha256: amendment.controller.sha256 }, check, 'Continuation controller');
  for (const diagnostic of amendment.diagnostics) await checkedFile(directory, { path: diagnostic.snapshot, sha256: diagnostic.sha256 }, check, 'Continuation diagnostic');
  check(amendment.paused_at_utc === original.finished_utc && amendment.gap_before_resume_ms >= 0 &&
    Date.parse(amendment.resumed_at_utc) - Date.parse(amendment.paused_at_utc) === amendment.gap_before_resume_ms &&
    Date.parse(amendment.created_utc) >= Date.parse(amendment.paused_at_utc) && Date.parse(amendment.created_utc) <= Date.parse(attempts[retry]?.started_utc), 'Continuation gap or amendment chronology differs.');
  const successful = manifest.blocks.filter(item => item.passed).length, failedCount = 1 + manifest.blocks.length - successful;
  check(attempts.length === manifest.blocks.length + 1 && attempts.filter(item => item.status === 'passed').length === successful && attempts.filter(item => item.status === 'failed').length === failedCount, 'Attempt ledger must include every successful block and failed warmup.');
  if (manifest.status === 'complete') check(manifest.total_attempts === attempts.length && manifest.failed_attempts === failedCount && manifest.successful_measured_blocks === successful, 'Completed continuation summary differs from its attempt ledger.');
  let previousFinished = -Infinity;
  for (const [index, attempt] of attempts.entries()) {
    const slot = index < retry ? index + 1 : index, expectedAttempt = index === retry ? 2 : 1;
    const app_id = inputs.schedule[Math.floor((slot - 1) / 9)][(slot - 1) % 9];
    const expectedPass = index !== retry - 1 && manifest.blocks[slot - 1]?.passed === true;
    check(attempt.planned_block_index === slot && attempt.attempt_index === expectedAttempt && attempt.app_id === app_id && attempt.status === (expectedPass ? 'passed' : 'failed'), `Attempt ${index + 1}: identity, explicit retry or status differs.`);
    const bytes = await checkedFile(directory, attempt, check, `Attempt ${index + 1}`), block = JSON.parse(bytes);
    check(block.started_utc === attempt.started_utc && block.finished_utc === attempt.finished_utc && Date.parse(attempt.started_utc) >= previousFinished, `Attempt ${index + 1}: timestamps differ or overlap.`);
    check(attempt.adopted === (index < retry - 1), `Attempt ${index + 1}: adoption identity differs.`);
    if (index === retry - 1) check(attempt.path === amendment.failed_attempt.path && attempt.sha256 === amendment.failed_attempt.sha256, 'Original failed attempt is missing from ledger.');
    previousFinished = Date.parse(attempt.finished_utc);
    if (attempt.status === 'passed') check(manifest.blocks[slot - 1].sha256 === attempt.sha256 && manifest.blocks[slot - 1].passed === true, `Attempt ${index + 1}: successful block is absent from the main index.`);
  }
  return { amendment: publicData(amendment), amendment_sha256: sha(amendmentBytes), original_manifest_sha256: sha(originalBytes), attempts_sha256: sha(attemptsBytes), attempts: publicData(attempts), first_failed_attempt: { ...failure, source_file: amendment.failed_attempt.path, source_sha256: amendment.failed_attempt.sha256 },
    total_attempts: attempts.length, successful_measured_blocks: successful, failed_warmup_attempts: failedCount, gap_before_resume_ms: amendment.gap_before_resume_ms, original_inputs_sha256: amendment.original_inputs_sha256 };
}

function analyzeBlock(block, app, config, check, prefix) {
  check(hostMemorySamplesValid(block.resource_samples), `${prefix}: host memory pressure or invalid resource samples.`);
  check(block.exit_code === 0 && block.timed_out === false && block.oversized !== true && !block.execution_failure, `${prefix}: process did not exit cleanly.`);
  check(block.verification?.passed === true && block.verification?.failures === 0, `${prefix}: runner correctness gate failed.`);
  const records = Array.isArray(block.records) ? block.records : [];
  check(Array.isArray(block.records) && records.every(record => record && ['scan', 'summary'].includes(record.kind)), `${prefix}: missing or unknown records could hide a failure.`);
  const summaries = records.filter(record => record.kind === 'summary');
  check(summaries.length === 1 && records.at(-1)?.kind === 'summary', `${prefix}: exactly one final summary is required.`);
  const summary = summaries[0] || {}, scans = records.filter(record => record.kind === 'scan');
  const warmup = scans.filter(scan => scan.phase === 'warmup'), measured = scans.filter(scan => scan.phase === 'measured');
  check(warmup.length === config.warmup_scans && summary.warmup_scans === warmup.length, `${prefix}: missing or unaccounted warmup scans.`);
  check(measured.length > 0 && summary.measured_scans === measured.length, `${prefix}: missing or unaccounted measured scans.`);
  check(summary.outcome === undefined || summary.outcome === 'ok', `${prefix}: summary reports failure.`);
  check(summary.failed_scans === undefined || summary.failed_scans === 0, `${prefix}: summary reports failed scans.`);
  check(summary.transport === expectedTransport(app), `${prefix}: unexpected transport.`);
  check(finite(summary.measured_wall_ms) && summary.measured_wall_ms >= config.duration_seconds * 1000, `${prefix}: measured window is too short.`);
  check(controlTimingValid(block, summary, warmup), `${prefix}: warmup and measured timing exceed or conflict with the independent controller interval.`);
  const pages = app.app_id === 'abap-cds' ? 50 : 51, bytes = app.approach === 'http' ? 1074741 : 0;
  const indexOffset = app.language === 'abap' ? 0 : config.warmup_scans;
  for (const [index, scan] of scans.entries()) {
    const phase = index < config.warmup_scans ? 'warmup' : 'measured';
    check(scan.phase === phase, `${prefix}, record ${index}: scan phase is missing or out of order.`);
    const expectedIndex = phase === 'warmup' ? index : index - config.warmup_scans + indexOffset;
    check(scan.schema_version === 1 && scan.scan_index === expectedIndex, `${prefix}, record ${index}: scan envelope or sequence differs.`);
    check(scan.outcome === 'ok' && scan.error === null, `${prefix}, record ${index}: failed or hidden-error scan.`);
    check(scan.rows === 5000 && scan.pages === pages && scan.digest === digest, `${prefix}, record ${index}: row/page/digest mismatch.`);
    check(scan.metrics?.body_bytes === bytes, `${prefix}, record ${index}: body bytes differ from the fixed workload.`);
    check(Number.isSafeInteger(scan.metrics?.missed_slots) && scan.metrics.missed_slots >= 0, `${prefix}, record ${index}: missing or invalid missed-slot metric.`);
    check(finite(scan.metrics?.elapsed_ms) && scan.metrics.elapsed_ms > 0, `${prefix}, record ${index}: invalid scan timing.`);
    if (app.language === 'abap' && app.approach !== 'http') {
      check(scan.transport === expectedTransport(app), `${prefix}, record ${index}: ABAP scan transport differs.`);
      if (app.approach !== 'http') check(scan.http_requests === 0, `${prefix}, record ${index}: internal/SQL scan unexpectedly used HTTP.`);
      if (app.approach === 'cds') check(scan.application_batches === 50, `${prefix}, record ${index}: CDS nonempty package count differs.`);
      if (app.approach === 'native') check(scan.logical_fetches === 51, `${prefix}, record ${index}: HANA logical fetch count differs.`);
    }
  }
  if (app.language !== 'abap') {
    check(summary.client_policy === (app.approach === 'http' ? 'fresh_per_scan' : 'persistent'), `${prefix}: client lifecycle differs.`);
    if (app.approach !== 'http') check(summary.fetch_size === 100, `${prefix}: SQL fetch size differs.`);
  } else {
    check(summary.duration_seconds === config.duration_seconds && summary.failed_scans === 0 && summary.measured_valid_rows === measured.length * 5000 && summary.measured_body_bytes === measured.length * bytes, `${prefix}: ABAP summary totals differ.`);
    if (app.approach === 'http') check(summary.authentication === 'preemptive_basic' && summary.service_root === 'http://host.docker.internal/sap/opu/odata4/sap/zui_bl_orders_o4/srvd_a2x/sap/zui_bl_orders/0001/', `${prefix}: ABAP HTTP endpoint or authentication differs.`);
    else check(summary.http_requests === 0 && summary.sap_client === '001' && summary.db_package_size === 100 && summary.entity === (app.approach === 'cds' ? 'ZI_BL_OrderPosition' : 'ZBL_BENCH_SQL.ORDER_POSITIONS_001') && (app.approach === 'cds' ? summary.measured_application_batches === measured.length * 50 : summary.measured_logical_fetches === measured.length * 51), `${prefix}: ABAP SQL/CDS summary metadata differs.`);
  }
  const latencies = measured.map(scan => scan.metrics?.elapsed_ms);
  check(latencies.every(finite) && sum(latencies) <= summary.measured_wall_ms + 2, `${prefix}: sequential scan durations exceed actual measured wall time.`);
  if (!latencies.length || !latencies.every(finite) || !finite(summary.measured_wall_ms) || summary.measured_wall_ms <= 0) return null;
  const errors = measured.filter(scan => scan.outcome !== 'ok' || scan.error !== null), successful = measured.filter(scan => scan.outcome === 'ok' && scan.error === null && scan.rows === 5000 && scan.digest === digest);
  check(summary.measured_valid_rows === undefined || summary.measured_valid_rows === successful.length * 5000, `${prefix}: summary valid-row count differs.`);
  const threshold = Math.max(3, nearestRank(latencies, 0.1) * 3), overSecond = slowSegments(latencies, 1000);
  let cumulative = 0;
  return { block_index: block.block_index, round: block.round, ...app, started_utc: block.started_utc, finished_utc: block.finished_utc,
    warmup_scans: warmup.length, attempts: measured.length, successful_scans: successful.length, failed_scans: errors.length,
    error_counts: errors.reduce((counts, scan) => { const code = scan.error?.code || 'UNSPECIFIED'; counts[code] = (counts[code] || 0) + 1; return counts; }, {}),
    measured_wall_ms: summary.measured_wall_ms, summed_scan_ms: sum(latencies), wall_minus_summed_scan_ms: summary.measured_wall_ms - sum(latencies),
    p10_ms: nearestRank(latencies, 0.1), p50_ms: nearestRank(latencies, 0.5), p95_ms: nearestRank(latencies, 0.95), p99_ms: nearestRank(latencies, 0.99),
    mean_latency_ms: sum(latencies) / latencies.length, minimum_latency_ms: minimum(latencies), maximum_latency_ms: maximum(latencies),
    useful_rows_per_second: successful.length * 5000 / (summary.measured_wall_ms / 1000), successful_scans_per_second: successful.length / (summary.measured_wall_ms / 1000),
    scans_over_1000_ms: overSecond.reduce((total, segment) => total + segment.scans, 0), over_1000_ms_segments: overSecond,
    relative_slow_scans: { threshold_ms: threshold, count: latencies.filter(value => value > threshold).length, segments: slowSegments(latencies, threshold) },
    latency_series: measured.map((scan, index) => ({ measured_index: index, total_scan_ordinal: warmup.length + index + 1, scan_index: scan.scan_index, elapsed_ms: scan.metrics.elapsed_ms, cumulative_timed_scan_ms: cumulative += scan.metrics.elapsed_ms, outcome: scan.outcome })),
    resource_samples: publicData(block.resource_samples || []),
  };
}

export async function analyzeDirectory(inputDirectory, { allowSynthetic = false, postRunProof } = {}) {
  const directory = await realpath(resolve(inputDirectory)), inputsPath = resolve(directory, 'inputs.json'), manifestPath = resolve(directory, 'manifest.json');
  const inputsBytes = await readFile(inputsPath), manifestBytes = await readFile(manifestPath);
  const inputs = JSON.parse(inputsBytes), manifest = JSON.parse(manifestBytes), config = inputs.configuration || {};
  const continued = manifest.execution_mode === 'continued';
  const partial = manifest.status === 'failed' && manifest.execution_mode === 'continued' && manifest.blocks?.length === 26 && manifest.blocks.slice(0, 25).every(item => item.passed === true) && manifest.blocks[25].passed === false;
  const issues = [], check = (condition, message) => { if (!condition) issues.push(message); };
  check(inputs.protocol === 'sap-nine-path-benchmark-v1' && manifest.protocol === inputs.protocol, 'Unsupported or inconsistent nine-path protocol.');
  check(manifest.execution_mode === undefined || continued, 'Unsupported execution mode.');
  check(continued || (manifest.clean_run !== false && !manifest.attempts_file && !manifest.continuation_inputs_file), 'Continuation metadata requires execution_mode=continued.');
  check(manifest.status === 'complete' || partial, 'The run is incomplete or failed without the auditable two-round partial design.');
  check(!inputs.synthetic_test_data || allowSynthetic, 'Synthetic data cannot produce a real performance report.');
  check(config.duration_seconds >= 180 && config.rounds === 3 && config.warmup_scans >= 5, 'Three rounds of at least 180 seconds and five warmups are required.');
  check(config.expected_rows === 5000 && config.expected_digest === digest && config.sap_client === '001', 'The frozen data or SAP client differs.');
  check(Array.isArray(inputs.apps) && inputs.apps.length === 9 && applications.every(app => inputs.apps.some(item => item.app_id === app.app_id)), 'All nine distinct application identities are required.');
  check(Array.isArray(inputs.schedule) && inputs.schedule.length === 3 && inputs.schedule.every(round => Array.isArray(round) && round.length === 9 && new Set(round).size === 9 && round.every(id => applications.some(app => app.app_id === id))), 'The planned schedule must run all nine paths once per round.');
  check(Array.isArray(manifest.blocks) && manifest.blocks.length === (partial ? 26 : 27), 'The expected successful blocks and terminal failed attempt must be present.');
  check(manifest.inputs_sha256 === sha(inputsBytes), 'The immutable input hash differs.');
  if (!inputs.synthetic_test_data) {
    check(config.continuous === true && config.concurrency === 1 && config.output_buffered_until_after_timing === true && config.cooldown_seconds === 5 && config.retries === 0, 'Concurrency, continuous pacing, output buffering, retries or cooldown differs.');
    check(config.external_resources?.cpus === 1 && config.external_resources?.memory_bytes === 268435456 && config.external_resources?.memory_swap_bytes === 268435456, 'External CPU and memory allocations differ.');
    check(/^[a-f0-9]{40}$/.test(inputs.source_revision || ''), 'Source revision is missing.');
  }
  if (issues.length) throw new Error(issues.join('\n'));
  for (const app of applications) {
    const positions = inputs.schedule.map(round => round.indexOf(app.app_id));
    check(new Set(positions.map(position => Math.floor(position / 3))).size === 3 && new Set(positions.map(position => position % 3)).size === 3, `${app.app_id}: rounds do not balance thirds and within-third positions.`);
  }
  const sources = inputs.source_inputs || [];
  check(sources.length > 0, 'Measured source snapshots are missing.');
  for (const item of sources) {
    if (inputs.synthetic_test_data && !item.snapshot) continue;
    const bytes = await readFile(await childPath(directory, item.snapshot));
    check(sha(bytes) === item.sha256, `Source snapshot hash mismatch: ${item.path}`);
  }
  for (const item of inputs.evidence_files || []) {
    const bytes = await readFile(await childPath(directory, item.snapshot));
    check(sha(bytes) === item.sha256, `Readiness evidence snapshot hash mismatch: ${item.path}`);
  }
  if (!inputs.synthetic_test_data) {
    const readinessBytes = await readFile(await childPath(directory, 'readiness-input.json'));
    check(sha(readinessBytes) === inputs.readiness_input?.sha256, 'Readiness input hash differs.');
    const readinessInput = JSON.parse(readinessBytes);
    check(JSON.stringify(readinessInput.readiness) === JSON.stringify(inputs.readiness), 'Readiness proof differs from the immutable input archive.');
    for (const query of Object.values(inputs.queries || {})) check(query.sha256 === sources.find(item => item.path === query.path)?.sha256, `Query differs from measured source snapshot: ${query.path}`);
  }
  const continuation = continued ? await auditContinuation(directory, inputs, manifest, check) : null;
  const blocks = [], failedAttempts = continuation ? [continuation.first_failed_attempt] : [], paths = new Set(); let previousFinished = -Infinity;
  for (const [index, entry] of manifest.blocks.entries()) {
    const round = Math.floor(index / 9) + 1, app_id = inputs.schedule[round - 1][index % 9], app = applications.find(item => item.app_id === app_id), prefix = `Block ${index + 1} (${app_id})`;
    check(entry.app_id === app_id && entry.round === round && entry.passed === !(partial && index === 25), `${prefix}: manifest identity/order/pass gate differs.`);
    const path = await childPath(directory, entry.path);
    check(!paths.has(path), `${prefix}: duplicated evidence path.`); paths.add(path);
    const bytes = await readFile(path), block = JSON.parse(bytes);
    if (!inputs.synthetic_test_data) check(entry.sha256 === sha(bytes), `${prefix}: block file hash differs from the manifest index.`);
    check(block.block_index === index + 1 && block.app_id === app_id && block.round === round && block.language === app.language && block.approach === app.approach, `${prefix}: block identity differs from its schedule.`);
    const started = Date.parse(block.started_utc), finished = Date.parse(block.finished_utc);
    check(Number.isFinite(started) && Number.isFinite(finished) && finished > started && started >= previousFinished, `${prefix}: invalid or overlapping execution boundaries.`);
    if (!inputs.synthetic_test_data && Number.isFinite(previousFinished)) check(started - previousFinished >= 5000, `${prefix}: the five-second inter-block gap is missing.`);
    previousFinished = finished;
    const rawName = entry.path.replace(/\.json$/, '.ndjson'), rawBytes = await readFile(await childPath(directory, rawName));
    const raw = rawBytes.toString('utf8').split(/\r?\n/).filter(line => line.trim()).map(line => JSON.parse(line));
    check(JSON.stringify(raw) === JSON.stringify(block.records), `${prefix}: raw NDJSON differs from analyzed records.`);
    if (!inputs.synthetic_test_data) check(block.raw_file === rawName && block.raw_sha256 === sha(rawBytes), `${prefix}: raw NDJSON hash differs from the block record.`);
    if (partial && index === 25) failedAttempts.push({ ...failedWarmup(block, app_id, check, prefix), source_file: entry.path, source_sha256: sha(bytes), raw_file: rawName, raw_sha256: sha(rawBytes) });
    else {
      const result = analyzeBlock(block, app, config, check, prefix);
      if (result) blocks.push({ ...result, analysis_cohort: partial && index >= 18 ? 'excluded_third_round' : 'main', source_file: entry.path, source_sha256: sha(bytes), raw_file: rawName, raw_sha256: sha(rawBytes) });
    }
  }
  check(blocks.length === (partial ? 25 : 27), 'Every successful block needs complete measured records.');
  let postRun = null;
  if (!inputs.synthetic_test_data) {
    if (partial) {
      check(!!postRunProof, 'Partial run needs an explicit read-only post-run source proof.');
      if (postRunProof) {
        const proofPath = await realpath(resolve(postRunProof)), proofBytes = await readFile(proofPath), proof = JSON.parse(proofBytes);
        const sourceProof = proof.sources || proof;
        check(sourceProof.passed === true && Array.isArray(sourceProof.checks) && sourceProof.checks.length === 6 && sourceProof.checks.every(item => item.matches_current_local === true && item.matches_original_preflight === true), 'Post-run active SAP sources differ from preflight.');
        const subfiles = [];
        for (const item of sourceProof.checks || []) { const bytes = await checkedFile(root, { path: item.file, sha256: item.active_sha256 }, check, `Post-run active source ${item.name}`); subfiles.push({ path: item.file, sha256: sha(bytes) }); }
        if (proof.sources) {
          check(proof.sap_container?.unchanged_start_and_allocation === true && proof.sap_container.started_at === inputs.sap_container.started_at && proof.sap_container.restart_count === 0 && Object.values(proof.sap_container.allocation_checks).every(item => item.match === true), 'Post-run SAP start/allocation differs.');
          for (const [name, expected] of [['postrun-sap-readiness.json', proof.sources], ['postrun-windows-memory.json', proof.windows_memory]]) {
            const path = resolve(dirname(proofPath), name), bytes = await readFile(path); check(JSON.stringify(JSON.parse(bytes)) === JSON.stringify(expected), `Post-run ${name} differs from the combined proof.`); subfiles.push({ path: posix(relative(root, path)), sha256: sha(bytes) });
          }
        }
        postRun = { file: posix(relative(root, proofPath)), sha256: sha(proofBytes), subfiles, proof: publicData(proof) };
      }
    } else check(JSON.stringify(manifest.final_images) === JSON.stringify(inputs.images), 'Runtime images changed during measurement.');
    check(inputs.readiness?.ready === true, 'Fresh live readiness proof is incomplete.');
  }
  if (issues.length) throw new Error(issues.slice(0, 100).join('\n') + (issues.length > 100 ? `\n${issues.length - 100} further failures.` : ''));
  const summaries = applications.map(app => {
    const selected = blocks.filter(block => block.app_id === app.app_id && block.analysis_cohort === 'main').sort((a, b) => a.round - b.round);
    return { ...app, repetitions: selected.length, successful_scans: sum(selected.map(block => block.successful_scans)), failed_scans: sum(selected.map(block => block.failed_scans)),
      p50_ms: repetitions(selected.map(block => block.p50_ms)), p95_ms: repetitions(selected.map(block => block.p95_ms)),
      useful_rows_per_second: repetitions(selected.map(block => block.useful_rows_per_second)), successful_scans_per_second: repetitions(selected.map(block => block.successful_scans_per_second)) };
  });
  const mainBlocks = blocks.filter(block => block.analysis_cohort === 'main'), excludedBlocks = blocks.filter(block => block.analysis_cohort !== 'main');
  const mainFailures = failedAttempts.filter(item => !partial || item.round <= 2);
  const totalAttempts = continuation?.total_attempts ?? manifest.blocks.length;
  const mainAttempts = mainBlocks.length + mainFailures.length;
  const analysisHash = sha(await readFile(fileURLToPath(import.meta.url)));
  return { schema_version: 1, protocol: inputs.protocol, status: partial ? 'validated_partial' : 'validated', experiment_complete: !partial, clean_run: !continued, synthetic_test_data: !!inputs.synthetic_test_data, analyzed_at_utc: new Date().toISOString(), run_id: basename(directory),
    source: { run_directory: posix(relative(root, directory)), inputs_file: posix(relative(root, inputsPath)), inputs_sha256: sha(inputsBytes), manifest_file: posix(relative(root, manifestPath)), manifest_sha256: sha(manifestBytes) },
    configuration: { ...publicData(config), planned_rounds: 3, main_completed_rounds: partial ? 2 : 3 }, schedule: inputs.schedule, provenance: publicData(inputs), continuation, post_run_proof: postRun,
    analysis_version: { script: 'scripts/analyze-nine-comparison.mjs', sha256: analysisHash, plot_script: 'scripts/plot-nine-comparison.py', plot_sha256: sha(await readFile(resolve(root, 'scripts/plot-nine-comparison.py'))), changed_after_measurement: sources.find(item => item.path === 'scripts/analyze-nine-comparison.mjs')?.sha256 !== analysisHash },
    execution: { total_attempts: totalAttempts, main_attempts: mainAttempts, excluded_third_round_attempts: partial ? totalAttempts - mainAttempts : 0, successful_measured_blocks: blocks.length, main_blocks: mainBlocks.length, excluded_successful_blocks: excludedBlocks.length, failed_warmup_attempts: failedAttempts.length, main_failed_warmup_attempts: mainFailures.length, missing_planned_slots: partial ? [{ block_index: 27, app_id: 'rust-native' }] : [], interrupted: continued, failed_attempts: failedAttempts.map(item => ({ ...item, excluded_from_main: partial && item.round === 3 })),
      availability: applications.map(app => ({ app_id: app.app_id, completed_measured_blocks: mainBlocks.filter(block => block.app_id === app.app_id).length, failed_warmup_attempts: mainFailures.filter(item => item.app_id === app.app_id).length })), preflight: publicData(inputs.readiness) },
    exclusion: partial ? { round: 3, reason: 'The operator reported concurrent host load and requested exclusion of the third round.', request_summary: 'Exclude all third-round observations from primary comparisons.', scope: 'All third-round successes, timings and its failed warmup are excluded from capacity, latency, availability inference and plots; raw evidence and exclusion ledger retained.', excluded_successful_block_indices: excludedBlocks.map(block => block.block_index), excluded_failed_attempt_slots: [26], unrun_slot: 27 } : null,
    methods: { percentiles: 'Nearest rank within each measured block: sorted latency at one-based rank ceil(p*n).', aggregation: `Ordinary sample median and observed minimum–maximum of ${partial ? 'two' : 'three'} main repetition statistics${partial ? '; for two values, the median is their arithmetic midpoint' : ''}; scans are not treated as independent experimental repetitions.`, throughput: 'Successful complete scans × 5,000 / actual measured wall seconds; every slow scan remains in the denominator. Warmup failures remain separate availability observations; these capacity figures are conditional on completing warmup.', confidence_intervals: 'Not estimated. Two or three repetitions provide observed ranges, not confidence intervals.', temporal_axis: 'Within-block measured scan index preserves exact order. Summed scan times exclude loop overhead and are not timestamps.', timer_resolution: 'ABAP emits integer milliseconds. Wall time minus summed scan timings includes bookkeeping and rounding; it is not an isolated loop-overhead measurement.' },
    summaries, blocks: mainBlocks, excluded_blocks: excludedBlocks,
    limitations: [
      'This compares complete local access paths. HTTP includes OData/SADL, authentication, sockets and JSON; CDS ODBC includes SQL-service and driver work; native HANA uses another database interface and restricted database identity.',
      'HTTP constructs and closes a client per scan, reusing connections within that scan. SQL clients keep their connection across scans and open/close a query or cursor per scan. Warmup and final disconnect are outside measured SQL wall time.',
      'ABAP CDS reads typed values internally and formats them in ABAP. The shared ODBC query projects exact decimal and ISO-date strings in SQL. Native HANA also returns a text projection. Common validation and hashing do not make those conversion costs equal.',
      'Node.js and Rust have equal one-CPU/256-MiB container caps. ABAP runs inside the shared SAP system with service and database resources; its work process does not have a matching independent cap.',
      'All applications share one host and SAP/database system, with one measured client active at a time. Balanced ordering reduces systematic drift; it does not remove thermal, caching, background-load or time effects.',
      'Page/package counters describe application behavior: HTTP 51 responses, internal CDS 50 nonempty packages, SQL 51 fetch attempts including EOF. They are not a measured count of SQL statements or physical database round trips.',
      partial ? 'At the operator\'s explicit request, the entire third round is excluded because of reported concurrent host load. Main comparison uses two complete rounds, equal repetitions per application; the original three-round temporal counterbalance is incomplete. Third-round raw evidence is retained only for audit.' : 'Only three repetitions per application were measured. No statistical winner, isolated language-speed ratio, production capacity or concurrent-write claim follows from this run.',
      ...(partial ? ['The retained rounds contain a diagnostic pause and one explicit warmup retry after a Node CDS connection/setup timeout. Successful capacity is conditional on completing warmup and must be read alongside that failed attempt. No measured sample within the retained rounds was dropped.', 'The third-round exclusion follows the operator\'s report of concurrent host load. No inference about a language, driver or SAP performance cause is made from the excluded round. Two retained repetitions support descriptive observed ranges only, not a statistical winner or universal language-speed claim.'] : []),
      ...(continued && !partial ? [`The comparison resumed after a ${continuation.gap_before_resume_ms / 60000}-minute diagnostic pause and ${failedAttempts.length} failed warmup attempt. Capacity statistics are conditional on successful warmup; the original failure and all ${totalAttempts} attempts remain in the ledger.`] : []),
      'This nine-path run and its raw evidence remain local; this run was not pushed to GitHub.',
    ],
  };
}

const n = value => value.toLocaleString('en-US', { maximumFractionDigits: 2 });
const metric = value => `${n(value.median)} (${n(value.minimum)}–${n(value.maximum)})`;
function markdown(report) {
  const partial = !report.experiment_complete, main = report.blocks;
  const row = item => `| ${item.block_index} | ${item.round} | ${item.label} | ${n(item.successful_scans)} | ${n(item.measured_wall_ms / 1000)} | ${n(item.p50_ms)} | ${n(item.p95_ms)} | ${n(item.useful_rows_per_second)} | ${n(item.maximum_latency_ms)} |`;
  const rows = report.summaries.map(item => `| ${item.label} | ${n(item.successful_scans)} | ${metric(item.p50_ms)} | ${metric(item.p95_ms)} | ${metric(item.useful_rows_per_second)} | ${item.failed_scans} |`).join('\n');
  const temporal = main.map(item => `| ${item.block_index} | ${item.label} | ${n(item.relative_slow_scans.threshold_ms)} | ${item.relative_slow_scans.count} | ${item.over_1000_ms_segments.map(segment => `${segment.first_measured_index}–${segment.last_measured_index} (${segment.scans})`).join('; ') || 'None'} |`).join('\n');
  const resumed = report.continuation;
  const resumeText = resumed ? `\n## Resumed execution and failed warmup\n\nThis comparison completed after an explicit warmup retry and a **${n(resumed.gap_before_resume_ms / 60000)}-minute diagnostic pause**. It contains **${report.execution.total_attempts} attempts: ${main.length} completed measured blocks and ${report.execution.failed_warmup_attempts} failed warmup attempt**. The run is marked **clean_run=false**. The original failed attempt, unchanged adopted blocks, pause evidence and complete attempt ledger remain in the machine-readable report. Capacity describes blocks that completed warmup; the failed attempt remains an availability observation.\n\n` : '';
  if (!partial) return `# Nine-application performance comparison

${report.synthetic_test_data ? '**SYNTHETIC TEST DATA — no performance claim.**\n\n' : ''}Run: \`${report.run_id}\`. **All 27 measured blocks completed: three 180-second trials per application.** ${resumed ? 'This is a resumed comparison with a retained failed warmup and diagnostic pause.' : 'This is a fresh comparison; previous interrupted attempts and excluded host-load measurements do not enter its statistics.'}

Every successful warmup and measured scan returned 5,000 rows and canonical SHA-256 \`${digest}\`. The measured blocks contain ${n(sum(main.map(item => item.successful_scans)))} successful scans and ${n(sum(main.map(item => item.successful_scans)) * 5000)} validated rows.

![Nine paths, three repetitions each](nine-comparison.png)

## Results

Values are medians of three trial statistics, with observed minimum–maximum in parentheses. Within a trial, p50 and p95 use nearest rank. Ranges are not confidence intervals.

| Application path | Measured scans | p50 ms, median (range) | p95 ms, median (range) | Useful rows/s, median (range) | Measured failures |
| --- | ---: | ---: | ---: | ---: | ---: |
${rows}

Useful rows/s = successful scans × 5,000 / actual measured wall seconds. All slow scans and loop overhead remain included; trials have equal weight.
${resumeText}

## Every repetition

| Slot | Round | Application path | Scans | Actual wall s | p50 ms | p95 ms | Useful rows/s | Max ms |
| --- | ---: | --- | ---: | ---: | ---: | ---: | ---: | ---: |
${main.map(row).join('\n')}

## Complete latency chronology

![Every measured scan across three rounds](nine-scan-latency.png)

All measured scans remain included, in their exact within-block order. Equal scan indices across paths do not represent equal wall times. The descriptive threshold max(3 ms, 3 × block p10) identifies variation without establishing its cause.

| Slot | Application | Relative threshold ms | Scans above relative threshold | >1 s segments: first–last measured index (count) |
| --- | --- | ---: | ---: | --- |
${temporal}

## Method and limits

Each block completes five warmups and then runs continuously for at least 180 seconds, finishing the last started scan. Only one application runs at a time, with five-second minimum inter-block gaps${resumed ? ' and the disclosed diagnostic pause' : ''}. Independent controller and UTC clocks bound measured time plus warmup. Scan timers include retrieval, conversion, validation, incremental hashing and cursor/client cleanup; process startup, warmups, control dispatch, final disconnect and output serialization are excluded.

${report.limitations.map(item => `- ${item}`).join('\n')}

The [protocol](nine-benchmark-protocol.md) defines the workload. ${resumed ? 'The continuation amendment and attempt ledger preserve the interruption and explicit retry.' : 'The [block 26 investigation](node-cds-block26-investigation.md) records the earlier failure and cancellation fix. Earlier interrupted results remain separate.'}

## Evidence

The [machine-readable report](nine-comparison.json) retains every latency, resource sample and trial statistic. Immutable image identities were checked at block boundaries and after completion. ${report.provenance.source_inputs.length} source snapshots, archived readiness evidence and all raw block hashes were verified. Raw manifest: \`${report.source.manifest_file}\` (SHA-256 \`${report.source.manifest_sha256}\`). Inputs: \`${report.source.inputs_file}\` (SHA-256 \`${report.source.inputs_sha256}\`). Resource samples describe the shared host and containers; they are not isolated per-language CPU or RSS measurements.
`;
  const failure = report.execution.failed_attempts.find(item => !item.excluded_from_main);
  const exclusionLedger = report.exclusion ? report.continuation.attempts.filter(item => item.planned_block_index >= 19).map(item => `| ${item.planned_block_index} | ${item.app_id} | ${item.status === 'passed' ? 'Completed; excluded' : 'Warmup TIMEOUT; excluded (zero measured scans)'} | Operator-reported concurrent host load |`).join('\n') + '\n| 27 | rust-native | Did not run | Run stopped at slot 26 |' : '';
  const statusText = partial ? '**The entire third round is excluded at the operator\'s request because of reported concurrent host load.** The comparison retains **two complete rounds: 18 measured blocks, two 180-second trials for each of the nine paths**. The retained rounds required **19 attempts: 18 measured-block successes and one Node.js CDS warmup timeout followed by one explicit retry**. The original three-round plan is incomplete, and its full temporal counterbalance was not achieved.' : 'All 27 measured blocks completed in the planned three-round design.';
  const failureText = partial ? `## Retained-round warmup failure and pause\n\nThe first slot 12 Node.js CDS attempt timed out during connection/setup in its first warmup: **${failure.rows_before_failure} rows, ${failure.attempted_pages} pages, ${n(failure.elapsed_ms)} ms, no measured samples**. An immutable amendment recorded one explicit retry after a **${n(report.continuation.gap_before_resume_ms / 60000)}-minute diagnostic pause**. The retry completed slot 12 with five fresh warmups and the original 180-second measured window. Sources, images, driver, data and settings were held fixed; the original eleven successful blocks and the failed attempt remain byte-for-byte preserved.\n\nThe main table describes capacity after successful warmup. Failure time is excluded under the warmup-exclusion rule applied to every application and remains an availability limitation: Node.js CDS completed two retained measured blocks after three block-start attempts. This small sample does not estimate a general failure probability. No measured scan failed in either retained round.\n\nA separate Node.js HTTP smoke warmup also timed out before official measurement. An authenticated service diagnostic then succeeded, and a new nine-path smoke run passed all paths. This preflight failure is separate from the 19 retained-round attempts.\n\n![Retained-round attempts and the diagnostic pause](nine-attempt-timeline.png)\n\n` : '';
  return `# Nine-application performance comparison\n\n${report.synthetic_test_data ? '**SYNTHETIC TEST DATA — no performance claim.**\n\n' : ''}Run: \`${report.run_id}\`. ${statusText}\n\nThe retained ${main.length} blocks contain **${n(sum(main.map(item => item.successful_scans)))} successful measured scans / ${n(sum(main.map(item => item.successful_scans)) * 5000)} validated rows**. Every successful warmup and measured scan returned the same 5,000 positions and canonical SHA-256 \`${digest}\`. No historical timing or third-round timing contributes to the comparison.\n\n![Nine paths, two retained repetitions each](nine-comparison.png)\n\n## Main comparison: ${partial ? 'two' : 'three'} complete rounds\n\nValues are ordinary medians of ${partial ? '**two** trial statistics: the arithmetic midpoint of the two observed values' : 'three trial statistics'}. Parentheses show observed minimum–maximum, not confidence intervals. Within each trial, p50 and p95 use nearest rank. Lower latency and higher useful throughput are better.\n\n| Application path | Retained measured scans | p50 ms, median (range) | p95 ms, median (range) | Useful rows/s, median (range) | Measured failures |\n| --- | ---: | ---: | ---: | ---: | ---: |\n${rows}\n\nUseful rows/s = successful scans × 5,000 / actual measured wall seconds, including every slow scan and loop overhead. It is not 5,000 divided by median latency. Each trial has equal weight; individual scans are not independent experimental repetitions.\n\n${failureText}## Every retained repetition\n\n| Slot | Round | Application path | Scans | Actual wall s | p50 ms | p95 ms | Useful rows/s | Max ms |\n| --- | ---: | --- | ---: | ---: | ---: | ---: | ---: | ---: |\n${main.map(row).join('\n')}\n\n## Complete retained-round latency chronology\n\n![Every measured scan in the retained two rounds](nine-scan-latency.png)\n\nAll measured scans in the first two rounds are included, with no outlier removal. Within each line, exact zero-based measured scan order is preserved. Equal scan indices across paths do not imply equal wall times. The JSON retains every latency. The descriptive threshold max(3 ms, 3 × block p10) flags variation without establishing a cause.\n\n| Slot | Application | Relative threshold ms | Scans above relative threshold | >1 s segments: first–last measured index (count) |\n| --- | --- | ---: | ---: | --- |\n${temporal}\n\n## Measurement boundary and interpretation\n\nEach retained block completes five warmups, then runs continuously for at least 180 measured seconds. The last complete scan crossing the boundary remains included. Only one benchmark application runs at a time, with five-second minimum inter-block gaps plus the disclosed diagnostic pause. No concurrent host load was reported for the first two rounds.\n\nScan timers include retrieval, validation, exact decimal/date normalization, canonical incremental SHA-256 and cursor/client cleanup. Process startup, warmup, ADT dispatch and final serialization are excluded. HTTP uses a fresh client per scan, reusing its connection within 51 requests. SQL keeps its connection across scans, opens/closes a query/cursor per scan and disconnects after timing. ABAP executes one SAP session per block; its scan timers emit integer milliseconds.\n\nAll HTTP languages call the same literal endpoint. CDS is internal Open SQL on \`ZI_BL_OrderPosition\` for ABAP and SAP's ABAP SQL service through ODBC for Node.js/Rust. Direct HANA queries the same text-projection view. Internal CDS formats native values in ABAP; external SQL performs a string projection in SQL. Shared validation and hashing do not make retrieval/conversion costs identical.\n\n${report.limitations.map(item => `- ${item}`).join('\n')}\n\n## Evidence and verification\n\nThe [machine-readable report](nine-comparison.json) contains all retained trial statistics, complete measured latency sequences, the warmup failures, full attempt ledger, source/raw-file hashes, image identities, continuation amendment and resource samples. Third-round data remains in a separate excluded evidence section and does not enter summaries or plots. The [original protocol](nine-benchmark-protocol.md) defines the three-round plan; this report records the explicit exclusion and incomplete execution.\n\nRaw manifest: \`${report.source.manifest_file}\`; SHA-256: \`${report.source.manifest_sha256}\`. Immutable inputs: \`${report.source.inputs_file}\`; SHA-256: \`${report.source.inputs_sha256}\`. All 151 original source snapshots, archived readiness evidence, adopted blocks and raw NDJSON were hash checked. Analysis code changed only after measurements stopped; its new hash is recorded separately.\n\nPost-run read-only checks confirm the four active ABAP classes and two CDS definitions match preflight after EOL/EOF normalization. A delayed filtered Docker inspection confirmed SAP's start time and resource allocation were unchanged. The post-run native-view metadata query timed out, so its final live definition was not reverified; it last matched before continuation. Every external command used an immutable image ID, and source/image-tag checks passed before each attempted block; final tag reinspection after stopping was unavailable.\n\nResource samples are host/Docker observations, not per-language RSS or isolated ABAP CPU. Post-run host memory pressure belongs to the excluded-round context and does not establish a cause for the earlier slot 12 timeout. This experiment and its raw results remain local; nothing was pushed to GitHub.\n\n${partial ? `## Appendix: excluded third-round ledger\n\nThe operator reported concurrent host load and explicitly requested that the third round be disregarded. The **entire third round** is excluded from latency, throughput, rankings, availability inference and charts. Its raw evidence is retained solely for audit; no language or driver conclusions are drawn from it.\n\n| Planned slot | Application | Recorded status | Exclusion/context |\n| --- | --- | --- | --- |\n${exclusionLedger}\n\nThe excluded slot 26 failure occurred during its second warmup after 1,900 rows and 20 attempted fetches; it produced no measured samples. Across all archived rounds there were 27 attempts (25 successful measured blocks and two failed warmups), including the excluded round. This overall ledger does not replace the retained-round 19-attempt count.\n` : ''}`;
}

export async function writeReport(report, outputDirectory = defaultOutput) {
  const output = resolve(outputDirectory);
  if (!['validated', 'validated_partial'].includes(report.status)) throw new Error('Only validated complete or explicitly partial evidence can be written.');
  if (report.synthetic_test_data && output === defaultOutput) throw new Error('Synthetic reports must remain outside real docs.');
  await mkdir(output, { recursive: true });
  await writeFile(resolve(output, 'nine-comparison.json'), JSON.stringify(report, null, 2) + '\n');
  await writeFile(resolve(output, 'nine-comparison.md'), markdown(report));
}

async function selfTest() {
  await mkdir(resolve(root, 'work'), { recursive: true });
  const directory = await mkdtemp(resolve(root, 'work/nine-analysis-selftest-'));
  const appIds = ['node', 'rust', 'abap'], routes = ['http', 'cds', 'native'];
  const schedule = Array.from({ length: 3 }, (_, round) => Array.from({ length: 9 }, (_, index) => `${appIds[(index % 3 + round) % 3]}-${routes[(Math.floor(index / 3) + index % 3 + 2 * round) % 3]}`));
  const inputs = { protocol: 'sap-nine-path-benchmark-v1', synthetic_test_data: true, configuration: { duration_seconds: 180, rounds: 3, warmup_scans: 5, expected_rows: 5000, expected_digest: digest, sap_client: '001' }, apps: applications, schedule, source_inputs: [{ path: 'synthetic', sha256: 'a'.repeat(64) }] };
  const inputsBytes = JSON.stringify(inputs); await writeFile(resolve(directory, 'inputs.json'), inputsBytes);
  const manifest = { protocol: inputs.protocol, status: 'complete', inputs_sha256: sha(inputsBytes), blocks: [] };
  for (let index = 0; index < 27; index++) {
    const round = Math.floor(index / 9) + 1, app = applications.find(item => item.app_id === schedule[round - 1][index % 9]), path = `block-${index + 1}.json`;
    const records = Array.from({ length: 9 }, (_, scanIndex) => ({ kind: 'scan', phase: scanIndex < 5 ? 'warmup' : 'measured', schema_version: 1, scan_index: scanIndex >= 5 && app.language === 'abap' ? scanIndex - 5 : scanIndex, outcome: 'ok', error: null, rows: 5000, pages: app.app_id === 'abap-cds' ? 50 : 51, digest,
      ...(app.language === 'abap' ? { transport: expectedTransport(app), http_requests: app.approach === 'http' ? 51 : 0, application_batches: 50, logical_fetches: 51 } : {}),
      metrics: { elapsed_ms: scanIndex < 5 ? 1 : (scanIndex - 2) * 10000, body_bytes: app.approach === 'http' ? 1074741 : 0, missed_slots: 0 } }));
    records.push({ kind: 'summary', transport: expectedTransport(app), measured_wall_ms: 180000, warmup_scans: 5, measured_scans: 4, client_policy: app.approach === 'http' ? 'fresh_per_scan' : 'persistent', fetch_size: 100 });
    if (app.language === 'abap') Object.assign(records.at(-1), { duration_seconds: 180, failed_scans: 0, measured_valid_rows: 20000, measured_body_bytes: app.approach === 'http' ? 4 * 1074741 : 0, authentication: 'preemptive_basic', service_root: 'http://host.docker.internal/sap/opu/odata4/sap/zui_bl_orders_o4/srvd_a2x/sap/zui_bl_orders/0001/', http_requests: 0, sap_client: '001', db_package_size: 100, entity: app.approach === 'cds' ? 'ZI_BL_OrderPosition' : 'ZBL_BENCH_SQL.ORDER_POSITIONS_001', measured_application_batches: 200, measured_logical_fetches: 204 });
    const block = { block_index: index + 1, round, ...app, exit_code: 0, timed_out: false, control_wall_ms: 181000, started_utc: new Date(Date.UTC(2026, 0, 1) + index * 190000).toISOString(), finished_utc: new Date(Date.UTC(2026, 0, 1) + index * 190000 + 181000).toISOString(), verification: { passed: true, failures: 0 }, resource_samples: [], records };
    await writeFile(resolve(directory, path), JSON.stringify(block)); await writeFile(resolve(directory, path.replace('.json', '.ndjson')), records.map(record => JSON.stringify(record)).join('\n') + '\n');
    manifest.blocks.push({ path, round, app_id: app.app_id, passed: true });
  }
  const saveManifest = () => writeFile(resolve(directory, 'manifest.json'), JSON.stringify(manifest)); await saveManifest();
  const report = await analyzeDirectory(directory, { allowSynthetic: true });
  assert.deepEqual(repetitions([500, 25, 50]), { median: 50, minimum: 25, maximum: 500, repetitions: [500, 25, 50] });
  assert.deepEqual(repetitions([25, 500]), { median: 262.5, minimum: 25, maximum: 500, repetitions: [25, 500] });
  const failed = { app_id: 'node-cds', exit_code: 1, control_wall_ms: 25100, started_utc: '2026-01-01T00:00:00.000Z', finished_utc: '2026-01-01T00:00:25.100Z', verification: { passed: false, failures: 1 }, records: [{ kind: 'scan', phase: 'warmup', scan_index: 0, schema_version: 1, outcome: 'error', digest: null, rows: 0, pages: 0, error: { code: 'TIMEOUT' }, metrics: { body_bytes: 0, elapsed_ms: 25000 } }, { kind: 'summary', outcome: 'error', measured_scans: 0, measured_wall_ms: 0, warmup_scans: 1 }] };
  const requireCheck = (condition, message) => { if (!condition) throw new Error(message); };
  assert.equal(failedWarmup(failed, 'node-cds', requireCheck, 'Synthetic failed warmup').measured_scans, 0);
  const changedFailure = structuredClone(failed); changedFailure.records.at(-1).measured_scans = 1;
  assert.throws(() => failedWarmup(changedFailure, 'node-cds', requireCheck, 'Synthetic failed warmup'), /no measured samples/);
  assert.equal(report.blocks.length, 27); assert.equal(report.summaries.length, 9); assert.equal(report.blocks[0].p50_ms, 40000); assert.equal(report.blocks[0].p95_ms, 60000); assert.equal(report.blocks[0].useful_rows_per_second, 20000 / 180); assert.equal(report.blocks[0].latency_series[0].total_scan_ordinal, 6);
  await assert.rejects(analyzeDirectory(directory), /Synthetic/);
  const path = resolve(directory, manifest.blocks[0].path), block = await readJson(path);
  const saveBlock = async () => { await writeFile(path, JSON.stringify(block)); await writeFile(path.replace('.json', '.ndjson'), block.records.map(record => JSON.stringify(record)).join('\n') + '\n'); };
  block.records[5].error = { code: 'SQL' }; await saveBlock(); await assert.rejects(analyzeDirectory(directory, { allowSynthetic: true }), /hidden-error/);
  block.records[5].error = null; block.records[5].pages = 50; await saveBlock(); await assert.rejects(analyzeDirectory(directory, { allowSynthetic: true }), /page\/digest/);
  block.records[5].pages = 51; block.records.at(-1).measured_wall_ms = 179999; await saveBlock(); await assert.rejects(analyzeDirectory(directory, { allowSynthetic: true }), /too short/);
  block.records.at(-1).measured_wall_ms = 180000000; await saveBlock(); await assert.rejects(analyzeDirectory(directory, { allowSynthetic: true }), /controller interval/);
  block.records.at(-1).measured_wall_ms = 180000; block.control_wall_ms = 181500; await saveBlock(); await assert.rejects(analyzeDirectory(directory, { allowSynthetic: true }), /controller interval/);
  block.control_wall_ms = 181000;
  block.records.at(-1).measured_wall_ms = 180000; await saveBlock(); await writeFile(path.replace('.json', '.ndjson'), ''); await assert.rejects(analyzeDirectory(directory, { allowSynthetic: true }), /raw NDJSON/);
  await saveBlock(); manifest.inputs_sha256 = 'b'.repeat(64); await saveManifest(); await assert.rejects(analyzeDirectory(directory, { allowSynthetic: true }), /immutable input hash/);
  manifest.inputs_sha256 = sha(inputsBytes); manifest.status = 'failed'; await saveManifest(); await assert.rejects(analyzeDirectory(directory, { allowSynthetic: true }), /incomplete or failed/);
  await writeReport(report, resolve(directory, 'report')); await assert.rejects(writeReport(report), /outside real docs/);
  const markdown = await readFile(resolve(directory, 'report/nine-comparison.md'), 'utf8');
  assert.match(markdown, /All 27 measured blocks completed/);
  assert.match(markdown, /three repetitions each/);
  assert.doesNotMatch(markdown, /All measured scans in the first two rounds|third-round timing contributes|151 original source/);
  process.stdout.write(`Nine-path analysis self-test passed. Synthetic artifacts: ${directory}\n`);
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length === 1 && args[0] === '--self-test') return selfTest();
  if (!args.length || args.length % 2 !== 1) throw new Error('Usage: node scripts/analyze-nine-comparison.mjs <runDirectory> [--output-dir directory] [--post-run-proof file] | --self-test');
  const options = {};
  for (let index = 1; index < args.length; index += 2) { if (!['--output-dir', '--post-run-proof'].includes(args[index]) || options[args[index]]) throw new Error('Unknown or duplicate option.'); options[args[index]] = args[index + 1]; }
  const report = await analyzeDirectory(args[0], { postRunProof: options['--post-run-proof'] }); await writeReport(report, options['--output-dir'] || defaultOutput);
  process.stdout.write(`Validated ${report.blocks.length} successful measured blocks across nine applications (${report.status}) for ${report.run_id}.\n`);
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main().catch(error => { process.stderr.write(`Nine-path comparison refused: ${error.message}\n`); process.exitCode = 1; });
