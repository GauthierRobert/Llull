// Where the renderer finds the local backend. @invariant SERVER_BASE has no trailing slash.
// Packaged desktop app: the backend serves this page, so its origin is the API base. `npm run dev` (Vite on :5173): the
// backend on loopback :3001. The per-launch bearer token arrives once as `#token=<token>` (desktop/src/main.ts).

const DEV_SERVER_BASE = 'http://localhost:3001';

export const SERVER_BASE: string = (
  import.meta.env.PROD && typeof window !== 'undefined' ? window.location.origin : DEV_SERVER_BASE
).replace(/\/+$/, '');

const TOKEN_STORAGE_KEY = 'llull.apiToken';

/** Token from `#token=<token>` (kept in `localStorage['llull.apiToken']`, fragment stripped so a reload keeps working). */
function currentApiToken(): string | undefined {
  try {
    const fragment = /^#token=(.+)$/.exec(window.location.hash)?.[1];
    if (fragment !== undefined) {
      window.localStorage.setItem(TOKEN_STORAGE_KEY, decodeURIComponent(fragment));
      window.history.replaceState(null, '', window.location.pathname + window.location.search);
    }
    const stored = window.localStorage.getItem(TOKEN_STORAGE_KEY)?.trim();
    return stored === undefined || stored === '' ? undefined : stored;
  } catch {
    return undefined;
  }
}

/** Empty without a token. */
export function serverAuthHeaders(): Record<string, string> {
  const token = currentApiToken();
  return token === undefined ? {} : { Authorization: `Bearer ${token}` };
}

/** Plain `/live` SSE URL (no credentials; with a token use `liveTicketStreamUrl`). */
export function liveStreamUrl(): string {
  return `${SERVER_BASE}/live`;
}

export const hasApiToken = (): boolean => currentApiToken() !== undefined;

/**
 * `/live` SSE URL carrying a fresh single-use `?ticket=` (EventSource cannot send headers; a bearer token in the URL would
 * leak into access logs). The ticket is minted over header auth; call again on every reconnect. Rejects when the mint fails.
 */
export async function liveTicketStreamUrl(): Promise<string> {
  const response = await fetch(`${SERVER_BASE}/live/ticket`, { method: 'POST', headers: serverAuthHeaders() });
  if (!response.ok) throw new Error(`live ticket request failed (${response.status})`);
  const body = (await response.json()) as { ticket?: unknown };
  if (typeof body.ticket !== 'string' || body.ticket === '') throw new Error('live ticket response malformed');
  return `${liveStreamUrl()}?ticket=${encodeURIComponent(body.ticket)}`;
}
