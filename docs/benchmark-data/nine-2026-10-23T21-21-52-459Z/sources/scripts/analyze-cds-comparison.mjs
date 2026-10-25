#!/usr/bin/env node
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { analyzeDirectory as analyzeHttpDirectory, nearestRank } from './analyze-performance.mjs';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const defaultOutput = resolve(projectRoot, 'docs');
const digest = 'df57de597e919adb10ae5365201b999788e86b39219ad040ffbc305539180bc7';
const baselineSource = 'fa1b254be2368a091acca469e7f67b224f5557a3';
const finite = value => typeof value === 'number' && Number.isFinite(value);
const sha256 = value => createHash('sha256').update(value).digest('hex');
const readJson = async path => JSON.parse(await readFile(path, 'utf8'));
const posix = path => path.split(sep).join('/');
const repetitionSummary = values => ({ median: nearestRank(values, 0.5), minimum: Math.min(...values), maximum: Math.max(...values), repetitions: values });
const total = (items, key) => items.reduce((sum, item) => sum + item[key], 0);

function publicData(value) {
  if (Array.isArray(value)) return value.map(publicData);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value)
    .filter(([key]) => !/password|username|secret|token|authorization|credential|cookie|^env$|environment_variables/i.test(key))
    .map(([key, item]) => [key, publicData(item)]));
  if (typeof value === 'string' && /^https?:\/\//i.test(value)) {
    try { const url = new URL(value); if (url.username || url.password) return '[redacted URL]'; } catch { return '[invalid URL]'; }
  }
  return value;
}

async function containedPath(directory, name) {
  if (typeof name !== 'string' || !name || isAbsolute(name)) throw new Error('Evidence paths must be relative.');
  const path = await realpath(resolve(directory, name));
  if (!path.startsWith(directory + sep)) throw new Error('Evidence path leaves its directory.');
  return path;
}

async function pinnedHttpBaseline(reference) {
  if (!reference || reference.path !== 'docs/performance-comparison.json' || !/^[a-f0-9]{64}$/.test(reference.sha256 || '')
      || reference.source_revision !== baselineSource || !/^[a-f0-9]{40}$/.test(reference.report_revision || '')) throw new Error('The historical HTTP baseline must be pinned by path, hash and source/report revisions.');
  const path = await containedPath(projectRoot, reference.path);
  const bytes = await readFile(path);
  if (sha256(bytes) !== reference.sha256) throw new Error('Pinned HTTP report hash mismatch.');
  const saved = JSON.parse(bytes.toString('utf8'));
  if (saved.status !== 'validated' || saved.synthetic_test_data || saved.protocol !== 'sap-http-benchmark-v1'
      || saved.provenance?.source_revision !== reference.source_revision || saved.blocks?.length !== 9 || saved.summaries?.length !== 3
      || saved.configuration?.expected_rows !== 5000 || saved.configuration?.expected_pages !== 51 || saved.configuration?.expected_digest !== digest) throw new Error('The saved HTTP baseline is not the expected validated experiment.');
  const manifestPath = await containedPath(projectRoot, saved.source.manifest_file);
  const manifestBytes = await readFile(manifestPath);
  if (sha256(manifestBytes) !== saved.source.manifest_sha256) throw new Error('Historical HTTP manifest hash mismatch.');
  const rawManifest = JSON.parse(manifestBytes.toString('utf8'));
  const recomputed = await analyzeHttpDirectory(dirname(manifestPath));
  assert.deepEqual(recomputed.summaries, saved.summaries, 'Historical HTTP summary differs from its raw records.');
  assert.deepEqual(recomputed.blocks, saved.blocks, 'Historical HTTP blocks differ from their raw records.');
  return { ...reference, run_id: saved.run_id, manifest_sha256: saved.source.manifest_sha256, identity_sha256: rawManifest.identity_sha256, sap_client: rawManifest.sap_client, saved };
}

