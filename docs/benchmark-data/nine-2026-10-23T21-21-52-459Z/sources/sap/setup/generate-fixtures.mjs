import { readFileSync, writeFileSync } from 'node:fs';

const fixtures = JSON.parse(readFileSync(new URL('../../contracts/fixtures.json', import.meta.url), 'utf8'));
const literal = value => '`' + value.replaceAll('`', '``') + '`';
const expression = value => {
  const chunks = [];
  for (let offset = 0; offset < value.length; offset += 120) chunks.push(literal(value.slice(offset, offset + 120)));
  return chunks.length ? chunks.join(' &&\n      ') : '``';
};
const prelude = (name, generated) => [
  `* ${generated}`,
  `CLASS ${name} DEFINITION PUBLIC FINAL CREATE PUBLIC.`,
  ' PUBLIC SECTION.', '  INTERFACES if_oo_adt_classrun.', 'ENDCLASS.',
  `CLASS ${name} IMPLEMENTATION.`, ' METHOD if_oo_adt_classrun~main.',
  '  DATA(poller) = NEW zcl_bl_poll_orders( ).',
  '  DATA result TYPE zcl_bl_poll_orders=>ty_result.',
  '  DATA passed TYPE i.', '  DATA ok TYPE abap_bool.', '  DATA line TYPE string.'
];
const comparison = (fixture, lines) => {
  const expected = fixture.expected;
  lines.push(`  ok = xsdbool( result-outcome = ${literal(expected.outcome)} AND result-rows = ${expected.rows}`);
  lines.push(`    AND result-pages = ${expected.pages} AND result-digest = ${literal(expected.digest ?? '')}`);
  lines.push(`    AND result-error-code = ${literal(expected.error?.code ?? '')}`);
  lines.push(`    AND result-error-page_index = ${expected.error?.page_index ?? 0} AND result-error-http_status = ${expected.error?.http_status ?? 0} ).`);
  lines.push('  IF ok = abap_true. passed += 1. ENDIF.');
  lines.push(`  line = ${literal('{"id":' + JSON.stringify(fixture.id) + ',"passed":')} && COND string( WHEN ok = abap_true THEN 'true' ELSE 'false' )`);
  lines.push(`    && ',"result":' && zcl_bl_poll_orders=>to_json( result ) && '}'.`);
  lines.push('  out->write( line ).');
};
const finish = (name, count, lines) => {
  lines.push(`  out->write( '{"fixture_count":${count},"passed":' && |{ passed NUMBER = RAW }| && '}' ).`);
  lines.push(' ENDMETHOD.', 'ENDCLASS.');
  const source = lines.join('\n') + '\n';
  if (source.split('\n').some(line => line.length > 255)) throw new Error('ABAP source line exceeds 255 characters');
  writeFileSync(new URL(`../src/${name}.clas.abap`, import.meta.url), source);
  console.log(`Generated ${count} cases in ${name}.`);
};

const offline = prelude('zcl_bl_test_orders', 'Generated from contracts/fixtures.json; run sap/setup/generate-fixtures.mjs.');
offline.push('  DATA pages TYPE zcl_bl_poll_orders=>tt_pages.', '  DATA config_json TYPE string.');
for (const fixture of fixtures.cases) {
  offline.push('  CLEAR pages.', '  config_json = ' + expression(JSON.stringify(fixture.config)) + '.');
  for (const page of fixture.pages) {
    offline.push(`  APPEND VALUE #( status = ${page.status} url = ${literal(page.url)}`);
    offline.push('    body_json = ' + expression(page.body_json) + ' ) TO pages.');
  }
  offline.push('  result = poller->fixture( config_json = config_json pages = pages ).');
  comparison(fixture, offline);
}
finish('zcl_bl_test_orders', fixtures.cases.length, offline);

const option = process.argv.find(value => value.startsWith('--http-origin='));
if (option) {
  const value = option.slice('--http-origin='.length);
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new Error('--http-origin must be an HTTP(S) origin without credentials, path, query or fragment');
  }
  const scenarios = JSON.parse(readFileSync(new URL('../../contracts/http-scenarios.json', import.meta.url), 'utf8'));
  const cases = [...fixtures.cases.filter(fixture => !fixture.id.startsWith('config_')), ...scenarios.cases];
  const http = prelude('zcl_bl_test_http', 'Generated from contracts/fixtures.json and contracts/http-scenarios.json.');
  http.push('  DATA config TYPE zcl_bl_poll_orders=>ty_config.');
  for (const fixture of cases) {
    if (!/^[A-Za-z0-9_-]+$/.test(fixture.id)) throw new Error('Unsafe fixture identifier');
    http.push('  config = zcl_bl_poll_orders=>defaults( ).');
    http.push(`  config-service_root = ${literal(url.origin + '/' + fixture.id + '/odata/')}.`);
    for (const [field, setting] of Object.entries(fixture.config)) {
      if (field === 'service_root') continue;
      if (!/^[a-z_]+$/.test(field)) throw new Error('Unsafe configuration field');
      if (typeof setting !== 'string' && !Number.isSafeInteger(setting)) throw new Error('HTTP fixture has invalid typed configuration');
      http.push(`  config-${field} = ${typeof setting === 'string' ? literal(setting) : setting}.`);
    }
    http.push('  result = poller->scan( config = config ).');
    comparison(fixture, http);
  }
  finish('zcl_bl_test_http', cases.length, http);
}
