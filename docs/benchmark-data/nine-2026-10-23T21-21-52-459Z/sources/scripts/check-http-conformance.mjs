import http from 'node:http';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { isDeepStrictEqual } from 'node:util';
import { projectRoot } from './sap-runtime.mjs';
const fixtures=JSON.parse(readFileSync(resolve(projectRoot,'contracts/fixtures.json'),'utf8'));
const cases=fixtures.cases.filter(value=>!value.id.startsWith('config_'));
const transportCases=JSON.parse(readFileSync(resolve(projectRoot,'contracts/http-scenarios.json'),'utf8')).cases;
const selected=process.argv.find(value=>value.startsWith('--implementation='))?.split('=')[1];
const implementations=selected?[selected]:['node','rust'];
if(implementations.some(value=>!['node','rust'].includes(value)))throw new Error('Unknown implementation');
const requests=new Map();
const server=http.createServer((request,response)=>{
  const id=new URL(request.url,'http://test.invalid').pathname.split('/')[1];
  if(id==='__stop'){response.end('Stopping');setTimeout(()=>server.close(()=>process.exit(0)),20);return;}
  if(new URL(request.url,'http://test.invalid').searchParams.has('$select'))requests.set(id,0);
  const index=requests.get(id)||0;requests.set(id,index+1);
  if(id==='transport'){request.socket.destroy();return;}
  if(id==='invalid_utf8'){response.writeHead(200,{'Content-Type':'application/json'});response.end(Buffer.from([123,34,118,97,108,117,101,34,58,91,195,93,125]));return;}
  if(id==='timeout'){setTimeout(()=>{if(!response.destroyed){response.writeHead(200);response.end('{"value":[]}');}},1500).unref();return;}
  if(['partial_timeout','oversized_timeout','partial_disconnect','non200_timeout','non200_oversized'].includes(id)){
    response.writeHead(id.startsWith('non200')?503:200,{'Content-Type':'application/json','Content-Length':'2048'});
    response.write('{"value":[');
    if(id==='non200_oversized'){response.end(' '.repeat(2038));return;}
    if(id==='partial_disconnect')setTimeout(()=>response.destroy(),100).unref();
    else setTimeout(()=>{if(!response.destroyed)response.end(' '.repeat(2038));},2500).unref();
    return;
  }
  if(id==='chunked_oversized'){
    response.writeHead(200,{'Content-Type':'application/json'});
    response.write('{"value":[');response.end(' '.repeat(100)+']}');return;
  }
  const test=cases.find(value=>value.id===id),page=test?.pages[index];
  if(!page){response.writeHead(500);response.end('Unexpected request');return;}
  if(request.headers.cookie){response.writeHead(400);response.end('Unexpected cookie');return;}
  const origin=`http://${request.headers.host}`;
  const body=page.body_json.replaceAll('http://fixture.invalid/odata/',`${origin}/${id}/odata/`).replaceAll('"/odata/',`"/${id}/odata/`);
  response.writeHead(page.status,{'Content-Type':'application/json','Content-Length':Buffer.byteLength(body),'Set-Cookie':'fixture=present','Location':`/${id}/odata/OrderPositions`});response.end(body);
});
await new Promise(resolveListen=>server.listen(0,'0.0.0.0',resolveListen));
const port=server.address().port;
if(process.argv.includes('--serve')){
  console.log(JSON.stringify({port,host:'host.docker.internal',cases:[...cases,...transportCases].map(value=>value.id)}));
  setTimeout(()=>{server.closeAllConnections();server.close();},600000).unref();
  await new Promise(resolveStop=>server.once('close',resolveStop));
  process.exit(0);
}
function execute(program,args,env){return new Promise(resolveExit=>{
  const child=spawn(program,args,{cwd:projectRoot,env,windowsHide:true});let stdout='',stderr='';
  const timer=setTimeout(()=>child.kill(),20000);
  child.stdout.on('data',value=>stdout+=value);child.stderr.on('data',value=>stderr+=value);
  child.on('error',error=>{clearTimeout(timer);resolveExit({code:null,stdout,stderr:error.name});});
  child.on('exit',code=>{clearTimeout(timer);resolveExit({code,stdout,stderr});});
});}
const results=[];
try{
  const scenarios=[...cases,...transportCases];
  for(const test of scenarios){
    for(const implementation of implementations){
      requests.set(test.id,0);
      const env={...process.env,SAP_SERVICE_ROOT:`http://${implementation==='node'?'127.0.0.1':'host.docker.internal'}:${port}/${test.id}/odata/`,SAP_CLIENT:'001',EXPECTED_ROWS:String(test.config.expected_rows),EXPECTED_DIGEST:test.config.expected_digest,SCANS:'1',SAP_TLS_INSECURE:'false'};
      delete env.SAP_USERNAME;delete env.SAP_PASSWORD;
      const overrides={request_timeout_seconds:'REQUEST_TIMEOUT_SECONDS',scan_timeout_seconds:'SCAN_TIMEOUT_SECONDS',max_pages:'MAX_PAGES',max_body_bytes:'MAX_BODY_BYTES'};
      for(const [field,key]of Object.entries(overrides))if(test.config[field]!==undefined)env[key]=String(test.config[field]);
      const environmentKeys=['SAP_SERVICE_ROOT','SAP_CLIENT','EXPECTED_ROWS','EXPECTED_DIGEST','SCANS','SAP_TLS_INSECURE','SAP_USERNAME','SAP_PASSWORD',...Object.values(overrides)].filter(key=>env[key]!==undefined);
      const command=implementation==='node'?[process.execPath,[resolve(projectRoot,'clients/node/src/cli.mjs')]]:['docker',['run','--rm','--cpus','1','--memory','256m',...environmentKeys.flatMap(key=>['-e',key]),'sap-polling-rust:local']];
      const run=await execute(command[0],command[1],env);
      let actual=null;try{const value=JSON.parse(run.stdout.trim());actual={outcome:value.outcome,rows:value.rows,pages:value.pages,digest:value.digest,error:value.error};}catch{}
      const expectedExit=test.expected.outcome==='ok'?0:test.expected.error?.code==='CONFIG'?2:1;
      results.push({id:test.id,implementation,passed:isDeepStrictEqual(actual,test.expected)&&run.code===expectedExit,expected:test.expected,actual,exit_code:run.code,expected_exit_code:expectedExit,requests:requests.get(test.id)});
    }
  }
}finally{server.closeAllConnections();await new Promise(resolveClose=>server.close(resolveClose));}
const failures=results.filter(value=>!value.passed);
const report={implementations,checks:results.length,passed:results.length-failures.length,failures};
mkdirSync(resolve(projectRoot,'work'),{recursive:true});
for(const implementation of implementations){
  const checks=results.filter(item=>item.implementation===implementation),failed=checks.filter(item=>!item.passed);
  writeFileSync(resolve(projectRoot,`work/http-conformance-${implementation}-report.json`),JSON.stringify({implementations:[implementation],checks:checks.length,passed:checks.length-failed.length,failures:failed},null,2)+'\n');
}
if(!selected)writeFileSync(resolve(projectRoot,'work/http-conformance-report.json'),JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify({...report,failures:failures.slice(0,3)},null,2));if(failures.length)process.exitCode=1;
