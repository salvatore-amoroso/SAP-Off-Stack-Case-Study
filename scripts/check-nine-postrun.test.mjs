import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { writeMatchingFile, savePostrunProof, postrunSourceSpecs } from './check-nine-postrun.mjs';

test('post-run retries reuse matching partial evidence and refuse changed bytes', async t => {
  const directory = await mkdtemp(resolve(tmpdir(), 'postrun-retry-')); t.after(() => rm(directory, { recursive: true, force: true }));
  const file = resolve(directory, 'source.abap');
  await writeMatchingFile(file, 'verified source'); await writeMatchingFile(file, 'verified source');
  await assert.rejects(writeMatchingFile(file, 'changed source'), /Existing post-run evidence differs/);
  assert.equal(await readFile(file, 'utf8'), 'verified source');
});

test('matching proofs retain their original timestamp and differing proofs are preserved', async t => {
  const directory = await mkdtemp(resolve(tmpdir(), 'postrun-proof-')); t.after(() => rm(directory, { recursive: true, force: true }));
  const file = resolve(directory, 'proof.json'), first = { checked_at_utc: '2026-10-24T00:00:00Z', passed: true, source: 'a' };
  await savePostrunProof(file, first);
  assert.deepEqual(await savePostrunProof(file, { ...first, checked_at_utc: '2026-10-24T01:00:00Z' }), first);
  await assert.rejects(savePostrunProof(file, { ...first, source: 'b' }), /Existing post-run proof differs/);
  assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), first);
});

test('postrun keeps the declared historical scope and expands only versioned full-source records', () => {
  assert.equal(postrunSourceSpecs(null).length, 6);
  assert.equal(postrunSourceSpecs({ source_binding_version: 1 }).length, 6);
  assert.equal(postrunSourceSpecs({ source_binding_version: 2, include_http: false }).length, 27);
  assert.equal(postrunSourceSpecs({ source_binding_version: 2, include_http: true }).length, 32);
  assert.throws(() => postrunSourceSpecs({ source_binding_version: 2 }), /HTTP-test scope/);
  assert.throws(() => postrunSourceSpecs({ source_binding_version: 99 }), /Unsupported/);
});
