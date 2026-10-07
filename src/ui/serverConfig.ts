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

const API_TOKEN: string | undefined = readEnvString(import.meta.env['VITE_LLULL_API_TOKEN']);

/** `Authorization` header for REST mutations; empty when no token is configured. */
export function serverAuthHeaders(): Record<string, string> {
  return API_TOKEN === undefined ? {} : { Authorization: `Bearer ${API_TOKEN}` };
}

/** `/live` SSE URL; carries `?access_token=` when a token is set (EventSource cannot send headers). */
export function liveStreamUrl(): string {
  const base = `${SERVER_BASE}/live`;
  return API_TOKEN === undefined ? base : `${base}?access_token=${encodeURIComponent(API_TOKEN)}`;
}
