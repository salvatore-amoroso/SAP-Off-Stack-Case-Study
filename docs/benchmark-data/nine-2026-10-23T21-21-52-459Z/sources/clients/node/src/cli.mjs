#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { scan, run } from './poller.mjs';
import { liveConfig } from './config.mjs';

const args = process.argv.slice(2);
const valueAfter = flag => { const index = args.indexOf(flag); return index < 0 ? undefined : args[index + 1]; };

async function fixtures(path) {
  const document = JSON.parse(await readFile(path, 'utf8'));
  const results = [];
  for (const fixture of document.cases) {
    let index = 0;
    const result = await scan({ service_root: 'http://fixture.invalid/odata/', ...fixture.config }, async url => {
      const page = fixture.pages[index++];
      if (!page) throw new Error('Fixture response missing');
      const body = page.body_json ?? '';
      return { status: page.status, url: page.url || url, headers: new Headers(page.headers), body: new Response(body).body };
    });
    const { metrics, ...functional } = result;
    results.push({ id: fixture.id, ...functional });
  }
  process.stdout.write(`${JSON.stringify(results)}\n`);
}

try {
  if (args.includes('--fixtures')) {
    await fixtures(valueAfter('--fixtures'));
  } else {
    const path = valueAfter('--config');
    const config = liveConfig(path ? JSON.parse(await readFile(path, 'utf8')) : {});
    const { createLiveFetcher } = await import('./transport.mjs');
    const transport = await createLiveFetcher(config, process.env.SAP_USERNAME, process.env.SAP_PASSWORD);
    try { process.exitCode = await run(config, transport.fetch); } finally { await transport.close(); }
  }
} catch {
  const result = await scan({});
  process.stdout.write(`${JSON.stringify(result)}\n`);
  process.stderr.write('Unable to load configuration or execute poller.\n');
  process.exitCode = 2;
}
