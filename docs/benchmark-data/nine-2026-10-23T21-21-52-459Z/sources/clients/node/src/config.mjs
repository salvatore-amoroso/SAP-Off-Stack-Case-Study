export function liveConfig(file = {}) {
  const env = process.env;
  const config = { ...file };
  for (const [environment, field] of Object.entries({ SAP_SERVICE_ROOT: 'service_root', SAP_CLIENT: 'sap_client', EXPECTED_DIGEST: 'expected_digest' })) if (env[environment] !== undefined) config[field] = env[environment];
  for (const [environment, field] of Object.entries({ EXPECTED_ROWS: 'expected_rows', SCANS: 'scans', POLL_INTERVAL_MS: 'interval_ms', REQUEST_TIMEOUT_SECONDS: 'request_timeout_seconds', SCAN_TIMEOUT_SECONDS: 'scan_timeout_seconds', PAGE_SIZE: 'page_size', MAX_BODY_BYTES: 'max_body_bytes', MAX_PAGES: 'max_pages' })) if (env[environment] !== undefined) config[field] = /^\d+$/.test(env[environment]) ? Number(env[environment]) : NaN;
  if (env.SAP_TLS_INSECURE !== undefined) config.tls_insecure = env.SAP_TLS_INSECURE === 'true' ? true : env.SAP_TLS_INSECURE === 'false' ? false : 'invalid';
  return config;
}
