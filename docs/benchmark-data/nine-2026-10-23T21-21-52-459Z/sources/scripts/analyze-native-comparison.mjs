#!/usr/bin/env node
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { analyzeDirectory as analyzeHttp, nearestRank } from './analyze-performance.mjs';
import { analyzeDirectory as analyzeCds } from './analyze-cds-comparison.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const defaultOutput = resolve(root, 'docs');
const digest = 'df57de597e919adb10ae5365201b999788e86b39219ad040ffbc305539180bc7';
const clients = ['node', 'rust', 'abap'];
const labels = { node: 'Node.js', rust: 'Rust', abap: 'ABAP' };
const order = [['node', 'rust', 'abap'], ['rust', 'abap', 'node'], ['abap', 'node', 'rust']];
const baselineHashes = { http: '473eaefb76b39d4f8f466737aeaad201c3b7eacf99b92607fdec299b3baccb15', cds: '5898cd0a859404068e9be26fe1dd09eeb7db6e8cd91e6179a837d5a6198a3a79' };
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const finite = value => typeof value === 'number' && Number.isFinite(value);
const sum = values => values.reduce((a, b) => a + b, 0);
const total = (items, key) => sum(items.map(item => item[key]));
const json = async path => JSON.parse(await readFile(path, 'utf8'));
const posix = path => path.split(sep).join('/');
const repetitions = values => ({ median: nearestRank(values, 0.5), minimum: Math.min(...values), maximum: Math.max(...values), repetitions: values });

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

async function baseline(kind, reference) {
  const path = kind === 'http' ? 'docs/performance-comparison.json' : 'docs/cds-comparison.json';
  if (reference?.path !== path || reference.sha256 !== baselineHashes[kind]) throw new Error(`The ${kind.toUpperCase()} baseline must use the pinned historical path and hash.`);
  const bytes = await readFile(await childPath(root, path));
  if (sha256(bytes) !== reference.sha256) throw new Error(`Historical ${kind.toUpperCase()} report hash mismatch.`);
  const saved = JSON.parse(bytes.toString('utf8'));
  if (saved.status !== 'validated' || saved.synthetic_test_data || saved.configuration?.expected_rows !== 5000 || saved.configuration?.expected_digest !== digest) throw new Error(`The historical ${kind.toUpperCase()} report is not the expected experiment.`);
  if (reference.source_revision && reference.source_revision !== saved.provenance.source_revision) throw new Error(`Historical ${kind.toUpperCase()} source revision mismatch.`);
  const manifestPath = await childPath(root, saved.source.manifest_file);
  const manifestBytes = await readFile(manifestPath);
  if (sha256(manifestBytes) !== saved.source.manifest_sha256) throw new Error(`Historical ${kind.toUpperCase()} manifest hash mismatch.`);
  const recomputed = await (kind === 'http' ? analyzeHttp : analyzeCds)(dirname(manifestPath));
  assert.deepEqual(recomputed.blocks, saved.blocks, `Historical ${kind.toUpperCase()} blocks differ from their raw records.`);
  assert.deepEqual(recomputed.summaries, saved.summaries, `Historical ${kind.toUpperCase()} summaries differ from their raw records.`);
  return { reference: { ...reference, run_id: saved.run_id, source_revision: saved.provenance.source_revision, manifest_sha256: saved.source.manifest_sha256, raw_manifest_file: saved.source.manifest_file }, saved };
}

function slowSegments(values, threshold) {
  const segments = [];
  for (let index = 0; index < values.length; index++) {
    if (values[index] <= threshold) continue;
    const start = index;
    while (index + 1 < values.length && values[index + 1] > threshold) index++;
    const selected = values.slice(start, index + 1);
    segments.push({ first_measured_index: start, last_measured_index: index, scans: selected.length, elapsed_scan_ms: sum(selected), maximum_latency_ms: selected.reduce((a, b) => Math.max(a, b), 0) });
  }
  return segments;
}

