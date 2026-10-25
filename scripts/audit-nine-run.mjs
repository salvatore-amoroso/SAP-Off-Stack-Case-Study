// Independent arithmetic/evidence audit: no analyzer or production timing-helper imports.
import assert from 'node:assert/strict';
import { readFile, realpath, writeFile } from 'node:fs/promises';
import { isAbsolute, resolve, relative, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';

const root = resolve(import.meta.dirname, '..');
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const read = async path => JSON.parse(await readFile(path, 'utf8'));
const sum = values => values.reduce((a, b) => a + b, 0);
const median = values => [...values].sort((a, b) => a - b)[1];
const percentile = (values, p) => [...values].sort((a, b) => a - b)[Math.ceil(values.length * p) - 1];
const sameNumber = (a, b, label) => assert(Math.abs(a - b) <= Math.max(1e-8, Math.abs(a) * 1e-12), label);
const identities = new Map(['abap', 'node', 'rust'].flatMap(language => ['http', 'cds', 'native'].map(approach => {
  const app_id = `${language}-${approach}`;
  return [app_id, { app_id, language, approach, label: `${{ abap: 'ABAP', node: 'Node.js', rust: 'Rust' }[language]} · ${{ http: 'HTTP / OData', cds: 'CDS', native: 'Direct HANA' }[approach]}` }];
})));
function assertReportIdentity(record, appId) {
  const expected = identities.get(appId); assert(expected, 'Unknown application identity');
  for (const [key, value] of Object.entries(expected)) assert.equal(record[key], value, `Report application identity differs: ${key}`);
}

export function assertControlTiming(block, summary, warmup) {
  const nonnegative = value => typeof value === 'number' && Number.isFinite(value) && value >= 0;
  assert(nonnegative(summary.measured_wall_ms), 'Invalid measured wall time');
  assert(nonnegative(block.control_wall_ms) && block.control_wall_ms > 0, 'Missing/invalid controller time');
  const duration = Date.parse(block.finished_utc) - Date.parse(block.started_utc);
  assert(Number.isFinite(duration) && duration > 0 && Math.abs(duration - block.control_wall_ms) <= 100, 'Controller and UTC intervals disagree');
  const durations = warmup.map(scan => scan.metrics?.elapsed_ms);
  assert(durations.every(nonnegative), 'Invalid warmup timing');
  assert(summary.measured_wall_ms + sum(durations) <= block.control_wall_ms + 2, 'Warmup and measured time exceed controller interval');
}

// Read-only by construction; CLI persistence is handled separately below.
export async function auditDirectory(directoryArg, reportArg, { allowSynthetic = false } = {}) {
  const directory = await realpath(resolve(root, directoryArg)), reportPath = resolve(root, reportArg);
  const safeChild = async name => {
    assert(typeof name === 'string' && name && !isAbsolute(name), 'Archive paths must be relative');
    const path = await realpath(resolve(directory, name));
    assert(path.startsWith(directory + sep), 'Evidence path leaves archive'); return path;
  };
  const checked = async (entry, path = entry.path) => {
    const bytes = await readFile(await safeChild(path)); assert.equal(sha(bytes), entry.sha256, path); return bytes;
  };
  const manifestBytes = await readFile(resolve(directory, 'manifest.json')), manifest = JSON.parse(manifestBytes);
  const inputsBytes = await readFile(resolve(directory, 'inputs.json')), inputs = JSON.parse(inputsBytes), report = await read(reportPath);
  assert(!inputs.synthetic_test_data || allowSynthetic, 'Synthetic evidence requires an explicit test-only opt-in');
  assert.equal(manifest.status, 'complete'); assert.equal(manifest.blocks.length, 27);
  assert.equal(manifest.inputs_sha256, sha(inputsBytes));
  assert.equal(inputs.configuration.rounds, 3); assert.equal(inputs.configuration.warmup_scans, 5); assert.equal(inputs.configuration.duration_seconds, 180);
  assert.equal(report.status, 'validated'); assert.equal(report.experiment_complete, true); assert.equal(report.blocks.length, 27);
  assert.equal(report.source.manifest_sha256, sha(manifestBytes)); assert.deepEqual(manifest.final_images, inputs.images);
  let checkedFiles = 0;
  for (const item of [...inputs.source_inputs, ...inputs.evidence_files]) { await checked(item, item.snapshot); checkedFiles++; }
  const fixtureSource = inputs.source_inputs.find(item => item.path === 'contracts/fixtures.json');
  const unitSource = inputs.source_inputs.find(item => item.path === 'sap/src/zcl_bl_poll_orders.clas.testclasses.abap');
  const fixtureEvidence = inputs.evidence_files.find(item => item.path.endsWith('/fixtures.ndjson'));
  const unitEvidence = inputs.evidence_files.find(item => item.path.endsWith('/unit.xml'));
  assert(fixtureSource && unitSource && fixtureEvidence && unitEvidence, 'Archived fixture/Unit sources and raw evidence are required');
  const cases = JSON.parse(await checked(fixtureSource, fixtureSource.snapshot)).cases;
  assert(Array.isArray(cases) && cases.length > 0);
  const fixtureRecords = (await checked(fixtureEvidence, fixtureEvidence.snapshot)).toString('utf8').trim().split(/\r?\n/).map(line => JSON.parse(line));
  const caseRecords = fixtureRecords.filter(item => typeof item.id === 'string');
  assert.equal(caseRecords.length, cases.length); assert.equal(new Set(caseRecords.map(item => item.id)).size, cases.length);
  for (const fixture of cases) {
    const record = caseRecords.find(item => item.id === fixture.id); assert.equal(record?.passed, true, fixture.id);
    const actual = record.result;
    assert.deepEqual({ outcome: actual.outcome, rows: actual.rows, pages: actual.pages, digest: actual.digest, error: actual.error }, fixture.expected, fixture.id);
  }
  const fixtureSummary = fixtureRecords.at(-1);
  assert.equal(fixtureSummary.fixture_count, cases.length); assert.equal(fixtureSummary.passed, cases.length);
  const expectedMethods = ((await checked(unitSource, unitSource.snapshot)).toString('utf8').match(/\bMETHODS\s+\w+\s+FOR\s+TESTING\b/gi) || []).length;
  const unitXml = (await checked(unitEvidence, unitEvidence.snapshot)).toString('utf8');
  assert(expectedMethods > 0); assert.equal((unitXml.match(/<(?:\w+:)?testMethod(?:\s|>)/g) || []).length, expectedMethods);
  assert(!/<(?:\w+:)?alert(?:\s|>)/.test(unitXml));

  const blocks = [], appCounts = new Map(); let priorEnd = -Infinity, missingDockerSamples = 0, warmupCount = 0;
  for (const [index, entry] of manifest.blocks.entries()) {
    assert.equal(entry.passed, true); const block = JSON.parse(await checked(entry));
    const raw = await checked({ path: block.raw_file, sha256: block.raw_sha256 });
    assert.deepEqual(raw.toString('utf8').trim().split(/\r?\n/).map(line => JSON.parse(line)), block.records);
    assert.equal(block.block_index, index + 1); assert.equal(block.round, Math.floor(index / 9) + 1);
    assert.equal(block.app_id, inputs.schedule[block.round - 1][index % 9]);
    const identity = identities.get(block.app_id); assert(identity, 'Unknown raw application identity');
    assert.equal(block.language, identity.language); assert.equal(block.approach, identity.approach);
    assert(Date.parse(block.started_utc) >= priorEnd); priorEnd = Date.parse(block.finished_utc);
    assert.equal(block.exit_code, 0); assert.equal(block.timed_out, false); assert(block.verification.passed);
    const scans = block.records.filter(item => item.kind === 'scan'), warmup = scans.filter(item => item.phase === 'warmup');
    const measured = scans.filter(item => item.phase === 'measured'), summary = block.records.at(-1);
    assert.equal(block.records.length, scans.length + 1); assert.equal(summary.kind, 'summary');
    assert.equal(warmup.length, inputs.configuration.warmup_scans); warmupCount += warmup.length;
    assert(measured.length > 0); assert.equal(summary.measured_scans, measured.length); assert(summary.measured_wall_ms >= 180000);
    assertControlTiming(block, summary, warmup);
    for (const [scanIndex, scan] of scans.entries()) {
      assert.equal(scan.outcome, 'ok'); assert.equal(scan.error, null); assert.equal(scan.rows, 5000);
      assert.equal(scan.digest, 'df57de597e919adb10ae5365201b999788e86b39219ad040ffbc305539180bc7');
      assert.equal(scan.pages, block.app_id === 'abap-cds' ? 50 : 51); assert.equal(scan.metrics.body_bytes, block.approach === 'http' ? 1074741 : 0);
      assert(Number.isFinite(scan.metrics.elapsed_ms) && scan.metrics.elapsed_ms > 0);
      assert.equal(scan.phase, scanIndex < warmup.length ? 'warmup' : 'measured');
      assert.equal(scan.scan_index, scanIndex < warmup.length || block.language !== 'abap' ? scanIndex : scanIndex - warmup.length);
    }
    for (const sample of block.resource_samples) { assert(sample.host.free_memory_bytes >= 2147483648); if (!sample.passed) missingDockerSamples++; }
    const values = measured.map(item => item.metrics.elapsed_ms); assert(sum(values) <= summary.measured_wall_ms + 2);
    const observed = report.blocks.find(item => item.block_index === block.block_index); assert(observed);
    assertReportIdentity(observed, block.app_id); assert.equal(observed.round, block.round, 'Report round differs');
    sameNumber(observed.p50_ms, percentile(values, .5), 'p50'); sameNumber(observed.p95_ms, percentile(values, .95), 'p95');
    sameNumber(observed.useful_rows_per_second, measured.length * 5000 * 1000 / summary.measured_wall_ms, 'throughput');
    assert.equal(observed.successful_scans, measured.length); assert.equal(observed.latency_series.length, measured.length);
    observed.latency_series.forEach((item, offset) => assert.equal(item.elapsed_ms, values[offset]));
    blocks.push(observed); appCounts.set(block.app_id, (appCounts.get(block.app_id) || 0) + 1); checkedFiles += 2;
  }
  assert.equal(appCounts.size, 9); assert([...appCounts.values()].every(count => count === 3));
  assert.equal(report.summaries.length, 9);
  assert.deepEqual([...new Set(report.summaries.map(item => item.app_id))].sort(), [...identities.keys()].sort(), 'Report summaries must identify all nine distinct applications');
  for (const item of report.summaries) {
    assertReportIdentity(item, item.app_id);
    const trials = blocks.filter(block => block.app_id === item.app_id);
    assert.equal(trials.length, 3); assert.equal(item.successful_scans, sum(trials.map(block => block.successful_scans)));
    for (const key of ['p50_ms', 'p95_ms', 'useful_rows_per_second']) {
      const values = trials.map(block => block[key]);
      sameNumber(item[key].median, median(values), `${key} median`); sameNumber(item[key].minimum, Math.min(...values), `${key} min`); sameNumber(item[key].maximum, Math.max(...values), `${key} max`);
    }
  }

  const continued = manifest.execution_mode === 'continued';
  let attempts = manifest.blocks.length, failedWarmups = 0;
  assert.equal(report.clean_run, !continued);
  if (continued) {
    assert.equal(manifest.clean_run, false);
    const ledger = JSON.parse(await checked({ path: manifest.attempts_file, sha256: manifest.attempts_sha256 }));
    const amendment = JSON.parse(await checked({ path: manifest.continuation_inputs_file, sha256: manifest.continuation_inputs_sha256 }));
    const retry = amendment.first_continued_block_index;
    assert(Number.isInteger(retry) && retry >= 1 && retry <= 27);
    assert.equal(amendment.clean_run, false); assert.equal(amendment.original_inputs_sha256, manifest.inputs_sha256);
    assert.equal(Date.parse(amendment.resumed_at_utc) - Date.parse(amendment.paused_at_utc), amendment.gap_before_resume_ms);
    const original = JSON.parse(await checked(amendment.original_failed_manifest));
    assert.equal(original.status, 'failed'); assert.equal(original.blocks.length, retry);
    assert.equal(original.inputs_sha256, manifest.inputs_sha256);
    assert.equal(amendment.adopted_blocks.length, retry - 1);
    for (const [index, entry] of amendment.adopted_blocks.entries()) {
      await checked(entry); assert.equal(entry.sha256, original.blocks[index].sha256); assert.equal(entry.sha256, manifest.blocks[index].sha256);
    }
    const failed = JSON.parse(await checked(amendment.failed_attempt));
    const raw = await checked({ path: amendment.failed_attempt.raw_path, sha256: amendment.failed_attempt.raw_sha256 });
    assert.deepEqual(raw.toString('utf8').trim().split(/\r?\n/).map(line => JSON.parse(line)), failed.records);
    assert.equal(original.blocks.at(-1).sha256, amendment.failed_attempt.sha256);
    const failedScans = failed.records.filter(item => item.kind === 'scan'), failedSummary = failed.records.at(-1);
    assert(failedScans.length > 0 && failedScans.every(scan => scan.phase === 'warmup'));
    assert.equal(failedScans.at(-1).outcome, 'error'); assert.equal(failedScans.at(-1).digest, null);
    assert.equal(failedSummary.measured_scans, 0); assert.equal(failedSummary.measured_wall_ms, 0);
    assertControlTiming(failed, failedSummary, failedScans);
    let finished = -Infinity;
    for (const [index, attempt] of ledger.entries()) {
      const slot = index < retry ? index + 1 : index, isFailure = index === retry - 1;
      assert.equal(attempt.planned_block_index, slot); assert.equal(attempt.attempt_index, index === retry ? 2 : 1);
      assert.equal(attempt.app_id, inputs.schedule.flat()[slot - 1]); assert.equal(attempt.status, isFailure ? 'failed' : 'passed');
      const block = JSON.parse(await checked(attempt));
      assert.equal(attempt.started_utc, block.started_utc); assert.equal(attempt.finished_utc, block.finished_utc);
      assert(Date.parse(block.started_utc) >= finished); finished = Date.parse(block.finished_utc);
      assert.equal(attempt.adopted, index < retry - 1);
      assert.equal(attempt.sha256, isFailure ? amendment.failed_attempt.sha256 : manifest.blocks[slot - 1].sha256);
    }
    attempts = ledger.length; failedWarmups = ledger.filter(item => item.status === 'failed').length;
    assert.equal(attempts, 28); assert.equal(failedWarmups, 1);
    assert.equal(manifest.total_attempts, attempts); assert.equal(manifest.failed_attempts, failedWarmups);
    assert.equal(report.continuation.attempts.length, attempts); assert.equal(report.continuation.gap_before_resume_ms, amendment.gap_before_resume_ms);
  }
  assert.equal(report.execution.total_attempts, attempts); assert.equal(report.execution.failed_warmup_attempts, failedWarmups);
  const archiveIndex = await read(resolve(directory, 'evidence-files.json'));
  for (const item of archiveIndex.files) await checked(item);
  return { audited_at_utc: new Date().toISOString(), passed: true, synthetic_test_data: !!inputs.synthetic_test_data,
    audit: 'Independent evidence and arithmetic checks, no analyzer or production timing-helper imports',
    archive: relative(root, directory).split(sep).join('/'), report: relative(root, reportPath).split(sep).join('/'),
    blocks: blocks.length, applications: appCounts.size, repetitions_per_application: 3, warmup_scans: warmupCount,
    total_attempts: attempts, failed_warmup_attempts: failedWarmups, clean_run: !continued,
    exact_shared_fixtures_verified: cases.length, abap_unit_methods_verified: expectedMethods,
    measured_scans: sum(blocks.map(block => block.successful_scans)), measured_failures: 0,
    validated_reported_rows: sum(blocks.map(block => block.successful_scans)) * 5000,
    checked_source_evidence_and_raw_files: checkedFiles, archive_index_files: archiveIndex.files.length,
    missing_docker_resource_samples: missingDockerSamples, manifest_sha256: sha(manifestBytes),
    report_sha256: sha(await readFile(reportPath)), auditor_sha256: sha(await readFile(import.meta.filename)),
    scope: 'Reconciles reported counts/digests, phase/index order, independent controller/UTC/warmup timing, trial/aggregate arithmetic, resumed attempts and evidence hashes. Pollers do not emit every source row; this does not independently recompute row hashes from a raw row trace.' };
}

async function main() {
  const args = process.argv.slice(2), checkOnly = args[0] === '--check-only';
  if (checkOnly) args.shift();
  assert.equal(args.length, 2, 'Usage: audit-nine-run.mjs [--check-only] <archive> <report JSON>');
  const result = await auditDirectory(args[0], args[1]);
  if (!checkOnly) {
    const bytes = JSON.stringify(result, null, 2) + '\n';
    await writeFile(resolve(root, args[0], 'independent-audit.json'), bytes);
    await writeFile(resolve(root, 'docs/nine-comparison-audit.json'), bytes);
  }
  console.log(JSON.stringify(result));
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main().catch(error => { process.stderr.write(`Nine-path audit refused: ${error.message}\n`); process.exitCode = 1; });
