#!/usr/bin/env node
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { nearestRank } from './analyze-performance.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const implementations = ['node', 'rust', 'abap'];
const modes = ['live_control', 'live_profile', 'db_only', 'replay_full'];
const phaseNames = ['database_ms', 'validation_ms', 'hashing_ms', 'cleanup_ms', 'residual_ms'];
const labels = { node: 'Node.js', rust: 'Rust', abap: 'ABAP' };
const digest = 'df57de597e919adb10ae5365201b999788e86b39219ad040ffbc305539180bc7';
const baselineHash = 'e76b636db92bc46e3c43220935bb7e29eeeb8eff698637fb0fdacc378cdfcf41';
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const sum = values => values.reduce((a, b) => a + b, 0);
const mean = values => sum(values) / values.length;
const finite = value => typeof value === 'number' && Number.isFinite(value);
const stats = values => ({ median: nearestRank(values, 0.5), minimum: Math.min(...values), maximum: Math.max(...values), repetitions: values });
const posix = path => path.split(sep).join('/');
const nullableMean = values => { const available = values.filter(value => finite(value) && value > 0); return available.length ? mean(available) : null; };

function driverMeans(scans) {
  const values = scans.map(scan => scan.metrics?.driver_statistics || scan.driver_statistics).filter(Boolean);
  if (!values.length) return null;
  const counts = values[0].driver_calls || {};
  return { sampled_scans: values.length, driver_calls: Object.fromEntries(Object.keys(counts).map(name => [name, {
    mean: mean(values.map(value => value.driver_calls[name])), minimum: Math.min(...values.map(value => value.driver_calls[name])), maximum: Math.max(...values.map(value => value.driver_calls[name])),
  }])), server: { units: 'microseconds', ...Object.fromEntries(['prepare', 'execute', 'fetch'].map(stage => [stage,
    Object.fromEntries(['cpu_us', 'processing_us'].map(name => [name, nullableMean(values.map(value => value.server?.[stage]?.[name]))]))])),
    scope: values[0].server?.scope || 'Driver-provided scoped statistics; not client elapsed time.' } };
}

