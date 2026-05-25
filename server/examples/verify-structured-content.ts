/* eslint-disable no-console -- this is a runnable CLI verification script; console output is its product. */
/**
 * @layer server/examples
 *
 * Round-trip verification: `data`-producing commands surface `structuredContent`.
 *
 * Calls `describe_scene` over MCP and asserts:
 *   1. `structuredContent` is present and is a non-null object.
 *   2. `structuredContent` contains the expected `SceneSnapshot` fields
 *      (`entityCount`, `entities`, `layers`, `groups`, `bounds`, `selection`).
 *   3. A JSON text block is also present in `content` for text-only clients.
 *
 * Mutating commands (`add_box`) must NOT produce `structuredContent`.
 *
 * Run (server must be started first with `npm --prefix server run dev`):
 *   npx tsx server/examples/verify-structured-content.ts
 *
 * Optional env vars:
 *   MCP_URL         override the server URL  (default: http://localhost:3001/mcp)
 *   MCP_AUTH_TOKEN  Bearer token, if the server requires one
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ContentBlock {
  type: string;
  [key: string]: unknown;
}

interface RawToolResult {
  content: ContentBlock[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

// ---------------------------------------------------------------------------
// Assertion helper
// ---------------------------------------------------------------------------

let passed = 0;
let failed = 0;

function assert(condition: boolean, label: string, detail?: string): void {
  if (condition) {
    console.log(`  [PASS] ${label}`);
    passed++;
  } else {
    console.error(`  [FAIL] ${label}${detail ? ` — ${detail}` : ''}`);
    failed++;
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const mcpUrl = process.env['MCP_URL'] ?? 'http://localhost:3001/mcp';
  const authToken = process.env['MCP_AUTH_TOKEN'];

  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (authToken) headers['Authorization'] = `Bearer ${authToken}`;

  const transport = new StreamableHTTPClientTransport(new URL(mcpUrl), {
    requestInit: { headers },
  });

  const client = new Client(
    { name: 'llull-verify-structured-content', version: '0.1.0' },
    { capabilities: {} },
  );

  console.log(`Connecting to llull MCP server at ${mcpUrl} ...`);
  try {
    await client.connect(transport as Transport);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`Failed to connect: ${msg}\nIs the server running?`);
    process.exit(1);
  }
  console.log('Connected.\n');

  // ---------------------------------------------------------------------------
  // Test 1: describe_scene produces structuredContent
  // ---------------------------------------------------------------------------
  console.log('--- Test 1: describe_scene → structuredContent present ---');
  const sceneRaw = await client.callTool({ name: 'describe_scene', arguments: {} });
  const scene = sceneRaw as RawToolResult;

  console.log('\nRaw tool result:');
  console.log(JSON.stringify(scene, null, 2));

  console.log('\nAssertions:');
  assert(
    scene.structuredContent !== undefined && scene.structuredContent !== null,
    'structuredContent is present',
    `got: ${JSON.stringify(scene.structuredContent)}`,
  );
  assert(
    typeof scene.structuredContent === 'object' &&
      scene.structuredContent !== null &&
      !Array.isArray(scene.structuredContent),
    'structuredContent is a non-null, non-array object (MCP record)',
  );

  const sc = scene.structuredContent ?? {};
  const snapshotKeys = ['entityCount', 'entities', 'layers', 'groups', 'bounds', 'selection'];
  for (const key of snapshotKeys) {
    assert(key in sc, `structuredContent has key: ${key}`);
  }

  // JSON text block check
  const textBlocks = scene.content.filter((c) => c.type === 'text');
  const jsonBlock = textBlocks.find((c) => typeof c['text'] === 'string' && (c['text'] as string).includes('```json'));
  assert(jsonBlock !== undefined, 'content includes a ```json text block for text-only clients');

  // ---------------------------------------------------------------------------
  // Test 2: add_box (mutating) does NOT produce structuredContent
  // ---------------------------------------------------------------------------
  console.log('\n--- Test 2: add_box → structuredContent absent ---');
  const boxRaw = await client.callTool({
    name: 'add_box',
    arguments: { size: [1, 1, 1], position: [0, 0, 0] },
  });
  const box = boxRaw as RawToolResult;

  console.log('\nRaw tool result:');
  console.log(JSON.stringify(box, null, 2));

  console.log('\nAssertions:');
  assert(
    box.structuredContent === undefined,
    'structuredContent absent for mutating command',
    `got: ${JSON.stringify(box.structuredContent)}`,
  );

  // ---------------------------------------------------------------------------
  // Test 3: describe_scene after add_box shows entityCount increased by 1
  // ---------------------------------------------------------------------------
  console.log('\n--- Test 3: describe_scene after add_box → entityCount increased by 1 ---');
  const beforeCount = typeof sc['entityCount'] === 'number' ? sc['entityCount'] : 0;
  const scene2Raw = await client.callTool({ name: 'describe_scene', arguments: {} });
  const scene2 = scene2Raw as RawToolResult;
  const sc2 = (scene2.structuredContent ?? {}) as { entityCount?: unknown };
  const afterCount = typeof sc2.entityCount === 'number' ? sc2.entityCount : -1;

  console.log('\nAssertions:');
  assert(
    afterCount === beforeCount + 1,
    `entityCount increased by 1 (before: ${beforeCount}, after: ${afterCount})`,
  );

  // ---------------------------------------------------------------------------
  // Summary
  // ---------------------------------------------------------------------------
  await client.close();
  console.log(`\n--- Summary: ${passed} passed, ${failed} failed ---`);
  if (failed > 0) process.exit(1);
}

main().catch((err: unknown) => {
  console.error('Unhandled error:', err instanceof Error ? err.message : String(err));
  process.exit(1);
});
