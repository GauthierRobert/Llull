/* eslint-disable no-console -- this is a runnable CLI demo; console output is its product. */
/**
 * @layer server/examples
 *
 * Standalone MCP agent script — end-to-end proof that an external agent can
 * drive the llull document over the MCP Streamable HTTP transport.
 *
 * What it does:
 *   1. Connects to the llull MCP server as an MCP Client.
 *   2. Calls tools/list and prints every registered tool name.
 *   3. Builds a small scene in sequence:
 *        add_box        → 2×2×2 box at origin
 *        draw_circle    → circle with radius 1 at center [0,0]
 *        extrude_sketch → extrudes the circle into a 3-unit solid
 *   4. Prints the summary text and affected entity ids for each call.
 *   5. Closes the client cleanly.
 *
 * Run (server must be started first):
 *   npm --prefix server run agent:example
 *
 * Optional env vars:
 *   MCP_URL         override the server URL  (default: http://localhost:3001/mcp)
 *   MCP_AUTH_TOKEN  Bearer token, if the server requires one
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';

// ---------------------------------------------------------------------------
// Types — narrow the loosely-typed SDK content array
// ---------------------------------------------------------------------------

interface TextContent {
  type: 'text';
  text: string;
}

type ContentItem = TextContent | { type: string };

function isTextContent(item: ContentItem): item is TextContent {
  return item.type === 'text' && typeof (item as TextContent).text === 'string';
}

// ---------------------------------------------------------------------------
// Parse tool result
// ---------------------------------------------------------------------------

interface ParsedToolResult {
  /** The command summary (first text block). */
  summary: string;
  /** Affected entity ids parsed from the second text block (may be empty). */
  affected: string[];
  isError: boolean;
}

function parseToolResult(result: {
  content: ContentItem[];
  isError?: boolean;
}): ParsedToolResult {
  const texts = result.content.filter(isTextContent).map((c) => c.text);

  const summary = texts[0] ?? '(no summary)';

  // The server appends "Affected entity ids: id1, id2" as a second text block.
  const affectedLine = texts.find((t) => t.startsWith('Affected entity ids:'));
  const affected: string[] = affectedLine
    ? affectedLine.replace('Affected entity ids:', '').trim().split(/,\s*/)
    : [];

  return { summary, affected, isError: result.isError === true };
}

// ---------------------------------------------------------------------------
// Pretty-print helpers
// ---------------------------------------------------------------------------

function printStep(step: number, toolName: string, result: ParsedToolResult): void {
  console.log(`\nStep ${step}: ${toolName}`);
  console.log(`  summary  : ${result.summary}`);
  if (result.affected.length > 0) {
    console.log(`  affected : ${result.affected.join(', ')}`);
  }
  if (result.isError) {
    console.warn('  [isError : true]');
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const mcpUrl = process.env['MCP_URL'] ?? 'http://localhost:3001/mcp';
  const authToken = process.env['MCP_AUTH_TOKEN'];

  // Build request headers — only add Authorization when token is provided.
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (authToken) {
    headers['Authorization'] = `Bearer ${authToken}`;
  }

  const transport = new StreamableHTTPClientTransport(new URL(mcpUrl), {
    requestInit: { headers },
  });

  const client = new Client(
    { name: 'llull-example-agent', version: '0.1.0' },
    { capabilities: {} },
  );

  // --- Connect ---
  console.log(`Connecting to llull MCP server at ${mcpUrl} ...`);
  // Cast to Transport: StreamableHTTPClientTransport's `sessionId` getter returns
  // `string | undefined`, which is incompatible with Transport's optional `sessionId?`
  // under exactOptionalPropertyTypes. The cast is safe — client.connect only reads the
  // shared Transport contract, not the concrete getter.
  try {
    await client.connect(transport as Transport);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(
      `\nFailed to connect: ${msg}\n\n` +
        'Is the server running? Start it with:\n' +
        '  npm --prefix server run dev\n' +
        '(optionally set MCP_AUTH_TOKEN to match the server.)',
    );
    process.exit(1);
  }

  console.log('Connected.\n');

  // --- Step 0: List tools ---
  const { tools } = await client.listTools();
  console.log(`tools/list → ${tools.length} tool(s) registered:`);
  tools.forEach((t) => console.log(`  - ${t.name}`));

  // --- Step 1: add_box ---
  const boxRaw = await client.callTool({
    name: 'add_box',
    arguments: { size: [2, 2, 2], position: [0, 0, 0] },
  });
  // callTool can return a compatibility shape; narrow to the content form.
  const boxResult = parseToolResult(boxRaw as { content: ContentItem[]; isError?: boolean });
  printStep(1, 'add_box', boxResult);

  // --- Step 2: draw_circle ---
  const circleRaw = await client.callTool({
    name: 'draw_circle',
    arguments: { center: [0, 0], radius: 1 },
  });
  const circleResult = parseToolResult(
    circleRaw as { content: ContentItem[]; isError?: boolean },
  );
  printStep(2, 'draw_circle', circleResult);

  // --- Step 3: extrude_sketch (uses the circle id from step 2) ---
  const circleId = circleResult.affected[0];
  if (!circleId) {
    console.error(
      '\nCould not find circle entity id in step 2 result — skipping extrude_sketch.',
    );
  } else {
    const extrudeRaw = await client.callTool({
      name: 'extrude_sketch',
      arguments: { id: circleId, depth: 3 },
    });
    const extrudeResult = parseToolResult(
      extrudeRaw as { content: ContentItem[]; isError?: boolean },
    );
    printStep(3, `extrude_sketch (source: ${circleId})`, extrudeResult);
  }

  // --- Done ---
  await client.close();
  console.log('\nDone. Client closed cleanly.');
}

main().catch((err: unknown) => {
  console.error('Unhandled error:', err instanceof Error ? err.message : String(err));
  process.exit(1);
});
