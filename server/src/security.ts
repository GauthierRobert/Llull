/**
 * HTTP hardening of the local backend: loopback-only bind, origin/host allowlists, the per-launch token guard, rate limits,
 * JSON errors. The token (`MCP_AUTH_TOKEN`, set by the desktop app per launch) keeps other local processes and websites
 * away from the document; there are no named users or roles (LC1: one local backend per machine).
 */
import crypto from 'crypto';
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import rateLimit from 'express-rate-limit';
import { positiveInteger } from './env';
import { consumeTicket } from './tickets';

const DEFAULT_ALLOWED_ORIGINS: readonly string[] = ['http://localhost:5173', 'http://localhost:5174', 'http://localhost:3000'];

/** JSON body of every 401. */
const UNAUTHORIZED_BODY = { error: 'Unauthorized — valid Bearer token required.' };

/** Origins allowed to call the server from a browser. `LLULL_ALLOWED_ORIGINS` = comma-separated. */
export function getAllowedOrigins(): string[] {
  const raw = process.env['LLULL_ALLOWED_ORIGINS'];
  return raw === undefined || raw.trim() === '' ? [...DEFAULT_ALLOWED_ORIGINS] : csv(raw);
}

const csv = (raw: string): string[] =>
  raw
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);

const sha256Digest = (value: string): Buffer => crypto.createHash('sha256').update(value).digest();

/** `Authorization: Bearer <token>` (scheme case-insensitive). */
function bearerToken(req: Request): string | undefined {
  const header = req.headers['authorization'];
  return typeof header === 'string' ? /^bearer +(.+)$/i.exec(header)?.[1] : undefined;
}

/** Constant-time `Authorization: Bearer <token>` check (digest compare: no length leak; scheme case-insensitive). */
export function hasValidBearer(req: Request, token: string): boolean {
  const presented = bearerToken(req);
  return presented !== undefined && crypto.timingSafeEqual(sha256Digest(presented), sha256Digest(token));
}

/** True for 127.0.0.0/8, ::1, ::ffff:127.*, and `localhost`. */
export function isLoopbackAddress(address: string | undefined): boolean {
  if (address === undefined) return false;
  const value = address.toLowerCase();
  return value === 'localhost' || value === '::1' || value.startsWith('127.') || value.startsWith('::ffff:127.');
}

/** Headers a reverse proxy sets when it relays a client; any of them marks the request as proxied (not local). */
const PROXY_HEADERS: readonly string[] = [
  'x-forwarded-for',
  'forwarded',
  'x-real-ip',
  'cf-connecting-ip',
  'x-forwarded-host',
  'x-forwarded-proto',
  'x-forwarded-port',
];

/**
 * Loopback TCP peer not relayed by a proxy (behind a local reverse proxy every client looks like loopback).
 * Redaction of licensed values for a non-local client (TR-MAT-32) relies on the proxy setting at least one of PROXY_HEADERS.
 */
export function isLocalPeer(req: Request): boolean {
  return PROXY_HEADERS.every((header) => req.headers[header] === undefined) && isLoopbackAddress(req.socket?.remoteAddress);
}

