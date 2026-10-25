#!/usr/bin/env node
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, writeFile } from 'node:fs/promises';
import { dirname, basename, isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const clients = ['node', 'rust', 'abap'];
const labels = { node: 'Node.js', rust: 'Rust', abap: 'ABAP' };
const order = [['node', 'rust', 'abap'], ['rust', 'abap', 'node'], ['abap', 'node', 'rust']];
const digest = 'df57de597e919adb10ae5365201b999788e86b39219ad040ffbc305539180bc7';
const serviceRoot = 'http://host.docker.internal/sap/opu/odata4/sap/zui_bl_orders_o4/srvd_a2x/sap/zui_bl_orders/0001/';
const defaultOutput = resolve(projectRoot, 'docs');
const finite = value => typeof value === 'number' && Number.isFinite(value);
const integer = value => Number.isSafeInteger(value);
const sha256 = value => createHash('sha256').update(value).digest('hex');
const json = async path => JSON.parse(await readFile(path, 'utf8'));

export function nearestRank(values, fraction) {
  if (!values.length) throw new Error('A percentile needs at least one observation.');
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(fraction * sorted.length) - 1)];
}

function repetitionSummary(values) {
  return { median: nearestRank(values, 0.5), minimum: Math.min(...values), maximum: Math.max(...values), repetitions: values };
}

function sampledStats(values) {
  const valid = values.filter(finite);
  return valid.length ? { samples: valid.length, minimum: Math.min(...valid), median: nearestRank(valid, 0.5), maximum: Math.max(...valid) } : null;
}

function memoryBytes(value) {
  const match = /^([0-9]+(?:\.[0-9]+)?)\s*([kmgtpe]?i?b)$/i.exec(String(value || '').split('/')[0].trim());
  if (!match) return null;
  const units = { b: 1, kb: 1000, mb: 1000 ** 2, gb: 1000 ** 3, tb: 1000 ** 4, pb: 1000 ** 5, eb: 1000 ** 6, kib: 1024, mib: 1024 ** 2, gib: 1024 ** 3, tib: 1024 ** 4, pib: 1024 ** 5, eib: 1024 ** 6 };
  return Number(match[1]) * units[match[2].toLowerCase()];
}

function resourceBlock(block) {
  const groups = new Map();
  const timestamps = [];
  for (const sample of block.resource_samples || []) {
    const timestamp = Date.parse(sample.at_utc);
    if (Number.isFinite(timestamp)) timestamps.push(timestamp);
    for (const record of sample.data || []) {
      const name = record.Name || record.Container;
      if (typeof name !== 'string') continue;
      const role = name === 'a4h' ? 'shared SAP system' : name === 'sap-local-ports' ? 'port forwarder' : 'external client';
      const group = groups.get(name) || { name, role, cpu: [], memory: [] };
      const percentage = /^([0-9]+(?:\.[0-9]+)?)%$/.exec(String(record.CPUPerc || ''));
      if (percentage) group.cpu.push(Number(percentage[1]));
      const memory = memoryBytes(record.MemUsage);
      if (finite(memory)) group.memory.push(memory);
      groups.set(name, group);
    }
  }
  timestamps.sort((a, b) => a - b);
  return { block_index: block.block_index, implementation: block.implementation, sample_events: (block.resource_samples || []).length,
    observed_interval_seconds: sampledStats(timestamps.slice(1).map((value, index) => (value - timestamps[index]) / 1000)),
    containers: [...groups.values()].map(group => ({ name: group.name, role: group.role, cpu_percent: sampledStats(group.cpu), memory_bytes: sampledStats(group.memory) })),
  };
}

function redacted(value) {
  if (Array.isArray(value)) return value.map(redacted);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).filter(([key]) => !/password|username|secret|token|authorization|credential|cookie|^env$|environment_variables/i.test(key)).map(([key, item]) => [key, redacted(item)]));
  if (typeof value === 'string' && /^https?:\/\//i.test(value)) {
    try { const url = new URL(value); if (url.username || url.password) return '[redacted URL]'; } catch { return '[invalid URL]'; }
  }
  return value;
}

async function childPath(directory, name) {
  if (typeof name !== 'string' || !name || isAbsolute(name)) throw new Error('Block paths must be relative to the run directory.');
  const candidate = await realpath(resolve(directory, name));
  if (!candidate.startsWith(directory + sep)) throw new Error('A block path leaves the run directory.');
  return candidate;
}

