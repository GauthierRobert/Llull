/** MCP Streamable HTTP test client over supertest (answers are SSE `data: <JSON-RPC>` lines). Not a test file. */

import { expect } from 'vitest';
import request from 'supertest';

type Target = Parameters<typeof request>[0];

export const INITIALIZE_PARAMS = { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test-client', version: '0.0.1' } };

export interface McpToolResult {
  content: Array<{ type: string; text?: string }>;
  isError?: boolean;
  structuredContent?: Record<string, unknown>;
}

/** POST /mcp with the JSON + SSE headers, inside `sessionId` once a session exists. */
export function mcpRequest(target: Target, sessionId?: string | null): request.Test {
  const req = request(target).post('/mcp').set('Content-Type', 'application/json').set('Accept', 'application/json, text/event-stream');
  return sessionId ? req.set('mcp-session-id', sessionId) : req;
}

/** The JSON-RPC result whose `id` is `rpcId` in an SSE body. */
function parseSseResult(text: string, rpcId: number): unknown {
  for (const line of text.split('\n')) {
    if (!line.startsWith('data: ')) continue;
    try {
      const parsed = JSON.parse(line.slice('data: '.length)) as { id?: number; result?: unknown };
      if (parsed.id === rpcId) return parsed.result;
    } catch {
      /* malformed line */
    }
  }
  return undefined;
}

let nextRpcId = 1;

/** One JSON-RPC call (expects HTTP 200); `sessionId` = the `mcp-session-id` response header. */
export async function mcpRpc(
  target: Target,
  sessionId: string | null,
  method: string,
  params: object,
): Promise<{ result: unknown; sessionId: string | null }> {
  const id = nextRpcId++;
  const res = await mcpRequest(target, sessionId).send({ jsonrpc: '2.0', id, method, params });
  expect(res.status).toBe(200);
  const header = res.headers['mcp-session-id'];
  return { result: parseSseResult(res.text, id), sessionId: typeof header === 'string' && header.length > 0 ? header : null };
}

/** `initialize` (+ the spec-required `initialized` notification unless `notify` is false): the session id. */
export async function openMcpSession(target: Target, notify = true): Promise<string> {
  const { sessionId } = await mcpRpc(target, null, 'initialize', INITIALIZE_PARAMS);
  expect(sessionId).not.toBeNull();
  if (notify) await mcpRequest(target, sessionId).send({ jsonrpc: '2.0', method: 'notifications/initialized' });
  return sessionId as string;
}

export async function callMcpTool(target: Target, sessionId: string, name: string, args: Record<string, unknown>): Promise<McpToolResult> {
  const { result } = await mcpRpc(target, sessionId, 'tools/call', { name, arguments: args });
  expect(result).toBeDefined();
  return result as McpToolResult;
}
