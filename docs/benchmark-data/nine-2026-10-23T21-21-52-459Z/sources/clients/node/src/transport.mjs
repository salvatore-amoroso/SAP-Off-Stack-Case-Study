import { Agent } from 'undici';
import { normalizeConfig } from './poller.mjs';

export async function createLiveFetcher(input, username, password) {
  const config = normalizeConfig(input);
  if ((username === undefined) !== (password === undefined)) throw new Error('Both credentials are required');
  const root = new URL(config.service_root);
  const dispatcher = new Agent({ connections: 1, pipelining: 1, connect: { rejectUnauthorized: !config.tls_insecure } });
  const authorization = username === undefined ? {} : { Authorization: `Basic ${Buffer.from(`${username}:${password}`, 'utf8').toString('base64')}` };
  return {
    fetch: (url, options) => {
      const target = new URL(url);
      if (target.origin !== root.origin || !target.pathname.startsWith(root.pathname) || target.username || target.password) throw new Error('Request is outside configured service');
      return globalThis.fetch(url, { ...options, dispatcher, headers: { ...options.headers, ...authorization } });
    },
    close: () => dispatcher.close(),
  };
}