/** Refusal message when `HOST` is not a loopback address (the backend is local-only, LC1), else null. */
export function checkBindSafety(host: string): string | null {
  if (isLoopbackAddress(host)) return null;
  return `Refusing to start: HOST=${host} is not a loopback address. The llull backend is local-only; bind to 127.0.0.1.`;
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

/** Host-header allowlist (DNS rebinding): localhost, 127.0.0.1, [::1], any port. */
export function hostAllowlist(): RequestHandler {
  return (req: Request, res: Response, next: NextFunction): void => {
    const header = req.headers['host'];
    const bare = typeof header === 'string' ? hostWithoutPort(header) : undefined;
    if (bare !== undefined && ['localhost', '127.0.0.1', '[::1]'].includes(bare)) next();
    else res.status(403).json({ error: 'Host header is not allowed.' });
  };
}

/**
 * Guard for /command, /undo, /redo, /exchange, /import. The Origin allowlist is CSRF protection ONLY, never authentication:
 *   1. valid `Authorization: Bearer <MCP_AUTH_TOKEN>`              -> allow
 *   2. `LLULL_REQUIRE_TOKEN_FOR_REST=true` and a token is set       -> 401
 *   3. token set and peer is NOT loopback (or came via a proxy)     -> 401 (Origin is not trusted)
 *   4. `Origin` header present and not in the allowlist             -> 403 (blocks CSRF from other sites)
 *   5. token set, no `Origin` header (non-browser client, no token) -> 401
 *   6. otherwise (allowed browser origin, or no token configured)   -> allow
 */
export function guardMutation(): RequestHandler {
  return buildGuard(false);
}

/**
 * Guard for /live, /live/snapshot, /export/*: `guardMutation` policy; no token -> open to same-site requests.
 * `GET /live` (EventSource cannot send headers) also takes a single-use `?ticket=` (see tickets.ts); a request
 * carrying an Authorization header is judged by that header alone.
 */
export function guardRead(): RequestHandler {
  const inner = buildGuard(true);
  return (req, res, next) => {
    const presented = req.query['ticket'];
    const isLiveStream = req.method === 'GET' && req.baseUrl + req.path === '/live';
    if (typeof presented !== 'string' || presented === '' || !isLiveStream || req.headers.authorization !== undefined)
      return inner(req, res, next);
    if (!consumeTicket(presented)) return void res.status(401).json(UNAUTHORIZED_BODY);
    next();
  };
}

/** Guard for `POST /live/ticket`: header auth ONLY (never a ticket). */
export function guardTicketIssue(): RequestHandler {
  return buildGuard(false);
}

function buildGuard(isRead: boolean): RequestHandler {
  return (req, res, next) => {
    const token = process.env['MCP_AUTH_TOKEN'];
    if (!token && isRead) {
      const refusal = crossSiteRefusal(req);
      if (refusal === null) next();
      else res.status(403).json({ error: refusal });
      return;
    }
    if (token && hasValidBearer(req, token)) {
      next();
      return;
    }
    if (token && (process.env['LLULL_REQUIRE_TOKEN_FOR_REST'] === 'true' || !isLocalPeer(req))) {
      res.status(401).json(UNAUTHORIZED_BODY);
      return;
    }
    const origin = req.headers['origin'];
    if (typeof origin === 'string' && !getAllowedOrigins().includes(origin)) {
      res.status(403).json({ error: `Origin ${origin} is not allowed.` });
      return;
    }
    if (token && typeof origin !== 'string') {
      res.status(401).json(UNAUTHORIZED_BODY);
      return;
    }
    next();
  };
}

/** Why a token-less read request must be refused as cross-site (CSRF of CPU-heavy exports), else null. */
function crossSiteRefusal(req: Request): string | null {
  const origin = req.headers['origin'];
  if (typeof origin === 'string') {
    if (getAllowedOrigins().includes(origin) || isSameHostOrigin(origin, req.headers['host'])) return null;
    return `Origin ${origin} is not allowed.`;
  }
  return req.headers['sec-fetch-site'] === 'cross-site' ? 'Cross-site requests are not allowed.' : null;
}

function isSameHostOrigin(origin: string, host: string | undefined): boolean {
  try {
    return host !== undefined && new URL(origin).host.toLowerCase() === host.trim().toLowerCase();
  } catch {
    return false;
  }
}

/** CSP for the served app (wasm kernels, blob workers/images; connect-src = same origin + allowed origins). */
export function contentSecurityPolicy(): string {
  return [
    "default-src 'self'",
    "script-src 'self' 'wasm-unsafe-eval'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    ['connect-src', "'self'", ...getAllowedOrigins()].join(' '),
    "worker-src 'self' blob:",
    "frame-ancestors 'none'",
    "object-src 'none'",
    "base-uri 'self'",
  ].join('; ');
}

/** Set the CSP on an HTML response (static `index.html` and the SPA fallback). */
export function setHtmlSecurityHeaders(res: Response): void {
  res.setHeader('Content-Security-Policy', contentSecurityPolicy());
}

/** Baseline hardening headers on every response. */
export function securityHeaders(): RequestHandler {
  return (_req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');
    next();
  };
}

/** Per-IP limiter: env `maxVariable` requests (default 600) per env `windowVariable` ms (default 60000). */
function buildRateLimiter(maxVariable: string, windowVariable: string): RequestHandler {
  return rateLimit({
    windowMs: positiveInteger(process.env[windowVariable], 60_000),
    max: positiveInteger(process.env[maxVariable], 600),
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many requests — please slow down.' },
  });
}

export function buildRestRateLimiter(): RequestHandler {
  return buildRateLimiter('LLULL_REST_RATE_LIMIT_MAX', 'LLULL_REST_RATE_LIMIT_WINDOW_MS');
}

interface HttpParseError extends Error {
  status?: number;
  type?: string;
}

/** Final error middleware: JSON bodies, never an HTML stack trace. */
export function jsonErrorHandler(err: unknown, _req: Request, res: Response, next: NextFunction): void {
  if (res.headersSent) {
    next(err);
    return;
  }
  const httpError = err as HttpParseError;
  if (httpError.type === 'entity.parse.failed') return void res.status(400).json({ error: 'Malformed JSON body.' });
  if (httpError.type === 'entity.too.large') return void res.status(413).json({ error: 'Request body too large.' });
  const status = typeof httpError.status === 'number' && httpError.status >= 400 ? httpError.status : 500;
  if (status >= 500) console.error('[server] unhandled error:', httpError.message);
  res.status(status).json({ error: status >= 500 ? 'Internal server error.' : httpError.message });
}
