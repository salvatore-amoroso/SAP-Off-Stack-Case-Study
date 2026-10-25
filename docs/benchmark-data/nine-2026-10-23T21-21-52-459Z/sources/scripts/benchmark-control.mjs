import https from 'node:https';
import { sapSettings } from './sap-runtime.mjs';

export const benchmarkServiceRoot = 'http://host.docker.internal/sap/opu/odata4/sap/zui_bl_orders_o4/srvd_a2x/sap/zui_bl_orders/0001/';

function request(url, options, payload) {
  return new Promise((resolve, reject) => {
    const req = https.request(url, options, response => {
      const chunks = [];
      let bytes = 0;
      response.on('data', chunk => {
        bytes += chunk.length;
        if (bytes > 16 * 1024 * 1024) req.destroy(new Error('CONTROL_BODY_LIMIT'));
        else chunks.push(chunk);
      });
      response.on('end', () => resolve({ status: response.statusCode, headers: response.headers, body: Buffer.concat(chunks).toString('utf8') }));
      response.on('error', () => reject(new Error('CONTROL_RESPONSE_FAILURE')));
    });
    req.setTimeout(330000, () => req.destroy(new Error('CONTROL_TIMEOUT')));
    req.on('error', error => reject(new Error(error.message === 'CONTROL_TIMEOUT' ? error.message : 'CONTROL_TRANSPORT_FAILURE')));
    if (payload) req.end(payload); else req.end();
  });
}

async function runLocalBenchmark(className, makePayload, { profilerId, onTiming } = {}) {
  const settings = sapSettings();
  const origin = new URL(settings.serviceRoot).origin;
  if (!settings.local) throw new Error('Benchmark control is restricted to the configured local trial');
  const agent = new https.Agent({ keepAlive: true, rejectUnauthorized: false });
  const authorization = `Basic ${Buffer.from(`${settings.username}:${settings.password}`).toString('base64')}`;
  try {
    const discovery = await request(`${origin}/sap/bc/adt/discovery?sap-client=${settings.client}`, {
      agent, method: 'GET', headers: { Authorization: authorization, 'X-CSRF-Token': 'Fetch', Accept: 'application/atomsvc+xml' },
    });
    const token = discovery.headers['x-csrf-token'];
    if (discovery.status !== 200 || !token || token === 'Required') throw new Error('CONTROL_CSRF_FETCH_FAILED');
    const cookie = (discovery.headers['set-cookie'] || []).map(value => value.split(';')[0]).join('; ');
    const payload = JSON.stringify(makePayload(settings));
    const query = new URLSearchParams({ 'sap-client': settings.client });
    if (profilerId) query.set('profilerId', profilerId);
    onTiming?.({ event: 'adt_dispatch', utc: new Date().toISOString(), monotonic_ns: process.hrtime.bigint().toString() });
    const result = await request(`${origin}/sap/bc/adt/oo/classrun/${className}?${query}`, {
      agent, method: 'POST', headers: { Authorization: authorization, 'X-CSRF-Token': token, Cookie: cookie,
        ...(profilerId ? { 'X-sap-adt-profiling': 'server-time' } : {}),
        Accept: 'text/plain', 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
    }, payload);
    onTiming?.({ event: 'adt_complete', utc: new Date().toISOString(), monotonic_ns: process.hrtime.bigint().toString() });
    if (result.status !== 200) throw new Error(`CONTROL_HTTP_${result.status}`);
    if (result.body.includes(settings.password) || result.body.includes(authorization)) throw new Error('CONTROL_OUTPUT_REDACTION_FAILED');
    return result.body;
  } finally { agent.destroy(); }
}

export function runAbapBenchmark({ durationSeconds, warmupScans, manifest, maxScans = 0 }) {
  return runLocalBenchmark('ZCL_BL_BENCH_ORDERS', settings => ({ username: settings.username, password: settings.password,
    service_root: benchmarkServiceRoot, sap_client: settings.client, expected_rows: manifest.expected_rows,
    expected_digest: manifest.expected_digest, request_timeout_seconds: 10, scan_timeout_seconds: 120,
    page_size: 500, max_body_bytes: 8388608, max_pages: 10000,
    duration_seconds: durationSeconds, warmup_scans: warmupScans, max_scans: maxScans }));
}

export function runCdsBenchmark({ durationSeconds, warmupScans, manifest, maxScans = 0 }, options) {
  return runLocalBenchmark('ZCL_BL_BENCH_CDS', settings => ({ sap_client: settings.client,
    expected_rows: manifest.expected_rows, expected_digest: manifest.expected_digest, scan_timeout_seconds: 120,
    duration_seconds: durationSeconds, warmup_scans: warmupScans, max_scans: maxScans }), options);
}

export function runCdsDiagnostic(input, { variant = 'instrumented', profilerId } = {}) {
  const classes = { instrumented: 'ZCL_BL_DIAG_CDS', base: 'ZCL_BL_DIAG_BASE', copy: 'ZCL_BL_DIAG_COPY', gc_once: 'ZCL_BL_DIAG_GCONCE', nojit: 'ZCL_BL_DIAG_NJ_RUN', phase: 'ZCL_BL_DIAG_PH_RUN', stat_window: 'ZCL_BL_DIAG_STAT_WINDOW' };
  const className = classes[variant];
  if (!className) throw new Error('INVALID_DIAGNOSTIC_VARIANT');
  return runLocalBenchmark(className, settings => {
    const payload = { sap_client: settings.client, ...input };
    payload.sap_client = settings.client;
    return payload;
  }, { profilerId });
}
