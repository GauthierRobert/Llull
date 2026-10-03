/**
 * @layer server
 *
 * Auth and rate-limit middleware for the /mcp router.
 */

import type { Request, RequestHandler, Response } from 'express';
import { buildRateLimiter, hasValidBearer } from '../security';

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

/** 60 requests per minute per IP; override via `MCP_RATE_LIMIT_MAX` / `MCP_RATE_LIMIT_WINDOW_MS`. */
export function buildMcpRateLimiter(): RequestHandler {
  const windowMs = Number.parseInt(process.env['MCP_RATE_LIMIT_WINDOW_MS'] ?? '', 10) || 60_000;
  const max = Number.parseInt(process.env['MCP_RATE_LIMIT_MAX'] ?? '', 10) || 60;
  return buildRateLimiter(max, windowMs);
}
