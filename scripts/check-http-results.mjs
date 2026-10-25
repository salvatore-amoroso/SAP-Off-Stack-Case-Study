import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { projectRoot } from './sap-runtime.mjs';
import { parseCaseResults } from './abap-results.mjs';

const read = path => JSON.parse(readFileSync(resolve(projectRoot, path), 'utf8').replace(/^\uFEFF/, ''));
const args = process.argv.slice(2);
if (args.length && (args.length !== 2 || args[0] !== '--abap-results')) throw new Error('Use --abap-results <raw NDJSON or JSON file>, or no arguments');
const fixtures = read('contracts/fixtures.json').cases.filter(item => !item.id.startsWith('config_') && !item.offline_only);
const scenarios = [...fixtures, ...read('contracts/http-scenarios.json').cases];
const functional = ({ outcome, rows, pages, digest, error }) => ({ outcome, rows, pages, digest, error });
const report = { schema_version: 1, cases: scenarios.length, implementations: {} };
for (const name of ['node', 'rust']) {
  const result = read(`work/http-conformance-${name}-report.json`);
  report.implementations[name] = {
    passed: result.checks === scenarios.length && result.passed === scenarios.length && result.failures.length === 0,
    passed_cases: result.passed,
    failures: result.failures,
  };
}
const abap = parseCaseResults(readFileSync(resolve(projectRoot, args[1] || 'work/abap-http-results.json'), 'utf8'));
const byId = new Map(abap.cases.map(item => [item.id, item]));
const failures = scenarios.filter(item => !byId.has(item.id) || byId.get(item.id).passed === false || !isDeepStrictEqual(functional(byId.get(item.id).result), item.expected)).map(item => item.id);
if (abap.cases.length !== scenarios.length) failures.push('result_count');
report.implementations.abap = { passed: failures.length === 0, passed_cases: scenarios.length - failures.filter(id => id !== 'result_count').length, failures };
report.all_passed = Object.values(report.implementations).every(item => item.passed);
writeFileSync(resolve(projectRoot, 'work/http-conformance-report.json'), JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report, null, 2));
if (!report.all_passed) process.exitCode = 1;
