/**
 * @layer server/tests
 *
 * Shared supertest request for the MCP transport: POST /mcp with the JSON + SSE headers, inside
 * `sessionId` once a session exists. Not a test file (no `.test.ts` suffix).
 */

import request from 'supertest';

export function mcpRequest(
  target: Parameters<typeof request>[0],
  sessionId?: string | null,
): request.Test {
  const req = request(target)
    .post('/mcp')
    .set('Content-Type', 'application/json')
    .set('Accept', 'application/json, text/event-stream');
  return sessionId ? req.set('mcp-session-id', sessionId) : req;
}
