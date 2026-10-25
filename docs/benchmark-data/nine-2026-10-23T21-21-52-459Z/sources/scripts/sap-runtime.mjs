import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import http from 'node:http';
import https from 'node:https';

export const projectRoot=resolve(dirname(fileURLToPath(import.meta.url)),'..');
export function sapSettings() {
  const installation=resolve(projectRoot,'../../Tools/mcp-abap-adt');
  const require=createRequire(resolve(installation,'node_modules/@mcp-abap-adt/core/package.json'));
  const settings=require('dotenv').parse(readFileSync(process.env.SAP_ENV_PATH||resolve(installation,'.env')));
  const origin=new URL(settings.SAP_URL);
  const local=origin.hostname==='127.0.0.1'||origin.hostname==='localhost';
  const serviceRoot=new URL('/sap/opu/odata4/sap/zui_bl_orders_o4/srvd_a2x/sap/zui_bl_orders/0001/',origin).href;
  return {serviceRoot,client:settings.SAP_CLIENT||'001',username:settings.SAP_USERNAME,password:settings.SAP_PASSWORD,local};
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
