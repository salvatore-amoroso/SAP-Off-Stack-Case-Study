import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, dirname } from 'node:path';
import { captureActiveSapSources } from './capture-sap-readiness.mjs';
import { sapSourceSpecs, sha256 } from './nine-readiness.mjs';

async function sourceFixture(t, includeHttp = false) {
  const root = await mkdtemp(resolve(tmpdir(), 'sap-active-parts-')); t.after(() => rm(root, { recursive: true, force: true }));
  const specs = sapSourceSpecs({ includeHttp }), responses = new Map(), saved = new Map(), settings = { serviceRoot: 'https://127.0.0.1/', password: 'fixture-private-value' };
  for (const source of specs) {
    const present = !source.optional || source.name === 'zcl_bl_poll_orders' && source.part !== 'macros';
    const body = present ? `* Current ${source.id}\nMETHOD fixture.\nENDMETHOD.\n` : '* SAP generated placeholder\n  " comment-only optional include\n';
    if (present) { const file = resolve(root, source.path); await mkdir(dirname(file), { recursive: true }); await writeFile(file, body); }
    responses.set(source.uri, { status: 200, body });
  }
  const get = async url => { assert.equal(url.searchParams.get('version'), 'active'); assert.equal(url.searchParams.get('sap-client'), '001'); return responses.get(url.pathname); };
  const store = async (file, text) => { assert(!saved.has(file), 'Source evidence filenames must be unique'); saved.set(file, text); return { file: `work/preflight/${file}`, sha256: sha256(text) }; };
  return { root, specs, responses, saved, settings, get, store, includeHttp };
}

test('capture binds all five source parts before tests and uses exact ADT include endpoints', async t => {
  const value = await sourceFixture(t), records = await captureActiveSapSources(value);
  assert.equal(records.length, 27); assert.equal(value.saved.size, 27);
  assert.equal(records.filter(item => !item.local_present).length, 17);
  for (const [part, suffix] of [['locals_def', 'definitions'], ['locals_imp', 'implementations'], ['macros', 'macros'], ['testclasses', 'testclasses']]) {
    assert.equal(records.find(item => item.name === 'zcl_bl_poll_orders' && item.part === part).uri, `/sap/bc/adt/oo/classes/zcl_bl_poll_orders/includes/${suffix}`);
  }
  assert(records.some(item => item.name === 'zcl_bl_test_orders' && item.part === 'main'));
});

test('HTTP capture additionally binds the fixture runner and all its include slots', async t => {
  const value = await sourceFixture(t, true), records = await captureActiveSapSources(value);
  assert.equal(records.length, 32); assert.equal(records.filter(item => item.name === 'zcl_bl_test_http').length, 5);
});

test('capture rejects inactive local implementations/test bodies rather than attaching old Unit output', async t => {
  const value = await sourceFixture(t);
  const source = value.specs.find(item => item.name === 'zcl_bl_poll_orders' && item.part === 'testclasses');
  await writeFile(resolve(value.root, source.path), (await readFile(resolve(value.root, source.path), 'utf8')) + '* unactivated change\n');
  await assert.rejects(captureActiveSapSources(value), /Active\/current SAP source mismatch/);
});

test('capture refuses unexpected active macro code and failed include reads', async t => {
  const value = await sourceFixture(t), uri = '/sap/bc/adt/oo/classes/zcl_bl_poll_orders/includes/macros';
  value.responses.set(uri, { status: 200, body: 'DEFINE hidden.\nEND-OF-DEFINITION.\n' });
  await assert.rejects(captureActiveSapSources(value), /Active\/current SAP source mismatch/);
  value.saved.clear();
  value.responses.set(uri, { status: 404, body: '' });
  await assert.rejects(captureActiveSapSources(value), /Unable to read active SAP source/);
});