export function summarizeBlocks(rawBlocks, manifest) {
  const issues = [], check = (value, message) => { if (!value) issues.push(message); };
  const expectedRows = manifest.expected_rows, expectedDigest = manifest.expected_digest;
  const blocks = [];
  for (const block of rawBlocks) {
    const label = `Block ${block.block_index}: ${block.implementation}/${block.mode}`;
    check(implementations.includes(block.implementation) && modes.includes(block.mode), `${label}: unknown identity`);
    check(Number.isInteger(block.round) && block.round >= 1 && block.round <= manifest.rounds, `${label}: invalid round`);
    check(block.verification?.passed === true && !block.verification?.failed_scans, `${label}: failed verification`);
    const records = Array.isArray(block.records) ? block.records : [];
    check(records.length > 1 && records.every(item => item && ['scan', 'summary', 'timer_calibration'].includes(item.kind)), `${label}: unknown/empty records`);
    const summaries = records.filter(item => item.kind === 'summary'), summary = summaries[0] || {};
    check(summaries.length === 1 && records.slice(records.indexOf(summary) + 1).every(item => item.kind === 'timer_calibration'), `${label}: exactly one summary after all scans required`);
    const calibrations = records.filter(item => item.kind === 'timer_calibration');
    check(calibrations.every(item => item.calls > 0 && finite(item.elapsed_us) && item.elapsed_us >= 0), `${label}: invalid timer calibration`);
    check((summary.outcome === undefined || summary.outcome === 'ok') && !summary.failed_scans, `${label}: summary reports failure`);
    const scans = records.filter(item => item.kind === 'scan');
    const measured = scans.filter(item => item.phase === 'measured'), warmup = scans.filter(item => item.phase === 'warmup');
    check(scans.length === measured.length + warmup.length, `${label}: unknown phase`);
    check(warmup.length === manifest.warmup_scans && summary.warmup_scans === warmup.length, `${label}: warmup count mismatch`);
    check(measured.length > 0 && summary.measured_scans === measured.length, `${label}: measured count mismatch`);
    check(finite(summary.measured_wall_ms) && summary.measured_wall_ms >= block.duration_seconds * 1000 - 1, `${label}: measurement window too short`);
    let seenMeasured = false;
    for (const scan of scans) {
      if (scan.phase === 'measured') seenMeasured = true;
      check(!(seenMeasured && scan.phase === 'warmup'), `${label}: warmup follows measurement`);
      check(scan.outcome === 'ok' && scan.error === null && scan.rows === expectedRows, `${label}: hidden scan error/count mismatch`);
      check(block.mode === 'db_only' ? scan.digest === null || scan.digest === '' || scan.digest === expectedDigest : scan.digest === expectedDigest, `${label}: digest mismatch`);
      check(finite(scan.metrics?.elapsed_ms) && scan.metrics.elapsed_ms >= 0 && scan.metrics.body_bytes === 0, `${label}: invalid native metric`);
      const phases = scan.timings || scan.metrics?.profile;
      if (block.mode !== 'live_control') {
        check(phases && [...phaseNames, 'total_ms'].every(name => finite(phases[name]) && phases[name] >= -0.1), `${label}: invalid/missing phase timings`);
        if (phases) check(Math.abs(sum(phaseNames.map(name => phases[name])) - phases.total_ms) < 0.03, `${label}: phase sum differs from total`);
        if (block.mode === 'replay_full' && phases) check(phases.database_ms === 0 && phases.cleanup_ms === 0, `${label}: replay contains DB/cleanup time`);
      }
    }
    if (!measured.length) continue;
    // Diagnostic Rust/ABAP wrappers also expose a precise total with profiling disabled.
    const latencies = measured.map(item => (item.timings || item.metrics?.profile)?.total_ms ?? item.metrics.elapsed_ms);
    check(latencies.every(finite) && sum(latencies) <= summary.measured_wall_ms + measured.length + 2, `${label}: sequential timing exceeds wall`);
    const phaseMeans = block.mode === 'live_control' ? null : Object.fromEntries([...phaseNames, 'total_ms'].map(name => [name, mean(measured.map(item => (item.timings || item.metrics.profile)[name]))]));
    if (phaseMeans) check(Math.abs(sum(phaseNames.map(name => phaseMeans[name])) - phaseMeans.total_ms) < 0.03, `${label}: mean phase sum mismatch`);
    blocks.push({ block_index: block.block_index, round: block.round, implementation: block.implementation, mode: block.mode, source_file: block.source_file,
      source_sha256: block.source_sha256, raw_records_sha256: block.raw_records_sha256, duration_seconds: block.duration_seconds,
      started_utc: block.started_utc, finished_utc: block.finished_utc, warmup_scans: warmup.length, measured_scans: measured.length, failed_scans: 0,
      measured_wall_ms: summary.measured_wall_ms, p50_ms: nearestRank(latencies, 0.5), p95_ms: nearestRank(latencies, 0.95), mean_total_ms: mean(latencies),
      useful_rows_per_second: block.mode === 'db_only' ? null : measured.length * expectedRows / (summary.measured_wall_ms / 1000), phase_means_ms: phaseMeans,
      driver_statistics_means: driverMeans(measured), timer_calibrations: calibrations, timer_calls_per_scan: measured.every(item => Number.isInteger(item.timer_calls)) ? stats(measured.map(item => item.timer_calls)) : null,
      total_metric: 'High-resolution diagnostic total where available, otherwise elapsed_ms. Existing whole-ms scan metric retained in samples.',
      samples: scans.map(scan => ({ phase: scan.phase, scan_index: scan.scan_index, elapsed_ms: scan.metrics.elapsed_ms,
        timings: scan.timings || scan.metrics?.profile || null, timer_calls: scan.timer_calls, driver_statistics: scan.metrics?.driver_statistics || scan.driver_statistics || null })) });
  }
  const summaries = [];
  for (const implementation of implementations) for (const mode of modes) {
    const selected = blocks.filter(block => block.implementation === implementation && block.mode === mode).sort((a, b) => a.round - b.round);
    check(selected.length === manifest.rounds && new Set(selected.map(item => item.round)).size === manifest.rounds, `${implementation}/${mode}: missing/repeated trial`);
    if (!selected.length) continue;
    const profiled = mode !== 'live_control';
    summaries.push({ implementation, label: labels[implementation], mode, trials: selected.length,
      successful_scans: sum(selected.map(item => item.measured_scans)), failed_scans: 0,
      p50_ms: stats(selected.map(item => item.p50_ms)), p95_ms: stats(selected.map(item => item.p95_ms)), mean_total_ms: stats(selected.map(item => item.mean_total_ms)),
      phases_ms: profiled ? Object.fromEntries([...phaseNames, 'total_ms'].map(name => [name, stats(selected.map(item => item.phase_means_ms[name]))])) : null,
      additive_mean_ms: profiled ? Object.fromEntries([...phaseNames, 'total_ms'].map(name => [name, mean(selected.map(item => item.phase_means_ms[name]))])) : null });
  }
  if (issues.length) throw new Error(issues.slice(0, 30).join('\n'));
  const comparisons = implementations.map(implementation => {
    const select = mode => blocks.filter(item => item.implementation === implementation && item.mode === mode).sort((a, b) => a.round - b.round);
    const control = select('live_control'), profile = select('live_profile'), db = select('db_only'), replay = select('replay_full');
    return { implementation, profile_to_control_mean_ratio: stats(profile.map((item, index) => item.mean_total_ms / control[index].mean_total_ms)),
      profile_to_control_p50_ratio: stats(profile.map((item, index) => item.p50_ms / control[index].p50_ms)),
      db_only_to_control_mean_ratio: stats(db.map((item, index) => item.mean_total_ms / control[index].mean_total_ms)),
      replay_to_live_profile_mean_ratio: stats(replay.map((item, index) => item.mean_total_ms / profile[index].mean_total_ms)) };
  });
  const live = implementation => summaries.find(item => item.implementation === implementation && item.mode === 'live_profile');
  const gaps = ['node', 'abap'].map(implementation => ({ implementation, reference: 'rust', scope: 'Difference of equal-weight means of directly timed live-profile trial components; descriptive, no independent-median subtraction.',
    difference_ms: Object.fromEntries([...phaseNames, 'total_ms'].map(name => [name, live(implementation).additive_mean_ms[name] - live('rust').additive_mean_ms[name]])) }));
  return { summaries, blocks, comparisons, live_profile_gap_components: gaps };
}

