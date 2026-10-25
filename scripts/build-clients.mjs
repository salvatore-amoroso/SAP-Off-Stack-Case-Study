import assert from 'node:assert/strict';
import { readFile, writeFile, readdir, mkdir } from 'node:fs/promises';
import { resolve, relative } from 'node:path';
import { createHash } from 'node:crypto';
import { spawn, execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { assertEvidenceSafe } from './evidence-safety.mjs';
export const projectRoot = resolve(import.meta.dirname, '..');
const hash = data => createHash('sha256').update(data).digest('hex');
export const builds = [
  { language: 'node', approach: 'http', dockerfile: 'clients/node/Dockerfile', tag: 'sap-polling-node:nine-http' },
  { language: 'node', approach: 'sql', dockerfile: 'clients/node/Dockerfile.sql', tag: 'sap-polling-node:nine-sql' },
  { language: 'rust', approach: 'http', dockerfile: 'clients/rust/Dockerfile', tag: 'sap-polling-rust:nine-http' },
  { language: 'rust', approach: 'sql', dockerfile: 'clients/rust/Dockerfile.sql', tag: 'sap-polling-rust:nine-sql' },
];
export async function sourceBuildFiles(root = projectRoot) {
  const paths = ['build-lock.json'];
  async function walk(directory) {
    for (const entry of await readdir(resolve(root, directory), { withFileTypes: true })) {
      assert(!entry.isSymbolicLink(), 'Build sources must not be symbolic links');
      const path = `${directory}/${entry.name}`;
      if (entry.isDirectory()) await walk(path); else paths.push(path);
    }
  }
  for (const language of ['node', 'rust']) {
    const base = `clients/${language}`;
    paths.push(`${base}/Dockerfile`, `${base}/Dockerfile.sql`, `${base}/.dockerignore`,
      ...((language === 'node' ? ['package.json', 'package-lock.json'] : ['Cargo.toml', 'Cargo.lock']).map(file => `${base}/${file}`)));
    await walk(`${base}/src`);
    if (language === 'node') await walk(`${base}/scripts`);
  }
  return Promise.all(paths.sort().map(async path => {
    const bytes = await readFile(resolve(root, path)); assertEvidenceSafe(path, bytes);
    return { path, sha256: hash(bytes) };
  }));
}
export async function validateBuildLock(root = projectRoot) {
  const lock = JSON.parse(await readFile(resolve(root, 'build-lock.json')));
  assert.equal(lock.platform, 'linux/amd64');
  for (const ref of Object.values(lock.images)) assert(/@sha256:[a-f0-9]{64}$/.test(ref), 'Immutable base digest required');
  assert.equal((await readFile(resolve(root, '.node-version'), 'utf8')).trim(), lock.node_version);
  assert((await readFile(resolve(root, 'rust-toolchain.toml'), 'utf8')).includes(`channel = "${lock.rust_version}"`));
  for (const build of builds) {
    const source = await readFile(resolve(root, build.dockerfile), 'utf8');
    assert(source.includes(`FROM ${lock.images[build.language]}`), `Base pin differs: ${build.dockerfile}`);
    if (build.language === 'rust') assert(source.includes(`FROM ${lock.images.debian}`));
    if (build.language === 'rust' || build.approach === 'sql') assert(source.includes(`/archive/debian/${lock.debian_snapshot}/`));
  }
  return lock;
}
export async function assertRustBuildCurrent(receipt, { root = projectRoot, inspect } = {}) {
  assert(receipt?.passed && receipt.clean_build && receipt.method === 'dockerfile-source-build', 'Run npm run build:clients first');
  const rustSources = files => files.filter(item => item.path === 'build-lock.json' || item.path.startsWith('clients/rust/'));
  assert.deepEqual(rustSources(receipt.source_files), rustSources(await sourceBuildFiles(root)), 'Rust sources changed since image build; run npm run build:clients');
  for (const image of [receipt.images?.['rust-http'], receipt.verification_builder]) {
    assert(image?.tag && /^sha256:[a-f0-9]{64}$/.test(image.id), 'Build receipt lacks the Rust runtime/test compiler identity; rebuild clients');
    const current = inspect ? await inspect(image.tag) : JSON.parse(execFileSync('docker', ['image', 'inspect', '--format', '{"id":{{json .Id}}}', image.tag], { encoding: 'utf8', windowsHide: true }));
    assert.equal(current.id, image.id, 'Rust image changed since source build; rebuild clients');
  }
}
export async function buildClients() {
  const lock = await validateBuildLock(), sources = await sourceBuildFiles();
  const directory = resolve(projectRoot, 'work/builds', new Date().toISOString().replace(/[:.]/g, '-'));
  await mkdir(directory, { recursive: true });
  const receipt = { schema_version: 1, method: 'dockerfile-source-build', clean_build: true, passed: false,
    created_at_utc: new Date().toISOString(), build_lock_sha256: hash(await readFile(resolve(projectRoot, 'build-lock.json'))),
    source_files: sources, base_images: lock.images, platform: lock.platform, images: {}, builds: [] };
  const run = async (args, logFile) => {
    console.log(JSON.stringify({ event: 'build_step', command: ['docker', ...args], log: relative(projectRoot, logFile) }));
    const chunks = [];
    const status = await new Promise((accept, reject) => {
      const child = spawn('docker', args, { cwd: projectRoot, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
      child.stdout.on('data', data => { chunks.push(data); process.stdout.write(data); });
      child.stderr.on('data', data => { chunks.push(data); process.stderr.write(data); });
      child.once('error', reject); child.once('close', accept);
    });
    await writeFile(logFile, Buffer.concat(chunks)); assert.equal(status, 0, 'Docker source build failed; see saved build log');
  };
  try {
    for (const build of builds) {
      await run(['build', '--platform', lock.platform, '--pull', '--no-cache', '--progress=plain', '-f', build.dockerfile, '-t', build.tag, `clients/${build.language}`], resolve(directory, `${build.language}-${build.approach}.log`));
      const image = JSON.parse(execFileSync('docker', ['image', 'inspect', '--format', '{"id":{{json .Id}},"os":{{json .Os}},"architecture":{{json .Architecture}}}', build.tag], { encoding: 'utf8', windowsHide: true }));
      assert.equal(image.os, 'linux'); assert.equal(image.architecture, 'amd64');
      const packages = execFileSync('docker', ['run', '--rm', '--network', 'none', '--entrypoint', 'cat', build.tag, '/usr/share/sap-polling-lab/packages.tsv'], { windowsHide: true });
      const packageFile = `${build.language}-${build.approach}-packages.tsv`; await writeFile(resolve(directory, packageFile), packages);
      receipt.builds.push({ ...build, ...image, package_inventory: packageFile, package_inventory_sha256: hash(packages), no_cache: true });
      for (const approach of build.approach === 'sql' ? ['cds', 'native'] : ['http']) receipt.images[`${build.language}-${approach}`] = { ...image, tag: build.tag, dockerfile: build.dockerfile };
    }
    // Tag the already-verified compiler stage for SAP-free Rust regression tests.
    await run(['build', '--platform', lock.platform, '--target', 'build', '--progress=plain', '-f', 'clients/rust/Dockerfile.sql', '-t', 'sap-polling-rust:verify-build', 'clients/rust'], resolve(directory, 'rust-test-builder.log'));
    receipt.verification_builder = { tag: 'sap-polling-rust:verify-build', ...JSON.parse(execFileSync('docker', ['image', 'inspect', '--format', '{"id":{{json .Id}}}', 'sap-polling-rust:verify-build'], { encoding: 'utf8', windowsHide: true })) };
    const version = (image, program) => execFileSync('docker', ['run', '--rm', '--network', 'none', '--entrypoint', program, image, '--version'], { encoding: 'utf8', windowsHide: true }).trim();
    receipt.runtime_versions = { node: version('sap-polling-node:nine-http', 'node'), rustc: version('sap-polling-rust:verify-build', 'rustc'), cargo: version('sap-polling-rust:verify-build', 'cargo') };
    assert.equal(receipt.runtime_versions.node, `v${lock.node_version}`);
    assert(receipt.runtime_versions.rustc.startsWith(`rustc ${lock.rust_version} `));
    assert.deepEqual(await sourceBuildFiles(), sources, 'Sources changed while building; rebuild before readiness');
    receipt.passed = true;
  } finally {
    receipt.finished_at_utc = new Date().toISOString();
    await writeFile(resolve(directory, 'build-receipt.json'), JSON.stringify(receipt, null, 2) + '\n');
    if (receipt.passed) await writeFile(resolve(projectRoot, 'work/builds/latest.json'), JSON.stringify({ receipt: relative(projectRoot, resolve(directory, 'build-receipt.json')).split('\\').join('/') }, null, 2) + '\n');
    console.log(JSON.stringify({ event: 'build_receipt', passed: receipt.passed, path: relative(projectRoot, resolve(directory, 'build-receipt.json')) }));
  }
  return receipt;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (process.argv.length !== 2) throw new Error('Usage: node scripts/build-clients.mjs');
  await buildClients();
}
