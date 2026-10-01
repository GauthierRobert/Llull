/**
 * @layer server
 *
 * HTTP hardening helpers for the non-MCP routes: origin allowlist, mutation guard,
 * filename sanitizer, JSON error handler. No business logic (architecture L6).
 */

import crypto from 'crypto';
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import rateLimit from 'express-rate-limit';

export const DEFAULT_ALLOWED_ORIGINS: readonly string[] = [
  'http://localhost:5173',
  'http://localhost:5174',
  'http://localhost:3000',
];

/** Origins allowed to call the server from a browser. `LLULL_ALLOWED_ORIGINS` = comma-separated. */
export function getAllowedOrigins(): string[] {
  const raw = process.env['LLULL_ALLOWED_ORIGINS'];
  if (raw === undefined || raw.trim() === '') return [...DEFAULT_ALLOWED_ORIGINS];
  return raw
    .split(',')
    .map((origin) => origin.trim())
    .filter((origin) => origin.length > 0);
}

const sha256 = (value: string): Buffer => crypto.createHash('sha256').update(value).digest();

/** Constant-time `Authorization: Bearer <token>` check (digest compare: no length leak; scheme case-insensitive). */
export function hasValidBearer(req: Request, token: string): boolean {
  const header = req.headers['authorization'];
  if (typeof header !== 'string') return false;
  const match = /^bearer +(.+)$/i.exec(header);
  const presented = match?.[1];
  if (presented === undefined) return false;
  return crypto.timingSafeEqual(sha256(presented), sha256(token));
}

/** True for 127.0.0.0/8, ::1, ::ffff:127.*, and `localhost`. */
export function isLoopbackAddress(address: string | undefined): boolean {
  if (address === undefined) return false;
  const value = address.toLowerCase();
  return (
    value === 'localhost' ||
    value === '::1' ||
    value.startsWith('127.') ||
    value.startsWith('::ffff:127.')
  );
}

/**
 * Startup safety: a non-loopback `HOST` without `MCP_AUTH_TOKEN` exposes an unauthenticated
 * document-mutating API to the network. Returns an error message to refuse startup, or null.
 * Opt out with `LLULL_ALLOW_UNAUTHENTICATED=true`.
 */
export function checkBindSafety(host: string, env: NodeJS.ProcessEnv = process.env): string | null {
  if (isLoopbackAddress(host) || env['MCP_AUTH_TOKEN']) return null;
  if (env['LLULL_ALLOW_UNAUTHENTICATED'] === 'true') return null;
  return (
    `Refusing to start: HOST=${host} is not loopback and MCP_AUTH_TOKEN is not set. ` +
    'Set MCP_AUTH_TOKEN, bind to 127.0.0.1, or set LLULL_ALLOW_UNAUTHENTICATED=true.'
  );
}

function hostWithoutPort(hostHeader: string): string {
  const value = hostHeader.trim().toLowerCase();
  if (value.startsWith('[')) {
    const end = value.indexOf(']');
    return end === -1 ? value : value.slice(0, end + 1);
  }
  const colon = value.lastIndexOf(':');
  return colon === -1 ? value : value.slice(0, colon);
}

/**
 * Host-header allowlist (DNS-rebinding defence). Allowed: localhost, 127.0.0.1, [::1] (any port)
 * plus `LLULL_ALLOWED_HOSTS` (comma-separated; `name` = any port, `name:port` = exact).
 * When `HOST` is non-loopback and `LLULL_ALLOWED_HOSTS` is unset, any Host is accepted
 * (public hostnames are unknown; bearer auth is mandatory there, see `checkBindSafety`).
 */
export function hostAllowlist(): RequestHandler {
  return (req: Request, res: Response, next: NextFunction): void => {
    const extra = (process.env['LLULL_ALLOWED_HOSTS'] ?? '')
      .split(',')
      .map((entry) => entry.trim().toLowerCase())
      .filter((entry) => entry.length > 0);
    if (extra.length === 0 && !isLoopbackAddress(process.env['HOST'] ?? '127.0.0.1')) {
      next();
      return;
    }
    const header = req.headers['host'];
    if (typeof header === 'string') {
      const full = header.trim().toLowerCase();
      const bare = hostWithoutPort(full);
      const allowed =
        ['localhost', '127.0.0.1', '[::1]'].includes(bare) ||
        extra.includes(full) ||
        extra.includes(bare);
      if (allowed) {
        next();
        return;
      }
    }
    res.status(403).json({ error: 'Host header is not allowed.' });
  };
}

