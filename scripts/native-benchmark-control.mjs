import https from 'node:https';
import { sapSettings } from './sap-runtime.mjs';

export async function runNativeAbapBenchmark({ durationSeconds, warmupScans, manifest }) {
  const settings = sapSettings();
  if (!settings.local || settings.client !== '001') throw new Error('LOCAL_TRIAL_CLIENT001_REQUIRED');
  const origin = new URL(settings.serviceRoot).origin;
  const agent = new https.Agent({ keepAlive: true, rejectUnauthorized: false });
  const authorization = `Basic ${Buffer.from(`${settings.username}:${settings.password}`).toString('base64')}`;
  const sensitive = [settings.password, authorization].filter(Boolean);
  function request(path, headers, body) {
    return new Promise((accept, reject) => {
      const req = https.request(`${origin}${path}`, { agent, method: body ? 'POST' : 'GET',
        headers: { Authorization: authorization, ...headers } }, response => {
        let output = '', bytes = 0;
        response.setEncoding('utf8');
        response.on('data', chunk => {
          bytes += Buffer.byteLength(chunk);
          if (bytes > 33554432) req.destroy(new Error('CONTROL_BODY_LIMIT')); else output += chunk;
        });
        response.on('end', () => accept({ status: response.statusCode, headers: response.headers, body: output }));
        response.on('error', () => reject(new Error('CONTROL_RESPONSE_FAILURE')));
      });
      const deadline = setTimeout(() => req.destroy(new Error('CONTROL_TIMEOUT')), (durationSeconds + 180) * 1000);
      req.on('close', () => clearTimeout(deadline));
      req.on('error', error => reject(new Error(error.message === 'CONTROL_TIMEOUT' ? error.message : 'CONTROL_TRANSPORT_FAILURE')));
      req.end(body);
    });
  }
  try {
    const discovery = await request(`/sap/bc/adt/discovery?sap-client=${settings.client}`,
      { 'X-CSRF-Token': 'Fetch', Accept: 'application/atomsvc+xml' });
    const token = discovery.headers['x-csrf-token'];
    if (discovery.status !== 200 || !token || token === 'Required') throw new Error('CONTROL_CSRF_FETCH_FAILED');
    const cookie = (discovery.headers['set-cookie'] || []).map(value => value.split(';')[0]).join('; ');
    const payload = JSON.stringify({ sap_client: settings.client, expected_rows: manifest.expected_rows,
      expected_digest: manifest.expected_digest, scan_timeout_seconds: 120, max_pages: 10000,
      duration_seconds: durationSeconds, warmup_scans: warmupScans, max_scans: 0 });
    const response = await request(`/sap/bc/adt/oo/classrun/ZCL_BL_BENCH_NATIVE?sap-client=${settings.client}`, {
      Cookie: cookie, 'X-CSRF-Token': token, Accept: 'text/plain', 'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(payload),
    }, payload);
    if (response.status !== 200) throw new Error(`CONTROL_HTTP_${response.status}`);
    if (sensitive.some(value => response.body.includes(value))) throw new Error('CONTROL_OUTPUT_REDACTION_FAILED');
    return response.body;
  } finally { agent.destroy(); }
}
