/**
 * @layer server/tests
 * LLULL_TOOLSETS filtering over the real MCP Streamable HTTP transport.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { buildMcpRouter, toolsetsFromEnv } from '../src/mcp';
import { getLiveDoc, _resetLiveDoc } from '../src/liveDocument';
import { _resetHistory } from '../src/commandBus';
import { TOOLSET_NAMES } from '@core/mcp';

const app = express();
app.use(express.json());
app.use('/mcp', buildMcpRouter({ port: null, allowCodeExecution: false }, toolsetsFromEnv('3d')));

function parseSseResult(text: string, rpcId: number): unknown {
  for (const line of text.split('\n')) {
    if (!line.startsWith('data: ')) continue;
    const parsed = JSON.parse(line.slice('data: '.length)) as { id?: number; result?: unknown };
    if (parsed.id === rpcId) return parsed.result;
  }
  return undefined;
}

let rpcId = 1;

beforeEach(() => {
  _resetLiveDoc();
  _resetHistory();
});

async function rpc(sessionId: string | null, method: string, params: object): Promise<unknown> {
  const id = rpcId++;
  let req = request(app)
    .post('/mcp')
    .set('Content-Type', 'application/json')
    .set('Accept', 'application/json, text/event-stream');
  if (sessionId !== null) req = req.set('mcp-session-id', sessionId);
  const res = await req.send({ jsonrpc: '2.0', id, method, params });
  expect(res.status).toBe(200);
  if (sessionId === null) return res.headers['mcp-session-id'];
  return parseSseResult(res.text, id);
}

async function openSession(): Promise<string> {
  return (await rpc(null, 'initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'toolsets-test', version: '0.0.1' },
  })) as string;
}

describe('MCP toolsets', () => {
  it('tools/list exposes only core + enabled toolsets', async () => {
    const sessionId = await openSession();
    const { tools } = (await rpc(sessionId, 'tools/list', {})) as { tools: { name: string }[] };
    const names = tools.map((tool) => tool.name);
    expect(names).toContain('add_box');
    expect(names).toContain('describe_scene');
    expect(names).not.toContain('draw_line');
    expect(names).not.toContain('add_wall');
    expect(names).not.toContain('import_step');
  });

  it('tools/call refuses a tool of a disabled toolset and names it', async () => {
    const sessionId = await openSession();
    const result = (await rpc(sessionId, 'tools/call', {
      name: 'draw_line',
      arguments: { start: [0, 0], end: [1, 0] },
    })) as { isError?: boolean; content: { text?: string }[] };
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain('"2d"');
    expect(result.content[0]?.text).toContain('LLULL_TOOLSETS');
  });

  it('build_project still runs steps from a disabled toolset', async () => {
    const sessionId = await openSession();
    const result = (await rpc(sessionId, 'tools/call', {
      name: 'build_project',
      arguments: { actions: [{ command: 'draw_line', params: { start: [0, 0], end: [5, 0] } }] },
    })) as { isError?: boolean; content: { text?: string }[] };
    expect(result.isError).toBe(false);
    expect(Object.values(getLiveDoc().entities).some((entity) => entity.kind === 'line')).toBe(
      true,
    );
  });

  it('keeps the render_view server enrichments in the filtered list', async () => {
    const sessionId = await openSession();
    const { tools } = (await rpc(sessionId, 'tools/list', {})) as {
      tools: { name: string; inputSchema: { properties?: Record<string, unknown> } }[];
    };
    const renderView = tools.find((tool) => tool.name === 'render_view');
    expect(renderView?.inputSchema.properties).toHaveProperty('turntable');
  });

  it('prompts/list hides workflows that need a disabled toolset', async () => {
    const sessionId = await openSession();
    const { prompts } = (await rpc(sessionId, 'prompts/list', {})) as {
      prompts: { name: string }[];
    };
    const names = prompts.map((prompt) => prompt.name);
    expect(names).toContain('model_bracket');
    expect(names).not.toContain('design_building');
  });

  it('toolsetsFromEnv warns on unknown names and defaults to all', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    expect([...toolsetsFromEnv('3d,bogus')].sort()).toEqual(['3d', 'core']);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('bogus'));
    expect(toolsetsFromEnv(undefined).size).toBe(TOOLSET_NAMES.length);
    warn.mockRestore();
  });
});
