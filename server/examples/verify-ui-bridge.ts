/* eslint-disable no-console -- this is a runnable CLI verification script; console output is its product. */
/**
 * @layer server/examples
 *
 * Verification script for the KI1-followup UI↔MCP live-sync bridge.
 *
 * What it verifies:
 *   1. POST /ui-bridge/push  — stage a fake CadDocument as the "live UI doc".
 *   2. snapshot_in_from_ui   — agent pulls the UI doc into its MCP session.
 *   3. add_box               — mutate the session document via a normal command.
 *   4. snapshot_out_to_ui    — agent stages the session doc back for the UI.
 *   5. POST /ui-bridge/pull  — retrieve the staged document; confirm the box is present.
 *
 * Run (server must be started first):
 *   npm --prefix server run verify:ui-bridge
 *
 * Optional env vars:
 *   SERVER_URL      base URL of the llull server  (default: http://localhost:3001)
 *   MCP_AUTH_TOKEN  Bearer token, if the server requires one
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { createEmptyDocument } from '@core/model/types';
import type { CadDocument } from '@core/model/types';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface TextContent {
  type: 'text';
  text: string;
}

type ContentItem = TextContent | { type: string };

function isTextContent(item: ContentItem): item is TextContent {
  return item.type === 'text' && typeof (item as TextContent).text === 'string';
}

interface ParsedToolResult {
  summary: string;
  affected: string[];
  isError: boolean;
}

function parseToolResult(result: {
  content: ContentItem[];
  isError?: boolean;
}): ParsedToolResult {
  const texts = result.content.filter(isTextContent).map((c) => c.text);
  const summary = texts[0] ?? '(no summary)';
  const affectedLine = texts.find((t) => t.startsWith('Affected entity ids:'));
  const affected: string[] = affectedLine
    ? affectedLine.replace('Affected entity ids:', '').trim().split(/,\s*/)
    : [];
  return { summary, affected, isError: result.isError === true };
}

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

