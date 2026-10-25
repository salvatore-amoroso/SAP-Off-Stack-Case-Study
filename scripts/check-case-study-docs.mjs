import assert from 'node:assert/strict';
import { readFile, stat, writeFile, mkdir } from 'node:fs/promises';
import { resolve, dirname, relative, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
const root = resolve(import.meta.dirname, '..');
export const repositoryUrl = 'https://github.com/salvatore-amoroso/SAP-Off-Stack-Case-Study';
export function documentationInventory(docRoot = root) {
  const tracked = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard'], { cwd: docRoot, encoding: 'utf8' }).trim().split(/\r?\n/).filter(Boolean);
  const deleted = new Set(execFileSync('git', ['ls-files', '--deleted'], { cwd: docRoot, encoding: 'utf8' }).trim().split(/\r?\n/).filter(Boolean));
  const paths = new Set(tracked.filter(file => !deleted.has(file)));
  return { paths, files: [...paths].filter(file => /\.(?:md|markdown)$/i.test(file)).sort() };
}
const markdownLink = /!?\[[^\]]*\]\((?:<([^>]+)>|([^\)]+))\)/g;
const fencedCode = /^ {0,3}(`{3,}|~{3,})([^\r\n]*)\r?\n[\s\S]*?^ {0,3}\1[ \t]*$/gm;
const format = value => value.toLocaleString('en-US', { maximumFractionDigits: 2 });
const sourceAnchors = {
  m1: 'm1-recorded-performance', m2: 'm2-derived-comparisons', c1: 'c1-workload-parity',
  g1: 'g1-cds-access', j1: 'j1-maintenance-obligations', h1: 'h1-driver-incident',
  s1: 's1-sql-service-exposure', s2: 's2-sql-access-scenarios', s3: 's3-cap-runtime-context',
  s4: 's4-http-odata', s5: 's5-rust-ffi',
};
const withoutCode = text => text.replace(fencedCode, '').replace(/<!--[\s\S]*?-->/g, '');
const withoutInlineCode = text => text.replace(/(`+)[^\r\n]*?\1/g, '');
const slug = title => title.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1').toLowerCase().replace(/<[^>]*>/g, '').replace(/[`*_]/g, '').replace(/[^\p{L}\p{N}\s_-]/gu, '').trim().replace(/\s+/g, '-');

export function markdownAnchors(text) {
  const body = withoutCode(text), anchors = new Set(), counts = new Map();
  for (const heading of body.matchAll(/^ {0,3}#{1,6}\s+(.+?)\s*#*\s*$/gm)) {
    const name = slug(heading[1]), count = counts.get(name) || 0;
    anchors.add(name + (count ? `-${count}` : '')); counts.set(name, count + 1);
  }
  for (const anchor of body.matchAll(/<a\b[^>]*\b(?:id|name)=["']([^"']+)["'][^>]*>/gi)) anchors.add(anchor[1]);
  return anchors;
}

export function checkReadmeWordBudget(text) {
  const visible = text.replace(fencedCode, (block, fence, info) => info.trim().toLowerCase() === 'mermaid' ? '' : block)
    .replace(/<!--[\s\S]*?-->/g, '').replace(/<[^>]*>/g, ' ')
    .replace(/!?\[([^\]]*)\]\((?:<[^>]+>|[^)]+)\)/g, '$1').replace(/\[\^[^\]]+\]:?/g, '');
  const words = visible.split(/\s+/).filter(word => /[\p{L}\p{N}]/u.test(word)).length;
  assert(words >= 900 && words <= 1200, `README word count ${words} is outside 900–1200 (Mermaid syntax excluded)`);
  return words;
}

export function checkReadmeMatrix(text, summaries) {
  const lines = withoutCode(text).split(/\r?\n/), header = '| Runtime | HTTP / OData | CDS | Direct HANA |';
  const positions = lines.flatMap((line, index) => line.trim() === header ? [index] : []);
  assert.equal(positions.length, 1, 'README must have exactly one performance matrix header');
  const start = positions[0];
  const separators = cells(lines[start + 1] || '');
  assert(separators.length === 4 && separators.every(cell => /^:?-{3,}:?$/.test(cell)), 'README performance matrix separator');
  const runtimes = ['ABAP', 'Node.js', 'Rust'], approaches = ['HTTP / OData', 'CDS', 'Direct HANA'];
  assert.equal(summaries.length, 9, 'Expected nine measured path summaries');
  const values = new Map(summaries.map(item => [item.label, item]));
  assert.equal(values.size, 9, 'Duplicate measured path summary identity');
  for (const [index, runtime] of runtimes.entries()) {
    const row = cells(lines[start + 2 + index] || '');
    assert.equal(row.length, 4, `README ${runtime} row must contain exactly three numeric cells`);
    assert.equal(row[0], runtime, `README performance matrix runtime row ${index + 1}`);
    for (const [column, approach] of approaches.entries()) {
      const label = `${runtime} · ${approach}`, item = values.get(label);
      assert(item, `Missing measured summary: ${label}`);
      assert.equal(row[column + 1], format(item.p50_ms.median), `README matrix p50 mismatch: ${label}`);
    }
  }
  assert(!/^\s*\|/.test(lines[start + 5] || ''), 'README performance matrix has extra or duplicated rows');
  return 9;
}

