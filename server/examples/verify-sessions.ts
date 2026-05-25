/* eslint-disable no-console -- verification script; console output is its product. */
/**
 * @layer server/examples
 *
 * Session-isolation verification script.
 *
 * Opens TWO independent MCP client sessions (A and B) concurrently, then:
 *   1. Adds a box in session A.
 *   2. Reads session A's document (describe_scene) — confirms entityCount = 1.
 *   3. Reads session B's document (describe_scene) — asserts entityCount = 0 (isolation).
 *   4. Closes both sessions cleanly.
 *   5. Verifies sessions were removed from the server Map (no transport leak):
 *      a GET with the old session id must return 404 after close.
 *
 * This proves that per-session documents do not share state AND that the sessions
 * Map does not leak entries when clients disconnect without sending DELETE.
 *
 * Run (server must be started first with `npm --prefix server run dev`):
 *   npx tsx server/examples/verify-sessions.ts
 *
 * Optional env vars:
 *   MCP_URL         override server URL (default: http://localhost:3001/mcp)
 *   MCP_AUTH_TOKEN  Bearer token, if the server requires one
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';

// ---------------------------------------------------------------------------
// SDK internals access (test script only — never in production code)
// ---------------------------------------------------------------------------

/**
 * Extract the session id from a connected `StreamableHTTPClientTransport`.
 * The field is private in the SDK but stable; we access it here only in the
 * verification script to assert Map cleanup after disconnect.
 */
function getClientSessionId(transport: StreamableHTTPClientTransport): string | undefined {
  return (transport as unknown as { _sessionId?: string })['_sessionId'];
}

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
// Client factory
// ---------------------------------------------------------------------------

