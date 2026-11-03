import type { FetchLike } from './GitHubClient.ts';

/**
 * Minimum scope for this app with a classic OAuth App: `repo` (private repositories; includes creating repos
 * via POST /user/repos). Use `public_repo` if you only ever use public repositories. A GitHub App with
 * fine-grained "Contents: read & write" (+ "Administration: write" only if the app should create repos)
 * is narrower and preferred where possible.
 */
export const REQUIRED_SCOPE = 'repo';

export class OAuthError extends Error {
  code: string;
  constructor(code: string, message?: string) {
    super(message || code);
    this.name = 'OAuthError';
    this.code = code;
  }
}

async function postForm(f: FetchLike, url: string, params: Record<string, string>): Promise<Record<string, unknown>> {
  const res = await f(url, {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params).toString(),
  });
  if (!res.ok) throw new OAuthError('http_' + res.status, `GitHub OAuth endpoint returned ${res.status}`);
  return (await res.json()) as Record<string, unknown>;
}

// ----- Web application flow (uses GITHUB_CLIENT_SECRET + GITHUB_CALLBACK_URL; server-side only) -----
export function buildAuthorizeUrl(a: { clientId: string; redirectUri: string; state: string; scope?: string }): string {
  const u = new URL('https://github.com/login/oauth/authorize');
  u.searchParams.set('client_id', a.clientId);
  u.searchParams.set('redirect_uri', a.redirectUri);
  u.searchParams.set('state', a.state); // caller must verify on callback (CSRF)
  u.searchParams.set('scope', a.scope ?? REQUIRED_SCOPE);
  return u.toString();
}

export async function exchangeCode(
  a: { clientId: string; clientSecret: string; code: string; redirectUri: string }, f: FetchLike = fetch,
): Promise<string> {
  const r = await postForm(f, 'https://github.com/login/oauth/access_token', {
    client_id: a.clientId, client_secret: a.clientSecret, code: a.code, redirect_uri: a.redirectUri,
  });
  if (typeof r.access_token !== 'string') throw new OAuthError(String(r.error ?? 'no_token'), String(r.error_description ?? ''));
  return r.access_token;
}

// ----- Device flow (no client secret needed; good for CLI/experiments) -----
export interface DeviceCode {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  expiresIn: number;
  interval: number;
}

export async function startDeviceFlow(clientId: string, scope = REQUIRED_SCOPE, f: FetchLike = fetch): Promise<DeviceCode> {
  const r = await postForm(f, 'https://github.com/login/device/code', { client_id: clientId, scope });
  if (typeof r.device_code !== 'string') throw new OAuthError(String(r.error ?? 'device_flow_failed'));
  return {
    deviceCode: r.device_code, userCode: String(r.user_code), verificationUri: String(r.verification_uri),
    expiresIn: Number(r.expires_in), interval: Number(r.interval ?? 5),
  };
}

export async function pollDeviceFlow(
  clientId: string, dc: DeviceCode,
  deps: { fetch?: FetchLike; sleep?: (ms: number) => Promise<void> } = {},
): Promise<string> {
  const f = deps.fetch ?? fetch;
  const sleep = deps.sleep ?? ((ms) => new Promise<void>((r) => setTimeout(r, ms)));
  let interval = dc.interval;
  const deadline = Date.now() + dc.expiresIn * 1000;
  while (Date.now() < deadline) {
    await sleep(interval * 1000);
    const r = await postForm(f, 'https://github.com/login/oauth/access_token', {
      client_id: clientId, device_code: dc.deviceCode, grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
    });
    if (typeof r.access_token === 'string') return r.access_token;
    if (r.error === 'authorization_pending') continue;
    if (r.error === 'slow_down') { interval += 5; continue; }
    throw new OAuthError(String(r.error ?? 'unknown'), String(r.error_description ?? ''));
  }
  throw new OAuthError('expired_token', 'Device code expired before authorisation');
}