/**
 * Guard for the browser routes (/command, /undo, /redo, /ui-bridge mutations).
 *
 * The Origin allowlist is CSRF protection ONLY (it stops other websites driving a browser);
 * `Origin` is trivially forged by curl, so it is never treated as authentication for remote peers.
 *
 * Policy (evaluated per request):
 *   1. valid `Authorization: Bearer <MCP_AUTH_TOKEN>`              -> allow
 *   2. `LLULL_REQUIRE_TOKEN_FOR_REST=true` and a token is set       -> 401
 *   3. token set and peer socket is NOT loopback                    -> 401 (Origin is not trusted)
 *   4. `Origin` header present and not in the allowlist             -> 403 (blocks CSRF from other sites)
 *   5. token set, no `Origin` header (non-browser client, no token) -> 401
 *   6. otherwise (allowed browser origin, or no token configured)   -> allow
 */
export function guardMutation(): RequestHandler {
  return (req: Request, res: Response, next: NextFunction): void => {
    const token = process.env['MCP_AUTH_TOKEN'];
    if (token && hasValidBearer(req, token)) {
      next();
      return;
    }
    if (token && process.env['LLULL_REQUIRE_TOKEN_FOR_REST'] === 'true') {
      res.status(401).json({ error: 'Unauthorized — valid Bearer token required.' });
      return;
    }
    if (token && !isLoopbackAddress(req.socket?.remoteAddress)) {
      res.status(401).json({ error: 'Unauthorized — valid Bearer token required.' });
      return;
    }
    const origin = req.headers['origin'];
    if (typeof origin === 'string' && !getAllowedOrigins().includes(origin)) {
      res.status(403).json({ error: `Origin ${origin} is not allowed.` });
      return;
    }
    if (token && typeof origin !== 'string') {
      res.status(401).json({ error: 'Unauthorized — valid Bearer token required.' });
      return;
    }
    next();
  };
}

/** Per-IP limiter for REST routes. `LLULL_REST_RATE_LIMIT_MAX` (default 600) per `LLULL_REST_RATE_LIMIT_WINDOW_MS` (default 60000). */
export function buildRestRateLimiter(): RequestHandler {
  const max = Number.parseInt(process.env['LLULL_REST_RATE_LIMIT_MAX'] ?? '', 10) || 600;
  const windowMs =
    Number.parseInt(process.env['LLULL_REST_RATE_LIMIT_WINDOW_MS'] ?? '', 10) || 60_000;
  return rateLimit({
    windowMs,
    max,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many requests — please slow down.' },
  });
}

/** Reduce a user string to a safe download basename: [A-Za-z0-9._-], max 64 chars, no leading dot. */
export function sanitizeFilename(raw: unknown, fallback = 'llull'): string {
  if (typeof raw !== 'string') return fallback;
  const cleaned = raw
    .replace(/[^A-Za-z0-9._-]+/g, '_')
    .replace(/^[._]+/, '')
    .slice(0, 64);
  return cleaned.length > 0 ? cleaned : fallback;
}

interface HttpParseError extends Error {
  status?: number;
  type?: string;
}

/** Final error middleware: JSON bodies, never an HTML stack trace. */
export function jsonErrorHandler(
  err: unknown,
  _req: Request,
  res: Response,
  next: NextFunction,
): void {
  if (res.headersSent) {
    next(err);
    return;
  }
  const httpError = err as HttpParseError;
  if (httpError.type === 'entity.parse.failed') {
    res.status(400).json({ error: 'Malformed JSON body.' });
    return;
  }
  if (httpError.type === 'entity.too.large') {
    res.status(413).json({ error: 'Request body too large.' });
    return;
  }
  const status =
    typeof httpError.status === 'number' && httpError.status >= 400 ? httpError.status : 500;
  if (status >= 500) console.error('[server] unhandled error:', httpError.message);
  res.status(status).json({ error: status >= 500 ? 'Internal server error.' : httpError.message });
}
