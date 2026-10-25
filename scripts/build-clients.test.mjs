import test from 'node:test';
import assert from 'node:assert/strict';
import { validateBuildLock, sourceBuildFiles, assertRustBuildCurrent } from './build-clients.mjs';
import { verificationOptions } from './verify-offline.mjs';
test('all four source Dockerfiles match immutable build and toolchain pins', async () => {
  const lock = await validateBuildLock(); assert.equal(lock.platform, 'linux/amd64');
  const sources = await sourceBuildFiles(); assert(sources.length > 20);
  assert(sources.every(item => /^[a-f0-9]{64}$/.test(item.sha256)));
  assert(!sources.some(item => /node_modules|target|\.env$/.test(item.path)));
});
test('Docker socket checks reject stale Rust source or replaced runtime/compiler images', async () => {
  const receipt = { passed: true, clean_build: true, method: 'dockerfile-source-build', source_files: await sourceBuildFiles(),
    images: { 'rust-http': { tag: 'sap-polling-rust:nine-http', id: `sha256:${'a'.repeat(64)}` } },
    verification_builder: { tag: 'sap-polling-rust:verify-build', id: `sha256:${'b'.repeat(64)}` } };
  const inspect = async tag => ({ id: tag.endsWith('verify-build') ? receipt.verification_builder.id : receipt.images['rust-http'].id });
  await assertRustBuildCurrent(receipt, { inspect });
  const changed = structuredClone(receipt); changed.source_files.find(item => item.path.endsWith('rust/Cargo.lock')).sha256 = '0'.repeat(64);
  await assert.rejects(assertRustBuildCurrent(changed, { inspect }), /sources changed/);
  await assert.rejects(assertRustBuildCurrent(receipt, { inspect: async () => ({ id: `sha256:${'c'.repeat(64)}` }) }), /image changed/);
});
test('offline verification cannot silently skip both languages or accept unknown switches', () => {
  assert.deepEqual(verificationOptions([]), { node: true, rust: true, docker: false });
  assert.deepEqual(verificationOptions(['--rust-only', '--docker']), { node: false, rust: true, docker: true });
  assert.throws(() => verificationOptions(['--node-only', '--rust-only']));
  assert.throws(() => verificationOptions(['--skip-tests']));
});
