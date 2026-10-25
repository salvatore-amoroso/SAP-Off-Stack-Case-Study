import { readdir, mkdir, readFile } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { assertRustBuildCurrent } from './build-clients.mjs';
const root = resolve(import.meta.dirname, '..');
export function verificationOptions(args) {
  if (args.some(arg => !['--node-only', '--rust-only', '--docker'].includes(arg)) || (args.includes('--node-only') && args.includes('--rust-only'))) throw new Error('Use --node-only, --rust-only and/or --docker');
  return { node: !args.includes('--rust-only'), rust: !args.includes('--node-only'), docker: args.includes('--docker') };
}
async function run(program, args) {
  console.log(`\n> ${program} ${args.join(' ')}`);
  const code = await new Promise((accept, reject) => {
    const child = spawn(program, args, { cwd: root, windowsHide: true, stdio: 'inherit' });
    child.once('error', reject); child.once('close', accept);
  });
  if (code !== 0) throw new Error(`Offline verification failed: ${program} (exit ${code})`);
}
export async function verifyOffline(args = process.argv.slice(2)) {
  const options = verificationOptions(args);
  if (Number(process.versions.node.split('.')[0]) < 24) throw new Error('Node.js 24 or later is required');
  await mkdir(resolve(root, 'work'), { recursive: true });
  if (options.node) {
    const files = [];
    for (const directory of ['clients/node/test', 'scripts', 'deploy', 'deploy/sql']) {
      for (const name of await readdir(resolve(root, directory))) if (name.endsWith('.test.mjs')) files.push(`${directory}/${name}`);
    }
    await run(process.execPath, ['--test', '--test-concurrency=2', ...files.sort()]);
    await run(process.execPath, ['scripts/analyze-nine-comparison.mjs', '--self-test']);
    await run(process.execPath, ['scripts/check-http-conformance.mjs', '--implementation=node']);
  }
  if (options.rust) {
    const cargo = spawnSync('cargo', ['--version'], { windowsHide: true, encoding: 'utf8' });
    if (!options.docker && cargo.status === 0) {
      const manifest = ['--locked', '--manifest-path', 'clients/rust/Cargo.toml'];
      await run('cargo', ['test', ...manifest]);
      await run('cargo', ['test', ...manifest, '--all-features']);
      await run('cargo', ['build', ...manifest, '--bin', 'poller']);
      const target = process.env.CARGO_TARGET_DIR ? resolve(process.env.CARGO_TARGET_DIR) : resolve(root, 'clients/rust/target');
      await run(process.execPath, ['scripts/check-http-conformance.mjs', '--implementation=rust', `--rust-bin=${resolve(target, 'debug', process.platform === 'win32' ? 'poller.exe' : 'poller')}`]);
    } else {
      if (root.includes(',')) throw new Error('Docker bind paths cannot contain commas');
      const probe = spawnSync('docker', ['image', 'inspect', 'sap-polling-rust:verify-build'], { windowsHide: true, stdio: 'ignore' });
      if (probe.status !== 0) throw new Error('Install Rust from rust-toolchain.toml or run npm run build:clients to create the Docker test compiler');
      const latest = JSON.parse(await readFile(resolve(root, 'work/builds/latest.json')));
      const receiptPath = resolve(root, latest.receipt);
      if (!receiptPath.startsWith(resolve(root, 'work/builds') + sep)) throw new Error('Invalid local build receipt path');
      await assertRustBuildCurrent(JSON.parse(await readFile(receiptPath)), { root });
      await run('docker', ['run', '--rm', '--network', 'none', '--cpus', '2', '--memory', '4g', '--memory-swap', '4g',
        '--mount', `type=bind,source=${root},target=/workspace,readonly`, '--workdir', '/workspace', '--env', 'CARGO_TARGET_DIR=/app/target',
        'sap-polling-rust:verify-build', 'bash', '-c', 'cargo test --offline --locked --manifest-path clients/rust/Cargo.toml && cargo test --offline --locked --manifest-path clients/rust/Cargo.toml --all-features']);
      await run(process.execPath, ['scripts/check-http-conformance.mjs', '--implementation=rust', '--rust-image=sap-polling-rust:nine-http']);
    }
  }
  console.log(JSON.stringify({ offline_verification_passed: true, ...options, sap_contacted: false, proprietary_odbc_driver_required: false }));
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await verifyOffline();
