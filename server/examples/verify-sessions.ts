/* eslint-disable no-console -- verification script; console output is its product. */
/**
 * @layer server/examples
 *
 * Session-isolation + idle-TTL eviction verification script.
 *
 * Opens TWO independent MCP client sessions (A and B) concurrently, then:
 *   1. Both sessions start with empty documents (entityCount = 0).
 *   2. Adds a box in session A; session B remains at 0 (isolation).
 *   3. Session B is independently mutable (adds its own entities, A unaffected).
 *   4. Idle-TTL eviction: abandon both sessions (client.close without DELETE),
 *      wait past the TTL + one sweep interval, then probe with the stale ids —
 *      both must return 404 (sessions evicted from the Map by the sweep).
 *
 * HTTP cannot reliably detect a vanished client, so eviction is EVENTUAL — it
 * happens on the next sweep tick after the session's TTL has elapsed.
 * This test runs with SHORT TTL/sweep values to verify that path in seconds
 * rather than minutes.  Start the server with matching env vars:
 *
 *   MCP_SESSION_TTL_MS=2000 MCP_SESSION_SWEEP_MS=500 npm --prefix server run dev
 *
 * Then run this script:
 *   npx tsx server/examples/verify-sessions.ts
 *
 * Optional env vars (client side):
 *   MCP_URL              override server URL (default: http://localhost:3001/mcp)
 *   MCP_AUTH_TOKEN       Bearer token, if the server requires one
 *   MCP_SESSION_TTL_MS   must match the server value (default: 2000 for this test)
 *   MCP_SESSION_SWEEP_MS must match the server value (default: 500 for this test)
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
// Helpers
// ---------------------------------------------------------------------------

/** Parse a positive integer env var, returning `fallback` when absent/invalid. */
function parsePosInt(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const n = parseInt(value, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
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
// MCP helpers
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
  // Test 4: idle-TTL eviction — eventual cleanup after client abandons session
  //
  // HTTP cannot reliably signal "client gone" — client.close() does NOT send an
  // HTTP DELETE and `transport.onclose` does not fire over stateless HTTP.
  // The idle-TTL sweep is the catch-all: it evicts sessions idle longer than
  // MCP_SESSION_TTL_MS.
  //
  // Strategy:
  //   1. Capture both session ids.
  //   2. Abandon both clients (close without DELETE) — sessions remain in the Map
  //      momentarily (this is expected — eviction is eventual).
  //   3. Wait for TTL + one sweep interval to pass.
  //   4. Probe with stale ids — the sweep must have removed them → 404.
  // ---------------------------------------------------------------------------

  console.log('\n--- Test 4: idle-TTL eviction (eventual cleanup) ---');

  // Capture session ids before abandoning
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

  // Abandon both sessions — no HTTP DELETE, just close the client transport.
  // The server does NOT know immediately; it will only learn via the TTL sweep.
  console.log('\n  Abandoning sessions (no DELETE) ...');
  await clientA.close();
  console.log('  Session A abandoned (client closed).');
  await clientB.close();
  console.log('  Session B abandoned (client closed).');

  // Determine the TTL + sweep values the server is running with.
  // Default to the SHORT values documented in the script header for fast testing.
  const ttlMs = parsePosInt(process.env['MCP_SESSION_TTL_MS'], 2_000);
  const sweepMs = parsePosInt(process.env['MCP_SESSION_SWEEP_MS'], 500);
  // Wait TTL + one full sweep interval + a small margin for clock jitter.
  const waitMs = ttlMs + sweepMs + 300;

  console.log(
    `\n  Waiting ${waitMs} ms for TTL (${ttlMs} ms) + sweep (${sweepMs} ms) to evict sessions ...`,
  );
  await new Promise<void>((resolve) => setTimeout(resolve, waitMs));

  // Probe: stale ids must now return 404 (sessions evicted by the sweep).
  const baseHeaders: Record<string, string> = { 'Content-Type': 'application/json' };
  if (authToken) baseHeaders['Authorization'] = `Bearer ${authToken}`;

  if (sessionIdA) {
    const probeA = await fetch(mcpUrl, {
      method: 'GET',
      headers: { ...baseHeaders, 'mcp-session-id': sessionIdA },
    });
    assert(
      probeA.status === 404,
      `session A evicted by TTL sweep (probe status ${probeA.status}, want 404)`,
      probeA.status !== 404
        ? 'session still in Map — is the server running with MCP_SESSION_TTL_MS=2000 MCP_SESSION_SWEEP_MS=500?'
        : undefined,
    );
  }

  if (sessionIdB) {
    const probeB = await fetch(mcpUrl, {
      method: 'GET',
      headers: { ...baseHeaders, 'mcp-session-id': sessionIdB },
    });
    assert(
      probeB.status === 404,
      `session B evicted by TTL sweep (probe status ${probeB.status}, want 404)`,
      probeB.status !== 404
        ? 'session still in Map — is the server running with MCP_SESSION_TTL_MS=2000 MCP_SESSION_SWEEP_MS=500?'
        : undefined,
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
