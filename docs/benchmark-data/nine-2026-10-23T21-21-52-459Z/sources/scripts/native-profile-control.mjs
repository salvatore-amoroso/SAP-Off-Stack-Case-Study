import https from 'node:https';
import { sapSettings } from './sap-runtime.mjs';

export async function runAbapProfile(input) {
  const settings = sapSettings();
  if (!settings.local || settings.client !== '001') throw new Error('LOCAL_TRIAL_CLIENT001_REQUIRED');
  const origin = new URL(settings.serviceRoot).origin;
  const agent = new https.Agent({ keepAlive: true, rejectUnauthorized: false });
  const authorization = `Basic ${Buffer.from(`${settings.username}:${settings.password}`).toString('base64')}`;
  function request(path, headers, body) {
    return new Promise((accept, reject) => {
      const req = https.request(`${origin}${path}`, { agent, method: body ? 'POST' : 'GET', headers: { Authorization: authorization, ...headers } }, response => {
        let output = '', bytes = 0;
        response.setEncoding('utf8');
        response.on('data', chunk => { bytes += Buffer.byteLength(chunk); if (bytes > 33554432) req.destroy(new Error('CONTROL_BODY_LIMIT')); else output += chunk; });
        response.on('end', () => accept({ status: response.statusCode, headers: response.headers, body: output }));
        response.on('error', () => reject(new Error('CONTROL_RESPONSE_FAILURE')));
      });
      const timer = setTimeout(() => req.destroy(new Error('CONTROL_TIMEOUT')), (input.duration_seconds + 180) * 1000);
      req.on('close', () => clearTimeout(timer));
      req.on('error', () => reject(new Error('CONTROL_TRANSPORT_FAILURE')));
      req.end(body);
    });
  }
  try {
    const discovery = await request(`/sap/bc/adt/discovery?sap-client=${settings.client}`, { 'X-CSRF-Token': 'Fetch', Accept: 'application/atomsvc+xml' });
    const token = discovery.headers['x-csrf-token'];
    if (discovery.status !== 200 || !token || token === 'Required') throw new Error('CONTROL_CSRF_FETCH_FAILED');
    const cookie = (discovery.headers['set-cookie'] || []).map(value => value.split(';')[0]).join('; ');
    const payload = JSON.stringify(input);
    const response = await request(`/sap/bc/adt/oo/classrun/ZCL_BL_DIAG_HANA_RUN?sap-client=${settings.client}`, {
      Cookie: cookie, 'X-CSRF-Token': token, Accept: 'text/plain', 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload),
    }, payload);
    if (response.status !== 200) throw new Error(`CONTROL_HTTP_${response.status}`);
    if ([settings.password, authorization].filter(Boolean).some(value => response.body.includes(value))) throw new Error('CONTROL_OUTPUT_REDACTION_FAILED');
    return response.body;
  } finally { agent.destroy(); }
}
