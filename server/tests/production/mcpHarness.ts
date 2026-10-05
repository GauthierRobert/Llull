/**
 * @layer server/tests/production
 *
 * Shared harness of the MCP-driven production gates: the real Express app on an ephemeral
 * loopback port, an MCP client over Streamable HTTP, and the live document the session edits.
 */

import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { app } from '../../src/index';
import { _resetLiveDoc, getLiveDoc } from '../../src/liveDocument';
import { _resetHistory } from '../../src/commandBus';
import type { CadDocument } from '@core/model/types';

export interface ToolOutcome {
  text: string;
  isError: boolean;
  structured: unknown;
}

export interface McpSession {
  client: Client;
  call(tool: string, args: Record<string, unknown>): Promise<ToolOutcome>;
  close(): Promise<void>;
}

let server: Server | null = null;
let baseUrl = '';

export async function startServer(): Promise<void> {
  if (server) return;
  const listening = await new Promise<Server>((resolve) => {
    const started: Server = app.listen(0, '127.0.0.1', () => resolve(started));
  });
  server = listening;
  const address = listening.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${address.port}`;
}

export async function stopServer(): Promise<void> {
  const running = server;
  server = null;
  if (running) await new Promise<void>((resolve) => running.close(() => resolve()));
}

/** Fresh live document (optionally a given one) and empty undo history. */
export function resetDocument(doc?: CadDocument): void {
  _resetLiveDoc(doc);
  _resetHistory();
}

export function liveDocument(): CadDocument {
  return getLiveDoc();
}

function textOf(content: unknown): string {
  if (!Array.isArray(content)) return '';
  return content
    .map((block: unknown) => {
      const item = block as { type?: string; text?: string };
      return item.type === 'text' && typeof item.text === 'string' ? item.text : '';
    })
    .filter((text) => text !== '')
    .join('\n');
}

export async function openSession(name: string): Promise<McpSession> {
  const client = new Client({ name, version: '1.0.0' });
  // Cast: the transport's `sessionId` getter vs Transport's optional field under
  // exactOptionalPropertyTypes (same as examples/mcp-agent.ts).
  await client.connect(new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`)) as Transport);
  return {
    client,
    call: async (tool, args) => {
      const result = await client.callTool({ name: tool, arguments: args });
      return {
        text: textOf(result.content),
        isError: result.isError === true,
        structured: result.structuredContent,
      };
    },
    close: () => client.close(),
  };
}
