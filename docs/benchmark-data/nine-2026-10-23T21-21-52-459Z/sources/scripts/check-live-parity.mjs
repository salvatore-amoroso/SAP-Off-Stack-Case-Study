import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { sapSettings,pollerEnvironment,projectRoot } from './sap-runtime.mjs';
const settings=sapSettings();
const manifest=JSON.parse(readFileSync(resolve(projectRoot,'contracts/seed-manifest.json'),'utf8'));
const env=pollerEnvironment(settings,manifest);
const commands={node:[process.execPath,resolve(projectRoot,'clients/node/src/cli.mjs')],rust:['docker','run','--rm','--cpus','1','--memory','512m',...['SAP_SERVICE_ROOT','SAP_CLIENT','SAP_USERNAME','SAP_PASSWORD','EXPECTED_ROWS','EXPECTED_DIGEST','SAP_TLS_INSECURE','SCANS'].flatMap(key=>['-e',key]),'sap-polling-rust:local']};
const summary={schema_version:1,expected_rows:manifest.expected_rows,expected_digest:manifest.expected_digest,implementations:{}};
mkdirSync(resolve(projectRoot,'work'),{recursive:true});
for(const [name,[program,...args]] of Object.entries(commands)){
  // Container traffic goes through the existing port forwarder's Docker network.
  const runEnv=name==='rust'?{...env,SAP_SERVICE_ROOT:env.SAP_SERVICE_ROOT.replace('https://127.0.0.1/','https://sap-local-ports/')} : env;
  if(name==='rust'){const imageIndex=args.indexOf('sap-polling-rust:local');args.splice(imageIndex,0,'--network','sap-local-ports');}
  const result=spawnSync(program,args,{cwd:projectRoot,env:runEnv,encoding:'utf8',timeout:150000,maxBuffer:8388608,windowsHide:true});
  try{
    const parsed=JSON.parse(result.stdout.trim());
    writeFileSync(resolve(projectRoot,`work/${name}-live-result.json`),JSON.stringify(parsed,null,2)+'\n');
    summary.implementations[name]={passed:result.status===0&&parsed.outcome==='ok'&&parsed.rows===manifest.expected_rows&&parsed.digest===manifest.expected_digest,result:parsed};
  }catch{summary.implementations[name]={passed:false,error:'Runner did not return a valid scan result',exit_code:result.status};}
}
try{
  const abap=JSON.parse(readFileSync(resolve(projectRoot,'work/abap-live-result.json'),'utf8'));
  summary.implementations.abap={passed:abap.outcome==='ok'&&abap.rows===manifest.expected_rows&&abap.digest===manifest.expected_digest,result:abap};
}catch{summary.implementations.abap={passed:false,error:'No validated ABAP live result artifact'};}
const functional=({schema_version,scan_index,outcome,rows,pages,digest,error})=>({schema_version,scan_index,outcome,rows,pages,digest,error});
const reference=summary.implementations.node.result;
summary.functional_match=Boolean(reference)&&Object.values(summary.implementations).every(value=>value.result&&isDeepStrictEqual(functional(value.result),functional(reference)));
summary.all_passed=summary.functional_match&&Object.values(summary.implementations).every(value=>value.passed);
writeFileSync(resolve(projectRoot,'work/live-parity-report.json'),JSON.stringify(summary,null,2)+'\n');
console.log(JSON.stringify(summary,null,2));
if(!summary.all_passed)process.exitCode=1;
