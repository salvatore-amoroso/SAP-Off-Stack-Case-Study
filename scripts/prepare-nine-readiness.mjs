import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve, dirname, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { projectRoot } from './sap-runtime.mjs';
import { projectFile, publicSourceFiles, validateNineReadiness } from './nine-readiness.mjs';

export async function prepareNineReadiness({ preflight, buildReceipt, smokeRun, output = 'work/nine-readiness/inputs.json', confirmIdle = false }, { root = projectRoot } = {}) {
  const read = async path => JSON.parse(await readFile(await projectFile(root, path), 'utf8'));
  const proof = await read(preflight), build = await read(buildReceipt);
  const evidence = [preflight, buildReceipt, ...proof.source_checks.map(item => item.file), proof.fixtures.file, proof.unit.file, proof.native_view.file, ...(proof.http ? [proof.http.file] : [])];
  if (smokeRun) {
    const smoke = await read(`${smokeRun}/manifest.json`);
    evidence.push(`${smokeRun}/manifest.json`, `${smokeRun}/inputs.json`, ...smoke.blocks.flatMap(item => [`${smokeRun}/${item.path}`, `${smokeRun}/${item.path.replace(/\.json$/, '.ndjson')}`]));
  }
  const descriptor = { schema_version: 1, images: Object.fromEntries(Object.entries(build.images).map(([app, image]) => [app, image.tag])), source_files: await publicSourceFiles(root), evidence_files: [...new Set(evidence)],
    readiness: { ready: Boolean(smokeRun && confirmIdle), operator_idle_confirmed: confirmIdle, sap_preflight: preflight, build_receipt: buildReceipt, nine_path_smoke_passed: Boolean(smokeRun), ...(smokeRun ? { smoke_run: smokeRun } : {}) },
    provenance: { preparation: 'Clean Dockerfile source builds, captured SAP checks and a separately verified nine-path smoke; no old timings adopted' } };
  assert(!confirmIdle || smokeRun, 'Idle attestation requires a completed smoke run');
  const summary = await validateNineReadiness(descriptor, { root, requireReady: descriptor.readiness.ready });
  const destination = resolve(root, output);
  assert(destination.startsWith(resolve(root, 'work') + sep), 'Descriptor output must stay under ignored work/');
  await mkdir(dirname(destination), { recursive: true });
  await writeFile(destination, JSON.stringify(descriptor, null, 2) + '\n');
  return { ...summary, ready: descriptor.readiness.ready, inputs: output };
}

async function main() {
  const args = process.argv.slice(2), options = {};
  if (args.length === 1 && args[0] === '--help') { console.log('Usage: node scripts/prepare-nine-readiness.mjs --preflight work/NEW/preflight.json --build-receipt work/builds/NEW/build-receipt.json [--output work/nine-readiness/inputs.json] [--smoke results/nine-smoke-NEW --confirm-idle]'); return; }
  const names = { '--preflight': 'preflight', '--build-receipt': 'buildReceipt', '--output': 'output', '--smoke': 'smokeRun' };
  for (let index = 0; index < args.length; index++) {
    const flag = args[index];
    if (flag === '--confirm-idle') { assert(!options.confirmIdle, 'Duplicate option'); options.confirmIdle = true; continue; }
    assert(names[flag] && !options[names[flag]] && args[index + 1] && !args[index + 1].startsWith('--'), 'Unexpected/missing or duplicate option; use --help');
    options[names[flag]] = args[++index].replaceAll('\\', '/');
  }
  assert(options.preflight && options.buildReceipt, '--preflight and --build-receipt are required');
  console.log(JSON.stringify(await prepareNineReadiness(options)));
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main().catch(error => { console.error(JSON.stringify({ passed: false, error: error.message })); process.exitCode = 1; });