export async function analyzeDirectory(inputDirectory, { allowSynthetic = false } = {}) {
  const directory = await realpath(resolve(inputDirectory));
  const manifestPath = resolve(directory, 'manifest.json');
  const manifestBytes = await readFile(manifestPath);
  const manifest = JSON.parse(manifestBytes.toString('utf8'));
  const issues = [];
  const check = (condition, message) => { if (!condition) issues.push(message); };
  check(manifest.protocol === 'sap-cds-benchmark-v1' && manifest.status === 'complete', 'A completed direct-CDS benchmark is required.');
  check(finite(manifest.duration_seconds) && manifest.duration_seconds >= 180, 'Measured target must be at least 180 seconds.');
  check(Number.isSafeInteger(manifest.warmup_scans) && manifest.warmup_scans >= 5, 'At least five warmup scans are required.');
  check(manifest.rounds === 3 && manifest.implementation === 'abap_cds', 'Exactly three native ABAP repetitions are required.');
  check(manifest.expected_rows === 5000 && manifest.expected_digest === digest, 'The frozen dataset differs.');
  check(manifest.cds_entity === 'ZI_BL_OrderPosition' && manifest.db_package_size === 100 && manifest.expected_application_batches === 50, 'The native cursor/package workload differs.');
  check(manifest.expected_http_requests === 0 && manifest.expected_body_bytes === 0, 'Native transport settings differ.');
  check(manifest.sap_client === '001' && manifest.identity_matches_http_baseline === true, 'SAP client/identity does not match the saved workload.');
  check(manifest.continuous === true && manifest.output_buffered_until_after_timing === true, 'Continuous scans and output buffered after timing are required.');
  check(!manifest.synthetic_test_data || allowSynthetic, 'Synthetic data cannot produce a real comparison report.');
  check(Array.isArray(manifest.blocks) && manifest.blocks.length === 3, 'All three native blocks must be present.');
  check(typeof manifest.source_revision === 'string' && /^[a-f0-9]{40}$/.test(manifest.source_revision), 'Measured source revision is missing.');
  check(Array.isArray(manifest.source_inputs) && manifest.source_inputs.length > 0 && manifest.source_inputs.every(item => typeof item.path === 'string' && /^[a-f0-9]{64}$/.test(item.sha256)), 'Measured source hashes are missing.');
  const readiness = manifest.post_refactor_http_validation;
  check(readiness && typeof readiness === 'object' && !Array.isArray(readiness), 'Post-refactor HTTP conformance evidence is required.');
  check(readiness?.all_passed === true && readiness?.source_activation_succeeded === true && readiness?.unit_alerts === 0, 'Post-refactor conformance or activation evidence reports failure.');
  for (const group of ['offline', 'socket', 'unit']) check(Number.isSafeInteger(readiness?.[`${group}_cases`]) && readiness[`${group}_cases`] > 0 && readiness[`${group}_passed`] === readiness[`${group}_cases`], `Post-refactor ${group} evidence is incomplete or failed.`);
  const nativeProof = readiness?.native_proof, httpProof = readiness?.authenticated_http_proof;
  check(nativeProof?.outcome === 'ok' && nativeProof?.error === null && nativeProof?.rows === 5000 && nativeProof?.pages === 50 && nativeProof?.digest === digest && nativeProof?.application_batches === 50 && nativeProof?.http_requests === 0 && nativeProof?.metrics?.body_bytes === 0, 'Native readiness proof does not match the frozen workload.');
  check(httpProof?.outcome === 'ok' && httpProof?.error === null && httpProof?.rows === 5000 && httpProof?.pages === 51 && httpProof?.digest === digest && httpProof?.metrics?.body_bytes === 1074741, 'Post-refactor HTTP readiness proof does not match the frozen workload.');
  for (const path of ['sap/src/zcl_bl_poll_orders.clas.abap', 'sap/src/zcl_bl_bench_cds.clas.abap']) check(readiness?.sources?.find(item => item.path === path)?.sha256 === manifest.source_inputs?.find(item => item.path === path)?.sha256 && !!manifest.source_inputs?.find(item => item.path === path), `Readiness source hash differs from measured ${path}.`);
  if (issues.length) throw new Error(issues.join('\n'));
  const baseline = await pinnedHttpBaseline(manifest.http_baseline);
  if (manifest.identity_sha256 !== baseline.identity_sha256 || manifest.sap_client !== baseline.sap_client) throw new Error('SAP client or identity hash differs from the historical HTTP experiment.');
  let evidence = null;
  const evidencePath = resolve(directory, 'evidence-files.json');
  const evidenceBytes = await readFile(evidencePath).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
  if (evidenceBytes) {
    const index = JSON.parse(evidenceBytes.toString('utf8'));
    if (!Array.isArray(index.files) || !index.files.length) throw new Error('Published evidence index is empty.');
    for (const item of index.files) {
      const bytes = await readFile(await containedPath(directory, item.path));
      if (bytes.length !== item.bytes || sha256(bytes) !== item.sha256) throw new Error(`Published evidence hash mismatch: ${item.path}`);
    }
    if (!index.files.some(item => item.path === 'readiness/summary.json')) throw new Error('Published readiness summary is missing.');
    assert.deepEqual(await readJson(resolve(directory, 'readiness/summary.json')), readiness, 'Published readiness summary differs from the measured manifest.');
    evidence = { index_file: posix(relative(projectRoot, evidencePath)), index_sha256: sha256(evidenceBytes), validated_files: index.files.length, readiness_summary_file: posix(relative(projectRoot, resolve(directory, 'readiness/summary.json'))) };
  }
  const blocks = [], paths = new Set();
  let previousFinished = -Infinity;
  for (const [index, entry] of manifest.blocks.entries()) {
    const prefix = `Native block ${index + 1}`;
    check(entry.round === index + 1 && entry.implementation === 'abap_cds' && entry.passed !== false, `${prefix}: invalid manifest identity or failed gate.`);
    const path = await containedPath(directory, entry.path);
    check(!paths.has(path), `${prefix}: duplicate file.`); paths.add(path);
    const bytes = await readFile(path), block = JSON.parse(bytes.toString('utf8'));
    check(block.block_index === index + 1 && block.round === index + 1 && block.implementation === 'abap_cds', `${prefix}: block identity mismatch.`);
    check(block.exit_code === 0 && block.verification?.passed === true && block.verification?.failures === 0, `${prefix}: unsuccessful process or correctness gate.`);
    const started = Date.parse(block.started_utc), finished = Date.parse(block.finished_utc);
    check(finite(started) && finite(finished) && finished > started && started >= previousFinished, `${prefix}: invalid or overlapping UTC boundaries.`);
    previousFinished = finished;
    const records = Array.isArray(block.records) ? block.records : [];
    check(Array.isArray(block.records) && records.every(item => item && ['scan', 'summary'].includes(item.kind)), `${prefix}: missing or unknown records could hide failures.`);
    const summaries = records.filter(item => item.kind === 'summary');
    check(summaries.length === 1 && records.at(-1)?.kind === 'summary', `${prefix}: exactly one final summary is required.`);
    const summary = summaries[0] || {};
    check(summary.transport === 'direct_cds' && summary.http_requests === 0, `${prefix}: native transport summary mismatch.`);
    check(summary.entity === 'ZI_BL_OrderPosition' && summary.sap_client === '001' && summary.db_package_size === 100, `${prefix}: native entity/client/package settings mismatch.`);
    check(summary.outcome === undefined || summary.outcome === 'ok', `${prefix}: failed summary.`);
    check(summary.failed_scans === undefined || summary.failed_scans === 0, `${prefix}: summary reports failed scans.`);
    const scans = records.filter(item => item.kind === 'scan');
    const warmup = scans.filter(item => item.phase === 'warmup'), measured = scans.filter(item => item.phase === 'measured');
    check(scans.every(item => ['warmup', 'measured'].includes(item.phase)), `${prefix}: unknown phase.`);
    check(warmup.length >= manifest.warmup_scans && summary.warmup_scans === warmup.length, `${prefix}: unaccounted warmup scans.`);
    check(measured.length > 0 && summary.measured_scans === measured.length, `${prefix}: measured count mismatch.`);
    check(finite(summary.measured_wall_ms) && summary.measured_wall_ms >= manifest.duration_seconds * 1000, `${prefix}: measured window is too short.`);
    check(finished - started + 1000 >= summary.measured_wall_ms, `${prefix}: measured wall exceeds control boundaries.`);
    let measurementStarted = false;
    for (const [scanIndex, scan] of scans.entries()) {
      if (scan.phase === 'measured') measurementStarted = true;
      check(!(measurementStarted && scan.phase === 'warmup'), `${prefix}: late warmup.`);
      const label = `${prefix}, scan ${scanIndex + 1}`;
      check(scan.schema_version === 1 && Number.isSafeInteger(scan.scan_index) && scan.scan_index >= 0, `${label}: invalid envelope.`);
      check(scan.outcome === 'ok' && scan.error === null, `${label}: failed or hidden-error scan.`);
      check(scan.rows === 5000 && scan.pages === 50 && scan.digest === digest, `${label}: row/package/digest mismatch.`);
      check(scan.metrics?.body_bytes === 0, `${label}: unexpected HTTP body bytes.`);
      check(scan.transport === 'direct_cds' && scan.http_requests === 0, `${label}: unexpected HTTP requests or transport.`);
      check(scan.application_batches === 50, `${label}: native package mismatch.`);
      check(finite(scan.metrics?.elapsed_ms) && scan.metrics.elapsed_ms > 0, `${label}: invalid outer latency.`);
    }
    const latencies = measured.map(scan => scan.metrics?.elapsed_ms);
    check(latencies.every(finite) && latencies.reduce((sum, value) => sum + value, 0) <= summary.measured_wall_ms + 1, `${prefix}: scan durations exceed sequential wall time.`);
    check(summary.measured_valid_rows === undefined || summary.measured_valid_rows === measured.length * 5000, `${prefix}: summary row total mismatch.`);
    check(summary.measured_body_bytes === undefined || summary.measured_body_bytes === 0, `${prefix}: summary body bytes mismatch.`);
    check(summary.measured_application_batches === measured.length * 50, `${prefix}: summary application package total mismatch.`);
    if (!latencies.length || !latencies.every(finite) || !finite(summary.measured_wall_ms)) continue;
    const scanTime = latencies.reduce((sum, value) => sum + value, 0), firstSlow = latencies.findIndex(value => value > 1000);
    const late = firstSlow < 0 ? [] : latencies.slice(firstSlow);
    blocks.push({ block_index: index + 1, round: index + 1, implementation: 'abap_cds', source_file: entry.path, source_sha256: sha256(bytes), started_utc: block.started_utc, finished_utc: block.finished_utc,
      warmup_scans: warmup.length, attempts: measured.length, successful_scans: measured.length, failed_scans: 0, error_counts: {}, measured_wall_ms: summary.measured_wall_ms,
      p50_ms: nearestRank(latencies, 0.5), p95_ms: nearestRank(latencies, 0.95), useful_rows_per_second: measured.length * 5000 / (summary.measured_wall_ms / 1000),
      p99_ms: nearestRank(latencies, 0.99), maximum_latency_ms: latencies.reduce((maximum, value) => Math.max(maximum, value), 0), scans_over_1000_ms: latencies.filter(value => value > 1000).length,
      mean_latency_ms: scanTime / latencies.length,
      latency_series: measured.map(scan => ({ scan_index: scan.scan_index, elapsed_ms: scan.metrics.elapsed_ms })),
      late_slowdown: { threshold_ms: 1000, first_scan_index: firstSlow < 0 ? null : measured[firstSlow].scan_index, preceding_scans: firstSlow < 0 ? measured.length : firstSlow,
        remaining_scans: late.length, all_remaining_over_threshold: late.length > 0 && late.every(value => value > 1000), remaining_elapsed_scan_ms: late.reduce((sum, value) => sum + value, 0),
        total_elapsed_scan_ms: scanTime, remaining_share_of_elapsed_scan_time: late.reduce((sum, value) => sum + value, 0) / scanTime },
      latency_samples: latencies.length, application_batches_per_scan: 50, http_requests_per_scan: 0, http_body_bytes: 0 });
  }
  if (issues.length) throw new Error(issues.slice(0, 35).join('\n') + (issues.length > 35 ? `\n...${issues.length - 35} more failures.` : ''));
  if (blocks.length !== 3) throw new Error('All three valid native blocks are required.');
  const native = { implementation: 'abap_cds', label: 'ABAP direct CDS', historical: false, repetitions: 3, successful_scans: total(blocks, 'successful_scans'), failed_scans: 0,
    p50_ms: repetitionSummary(blocks.map(item => item.p50_ms)), p95_ms: repetitionSummary(blocks.map(item => item.p95_ms)), useful_rows_per_second: repetitionSummary(blocks.map(item => item.useful_rows_per_second)) };
  const historical = ['abap', 'node', 'rust'].map(implementation => {
    const original = baseline.saved.summaries.find(item => item.implementation === implementation);
    if (!original) throw new Error('A saved HTTP client summary is missing.');
    return { ...original, implementation: `${implementation}_http`, label: `${original.label} HTTP (saved)`, historical: true };
  });
  const savedAbap = historical[0];
  return { schema_version: 1, protocol: manifest.protocol, status: 'validated', synthetic_test_data: !!manifest.synthetic_test_data, analyzed_at_utc: new Date().toISOString(), run_id: basename(directory),
    source: { run_directory: directory, manifest_file: posix(relative(projectRoot, manifestPath)), manifest_sha256: sha256(manifestBytes), published_evidence: evidence },
    configuration: { duration_seconds: manifest.duration_seconds, warmup_scans: manifest.warmup_scans, rounds: 3, cds_entity: manifest.cds_entity, db_package_size: 100, expected_rows: 5000, expected_digest: digest, expected_application_batches: 50, expected_http_requests: 0, expected_body_bytes: 0 },
    methods: { percentiles: 'Nearest rank within each repetition: one-based rank ceil(p*n).', aggregation: 'Median and observed range of three repetition statistics; no pooling of scans as independent trials.', throughput: 'Successful scans * 5000 / actual measured wall seconds.', ratio: 'Descriptive ratio of native median throughput to historical ABAP HTTP median throughput; not a causal estimate.', uncertainty: 'Three repetitions; show all points and ranges without a confidence interval or significance claim.' },
    provenance: publicData({ source_revision: manifest.source_revision, source_inputs: manifest.source_inputs, sap_client: manifest.sap_client, identity_matches_http_baseline: manifest.identity_matches_http_baseline, docker: manifest.docker, sap_container: manifest.sap_container, post_refactor_http_validation: readiness }),
    http_baseline: { ...manifest.http_baseline, run_id: baseline.run_id, manifest_sha256: baseline.manifest_sha256, raw_manifest_file: baseline.saved.source.manifest_file },
    summaries: [native, ...historical], blocks, http_blocks: baseline.saved.blocks.map(block => ({ ...block, implementation: `${block.implementation}_http` })),
    ratios: { cds_to_saved_abap_http_throughput: native.useful_rows_per_second.median / savedAbap.useful_rows_per_second.median, saved_abap_http_to_cds_p50: savedAbap.p50_ms.median / native.p50_ms.median },
    resource_observations: publicData({ scope: 'Whole SAP container snapshots, not isolated native-client CPU/RSS; sampled maxima are not true peaks. Historical HTTP allocations and placement remain different.', sample_interval_seconds: manifest.resource_sample_interval_seconds, baseline: manifest.baseline_resources || [], blocks: await Promise.all(manifest.blocks.map(async entry => { const block = await readJson(resolve(directory, entry.path)); return { round: entry.round, samples: block.resource_samples || [] }; })) }),
    limitations: ['The direct CDS and saved HTTP results were measured at different times and source revisions. The common-validator refactor was checked for correctness, but historical HTTP timing was not rerun.', 'All three native repetitions develop a late slower phase. Its cause is unresolved; the whole-window ratio is not a steady-state throughput claim.', 'One native Open SQL SELECT/cursor with 50 nonempty application packages differs from 51 paginated HTTP responses. Package counts are not SQL statement counts or measured database wire fetch counts.', 'The paths differ in OData/SADL service work, authentication, network placement, JSON serialization/parsing and query/pagination strategy; the ratio cannot isolate HTTP protocol cost or language speed.', 'ABAP shares SAP application-server and database resources. The saved external clients had separate placements and explicit container limits.', 'The dataset is frozen and uses CHF/EA. The result does not establish general currency/unit conversion parity, concurrent-write behavior or production capacity.'] };
}

