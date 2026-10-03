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
import { TOOLSET_NAMES, TOOLSETS } from '@mcp/index';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';

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

const coreApp = express();
coreApp.use(express.json());
coreApp.use('/mcp', buildMcpRouter({ port: null, allowCodeExecution: false }, toolsetsFromEnv('')));

async function coreRpc(sessionId: string | null, method: string, params: object): Promise<unknown> {
  const id = rpcId++;
  let req = request(coreApp)
    .post('/mcp')
    .set('Content-Type', 'application/json')
    .set('Accept', 'application/json, text/event-stream');
  if (sessionId !== null) req = req.set('mcp-session-id', sessionId);
  const res = await req.send({ jsonrpc: '2.0', id, method, params });
  expect(res.status).toBe(200);
  if (sessionId === null) return res.headers['mcp-session-id'];
  return parseSseResult(res.text, id);
}

async function openCoreSession(): Promise<string> {
  return (await coreRpc(null, 'initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'discovery-test', version: '0.0.1' },
  })) as string;
}

async function listNames(sessionId: string): Promise<string[]> {
  const { tools } = (await coreRpc(sessionId, 'tools/list', {})) as { tools: { name: string }[] };
  return tools.map((tool) => tool.name);
}

describe('MCP tool discovery (default core-only exposure)', () => {
  it('tools/list holds only core tools + the discovery tools by default', async () => {
    const names = await listNames(await openCoreSession());
    expect(names).toContain('search_tools');
    expect(names).toContain('enable_toolset');
    expect(names).toContain('describe_scene');
    expect(names).not.toContain('add_box');
    expect(names).not.toContain('add_wall');
    for (const name of names) expect(TOOLSETS.core).toContain(name);
  });

  it('search_tools finds tools of disabled toolsets with their toolset', async () => {
    const sessionId = await openCoreSession();
    const result = (await coreRpc(sessionId, 'tools/call', {
      name: 'search_tools',
      arguments: { query: 'wall' },
    })) as {
      isError?: boolean;
      structuredContent: { results: { name: string; toolset: string; enabled: boolean }[] };
    };
    expect(result.isError).toBe(false);
    const wall = result.structuredContent.results.find((r) => r.name === 'add_wall');
    expect(wall).toMatchObject({ toolset: 'building', enabled: false });
  });

  it('enable_toolset adds the toolset to tools/list and sends tools/list_changed', async () => {
    const notify = vi.spyOn(Server.prototype, 'sendToolListChanged').mockResolvedValue(undefined);
    const sessionId = await openCoreSession();
    const result = (await coreRpc(sessionId, 'tools/call', {
      name: 'enable_toolset',
      arguments: { toolset: 'building' },
    })) as { isError?: boolean };
    expect(result.isError).toBe(false);
    expect(notify).toHaveBeenCalledTimes(1);
    expect(await listNames(sessionId)).toContain('add_wall');
    // Another session is unaffected.
    expect(await listNames(await openCoreSession())).not.toContain('add_wall');
    // Re-enabling is a no-op: no second notification.
    await coreRpc(sessionId, 'tools/call', {
      name: 'enable_toolset',
      arguments: { toolset: 'building' },
    });
    expect(notify).toHaveBeenCalledTimes(1);
    notify.mockRestore();
  });

  it('enable_toolset with an unknown toolset is an error listing the valid ones', async () => {
    const result = (await coreRpc(await openCoreSession(), 'tools/call', {
      name: 'enable_toolset',
      arguments: { toolset: 'bogus' },
    })) as { isError?: boolean; content: { text?: string }[] };
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain('Valid toolsets');
    expect(result.content[0]?.text).toContain('building');
  });

  it('a disabled tool call points at enable_toolset, and works once enabled', async () => {
    const sessionId = await openCoreSession();
    const call = { name: 'add_box', arguments: { width: 1, depth: 1, height: 1 } };
    const refused = (await coreRpc(sessionId, 'tools/call', call)) as {
      isError?: boolean;
      content: { text?: string }[];
    };
    expect(refused.isError).toBe(true);
    expect(refused.content[0]?.text).toContain('enable_toolset');
    await coreRpc(sessionId, 'tools/call', {
      name: 'enable_toolset',
      arguments: { toolset: '3d' },
    });
    const ok = (await coreRpc(sessionId, 'tools/call', call)) as { isError?: boolean };
    expect(ok.isError).toBe(false);
  });

  it('prompts/list follows the session toolsets', async () => {
    const sessionId = await openCoreSession();
    const before = (await coreRpc(sessionId, 'prompts/list', {})) as {
      prompts: { name: string }[];
    };
    expect(before.prompts.map((p) => p.name)).not.toContain('design_building');
    await coreRpc(sessionId, 'tools/call', {
      name: 'enable_toolset',
      arguments: { toolset: 'building' },
    });
    const after = (await coreRpc(sessionId, 'prompts/list', {})) as { prompts: { name: string }[] };
    expect(after.prompts.map((p) => p.name)).toContain('design_building');
  });
});

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

  it('toolsetsFromEnv warns on unknown names and defaults to core only', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    expect([...toolsetsFromEnv('3d,bogus')].sort()).toEqual(['3d', 'core']);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('bogus'));
    expect([...toolsetsFromEnv('')]).toEqual(['core']);
    expect(toolsetsFromEnv('all').size).toBe(TOOLSET_NAMES.length);
    warn.mockRestore();
  });
});
