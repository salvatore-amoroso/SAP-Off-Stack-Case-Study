import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  checkReadmeMatrix, checkReadmeWordBudget, checkFootnotes, checkReadmeSourceMapping,
  markdownAnchors, checkLocalLinks, documentationOutput, writeDocumentationReceipt, repositoryUrl, documentationInventory,
} from './check-case-study-docs.mjs';

const runtimes = ['ABAP', 'Node.js', 'Rust'], approaches = ['HTTP / OData', 'CDS', 'Direct HANA'];
const medians = [[1556, 76, 72], [1427.28, 55.1, 41.16], [1395, 29, 16]];
const summaries = runtimes.flatMap((runtime, row) => approaches.map((approach, column) => ({
  label: `${runtime} · ${approach}`, p50_ms: { median: medians[row][column] },
})));
const matrix = [
  '| Runtime | HTTP / OData | CDS | Direct HANA |',
  '| --- | ---: | ---: | ---: |',
  '| ABAP | 1,556 | 76 | 72 |',
  '| Node.js | 1,427.28 | 55.1 | 41.16 |',
  '| Rust | 1,395 | 29 | 16 |',
  '',
].join('\n');

test('performance matrix binds all nine p50 cells to runtime and access path', () => {
  assert.equal(checkReadmeMatrix(matrix, summaries), 9);
  assert.equal(checkReadmeMatrix(matrix.replaceAll('\n', '\r\n'), summaries), 9);
});

test('matrix rejects wrong, missing, swapped or duplicated content', async t => {
  const mutations = [
    ['wrong p50', matrix.replace('| 29 |', '| 30 |')],
    ['p95 in a p50 cell', matrix.replace('| 29 |', '| 31 |')],
    ['swapped access-path cells', matrix.replace('| 76 | 72 |', '| 72 | 76 |')],
    ['swapped runtime rows', matrix.replace('| ABAP |', '| Other |').replace('| Rust |', '| ABAP |').replace('| Other |', '| Rust |')],
    ['missing runtime row', matrix.replace('| Node.js | 1,427.28 | 55.1 | 41.16 |\n', '')],
    ['duplicated runtime identity', matrix.replace('| Node.js |', '| ABAP |')],
    ['extra runtime row', matrix + '| Rust | 1,395 | 29 | 16 |\n'],
    ['missing numeric cell', matrix.replace('| 29 | 16 |', '| 29 |')],
    ['extra numeric cell', matrix.replace('| 29 | 16 |', '| 29 | 16 | 16 |')],
    ['invalid row prefix', matrix.replace('| Rust |', 'garbage | Rust |')],
    ['duplicated numeric value', matrix.replace('| 29 | 16 |', '| 29 | 29 |')],
    ['missing header', matrix.replace('| Runtime | HTTP / OData | CDS | Direct HANA |', '')],
    ['duplicated table', matrix + matrix],
    ['table only inside a code fence', '```text\n' + matrix + '```\n'],
  ];
  for (const [name, text] of mutations) await t.test(name, () => assert.throws(() => checkReadmeMatrix(text, summaries)));
});

test('matrix refuses incomplete or duplicate source identities', () => {
  assert.throws(() => checkReadmeMatrix(matrix, summaries.slice(1)), /nine measured/);
  assert.throws(() => checkReadmeMatrix(matrix, [summaries[0], ...summaries.slice(0, 8)]), /Duplicate measured/);
  assert.throws(() => checkReadmeMatrix(matrix, summaries.map((item, index) => index ? item : { ...item, label: 'other' })), /Missing measured/);
});

test('README budget includes table/caption/source words but excludes Mermaid and invisible anchors', () => {
  assert.equal(checkReadmeWordBudget('word '.repeat(900)), 900);
  assert.equal(checkReadmeWordBudget('word '.repeat(1200)), 1200);
  const text = 'word '.repeat(896) + '\n| caption | value |\n[source note](https://example.invalid/hidden/url)\n' +
    '<a id="legacy-anchor-that-is-not-visible"></a>\n```mermaid\n' + 'ignored '.repeat(1500) + '\n```\n';
  assert.equal(checkReadmeWordBudget(text), 900);
  assert.throws(() => checkReadmeWordBudget('word '.repeat(899)), /word count 899/);
  assert.throws(() => checkReadmeWordBudget('word '.repeat(1201)), /word count 1201/);
  assert.throws(() => checkReadmeWordBudget('word '.repeat(900) + '\n```text\n' + 'code '.repeat(400) + '\n```'), /outside/);
});