export async function analyzeDirectory(inputDirectory, { allowSynthetic = false } = {}) {
  const directory = await realpath(resolve(inputDirectory));
  const manifestPath = resolve(directory, 'manifest.json');
  const manifestBytes = await readFile(manifestPath);
  const manifest = JSON.parse(manifestBytes.toString('utf8'));
  const issues = [], check = (condition, message) => { if (!condition) issues.push(message); };
  check(manifest.protocol === 'sap-native-hana-benchmark-v1' && manifest.status === 'complete', 'A completed native HANA run is required.');
  check(finite(manifest.duration_seconds) && manifest.duration_seconds >= 180, 'Each measured target must be at least 180 seconds.');
  check(Number.isSafeInteger(manifest.warmup_scans) && manifest.warmup_scans >= 5, 'At least five warmup scans are required.');
  check(manifest.rounds === 3 && manifest.blocks?.length === 9, 'Exactly nine blocks in three balanced rounds are required.');
  check(manifest.expected_rows === 5000 && manifest.expected_pages === 51 && manifest.expected_digest === digest && manifest.expected_body_bytes === 0, 'The frozen native workload differs.');
  check(manifest.sap_client === '001' && manifest.continuous === true, 'SAP client 001 and continuous scans are required.');
  check(manifest.output_buffered_until_after_timing === true, 'Scan records must serialize after the measured window.');
  check(manifest.connection_lifecycle?.policy === 'persistent', 'Native connections must persist across scans.');
  check(manifest.client_resources?.cpu_limit === 1 && manifest.client_resources?.memory_bytes === 268435456, 'External clients must use the equal one-CPU/256-MiB allocation.');
  check(/^[a-f0-9]{40}$/.test(manifest.source_revision || ''), 'Measured source revision is missing.');
  check(Array.isArray(manifest.source_inputs) && manifest.source_inputs.length > 0 && manifest.source_inputs.every(item => typeof item.path === 'string' && /^[a-f0-9]{64}$/.test(item.sha256 || '')), 'Measured source hashes are missing.');
  check(manifest.readiness?.ready === true && manifest.live_parity?.all_passed === true, 'Live readiness or parity evidence is incomplete.');
  check(!manifest.synthetic_test_data || allowSynthetic, 'Synthetic data cannot produce a real comparison report.');
  if (issues.length) throw new Error(issues.join('\n'));
  const http = await baseline('http', manifest.http_baseline), cds = await baseline('cds', manifest.cds_baseline);
  const evidencePath = resolve(directory, 'evidence-files.json');
  const evidenceBytes = await readFile(evidencePath).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
  let evidence = null;
  if (evidenceBytes) {
    const index = JSON.parse(evidenceBytes.toString('utf8'));
    if (!Array.isArray(index.files) || index.files.length === 0) throw new Error('Published evidence index is empty.');
    const indexedPaths = new Set();
    for (const item of index.files) {
      if (indexedPaths.has(item.path)) throw new Error('Published evidence index repeats a file.');
      indexedPaths.add(item.path);
      const bytes = await readFile(await childPath(directory, item.path));
      if (bytes.length !== item.bytes || sha256(bytes) !== item.sha256) throw new Error(`Published evidence hash mismatch: ${item.path}`);
    }
    if (!indexedPaths.has('readiness/readiness.json')) throw new Error('Published readiness evidence is missing.');
    assert.deepEqual(await json(resolve(directory, 'readiness/readiness.json')), manifest.readiness, 'Published readiness differs from measured readiness.');
    evidence = { index_file: posix(relative(root, evidencePath)), index_sha256: sha256(evidenceBytes), validated_files: index.files.length, readiness_file: posix(relative(root, resolve(directory, 'readiness/readiness.json'))) };
  }
  const checkedSources = [];
  for (const item of manifest.source_inputs) {
    if (!item.snapshot && manifest.synthetic_test_data) continue;
    const bytes = await readFile(await childPath(directory, item.snapshot));
    if (sha256(bytes) !== item.sha256) throw new Error(`Source snapshot hash mismatch: ${item.path}`);
    checkedSources.push({ path: item.path, snapshot: item.snapshot, sha256: item.sha256 });
  }
  if (!manifest.synthetic_test_data) {
    if (manifest.query?.path !== 'contracts/native-hana.sql' || manifest.query.sha256 !== manifest.source_inputs.find(item => item.path === 'contracts/native-hana.sql')?.sha256 || manifest.query.sha256 !== manifest.live_parity.query_sha256) throw new Error('The common SQL query hash differs between source, manifest and live parity.');
    if (sha256(await readFile(await childPath(directory, 'readiness/view-definition.csv'))) !== manifest.query.actual_view_definition_sha256) throw new Error('Actual database view-definition hash mismatch.');
    if (JSON.stringify(manifest.final_images) !== JSON.stringify(manifest.images)) throw new Error('The runtime images changed during measurement.');
  }
  const blocks = [], paths = new Set();
  let previousFinished = -Infinity;
  for (const [index, entry] of manifest.blocks.entries()) {
    const round = Math.floor(index / 3) + 1, implementation = order[round - 1][index % 3], prefix = `Native block ${index + 1}`;
    check(entry.round === round && entry.implementation === implementation && entry.passed === true, `${prefix}: incorrect balanced order or failed gate.`);
    const path = await childPath(directory, entry.path);
    check(!paths.has(path), `${prefix}: duplicate result path.`); paths.add(path);
    const bytes = await readFile(path), block = JSON.parse(bytes.toString('utf8'));
    let rawRecords = null;
    if (!manifest.synthetic_test_data) {
      const rawPath = entry.path.replace(/\.json$/, '.ndjson');
      if (rawPath === entry.path) throw new Error(`${prefix}: expected a JSON block filename.`);
      const rawBytes = await readFile(await childPath(directory, rawPath));
      const parsedRecords = rawBytes.toString('utf8').split(/\r?\n/).filter(line => line.trim()).map(line => JSON.parse(line));
      assert.deepEqual(parsedRecords, block.records, `${prefix}: raw NDJSON differs from block records.`);
      rawRecords = { path: rawPath, sha256: sha256(rawBytes), records: parsedRecords.length };
    }
    check(block.block_index === index + 1 && block.round === round && block.implementation === implementation, `${prefix}: block identity mismatch.`);
    check(block.exit_code === 0 && block.verification?.passed === true && block.verification?.failures === 0, `${prefix}: unsuccessful process or verification gate.`);
    const started = Date.parse(block.started_utc), finished = Date.parse(block.finished_utc);
    check(finite(started) && finite(finished) && finished > started && started >= previousFinished, `${prefix}: invalid or overlapping UTC boundaries.`);
    previousFinished = finished;
    const records = Array.isArray(block.records) ? block.records : [];
    check(Array.isArray(block.records) && records.every(item => item && ['scan', 'summary'].includes(item.kind)), `${prefix}: unknown records could hide failures.`);
    const summaries = records.filter(item => item.kind === 'summary'), summary = summaries[0] || {};
    check(summaries.length === 1 && records.at(-1)?.kind === 'summary', `${prefix}: exactly one final summary is required.`);
    const scans = records.filter(item => item.kind === 'scan'), warmup = scans.filter(item => item.phase === 'warmup'), measured = scans.filter(item => item.phase === 'measured');
    const transport = implementation === 'abap' ? 'native_hana_adbc' : 'hana';
    check(summary.transport === transport && (summary.outcome === undefined || summary.outcome === 'ok') && (summary.failed_scans === undefined || summary.failed_scans === 0), `${prefix}: native summary reports a different transport or failure.`);
    check(scans.every(item => ['warmup', 'measured'].includes(item.phase)), `${prefix}: unknown scan phase.`);
    check(warmup.length === manifest.warmup_scans && summary.warmup_scans === warmup.length, `${prefix}: warmup count mismatch.`);
    check(measured.length > 0 && summary.measured_scans === measured.length, `${prefix}: measured count mismatch.`);
    check(finite(summary.measured_wall_ms) && summary.measured_wall_ms >= manifest.duration_seconds * 1000, `${prefix}: measurement is too short.`);
    check(finished - started + 1000 >= summary.measured_wall_ms, `${prefix}: measured wall exceeds control boundaries.`);
    let measurementStarted = false, warmupIndex = 0, measuredIndex = 0;
    for (const [scanNumber, scan] of scans.entries()) {
      const label = `${prefix}, scan ${scanNumber + 1}`;
      if (scan.phase === 'measured') measurementStarted = true;
      check(!(measurementStarted && scan.phase === 'warmup'), `${label}: late warmup.`);
      const expectedIndex = scan.phase === 'warmup' ? warmupIndex++ : measuredIndex++ + (implementation === 'abap' ? 0 : warmup.length);
      check(scan.schema_version === 1 && scan.scan_index === expectedIndex, `${label}: scan envelope/index mismatch.`);
      check(scan.outcome === 'ok' && scan.error === null, `${label}: failed or hidden-error scan.`);
      check(scan.rows === 5000 && scan.pages === 51 && scan.digest === digest, `${label}: row/fetch/digest mismatch.`);
      check(scan.metrics?.body_bytes === 0 && finite(scan.metrics?.elapsed_ms) && scan.metrics.elapsed_ms > 0, `${label}: unexpected HTTP bytes or invalid latency.`);
      check(implementation === 'abap' ? scan.transport === transport : scan.transport === undefined || scan.transport === transport, `${label}: native transport mismatch.`);
      check(scan.logical_fetches === undefined || scan.logical_fetches === 51, `${label}: logical fetch count mismatch.`);
      check(scan.http_requests === undefined || scan.http_requests === 0, `${label}: unexpected HTTP requests.`);
    }
    const latencies = measured.map(scan => scan.metrics?.elapsed_ms);
    check(latencies.every(finite) && sum(latencies) <= summary.measured_wall_ms + 1, `${prefix}: scan durations exceed sequential wall time.`);
    for (const [key, expected] of Object.entries({ measured_valid_rows: measured.length * 5000, measured_logical_fetches: measured.length * 51, measured_body_bytes: 0 })) check(summary[key] === undefined || summary[key] === expected, `${prefix}: summary ${key} mismatch.`);
    if (!latencies.length || !latencies.every(finite) || !finite(summary.measured_wall_ms)) continue;
    const segments = slowSegments(latencies, 1000), baselineP10 = nearestRank(latencies, 0.1), relativeThreshold = Math.max(3, baselineP10 * 3);
    blocks.push({ block_index: index + 1, round, implementation: `${implementation}_native`, source_file: entry.path, source_sha256: sha256(bytes), raw_records: rawRecords, started_utc: block.started_utc, finished_utc: block.finished_utc,
      warmup_scans: warmup.length, attempts: measured.length, successful_scans: measured.length, failed_scans: 0, error_counts: {}, measured_wall_ms: summary.measured_wall_ms,
      p50_ms: nearestRank(latencies, 0.5), p95_ms: nearestRank(latencies, 0.95), p99_ms: nearestRank(latencies, 0.99), mean_latency_ms: sum(latencies) / latencies.length,
      maximum_latency_ms: latencies.reduce((a, b) => Math.max(a, b), 0), useful_rows_per_second: measured.length * 5000 / (summary.measured_wall_ms / 1000),
      latency_samples: latencies.length, scans_over_1000_ms: total(segments, 'scans'), over_1000_ms_segments: segments,
      relative_slow_scans: { p10_ms: baselineP10, threshold_ms: relativeThreshold, count: latencies.filter(value => value > relativeThreshold).length, segments: slowSegments(latencies, relativeThreshold) },
      latency_series: measured.map((scan, measuredIndex) => ({ measured_index: measuredIndex, scan_index: scan.scan_index, total_scan_ordinal: warmup.length + measuredIndex + 1, elapsed_ms: scan.metrics.elapsed_ms })),
      logical_fetches_per_scan: 51, http_requests_per_scan: 0, http_body_bytes: 0 });
  }
  if (issues.length) throw new Error(issues.slice(0, 40).join('\n') + (issues.length > 40 ? `\n...${issues.length - 40} more failures.` : ''));
  if (blocks.length !== 9) throw new Error('All nine valid native blocks are required.');
  const native = clients.map(client => {
    const items = blocks.filter(block => block.implementation === `${client}_native`);
    return { implementation: `${client}_native`, label: `${labels[client]} native HANA`, historical: false, repetitions: 3, successful_scans: total(items, 'successful_scans'), failed_scans: 0,
      p50_ms: repetitions(items.map(item => item.p50_ms)), p95_ms: repetitions(items.map(item => item.p95_ms)), useful_rows_per_second: repetitions(items.map(item => item.useful_rows_per_second)) };
  });
  const historical = http.saved.summaries.map(item => ({ ...item, implementation: `${item.implementation}_http`, label: `${item.label} HTTP (saved)`, historical: true }));
  const cdsSummary = { ...cds.saved.summaries.find(item => item.implementation === 'abap_cds'), label: 'ABAP direct CDS (saved)', historical: true };
  const summaries = [...native, ...historical, cdsSummary], byId = Object.fromEntries(summaries.map(item => [item.implementation, item]));
  const ratio = (numerator, denominator) => ({ numerator, denominator, throughput_ratio: byId[numerator].useful_rows_per_second.median / byId[denominator].useful_rows_per_second.median, inverse_p50_ratio: byId[denominator].p50_ms.median / byId[numerator].p50_ms.median });
  const ratios = [...clients.map(client => ratio(`${client}_native`, `${client}_http`)), ratio('abap_native', 'abap_cds'), ratio('rust_native', 'node_native'), ratio('abap_native', 'node_native'), ratio('abap_native', 'rust_native')];
  const phaseObservations = {
    over_1000_ms_scans: total(blocks, 'scans_over_1000_ms'),
    over_1000_ms_records: blocks.flatMap(item => item.latency_series.filter(scan => scan.elapsed_ms > 1000).map(scan => ({ implementation: item.implementation, round: item.round, block_index: item.block_index, ...scan }))),
    abap_historical_onset_check: { total_scan_ordinal: 1395,
      over_1000_ms_scans: total(blocks.filter(item => item.implementation === 'abap_native'), 'scans_over_1000_ms'),
      repetitions: blocks.filter(item => item.implementation === 'abap_native').map(item => ({ round: item.round, block_index: item.block_index,
        latency_at_ordinal_ms: item.latency_series.find(scan => scan.total_scan_ordinal === 1395)?.elapsed_ms ?? null,
        maximum_latency_ms: item.maximum_latency_ms,
        maximum_at_or_after_ordinal_ms: item.latency_series.filter(scan => scan.total_scan_ordinal >= 1395).reduce((value, scan) => Math.max(value, scan.elapsed_ms), 0) || null })) }
  };
  return { schema_version: 1, protocol: manifest.protocol, status: 'validated', synthetic_test_data: !!manifest.synthetic_test_data, analyzed_at_utc: new Date().toISOString(), run_id: basename(directory),
    source: { run_directory: directory, manifest_file: posix(relative(root, manifestPath)), manifest_sha256: sha256(manifestBytes), checked_source_snapshots: checkedSources, published_evidence: evidence },
    configuration: publicData({ duration_seconds: manifest.duration_seconds, warmup_scans: manifest.warmup_scans, rounds: 3, expected_rows: 5000, expected_digest: digest, expected_pages: 51, expected_body_bytes: 0, sap_client: '001', order, connection_lifecycle: manifest.connection_lifecycle, client_resources: manifest.client_resources, pacing: 'continuous; one scan in flight; no polling delay' }),
    methods: { percentiles: 'Nearest rank within each repetition: one-based rank ceil(p*n).', aggregation: 'Median and observed minimum/maximum of three repetition statistics; scans are not independent trials.', throughput: 'Successful measured scans * 5000 / actual measured wall seconds, including loop overhead and final boundary-crossing scan.', ratios: 'Ratios of repetition-median metrics; descriptive, not estimates of language speed or isolated HTTP overhead.', uncertainty: 'Three repetitions; all trial values and ranges, no confidence interval or significance claim.', slow_scans: 'All scans retained. Report every contiguous >1000 ms segment and every segment >max(3 ms, 3*within-block p10); these descriptive thresholds do not identify a cause.' },
    provenance: publicData({ source_revision: manifest.source_revision, source_inputs: manifest.source_inputs, working_tree_status: manifest.working_tree_status, query: manifest.query, readiness: manifest.readiness, live_parity: manifest.live_parity, docker: manifest.docker, sap_container: manifest.sap_container, host: manifest.host, topology: manifest.topology, images: manifest.images, final_images: manifest.final_images, runtime_versions: manifest.runtime_versions, build: manifest.build, connection_lifecycle: manifest.connection_lifecycle, client_resources: manifest.client_resources }),
    http_baseline: http.reference, cds_baseline: cds.reference, summaries, blocks,
    historical_blocks: [...http.saved.blocks.map(item => ({ ...item, implementation: `${item.implementation}_http` })), ...cds.saved.blocks], ratios, phase_observations: phaseObservations,
    resource_observations: publicData({ scope: 'Docker snapshots are sampled whole-container observations, not true peaks or isolated ABAP process CPU/RSS. Shared SAP also contains HANA.', sample_interval_seconds: manifest.resource_sample_interval_seconds, baseline: manifest.baseline_resources || [], blocks: await Promise.all(manifest.blocks.map(async entry => { const block = await json(resolve(directory, entry.path)); return { block_index: block.block_index, implementation: block.implementation, resource_samples: block.resource_samples || [] }; })) }),
    limitations: [
      'This compares these implementations, database drivers and local placements. ABAP shares the SAP application server and HANA container; Node.js and Rust have separate equally limited containers. CPU and memory isolation are not equivalent across all three.',
      'ABAP uses the already-connected SAP primary database session as SAPA4H; Node.js and Rust use a restricted view-only account and connect during warmup. Database identities, session settings, kernel/driver preparation and network paths differ.',
      'Native HANA scans share the exact ordered SQL/view, nine text fields, frozen 5000-row dataset, row validation/canonicalization and SHA-256. Driver fetch/buffering behavior differs; 51 logical application fetches are not measured physical wire round trips.',
      'HTTP and CDS results are preserved experiments from different times, source revisions, process lifecycles and runtime/build configurations. HTTP used a fresh client per scan; native HANA reuses a session. Historical timing was not rerun.',
      'Saved CDS uses one Open SQL cursor and 50 nonempty packages; native HANA has 51 logical fetch attempts including the terminal empty fetch. HTTP uses 51 responses. These counts describe different mechanisms.',
      'The saved CDS experiment includes its late slowdown near total scan 1395 (five warmups plus measured index 1389). Its complete-window throughput includes that phase; its p50 is not a substitute for complete-window throughput. The original investigation remains separate.',
      'The frozen local trial uses CHF/EA, no concurrent writes, one in-flight scan and no retries. Results do not establish production capacity, concurrent-write semantics or general currency/unit conversion parity.',
      'Transport deadlines/cancellation differ: public ADBC calls cannot be cancelled through this adapter. No driver-failure timing equivalence is claimed. body_bytes=0 means no HTTP body, not zero SQL network traffic.',
      'Three repetitions show observed variation only. Resource snapshots are sampled whole containers; no confidence interval, statistical winner or isolated language/HTTP-overhead claim is made.'
    ] };
}