async function childPath(directory, name) {
  if (typeof name !== 'string' || !name || isAbsolute(name)) throw new Error('Evidence path must be relative');
  const path = await realpath(resolve(directory, name));
  if (!path.startsWith(directory + sep)) throw new Error('Evidence path escapes run directory');
  return path;
}

async function validateEvidenceIndex(directory) {
  const path = resolve(directory, 'evidence-files.json');
  const bytes = await readFile(path), index = JSON.parse(bytes);
  assert(index.files?.length > 0, 'Published evidence closure index required');
  const paths = new Set();
  for (const item of index.files) {
    assert(!paths.has(item.path), 'Evidence index repeats a path'); paths.add(item.path);
    const content = await readFile(await childPath(directory, item.path));
    assert.equal(content.length, item.bytes, `Evidence size mismatch: ${item.path}`); assert.equal(sha256(content), item.sha256, `Evidence hash mismatch: ${item.path}`);
  }
  assert(paths.has('manifest.json'), 'Evidence index must contain the manifest');
  return { index_file: posix(relative(root, path)), index_sha256: sha256(bytes), validated_files: index.files.length };
}

export async function analyzeDirectory(inputDirectory) {
  const directory = await realpath(resolve(inputDirectory));
  const evidence = await validateEvidenceIndex(directory);
  const manifestPath = resolve(directory, 'manifest.json'), bytes = await readFile(manifestPath), manifest = JSON.parse(bytes);
  assert.equal(manifest.protocol, 'sap-native-hana-profile-v1'); assert.equal(manifest.status, 'complete'); assert.equal(manifest.smoke, false);
  assert.equal(manifest.rounds, 3); assert.equal(manifest.warmup_scans, 5); assert.equal(manifest.expected_rows, 5000); assert.equal(manifest.expected_digest, digest);
  assert.equal(manifest.blocks.length, 36); assert.equal(manifest.client_resources.cpu_limit, 1); assert.equal(manifest.client_resources.memory_bytes, 268435456);
  assert.equal(manifest.official_baseline?.path, 'docs/native-comparison.json'); assert.equal(manifest.official_baseline?.sha256, baselineHash);
  const baselineBytes = await readFile(resolve(root, manifest.official_baseline.path)); assert.equal(sha256(baselineBytes), baselineHash);
  const baseline = JSON.parse(baselineBytes); assert.equal(baseline.status, 'validated'); assert.equal(baseline.configuration.expected_digest, digest);
  const capturedBytes = await readFile(await childPath(directory, 'captured-rows.json')); assert.equal(sha256(capturedBytes), manifest.capture.sha256);
  const captured = JSON.parse(capturedBytes); assert.equal(captured.expected_rows, 5000); assert.equal(captured.expected_digest, digest); assert.equal(captured.query_sha256, manifest.query_sha256); assert.equal(captured.rows.length, 5000);
  const sources = [];
  for (const source of manifest.source_inputs) {
    assert.equal(sha256(await readFile(await childPath(directory, source.snapshot))), source.sha256, `Source hash: ${source.path}`);
    sources.push(source);
  }
  assert.equal(sources.find(item => item.path === 'contracts/native-hana.sql')?.sha256, manifest.query_sha256);
  assert(sources.some(item => item.path === 'clients/rust/src/sql/profile.rs'), 'Nested Rust profile module snapshot required');
  const rawBlocks = [];
  let previousFinish = 0;
  for (const [index, entry] of manifest.blocks.entries()) {
    assert.equal(entry.passed, true);
    const path = await childPath(directory, entry.path), blockBytes = await readFile(path), block = JSON.parse(blockBytes);
    assert.equal(block.block_index, index + 1); assert.equal(block.round, entry.round); assert.equal(block.implementation, entry.implementation); assert.equal(block.mode, entry.mode);
    const rawBytes = await readFile(await childPath(directory, entry.path.replace(/\.json$/, '.ndjson')));
    assert.deepEqual(rawBytes.toString('utf8').trim().split(/\r?\n/).map(line => JSON.parse(line)), block.records);
    const started = Date.parse(block.started_utc), finished = Date.parse(block.finished_utc);
    assert(finite(started) && finite(finished) && finished > started && started >= previousFinish, 'Blocks overlap or timestamps invalid'); previousFinish = finished;
    rawBlocks.push({ ...block, source_file: entry.path, source_sha256: sha256(blockBytes), raw_records_sha256: sha256(rawBytes) });
  }
  const analysis = summarizeBlocks(rawBlocks, manifest);
  return { schema_version: 1, protocol: manifest.protocol, status: 'validated', analyzed_at_utc: new Date().toISOString(), run_id: basename(directory),
    source: { run_directory: directory, manifest_file: posix(relative(root, manifestPath)), manifest_sha256: sha256(bytes), capture_sha256: manifest.capture.sha256, source_inputs: sources, published_evidence: evidence },
    configuration: { rounds: 3, warmup_scans: 5, live_duration_seconds: manifest.live_duration_seconds, control_duration_seconds: manifest.control_duration_seconds, expected_rows: 5000, expected_digest: digest, query_sha256: manifest.query_sha256, client_resources: manifest.client_resources },
    methods: { components: 'Exclusive elapsed time around existing database/driver calls, row mapping/validation/ordering, canonical-byte construction and hash operations, and cursor cleanup. Residual includes loop/deadline checks/timers/state/other overhead.',
      aggregation: 'Arithmetic component means within each block; median/minimum/maximum of three block means. No scan removal. Component medians need not sum to the median total.',
      additive_chart: 'Arithmetic mean of the three block component means, equally weighted by trial; component sums equal the chart total. Each trial total also shown.',
      replay: 'Captured rows, full functional validation and canonical SHA-256; file I/O and capture preflight outside timers. Driver-shaped data setup happens before the timed replay. ABAP uses its separately loaded/frozen native rows; exact shared digest validates the input.',
      ablations: 'DB-only omits row validation and hashing. Separate control totals are reported directly; their differences are not substituted for timed components.',
      observer_effect: 'Profile-enabled versus profile-disabled paired trial ratios measure combined instrumentation/code-path and temporal effects, not a universal timer calibration.' },
    provenance: { images: manifest.images, final_images: manifest.final_images, source_revision: manifest.source_revision, topology: manifest.topology },
    official_baseline: { ...manifest.official_baseline, run_id: baseline.run_id, summaries: baseline.summaries.filter(item => item.implementation.endsWith('_native')) },
    ...analysis,
    implementation_evidence: [
      { implementation: 'node', paths: ['clients/node/src/sql-transport.mjs', 'clients/node/src/sql-poller.mjs', 'clients/node/src/poller.mjs'], observation: 'Each row crosses native driver next/getValues APIs and their can-block checks. Uppercase SQL object mapping, regex/date/decimal normalization, arrays/objects/strings and one SHA-256 UTF-8 update per row are in the measured path. Native API counts are not network round trips.' },
      { implementation: 'rust', paths: ['clients/rust/src/sql.rs', 'clients/rust/src/lib.rs', 'clients/rust/src/sql/profile.rs'], observation: 'hdbconnect buffers result rows; Rust validates via compiled ASCII/date/decimal routines and streams canonical field bytes into SHA-256 without constructing one joined canonical line. Compiled code and different driver/protocol buffering are plausible mechanisms; timed stages establish their observed scope, not an isolated language cause.' },
      { implementation: 'abap', paths: ['sap/src/zcl_bl_poll_orders.clas.abap', 'sap/diagnostics/native-hana'], observation: 'ADBC fetches table packages. Each row performs PCRE checks, date plausibility function, decimal string normalization and ordering; canonical line concatenation, string-to-xstring conversion and digest method calls are inside hashing.' },
    ],
    limitations: [
      'Database access is driver-inclusive elapsed time: HANA work, network, buffering, decoding, language-native crossings and waiting. It is not pure HANA server execution time.',
      'Node driver server CPU/processing times are separately scoped prepare, execution and subsequent result-set fetch reports. Zero/unavailable is null. Do not count initially returned rows in both execution and fetch statistics.',
      'The profiler adds per-row clocks and counters. Enabled/disabled controls quantify the observed effect; profiled phase totals are not replacements for the official uninstrumented benchmark.',
      'ABAP shares SAP/HANA resources and its primary session; Node.js/Rust have equal external container limits and a separate restricted database identity. Placements, drivers, preparation, buffering and execution environments differ.',
      'CPU replay preserves data and contract but has no driver/network wait and a different allocation/cache/interleaving pattern. It diagnoses client processing cost, not end-to-end production performance.',
      'The implementations use different numbers of phase-clock calls (approximately 30,000 Rust, 20,000 ABAP, 15,000 Node per full scan, plus Node driver counters). Key-state commits, deadline checks and bookkeeping fall into slightly different residual boundaries. Fine differences below observer overhead should not be overinterpreted.',
      'DB-only controls retain normal scan setup; for example, Rust still initializes the SHA-256 prefix. Replay allocation and application batching differ by implementation. Replay and DB-only medians cannot be subtracted from live medians to identify exact components.',
      'Three short diagnostic repetitions provide observed ranges, not a confidence interval or a claim about language speed in general. All scans and spikes remain included.',
      'The saved 180-second native results are historical context. This investigation changes code for instrumentation and runs at a later time.',
    ] };
}

