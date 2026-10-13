/** HTTP hardening for the non-MCP routes: origin/host allowlists, auth guards, rate limits, JSON errors. */
import crypto from 'crypto';
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import rateLimit from 'express-rate-limit';
import { UNAUTHORIZED_BODY, bearerToken, isUserMode, requireRole, sha256Digest, type Role } from './users';
import { positiveInteger } from './env';

const DEFAULT_ALLOWED_ORIGINS: readonly string[] = ['http://localhost:5173', 'http://localhost:5174', 'http://localhost:3000'];

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

/** Constant-time equality of two tokens (compares SHA-256 digests: no length leak). */
function tokensMatch(presented: string, token: string): boolean {
  return crypto.timingSafeEqual(sha256Digest(presented), sha256Digest(token));
}

/** Constant-time `Authorization: Bearer <token>` check (digest compare: no length leak; scheme case-insensitive). */
export function hasValidBearer(req: Request, token: string): boolean {
  const presented = bearerToken(req);
  return presented !== undefined && tokensMatch(presented, token);
}

/** Constant-time check of the `?access_token=` query parameter (EventSource cannot set headers). */
function hasValidAccessToken(req: Request, token: string): boolean {
  const presented = req.query['access_token'];
  return typeof presented === 'string' && presented.length > 0 && tokensMatch(presented, token);
}

/** True for 127.0.0.0/8, ::1, ::ffff:127.*, and `localhost`. */
export function isLoopbackAddress(address: string | undefined): boolean {
  if (address === undefined) return false;
  const value = address.toLowerCase();
  return value === 'localhost' || value === '::1' || value.startsWith('127.') || value.startsWith('::ffff:127.');
}

/** Loopback TCP peer not relayed by a proxy (behind a local reverse proxy every client looks like loopback). */
function isLocalPeer(req: Request): boolean {
  return (
    req.headers['x-forwarded-for'] === undefined && req.headers['forwarded'] === undefined && isLoopbackAddress(req.socket?.remoteAddress)
  );
}

/** Refusal message when a non-loopback `HOST` would expose an unauthenticated API (opt out: `LLULL_ALLOW_UNAUTHENTICATED=true`), else null. */
export function checkBindSafety(host: string, env: NodeJS.ProcessEnv = process.env): string | null {
  if (isLoopbackAddress(host) || env['MCP_AUTH_TOKEN'] || env['LLULL_USERS_FILE'] || env['LLULL_ALLOW_UNAUTHENTICATED'] === 'true')
    return null;
  return (
    `Refusing to start: HOST=${host} is not loopback and MCP_AUTH_TOKEN is not set. ` +
    'Set MCP_AUTH_TOKEN (or LLULL_USERS_FILE), bind to 127.0.0.1, or set LLULL_ALLOW_UNAUTHENTICATED=true.'
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
 * Host-header allowlist (DNS rebinding): localhost, 127.0.0.1, [::1] (any port) + `LLULL_ALLOWED_HOSTS` (`name` any port,
 * `name:port` exact). Non-loopback `HOST` with no allowlist accepts any Host (bearer auth is mandatory there).
 */
export function hostAllowlist(): RequestHandler {
  return (req: Request, res: Response, next: NextFunction): void => {
    const extra = csv((process.env['LLULL_ALLOWED_HOSTS'] ?? '').toLowerCase());
    const header = req.headers['host'];
    const full = typeof header === 'string' ? header.trim().toLowerCase() : undefined;
    const bare = full === undefined ? undefined : hostWithoutPort(full);
    const allowed =
      (extra.length === 0 && !isLoopbackAddress(process.env['HOST'] ?? '127.0.0.1')) ||
      (full !== undefined &&
        bare !== undefined &&
        (['localhost', '127.0.0.1', '[::1]'].includes(bare) || extra.includes(full) || extra.includes(bare)));
    if (allowed) next();
    else res.status(403).json({ error: 'Host header is not allowed.' });
  };
}

/**
 * Guard for /command, /undo, /redo. The Origin allowlist is CSRF protection ONLY, never authentication. Policy:
 *   1. valid `Authorization: Bearer <MCP_AUTH_TOKEN>`              -> allow
 *   2. `LLULL_REQUIRE_TOKEN_FOR_REST=true` and a token is set       -> 401
 *   3. token set and peer is NOT loopback (or came via a proxy)     -> 401 (Origin is not trusted)
 *   4. `Origin` header present and not in the allowlist             -> 403 (blocks CSRF from other sites)
 *   5. token set, no `Origin` header (non-browser client, no token) -> 401
 *   6. otherwise (allowed browser origin, or no token configured)   -> allow
 */
export function guardMutation(): RequestHandler {
  return buildGuard(false, 'editor');
}

/** Guard for /live, /live/snapshot, /export/*: `guardMutation` policy + `?access_token=` (EventSource); no token -> open. */
export function guardRead(): RequestHandler {
  return buildGuard(true, 'viewer');
}

/** Guard for `/admin/*`: role `admin` (named users), the shared token, or (no token) loopback peers only. */
export function guardAdmin(): RequestHandler {
  return userRoleOr('admin', false, (req, res, next) => {
    const token = process.env['MCP_AUTH_TOKEN'];
    if (token ? hasValidBearer(req, token) : isLocalPeer(req)) {
      next();
      return;
    }
    res.status(token ? 401 : 403).json(token ? UNAUTHORIZED_BODY : { error: 'Admin endpoints need MCP_AUTH_TOKEN or a loopback peer.' });
  });
}

/** Named-user mode defers to the role check; otherwise `tokenGuard` decides. */
function userRoleOr(role: Role, acceptQuery: boolean, tokenGuard: RequestHandler): RequestHandler {
  const userGuard = requireRole(role, acceptQuery);
  return (req, res, next) => (isUserMode() ? userGuard : tokenGuard)(req, res, next);
}

function buildGuard(acceptQueryToken: boolean, role: Role): RequestHandler {
  return userRoleOr(role, acceptQueryToken, (req, res, next) => {
    const token = process.env['MCP_AUTH_TOKEN'];
    if (!token && acceptQueryToken) {
      const refusal = crossSiteRefusal(req);
      if (refusal === null) next();
      else res.status(403).json({ error: refusal });
      return;
    }
    if (token && (hasValidBearer(req, token) || (acceptQueryToken && hasValidAccessToken(req, token)))) {
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
  });
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

/** `LLULL_TRUST_PROXY` -> Express `trust proxy` value (`true`/`false`, hop count, or a name/subnet list); undefined when unset. */
export function trustProxySetting(raw: string | undefined): boolean | number | string | undefined {
  const value = raw?.trim();
  if (value === undefined || value === '') return undefined;
  if (value === 'true') return true;
  if (value === 'false') return false;
  return /^\d+$/.test(value) ? Number(value) : value;
}

/** CSP for the served web app (wasm kernels, blob workers/images; connect-src = same origin + allowed origins). */
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
export function buildRateLimiter(maxVariable: string, windowVariable: string): RequestHandler {
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