export function markdown(report) {
  const n = value => value.toLocaleString('en-US', { maximumFractionDigits: 2 });
  const metric = value => `${n(value.median)} (${n(value.minimum)}–${n(value.maximum)})`;
  const rows = report.summaries.map(item => `| ${item.label} | ${n(item.successful_scans)} | ${metric(item.p50_ms)} | ${metric(item.p95_ms)} | ${metric(item.useful_rows_per_second)} | ${item.failed_scans} |`).join('\n');
  const detail = report.blocks.map(item => `| ${item.block_index} | ${item.implementation.replace('_native', '')} | ${item.round} | ${n(item.successful_scans)} | ${n(item.measured_wall_ms / 1000)} | ${n(item.p50_ms)} | ${n(item.p95_ms)} | ${n(item.useful_rows_per_second)} | ${n(item.maximum_latency_ms)} | ${item.scans_over_1000_ms} |`).join('\n');
  const name = id => report.summaries.find(item => item.implementation === id).label;
  const byId = Object.fromEntries(report.summaries.map(item => [item.implementation, item]));
  const rate = id => byId[id].useful_rows_per_second.median;
  const changed = `## What changed\n\nIn these native HANA trials, Rust's median useful throughput was **${n(rate('rust_native') / rate('node_native'))}× Node.js** and **${n(rate('rust_native') / rate('abap_native'))}× ABAP**. ABAP native p50 was **${n(byId.abap_native.p50_ms.median)} ms versus ${n(byId.abap_cds.p50_ms.median)} ms** for saved CDS (a ${n(byId.abap_cds.p50_ms.median / byId.abap_native.p50_ms.median)}× inverse-p50 ratio), while its full-window useful throughput was **${n(rate('abap_native') / rate('abap_cds'))}×** the saved CDS rate. The saved CDS window includes its slow phase, and the paths also differ in access and value conversion; these figures cannot isolate the contribution of either.`;
  const ratios = report.ratios.map(item => `| ${name(item.numerator)} / ${name(item.denominator)} | ${n(item.throughput_ratio)}× | ${n(item.inverse_p50_ratio)}× |`).join('\n') + `\n\n${changed}`;
  const slow = report.blocks.filter(item => item.scans_over_1000_ms > 0 || item.relative_slow_scans.count > 0);
  const onset = report.phase_observations.abap_historical_onset_check;
  const onsetText = onset.repetitions.map(item => `round ${item.round}: ${item.latency_at_ordinal_ms === null ? 'ordinal not reached' : `${n(item.latency_at_ordinal_ms)} ms`}`).join('; ');
  const maximumText = onset.repetitions.map(item => n(item.maximum_latency_ms)).join('/');
  const phaseText = onset.over_1000_ms_scans === 0
    ? `No ABAP native scan exceeded one second. At total scan ordinal 1,395, latency was ${onsetText}; the three full-block maxima were ${maximumText} ms. These native trials did not reproduce the earlier CDS slowdown at that magnitude; this does not identify its cause.`
    : `The ABAP native trials contain ${onset.over_1000_ms_scans} scans over one second. At total scan ordinal 1,395, latency was ${onsetText}; every slow scan remains included.`;
  const longScans = report.phase_observations.over_1000_ms_records;
  const spikeText = longScans.length === 1
    ? ` The only native scan over one second was ${name(longScans[0].implementation)}, round ${longScans[0].round}, measured index ${longScans[0].measured_index}: ${longScans[0].elapsed_ms.toLocaleString('en-US', { maximumFractionDigits: 3 })} ms. It remains included in the trial statistics.`
    : ` There were ${longScans.length} native measured scans over one second; all remain included in the trial statistics.`;
  const scanSeries = (slow.length ? '\n![Every native measured scan, with no outliers removed](native-scan-latency.png)\n' : '') + `\n${phaseText}${spikeText}\n`;
  const slowText = report.blocks.map(item => `| ${item.block_index} | ${item.implementation.replace('_native', '')} | ${n(item.relative_slow_scans.threshold_ms)} | ${n(item.relative_slow_scans.count)} | ${item.over_1000_ms_segments.map(segment => `${segment.first_measured_index}–${segment.last_measured_index} (${segment.scans})`).join('; ') || 'None'} |`).join('\n');
  return `# Native HANA, HTTP and direct CDS comparison\n\n${report.synthetic_test_data ? '**SYNTHETIC TEST DATA — no performance claim.**\n\n' : ''}Native run: \`${report.run_id}\`. All nine blocks completed in three balanced rounds, with ${total(report.blocks, 'warmup_scans')} warmup scans and ${n(total(report.blocks, 'successful_scans'))} successful measured scans. Every scan returned 5,000 rows, 51 logical fetch attempts and the expected SHA-256; zero errors. The native scan timer includes query/cursor creation, fetch, validation, canonical hashing and cursor cleanup. Connections persist across scans.\n\nThe HTTP and direct CDS rows are the preserved [HTTP experiment](performance-comparison.md) and [CDS experiment](cds-comparison.md), not new measurements. Both saved summaries and their raw records were revalidated; their files were not modified.\n\n![Three native HANA paths and four saved paths, every repetition](native-comparison.png)\n\n## Summary\n\nValues are the median of three repetition statistics; parentheses show the observed minimum–maximum. Ranges are not confidence intervals. Useful rows/s uses the full measured wall time, including every slow scan.\n\n| Path | Successful measured scans | p50 ms, median (range) | p95 ms, median (range) | Useful rows/s, median (range) | Failures |\n| --- | ---: | ---: | ---: | ---: | ---: |\n${rows}\n\n## Descriptive comparisons\n\n| Numerator / denominator | Useful-throughput ratio | Denominator p50 / numerator p50 |\n| --- | ---: | ---: |\n${ratios}\n\nThese ratios compare complete access paths. Native/HTTP ratios also include changed connection lifecycles, software revisions and measurement time. ABAP native/CDS includes different database access and value conversion, plus the saved CDS slowdown; it is not an estimate of CDS overhead. Native language ratios include different runtimes, drivers, database identities and placements.\n\n## Native repetitions\n\nBalanced sequence: Node.js → Rust → ABAP; Rust → ABAP → Node.js; ABAP → Node.js → Rust. Each block has at least ${report.configuration.duration_seconds} measured seconds after ${report.configuration.warmup_scans} warmup scans. The last complete scan crossing the time target is included. Node.js and Rust use equal one-CPU/256-MiB limits; ABAP shares the existing SAP/HANA container.\n\n| Block | Client | Round | Scans | Actual wall s | p50 ms | p95 ms | Useful rows/s | Max ms | Scans >1 s |\n| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |\n${detail}\n\nPercentiles are nearest rank within each repetition. Trial statistics are summarized across three repetitions; individual scans are not treated as independent repeated experiments. SQL physical round trips and wire-byte counts are unknown.\n\n## Complete sequence and slow scans\n\nAll warmup and measured records remain in the raw evidence; every measured latency is also in the JSON. No spikes or phases were removed. The following relative threshold is a descriptive check, max(3 ms, three times each block's p10), and does not establish a cause. Measured indices are zero-based, excluding the five warmups.\n\n| Block | Client | Relative threshold ms | Scans over relative threshold | >1 s segments: first–last measured index (count) |\n| --- | --- | ---: | ---: | --- |\n${slowText}\n${scanSeries}\nThe saved CDS report retains its late slowdown near total scan 1,395 (measured index 1,389 after five warmups). Its whole-window throughput includes the slowdown. Compare complete-window rates; a low median scan latency can coexist with a substantial slow tail.\n\n## Interpretation limits\n\n${report.limitations.map(item => `- ${item}`).join('\n')}\n\n## Evidence\n\n[Machine-readable report](native-comparison.json) contains all repetition metrics, latency sequences, source hashes, ratios and resource snapshots. [Native protocol](native-benchmark-protocol.md) defines the experiment. Native source revision: \`${report.provenance.source_revision}\`; manifest SHA-256: \`${report.source.manifest_sha256}\`. Raw manifest: \`${report.source.manifest_file}\`.\n\nPinned HTTP report SHA-256: \`${report.http_baseline.sha256}\`; source revision \`${report.http_baseline.source_revision}\`. Pinned CDS report SHA-256: \`${report.cds_baseline.sha256}\`; source revision \`${report.cds_baseline.source_revision}\`.\n`;
}

