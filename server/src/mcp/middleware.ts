/**
 * @layer server
 *
 * Auth and rate-limit middleware for the /mcp router.
 */

import type { Request, RequestHandler, Response } from 'express';
import { UNAUTHORIZED_BODY, buildRateLimiter, hasValidBearer } from '../security';
import { isUserMode, requireRole } from '../users';

/**
 * Bearer-token auth guard.
 *
 * If `MCP_AUTH_TOKEN` is set: require `Authorization: Bearer <token>`.
 * If unset: warn once at startup and allow all traffic (local dev only).
 * Never logs the token value.
 */
export function buildAuthMiddleware(): (req: Request, res: Response, next: () => void) => void {
  const userGuard = requireRole('viewer', false); // per-tool role checks live in mcp/server.ts
  const token = process.env['MCP_AUTH_TOKEN'];
  if (!token && !isUserMode()) {
    console.warn(
      '[warn] MCP_AUTH_TOKEN is not set — /mcp endpoint is unprotected. Set it in production.',
    );
  }
  return (req: Request, res: Response, next: () => void) => {
    if (isUserMode()) {
      userGuard(req, res, next);
      return;
    }
    if (!token) {
      next();
      return;
    }
    if (!hasValidBearer(req, token)) {
      res.status(401).json(UNAUTHORIZED_BODY);
      return;
    }
    next();
  };
}

/**
 * 600 requests per minute per IP (an agent modelling a building makes 100–300 tool calls in a few
 * minutes); override via `MCP_RATE_LIMIT_MAX` / `MCP_RATE_LIMIT_WINDOW_MS`.
 */
export function buildMcpRateLimiter(): RequestHandler {
  return buildRateLimiter('MCP_RATE_LIMIT_MAX', 'MCP_RATE_LIMIT_WINDOW_MS');
}
