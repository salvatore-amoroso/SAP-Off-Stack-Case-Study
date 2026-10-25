import { basename, extname, isAbsolute } from 'node:path';
const textTypes = new Set(['.mjs', '.js', '.rs', '.c', '.cpp', '.h', '.hpp', '.json', '.toml', '.lock', '.md', '.txt', '.log', '.tap', '.ndjson', '.xml', '.abap', '.asddls', '.baseinfo', '.srvdsrv', '.sql', '.yaml', '.yml', '.py', '.ps1', '.tsv', '.csv', '.sha256', '.svg']);
const publicNames = new Set(['.env.example', '.gitignore', '.dockerignore', '.gitattributes', '.node-version']);
const privateNames = /^(?:\.env(?:\..*)?|runtime\.json|\.npmrc|\.pypirc|\.netrc|(?:id_rsa|id_ed25519)(?:\.pub)?|credentials(?:\.json)?|(?:\.odbc|odbc)\.ini|SAPCAR.*)$/i;
const binaryExtension = /\.(?:sar|so(?:\.\d+)*|dll|exe|dylib|pse|pfx|p12|pem|key|zip|tar|gz|7z)$/i;
export function assertEvidenceSafe(path, bytes, { secrets = [], allowImages = false } = {}) {
  if (typeof path !== 'string' || !path || isAbsolute(path) || path.split(/[\\/]/).includes('..')) throw new Error('PROJECT_RELATIVE_EVIDENCE_REQUIRED');
  const name = basename(path.replaceAll('\\', '/'));
  if (binaryExtension.test(name) || (!publicNames.has(name) && privateNames.test(name))) throw new Error('EXCLUDED_CREDENTIAL_OR_BINARY_FILE');
  if (secrets.filter(Boolean).some(secret => bytes.includes(Buffer.from(secret)))) throw new Error('CONFIGURED_CREDENTIAL_IN_EVIDENCE');
  const text = bytes.toString('utf8');
  if (/-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY-----|gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,}|AKIA[A-Z0-9]{16}/.test(text)) throw new Error('PRIVATE_KEY_OR_TOKEN_IN_EVIDENCE');
  if (allowImages && name.endsWith('.png') && bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) return;
  if (bytes.includes(0)) throw new Error('BINARY_EVIDENCE_REFUSED');
  if (!textTypes.has(extname(name)) && !publicNames.has(name) && !/^Dockerfile(?:\.[\w-]+)?$/.test(name)) throw new Error('UNSUPPORTED_EVIDENCE_TYPE');
}