const cells = row => {
  assert(row.trim().startsWith('|') && row.trim().endsWith('|'), 'Expected a pipe-delimited table row');
  return row.trim().split('|').slice(1, -1).map(value => value.trim());
};

export function checkFootnotes(text, file = 'Markdown') {
  const body = withoutCode(text), definitions = new Map();
  for (const match of body.matchAll(/^\[\^([^\]\r\n]+)\]:[ \t]*(.*(?:\r?\n[ \t]{2,}[^\r\n]+)*)/gm)) {
    assert(!definitions.has(match[1]), `Duplicate footnote definition ${match[1]} in ${file}`);
    assert(match[2].trim(), `Empty footnote definition ${match[1]} in ${file}`);
    definitions.set(match[1], match[2]);
  }
  const references = new Set([...withoutInlineCode(body.replace(/^\[\^[^\]\r\n]+\]:/gm, '')).matchAll(/\[\^([^\]\r\n]+)\]/g)].map(match => match[1]));
  for (const id of references) assert(definitions.has(id), `Undefined footnote ${id} in ${file}`);
  for (const id of definitions.keys()) assert(references.has(id), `Unreferenced footnote ${id} in ${file}`);
  return definitions;
}

export function checkReadmeSourceMapping(text, sourceText) {
  const definitions = checkFootnotes(text, 'README.md'), anchors = markdownAnchors(sourceText);
  assert(definitions.size > 0, 'README must cite its source/evidence register');
  for (const [id, definition] of definitions) {
    const anchor = sourceAnchors[id];
    assert(anchor, `Unknown README source footnote ${id}`);
    const targets = [...definition.matchAll(markdownLink)].map(match => (match[1] || match[2]).trim());
    assert(targets.includes(`${repositoryUrl}/blob/main/docs/sources-and-evidence.md#${anchor}`), `README footnote ${id} must link to its source/evidence record with a fully qualified GitHub URL; relative footnote links break on the repository landing page`);
    assert(anchors.has(anchor), `Missing source/evidence record ${anchor}`);
  }
  return [...definitions.keys()];
}

export async function checkLocalLinks(text, file, docRoot = root, trackedPaths = null) {
  const path = resolve(docRoot, file); let count = 0;
  for (const match of withoutInlineCode(withoutCode(text)).matchAll(markdownLink)) {
    let target = (match[1] || match[2]).trim();
    if (target.startsWith(repositoryUrl + '/blob/main/')) target = '/' + target.slice((repositoryUrl + '/blob/main/').length);
    else if (target.startsWith(repositoryUrl + '/tree/main/')) target = '/' + target.slice((repositoryUrl + '/tree/main/').length);
    else if (/^(?:https?:|mailto:)/i.test(target)) continue;
    const [name, anchor] = target.split('#');
    const cleanName = name.split('?')[0];
    const destination = cleanName ? (cleanName.startsWith('/') ? resolve(docRoot, decodeURIComponent(cleanName.slice(1))) : resolve(dirname(path), decodeURIComponent(cleanName))) : path;
    assert(destination === docRoot || destination.startsWith(docRoot + sep), `Local link leaves project: ${file}`);
    if (trackedPaths) {
      const relativePath = relative(docRoot, destination).split(sep).join('/');
      const isTracked = relativePath === '' || trackedPaths.has(relativePath) || [...trackedPaths].some(item => item.startsWith(relativePath + '/'));
      assert(isTracked, `Link target is missing, ignored/untracked or has incorrect Git case: ${file} -> ${target}`);
    }
    const info = await stat(destination);
    assert(info.isFile() || info.isDirectory(), `Missing link: ${file} -> ${target}`); count++;
    if (anchor && destination.endsWith('.md')) {
      const body = await readFile(destination, 'utf8');
      assert(markdownAnchors(body).has(decodeURIComponent(anchor)), `Missing anchor: ${file} -> ${target}`);
    }
  }
  return count;
}