test('Markdown anchors support GitHub headings, duplicates and explicit legacy IDs, excluding fenced examples', () => {
  const text = '# Title\n## Same\n## Same\n<a id="old-section"></a>\n<a name=\'older-section\'></a>\n' +
    '```powershell\n# After setup\n<a id="fake-id"></a>\n```\n';
  const anchors = markdownAnchors(text);
  assert.deepEqual([...anchors], ['title', 'same', 'same-1', 'old-section', 'older-section']);
  assert(!anchors.has('after-setup') && !anchors.has('fake-id'));
});

test('footnotes accept repeated citations and reject unresolved, duplicated, unused or empty definitions', () => {
  const text = 'Result[^m1] and another citation[^m1].\n\n[^m1]: [Evidence](docs/sources-and-evidence.md#m1-recorded-performance)\n';
  assert.equal(checkFootnotes(text).size, 1);
  assert.equal(checkFootnotes(text + '\n```text\n[^fake]\n[^unused]: example\n```').size, 1);
  assert.equal(checkFootnotes(text + '\n`[^inline-example]` <!-- [^comment-example] -->').size, 1);
  assert.throws(() => checkFootnotes('Claim[^missing].'), /Undefined footnote/);
  assert.throws(() => checkFootnotes(text + '[^m1]: duplicate\n'), /Duplicate footnote/);
  assert.throws(() => checkFootnotes('[^unused]: definition\n'), /Unreferenced footnote/);
  assert.throws(() => checkFootnotes('Claim[^empty].\n[^empty]:\n'), /Empty footnote/);
});

test('README citations map to the correct evidence/source record rather than an unrelated anchor', () => {
  const text = `Measured result[^m1].\n[^m1]: [Evidence](${repositoryUrl}/blob/main/docs/sources-and-evidence.md#m1-recorded-performance)\n`;
  const sources = '<a id="m1-recorded-performance"></a>\n## Results\n';
  assert.deepEqual(checkReadmeSourceMapping(text, sources), ['m1']);
  assert.throws(() => checkReadmeSourceMapping(text.replace('#m1-recorded-performance', '#s2-sql-access-scenarios'), sources), /must link/);
  assert.throws(() => checkReadmeSourceMapping(text, '# Different record'), /Missing source\/evidence/);
  assert.throws(() => checkReadmeSourceMapping(text.replaceAll('m1', 'unknown'), sources), /Unknown README/);
  assert.throws(() => checkReadmeSourceMapping('No citations', sources), /must cite/);
  assert.throws(() => checkReadmeSourceMapping(text.replace(repositoryUrl + '/blob/main/', ''), sources), /fully qualified GitHub URL/);
});

test('inventory covers every tracked Markdown page, including frozen snapshots', () => {
  const { files, paths } = documentationInventory();
  for (const file of ['AGENTS.md', 'clients/node/README.md', 'docs/requirements-install-run.md', 'docs/benchmark-data/nine-2026-10-23T21-21-52-459Z/sources/clients/node/README.md']) {
    assert(paths.has(file)); assert(files.includes(file));
  }
});

test('inventory excludes unstaged deletions while keeping new unignored documentation', async t => {
  const directory = await temporaryDocs(t);
  execFileSync('git', ['init', '--quiet'], { cwd: directory });
  await writeFile(resolve(directory, 'old.md'), '# Old\n');
  await writeFile(resolve(directory, '.gitignore'), 'private.md\n');
  execFileSync('git', ['add', 'old.md', '.gitignore'], { cwd: directory });
  await rm(resolve(directory, 'old.md'));
  await writeFile(resolve(directory, 'new.md'), '# New\n');
  await writeFile(resolve(directory, 'private.md'), '# Private\n');
  const { files, paths } = documentationInventory(directory);
  assert.deepEqual(files, ['new.md']);
  assert(!paths.has('old.md') && !paths.has('private.md'));
});