const number = value => value.toLocaleString('en-US', { maximumFractionDigits: 2 });
const interval = metric => `${number(metric.median)} (${number(metric.minimum)}–${number(metric.maximum)})`;
function markdown(report) {
  const test = report.synthetic_test_data ? '**SYNTHETIC TEST DATA — NOT A PERFORMANCE RESULT.**\n\n' : '';
  const rows = report.summaries.map(item => `| ${item.label} | ${item.successful_scans} | ${interval(item.p50_ms)} | ${interval(item.p95_ms)} | ${interval(item.useful_rows_per_second)} | ${item.failed_scans} |`).join('\n')
    + '\n\n**The native repetitions change to a slower final phase. Its cause is unresolved; p50/p95 do not describe that phase. See the complete sequence plot and diagnostics below.**';
  const published = report.source.published_evidence;
  const evidenceText = published ? ` The durable [readiness summary](${published.readiness_summary_file.replace(/^docs\//, '')}) and [evidence index](${published.index_file.replace(/^docs\//, '')}) preserve the raw readiness files; the index maps their original execution paths to the published copies. All ${published.validated_files} indexed file hashes were verified.` : '';
  const checks = report.provenance.post_refactor_http_validation;
  const temporalRows = report.blocks.map(item => `| ${item.round} | ${number(item.mean_latency_ms)} | ${number(item.p99_ms)} | ${number(item.maximum_latency_ms)} | ${item.late_slowdown.first_scan_index ?? 'None'} | ${item.scans_over_1000_ms} | ${number(item.late_slowdown.remaining_share_of_elapsed_scan_time * 100)}% |`).join('\n');
  const detail = report.blocks.map(item => `| ${item.round} | ${item.successful_scans} | ${number(item.measured_wall_ms / 1000)} | ${number(item.p50_ms)} | ${number(item.p95_ms)} | ${number(item.useful_rows_per_second)} | ${item.failed_scans} |`).join('\n')
    + `\n\n### Late native slowdown\n\nThis is a temporal change, not scattered isolated spikes: ${report.blocks.every(item => item.late_slowdown.first_scan_index === 1389 && item.late_slowdown.all_remaining_over_threshold) ? 'in all three repetitions, the first 1,389 measured scans are at or below one second; every measured scan from zero-based index **1389** onward exceeds one second' : 'the sequence plot and diagnostics below show when scans cross one second and whether the remainder stays above it'}. The p50/p95 summaries alone conceal this final phase. Its cause is unresolved. The **${number(report.ratios.cds_to_saved_abap_http_throughput)}× whole-window throughput ratio is descriptive and is not a steady-state claim**. No earlier fast-only segment replaces the complete recorded window.\n\n| Repetition | Mean ms | p99 ms | Max ms | First >1 s scan index | Scans >1 s | Late phase share of summed scan time |\n| --- | ---: | ---: | ---: | ---: | ---: | ---: |\n${temporalRows}\n\nAll ${total(report.blocks, 'scans_over_1000_ms')} scans over one second remain included in the wall-time throughput denominator. Scan-time shares sum the outer scan timings; they exclude loop overhead. Native elapsed values have integer-millisecond resolution.\n\nPost-refactor readiness passed ${checks.offline_passed}/${checks.offline_cases} offline cases, ${checks.socket_passed}/${checks.socket_cases} real-socket cases, and ${checks.unit_passed}/${checks.unit_cases} ABAP unit checks, with zero unit alerts, plus matching native and authenticated HTTP count/digest proofs.${evidenceText}`;
  return `# Direct CDS and saved HTTP comparison\n\n${test}Native run: \`${report.run_id}\`. All three native repetitions passed: 5,000 rows, 50 nonempty application packages and the shared expected digest on every warmup and measured scan. Each repetition measured at least ${report.configuration.duration_seconds} seconds after at least ${report.configuration.warmup_scans} warmup scans. There were ${total(report.blocks, 'successful_scans')} successful measured native scans and ${total(report.blocks, 'warmup_scans')} warmup scans, with no errors.\n\nThe HTTP rows are the preserved [earlier HTTP experiment](performance-comparison.md), not new measurements. They retain its nine raw blocks and source revision.\n\n![Native and historical HTTP repetition-level latency and throughput](cds-comparison.png)\n\n## Summary\n\nValues are the median of three repetition statistics, with their observed minimum–maximum in parentheses. These ranges are not confidence intervals.\n\n| Path | Successful measured scans | p50 ms, median (range) | p95 ms, median (range) | Useful rows/s, median (range) | Failures |\n| --- | ---: | ---: | ---: | ---: | ---: |\n${rows}\n\nNative median throughput was **${number(report.ratios.cds_to_saved_abap_http_throughput)}×** the saved ABAP HTTP median. Saved ABAP HTTP p50 was ${number(report.ratios.saved_abap_http_to_cds_p50)}× the native p50. These describe different end-to-end access paths at different times and source versions; they do not estimate HTTP-only overhead or language speed.\n\n## Native repetitions\n\n| Repetition | Successful scans | Actual wall s | p50 ms | p95 ms | Useful rows/s | Failures |\n| --- | ---: | ---: | ---: | ---: | ---: | ---: |\n${detail}\n\nPercentiles use nearest rank within each repetition. Throughput is successful scans × 5,000 divided by actual measured wall seconds, including loop overhead and the final scan that crosses the target boundary. No individual scan is treated as an independent repeated experiment.\n\n## What the native path measures\n\nOne ordered Open SQL SELECT/cursor reads \`ZI_BL_OrderPosition\` with \`PACKAGE SIZE 100\`. Its 50 nonempty ABAP processing packages are not 50 SQL queries or a measured count of database wire fetches. The same row validation, canonicalization and SHA-256 implementation is shared with the refactored HTTP path. Native \`http_requests=0\` and \`body_bytes=0\` mean no HTTP traffic; they do not measure database transport bytes. The timer includes cursor opening, reading, conversion, validation, hashing and cursor cleanup, and excludes ADT dispatch, warmup and final output serialization.\n\n## Interpretation limits\n\n${report.limitations.map(item => `- ${item}`).join('\n')}\n- Three native repetitions and the three historical repetitions per client show observed variation only. No statistical winner or universal performance ratio is claimed.\n- Resource snapshots, if present in the JSON, cover the shared SAP system. They are not an isolated native ABAP process measurement.\n\n## Evidence\n\nThe [machine-readable comparison](cds-comparison.json) preserves repetition metrics, actual readiness evidence, source hashes and resource snapshots. The [native protocol](cds-benchmark-protocol.md) defines the measurement boundary. Native source revision: \`${report.provenance.source_revision}\`; manifest SHA-256: \`${report.source.manifest_sha256}\`. Native raw manifest: \`${report.source.manifest_file}\`.\n\nPinned HTTP report SHA-256: \`${report.http_baseline.sha256}\`. Its measurement source revision is \`${report.http_baseline.source_revision}\`, and its report revision is \`${report.http_baseline.report_revision}\`. Saved HTTP run: \`${report.http_baseline.run_id}\`. Both saved summaries and their raw records were revalidated before comparison.\n`;
}