export function documentationOutput(args, docRoot = root) {
  assert(args.length === 0 || (args.length === 2 && args[0] === '--output'), 'Use --output <project-relative JSON path> or no arguments');
  const output = resolve(docRoot, args[1] || 'work/documentation-checks-current.json');
  assert(output.startsWith(docRoot + sep), 'Documentation check output must stay inside the project');
  const name = relative(docRoot, output).split(sep).join('/');
  assert(!/^docs\/benchmark-(?:data|history)(?:\/|$)/i.test(name) && name.toLowerCase() !== 'docs/documentation-checks.json', 'Historical evidence/check receipts cannot be documentation check output');
  return output;
}

export async function writeDocumentationReceipt(output, result, docRoot = root) {
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, JSON.stringify(result, null, 2) + '\n', { flag: output.startsWith(resolve(docRoot, 'work') + sep) ? 'w' : 'wx' });
}

export async function checkCaseStudyDocs(args = process.argv.slice(2)) {
  const output = documentationOutput(args);
  const { files, paths } = documentationInventory();
  const report = JSON.parse(await readFile(resolve(root, 'docs/nine-comparison.json')));
  assert.equal(report.status, 'validated'); assert.equal(report.blocks.length, 27);
  const hash = bytes => createHash('sha256').update(bytes).digest('hex');
  const texts = new Map(), records = []; let links = 0;
  for (const file of files) {
    const path = resolve(root, file), bytes = await readFile(path), text = bytes.toString('utf8'); texts.set(file, text);
    assert(!/will be recorded here after|REVIEW_PENDING|RESULTS_PENDING/.test(text), `Unfinished text in ${file}`);
    checkFootnotes(text, file); links += await checkLocalLinks(text, file, root, paths);
    records.push({ file, sha256: hash(bytes), bytes: bytes.length });
  }
  const readme = texts.get('README.md'), words = checkReadmeWordBudget(readme);
  const matrixCells = checkReadmeMatrix(readme, report.summaries);
  const sourceIds = checkReadmeSourceMapping(readme, texts.get('docs/sources-and-evidence.md'));
  for (const item of report.summaries) {
    const rows = texts.get('docs/nine-comparison.md').split('\n').filter(line => line.startsWith(`| ${item.label} |`));
    assert.equal(rows.length, 1, `Missing or duplicate detailed result: ${item.label}`);
    const columns = cells(rows[0]); assert.equal(columns.length, 6);
    assert.equal(columns[1], format(item.successful_scans));
    assert(columns[2].startsWith(format(item.p50_ms.median) + ' (')); assert(columns[3].startsWith(format(item.p95_ms.median) + ' ('));
    assert(columns[4].startsWith(format(item.useful_rows_per_second.median) + ' (')); assert.equal(columns[5], '0');
  }
  const graphs = [...readme.matchAll(/```mermaid[\s\S]*?```/g)]; assert.equal(graphs.length, 1, 'README must retain one canonical Mermaid diagram');
  const graph = graphs[0][0];
  assert(graph.includes('subgraph SQL_ACCESS[SQL access]') && graph.includes('subgraph HTTP_ACCESS[HTTP access]'));
  assert.equal((graph.match(/\[\(/g) || []).length, 1); assert(graph.includes('ZBL_ORD_HDR') && graph.includes('ZBL_ORD_POS') && graph.includes('ADBC('));
  const imageFiles = ['docs/nine-comparison.png', 'docs/nine-comparison.svg', 'docs/nine-scan-latency.png', 'docs/nine-scan-latency.svg'];
  const images = [];
  for (const file of imageFiles) { const bytes = await readFile(resolve(root, file)); assert(bytes.length > 1000); images.push({ file, sha256: hash(bytes), bytes: bytes.length }); }
  const result = { checked_at_utc: new Date().toISOString(), passed: true, documents: records, local_links_checked: links,
    readme_words_excluding_mermaid: words, matrix_cells_verified: matrixCells, detailed_result_rows_verified: report.summaries.length,
    readme_source_footnotes: sourceIds,
    figures: images, canonical_graph_groups_and_single_database_verified: true,
    checker_sha256: hash(await readFile(import.meta.filename)),
    scope: 'All tracked Markdown pages: exact-case repository link/anchor checks, including same-repository absolute URLs and archived snapshots; README word-budget/source-footnote checks, numeric tables, figures and graph. External sites and rendered navigation are reviewed separately.' };
  await writeDocumentationReceipt(output, result);
  console.log(JSON.stringify({ passed: true, documents: files.length, local_links: links, readme_words: words, matrix_cells: matrixCells, detailed_result_rows: report.summaries.length, figures: 4 }));
  return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await checkCaseStudyDocs();