function buildClient(name: string, mcpUrl: string, authToken?: string): {
  client: Client;
  transport: StreamableHTTPClientTransport;
} {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (authToken) headers['Authorization'] = `Bearer ${authToken}`;

  const transport = new StreamableHTTPClientTransport(new URL(mcpUrl), {
    requestInit: { headers },
  });

  const client = new Client({ name, version: '0.1.0' }, { capabilities: {} });
  return { client, transport };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Return the entityCount from a describe_scene structured result.
 * Returns -1 if the result is missing or malformed.
 */
async function getEntityCount(client: Client): Promise<number> {
  const raw = await client.callTool({ name: 'describe_scene', arguments: {} });
  const result = raw as RawToolResult;
  const sc = result.structuredContent;
  if (!sc || typeof sc['entityCount'] !== 'number') return -1;
  return sc['entityCount'];
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const mcpUrl = process.env['MCP_URL'] ?? 'http://localhost:3001/mcp';
  const authToken = process.env['MCP_AUTH_TOKEN'];

  // ---------------------------------------------------------------------------
  // Connect two independent sessions
  // ---------------------------------------------------------------------------

  const { client: clientA, transport: transportA } = buildClient(
    'llull-verify-sessions-A',
    mcpUrl,
    authToken,
  );
  const { client: clientB, transport: transportB } = buildClient(
    'llull-verify-sessions-B',
    mcpUrl,
    authToken,
  );

  console.log(`Connecting session A to ${mcpUrl} ...`);
  try {
    await clientA.connect(transportA as Transport);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`Session A failed to connect: ${msg}\nIs the server running?`);
    process.exit(1);
  }
  console.log('Session A connected.\n');

  console.log(`Connecting session B to ${mcpUrl} ...`);
  try {
    await clientB.connect(transportB as Transport);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`Session B failed to connect: ${msg}\nIs the server running?`);
    await clientA.close();
    process.exit(1);
  }
  console.log('Session B connected.\n');

  // ---------------------------------------------------------------------------
  // Test 1: both sessions start with empty documents
  // ---------------------------------------------------------------------------

  console.log('--- Test 1: both sessions start empty ---');
  const countA0 = await getEntityCount(clientA);
  const countB0 = await getEntityCount(clientB);
  assert(countA0 === 0, `session A starts with entityCount = 0 (got ${countA0})`);
  assert(countB0 === 0, `session B starts with entityCount = 0 (got ${countB0})`);

  // ---------------------------------------------------------------------------
  // Test 2: add a box in session A, verify A has 1 entity, B still has 0
  // ---------------------------------------------------------------------------

  console.log('\n--- Test 2: add_box in session A → B unaffected ---');
  const boxRaw = await clientA.callTool({
    name: 'add_box',
    arguments: { size: [1, 1, 1], position: [0, 0, 0] },
  });
  const box = boxRaw as RawToolResult;
  const boxOk = !box.isError;
  assert(boxOk, 'add_box succeeded in session A');

  const countA1 = await getEntityCount(clientA);
  const countB1 = await getEntityCount(clientB);

  console.log(`\n  Session A entityCount after add_box: ${countA1}`);
  console.log(`  Session B entityCount after add_box: ${countB1}`);

  assert(countA1 === 1, `session A entityCount is 1 after add_box (got ${countA1})`);
  assert(
    countB1 === 0,
    `session B entityCount is still 0 (isolation preserved, got ${countB1})`,
  );

  // ---------------------------------------------------------------------------
  // Test 3: session B is independently mutable (add its own entity)
  // ---------------------------------------------------------------------------

  console.log('\n--- Test 3: session B is independently mutable ---');
  await clientB.callTool({
    name: 'add_box',
    arguments: { size: [2, 2, 2], position: [5, 0, 0] },
  });
  await clientB.callTool({
    name: 'add_box',
    arguments: { size: [3, 3, 3], position: [10, 0, 0] },
  });

  const countA2 = await getEntityCount(clientA);
  const countB2 = await getEntityCount(clientB);

  console.log(`\n  Session A entityCount: ${countA2} (should still be 1)`);
  console.log(`  Session B entityCount: ${countB2} (should be 2)`);

  assert(countA2 === 1, `session A entityCount unchanged at 1 (got ${countA2})`);
  assert(countB2 === 2, `session B entityCount is 2 after 2× add_box (got ${countB2})`);

  // ---------------------------------------------------------------------------
  // Test 4: session Map cleanup — no transport leak after client.close()
  //
  // Before KI1 fix, client.close() did NOT trigger onsessionclosed (which only
  // fires on HTTP DELETE).  The transport.onclose wiring now covers this path.
  // We verify by: capture the session id, close the client, then probe the
  // server with a raw GET — the entry must be gone (404), not still alive.
  // ---------------------------------------------------------------------------

  console.log('\n--- Test 4: sessions Map cleaned up after client disconnect ---');

  // Capture session ids before closing
  const sessionIdA = getClientSessionId(transportA);
  const sessionIdB = getClientSessionId(transportB);

  assert(
    typeof sessionIdA === 'string' && sessionIdA.length > 0,
    `session A id captured: ${sessionIdA ?? '(none)'}`,
  );
  assert(
    typeof sessionIdB === 'string' && sessionIdB.length > 0,
    `session B id captured: ${sessionIdB ?? '(none)'}`,
  );

  // Close both clients (this triggers transport.onclose, NOT HTTP DELETE)
  console.log('\n--- Cleanup ---');
  await clientA.close();
  console.log('  Session A closed.');
  await clientB.close();
  console.log('  Session B closed.');

  // Give the server a moment to process the close event
  await new Promise<void>((resolve) => setTimeout(resolve, 200));

  // Probe: a GET with the now-stale session id must return 404 (entry removed)
  const baseHeaders: Record<string, string> = { 'Content-Type': 'application/json' };
  if (authToken) baseHeaders['Authorization'] = `Bearer ${authToken}`;

  if (sessionIdA) {
    const probeA = await fetch(mcpUrl, {
      method: 'GET',
      headers: { ...baseHeaders, 'mcp-session-id': sessionIdA },
    });
    assert(
      probeA.status === 404,
      `session A entry removed from Map after close (probe status ${probeA.status}, want 404)`,
      probeA.status !== 404 ? 'transport leak — session still in Map after client.close()' : undefined,
    );
  }

  if (sessionIdB) {
    const probeB = await fetch(mcpUrl, {
      method: 'GET',
      headers: { ...baseHeaders, 'mcp-session-id': sessionIdB },
    });
    assert(
      probeB.status === 404,
      `session B entry removed from Map after close (probe status ${probeB.status}, want 404)`,
      probeB.status !== 404 ? 'transport leak — session still in Map after client.close()' : undefined,
    );
  }

  // ---------------------------------------------------------------------------
  // Summary
  // ---------------------------------------------------------------------------

  console.log(`\n--- Summary: ${passed} passed, ${failed} failed ---`);
  if (failed > 0) process.exit(1);
}

main().catch((err: unknown) => {
  console.error('Unhandled error:', err instanceof Error ? err.message : String(err));
  process.exit(1);
});