export async function writeReport(report, outputDirectory = defaultOutput) {
  const output = resolve(outputDirectory);
  if (report.synthetic_test_data && output === defaultOutput) throw new Error('Synthetic reports must remain outside real docs.');
  await mkdir(output, { recursive: true });
  await writeFile(resolve(output, 'native-comparison.json'), JSON.stringify(report, null, 2) + '\n');
  await writeFile(resolve(output, 'native-comparison.md'), markdown(report));
}

async function selfTest() {
  const work = resolve(root, 'work'); await mkdir(work, { recursive: true });
  const directory = await mkdtemp(resolve(work, 'native-analysis-selftest-'));
  const manifest = { protocol: 'sap-native-hana-benchmark-v1', status: 'complete', duration_seconds: 180, warmup_scans: 5, rounds: 3, expected_rows: 5000, expected_pages: 51, expected_body_bytes: 0, expected_digest: digest, sap_client: '001', continuous: true, output_buffered_until_after_timing: true, readiness: { ready: true }, live_parity: { all_passed: true }, connection_lifecycle: { policy: 'persistent' }, client_resources: { cpu_limit: 1, memory_bytes: 268435456 }, source_revision: 'a'.repeat(40), source_inputs: [{ path: 'contracts/native-hana.sql', sha256: 'a'.repeat(64) }], synthetic_test_data: true, http_baseline: { path: 'docs/performance-comparison.json', sha256: baselineHashes.http }, cds_baseline: { path: 'docs/cds-comparison.json', sha256: baselineHashes.cds }, blocks: [] };
  for (let index = 0; index < 9; index++) {
    const round = Math.floor(index / 3) + 1, implementation = order[round - 1][index % 3], path = `block-${index + 1}.json`, transport = implementation === 'abap' ? 'native_hana_adbc' : 'hana';
    const records = Array.from({ length: 9 }, (_, scan) => ({ kind: 'scan', phase: scan < 5 ? 'warmup' : 'measured', schema_version: 1, scan_index: implementation === 'abap' && scan >= 5 ? scan - 5 : scan, outcome: 'ok', error: null, rows: 5000, pages: 51, digest, ...(implementation === 'abap' ? { transport } : {}), metrics: { elapsed_ms: scan < 5 ? 1 : (scan - 2) * 10000, body_bytes: 0 } }));
    records.push({ kind: 'summary', transport, measured_wall_ms: 180000, measured_scans: 4, warmup_scans: 5 });
    await writeFile(resolve(directory, path), JSON.stringify({ block_index: index + 1, round, implementation, started_utc: new Date(Date.UTC(2026, 0, 1) + index * 190000).toISOString(), finished_utc: new Date(Date.UTC(2026, 0, 1) + index * 190000 + 181000).toISOString(), exit_code: 0, verification: { passed: true, failures: 0 }, records }));
    manifest.blocks.push({ path, round, implementation, passed: true });
  }
  const saveManifest = () => writeFile(resolve(directory, 'manifest.json'), JSON.stringify(manifest));
  await saveManifest(); const report = await analyzeDirectory(directory, { allowSynthetic: true });
  assert.equal(report.blocks[0].p50_ms, 40000); assert.equal(report.blocks[0].p95_ms, 60000); assert.equal(report.blocks[0].useful_rows_per_second, 20000 / 180);
  assert.equal(report.summaries.length, 7); assert.equal(report.blocks[0].scans_over_1000_ms, 4); assert.equal(report.blocks[0].over_1000_ms_segments[0].last_measured_index, 3);
  assert.equal(report.blocks[0].latency_series[0].total_scan_ordinal, 6); assert.equal(report.historical_blocks.length, 12);
  await assert.rejects(analyzeDirectory(directory), /Synthetic/);
  const blockPath = resolve(directory, manifest.blocks[0].path), block = await json(blockPath), saveBlock = () => writeFile(blockPath, JSON.stringify(block));
  block.records[5].error = { code: 'DB' }; await saveBlock(); await assert.rejects(analyzeDirectory(directory, { allowSynthetic: true }), /hidden-error/);
  block.records[5].error = null; block.records[5].pages = 50; await saveBlock(); await assert.rejects(analyzeDirectory(directory, { allowSynthetic: true }), /fetch\/digest/);
  block.records[5].pages = 51; block.records.at(-1).measured_wall_ms = 179999; await saveBlock(); await assert.rejects(analyzeDirectory(directory, { allowSynthetic: true }), /too short/);
  block.records.at(-1).measured_wall_ms = 180000; await saveBlock(); manifest.http_baseline.sha256 = 'b'.repeat(64); await saveManifest(); await assert.rejects(analyzeDirectory(directory, { allowSynthetic: true }), /pinned historical/);
  manifest.http_baseline.sha256 = baselineHashes.http; await saveManifest(); await writeReport(report, resolve(directory, 'report')); await assert.rejects(writeReport(report), /outside real docs/);
  process.stdout.write(`Native comparison analysis self-test passed. Synthetic artifacts: ${directory}\n`);
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length === 1 && args[0] === '--self-test') return selfTest();
  if (args.length !== 1 && !(args.length === 3 && args[1] === '--output-dir')) throw new Error('Usage: node scripts/analyze-native-comparison.mjs <runDirectory> [--output-dir directory] | --self-test');
  const report = await analyzeDirectory(args[0]); await writeReport(report, args.length === 3 ? args[2] : defaultOutput);
  process.stdout.write(`Validated nine native HANA blocks and both pinned historical experiments for ${report.run_id}.\n`);
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main().catch(error => { process.stderr.write(`Native comparison refused: ${error.message}\n`); process.exitCode = 1; });