async function httpPost(
  url: string,
  body: unknown,
  authToken: string | undefined,
): Promise<unknown> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (authToken) headers['Authorization'] = `Bearer ${authToken}`;

  const res = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });

  const text = await res.text();
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} from ${url}: ${text}`);
  }

  return JSON.parse(text) as unknown;
}

// ---------------------------------------------------------------------------
// Assertion helper
// ---------------------------------------------------------------------------

function assert(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(`ASSERTION FAILED: ${message}`);
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const serverUrl = process.env['SERVER_URL'] ?? 'http://localhost:3001';
  const mcpUrl = `${serverUrl}/mcp`;
  const authToken = process.env['MCP_AUTH_TOKEN'];

  console.log(`Verifying UI↔MCP bridge at ${serverUrl} ...\n`);

  // --------------------------------------------------------------------------
  // Step 1: POST /ui-bridge/push — push a fake CadDocument as the live UI doc
  // --------------------------------------------------------------------------

  // Build a minimal CadDocument with a known structure (no entities).
  const fakeUiDoc: CadDocument = createEmptyDocument();

  console.log('Step 1: POST /ui-bridge/push');
  const pushResult = (await httpPost(
    `${serverUrl}/ui-bridge/push`,
    fakeUiDoc,
    authToken,
  )) as { ok: boolean; summary: string };

  assert(pushResult.ok === true, `push should succeed (got: ${JSON.stringify(pushResult)})`);
  console.log(`  ok: ${pushResult.ok}`);
  console.log(`  summary: ${pushResult.summary}\n`);

  // --------------------------------------------------------------------------
  // Step 2: Connect MCP client
  // --------------------------------------------------------------------------

  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (authToken) headers['Authorization'] = `Bearer ${authToken}`;

  const transport = new StreamableHTTPClientTransport(new URL(mcpUrl), {
    requestInit: { headers },
  });

  const client = new Client(
    { name: 'llull-verify-ui-bridge', version: '0.1.0' },
    { capabilities: {} },
  );

  console.log(`Connecting MCP client to ${mcpUrl} ...`);
  try {
    await client.connect(transport as Transport);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(
      `\nFailed to connect: ${msg}\n\n` +
        'Is the server running? Start it with:\n' +
        '  npm --prefix server run dev\n',
    );
    process.exit(1);
  }
  console.log('Connected.\n');

  // --------------------------------------------------------------------------
  // Step 3: Verify bridge tools appear in tools/list
  // --------------------------------------------------------------------------

  console.log('Step 3: tools/list — checking bridge tools are present');
  const { tools } = await client.listTools();
  const toolNames = tools.map((t) => t.name);

  const hasSnapshotIn = toolNames.includes('snapshot_in_from_ui');
  const hasSnapshotOut = toolNames.includes('snapshot_out_to_ui');

  assert(hasSnapshotIn, `snapshot_in_from_ui should be in tools/list (got: ${toolNames.join(', ')})`);
  assert(hasSnapshotOut, `snapshot_out_to_ui should be in tools/list (got: ${toolNames.join(', ')})`);

  console.log(`  Total tools: ${tools.length}`);
  console.log(`  snapshot_in_from_ui: present ✓`);
  console.log(`  snapshot_out_to_ui: present ✓\n`);

  // Check annotations
  const snapshotInTool = tools.find((t) => t.name === 'snapshot_in_from_ui');
  const snapshotOutTool = tools.find((t) => t.name === 'snapshot_out_to_ui');

  assert(
    snapshotInTool?.annotations?.readOnlyHint === true,
    'snapshot_in_from_ui should have readOnlyHint:true',
  );
  assert(
    snapshotOutTool?.annotations?.destructiveHint === true,
    'snapshot_out_to_ui should have destructiveHint:true',
  );
  console.log('  Annotations: readOnlyHint + destructiveHint ✓\n');

  // --------------------------------------------------------------------------
  // Step 4: snapshot_in_from_ui — pull UI doc into session
  // --------------------------------------------------------------------------

  console.log('Step 4: snapshot_in_from_ui — pull UI doc into session');
  const snapshotInRaw = await client.callTool({ name: 'snapshot_in_from_ui', arguments: {} });
  const snapshotInResult = parseToolResult(
    snapshotInRaw as { content: ContentItem[]; isError?: boolean },
  );

  assert(!snapshotInResult.isError, `snapshot_in_from_ui should not be an error`);
  assert(
    snapshotInResult.summary.includes('snapshot_in_from_ui'),
    `summary should mention the tool name`,
  );
  console.log(`  summary: ${snapshotInResult.summary}`);
  console.log(`  isError: ${snapshotInResult.isError} ✓\n`);

  // --------------------------------------------------------------------------
  // Step 5: add_box — mutate the session document
  // --------------------------------------------------------------------------

  console.log('Step 5: add_box — add a box to the session document');
  const boxRaw = await client.callTool({
    name: 'add_box',
    arguments: { size: [3, 3, 3], position: [1, 0, 0] },
  });
  const boxResult = parseToolResult(boxRaw as { content: ContentItem[]; isError?: boolean });

  assert(!boxResult.isError, `add_box should not be an error`);
  assert(boxResult.affected.length === 1, `add_box should affect exactly one entity`);
  const boxId = boxResult.affected[0] as string;
  console.log(`  boxId: ${boxId}`);
  console.log(`  summary: ${boxResult.summary} ✓\n`);

  // --------------------------------------------------------------------------
  // Step 6: snapshot_out_to_ui — stage session doc for UI
  // --------------------------------------------------------------------------

  console.log('Step 6: snapshot_out_to_ui — stage session doc for UI');
  const snapshotOutRaw = await client.callTool({ name: 'snapshot_out_to_ui', arguments: {} });
  const snapshotOutResult = parseToolResult(
    snapshotOutRaw as { content: ContentItem[]; isError?: boolean },
  );

  assert(!snapshotOutResult.isError, `snapshot_out_to_ui should not be an error`);
  assert(
    snapshotOutResult.summary.includes('snapshot_out_to_ui'),
    `summary should mention the tool name`,
  );
  console.log(`  summary: ${snapshotOutResult.summary}`);
  console.log(`  isError: ${snapshotOutResult.isError} ✓\n`);

  // --------------------------------------------------------------------------
  // Step 7: POST /ui-bridge/pull — retrieve staged document
  // --------------------------------------------------------------------------

  console.log('Step 7: POST /ui-bridge/pull — retrieve staged document');
  const pullResult = (await httpPost(
    `${serverUrl}/ui-bridge/pull`,
    {},
    authToken,
  )) as { pending: boolean; document?: CadDocument };

  assert(pullResult.pending === true, `pull should have a pending document`);
  assert(pullResult.document !== undefined, `pull response should contain a document`);

  const pulledDoc = pullResult.document as CadDocument;
  const entityIds = Object.keys(pulledDoc.entities);

  console.log(`  pending: ${pullResult.pending} ✓`);
  console.log(`  entity count: ${entityIds.length}`);

  // The pulled document should contain the box we added.
  assert(entityIds.includes(boxId), `pulled document should contain the added box (id: ${boxId})`);
  const pulledBox = pulledDoc.entities[boxId];
  assert(pulledBox?.kind === 'box', `entity ${boxId} should be a box`);
  console.log(`  box (${boxId}) present in pulled document ✓\n`);

  // --------------------------------------------------------------------------
  // Step 8: second pull should return no pending doc (cleared after first pull)
  // --------------------------------------------------------------------------

  console.log('Step 8: POST /ui-bridge/pull again — should be empty');
  const pullResult2 = (await httpPost(
    `${serverUrl}/ui-bridge/pull`,
    {},
    authToken,
  )) as { pending: boolean };

  assert(pullResult2.pending === false, `second pull should have no pending document`);
  console.log(`  pending: ${pullResult2.pending} ✓\n`);

  // --------------------------------------------------------------------------
  // Done
  // --------------------------------------------------------------------------

  await client.close();
  console.log('All verifications passed. Client closed cleanly.\n');
  console.log('Summary:');
  console.log('  [1] /ui-bridge/push accepted a CadDocument ✓');
  console.log('  [2] MCP client connected ✓');
  console.log('  [3] Bridge tools in tools/list with correct annotations ✓');
  console.log('  [4] snapshot_in_from_ui pulled UI doc into session ✓');
  console.log('  [5] add_box mutated session document ✓');
  console.log('  [6] snapshot_out_to_ui staged session doc ✓');
  console.log('  [7] /ui-bridge/pull returned doc containing the new box ✓');
  console.log('  [8] second /ui-bridge/pull cleared the pending doc ✓');
}

main().catch((err: unknown) => {
  console.error('Verification FAILED:', err instanceof Error ? err.message : String(err));
  process.exit(1);
});
