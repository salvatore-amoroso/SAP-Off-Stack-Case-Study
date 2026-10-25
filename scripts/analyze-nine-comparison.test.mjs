import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { analyzeDirectory, writeReport } from './analyze-nine-comparison.mjs';
import { fixtureRun } from './benchmark-test-fixtures.mjs';

for (const retry of [1, 12, 24, 27]) {
  test(`a completed continuation at slot ${retry} retains 28 attempts, its failed warmup and pause`, async () => {
    const run = await fixtureRun({ continued: true, retry });
    const report = await analyzeDirectory(run.directory, { allowSynthetic: true });
    assert.equal(report.status, 'validated');
    assert.equal(report.experiment_complete, true);
    assert.equal(report.clean_run, false);
    assert.equal(report.source.run_directory, relative(resolve(import.meta.dirname, '..'), run.directory).split(sep).join('/'));
    assert.equal(isAbsolute(report.source.run_directory), false);
    assert.equal(report.blocks.length, 27);
    assert.equal(report.execution.total_attempts, 28);
    assert.equal(report.execution.main_attempts, 28);
    assert.equal(report.execution.failed_warmup_attempts, 1);
    assert.equal(report.execution.main_failed_warmup_attempts, 1);
    assert.equal(report.execution.failed_attempts[0].block_index, retry);
    assert.equal(report.execution.failed_attempts[0].excluded_from_main, false);
    assert.equal(report.execution.availability.find(item => item.app_id === run.blocks[retry - 1].app_id).failed_warmup_attempts, 1);
    assert.equal(report.continuation.attempts.length, 28);
    assert.equal(report.continuation.gap_before_resume_ms, 900000);
    await writeReport(report, resolve(run.directory, 'report'));
    const markdown = await readFile(resolve(run.directory, 'report/nine-comparison.md'), 'utf8');
    assert.match(markdown, /28 attempts/);
    assert.match(markdown, /15-minute diagnostic pause/);
    assert.match(markdown, /clean_run=false/);
    assert.doesNotMatch(markdown, /This is a fresh comparison/);
  });
}

test('analysis rejects inflated wall time, missing controller time and conflicting UTC clocks', async () => {
  const run = await fixtureRun(), original = structuredClone(run.blocks[0]);
  for (const mutate of [
    block => { block.records.at(-1).measured_wall_ms = 180000000; },
    block => { delete block.control_wall_ms; },
    block => { block.control_wall_ms = 181500; },
    block => { block.finished_utc = block.started_utc; },
    block => { block.records[0].metrics.elapsed_ms = 2000; },
  ]) {
    const block = structuredClone(original); mutate(block); await run.saveBlock(block);
    await assert.rejects(analyzeDirectory(run.directory, { allowSynthetic: true }), /controller interval/);
  }
});

test('completed continuation cannot hide or relabel the failed attempt', async () => {
  const run = await fixtureRun({ continued: true });
  run.manifest.total_attempts = 27; await run.saveManifest();
  await assert.rejects(analyzeDirectory(run.directory, { allowSynthetic: true }), /continuation summary differs/);
  run.manifest.total_attempts = 28; run.manifest.clean_run = true; await run.saveManifest();
  await assert.rejects(analyzeDirectory(run.directory, { allowSynthetic: true }), /must not be presented as clean/);
  delete run.manifest.execution_mode; await run.saveManifest();
  await assert.rejects(analyzeDirectory(run.directory, { allowSynthetic: true }), /Continuation metadata/);
});

for (const continued of [false, true]) {
  test(`analysis rejects memory pressure in a ${continued ? 'continued' : 'fresh'} run`, async () => {
    const run = await fixtureRun({ continued });
    const block = run.blocks.at(-1);
    block.resource_samples = [{ host: { free_memory_bytes: 1024 ** 3 } }];
    const entry = await run.saveBlock(block); Object.assign(run.manifest.blocks.at(-1), entry);
    if (continued) {
      const ledger = JSON.parse(await readFile(resolve(run.directory, 'attempts.json'), 'utf8'));
      ledger.at(-1).sha256 = entry.sha256;
      run.manifest.attempts_sha256 = (await run.save('attempts.json', ledger)).sha256;
    }
    await run.saveManifest();
    await assert.rejects(analyzeDirectory(run.directory, { allowSynthetic: true }), /host memory pressure/);
  });
}