export async function analyzeDirectory(inputDirectory, { allowSynthetic = false } = {}) {
  const directory = await realpath(resolve(inputDirectory));
  const manifestPath = resolve(directory, 'manifest.json');
  const manifestBytes = await readFile(manifestPath);
  const manifest = JSON.parse(manifestBytes.toString('utf8'));
  const issues = [];
  const check = (condition, message) => { if (!condition) issues.push(message); };
  check(manifest.protocol === 'sap-http-benchmark-v1', 'Unsupported benchmark protocol.');
  check(manifest.status === 'complete', 'The orchestrator has not marked this run complete.');
  check(finite(manifest.duration_seconds) && manifest.duration_seconds >= 180, 'Target measurement duration must be at least 180 seconds.');
  check(integer(manifest.warmup_scans) && manifest.warmup_scans >= 5, 'At least five warmup scans are required.');
  check(manifest.rounds === 3, 'Exactly three balanced rounds are required.');
  check(manifest.service_root === serviceRoot, 'The common literal HTTP service root differs from the protocol.');
  check(manifest.expected_rows === 5000 && manifest.expected_pages === 51 && manifest.expected_digest === digest, 'Frozen dataset settings differ from the protocol.');
  check(manifest.expected_body_bytes === undefined || manifest.expected_body_bytes === 1074741, 'Payload-byte setting differs from the fixed workload.');
  check(manifest.fresh_client_per_scan === true && manifest.continuous === true, 'Fresh clients and continuous scans are required.');
  check(!manifest.synthetic_test_data || allowSynthetic, 'Synthetic data cannot produce a real performance report.');
  check(Array.isArray(manifest.blocks) && manifest.blocks.length === 9, 'All nine blocks must be present.');
  if (issues.length) throw new Error(issues.join('\n'));

  const blocks = [];
  const resourceBlocks = [];
  const blockPaths = new Set();
  let previousFinished = -Infinity;
  for (const [index, entry] of manifest.blocks.entries()) {
    const prefix = `Block ${index + 1}`;
    const round = Math.floor(index / 3) + 1;
    const implementation = order[round - 1][index % 3];
    check(entry.round === round && entry.implementation === implementation, `${prefix}: planned order is not balanced.`);
    check(entry.passed === undefined || entry.passed === true, `${prefix}: orchestrator marked the block as failed.`);
    const path = await childPath(directory, entry.path);
    check(!blockPaths.has(path), `${prefix}: duplicated result file.`);
    blockPaths.add(path);
    const sourceBytes = await readFile(path);
    const block = JSON.parse(sourceBytes.toString('utf8'));
    check(block.block_index === index + 1 && block.round === round && block.implementation === implementation, `${prefix}: block identity differs from its manifest.`);
    check(block.exit_code === undefined || block.exit_code === 0, `${prefix}: client process exited unsuccessfully.`);
    check(block.verification === undefined || (block.verification.passed === true && block.verification.failures === 0), `${prefix}: orchestrator correctness gate failed.`);
    const started = Date.parse(block.started_utc);
    const finished = Date.parse(block.finished_utc);
    check(Number.isFinite(started) && Number.isFinite(finished) && finished > started, `${prefix}: invalid UTC boundaries.`);
    check(started >= previousFinished, `${prefix}: block overlaps an earlier client.`);
    previousFinished = finished;
    const records = Array.isArray(block.records) ? block.records : [];
    check(Array.isArray(block.records), `${prefix}: missing records.`);
    check(records.every(record => record && ['scan', 'summary'].includes(record.kind)), `${prefix}: unknown records could hide a failed scan.`);
    const summaries = records.filter(record => record?.kind === 'summary');
    check(summaries.length === 1 && records.at(-1)?.kind === 'summary', `${prefix}: exactly one final summary is required.`);
    const summary = summaries[0] || {};
    check(summary.outcome === undefined || summary.outcome === 'ok', `${prefix}: summary reports failure.`);
    check(summary.failed_scans === undefined || summary.failed_scans === 0, `${prefix}: summary reports failed scans.`);
    check(summary.client_policy === undefined || summary.client_policy === 'fresh_per_scan', `${prefix}: client lifecycle differs.`);
    check(summary.transport === undefined || ['socket', 'classic_socket'].includes(summary.transport), `${prefix}: HTTP socket transport is required.`);
    check(summary.service_root === undefined || summary.service_root === serviceRoot, `${prefix}: summary service root differs.`);
    const scans = records.filter(record => record?.kind === 'scan');
    check(scans.every(record => ['warmup', 'measured'].includes(record.phase)), `${prefix}: unknown scan phase.`);
    const warmup = scans.filter(record => record.phase === 'warmup');
    const measured = scans.filter(record => record.phase === 'measured');
    check(warmup.length >= manifest.warmup_scans && summary.warmup_scans === warmup.length, `${prefix}: missing or unaccounted warmup scans.`);
    check(measured.length > 0 && summary.measured_scans === measured.length, `${prefix}: measured scan count differs from summary.`);
    check(finite(summary.measured_wall_ms) && summary.measured_wall_ms >= manifest.duration_seconds * 1000, `${prefix}: measured window is too short.`);
    let measuredStarted = false;
    for (const [scanIndex, scan] of scans.entries()) {
      if (scan.phase === 'measured') measuredStarted = true;
      check(!(measuredStarted && scan.phase === 'warmup'), `${prefix}: warmup occurs after measurement started.`);
      const scanPrefix = `${prefix}, scan ${scanIndex + 1}`;
      check(scan.schema_version === 1 && integer(scan.scan_index) && scan.scan_index >= 0, `${scanPrefix}: invalid result envelope.`);
      check(scan.outcome === 'ok' && scan.error === null, `${scanPrefix}: failed or hidden-error scan (${scan.error?.code || scan.outcome || 'missing'}).`);
      check(scan.rows === 5000 && scan.pages === 51 && scan.digest === digest, `${scanPrefix}: row/page/digest mismatch.`);
      check(scan.metrics?.body_bytes === 1074741, `${scanPrefix}: body-byte count differs from the fixed payload.`);
      check(finite(scan.metrics?.elapsed_ms) && scan.metrics.elapsed_ms > 0, `${scanPrefix}: invalid outer scan latency.`);
    }
    const latencies = measured.map(scan => scan.metrics?.elapsed_ms);
    check(latencies.every(finite) && latencies.reduce((sum, value) => sum + value, 0) <= summary.measured_wall_ms + 1, `${prefix}: scan durations exceed sequential measured wall time.`);
    if (!latencies.length || !latencies.every(finite) || !finite(summary.measured_wall_ms)) continue;
    const errors = measured.filter(scan => scan.outcome !== 'ok' || scan.error !== null);
    const errorCounts = {};
    for (const scan of errors) { const code = scan.error?.code || 'UNSPECIFIED'; errorCounts[code] = (errorCounts[code] || 0) + 1; }
    const successful = measured.filter(scan => scan.outcome === 'ok' && scan.error === null);
    check(summary.measured_valid_rows === undefined || summary.measured_valid_rows === successful.length * 5000, `${prefix}: summary row count differs.`);
    check(summary.measured_body_bytes === undefined || summary.measured_body_bytes === successful.length * 1074741, `${prefix}: summary byte count differs.`);
    resourceBlocks.push(resourceBlock(block));
    blocks.push({ block_index: index + 1, round, implementation, source_file: entry.path, source_sha256: sha256(sourceBytes), started_utc: block.started_utc, finished_utc: block.finished_utc,
      warmup_scans: warmup.length, attempts: measured.length, successful_scans: successful.length, failed_scans: errors.length, error_counts: errorCounts,
      measured_wall_ms: summary.measured_wall_ms, p50_ms: nearestRank(latencies, 0.5), p95_ms: nearestRank(latencies, 0.95),
      useful_rows_per_second: successful.length * 5000 / (summary.measured_wall_ms / 1000), successful_scans_per_minute: successful.length * 60 / (summary.measured_wall_ms / 1000),
      successful_body_bytes: successful.length * 1074741, latency_samples: latencies.length,
    });
  }
  if (issues.length) throw new Error(issues.slice(0, 50).join('\n') + (issues.length > 50 ? `\n...${issues.length - 50} more validation failures.` : ''));
  if (blocks.length !== 9) throw new Error('All nine complete blocks are required.');
  const summaries = clients.map(implementation => {
    const repetitions = blocks.filter(block => block.implementation === implementation);
    return { implementation, label: labels[implementation], repetitions: 3, successful_scans: repetitions.reduce((total, block) => total + block.successful_scans, 0), failed_scans: repetitions.reduce((total, block) => total + block.failed_scans, 0),
      p50_ms: repetitionSummary(repetitions.map(block => block.p50_ms)), p95_ms: repetitionSummary(repetitions.map(block => block.p95_ms)), useful_rows_per_second: repetitionSummary(repetitions.map(block => block.useful_rows_per_second)),
    };
  });
  return { schema_version: 1, protocol: manifest.protocol, status: 'validated', synthetic_test_data: !!manifest.synthetic_test_data, analyzed_at_utc: new Date().toISOString(), run_id: basename(directory),
    source: { run_directory: directory, manifest_file: relative(projectRoot, manifestPath).split(sep).join('/'), manifest_sha256: sha256(manifestBytes) },
    configuration: { service_root: serviceRoot, duration_seconds: manifest.duration_seconds, warmup_scans: manifest.warmup_scans, rounds: 3, expected_rows: 5000, expected_pages: 51, expected_digest: digest, expected_body_bytes: 1074741, lifecycle: 'fresh client per scan; reuse within 51 pages; close/drop included', pacing: 'continuous; no polling delay' },
    methods: { percentiles: 'nearest rank: sorted values at one-based rank ceil(p*n)', aggregation: 'median and observed range of three repetition statistics; scans are not independent repetitions', throughput: 'successful scans * 5000 / actual measured wall seconds; includes failed-attempt time', confidence_intervals: 'Not estimated: only three repeated blocks per client; show all values and observed ranges.' },
    provenance: redacted({ ...(manifest.provenance || {}), source_revision: manifest.source_revision, source_inputs: manifest.source_inputs, host: manifest.host, docker: manifest.docker, sap_container: manifest.sap_container, images: manifest.images, external_resources: manifest.external_resources }),
    resource_observations: { source: 'Docker stats snapshots', sampling_deviation: 'The draft protocol proposed one-second collection. The frozen runner used approximately 30-second snapshots consistently for all blocks.',
      scope: 'Samples cover whole blocks, including possible warmup/control time. Docker formatted snapshots are rounded. Maxima are sampled maxima, not true peaks, RSS or language heap size. No cumulative CPU counters were supplied, so CPU seconds per scan are not estimated. SAP includes client, service and database work.',
      baseline: redacted(manifest.baseline_resources || []), additional_manifest_observations: redacted(manifest.resource_observations || null), blocks: resourceBlocks }, summaries, blocks,
    limitations: ['ABAP shares the SAP runtime with the common service/database; external client container limits do not match SAP work-process resources.', 'All clients use real sockets and the same literal HTTP endpoint, but network placement and runtime libraries remain different.', 'Three repetitions quantify observed variation on this host; they do not justify strong statistical significance or a universal language ranking.', 'Client construction and cleanup are included; process startup, warmup and final output serialization are excluded.', 'The frozen dataset and this SAP release define the scope of these results; no production capacity or concurrent-write claim is made.'],
  };
}

