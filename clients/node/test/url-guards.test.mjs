import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeConfig, nextUrl } from '../src/poller.mjs';

const input = { service_root: 'http://fixture.invalid/odata/', expected_rows: 0, expected_digest: '0'.repeat(64) };

test('raw continuation checks reject empty userinfo and whitespace before protocol-relative URLs', () => {
  const config = normalizeConfig(input);
  for (const reference of ['http://@fixture.invalid/odata/x', ' http://@fixture.invalid/odata/x', ' //fixture.invalid/odata/x']) {
    assert.throws(() => nextUrl(reference, `${input.service_root}OrderPositions`, config), error => error.code === 'NEXTLINK');
  }
});

test('service root checks reject empty userinfo, empty query/fragment, and trailing whitespace', () => {
  for (const service_root of ['http://@fixture.invalid/odata/', `${input.service_root}?`, `${input.service_root}#`, `${input.service_root} `]) {
    assert.throws(() => normalizeConfig({ ...input, service_root }), error => error.code === 'CONFIG');
  }
});
