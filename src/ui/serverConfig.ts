// Build-time server config (Vite env, `.env.example`). @invariant SERVER_BASE has no trailing slash. The shared token is
// embedded in the bundle: only for access-controlled deployments; required with LLULL_REQUIRE_TOKEN_FOR_REST=true.

const DEFAULT_SERVER_BASE = 'http://localhost:3001';

function readEnvString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

/** `VITE_LLULL_SERVER_URL=same-origin`: the server serves this page (desktop app, on-prem image). */
const SAME_ORIGIN = 'same-origin';

function serverBaseOf(configured: string | undefined): string {
  if (configured !== SAME_ORIGIN) return configured ?? DEFAULT_SERVER_BASE;
  return typeof window === 'undefined' ? DEFAULT_SERVER_BASE : window.location.origin;
}

export const SERVER_BASE: string = serverBaseOf(readEnvString(import.meta.env['VITE_LLULL_SERVER_URL'])).replace(/\/+$/, '');

// WARNING: VITE_* values are inlined into the PUBLIC bundle; never set VITE_LLULL_API_TOKEN for a public deployment.
const BUILD_API_TOKEN: string | undefined = readEnvString(import.meta.env['VITE_LLULL_API_TOKEN']);
const TOKEN_STORAGE_KEY = 'llull.apiToken';

/** Per-user token `localStorage['llull.apiToken']`, set by opening `/#token=<token>` (fragment stripped); else the build-time token. */
function currentApiToken(): string | undefined {
  try {
    const fragment = /^#token=(.+)$/.exec(window.location.hash)?.[1];
    if (fragment !== undefined) {
      window.localStorage.setItem(TOKEN_STORAGE_KEY, decodeURIComponent(fragment));
      window.history.replaceState(null, '', window.location.pathname + window.location.search);
    }
    return readEnvString(window.localStorage.getItem(TOKEN_STORAGE_KEY)) ?? BUILD_API_TOKEN;
  } catch {
    return BUILD_API_TOKEN;
  }
}

/** Empty without a token. */
export function serverAuthHeaders(): Record<string, string> {
  const token = currentApiToken();
  return token === undefined ? {} : { Authorization: `Bearer ${token}` };
}

/** `/live` SSE URL; carries `?access_token=` when a token is set (EventSource cannot send headers). */
export function liveStreamUrl(): string {
  const base = `${SERVER_BASE}/live`;
  const token = currentApiToken();
  return token === undefined ? base : `${base}?access_token=${encodeURIComponent(token)}`;
}