export async function analyzeBufferDirectory(inputDirectory, report) {
  const directory = await realpath(resolve(inputDirectory)), manifestPath = resolve(directory, 'manifest.json');
  const evidence = await validateEvidenceIndex(directory);
  const bytes = await readFile(manifestPath), manifest = JSON.parse(bytes);
  assert.equal(manifest.protocol, 'sap-node-hana-buffer-control-v1'); assert.equal(manifest.status, 'complete');
  assert.equal(manifest.rounds, 3); assert.equal(manifest.blocks.length, 6); assert.equal(manifest.duration_seconds, 15); assert.equal(manifest.warmup_scans, 5);
  assert.equal(manifest.main_run.manifest_sha256, report.source.manifest_sha256); assert.equal(manifest.expected_digest, digest); assert.equal(manifest.expected_rows, 5000);
  assert.equal(manifest.query_sha256, report.configuration.query_sha256); assert.equal(manifest.image, report.provenance.images.node); assert.equal(manifest.final_image, manifest.image);
  assert.equal(manifest.client_resources.cpu_limit, 1); assert.equal(manifest.client_resources.memory_bytes, 268435456);
  assert.equal(sha256(await readFile(await childPath(directory, 'native-hana.sql'))), manifest.query_sha256);
  assert.equal(sha256(await readFile(await childPath(directory, 'run-node-hana-buffer-control.mjs'))), manifest.script_sha256);
  const variants = {};
  for (const item of manifest.source_inputs) {
    const sourceBytes = await readFile(await childPath(directory, item.snapshot)); assert.equal(sha256(sourceBytes), item.sha256);
    variants[item.variant_kib] ??= {}; variants[item.variant_kib][item.file] = sourceBytes;
  }
  const transport = variants[128]?.['sql-transport.mjs']?.toString('utf8');
  assert.equal(transport?.split('resultSetRowSetLimitKB: 128').length, 2);
  assert.deepEqual(Object.keys(variants[128]).sort(), Object.keys(variants[1024]).sort());
  for (const file of Object.keys(variants[128])) {
    if (file === 'sql-transport.mjs') assert.equal(variants[1024][file].toString('utf8'), transport.replace('resultSetRowSetLimitKB: 128', 'resultSetRowSetLimitKB: 1024'));
    else assert.deepEqual(variants[128][file], variants[1024][file]);
    assert.equal(sha256(variants[128][file]), report.source.source_inputs.find(item => item.path === `clients/node/src/${file}`)?.sha256);
  }
  const blocks = [];
  let previousFinish = 0;
  for (const [index, entry] of manifest.blocks.entries()) {
    assert.equal(entry.passed, true);
    const blockBytes = await readFile(await childPath(directory, entry.path)), block = JSON.parse(blockBytes);
    assert.equal(block.block_index, index + 1); assert.equal(block.round, entry.round); assert.equal(block.buffer_kib, entry.buffer_kib);
    assert.equal(block.buffer_kib, manifest.schedule[block.round - 1][index % 2]);
    const rawBytes = await readFile(await childPath(directory, entry.path.replace(/\.json$/, '.ndjson')));
    assert.deepEqual(rawBytes.toString('utf8').trim().split(/\r?\n/).map(line => JSON.parse(line)), block.records);
    const started = Date.parse(block.started_utc), finished = Date.parse(block.finished_utc);
    assert(started >= previousFinish && finished > started); previousFinish = finished;
    const summaries = block.records.filter(item => item.kind === 'summary'); assert.equal(summaries.length, 1);
    assert(block.records.every(item => ['scan', 'summary'].includes(item.kind)));
    const summary = summaries[0], scans = block.records.filter(item => item.kind === 'scan'), measured = scans.filter(item => item.phase === 'measured');
    assert.equal(summary.outcome, 'ok'); assert.equal(summary.warmup_scans, 5); assert.equal(scans.length - measured.length, 5); assert.equal(summary.measured_scans, measured.length); assert(summary.measured_wall_ms >= 15000);
    for (const scan of scans) {
      assert.equal(scan.outcome, 'ok'); assert.equal(scan.error, null); assert.equal(scan.rows, 5000); assert.equal(scan.pages, 51); assert.equal(scan.digest, digest);
      const timing = scan.metrics.profile; assert([...phaseNames, 'total_ms'].every(name => finite(timing[name]) && timing[name] >= 0));
      assert(Math.abs(sum(phaseNames.map(name => timing[name])) - timing.total_ms) < 0.03);
      const calls = scan.metrics.driver_statistics.driver_calls; assert.equal(calls.logical_fetch, 51); assert.equal(calls.next_sync + calls.next_async, 5001); assert.equal(calls.get_values_sync + calls.get_values_async, 5000);
    }
    const timings = measured.map(item => item.metrics.profile), latencies = timings.map(item => item.total_ms);
    blocks.push({ block_index: block.block_index, round: block.round, buffer_kib: block.buffer_kib, source_file: entry.path, source_sha256: sha256(blockBytes), raw_records_sha256: sha256(rawBytes),
      measured_scans: measured.length, warmup_scans: 5, measured_wall_ms: summary.measured_wall_ms, p50_ms: nearestRank(latencies, 0.5), p95_ms: nearestRank(latencies, 0.95),
      phase_means_ms: Object.fromEntries([...phaseNames, 'total_ms'].map(name => [name, mean(timings.map(value => value[name]))])), driver_statistics_means: driverMeans(measured),
      samples: scans.map(scan => ({ phase: scan.phase, scan_index: scan.scan_index, elapsed_ms: scan.metrics.elapsed_ms, timings: scan.metrics.profile, driver_statistics: scan.metrics.driver_statistics })) });
  }
  const summaries = [128, 1024].map(kib => {
    const selected = blocks.filter(item => item.buffer_kib === kib).sort((a, b) => a.round - b.round); assert.equal(selected.length, 3); assert.equal(new Set(selected.map(item => item.round)).size, 3);
    return { buffer_kib: kib, measured_scans: sum(selected.map(item => item.measured_scans)), p50_ms: stats(selected.map(item => item.p50_ms)),
      phases_ms: Object.fromEntries([...phaseNames, 'total_ms'].map(name => [name, stats(selected.map(item => item.phase_means_ms[name]))])),
      additive_mean_ms: Object.fromEntries([...phaseNames, 'total_ms'].map(name => [name, mean(selected.map(item => item.phase_means_ms[name]))])),
      next_async_calls: stats(selected.map(item => item.driver_statistics_means.driver_calls.next_async.mean)) };
  });
  const ratio = stats([1, 2, 3].map(round => blocks.find(item => item.round === round && item.buffer_kib === 1024).phase_means_ms.total_ms / blocks.find(item => item.round === round && item.buffer_kib === 128).phase_means_ms.total_ms));
  return { source: { run_directory: directory, manifest_file: posix(relative(root, manifestPath)), manifest_sha256: sha256(bytes), source_inputs: manifest.source_inputs, published_evidence: evidence },
    configuration: { duration_seconds: 15, warmup_scans: 5, rounds: 3, buffers_kib: [128, 1024], client_resources: manifest.client_resources, image: manifest.image, query_sha256: manifest.query_sha256 },
    variant_diff_verified: true, methods: 'Only resultSetRowSetLimitKB changes from 128 to 1024. Full row validation, ordering, canonical bytes and digest remain enabled; all other source bytes and resources match. Counts describe native API calls, not proven wire round trips.',
    ratio_1024_to_128_mean_latency: ratio, summaries, blocks };
}

