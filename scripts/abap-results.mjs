// ADT class-run emits NDJSON; older saved checks used JSON arrays or { cases }.
export function parseCaseResults(text, { requireSummary = false } = {}) {
  const input = String(text).replace(/^\uFEFF/, '').trim();
  if (!input) throw new Error('Case results are empty');
  let records, summary = null;
  try {
    const document = JSON.parse(input);
    if (Array.isArray(document)) records = document;
    else if (Array.isArray(document?.cases)) {
      records = document.cases;
      if (document.fixture_count !== undefined) summary = { fixture_count: document.fixture_count, passed: document.passed };
    } else records = [document];
  } catch {
    try { records = input.split(/\r?\n/).filter(line => line.trim()).map(line => JSON.parse(line)); }
    catch { throw new Error('Case results must be JSON or one JSON record per line'); }
  }
  const cases = [], ids = new Set();
  for (const [index, record] of records.entries()) {
    if (record && record.fixture_count !== undefined && record.id === undefined) {
      if (summary || index !== records.length - 1) throw new Error('Case summary must occur once, after all cases');
      summary = record;
      continue;
    }
    if (!record || typeof record.id !== 'string' || !record.id || ids.has(record.id)) throw new Error('Case IDs must be present and unique');
    ids.add(record.id);
    if (record.passed !== undefined && typeof record.passed !== 'boolean') throw new Error('Case passed must be boolean');
    const { id, passed, ...flatResult } = record;
    const result = record.result ?? flatResult;
    if (!result || typeof result !== 'object' || Array.isArray(result)) throw new Error('Case result must be an object');
    cases.push({ id, ...(passed === undefined ? {} : { passed }), result });
  }
  if (!cases.length) throw new Error('Case results contain no cases');
  if (requireSummary && !summary) throw new Error('A final ABAP case summary is required');
  if (summary && (!Number.isSafeInteger(summary.fixture_count) || summary.fixture_count !== cases.length || !Number.isSafeInteger(summary.passed) || summary.passed < 0 || summary.passed > cases.length || cases.some(item => typeof item.passed !== 'boolean') || summary.passed !== cases.filter(item => item.passed).length)) throw new Error('Case summary does not reconcile with case records');
  return { cases, summary };
}

export function unitMethodCount(xml) {
  if (typeof xml !== 'string' || !/<(?:\w+:)?runResult(?:\s|>)/.test(xml) || !/<\/(?:\w+:)?runResult\s*>/.test(xml)) throw new Error('ABAP Unit runResult XML is required');
  if (/<(?:\w+:)?alert(?=[\s/>])/.test(xml)) throw new Error('ABAP Unit reported an alert');
  const count = (xml.match(/<(?:\w+:)?testMethod(?=[\s/>])/g) || []).length;
  if (!count) throw new Error('ABAP Unit reported no test methods');
  return count;
}
