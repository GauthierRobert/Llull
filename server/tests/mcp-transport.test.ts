/**
 * @layer server/tests
 *
 * MCP transport integration tests — real MCP Streamable HTTP handshake.
 *
 * These tests drive the actual MCP `CallToolRequestSchema` handler through the
 * HTTP transport (via supertest), not through the command bus or REST endpoints
 * directly.  They verify that shapeToolCallContent is exercised end-to-end and
 * that MCP tool calls share undo history with the REST endpoints.
 *
 * Transport note: the MCP Streamable HTTP transport responds with
 * `Content-Type: text/event-stream` (SSE), not application/json.
 * supertest reads the body as `res.text`; we parse the SSE envelope to extract
 * the JSON-RPC result.  Format: `event: message\ndata: <JSON>\n\n`.
 *
 * Covers:
 *   (a) MCP initialize handshake → session id header returned.
 *   (b) tools/list → every registered command has a tool entry.
 *   (c) tools/call add_box (mutation) → summary block, "Affected entity ids" block,
 *       isError:false.
 *   (d) tools/call measure_volume on the created entity (query) → json data block,
 *       structuredContent is the record, isError:false.
 *   (e) tools/call add_box (MCP) then POST /undo (REST) → entity is reverted
 *       (real MCP-to-shared-history interop, replacing the comment-only test).
 *   (f) tools/call with unknown tool name → isError:true, explanatory content block.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import { app } from '../src/index';
import { getLiveDoc, _resetLiveDoc } from '../src/liveDocument';
import { _resetHistory } from '../src/commandBus';
import { listCommands } from '@core/commands/registry';
import { buildBridgeToolDefinitions } from '@core/mcp';

// ---------------------------------------------------------------------------
// SSE parsing helpers
// ---------------------------------------------------------------------------

/**
 * Parse the JSON-RPC result from an SSE response body.
 *
 * The MCP Streamable HTTP transport always responds with `text/event-stream`.
 * Each message is a line starting with `data: ` followed by JSON.
 * We parse every data line and return the one whose `id` matches `rpcId`.
 */
function parseSseResult(text: string, rpcId: number): unknown {
  for (const line of text.split('\n')) {
    if (!line.startsWith('data: ')) continue;
    try {
      const parsed = JSON.parse(line.slice('data: '.length)) as {
        id?: number;
        result?: unknown;
        error?: unknown;
        jsonrpc?: string;
      };
      if (parsed.id === rpcId) return parsed.result;
    } catch {
      // skip malformed lines
    }
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// JSON-RPC id counter — each request needs a unique id.
// ---------------------------------------------------------------------------

let rpcId = 1;
function nextId(): number {
  return rpcId++;
}

// ---------------------------------------------------------------------------
// Transport helpers
// ---------------------------------------------------------------------------

/**
 * Perform the MCP `initialize` handshake and return the session id.
 *
 * The first POST to /mcp (no mcp-session-id header) carries the `initialize`
 * method.  The server responds with the session id in the `mcp-session-id` header.
 */
async function mcpInitialize(): Promise<string> {
  const id = nextId();
  const res = await request(app)
    .post('/mcp')
    .set('Content-Type', 'application/json')
    .set('Accept', 'application/json, text/event-stream')
    .send({
      jsonrpc: '2.0',
      id,
      method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'test-client', version: '0.0.1' },
      },
    });

  expect(res.status).toBe(200);
  const sessionId = res.headers['mcp-session-id'] as string | undefined;
  expect(typeof sessionId).toBe('string');
  return sessionId as string;
}

/**
 * Send an initialized notification (required by the MCP spec after initialize).
 * Notifications have no `id` field and no expected response.
 */
async function mcpNotifyInitialized(sessionId: string): Promise<void> {
  await request(app)
    .post('/mcp')
    .set('Content-Type', 'application/json')
    .set('Accept', 'application/json, text/event-stream')
    .set('mcp-session-id', sessionId)
    .send({ jsonrpc: '2.0', method: 'notifications/initialized' });
}

interface McpToolResult {
  content: Array<{ type: string; text?: string }>;
  isError?: boolean;
  structuredContent?: Record<string, unknown>;
}

/**
 * Call a tool over the MCP transport and return the parsed CallToolResult.
 *
 * Reads `res.text` (SSE body) and extracts the JSON-RPC result for `id`.
 */
