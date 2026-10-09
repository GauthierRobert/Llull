/**
 * @layer ui
 * Build-time server configuration (Vite env, see `.env.example`).
 *
 * @invariant SERVER_BASE has no trailing slash
 * @invariant the token is embedded in the static bundle — use it only for deployments whose
 *            web app is itself access-controlled; it is required when the server runs with
 *            LLULL_REQUIRE_TOKEN_FOR_REST=true.
 */

const DEFAULT_SERVER_BASE = 'http://localhost:3001';

function readEnvString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

export const SERVER_BASE: string = (
  readEnvString(import.meta.env['VITE_LLULL_SERVER_URL']) ?? DEFAULT_SERVER_BASE
).replace(/\/+$/, '');

const BUILD_API_TOKEN: string | undefined = readEnvString(import.meta.env['VITE_LLULL_API_TOKEN']);
const TOKEN_STORAGE_KEY = 'llull.apiToken';

/**
 * Per-user token for named-user servers: `localStorage['llull.apiToken']`, set once by opening the
 * app at `/#token=<token>` (the fragment is stripped). Falls back to the build-time shared token.
 */
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

/** `Authorization` header for REST mutations; empty when no token is configured. */
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
