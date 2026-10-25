import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';

export const fields = ['OrderId', 'PositionNumber', 'CustomerId', 'OrderDate', 'MaterialId', 'Quantity', 'Unit', 'NetAmount', 'Currency'];
const defaults = { sap_client: '001', scans: 1, interval_ms: 1000, request_timeout_seconds: 10, scan_timeout_seconds: 120, page_size: 500, max_body_bytes: 8388608, max_pages: 10000 };
const terminalCodes = new Set(['CONFIG', 'SCHEMA', 'ORDER', 'NEXTLINK', 'LIMIT', 'COUNT', 'DIGEST']);

export class PollError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}
const fail = (code, message) => { throw new PollError(code, message); };

function unsafePath(reference) {
  let path = reference.split(/[?#]/, 1)[0];
  path = path.replace(/^[a-z][a-z0-9+.-]*:\/\/[^/]*/i, '');
  return /%(?:2f|5c)/i.test(path) || path.split('/').some(segment => /%2e/i.test(segment) && /^(?:\.|%2e){1,2}$/i.test(segment));
}

function hasUserInfo(reference) {
  const authority = reference.trimStart().match(/^[a-z][a-z0-9+.-]*:\/\/([^/?#]*)/i)?.[1];
  return authority?.includes('@') ?? false;
}

export function normalizeConfig(input) {
  const config = { ...defaults, ...input };
  if (typeof config.service_root !== 'string' || /[^\x21-\x7e]/.test(config.service_root)) fail('CONFIG', 'service_root must be an ASCII URI without raw spaces');
  let root;
  try { root = new URL(config.service_root); } catch { fail('CONFIG', 'service_root must be an absolute URL'); }
  if (!['http:', 'https:'].includes(root.protocol) || root.username || root.password || root.hash || root.search || !config.service_root.endsWith('/') || config.service_root.includes('?') || config.service_root.includes('#') || hasUserInfo(config.service_root) || unsafePath(config.service_root) || /[\\\u0000-\u001f\u007f]/.test(config.service_root)) {
    fail('CONFIG', 'service_root must be an HTTP(S) service directory without credentials, query, or fragment');
  }
  if (typeof config.sap_client !== 'string' || !/^\d{3}$/.test(config.sap_client)) fail('CONFIG', 'sap_client must contain three digits');
  if (typeof config.expected_digest !== 'string' || !/^[a-f0-9]{64}$/.test(config.expected_digest)) fail('CONFIG', 'expected_digest must be lowercase SHA-256');
  const bounds = { expected_rows: [0, 2147483647], scans: [1, 1000000], interval_ms: [1, 3600000], request_timeout_seconds: [1, 3600], scan_timeout_seconds: [1, 86400], page_size: [1, 10000], max_body_bytes: [1, 67108864], max_pages: [1, 1000000] };
  for (const [key, [minimum, maximum]] of Object.entries(bounds)) {
    if (!Number.isSafeInteger(config[key]) || config[key] < minimum || config[key] > maximum) fail('CONFIG', `${key} is outside contract bounds`);
  }
  if (config.tls_insecure !== undefined && typeof config.tls_insecure !== 'boolean') fail('CONFIG', 'tls_insecure must be boolean');
  config.service_root = root.href;
  return config;
}

export function initialUrl(config) {
  const url = new URL('OrderPositions', config.service_root);
  url.searchParams.set('$select', fields.join(','));
  url.searchParams.set('$orderby', 'OrderId,PositionNumber');
  url.searchParams.set('sap-client', config.sap_client);
  return url.href;
}

export function nextUrl(reference, responseUrl, config) {
  if (typeof reference !== 'string' || !reference || /[^\x21-\x7e]/.test(reference) || reference.startsWith('//') || hasUserInfo(reference) || /[\\\u0000-\u001f\u007f]/.test(reference) || reference.includes('#') || unsafePath(reference)) fail('NEXTLINK', 'Unsafe continuation reference');
  let url;
  try { url = new URL(reference, responseUrl); } catch { fail('NEXTLINK', 'Invalid continuation URL'); }
  const root = new URL(config.service_root);
  if (url.origin !== root.origin || !url.pathname.startsWith(root.pathname) || url.username || url.password || url.hash) fail('NEXTLINK', 'Continuation is outside the service root');
  if (url.searchParams.getAll('sap-client').some(client => client !== config.sap_client)) fail('NEXTLINK', 'Continuation changes SAP client');
  return url.href;
}

function decimal(value, scale, integerDigits) {
  if (!/^\d+(?:\.\d+)?$/.test(value)) fail('SCHEMA', 'Invalid decimal');
  const [rawInteger, fraction = ''] = value.split('.');
  const integer = rawInteger.replace(/^0+(?=\d)/, '');
  if (fraction.length > scale || integer.length > integerDigits) fail('SCHEMA', 'Decimal exceeds scale or precision');
  return `${integer}.${fraction.padEnd(scale, '0')}`;
}

function validDate(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;
  const [year, month, day] = match.slice(1).map(Number);
  if (year < 1 || month < 1 || month > 12 || day < 1) return false;
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  return day <= [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1];
}

export function normalizeRow(row) {
  if (!row || typeof row !== 'object' || Array.isArray(row) || fields.some(field => typeof row[field] !== 'string')) fail('SCHEMA', 'Selected row fields must be strings');
  const patterns = { OrderId: /^[A-Za-z0-9_-]{1,20}$/, PositionNumber: /^\d{6}$/, CustomerId: /^[A-Za-z0-9_-]{1,10}$/, MaterialId: /^[A-Za-z0-9_-]{1,18}$/, Unit: /^[A-Z]{1,3}$/, Currency: /^[A-Z]{3}$/ };
  for (const [field, pattern] of Object.entries(patterns)) if (!pattern.test(row[field])) fail('SCHEMA', `Invalid ${field}`);
  if (!validDate(row.OrderDate)) fail('SCHEMA', 'Invalid OrderDate');
  return fields.map(field => field === 'Quantity' ? decimal(row[field], 3, 10) : field === 'NetAmount' ? decimal(row[field], 2, 13) : row[field]);
}

export function createRowAccumulator(profile = null, { hashing = true } = {}) {
  const hashStarted = profile ? performance.now() : 0;
  const hash = hashing ? createHash('sha256').update('sap-polling-lab\t1\n', 'utf8') : null;
  if (profile && hashing) profile.hashing_ms += performance.now() - hashStarted;
  let previous = null;
  return {
    rows: 0,
    add(row, project) {
      const validationStarted = profile ? performance.now() : 0;
      const normalized = normalizeRow(project ? project(row) : row);
      const key = [normalized[0], normalized[1]];
      if (previous && (key[0] < previous[0] || (key[0] === previous[0] && key[1] <= previous[1]))) fail('ORDER', 'Nonascending composite key');
      const hashingStarted = profile ? performance.now() : 0;
      if (profile) profile.validation_ms += hashingStarted - validationStarted;
      if (hashing) hash.update(`${normalized.join('\t')}\n`, 'utf8');
      if (profile && hashing) profile.hashing_ms += performance.now() - hashingStarted;
      previous = key;
      this.rows++;
    },
    finish(expectedRows, expectedDigest, checkDeadline = () => {}) {
      if (this.rows !== expectedRows) fail('COUNT', 'Final row count differs from manifest');
      const hashingStarted = profile ? performance.now() : 0;
      const digest = hashing ? hash.digest('hex') : null;
      if (profile && hashing) profile.hashing_ms += performance.now() - hashingStarted;
      checkDeadline();
      if (hashing && digest !== expectedDigest) fail('DIGEST', 'Final digest differs from manifest');
      checkDeadline();
      return digest;
    },
  };
}

async function responseBytes(response, maximum, signal, onBytes, discardBody = false) {
  const length = response.headers?.get?.('content-length');
  let oversized = Boolean(length && /^\d+$/.test(length) && BigInt(length) > BigInt(maximum));
  const chunks = [];
  let total = 0;
  if (response.body) {
    const reader = response.body.getReader();
    try {
      while (true) {
        if (signal.aborted) fail('TIMEOUT', 'Request deadline exceeded');
        const { value, done } = await reader.read();
        if (done) break;
        const bytes = Buffer.from(value);
        total += bytes.length;
        onBytes(bytes.length);
        if (total > maximum) oversized = true;
        if (oversized || discardBody) chunks.length = 0;
        else chunks.push(bytes);
      }
    } finally {
      if (total > maximum || signal.aborted) await reader.cancel().catch(() => {});
      reader.releaseLock();
    }
  }
  // All runtimes decide the acceptance limit after complete receipt; a stalled
  // oversized transfer is TIMEOUT, including on ABAP's buffered HTTP client.
  if (discardBody) return Buffer.alloc(0);
  if (oversized) fail('LIMIT', 'Response exceeds body limit');
  return Buffer.concat(chunks, total);
}

function timed(promise, signal) {
  if (signal.aborted) return Promise.reject(new PollError('TIMEOUT', 'Deadline exceeded'));
  let listener;
  const aborted = new Promise((_, reject) => {
    listener = () => reject(new PollError('TIMEOUT', 'Deadline exceeded'));
    signal.addEventListener('abort', listener, { once: true });
  });
  return Promise.race([promise, aborted]).finally(() => signal.removeEventListener('abort', listener));
}

export async function scan(input, fetcher = globalThis.fetch, scanIndex = 0) {
  const started = performance.now();
  const result = { schema_version: 1, scan_index: scanIndex, outcome: 'error', rows: 0, pages: 0, digest: null, error: null, metrics: { elapsed_ms: 0, body_bytes: 0, missed_slots: 0 } };
  let pageIndex = 0;
  let status = null;
  let config;
  try {
    config = normalizeConfig(input);
    const accumulator = createRowAccumulator();
    const visited = new Set();
    let url = initialUrl(config);
    const scanDeadline = started + config.scan_timeout_seconds * 1000;
    const checkDeadline = () => { if (performance.now() >= scanDeadline) fail('TIMEOUT', 'Scan deadline exceeded'); };
    while (url !== null) {
      pageIndex = result.pages + 1;
      status = null;
      checkDeadline();
      if (result.pages >= config.max_pages) fail('LIMIT', 'Page limit exceeded');
      visited.add(url);
      result.pages++;
      const controller = new AbortController();
      const requestBudget = Math.min(config.request_timeout_seconds * 1000, scanDeadline - performance.now());
      const requestDeadline = performance.now() + requestBudget;
      const timer = setTimeout(() => controller.abort(), Math.max(1, requestBudget));
      let response;
      let body;
      try {
        response = await timed(Promise.resolve().then(() => fetcher(url, {
          method: 'GET', redirect: 'manual', credentials: 'omit', signal: controller.signal,
          headers: { Accept: 'application/json;odata.metadata=minimal;IEEE754Compatible=true', Prefer: `odata.maxpagesize=${config.page_size}`, 'Accept-Encoding': 'identity' },
        })), controller.signal);
        status = response.status;
        body = await timed(responseBytes(response, config.max_body_bytes, controller.signal, count => { result.metrics.body_bytes += count; }, status !== 200), controller.signal);
        if (controller.signal.aborted || performance.now() >= requestDeadline) fail('TIMEOUT', 'Request deadline exceeded');
        if (status !== 200) fail('HTTP_STATUS', 'HTTP response was not 200');
      } catch (error) {
        if (response?.body && !response.body.locked) await response.body.cancel().catch(() => {});
        if (error instanceof PollError) throw error;
        if (controller.signal.aborted || error?.name === 'AbortError' || error?.name === 'TimeoutError') fail('TIMEOUT', 'Request deadline exceeded');
        fail('TRANSPORT', 'HTTP transport failed');
      } finally { clearTimeout(timer); }
      checkDeadline();
      let envelope;
      try { envelope = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(body)); } catch { fail('SCHEMA', 'Invalid UTF-8 or JSON'); }
      if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope) || !Array.isArray(envelope.value)) fail('SCHEMA', 'Invalid OData envelope');
      if (Object.hasOwn(envelope, '@odata.nextLink') && typeof envelope['@odata.nextLink'] !== 'string') fail('SCHEMA', 'Continuation must be a string');
      for (const row of envelope.value) {
        checkDeadline();
        accumulator.add(row);
        result.rows++;
      }
      checkDeadline();
      url = Object.hasOwn(envelope, '@odata.nextLink') ? nextUrl(envelope['@odata.nextLink'], response.url || url, config) : null;
      if (url !== null && visited.has(url)) fail('LIMIT', 'Continuation URL cycle');
      checkDeadline();
    }
    const digest = accumulator.finish(config.expected_rows, config.expected_digest, checkDeadline);
    result.outcome = 'ok';
    result.digest = digest;
  } catch (error) {
    const code = error instanceof PollError ? error.code : 'SCHEMA';
    result.error = { code, page_index: pageIndex, http_status: ['TIMEOUT', 'TRANSPORT'].includes(code) ? null : status };
  }
  result.metrics.elapsed_ms = performance.now() - started;
  return result;
}

export function terminal(result) {
  return result.error && (terminalCodes.has(result.error.code) || (result.error.code === 'HTTP_STATUS' && [400, 401, 403, 404].includes(result.error.http_status)));
}

export async function run(input, fetcher, emit = result => process.stdout.write(`${JSON.stringify(result)}\n`)) {
  let config;
  try { config = normalizeConfig(input); } catch {
    const result = await scan(input, fetcher);
    emit(result);
    return 2;
  }
  const origin = performance.now();
  let slot = 0;
  let exitCode = 0;
  for (let index = 0; index < config.scans; index++) {
    const result = await scan(config, fetcher, index);
    const nextSlot = Math.max(slot + 1, Math.floor((performance.now() - origin) / config.interval_ms) + 1);
    result.metrics.missed_slots = nextSlot - slot - 1;
    emit(result);
    if (result.outcome !== 'ok') exitCode = result.error.code === 'CONFIG' ? 2 : 1;
    if (terminal(result) || index + 1 === config.scans) break;
    slot = nextSlot;
    const delay = origin + slot * config.interval_ms - performance.now();
    if (delay > 0) await new Promise(resolve => setTimeout(resolve, delay));
  }
  return exitCode;
}
