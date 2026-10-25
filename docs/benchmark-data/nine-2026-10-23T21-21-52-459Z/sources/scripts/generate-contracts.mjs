import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const fields = ['OrderId','PositionNumber','CustomerId','OrderDate','MaterialId','Quantity','Unit','NetAmount','Currency'];
const prefix = 'sap-polling-lab\t1\n';
export function seedRow(order, position) {
  return { OrderId: String(order).padStart(20,'0'), PositionNumber: String(position*10).padStart(6,'0'),
    CustomerId: `C${String(order).padStart(9,'0')}`, OrderDate:'2026-01-01',
    MaterialId:`M${String(position).padStart(17,'0')}`, Quantity:`${position}.000`, Unit:'EA',
    NetAmount:`${order+position}.00`, Currency:'CHF' };
}
function canonical(row) {
  const normalized={...row};
  for(const [field,scale] of [['Quantity',3],['NetAmount',2]]) {
    const [integer,fraction='']=row[field].split('.');
    normalized[field]=`${integer.replace(/^0+(?=\d)/,'')}.${fraction.padEnd(scale,'0')}`;
  }
  return fields.map(field=>normalized[field]).join('\t')+'\n';
}
function digest(rows) { const hash=createHash('sha256').update(prefix); for(const row of rows)hash.update(canonical(row),'utf8'); return hash.digest('hex'); }
const first=seedRow(1,1), second=seedRow(1,2), standardDigest=digest([first,second]);
const config={service_root:'http://fixture.invalid/odata/',sap_client:'001',expected_rows:2,expected_digest:standardDigest};
const page=(value,extra={})=>({status:200,url:'http://fixture.invalid/odata/OrderPositions',body_json:JSON.stringify({value,...extra})});
const cases=[];
function good(id,pages,rows=[first,second],overrides={}) {cases.push({id,config:{...config,expected_rows:rows.length,expected_digest:digest(rows),...overrides},pages,expected:{outcome:'ok',rows:rows.length,pages:pages.length,digest:digest(rows),error:null}});}
function bad(id,pages,code,rows=0,overrides={},index=pages.length,status=pages.at(-1)?.status??null) {cases.push({id,config:{...config,...overrides},pages,expected:{outcome:'error',rows,pages:pages.length,digest:null,error:{code,page_index:index,http_status:status}}});}
good('two_rows',[page([first,second])]);
good('empty',[page([])],[]);
good('decimal_normalization',[page([{...first,Quantity:'0001.0',NetAmount:'0002'},second])]);
good('unknown_properties',[page([{...first,Ignored:{anything:true}},second],{'@odata.context':'ignored'})]);
for(const [id,link] of [['query','?cursor=two'],['relative','OrderPositions?cursor=two'],['root','/odata/OrderPositions?cursor=two'],['absolute','http://fixture.invalid/odata/OrderPositions?cursor=two']]) good(`next_${id}`,[page([first],{'@odata.nextLink':link}),page([second])]);
good('empty_middle_page',[page([first],{'@odata.nextLink':'?cursor=two'}),page([],{'@odata.nextLink':'?cursor=three'}),page([second])]);
good('next_encoded_dot_name',[page([first],{'@odata.nextLink':'Order%2ePositions?cursor=two'}),page([second])]);
good('leap_day',[page([{...first,OrderDate:'2000-02-29'}])],[{...first,OrderDate:'2000-02-29'}]);
for(const [id,field,value] of [['decimal_number','Quantity',1],['null','CustomerId',null],['quantity_scale','Quantity','1.0000'],['amount_scale','NetAmount','2.000'],['decimal_exponent','Quantity','1e0'],['negative','NetAmount','-1.00'],['quantity_overflow','Quantity','10000000000.000'],['amount_overflow','NetAmount','10000000000000.00'],['invalid_date','OrderDate','2026-02-30'],['century_nonleap','OrderDate','1900-02-29'],['bad_position','PositionNumber','10'],['tab_identifier','OrderId','A\tB'],['nonascii','MaterialId','Mä'],['currency','Currency','chf']])bad(`schema_${id}`,[page([{...first,[field]:value}])],'SCHEMA');
const missing={...first};delete missing.Unit;bad('schema_missing',[page([missing])],'SCHEMA');
for(const field of fields)bad(`schema_trailing_newline_${field}`,[page([{...first,[field]:first[field]+'\n'}])],'SCHEMA');
bad('schema_envelope',[{...page([]),body_json:'{"value":{}}'}],'SCHEMA');
bad('schema_json',[{...page([]),body_json:'{"value":['}],'SCHEMA');
bad('order_duplicate',[page([first,first])],'ORDER',1);
bad('order_descending',[page([second,first])],'ORDER',1);
bad('order_across_pages',[page([second],{'@odata.nextLink':'?cursor=two'}),page([first])],'ORDER',1);
for(const [id,link] of [['foreign_origin','http://other.invalid/odata/OrderPositions'],['outside_root','http://fixture.invalid/other/OrderPositions'],['protocol_relative','//fixture.invalid/odata/OrderPositions'],['userinfo','http://user:example@fixture.invalid/odata/OrderPositions'],['fragment','?cursor=two#fragment'],['client','?sap-client=002'],['duplicate_client','?sap-client=001&sap-client=002'],['encoded_traversal','/odata/%2e%2e/private'],['empty','']])bad(`nextlink_${id}`,[page([first],{'@odata.nextLink':link})],'NEXTLINK',1);
bad('nextlink_wrong_type',[page([first],{'@odata.nextLink':null})],'SCHEMA',0);
bad('nextlink_empty_userinfo',[page([first],{'@odata.nextLink':'http://@fixture.invalid/odata/OrderPositions'})],'NEXTLINK',1);
bad('nextlink_whitespace_protocol_relative',[page([first],{'@odata.nextLink':' //fixture.invalid/odata/OrderPositions'})],'NEXTLINK',1);
bad('nextlink_raw_space',[page([first],{'@odata.nextLink':'Order Positions?cursor=two'})],'NEXTLINK',1);
bad('nextlink_raw_nonascii',[page([first],{'@odata.nextLink':'OrderPösitions?cursor=two'})],'NEXTLINK',1);
bad('http_401',[{...page([]),status:401,body_json:'not JSON'}],'HTTP_STATUS');
bad('http_redirect',[{...page([]),status:302}],'HTTP_STATUS');
bad('count_mismatch',[page([first])],'COUNT',1);
bad('digest_mismatch',[page([first,second])],'DIGEST',2,{expected_digest:'0'.repeat(64)});
bad('body_limit',[page([first,second])],'LIMIT',0,{max_body_bytes:16});
const limited=page([first],{'@odata.nextLink':'?cursor=two'});
bad('page_limit',[limited],'LIMIT',1,{max_pages:1},2,null);
bad('page_cycle',[page([first],{'@odata.nextLink':'?cursor=two'}),page([second],{'@odata.nextLink':'?cursor=two'})],'LIMIT',2);
for(const [id,overrides] of [['negative_rows',{expected_rows:-1}],['string_rows',{expected_rows:'2'}],['zero_timeout',{request_timeout_seconds:0}],['fractional_interval',{interval_ms:1.5}],['bad_digest',{expected_digest:'BAD'}],['root_fragment',{service_root:'http://fixture.invalid/odata/#x'}]])bad(`config_${id}`,[],'CONFIG',0,overrides,0,null);
bad('config_root_leading_space',[],'CONFIG',0,{service_root:' http://fixture.invalid/odata/'},0,null);
const rows=Array.from({length:1000},(_,order)=>Array.from({length:5},(_,position)=>seedRow(order+1,position+1))).flat();
const manifest={schema_version:1,dataset_id:'seed-v1-h1000-p5',headers:1000,positions_per_header:5,expected_rows:5000,expected_digest:digest(rows),digest_algorithm:'sha256-canonical-tsv-v1',unit:'EA',fields};
mkdirSync(resolve(root,'contracts'),{recursive:true});
writeFileSync(resolve(root,'contracts/fixtures.json'),JSON.stringify({schema_version:1,cases},null,2)+'\n');
writeFileSync(resolve(root,'contracts/seed-manifest.json'),JSON.stringify(manifest,null,2)+'\n');
writeFileSync(resolve(root,'contracts/canonical-example.tsv'),prefix+canonical(first)+canonical(second));
console.log(JSON.stringify({cases:cases.length,manifest},null,2));