const number = value => value.toLocaleString('en-US', { maximumFractionDigits: 2 });
const range = value => `${number(value.minimum)}–${number(value.maximum)}`;
function markdown(report) {
  const test = report.synthetic_test_data ? '**SYNTHETIC TEST DATA — NOT A PERFORMANCE RESULT.**\n\n' : '';
  const rows = report.summaries.map(summary => `| ${summary.label} | ${summary.successful_scans} | ${number(summary.p50_ms.median)} | ${number(summary.p95_ms.median)} | ${number(summary.useful_rows_per_second.median)} (${range(summary.useful_rows_per_second)}) | ${summary.failed_scans} |`).join('\n');
  const node = report.summaries.find(item => item.implementation === 'node');
  const rust = report.summaries.find(item => item.implementation === 'rust');
  const abap = report.summaries.find(item => item.implementation === 'abap');
  const overlap = Math.max(node.useful_rows_per_second.minimum, rust.useful_rows_per_second.minimum) <= Math.min(node.useful_rows_per_second.maximum, rust.useful_rows_per_second.maximum);
  const relativeThroughput = item => (item.useful_rows_per_second.median / node.useful_rows_per_second.median - 1) * 100;
  const relativeText = item => `${number(Math.abs(relativeThroughput(item)))}% ${relativeThroughput(item) >= 0 ? 'above' : 'below'} Node.js`;
  const interpretation = `Rust's median throughput was ${relativeText(rust)}; the observed Node.js and Rust trial ranges ${overlap ? 'overlap' : 'do not overlap'}. ABAP's was ${relativeText(abap)}. These are descriptive ratios for this run, without a statistical significance or universal language-speed claim.`;
  const detail = report.blocks.map(block => `| ${block.round} | ${labels[block.implementation]} | ${block.successful_scans} | ${number(block.measured_wall_ms / 1000)} | ${number(block.p50_ms)} | ${number(block.p95_ms)} | ${number(block.useful_rows_per_second)} | ${block.failed_scans} |`).join('\n');
  const resourceRows = report.resource_observations.blocks.flatMap(block => block.containers.map(container => `| ${block.block_index} | ${labels[block.implementation]} | ${container.role} | ${container.cpu_percent ? number(container.cpu_percent.median) : 'Unavailable'} | ${container.cpu_percent ? number(container.cpu_percent.maximum) : 'Unavailable'} | ${container.memory_bytes ? number(container.memory_bytes.maximum / 1024 ** 2) : 'Unavailable'} | ${Math.max(container.cpu_percent?.samples || 0, container.memory_bytes?.samples || 0)} |`));
  const resources = resourceRows.length ? `${report.resource_observations.sampling_deviation}\n\n| Block | Active poller | Observed container | Median sampled CPU (%) | Max sampled CPU (%) | Max sampled Docker memory (MiB) | Samples |\n| --- | --- | --- | ---: | ---: | ---: | ---: |\n${resourceRows.join('\n')}\n\n${report.resource_observations.scope}` : 'No per-block CPU or memory snapshots were supplied. Configured limits describe allocation, not measured usage. Baseline observations, if present, remain in the JSON report.';
  return `# Real HTTP polling performance comparison\n\n${test}Run: \`${report.run_id}\`. All nine blocks passed the same frozen-data checks: 5,000 positions, 51 pages, 1,074,741 body bytes and the expected digest on every warmup and measured scan. Each client has three measured repetitions of at least ${report.configuration.duration_seconds} seconds, after at least ${report.configuration.warmup_scans} warmup scans.\n\nThe clients used real HTTP sockets, the same service root and Basic identity, one request at a time, a fresh client per scan and connection reuse within each scan. These are results for the recorded implementations and deployment paths.\n\n![Repetition-level scan latency and useful throughput](performance-comparison.png)\n\n## Summary\n\nEach timing and throughput summary is the median of three repetition statistics. The range is the observed minimum–maximum across repetitions; it is not a confidence interval.\n\n| Client | Successful measured scans | Repetition p50 median (ms) | Repetition p95 median (ms) | Useful rows/s median (range) | Failures |\n| --- | ---: | ---: | ---: | ---: | ---: |\n${rows}\n\n${interpretation}\n\n## Repetitions\n\n| Round | Client | Successful scans | Actual wall (s) | p50 (ms) | p95 (ms) | Useful rows/s | Failures |\n| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |\n${detail}\n\nBoth p50 and p95 use nearest rank. Throughput is successful scans × 5,000 divided by actual measured wall seconds, including loop overhead and any failed-attempt time. The last scan finishes after the 180-second boundary; its work and time are both included. No scans were pooled into an apparent larger independent experiment. With only three repetitions, the report shows the complete repetition values and ranges and makes no significance claim.\n\n## Resource observations\n\n${resources}\n\n## Interpretation limits\n\n${report.limitations.map(item => `- ${item}`).join('\n')}\n\n## Evidence\n\nThe [machine-readable report](performance-comparison.json) contains per-block metrics, source-file hashes and available provenance. The [protocol](benchmark-protocol.md) defines the fixed workload and timing boundary. Input manifest SHA-256: \`${report.source.manifest_sha256}\`. Raw scan records remain in \`${report.source.manifest_file.replace(/manifest\.json$/, '')}\`.\n`;
}

