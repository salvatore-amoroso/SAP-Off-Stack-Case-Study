import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';

const root = resolve(import.meta.dirname, '..');
test('deployment guides use the same patch file rather than inline native JSON', async () => {
  const patch = JSON.parse(await readFile(resolve(root, 'deploy/unsuspend-job.json'), 'utf8'));
  assert.deepEqual(patch, { spec: { suspend: false } });
  for (const file of ['deploy/README.md', 'deploy/sql/README.md']) {
    const guide = await readFile(resolve(root, file), 'utf8');
    assert.equal((guide.match(/--patch-file=deploy\/unsuspend-job\.json/g) || []).length, 2);
    assert(!guide.includes('-p \'{"spec"'), `${file} must not depend on JSON argument escaping`);
  }
});

test('Windows PowerShell 5.1 preserves the documented native patch-file arguments', { skip: process.platform !== 'win32' }, async t => {
  const directory = await mkdtemp(resolve(tmpdir(), 'patch-file-argv-')); t.after(() => rm(directory, { recursive: true, force: true }));
  const printer = resolve(directory, 'argv.mjs'); await writeFile(printer, 'console.log(JSON.stringify(process.argv.slice(2)));\n');
  const quote = value => `'${value.replaceAll("'", "''")}'`;
  const script = `& ${quote(process.execPath)} ${quote(printer)} --type=merge --patch-file=deploy/unsuspend-job.json`;
  const powershell = resolve(process.env.SystemRoot || 'C:/Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe');
  const result = spawnSync(powershell, ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { cwd: root, encoding: 'utf8', windowsHide: true, timeout: 15000 });
  assert.equal(result.status, 0, 'The read-only native argument printer must complete');
  assert.deepEqual(JSON.parse(result.stdout.trim()), ['--type=merge', '--patch-file=deploy/unsuspend-job.json']);
});
