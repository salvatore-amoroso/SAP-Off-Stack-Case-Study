import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const fixtures=JSON.parse(readFileSync(resolve(root,'contracts/fixtures.json'),'utf8'));
const work=resolve(root,'work');mkdirSync(work,{recursive:true});
const functional=value=>({outcome:value.outcome,rows:value.rows,pages:value.pages,digest:value.digest,error:value.error});
const commands={
  node:[process.execPath,resolve(root,'clients/node/src/cli.mjs'),'--fixtures',resolve(root,'contracts/fixtures.json')],
  rust:['docker','run','--rm','--cpus','1','--memory','512m','--mount',`type=bind,source=${root},target=/lab,readonly`,'sap-polling-rust:local','--fixtures','/lab/contracts/fixtures.json']
};
const report={schema_version:1,cases:fixtures.cases.length,implementations:{}};
for(const [name,[program,...args]] of Object.entries(commands)) {
  const result=spawnSync(program,args,{cwd:root,encoding:'utf8',timeout:180000,maxBuffer:16*1024*1024,windowsHide:true});
  if(result.status!==0){report.implementations[name]={passed:false,error:'Runner failed',exit_code:result.status};continue;}
  writeFileSync(resolve(work,`${name}-fixtures-results.json`),result.stdout);
}
for(const name of ['node','rust','abap']) {
  const path=resolve(work,`${name}-fixtures-results.json`);
  if(report.implementations[name]?.passed===false)continue;
  if(!existsSync(path)){report.implementations[name]={passed:false,error:'No result artifact'};continue;}
  try{
    const document=JSON.parse(readFileSync(path,'utf8').replace(/^\uFEFF/,''));
    const rows=Array.isArray(document)?document:document.cases.map(value=>({id:value.id,...value.result}));
    const byId=new Map(rows.map(row=>[row.id,row]));
    const failures=fixtures.cases.filter(fixture=>!byId.has(fixture.id)||!isDeepStrictEqual(functional(byId.get(fixture.id)),fixture.expected)).map(fixture=>({id:fixture.id,expected:fixture.expected,actual:byId.has(fixture.id)?functional(byId.get(fixture.id)):null}));
    if(rows.length!==fixtures.cases.length)failures.push({id:'result_count',expected:fixtures.cases.length,actual:rows.length});
    report.implementations[name]={passed:failures.length===0,passed_cases:fixtures.cases.length-failures.filter(f=>f.id!=='result_count').length,failures};
  }catch{report.implementations[name]={passed:false,error:'Invalid result JSON'};}
}
report.all_passed=Object.values(report.implementations).every(value=>value.passed);
writeFileSync(resolve(work,'conformance-report.json'),JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify(report,null,2));
if(!report.all_passed)process.exitCode=1;
