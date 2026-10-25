import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { auditDirectory, assertControlTiming } from './audit-nine-run.mjs';
import { analyzeDirectory } from './analyze-nine-comparison.mjs';
import { fixtureRun } from './benchmark-test-fixtures.mjs';

for (const continued of [false, true]) {
  test(`independent read-only audit derives archived fixture/Unit counts for a ${continued ? 'resumed' : 'fresh'} run`, async () => {
    const run = await fixtureRun({ continued }), report = await analyzeDirectory(run.directory, { allowSynthetic: true });
    const reportPath = resolve(run.directory, 'report.json'); await run.save('report.json', report); await run.saveIndex();
    const result = await auditDirectory(run.directory, reportPath, { allowSynthetic: true });
    assert.equal(result.passed, true);
    assert.equal(result.exact_shared_fixtures_verified, 1);
    assert.equal(result.abap_unit_methods_verified, 2);
    assert.equal(result.clean_run, !continued);
    assert.equal(result.total_attempts, continued ? 28 : 27);
    assert.equal(result.failed_warmup_attempts, continued ? 1 : 0);
    await assert.rejects(readFile(resolve(run.directory, 'independent-audit.json')), { code: 'ENOENT' });
  });
}

test('independent audit rejects inflated controller/measurement clocks after hashes are reconciled', async () => {
  const run = await fixtureRun(), report = await analyzeDirectory(run.directory, { allowSynthetic: true });
  run.blocks[0].records.at(-1).measured_wall_ms = 180000000;
  Object.assign(run.manifest.blocks[0], await run.saveBlock(run.blocks[0])); await run.saveManifest();
  report.source.manifest_sha256 = createHash('sha256').update(await readFile(resolve(run.directory, 'manifest.json'))).digest('hex');
  const reportPath = resolve(run.directory, 'report.json'); await run.save('report.json', report); await run.saveIndex();
  await assert.rejects(auditDirectory(run.directory, reportPath, { allowSynthetic: true }), /exceed controller interval/);
});

test('independent timing audit requires finite warmup work and agreement with UTC', () => {
  const block = { control_wall_ms: 181000, started_utc: '2026-01-01T00:00:00.000Z', finished_utc: '2026-01-01T00:03:01.000Z' };
  assert.doesNotThrow(() => assertControlTiming(block, { measured_wall_ms: 180000 }, [{ metrics: { elapsed_ms: 500 } }]));
  assert.throws(() => assertControlTiming(block, { measured_wall_ms: 180000 }, [{ metrics: { elapsed_ms: 1003 } }]), /exceed controller interval/);
  assert.throws(() => assertControlTiming({ ...block, control_wall_ms: 181500 }, { measured_wall_ms: 180000 }, []), /UTC intervals disagree/);
  assert.throws(() => assertControlTiming(block, { measured_wall_ms: 180000 }, [{ metrics: { elapsed_ms: -1 } }]), /warmup timing/);
});

test('independent audit binds report identities and labels to the raw applications', async () => {
  const run = await fixtureRun(), original = await analyzeDirectory(run.directory, { allowSynthetic: true });
  const path = resolve(run.directory, 'report.json');
  const verify = async report => { await run.save('report.json', report); await run.saveIndex(); return auditDirectory(run.directory, path, { allowSynthetic: true }); };
  assert.equal((await verify(original)).passed, true);
  for (const mutate of [
    report => {
      const identities = Object.fromEntries(report.summaries.map(({ app_id, language, approach, label }) => [app_id, { app_id, language, approach, label }]));
      for (const item of [...report.blocks, ...report.summaries]) {
        if (item.app_id === 'node-http') Object.assign(item, identities['rust-native']);
        else if (item.app_id === 'rust-native') Object.assign(item, identities['node-http']);
      }
    },
    report => { report.summaries[1] = structuredClone(report.summaries[0]); },
    report => { report.summaries[0].label = 'Rust · Direct HANA'; },
    report => { report.blocks[0].round = 3; },
  ]) {
    const changed = structuredClone(original); mutate(changed);
    await assert.rejects(verify(changed), /identity|distinct applications|round differs/);
  }
});