function number(value) { return value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }
function interval(value) { return `${number(value.median)} (${number(value.minimum)}–${number(value.maximum)})`; }
export function markdown(report) {
  const lines = ['# Native HANA performance investigation', '', `Run: \`${report.run_id}\`. Three repetitions per client and mode, five warmups; 5,000 rows and the same canonical SHA-256 in every full scan. All ${report.summaries.reduce((n, item) => n + item.successful_scans, 0).toLocaleString('en-US')} measured diagnostic scans passed their applicable checks. DB-only deliberately omits validation/hash.`, '',
    '![Database, validation and hashing breakdown](native-profile-investigation.png)', '', '## Directly timed live components', '', 'Milliseconds per scan: median of three trial **means**, with the observed trial range. Validation includes mapping, normalization and ordering; hashing includes canonical bytes, UTF-8 conversion, updates and finalization.', '',
    '| Client | Database + driver | Validation | Canonical bytes + SHA-256 | Cleanup | Residual | Total |', '|---|---:|---:|---:|---:|---:|---:|'];
  const nodeGap = report.live_profile_gap_components.find(item => item.implementation === 'node').difference_ms;
  const abap = report.summaries.find(item => item.implementation === 'abap' && item.mode === 'live_profile').additive_mean_ms;
  const interpretation = [
    `Rust's observed lead over Node.js is split between database/driver work and validation/mapping/ordering: ${number(nodeGap.database_ms)} ms and ${number(nodeGap.validation_ms)} ms of the ${number(nodeGap.total_ms)} ms profiled mean gap.`,
    `ABAP's database stage averages ${number(abap.database_ms)} ms, while its CPU validation and canonical-byte/hash stages average ${number(abap.validation_ms)} and ${number(abap.hashing_ms)} ms.`,
    ...(report.buffer_control ? ['Changing the Node row-set cache from 128 to 1024 KiB leaves all 168 potentially blocking advances per scan unchanged and changes paired mean time by about 3%, with one pair reversing direction.'] : []),
    'Profiling raises observed ABAP time by roughly 10%; Node/Rust enabled/disabled differences stay within a few percent across these trials, so the earlier uninstrumented results remain the performance headline.',
  ];
  lines.splice(4, 0, '## Findings', '', interpretation.join(' '), '');
  for (const item of report.summaries.filter(item => item.mode === 'live_profile')) lines.push(`| ${item.label} | ${[...phaseNames, 'total_ms'].map(name => interval(item.phases_ms[name])).join(' | ')} |`);
  lines.push('', 'Component medians need not add to the median total. The chart uses equal-weight arithmetic means of the three trial means so its stacked components add exactly.', '', '## Instrumentation and isolation controls', '',
    '| Client | Live control mean ms | Profile/control mean ratio | DB-only mean ms | CPU replay mean ms |', '|---|---:|---:|---:|---:|');
  for (const implementation of implementations) {
    const select = mode => report.summaries.find(item => item.implementation === implementation && item.mode === mode);
    const comparison = report.comparisons.find(item => item.implementation === implementation);
    lines.push(`| ${labels[implementation]} | ${interval(select('live_control').mean_total_ms)} | ${interval(comparison.profile_to_control_mean_ratio)}× | ${interval(select('db_only').mean_total_ms)} | ${interval(select('replay_full').mean_total_ms)} |`);
  }
  lines.push('', 'Ratios pair diagnostic rounds. Controls include temporal and code-path variation. Separate medians were not subtracted to manufacture components.', '', '## CPU replay components', '',
    '| Client | Validation ms | Canonical bytes + SHA-256 ms | Residual ms | Total ms |', '|---|---:|---:|---:|---:|');
  for (const item of report.summaries.filter(item => item.mode === 'replay_full')) lines.push(`| ${item.label} | ${['validation_ms', 'hashing_ms', 'residual_ms', 'total_ms'].map(name => interval(item.phases_ms[name])).join(' | ')} |`);
  lines.push('', '## Where the observed gap occurs', '', 'Differences below use the directly timed additive means (equal weight per trial), so their components sum to the observed profiled mean gap. They do not subtract independent control/replay medians. Observer overhead is included.', '',
    '| Comparison | Database + driver gap ms | Validation gap ms | Hashing gap ms | Cleanup + residual gap ms | Total gap ms |', '|---|---:|---:|---:|---:|---:|');
  for (const item of report.live_profile_gap_components) {
    const values = item.difference_ms;
    lines.push(`| ${labels[item.implementation]} − Rust | ${number(values.database_ms)} | ${number(values.validation_ms)} | ${number(values.hashing_ms)} | ${number(values.cleanup_ms + values.residual_ms)} | ${number(values.total_ms)} |`);
  }
  const driverBlocks = report.blocks.filter(item => item.implementation === 'node' && item.mode === 'live_profile' && item.driver_statistics_means);
  if (driverBlocks.length) {
    lines.push('', '## Node native driver observations', '', 'These are means within each trial, then median and range across trials. Driver API calls are not measured wire round trips.', '', '| API calls per scan | Median (trial range) |', '|---|---:|');
    for (const name of Object.keys(driverBlocks[0].driver_statistics_means.driver_calls)) lines.push(`| ${name} | ${interval(stats(driverBlocks.map(item => item.driver_statistics_means.driver_calls[name].mean)))} |`);
    lines.push('', '| Server report | CPU ms | Processing ms |', '|---|---:|---:|');
    for (const stage of ['prepare', 'execute', 'fetch']) {
      const cell = name => { const values = driverBlocks.map(item => item.driver_statistics_means.server[stage][name]).filter(finite).map(value => value / 1000); return values.length ? interval(stats(values)) : 'Unavailable'; };
      lines.push(`| ${stage} | ${cell('cpu_us')} | ${cell('processing_us')} |`);
    }
    lines.push('', 'Statement execution includes the initially returned rows; the result-set report covers subsequent fetches. Server reports exclude network time and do not describe JavaScript/native conversion or client processing. Zero/unavailable reports remain null in the JSON. SAP documents these Node.js API scopes and microsecond units in its [Statement reference, sections 14.6.12–14](https://help.sap.com/doc/e48ad53de2444b5f987c75288c42758a/2.0.04/en-US/SAP_HANA_Client_Interface_Programming_Reference_en.pdf#page=241) and [ResultSet reference, section 14.5.9](https://help.sap.com/doc/e48ad53de2444b5f987c75288c42758a/2.0.04/en-US/SAP_HANA_Client_Interface_Programming_Reference_en.pdf#page=225).');
  }
  if (report.buffer_control) {
    lines.push('', '## Node buffer size control', '', report.buffer_control.methods, '', '| Native row-set cache limit | Database + driver ms | Validation ms | Hashing ms | Total ms | Async next calls/scan |', '|---|---:|---:|---:|---:|---:|');
    for (const item of report.buffer_control.summaries) lines.push(`| ${item.buffer_kib} KiB | ${['database_ms', 'validation_ms', 'hashing_ms', 'total_ms'].map(name => interval(item.phases_ms[name])).join(' | ')} | ${interval(item.next_async_calls)} |`);
    lines.push('', `Paired-round mean-latency ratio, 1024/128 KiB: **${interval(report.buffer_control.ratio_1024_to_128_mean_latency)}×**. This tests this single driver setting; blocking API calls are not necessarily distinct network requests.`, '', '![Node row-set buffer control](native-profile-buffer-control.png)');
  }
  lines.push('', '## Earlier uninstrumented native benchmark', '', 'Historical p50 values below come from the preserved 180-second trials. Diagnostic controls run later, for shorter windows, with profiler code disabled. Rust/ABAP diagnostic wrappers expose precise totals, whereas the official scan metrics used whole milliseconds.', '',
    '| Client | Saved native p50 ms | Diagnostic control p50 ms (trial range) |', '|---|---:|---:|');
  for (const implementation of implementations) {
    const old = report.official_baseline.summaries.find(item => item.implementation === `${implementation}_native`);
    const current = report.summaries.find(item => item.implementation === implementation && item.mode === 'live_control');
    lines.push(`| ${labels[implementation]} | ${number(old.p50_ms.median)} | ${interval(current.p50_ms)} |`);
  }
  lines.push('', '## Source evidence', '');
  for (const evidence of report.implementation_evidence) lines.push(`- **${labels[evidence.implementation]}:** ${evidence.observation} ${evidence.paths.map(path => `[${path}](../${path})`).join(', ')}.`);
  lines.push('', '## Limits', '', ...report.limitations.map(item => `- ${item}`), '', '## Reproduce and inspect', '',
    `- [Pinned manifest](../${report.source.manifest_file.replace(/\\/g, '/')}) · SHA-256 \`${report.source.manifest_sha256}\``,
    '- [Machine-readable report](native-profile-investigation.json): every scan latency, phase sample and available driver statistic.', '- [Saved 180-second native/HTTP/CDS report](native-comparison.md).',
    '- [Diagnostic protocol](native-profile-protocol.md) · [Independent audit](native-profile-audit.txt).',
    ...(report.buffer_control ? [`- [Buffer control manifest](../${report.buffer_control.source.manifest_file.replace(/\\/g, '/')}) · ${report.buffer_control.summaries.reduce((n, item) => n + item.measured_scans, 0).toLocaleString('en-US')} additional measured scans; all passed.`] : []), '',
    '```powershell', `node scripts/analyze-native-profile.mjs "${posix(relative(root, report.source.run_directory))}"${report.buffer_control ? ` --buffer-run "${posix(relative(root, report.buffer_control.source.run_directory))}"` : ''}`, '```', '');
  return lines.join('\n');
}

