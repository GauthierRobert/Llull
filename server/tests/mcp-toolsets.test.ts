/** LLULL_TOOLSETS filtering over the real MCP Streamable HTTP transport. */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import { buildMcpRouter, toolsetsFromEnv } from '../src/mcp';
import { getLiveDoc, _resetLiveDoc } from '../src/liveDocument';
import { _resetHistory } from '../src/commandBus';
import { TOOLSET_NAMES, TOOLSETS } from '@mcp/index';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { mcpRpc, openMcpSession } from './mcpTestSupport';

const app = express();
app.use(express.json());
app.use('/mcp', buildMcpRouter({ port: null, allowCodeExecution: false }, toolsetsFromEnv('3d')));

beforeEach(() => {
  _resetLiveDoc();
  _resetHistory();
});

const coreApp = express();
coreApp.use(express.json());
coreApp.use('/mcp', buildMcpRouter({ port: null, allowCodeExecution: false }, toolsetsFromEnv('')));

const rpcOn =
  (target: express.Express) =>
  async (sessionId: string, method: string, params: object): Promise<unknown> =>
    (await mcpRpc(target, sessionId, method, params)).result;
const rpc = rpcOn(app);
const coreRpc = rpcOn(coreApp);
const openSession = (): Promise<string> => openMcpSession(app, false);
const openCoreSession = (): Promise<string> => openMcpSession(coreApp, false);

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
    expect(names).not.toContain('draw_walls');
    for (const name of names) expect(TOOLSETS.core).toContain(name);
  });

  it('search_tools finds tools of disabled toolsets with their toolset', async () => {
    const sessionId = await openCoreSession();
    const result = (await coreRpc(sessionId, 'tools/call', { name: 'search_tools', arguments: { query: 'wall' } })) as {
      isError?: boolean;
      structuredContent: { results: { name: string; toolset: string; enabled: boolean }[] };
    };
    expect(result.isError).toBe(false);
    const wall = result.structuredContent.results.find((r) => r.name === 'draw_walls');
    expect(wall).toMatchObject({ toolset: 'building', enabled: false });
  });

  it('enable_toolset adds the toolset to tools/list and sends tools/list_changed', async () => {
    const notify = vi.spyOn(Server.prototype, 'sendToolListChanged').mockResolvedValue(undefined);
    const sessionId = await openCoreSession();
    const result = (await coreRpc(sessionId, 'tools/call', { name: 'enable_toolset', arguments: { toolset: 'building' } })) as {
      isError?: boolean;
    };
    expect(result.isError).toBe(false);
    expect(notify).toHaveBeenCalledTimes(1);
    expect(await listNames(sessionId)).toContain('draw_walls');
    // Another session is unaffected.
    expect(await listNames(await openCoreSession())).not.toContain('draw_walls');
    // Re-enabling is a no-op: no second notification.
    await coreRpc(sessionId, 'tools/call', { name: 'enable_toolset', arguments: { toolset: 'building' } });
    expect(notify).toHaveBeenCalledTimes(1);
    notify.mockRestore();
  });

  it('enable_toolset with an unknown toolset is an error listing the valid ones', async () => {
    const result = (await coreRpc(await openCoreSession(), 'tools/call', { name: 'enable_toolset', arguments: { toolset: 'bogus' } })) as {
      isError?: boolean;
      content: { text?: string }[];
    };
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain('Valid toolsets');
    expect(result.content[0]?.text).toContain('building');
  });

  it('a disabled tool call points at enable_toolset, and works once enabled', async () => {
    const sessionId = await openCoreSession();
    const call = { name: 'add_box', arguments: { size: [1, 1, 1] } };
    const refused = (await coreRpc(sessionId, 'tools/call', call)) as { isError?: boolean; content: { text?: string }[] };
    expect(refused.isError).toBe(true);
    expect(refused.content[0]?.text).toContain('enable_toolset');
    await coreRpc(sessionId, 'tools/call', { name: 'enable_toolset', arguments: { toolset: '3d' } });
    const ok = (await coreRpc(sessionId, 'tools/call', call)) as { isError?: boolean };
    expect(ok.isError).toBe(false);
  });

  it('prompts/list follows the session toolsets', async () => {
    const sessionId = await openCoreSession();
    const before = (await coreRpc(sessionId, 'prompts/list', {})) as { prompts: { name: string }[] };
    expect(before.prompts.map((p) => p.name)).not.toContain('design_building');
    await coreRpc(sessionId, 'tools/call', { name: 'enable_toolset', arguments: { toolset: 'building' } });
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
    expect(names).not.toContain('draw_polyline');
    expect(names).not.toContain('draw_walls');
    expect(names).not.toContain('import_step');
  });

  it('tools/list advertises registry annotations', async () => {
    const sessionId = await openSession();
    const { tools } = (await rpc(sessionId, 'tools/list', {})) as { tools: { name: string; annotations?: { readOnlyHint?: boolean } }[] };
    expect(tools.find((tool) => tool.name === 'describe_scene')?.annotations?.readOnlyHint).toBe(true);
    expect(tools.find((tool) => tool.name === 'add_box')?.annotations?.readOnlyHint).toBeUndefined();
  });

  it('tools/call refuses a tool of a disabled toolset and names it', async () => {
    const sessionId = await openSession();
    const result = (await rpc(sessionId, 'tools/call', {
      name: 'draw_polyline',
      arguments: {
        points: [
          [0, 0],
          [1, 0],
        ],
      },
    })) as { isError?: boolean; content: { text?: string }[] };
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain('"2d"');
    expect(result.content[0]?.text).toContain('LLULL_TOOLSETS');
  });

  it('build_project still runs steps from a disabled toolset', async () => {
    const sessionId = await openSession();
    const result = (await rpc(sessionId, 'tools/call', {
      name: 'build_project',
      arguments: {
        actions: [
          {
            command: 'draw_polyline',
            params: {
              points: [
                [0, 0],
                [5, 0],
              ],
            },
          },
        ],
      },
    })) as { isError?: boolean; content: { text?: string }[] };
    expect(result.isError).toBe(false);
    expect(Object.values(getLiveDoc().entities).some((entity) => entity.kind === 'line')).toBe(true);
  });

  it('advertises the render_view enrichment params in the filtered list', async () => {
    const sessionId = await openSession();
    const { tools } = (await rpc(sessionId, 'tools/list', {})) as {
      tools: { name: string; inputSchema: { properties?: Record<string, unknown> } }[];
    };
    const renderView = tools.find((tool) => tool.name === 'render_view');
    expect(renderView?.inputSchema.properties).toHaveProperty('turntable');
  });

  it('prompts/list hides workflows that need a disabled toolset', async () => {
    const sessionId = await openSession();
    const { prompts } = (await rpc(sessionId, 'prompts/list', {})) as { prompts: { name: string }[] };
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
