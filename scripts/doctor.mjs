import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { validateBuildLock } from './build-clients.mjs';
import { sapSettings, sapGet } from './sap-runtime.mjs';
import { loadRuntime } from '../deploy/sql/native-runtime.mjs';
import { loadOdbcRuntime } from '../deploy/sql/odbc-runtime.mjs';
export function doctorOptions(args) {
  if (args.some(arg => arg !== '--live') || args.length > 1) throw new Error('Usage: npm run doctor -- [--live]');
  return { live: args.includes('--live') };
}
export async function doctor({ live = false } = {}) {
  const checks = [];
  async function check(name, action, { optional = false, failure = 'Check failed; see the installation guide' } = {}) {
    try { await action(); checks.push({ name, status: 'passed' }); }
    catch { checks.push({ name, status: optional ? 'optional-unavailable' : 'failed', action: failure }); }
  }
  const probe = (program, args) => {
    const result = spawnSync(program, args, { encoding: 'utf8', windowsHide: true, timeout: 10000 });
    assert.equal(result.status, 0);
    return result.stdout.trim();
  };
  await check('Node.js >=24', () => assert(Number(process.versions.node.split('.')[0]) >= 24), { failure: 'Install the Node version in .node-version' });
  await check('Immutable image/toolchain/package-snapshot pins', () => validateBuildLock());
  await check('Git', () => probe('git', ['--version']), { failure: 'Install Git' });
  await check('Docker Linux engine', () => assert.equal(probe('docker', ['info', '--format', '{{.OSType}}']), 'linux'), { optional: !live, failure: 'Start the existing independent Linux Docker launcher' });
  await check('Host Rust toolchain', () => probe('cargo', ['--version']), { optional: true, failure: 'Install rust-toolchain.toml or use npm run build:clients followed by npm run verify:offline -- --docker' });
  if (live) {
    await check('SAP settings and client', () => { const settings = sapSettings(); assert(settings.local && settings.client === '001'); }, { failure: 'Configure .env/SAP_ENV_PATH using .env.example for the existing local trial' });
    await check('Native HANA private runtime', () => loadRuntime(), { failure: 'Provision the restricted view/account using the native HANA setup guide' });
    await check('External ABAP ODBC driver, trusted certificate and SAP network', () => loadOdbcRuntime(), { failure: 'Configure ABAP_ODBC_DRIVER_DIR with Linux driver dependencies and the trusted public certificate; start SAP' });
    await check('Published OData metadata', async () => {
      const settings = sapSettings(), url = new URL(`$metadata?sap-client=${settings.client}`, settings.serviceRoot);
      const response = await sapGet(url, settings, { insecureLocal: settings.local, accept: 'application/xml' });
      assert.equal(response.status, 200); assert(response.body.includes('OrderPositions'));
    }, { failure: 'Check SAP readiness, credentials and OData publication' });
  }
  const result = { passed: checks.every(item => item.status !== 'failed'), mode: live ? 'live-read-only' : 'offline-prerequisites',
    checks, credentials_or_driver_values_printed: false };
  return result;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const result = await doctor(doctorOptions(process.argv.slice(2))); console.log(JSON.stringify(result, null, 2));
  if (!result.passed) process.exitCode = 1;
}