async function mcpCallTool(
  sessionId: string,
  name: string,
  args: Record<string, unknown>,
): Promise<McpToolResult> {
  const id = nextId();
  const res = await request(app)
    .post('/mcp')
    .set('Content-Type', 'application/json')
    .set('Accept', 'application/json, text/event-stream')
    .set('mcp-session-id', sessionId)
    .send({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } });

  expect(res.status).toBe(200);
  const result = parseSseResult(res.text, id) as McpToolResult | undefined;
  expect(result).toBeDefined();
  return result as McpToolResult;
}

/**
 * Call tools/list over the MCP transport and return the parsed tools array.
 */
async function mcpListTools(sessionId: string): Promise<Array<{ name: string }>> {
  const id = nextId();
  const res = await request(app)
    .post('/mcp')
    .set('Content-Type', 'application/json')
    .set('Accept', 'application/json, text/event-stream')
    .set('mcp-session-id', sessionId)
    .send({ jsonrpc: '2.0', id, method: 'tools/list', params: {} });

  expect(res.status).toBe(200);
  const result = parseSseResult(res.text, id) as { tools?: Array<{ name: string }> } | undefined;
  expect(result).toBeDefined();
  return result!.tools ?? [];
}

// ---------------------------------------------------------------------------
// Reset shared state before each test.
// ---------------------------------------------------------------------------

beforeEach(() => {
  rpcId = 1;
  _resetLiveDoc();
  _resetHistory();
});

// ---------------------------------------------------------------------------
// (a) MCP initialize handshake
// ---------------------------------------------------------------------------

describe('MCP initialize handshake', () => {
  it('returns 200 and a non-empty mcp-session-id header', async () => {
    const sessionId = await mcpInitialize();
    expect(sessionId.length).toBeGreaterThan(0);
  });

  it('each initialize call returns a distinct session id', async () => {
    const id1 = await mcpInitialize();
    const id2 = await mcpInitialize();
    expect(id1).not.toBe(id2);
  });
});

// ---------------------------------------------------------------------------
// (b) tools/list — tool count == listCommands()
// ---------------------------------------------------------------------------

describe('MCP tools/list', () => {
  it('returns one tool per registered command, plus the bridge tools', async () => {
    const sessionId = await mcpInitialize();
    await mcpNotifyInitialized(sessionId);

    const tools = await mcpListTools(sessionId);
    expect(tools.length).toBe(listCommands().length + buildBridgeToolDefinitions().length);
  });

  it('tool names match the registered command names followed by the bridge tools', async () => {
    const sessionId = await mcpInitialize();
    await mcpNotifyInitialized(sessionId);

    const tools = await mcpListTools(sessionId);
    const expectedNames = [
      ...listCommands().map((c) => c.name),
      ...buildBridgeToolDefinitions().map((t) => t.name),
    ];
    const toolNames = tools.map((t) => t.name);
    expect(toolNames).toEqual(expectedNames);
  });
});

// ---------------------------------------------------------------------------
// (c) tools/call add_box — mutation → summary block + affected block
// ---------------------------------------------------------------------------

