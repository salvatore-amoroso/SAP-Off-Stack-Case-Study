import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { scan, run, normalizeConfig, initialUrl } from '../src/poller.mjs';
import { createLiveFetcher } from '../src/transport.mjs';

const fixturePath = process.env.FIXTURES_PATH || new URL('../../../contracts/fixtures.json', import.meta.url);
const { cases } = JSON.parse(await readFile(fixturePath, 'utf8'));

for (const fixture of cases) {
  test(`shared fixture: ${fixture.id}`, async () => {
    let index = 0;
    const actual = await scan(fixture.config, async url => {
      const page = fixture.pages[index++];
      assert.ok(page, 'must not request an unprovided page');
      return { status: page.status, url: page.url || url, headers: new Headers(page.headers), body: new Response(page.body_json).body };
    });
    const { schema_version, scan_index, metrics, ...functional } = actual;
    assert.equal(schema_version, 1);
    assert.equal(scan_index, 0);
    assert.deepEqual(functional, fixture.expected);
  });
}

test('first request and numeric bounds follow the common contract', () => {
  const config = normalizeConfig(cases[0].config);
  const url = new URL(initialUrl(config));
  assert.deepEqual([...url.searchParams.keys()], ['$select', '$orderby', 'sap-client']);
  assert.equal(url.searchParams.get('sap-client'), '001');
  assert.equal(url.searchParams.has('$top'), false);
  for (const override of [{ expected_rows: 2147483648 }, { request_timeout_seconds: 0.5 }, { scans: 1000001 }, { interval_ms: 3600001 }, { page_size: 10001 }, { max_body_bytes: 67108865 }, { max_pages: 1000001 }]) assert.throws(() => normalizeConfig({ ...config, ...override }), error => error.code === 'CONFIG');
});

async function withServer(handler, callback) {
  const server = createServer(handler);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const root = `http://127.0.0.1:${server.address().port}/odata/`;
  const config = { ...cases[0].config, service_root: root };
  const transport = await createLiveFetcher(config, 'fixture-user', 'fixture-password');
  try { await callback(config, transport.fetch); }
  finally { await transport.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
}

test('live fetch preserves auth/headers, follows query-only links, and does not retain cookies', async () => {
  let requests = 0;
  const source = JSON.parse(cases[0].pages[0].body_json).value;
  await withServer((request, response) => {
    requests++;
    assert.equal(request.headers.authorization, `Basic ${Buffer.from('fixture-user:fixture-password').toString('base64')}`);
    assert.equal(request.headers.cookie, undefined);
    assert.equal(request.headers['accept-encoding'], 'identity');
    assert.equal(request.headers.prefer, 'odata.maxpagesize=500');
    response.setHeader('Set-Cookie', 'lab_session=never-replay');
    response.end(JSON.stringify(requests === 1 ? { value: [source[0]], '@odata.nextLink': '?cursor=2' } : { value: [source[1]] }));
  }, async (config, fetcher) => {
    const result = await scan(config, fetcher);
    assert.equal(result.outcome, 'ok');
    assert.equal(result.pages, 2);
  });
  assert.equal(requests, 2);
});

test('live redirects are not followed', async () => {
  let requests = 0;
  await withServer((request, response) => { requests++; response.writeHead(302, { Location: '/odata/leak' }); response.end(); }, async (config, fetcher) => {
    const result = await scan(config, fetcher);
    assert.deepEqual(result.error, { code: 'HTTP_STATUS', page_index: 1, http_status: 302 });
  });
  assert.equal(requests, 1);
});

test('request deadline includes a stalled response body', async () => {
  await withServer((request, response) => { response.writeHead(200); response.write('{"value":['); }, async (config, fetcher) => {
    const result = await scan({ ...config, request_timeout_seconds: 1 }, fetcher);
    assert.deepEqual(result.error, { code: 'TIMEOUT', page_index: 1, http_status: null });
    assert.ok(result.metrics.elapsed_ms >= 900 && result.metrics.elapsed_ms < 2500);
  });
});

test('invalid UTF-8 and declared body limits fail before row processing', async () => {
  const config = cases[0].config;
  const invalid = await scan(config, async url => ({ status: 200, url, headers: new Headers(), body: new Response(Buffer.from([0xff])).body }));
  assert.equal(invalid.error.code, 'SCHEMA');
  const limit = await scan({ ...config, max_body_bytes: 10 }, async url => ({ status: 200, url, headers: new Headers({ 'content-length': '11' }), body: new Response('invalid JSON').body }));
  assert.equal(limit.error.code, 'LIMIT');
  assert.equal(limit.rows, 0);
});

test('transient errors permit the next scan, terminal errors stop, and slots are skipped', async () => {
  const config = { ...cases[0].config, scans: 3, interval_ms: 10 };
  let calls = 0;
  const output = [];
  const code = await run(config, async url => {
    calls++;
    if (calls === 1) { await new Promise(resolve => setTimeout(resolve, 25)); return new Response('', { status: 503 }); }
    return { status: 200, url, headers: new Headers(), body: new Response(cases[0].pages[0].body_json).body };
  }, result => output.push(result));
  assert.equal(code, 1);
  assert.equal(output.length, 3);
  assert.deepEqual(output.map(result => result.scan_index), [0, 1, 2]);
  assert.ok(output[0].metrics.missed_slots >= 2);
  const stopped = [];
  assert.equal(await run(config, async () => new Response('', { status: 401 }), result => stopped.push(result)), 1);
  assert.equal(stopped.length, 1);
});