export async function writeReport(report, outputDirectory = defaultOutput) {
  const output = resolve(outputDirectory);
  if (report.synthetic_test_data && output === defaultOutput) throw new Error('Synthetic output must remain outside real docs.');
  await mkdir(output, { recursive: true });
  await writeFile(resolve(output, 'cds-comparison.json'), JSON.stringify(report, null, 2) + '\n');
  await writeFile(resolve(output, 'cds-comparison.md'), markdown(report));
}

async function selfTest() {
  const work = resolve(projectRoot, 'work'); await mkdir(work, { recursive: true });
  const directory = await mkdtemp(resolve(work, 'cds-analysis-selftest-'));
  const baselineBytes = await readFile(resolve(defaultOutput, 'performance-comparison.json'));
  const savedBaseline = JSON.parse(baselineBytes.toString('utf8'));
  const savedManifest = await readJson(resolve(projectRoot, savedBaseline.source.manifest_file));
  const syntheticSources = ['sap/src/zcl_bl_poll_orders.clas.abap', 'sap/src/zcl_bl_bench_cds.clas.abap'].map(path => ({ path, sha256: 'a'.repeat(64) }));
  const proof = { outcome: 'ok', error: null, rows: 5000, pages: 50, digest, application_batches: 50, http_requests: 0, metrics: { body_bytes: 0 } };
  const readiness = { all_passed: true, source_activation_succeeded: true, offline_cases: 1, offline_passed: 1, socket_cases: 1, socket_passed: 1, unit_cases: 1, unit_passed: 1, unit_alerts: 0, native_proof: proof, authenticated_http_proof: { ...proof, pages: 51, metrics: { body_bytes: 1074741 } }, sources: syntheticSources };
  const manifest = { protocol: 'sap-cds-benchmark-v1', status: 'complete', duration_seconds: 180, warmup_scans: 5, rounds: 3, implementation: 'abap_cds', cds_entity: 'ZI_BL_OrderPosition', db_package_size: 100, expected_application_batches: 50, expected_rows: 5000, expected_digest: digest, expected_http_requests: 0, expected_body_bytes: 0, sap_client: '001', identity_sha256: savedManifest.identity_sha256, identity_matches_http_baseline: true, continuous: true, output_buffered_until_after_timing: true, source_revision: 'a'.repeat(40), source_inputs: syntheticSources, post_refactor_http_validation: readiness, synthetic_test_data: true, http_baseline: { path: 'docs/performance-comparison.json', sha256: sha256(baselineBytes), source_revision: baselineSource, report_revision: '8521711b972dcda25858c3bf75b4b0655eed82f6' }, blocks: [] };
  for (let index = 0; index < 3; index++) {
    const path = `block-${index + 1}.json`; manifest.blocks.push({ path, round: index + 1, implementation: 'abap_cds', passed: true });
    const records = Array.from({ length: 9 }, (_, scanIndex) => ({ kind: 'scan', phase: scanIndex < 5 ? 'warmup' : 'measured', schema_version: 1, scan_index: scanIndex, outcome: 'ok', rows: 5000, pages: 50, digest, error: null, transport: 'direct_cds', application_batches: 50, http_requests: 0, metrics: { elapsed_ms: scanIndex < 5 ? 100 : (scanIndex - 4) * 1000, body_bytes: 0 } }));
    records.push({ kind: 'summary', transport: 'direct_cds', http_requests: 0, entity: 'ZI_BL_OrderPosition', sap_client: '001', db_package_size: 100, measured_application_batches: 200, measured_wall_ms: 180000, measured_scans: 4, warmup_scans: 5 });
    await writeFile(resolve(directory, path), JSON.stringify({ block_index: index + 1, round: index + 1, implementation: 'abap_cds', started_utc: new Date(Date.UTC(2026, 0, 1) + index * 200000).toISOString(), finished_utc: new Date(Date.UTC(2026, 0, 1) + index * 200000 + 181000).toISOString(), exit_code: 0, verification: { passed: true, failures: 0 }, records }));
  }
  const saveManifest = () => writeFile(resolve(directory, 'manifest.json'), JSON.stringify(manifest));
  await saveManifest(); const report = await analyzeDirectory(directory, { allowSynthetic: true });
  assert.equal(report.blocks[0].p50_ms, 2000); assert.equal(report.blocks[0].p95_ms, 4000); assert.equal(report.summaries[0].successful_scans, 12); assert.equal(report.blocks[0].useful_rows_per_second, 20000 / 180);
  assert.equal(report.blocks[0].mean_latency_ms, 2500); assert.equal(report.blocks[0].p99_ms, 4000); assert.equal(report.blocks[0].latency_series.length, 4);
  assert.equal(report.blocks[0].late_slowdown.first_scan_index, 6); assert.equal(report.blocks[0].late_slowdown.all_remaining_over_threshold, true); assert.equal(report.blocks[0].late_slowdown.remaining_share_of_elapsed_scan_time, 0.9);
  await assert.rejects(analyzeDirectory(directory), /Synthetic/);
  const path = resolve(directory, manifest.blocks[0].path), block = await readJson(path), saveBlock = () => writeFile(path, JSON.stringify(block));
  block.records.at(-1).measured_wall_ms = 179999; await saveBlock(); await assert.rejects(analyzeDirectory(directory, { allowSynthetic: true }), /too short/);
  block.records.at(-1).measured_wall_ms = 180000; block.records[5].error = { code: 'CDS' }; await saveBlock(); await assert.rejects(analyzeDirectory(directory, { allowSynthetic: true }), /hidden-error/);
  block.records[5].error = null; block.records[5].pages = 51; await saveBlock(); await assert.rejects(analyzeDirectory(directory, { allowSynthetic: true }), /package\/digest/);
  block.records[5].pages = 50; block.records[5].metrics.body_bytes = 1; await saveBlock(); await assert.rejects(analyzeDirectory(directory, { allowSynthetic: true }), /body bytes/);
  block.records[5].metrics.body_bytes = 0; await saveBlock(); manifest.http_baseline.sha256 = 'b'.repeat(64); await saveManifest(); await assert.rejects(analyzeDirectory(directory, { allowSynthetic: true }), /hash mismatch/);
  manifest.http_baseline.sha256 = sha256(baselineBytes); manifest.post_refactor_http_validation.unit_passed = 0; await saveManifest(); await assert.rejects(analyzeDirectory(directory, { allowSynthetic: true }), /unit evidence/);
  manifest.post_refactor_http_validation.unit_passed = 1; manifest.identity_sha256 = 'b'.repeat(64); await saveManifest(); await assert.rejects(analyzeDirectory(directory, { allowSynthetic: true }), /identity hash/);
  manifest.identity_sha256 = savedManifest.identity_sha256; await saveManifest(); await writeReport(report, resolve(directory, 'report')); await assert.rejects(writeReport(report), /outside real docs/);
  process.stdout.write(`CDS analysis self-test passed. Synthetic artifacts: ${directory}\n`);
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length === 1 && args[0] === '--self-test') return selfTest();
  if (args.length !== 1 && !(args.length === 3 && args[1] === '--output-dir')) throw new Error('Usage: node scripts/analyze-cds-comparison.mjs <runDirectory> [--output-dir directory] | --self-test');
  const report = await analyzeDirectory(args[0]); await writeReport(report, args.length === 3 ? args[2] : defaultOutput);
  process.stdout.write(`Validated three native blocks and the pinned historical HTTP records for ${report.run_id}.\n`);
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main().catch(error => { process.stderr.write(`CDS analysis refused: ${error.message}\n`); process.exitCode = 1; });