describe('MCP tools/call — mutation (add_box)', () => {
  it('returns isError:false with summary and affected-ids content blocks', async () => {
    const sessionId = await mcpInitialize();
    await mcpNotifyInitialized(sessionId);

    const result = await mcpCallTool(sessionId, 'add_box', {
      size: [2, 2, 2],
      position: [0, 0, 0],
    });

    expect(result.isError).toBeFalsy();
    expect(Array.isArray(result.content)).toBe(true);

    // Block 0: summary mentioning "box"
    const summaryBlock = result.content[0];
    expect(summaryBlock).toBeDefined();
    expect(summaryBlock!.type).toBe('text');
    expect(summaryBlock!.text).toMatch(/box/i);

    // Block 1: "Affected entity ids: ..." (shapeToolCallContent adds this when affected is non-empty)
    expect(result.content.length).toBeGreaterThanOrEqual(2);
    const affectedBlock = result.content[1];
    expect(affectedBlock).toBeDefined();
    expect(affectedBlock!.type).toBe('text');
    expect(affectedBlock!.text).toMatch(/^Affected entity ids:/);
  });

  it('live document is updated after the MCP mutation', async () => {
    const sessionId = await mcpInitialize();
    await mcpNotifyInitialized(sessionId);

    await mcpCallTool(sessionId, 'add_box', { size: [3, 3, 3], position: [0, 0, 0] });

    expect(Object.keys(getLiveDoc().entities)).toHaveLength(1);
  });

  it('does NOT set structuredContent for a mutation result', async () => {
    const sessionId = await mcpInitialize();
    await mcpNotifyInitialized(sessionId);

    const result = await mcpCallTool(sessionId, 'add_box', {
      size: [1, 1, 1],
      position: [0, 0, 0],
    });

    // Mutations have no `data` → no structuredContent
    expect(result.structuredContent).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// (d) tools/call measure_volume (query) → json data block + structuredContent
// ---------------------------------------------------------------------------

describe('MCP tools/call — query (measure_volume)', () => {
  it('returns json data block and structuredContent with volume record', async () => {
    const sessionId = await mcpInitialize();
    await mcpNotifyInitialized(sessionId);

    // First create a box to measure.
    const addResult = await mcpCallTool(sessionId, 'add_box', {
      size: [2, 2, 2],
      position: [0, 0, 0],
    });

    // Extract entity id from the "Affected entity ids: ..." block.
    const affectedBlock = addResult.content.find((c) =>
      c.text?.startsWith('Affected entity ids:'),
    );
    expect(affectedBlock).toBeDefined();
    const entityId = affectedBlock!.text!.replace('Affected entity ids:', '').trim();
    expect(entityId.length).toBeGreaterThan(0);

    // Measure volume via MCP.
    const measureResult = await mcpCallTool(sessionId, 'measure_volume', { entityId });

    expect(measureResult.isError).toBeFalsy();

    // The json block starts with ```json
    const jsonBlock = measureResult.content.find((c) => c.text?.startsWith('```json'));
    expect(jsonBlock).toBeDefined();
    expect(jsonBlock!.text).toContain('"volume"');

    // structuredContent must be present with volume + unit fields
    expect(measureResult.structuredContent).toBeDefined();
    expect(typeof measureResult.structuredContent!['volume']).toBe('number');
    expect(measureResult.structuredContent!['unit']).toBe('mm³');
    // 2×2×2 box = volume 8
    expect(measureResult.structuredContent!['volume']).toBeCloseTo(8);
  });

  it('query does NOT mutate the live document', async () => {
    const sessionId = await mcpInitialize();
    await mcpNotifyInitialized(sessionId);

    await mcpCallTool(sessionId, 'add_box', { size: [1, 1, 1], position: [0, 0, 0] });
    const entityId = Object.keys(getLiveDoc().entities)[0]!;

    const docBefore = getLiveDoc();
    await mcpCallTool(sessionId, 'measure_volume', { entityId });

    // Same reference — query did not swap the live document.
    expect(getLiveDoc()).toBe(docBefore);
  });
});

// ---------------------------------------------------------------------------
// (e) MCP tools/call mutation → REST /undo reverts it (shared history interop)
// ---------------------------------------------------------------------------

describe('MCP tools/call + REST /undo interop', () => {
  it('POST /undo after MCP add_box reverts the entity (shared history)', async () => {
    const sessionId = await mcpInitialize();
    await mcpNotifyInitialized(sessionId);

    // MCP call mutates the live document via the command bus.
    await mcpCallTool(sessionId, 'add_box', { size: [4, 4, 4], position: [0, 0, 0] });
    expect(Object.keys(getLiveDoc().entities)).toHaveLength(1);

    // REST /undo — same command bus, same undo stack.
    const undoRes = await request(app).post('/undo').send();
    expect(undoRes.status).toBe(200);
    expect(undoRes.body.summary).toBe('Undid last change.');
    expect(undoRes.body.canRedo).toBe(true);

    // Entity is gone — MCP mutation was reverted by REST undo.
    expect(Object.keys(getLiveDoc().entities)).toHaveLength(0);
  });

  it('two MCP mutations then two REST undos restore empty document', async () => {
    const sessionId = await mcpInitialize();
    await mcpNotifyInitialized(sessionId);

    await mcpCallTool(sessionId, 'add_box', { size: [1, 1, 1], position: [0, 0, 0] });
    await mcpCallTool(sessionId, 'add_box', { size: [2, 2, 2], position: [5, 0, 0] });
    expect(Object.keys(getLiveDoc().entities)).toHaveLength(2);

    await request(app).post('/undo').send();
    expect(Object.keys(getLiveDoc().entities)).toHaveLength(1);

    await request(app).post('/undo').send();
    expect(Object.keys(getLiveDoc().entities)).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// (g) tools/call render_view → image block present, no raw SVG in any text block
// ---------------------------------------------------------------------------

describe('MCP tools/call — render_view (SVG stripping)', () => {
  it('response contains an image block', { timeout: 15000 }, async () => {
    const sessionId = await mcpInitialize();
    await mcpNotifyInitialized(sessionId);

    // Add a box so the render has something to draw.
    await mcpCallTool(sessionId, 'add_box', { size: [2, 2, 2], position: [0, 0, 0] });

    const result = await mcpCallTool(sessionId, 'render_view', {});

    const imageBlocks = result.content.filter((b) => b.type === 'image');
    expect(imageBlocks.length).toBeGreaterThanOrEqual(1);
  });

  it('no text block contains raw SVG markup (<svg or <polygon)', { timeout: 15000 }, async () => {
    const sessionId = await mcpInitialize();
    await mcpNotifyInitialized(sessionId);

    await mcpCallTool(sessionId, 'add_box', { size: [2, 2, 2], position: [0, 0, 0] });

    const result = await mcpCallTool(sessionId, 'render_view', {});

    const textBlocks = result.content.filter((b) => b.type === 'text');
    for (const block of textBlocks) {
      expect(block.text ?? '').not.toMatch(/<svg/i);
      expect(block.text ?? '').not.toMatch(/<polygon/i);
    }
  });

  it('json metadata block still contains useful fields (not svg)', { timeout: 15000 }, async () => {
    const sessionId = await mcpInitialize();
    await mcpNotifyInitialized(sessionId);

    await mcpCallTool(sessionId, 'add_box', { size: [2, 2, 2], position: [0, 0, 0] });

    const result = await mcpCallTool(sessionId, 'render_view', {});

    const jsonBlock = result.content.find((b) => b.text?.startsWith('```json'));
    expect(jsonBlock).toBeDefined();
    // Metadata fields that agents actually use must be present.
    expect(jsonBlock!.text).toMatch(/"width"/);
    expect(jsonBlock!.text).toMatch(/"height"/);
    // The raw svg key must not appear.
    expect(jsonBlock!.text).not.toMatch(/"svg"/);
  });

  it('structuredContent does not contain svg key', { timeout: 15000 }, async () => {
    const sessionId = await mcpInitialize();
    await mcpNotifyInitialized(sessionId);

    await mcpCallTool(sessionId, 'add_box', { size: [2, 2, 2], position: [0, 0, 0] });

    const result = await mcpCallTool(sessionId, 'render_view', {});

    if (result.structuredContent !== undefined) {
      expect('svg' in result.structuredContent).toBe(false);
    }
  });

  it('normal mutation (add_box) still works unchanged — regression', async () => {
    const sessionId = await mcpInitialize();
    await mcpNotifyInitialized(sessionId);

    const result = await mcpCallTool(sessionId, 'add_box', {
      size: [1, 1, 1],
      position: [0, 0, 0],
    });

    expect(result.isError).toBeFalsy();
    // No image block for non-SVG results.
    expect(result.content.filter((b) => b.type === 'image')).toHaveLength(0);
    // Summary and affected blocks present.
    expect(result.content[0]!.type).toBe('text');
    expect(result.content.some((b) => b.text?.startsWith('Affected entity ids:'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// (f) Unknown tool name → isError:true
// ---------------------------------------------------------------------------

describe('MCP tools/call — unknown tool name', () => {
  it('returns isError:true with an explanatory summary content block', async () => {
    const sessionId = await mcpInitialize();
    await mcpNotifyInitialized(sessionId);

    const result = await mcpCallTool(sessionId, 'totally_nonexistent_tool', {});

    expect(result.isError).toBe(true);
    expect(result.content.length).toBeGreaterThanOrEqual(1);
    expect(result.content[0]!.type).toBe('text');
    expect(result.content[0]!.text).toMatch(/unknown command/i);
  });
});