test('GitHub-qualified footnote links are checked locally rather than skipped as external', async t => {
  const directory = await temporaryDocs(t);
  await mkdir(resolve(directory, 'docs'));
  await writeFile(resolve(directory, 'README.md'), '# Main\n');
  await writeFile(resolve(directory, 'docs/source.md'), '# Evidence\n');
  const tracked = new Set(['README.md', 'docs/source.md']);
  assert.equal(await checkLocalLinks(`[source](${repositoryUrl}/blob/main/docs/source.md#evidence)`, 'README.md', directory, tracked), 1);
  await assert.rejects(checkLocalLinks(`[source](${repositoryUrl}/blob/main/docs/missing.md)`, 'README.md', directory, tracked), /missing, ignored/);
  await assert.rejects(checkLocalLinks('[case](docs/Source.md)', 'README.md', directory, tracked), /incorrect Git case/);
  await writeFile(resolve(directory, 'private.md'), '# Exists only locally\n');
  await assert.rejects(checkLocalLinks('[ignored](private.md)', 'README.md', directory, tracked), /ignored\/untracked/);
  assert.equal(await checkLocalLinks('[directory](docs/)', 'README.md', directory, tracked), 1);
});

async function temporaryDocs(t) {
  const work = resolve(import.meta.dirname, '../work'); await mkdir(work, { recursive: true });
  const directory = await mkdtemp(resolve(work, 'docs-checker-test-'));
  assert(directory.startsWith(work + sep));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

test('local links resolve explicit anchors and headings, and reject missing paths, anchors and escapes', async t => {
  const directory = await temporaryDocs(t);
  await writeFile(resolve(directory, 'README.md'), '# Main\n');
  await writeFile(resolve(directory, 'appendix.md'), '# Appendix\n<a id="stable-source"></a>\n```text\n# Fake heading\n```\n');
  assert.equal(await checkLocalLinks('[heading](appendix.md#appendix) [source](appendix.md#stable-source) [self](#main)', 'README.md', directory), 3);
  assert.equal(await checkLocalLinks('```text\n[example](missing.md)\n```\n`[inline](missing.md)` <!-- [comment](missing.md) -->\n[external](https://example.invalid)', 'README.md', directory), 0);
  await assert.rejects(checkLocalLinks('[missing](missing.md)', 'README.md', directory), /ENOENT/);
  await assert.rejects(checkLocalLinks('[missing](appendix.md#not-there)', 'README.md', directory), /Missing anchor/);
  await assert.rejects(checkLocalLinks('[fake](appendix.md#fake-heading)', 'README.md', directory), /Missing anchor/);
  await assert.rejects(checkLocalLinks('[escape](../outside.md)', 'README.md', directory), /leaves project/);
});

test('check output defaults to ignored work and cannot target historical evidence or leave the project', async t => {
  const directory = await temporaryDocs(t);
  assert.equal(documentationOutput([], directory), resolve(directory, 'work/documentation-checks-current.json'));
  assert.equal(documentationOutput(['--output', 'docs/new-verification.json'], directory), resolve(directory, 'docs/new-verification.json'));
  for (const path of ['docs/documentation-checks.json', 'docs/benchmark-data/run/check.json', 'docs/benchmark-history/run/check.json', 'DOCS/BENCHMARK-DATA/run/check.json']) {
    assert.throws(() => documentationOutput(['--output', path], directory), /Historical evidence/);
  }
  assert.throws(() => documentationOutput(['--output', '../outside.json'], directory), /stay inside/);
  assert.throws(() => documentationOutput(['--unknown'], directory), /Use --output/);
});

test('new receipts outside work use exclusive creation and preserve prior evidence on rerun', async t => {
  const directory = await temporaryDocs(t), file = resolve(directory, 'docs/new-check.json');
  await writeDocumentationReceipt(file, { passed: true }, directory);
  const original = await readFile(file, 'utf8');
  await assert.rejects(writeDocumentationReceipt(file, { passed: false }, directory), /EEXIST/);
  assert.equal(await readFile(file, 'utf8'), original);
  const current = documentationOutput([], directory);
  await writeDocumentationReceipt(current, { revision: 1 }, directory);
  await writeDocumentationReceipt(current, { revision: 2 }, directory);
  assert.deepEqual(JSON.parse(await readFile(current)), { revision: 2 });
});
