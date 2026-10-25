import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, stat } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { tmpdir } from 'node:os';
import { archiveNineRun } from './archive-nine-run.mjs';
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'sap-archive-test-'));
  await mkdir(resolve(root, 'results/run'), { recursive: true });
  await writeFile(resolve(root, 'results/run/manifest.json'), JSON.stringify({ status: 'complete', blocks: Array.from({ length: 27 }, () => ({ passed: true })) }));
  await writeFile(resolve(root, 'results/run/output.ndjson'), '{"public":"evidence"}\n');
  return root;
}
test('archive verifies exact copies, records performed guard scope and refuses overwrite', async () => {
  const root = await fixture(), result = await archiveNineRun('results/run', 'docs/benchmark-data/run', { root });
  assert(result.all_copies_hash_verified && result.safety_scan.passed);
  assert.equal(result.credentials_included, undefined);
  assert.deepEqual(await readFile(resolve(root, 'results/run/output.ndjson')), await readFile(resolve(root, 'docs/benchmark-data/run/output.ndjson')));
  await assert.rejects(archiveNineRun('results/run', 'docs/benchmark-data/run', { root }), /already exists/);
});
test('unrelated private key prevents all copying before destination creation', async () => {
  const root = await fixture();
  await writeFile(resolve(root, 'results/run/other.txt'), ['-----BEGIN', 'PRIVATE KEY-----'].join(' '));
  await assert.rejects(archiveNineRun('results/run', 'docs/benchmark-data/run', { root }), /PRIVATE_KEY/);
  await assert.rejects(stat(resolve(root, 'docs/benchmark-data/run')), { code: 'ENOENT' });
});
