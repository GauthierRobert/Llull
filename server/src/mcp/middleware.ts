/**
 * @layer server
 *
 * Auth and rate-limit middleware for the /mcp router.
 */

import type { Request, Response } from 'express';
import rateLimit from 'express-rate-limit';
import { hasValidBearer } from '../security';

/**
 * Bearer-token auth guard.
 *
 * If `MCP_AUTH_TOKEN` is set: require `Authorization: Bearer <token>`.
 * If unset: warn once at startup and allow all traffic (local dev only).
 * Never logs the token value.
 */
export function buildAuthMiddleware(): (req: Request, res: Response, next: () => void) => void {
  const token = process.env['MCP_AUTH_TOKEN'];
  if (!token) {
    console.warn(
      '[warn] MCP_AUTH_TOKEN is not set — /mcp endpoint is unprotected. Set it in production.',
    );
    return (_req, _res, next) => next();
  }
  return (req: Request, res: Response, next: () => void) => {
    if (!hasValidBearer(req, token)) {
      res.status(401).json({ error: 'Unauthorized — valid Bearer token required.' });
      return;
    }
    next();
  };
}

// ---------------------------------------------------------------------------
// Rate limiting
// ---------------------------------------------------------------------------

/**
 * Defaults: 60 requests per minute per IP.
 * Override via `MCP_RATE_LIMIT_MAX` (requests) and `MCP_RATE_LIMIT_WINDOW_MS`.
 */
export function buildRateLimiter(): ReturnType<typeof rateLimit> {
  const windowMs = process.env['MCP_RATE_LIMIT_WINDOW_MS']
    ? parseInt(process.env['MCP_RATE_LIMIT_WINDOW_MS'], 10)
    : 60_000;
  const max = process.env['MCP_RATE_LIMIT_MAX']
    ? parseInt(process.env['MCP_RATE_LIMIT_MAX'], 10)
    : 60;
  return rateLimit({
    windowMs,
    max,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many requests — please slow down.' },
  });
}
