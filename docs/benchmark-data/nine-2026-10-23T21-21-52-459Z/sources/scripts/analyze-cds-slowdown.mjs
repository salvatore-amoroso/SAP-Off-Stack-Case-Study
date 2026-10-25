import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdirSync, copyFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, basename, resolve } from 'node:path';

const seed = JSON.parse(readFileSync('contracts/seed-manifest.json', 'utf8'));
const evidenceRoot = 'docs/benchmark-data/cds-slowdown-2026-10-23';
mkdirSync(evidenceRoot, { recursive: true });
const definitions = [
  ['original_short', 'Original, zero warmups', 'work/slowdown/base-original-2026-10-23T11-29-22-375Z'],
  ['original_extended', 'Original, extended run', 'work/slowdown/base-original-2026-10-23T11-52-25-245Z'],
  ['copy', 'Class rename only', 'work/slowdown/base-copy-2026-10-23T11-32-08-774Z'],
  ['nojit', 'Core PCRE JIT disabled', 'work/slowdown/base-nojit-2026-10-23T11-46-11-556Z'],
  ['base', 'Extra diagnostic input fields, no intervention', 'work/slowdown/base-none-2026-10-23T11-26-21-648Z'],
  ['gc_once', 'One explicit GC after scan 1,400', 'work/slowdown/base-gc_once-2026-10-23T11-40-34-233Z'],
  ['sat', 'Original with aggregated SAT trace', 'work/slowdown/profile-2026-10-23T11-36-47-524Z'],
];
const previousReport = existsSync('docs/cds-slowdown-investigation.json') ? JSON.parse(readFileSync('docs/cds-slowdown-investigation.json', 'utf8')) : null;
const phaseDirectory = process.argv[2] || previousReport?.runs?.find(run => run.id === 'phase')?.source_directory;
if (phaseDirectory) definitions.push(['phase', 'Sparse phase probes from index 1,350', phaseDirectory]);
const hash = data => createHash('sha256').update(data).digest('hex');
const percentile = (values, q) => values.length ? [...values].sort((a, b) => a - b)[Math.max(0, Math.ceil(q * values.length) - 1)] : null;
const stats = values => ({ count: values.length, p50_ms: percentile(values, .5), p95_ms: percentile(values, .95), min_ms: values.length ? Math.min(...values) : null, max_ms: values.length ? Math.max(...values) : null });
function segments(values) {
  const result = [];
  for (let i = 0; i < values.length; i++) {
    const slow = values[i] > 500;
    if (!result.length || result.at(-1).over_500ms !== slow) result.push({ first_ordinal: i + 1, last_ordinal: i + 1, over_500ms: slow });
    else result.at(-1).last_ordinal = i + 1;
  }
  return result.map(segment => ({ ...segment, ...stats(values.slice(segment.first_ordinal - 1, segment.last_ordinal)) }));
}
assert.deepEqual(segments([80, 1200, 1300, 81]).map(s => [s.first_ordinal, s.last_ordinal, s.over_500ms]), [[1, 1, false], [2, 3, true], [4, 4, false]]);
assert.equal(percentile([1, 3, 2], .5), 2);
const files = [];
function preserve(source, target) {
  const destination = join(evidenceRoot, target);
  const readable = existsSync(source) ? source : destination;
  const bytes = readFileSync(readable);
  mkdirSync(join(destination, '..'), { recursive: true });
  if (resolve(readable) !== resolve(destination)) copyFileSync(readable, destination);
  assert.equal(hash(readFileSync(destination)), hash(bytes));
  files.push({ path: destination.replaceAll('\\', '/'), source, bytes: bytes.length, sha256: hash(bytes) });
  return destination.replaceAll('\\', '/');
}
const runs = definitions.map(([id, label, directory]) => {
  const raw = preserve(`${directory}/output.ndjson`, `${id}/output.ndjson`);
  const config = preserve(`${directory}/config.json`, `${id}/config.json`);
  let processSamples;
  const processSource = `${directory}/process-samples-host.ndjson`;
  if (existsSync(processSource) || existsSync(`${evidenceRoot}/${id}/process-samples-host.ndjson`)) {
    processSamples = preserve(processSource, `${id}/process-samples-host.ndjson`);
    readFileSync(processSamples, 'utf8').trim().split(/\r?\n/).forEach(line => assert(Array.isArray(JSON.parse(line).processes)));
  }
  const records = readFileSync(raw, 'utf8').trim().split(/\r?\n/).map(line => JSON.parse(line));
  const scans = records.filter(row => row.kind === 'scan');
  const summaries = records.filter(row => row.kind === 'summary');
  assert.equal(summaries.length, 1, id);
  const summary = summaries[0];
  assert.equal(summary.measured_scans, scans.length, id);
  assert.equal(summary.warmup_scans, 0, id);
  assert.equal(summary.failed_scans, 0, id);
  assert.equal(summary.measured_valid_rows, scans.length * 5000, id);
  scans.forEach((scan, index) => {
    assert.equal(scan.scan_index, index, id); assert.equal(scan.outcome, 'ok', id);
    assert.equal(scan.error, null, id); assert.equal(scan.rows, 5000, id);
    assert.equal(scan.pages, 50, id); assert.equal(scan.application_batches, 50, id);
    assert.equal(scan.http_requests, 0, id); assert.equal(scan.metrics.body_bytes, 0, id);
    assert.equal(scan.digest, seed.expected_digest, id);
  });
  const values = scans.map(scan => scan.metrics.elapsed_ms);
  const phases = records.filter(record => record.kind === 'phase');
  const phaseStats = {};
  if (phases.length) {
    assert.equal(phases.length, scans.length - 1350);
    for (const phase of phases) {
      assert.equal(phase.rows, 5000); assert.equal(phase.application_batches, 50);
      assert.equal(phase.sampled_rows, 50); assert.equal(phase.outcome, 'ok');
      assert.equal(phase.setup_us + phase.fetch_gap_us + phase.row_work_us + phase.finalization_us, phase.total_us);
      assert.equal(phase.sample_entry_us + phase.sample_schema_date_us + phase.sample_decimal_us + phase.sample_canonical_utf8_us + phase.sample_digest_us + phase.sample_tail_us + phase.sample_unattributed_us, phase.sample_call_us);
    }
    for (const slow of [false, true]) {
      const selected = phases.filter(phase => (values[phase.scan_index] > 500) === slow);
      phaseStats[slow ? 'slow' : 'fast'] = { count: selected.length,
        median_outer_minus_core_us: percentile(selected.map(row => values[row.scan_index] * 1000 - row.total_us), .5),
        outer_minus_core_note: 'Outer milliseconds are floored; this difference includes work outside the core clock boundary and up to one millisecond of quantization.',
        median_us: Object.fromEntries(Object.keys(phases[0]).filter(key => key.endsWith('_us')).map(key => [key, percentile(selected.map(row => row[key]), .5)])) };
    }
  }
  return { id, label, source_directory: directory, raw, config, process_samples: processSamples, summary, latency: stats(values),
    total_scan_ms: values.reduce((a, b) => a + b, 0),
    first_over_500ms_ordinal: values.findIndex(value => value > 500) < 0 ? null : values.findIndex(value => value > 500) + 1,
    segments: segments(values), phase_statistics: phaseStats };
});
for (const file of [
  'work/zcl_bl_diag_copy.clas.abap', 'work/diag-copy-source-proof.json',
  'work/zcl_bl_diag_base.clas.abap',
  'work/zcl_bl_diag_gconce.clas.abap', 'work/diag-gconce-source-proof.json',
  'work/slowdown/zcl_bl_diag_stat.clas.abap',
  ...['zcl_bl_diag_nojit.clas.abap', 'zcl_bl_diag_nojit.clas.locals_def.abap', 'zcl_bl_diag_nojit.clas.locals_imp.abap',
    'zcl_bl_diag_nj_run.clas.abap', 'zcl_bl_diag_nj_test.clas.abap', 'readiness.json', 'manifest.json', 'companions-manifest.json']
    .map(name => `work/slowdown/nojit/${name}`),
  ...['zcl_bl_diag_phase.clas.abap', 'zcl_bl_diag_phase.clas.locals_def.abap', 'zcl_bl_diag_phase.clas.locals_imp.abap',
    'zcl_bl_diag_ph_run.clas.abap', 'zcl_bl_diag_ph_test.clas.abap', 'zcl_bl_diag_ph_check.clas.abap', 'readiness.json', 'manifest.json', 'companions-manifest.json']
    .map(name => `work/slowdown/phase/${name}`),
]) {
  const target = `diagnostic-sources/${file.includes('/phase/') ? 'phase/' : file.includes('/nojit/') ? 'nojit/' : ''}${basename(file)}`;
  if (existsSync(file) || existsSync(join(evidenceRoot, target))) preserve(file, target);
}
let runtimeStatistics;
if (existsSync('work/slowdown/stat-findings.json') || existsSync(`${evidenceRoot}/runtime-statistics.json`)) {
  const published = preserve('work/slowdown/stat-findings.json', 'runtime-statistics.json');
  runtimeStatistics = JSON.parse(readFileSync(published, 'utf8'));
  assert.equal(runtimeStatistics.matched_main_record.gc_time_raw / 1000, runtimeStatistics.converted.gc_milliseconds);
  assert.equal(runtimeStatistics.field_units.proof.read_subrc, 0);
  assert.equal(runtimeStatistics.record_match.control_measured_wall_ms, runs.find(run => run.id === 'original_extended').summary.measured_wall_ms);
  assert.equal(runtimeStatistics.evidence.control_output_sha256, files.find(file => file.path.endsWith('/original_extended/output.ndjson')).sha256);
}
const report = { schema_version: 1, generated_at_utc: new Date().toISOString(), status: 'validated',
  question: 'Why does the direct CDS benchmark slow down after measured index 1389?',
  ordinal_convention: 'One based total scan ordinal; original measured index 1389 plus five warmups corresponds to total ordinal 1395.',
  slow_segment_definition: 'Consecutive outer scan durations strictly greater than 500 ms; threshold describes the observed sequence and is not a failure limit.',
  expected_rows: 5000, expected_application_batches: 50, expected_digest: seed.expected_digest,
  original_source_revision: 'ef94edae1a03363c802fc0f30c0527a07e2c82f3',
  // Provenance belongs to the measured revision, even when current sources later change.
  original_core_sha256: 'ddcfe8fffff67d14af802211716928816ee0627391dc76d197bb0cb03cce091d',
  original_runner_sha256: 'e6d849a05e681ad3ffdcc15e1edfb77bc5e95667c8e31e12520e2383e967c3df',
  runs, runtime_statistics: runtimeStatistics, preserved_files: files };
writeFileSync('docs/cds-slowdown-investigation.json', JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify({ status: report.status, scans_validated: runs.reduce((sum, run) => sum + run.summary.measured_scans, 0), files: files.length,
  runs: runs.map(run => ({ id: run.id, scans: run.summary.measured_scans, first_slow: run.first_over_500ms_ordinal, slow_segments: run.segments.filter(s => s.over_500ms) })) }, null, 2));
