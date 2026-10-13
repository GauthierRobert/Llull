/** Real MCP Streamable HTTP handshake + tools/call through supertest. */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import { app } from '../src/index';
import { getLiveDoc, _resetLiveDoc } from '../src/liveDocument';
import { _resetHistory } from '../src/commandBus';
import { listCommands } from '@core/commands/registry';
import * as registry from '@core/commands/registry';
import { buildDiscoveryToolDefinitions, buildExchangeToolDefinitions } from '@mcp/index';
import { callMcpTool, INITIALIZE_PARAMS, mcpRequest, mcpRpc, openMcpSession, type McpToolResult } from './mcpTestSupport';

const mcpSession = (): Promise<string> => openMcpSession(app);
const mcpCallTool = (sessionId: string, name: string, args: Record<string, unknown>): Promise<McpToolResult> =>
  callMcpTool(app, sessionId, name, args);
const entityCount = (): number => Object.keys(getLiveDoc().entities).length;

beforeEach(() => {
  _resetLiveDoc();
  _resetHistory();
});

describe('MCP initialize', () => {
  it('returns the server instructions so agents learn the workflow up front', async () => {
    const res = await mcpRequest(app).send({ jsonrpc: '2.0', id: 9001, method: 'initialize', params: INITIALIZE_PARAMS });
    expect(res.status).toBe(200);
    for (const text of ['instructions', 'cad://conventions', 'search_tools']) expect(res.text).toContain(text);
  });

  it('returns a distinct non-empty mcp-session-id per call', async () => {
    const id1 = await openMcpSession(app, false);
    expect(id1.length).toBeGreaterThan(0);
    expect(id1).not.toBe(await openMcpSession(app, false));
  });
});

describe('MCP tools/list', () => {
  it('lists every registered command, then the exchange and discovery tools', async () => {
    const { result } = await mcpRpc(app, await mcpSession(), 'tools/list', {});
    const { tools = [] } = result as { tools?: Array<{ name: string }> };
    const extra = [...buildExchangeToolDefinitions(), ...buildDiscoveryToolDefinitions()];
    expect(tools.length).toBe(listCommands().length + extra.length);
    expect(tools.map((t) => t.name)).toEqual([...listCommands().map((c) => c.name), ...extra.map((t) => t.name)]);
  });
});

describe('MCP tools/call — mutation (add_box)', () => {
  it('returns summary + affected-ids blocks, no structuredContent, no image; updates the live document', async () => {
    const result = await mcpCallTool(await mcpSession(), 'add_box', { size: [2, 2, 2], position: [0, 0, 0] });
    expect(result.isError).toBeFalsy();
    expect(Array.isArray(result.content)).toBe(true);
    expect(result.content[0]!.type).toBe('text');
    expect(result.content[0]!.text).toMatch(/box/i);
    expect(result.content.length).toBeGreaterThanOrEqual(2);
    expect(result.content[1]!.type).toBe('text');
    expect(result.content[1]!.text).toMatch(/^Affected entity ids:/);
    expect(result.structuredContent).toBeUndefined();
    expect(result.content.filter((b) => b.type === 'image')).toHaveLength(0);
    expect(entityCount()).toBe(1);
  });
});

describe('MCP tools/call — query (mass_properties)', () => {
  it('returns a json data block and the record as structuredContent, without mutating', async () => {
    const sessionId = await mcpSession();
    const added = await mcpCallTool(sessionId, 'add_box', { size: [2, 2, 2], position: [0, 0, 0] });
    const entityId = added.content
      .find((c) => c.text?.startsWith('Affected entity ids:'))!
      .text!.replace('Affected entity ids:', '')
      .trim();
    expect(entityId.length).toBeGreaterThan(0);
    const docBefore = getLiveDoc();
    const measured = await mcpCallTool(sessionId, 'mass_properties', { entityId });
    expect(getLiveDoc()).toBe(docBefore);
    expect(measured.isError).toBeFalsy();
    expect(measured.content.find((c) => c.text?.startsWith('```json'))!.text).toContain('"volume"');
    expect(typeof measured.structuredContent!['volume']).toBe('number');
    expect(measured.structuredContent!['volumeUnit']).toBe('mm³');
    expect(measured.structuredContent!['volume']).toBeCloseTo(8);
  });
});

describe('MCP tools/call + REST /undo share one history', () => {
  it('REST undos revert MCP mutations one by one', async () => {
    const sessionId = await mcpSession();
    await mcpCallTool(sessionId, 'add_box', { size: [1, 1, 1], position: [0, 0, 0] });
    await mcpCallTool(sessionId, 'add_box', { size: [2, 2, 2], position: [5, 0, 0] });
    expect(entityCount()).toBe(2);
    const undoRes = await request(app).post('/undo').send();
    expect(undoRes.status).toBe(200);
    expect(undoRes.body.summary).toBe('Undid last change.');
    expect(undoRes.body.canRedo).toBe(true);
    expect(entityCount()).toBe(1);
    await request(app).post('/undo').send();
    expect(entityCount()).toBe(0);
  });
});

describe('MCP tools/call — render_view', () => {
  it('adds an image block and strips the SVG from every text block and structuredContent', { timeout: 15000 }, async () => {
    const sessionId = await mcpSession();
    await mcpCallTool(sessionId, 'add_box', { size: [2, 2, 2], position: [0, 0, 0] });
    const result = await mcpCallTool(sessionId, 'render_view', {});
    expect(result.content.filter((b) => b.type === 'image').length).toBeGreaterThanOrEqual(1);
    for (const block of result.content.filter((b) => b.type === 'text')) expect(block.text ?? '').not.toMatch(/<svg|<polygon/i);
    const json = result.content.find((b) => b.text?.startsWith('```json'))!.text;
    expect(json).toMatch(/"width"/);
    expect(json).toMatch(/"height"/);
    expect(json).not.toMatch(/"svg"/);
    if (result.structuredContent !== undefined) expect('svg' in result.structuredContent).toBe(false);
  });
});

describe('MCP tools/call — failures are isError results', () => {
  it.each([
    ['totally_nonexistent_tool', [/unknown command/i]],
    ['add_boxx', [/Closest tools: add_box[,.]/]],
    ['make_box', [/Unknown command: make_box\./, /Closest tools: .*add_box/, /search_tools/]],
  ])('unknown tool %s explains and suggests', async (name, patterns) => {
    const result = await mcpCallTool(await mcpSession(), name, {});
    expect(result.isError).toBe(true);
    expect(result.content[0]!.type).toBe('text');
    for (const pattern of patterns) expect(result.content[0]!.text).toMatch(pattern);
  });

  it('a throwing command is an isError result, not a JSON-RPC error', async () => {
    const sessionId = await mcpSession();
    vi.spyOn(registry, 'execute').mockImplementation(() => {
      throw new Error('kernel exploded');
    });
    const result = await mcpCallTool(sessionId, 'add_box', { size: [1, 1, 1] });
    vi.restoreAllMocks();
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain('kernel exploded');
  });
});