export async function writeReport(report, outputDirectory = defaultOutput) {
  const output = resolve(outputDirectory);
  if (report.synthetic_test_data && output === defaultOutput) throw new Error('Synthetic output must remain outside the real docs report.');
  await mkdir(output, { recursive: true });
  await writeFile(resolve(output, 'performance-comparison.json'), JSON.stringify(report, null, 2) + '\n');
  await writeFile(resolve(output, 'performance-comparison.md'), markdown(report));
}

async function selfTest() {
  const testRoot = resolve(projectRoot, 'work');
  await mkdir(testRoot, { recursive: true });
  const directory = await mkdtemp(resolve(testRoot, 'analysis-selftest-'));
  const manifest = { protocol: 'sap-http-benchmark-v1', status: 'complete', duration_seconds: 180, warmup_scans: 5, rounds: 3, service_root: serviceRoot, expected_rows: 5000, expected_pages: 51, expected_digest: digest, fresh_client_per_scan: true, continuous: true, synthetic_test_data: true, blocks: [] };
  const start = Date.parse('2026-01-01T00:00:00Z');
  for (let index = 0; index < 9; index++) {
    const round = Math.floor(index / 3) + 1;
    const implementation = order[round - 1][index % 3];
    const path = `block-${String(index + 1).padStart(2, '0')}-${implementation}.json`;
    manifest.blocks.push({ path, round, implementation });
    const records = Array.from({ length: 9 }, (_, scanIndex) => ({ kind: 'scan', phase: scanIndex < 5 ? 'warmup' : 'measured', schema_version: 1, scan_index: scanIndex, outcome: 'ok', rows: 5000, pages: 51, digest, error: null, metrics: { elapsed_ms: scanIndex < 5 ? 100 : (scanIndex - 4) * 1000, body_bytes: 1074741, missed_slots: 0 } }));
    records.push({ kind: 'summary', measured_wall_ms: 180000, measured_scans: 4, warmup_scans: 5 });
    await writeFile(resolve(directory, path), JSON.stringify({ block_index: index + 1, round, implementation, started_utc: new Date(start + index * 200000).toISOString(), finished_utc: new Date(start + index * 200000 + 181000).toISOString(), records }));
  }
  await writeFile(resolve(directory, 'manifest.json'), JSON.stringify(manifest));
  const report = await analyzeDirectory(directory, { allowSynthetic: true });
  assert.equal(report.blocks[0].p50_ms, 2000);
  assert.equal(report.blocks[0].p95_ms, 4000);
  assert.equal(report.blocks[0].useful_rows_per_second, 20000 / 180);
  assert.equal(report.summaries[0].successful_scans, 12);
  await assert.rejects(analyzeDirectory(directory), /Synthetic/);
  const blockPath = resolve(directory, manifest.blocks[0].path);
  const block = await json(blockPath);
  block.records.at(-1).measured_wall_ms = 179999;
  await writeFile(blockPath, JSON.stringify(block));
  await assert.rejects(analyzeDirectory(directory, { allowSynthetic: true }), /too short/);
  block.records.at(-1).measured_wall_ms = 180000;
  block.records[5].error = { code: 'TIMEOUT' };
  await writeFile(blockPath, JSON.stringify(block));
  await assert.rejects(analyzeDirectory(directory, { allowSynthetic: true }), /hidden-error/);
  block.records[5].error = null;
  block.records[5].pages = 50;
  await writeFile(blockPath, JSON.stringify(block));
  await assert.rejects(analyzeDirectory(directory, { allowSynthetic: true }), /page\/digest/);
  block.records[5].pages = 51;
  await writeFile(blockPath, JSON.stringify(block));
  await writeReport(report, resolve(directory, 'report'));
  process.stdout.write(`Analysis self-test passed. Synthetic artifacts: ${directory}\n`);
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length === 1 && args[0] === '--self-test') return selfTest();
  if (args.length !== 1 && !(args.length === 3 && args[1] === '--output-dir')) throw new Error('Usage: node scripts/analyze-performance.mjs <runDirectory> [--output-dir directory] | --self-test');
  const report = await analyzeDirectory(args[0]);
  await writeReport(report, args.length === 3 ? args[2] : defaultOutput);
  process.stdout.write(`Validated nine blocks and wrote the performance report for ${report.run_id}.\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main().catch(error => { process.stderr.write(`Analysis refused: ${error.message}\n`); process.exitCode = 1; });