function selfTest() {
  const manifest = { rounds: 3, warmup_scans: 5, expected_rows: 5000, expected_digest: digest };
  const blocks = [];
  for (let round = 1; round <= 3; round++) for (const implementation of implementations) for (const mode of modes) {
    const timings = { database_ms: mode === 'replay_full' ? 0 : 2, validation_ms: mode === 'db_only' ? 0 : 3, hashing_ms: mode === 'db_only' ? 0 : 1, cleanup_ms: mode === 'replay_full' ? 0 : 0.1, residual_ms: 0.5 };
    timings.total_ms = sum(Object.values(timings));
    const scans = Array.from({ length: 7 }, (_, index) => ({ kind: 'scan', phase: index < 5 ? 'warmup' : 'measured', schema_version: 1, scan_index: index, outcome: 'ok', rows: 5000, pages: 51, digest: mode === 'db_only' ? null : digest, error: null, metrics: { elapsed_ms: timings.total_ms, body_bytes: 0, ...(mode === 'live_control' ? {} : { profile: { ...timings } }) } }));
    blocks.push({ block_index: blocks.length + 1, round, implementation, mode, duration_seconds: 1, verification: { passed: true, failed_scans: 0 }, records: [...scans, { kind: 'summary', outcome: 'ok', warmup_scans: 5, measured_scans: 2, measured_wall_ms: 1000 }] });
  }
  const report = summarizeBlocks(blocks, manifest); assert.equal(report.summaries.length, 12); assert.equal(report.blocks.length, 36);
  for (const summary of report.summaries.filter(item => item.mode !== 'live_control')) assert(Math.abs(sum(phaseNames.map(name => summary.additive_mean_ms[name])) - summary.additive_mean_ms.total_ms) < 1e-9);
  const broken = structuredClone(blocks); broken[0].records[0].error = { code: 'HIDDEN' }; assert.throws(() => summarizeBlocks(broken, manifest));
  const badSum = structuredClone(blocks); badSum[1].records[0].metrics.profile.hashing_ms += 1; assert.throws(() => summarizeBlocks(badSum, manifest));
  const short = structuredClone(blocks); short[0].records.at(-1).measured_wall_ms = 1; assert.throws(() => summarizeBlocks(short, manifest));
  assert.throws(() => summarizeBlocks(blocks.slice(1), manifest));
  console.log('Native profile analysis self-test passed.');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const args = process.argv.slice(2);
    if (args[0] === '--self-test') selfTest();
    else {
      if (!args[0]) throw new Error('A completed profile run directory is required');
      const outputIndex = args.indexOf('--output-dir'), output = outputIndex < 0 ? resolve(root, 'docs') : resolve(args[outputIndex + 1]);
      const report = await analyzeDirectory(args[0]);
      const bufferIndex = args.indexOf('--buffer-run'); if (bufferIndex >= 0) report.buffer_control = await analyzeBufferDirectory(args[bufferIndex + 1], report);
      await mkdir(output, { recursive: true });
      await writeFile(resolve(output, 'native-profile-investigation.json'), JSON.stringify(report, null, 2) + '\n');
      await writeFile(resolve(output, 'native-profile-investigation.md'), markdown(report) + '\n');
      console.log(`Validated ${report.blocks.length} blocks; wrote native profile report to ${output}`);
    }
  } catch (error) { console.error(`Analysis refused: ${error.message}`); process.exitCode = 1; }
}
