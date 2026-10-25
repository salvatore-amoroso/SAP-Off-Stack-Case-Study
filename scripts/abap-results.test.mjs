import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { parseCaseResults, unitMethodCount } from './abap-results.mjs';

const result = { outcome: 'ok', rows: 1, pages: 1, digest: 'a'.repeat(64), error: null };
const cases = [{ id: 'first', passed: true, result }, { id: 'second', passed: false, result }];
const summary = { fixture_count: 2, passed: 1 };
const ndjson = [...cases, summary].map(value => JSON.stringify(value)).join('\r\n');

test('raw ADT NDJSON preserves every case and reconciles its final summary', () => {
  assert.deepEqual(parseCaseResults('\uFEFF' + ndjson + '\n', { requireSummary: true }), { cases, summary });
});

test('older JSON envelopes and flat Node/Rust arrays remain readable', () => {
  assert.deepEqual(parseCaseResults(JSON.stringify({ cases })).cases, cases);
  const flat = [{ id: 'first', ...result }];
  assert.deepEqual(parseCaseResults(JSON.stringify(flat)).cases, [{ id: 'first', result }]);
});

test('truncation, duplicate IDs, diagnostic text and inconsistent summaries fail closed', () => {
  for (const text of ['', JSON.stringify(summary), `${ndjson}\nnot-json`, JSON.stringify([cases[0], cases[0]]), [summary, ...cases].map(JSON.stringify).join('\n'), [...cases, { fixture_count: 3, passed: 1 }].map(JSON.stringify).join('\n'), [...cases, { fixture_count: 2, passed: 2 }].map(JSON.stringify).join('\n')]) {
    assert.throws(() => parseCaseResults(text));
  }
  assert.throws(() => parseCaseResults(JSON.stringify(cases), { requireSummary: true }), /summary/);
});

test('Unit evidence requires a completed result, methods and no alerts', () => {
  assert.equal(unitMethodCount('<aunit:runResult><testMethod name="case"/></aunit:runResult>'), 1);
  for (const xml of ['<testMethod/>', '<runResult></runResult>', '<runResult><testMethod/><alert/></runResult>', '<runResult><testMethod/>']) assert.throws(() => unitMethodCount(xml));
});

test('preserved raw SAP fixture and Unit receipts remain readable', async () => {
  const directory = new URL('../docs/benchmark-data/nine-2026-10-23T21-21-52-459Z/evidence/work/night-run/', import.meta.url);
  const fixtures = parseCaseResults(await readFile(new URL('fixtures.ndjson', directory), 'utf8'), { requireSummary: true });
  assert.equal(fixtures.summary.passed, fixtures.cases.length);
  assert(unitMethodCount(await readFile(new URL('unit.xml', directory), 'utf8')) > 0);
});
