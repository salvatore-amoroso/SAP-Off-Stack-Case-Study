import { writeFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { sapSettings,sapGet,projectRoot } from './sap-runtime.mjs';
const settings=sapSettings();
const root=settings.serviceRoot;
const metadata=await sapGet(`${root}$metadata?sap-client=${settings.client}`,settings,{insecureLocal:true,accept:'application/xml'});
mkdirSync(resolve(projectRoot,'work'),{recursive:true});
writeFileSync(resolve(projectRoot,'work/service-metadata.xml'),metadata.body);
const sample=await sapGet(`${root}OrderPositions?$top=1&sap-client=${settings.client}`,settings,{insecureLocal:true});
let parsed;try{parsed=JSON.parse(sample.body);}catch{parsed=null;}
const headerUrl=new URL('Orders',root);
headerUrl.searchParams.set('$top','1');headerUrl.searchParams.set('$select','OrderId,CustomerId,OrderDate');
headerUrl.searchParams.set('$expand','_Positions($select=OrderId,PositionNumber)');headerUrl.searchParams.set('sap-client',settings.client);
const header=await sapGet(headerUrl,settings,{insecureLocal:true});
let expanded;try{expanded=JSON.parse(header.body)?.value?.[0];}catch{}
const report={service_root:root,sap_client:settings.client,metadata_status:metadata.status,sample_status:sample.status,
  sample:parsed?.value?.[0]??null,header_status:header.status,header_order_id:expanded?.OrderId??null,
  expanded_positions:expanded?._Positions?.length??null,error:parsed?.error?{code:parsed.error.code,message:parsed.error.message}:null};
writeFileSync(resolve(projectRoot,'work/service-check.json'),JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify(report,null,2));
if(metadata.status!==200||sample.status!==200||header.status!==200||report.expanded_positions!==5)process.exitCode=1;
