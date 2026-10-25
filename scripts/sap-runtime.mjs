import { existsSync, readFileSync } from 'node:fs';
import { parseEnv } from 'node:util';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import http from 'node:http';
import https from 'node:https';

export const projectRoot=resolve(dirname(fileURLToPath(import.meta.url)),'..');
export function sapSettings({ env = process.env, root = projectRoot } = {}) {
  const localFile = resolve(root, '.env');
  const legacyFile = resolve(root, '../../Tools/mcp-abap-adt/.env');
  const file = env.SAP_ENV_PATH ? resolve(env.SAP_ENV_PATH) : existsSync(localFile) ? localFile : existsSync(legacyFile) ? legacyFile : null;
  let settings = {};
  if (file) {
    try { settings = parseEnv(readFileSync(file, 'utf8').replace(/^\uFEFF/, '')); }
    catch { throw new Error('Unable to read SAP settings; check SAP_ENV_PATH or the project .env file'); }
  }
  for (const key of ['SAP_URL', 'SAP_CLIENT', 'SAP_USERNAME', 'SAP_PASSWORD', 'ABAP_ODBC_DRIVER_DIR']) if (env[key] !== undefined) settings[key] = env[key];
  const missing = ['SAP_URL', 'SAP_USERNAME', 'SAP_PASSWORD'].filter(key => typeof settings[key] !== 'string' || !settings[key]);
  if (missing.length) throw new Error(`Missing SAP settings: ${missing.join(', ')}; set process environment variables or copy .env.example to a private .env file`);
  if (['SAP_URL', 'SAP_CLIENT', 'SAP_USERNAME', 'SAP_PASSWORD', 'ABAP_ODBC_DRIVER_DIR'].some(key => settings[key] !== undefined && /[\0\r\n]/.test(settings[key]))) throw new Error('SAP settings must not contain NUL or newline characters');
  let origin;
  try { origin = new URL(settings.SAP_URL); } catch { throw new Error('SAP_URL must be an absolute HTTP(S) origin'); }
  if (!['http:', 'https:'].includes(origin.protocol) || origin.username || origin.password || origin.search || origin.hash || origin.pathname !== '/') throw new Error('SAP_URL must be an HTTP(S) origin without credentials, path, query or fragment');
  const client = settings.SAP_CLIENT || '001';
  if (!/^\d{3}$/.test(client)) throw new Error('SAP_CLIENT must contain exactly three digits');
  const local=origin.hostname==='127.0.0.1'||origin.hostname==='localhost';
  const serviceRoot=new URL('/sap/opu/odata4/sap/zui_bl_orders_o4/srvd_a2x/sap/zui_bl_orders/0001/',origin).href;
  const driverDirectory = resolve(root, settings.ABAP_ODBC_DRIVER_DIR || '../../Tools/abap-odbc/driver');
  return {serviceRoot,client,username:settings.SAP_USERNAME,password:settings.SAP_PASSWORD,local,driverDirectory};
}
export function sapGet(url,settings,{insecureLocal=false,accept='application/json;odata.metadata=minimal;IEEE754Compatible=true'}={}) {
  const target=new URL(url);
  const headers={Authorization:`Basic ${Buffer.from(`${settings.username}:${settings.password}`).toString('base64')}`,Accept:accept,'Accept-Encoding':'identity'};
  const agent=target.protocol==='https:'?new https.Agent({rejectUnauthorized:!(insecureLocal&&settings.local)}):undefined;
  return new Promise((resolveRequest,reject)=>{
    const request=(target.protocol==='https:'?https:http).get(target,{headers,agent,timeout:15000},response=>{
      const chunks=[];let bytes=0;
      response.on('data',chunk=>{bytes+=chunk.length;if(bytes>8388608){request.destroy(new Error('BODY_LIMIT'));return;}chunks.push(chunk);});
      response.on('end',()=>resolveRequest({status:response.statusCode,headers:response.headers,body:Buffer.concat(chunks).toString('utf8')}));
      response.on('error',reject);
    });
    request.on('timeout',()=>request.destroy(new Error('TIMEOUT')));
    request.on('error',reject);
  });
}
export function pollerEnvironment(settings,manifest) {
  return {...process.env,SAP_SERVICE_ROOT:settings.serviceRoot,SAP_CLIENT:settings.client,SAP_USERNAME:settings.username,SAP_PASSWORD:settings.password,
    EXPECTED_ROWS:String(manifest.expected_rows),EXPECTED_DIGEST:manifest.expected_digest,SAP_TLS_INSECURE:String(settings.local),SCANS:'1'};
}
