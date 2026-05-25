/* eslint-disable no-console -- verification script; console output is its product. */
/**
 * @layer server/examples
 *
 * Verification script — MCP prompts/list + prompts/get round-trip.
 *
 * Confirms that:
 *   1. `prompts/list` returns the 3 registered templates.
 *   2. `prompts/get` for each template returns messages with role + text content.
 *   3. `prompts/get` for an unknown name throws / surfaces an error gracefully.
 *   4. Existing tools/list still works (regression guard).
 *
 * Run (server must be started first with `npm --prefix server run dev`):
 *   npx tsx server/examples/verify-prompts.ts
 *
 * Optional env vars:
 *   MCP_URL         override server URL (default: http://localhost:3001/mcp)
 *   MCP_AUTH_TOKEN  Bearer token, if the server requires one
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface PromptArgument {
  name: string;
  description: string;
  required?: boolean;
}

interface PromptDescriptor {
  name: string;
  description: string;
  arguments?: PromptArgument[];
}

interface PromptMessage {
  role: string;
  content: { type: string; text?: string };
}

interface GetPromptResult {
  description?: string;
  messages: PromptMessage[];
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
    { name: 'llull-verify-prompts', version: '0.1.0' },
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
  // Test 1: prompts/list
  // ---------------------------------------------------------------------------
  console.log('--- Test 1: prompts/list ---');
  const listResult = await client.listPrompts();
  const prompts = listResult.prompts as PromptDescriptor[];

  console.log(`\nprompts/list raw result:`);
  console.log(JSON.stringify(listResult, null, 2));

  console.log('\nAssertions:');
  assert(Array.isArray(prompts), 'prompts is an array');
  assert(prompts.length === 3, `exactly 3 prompts registered (got ${prompts.length})`);

  const expectedNames = ['model_bracket', 'orthographic_setup', 'parametric_part'];
  const returnedNames = prompts.map((p) => p.name);
  for (const name of expectedNames) {
    assert(returnedNames.includes(name), `prompts includes "${name}"`);
  }

  for (const p of prompts) {
    assert(p.name.length > 0, `prompt "${p.name}" has non-empty name`);
    assert(p.description.length > 0, `prompt "${p.name}" has non-empty description`);
  }

  // ---------------------------------------------------------------------------
  // Test 2: prompts/get — model_bracket
  // ---------------------------------------------------------------------------
  console.log('\n--- Test 2: prompts/get — model_bracket ---');
  const bracketRaw = await client.getPrompt({
    name: 'model_bracket',
    arguments: { width: '100', height: '50', thickness: '8', hole_count: '2' },
  });
  const bracket = bracketRaw as GetPromptResult;

  console.log('\nprompts/get model_bracket raw result:');
  console.log(JSON.stringify(bracket, null, 2));

  console.log('\nAssertions:');
  assert(Array.isArray(bracket.messages), 'bracket result has messages array');
  assert(bracket.messages.length >= 2, `at least 2 messages (got ${bracket.messages.length})`);
  assert(bracket.messages[0]?.role === 'user', 'first message role is "user"');
  assert(bracket.messages[1]?.role === 'assistant', 'second message role is "assistant"');

  const assistantText = bracket.messages.find((m) => m.role === 'assistant')?.content.text ?? '';
  assert(assistantText.includes('build_project'), 'assistant text mentions build_project');
  assert(assistantText.includes('draw_rectangle'), 'assistant text mentions draw_rectangle');
  assert(assistantText.includes('extrude_sketch'), 'assistant text mentions extrude_sketch');
  assert(assistantText.includes('boolean_subtract'), 'assistant text mentions boolean_subtract');
  assert(assistantText.includes('set_entity_name'), 'assistant text mentions set_entity_name');

  // ---------------------------------------------------------------------------
  // Test 3: prompts/get — orthographic_setup
  // ---------------------------------------------------------------------------
  console.log('\n--- Test 3: prompts/get — orthographic_setup ---');
  const orthoRaw = await client.getPrompt({
    name: 'orthographic_setup',
    arguments: { view: 'front' },
  });
  const ortho = orthoRaw as GetPromptResult;

  console.log('\nprompts/get orthographic_setup raw result:');
  console.log(JSON.stringify(ortho, null, 2));

  console.log('\nAssertions:');
  assert(ortho.messages.length >= 2, `at least 2 messages (got ${ortho.messages.length})`);
  const orthoText = ortho.messages.find((m) => m.role === 'assistant')?.content.text ?? '';
  assert(orthoText.includes('describe_scene'), 'assistant text mentions describe_scene');
  assert(orthoText.includes('find_entities'), 'assistant text mentions find_entities');
  assert(/FRONT/i.test(orthoText), 'assistant text mentions FRONT direction');

  // ---------------------------------------------------------------------------
  // Test 4: prompts/get — parametric_part
  // ---------------------------------------------------------------------------
  console.log('\n--- Test 4: prompts/get — parametric_part ---');
  const partRaw = await client.getPrompt({
    name: 'parametric_part',
    arguments: { part_name: 'flange_plate' },
  });
  const part = partRaw as GetPromptResult;

  console.log('\nprompts/get parametric_part raw result:');
  console.log(JSON.stringify(part, null, 2));

  console.log('\nAssertions:');
  assert(part.messages.length >= 2, `at least 2 messages (got ${part.messages.length})`);
  const partText = part.messages.find((m) => m.role === 'assistant')?.content.text ?? '';
  assert(partText.includes('build_project'), 'assistant text mentions build_project');
  assert(partText.includes('boolean_subtract'), 'assistant text mentions boolean_subtract');
  assert(partText.includes('validate'), 'assistant text mentions validate dry-run');

  const userText = part.messages.find((m) => m.role === 'user')?.content.text ?? '';
  assert(userText.includes('flange_plate'), 'user message substitutes part_name arg');

  // ---------------------------------------------------------------------------
  // Test 5: prompts/get — unknown name (expect error)
  // ---------------------------------------------------------------------------
  console.log('\n--- Test 5: prompts/get — unknown prompt name (expect error) ---');
  let unknownErrored = false;
  try {
    await client.getPrompt({ name: 'nonexistent_prompt_xyz', arguments: {} });
  } catch {
    unknownErrored = true;
  }
  assert(unknownErrored, 'unknown prompt name throws / returns MCP error');

  // ---------------------------------------------------------------------------
  // Test 6: tools/list still works (regression guard)
  // ---------------------------------------------------------------------------
  console.log('\n--- Test 6: tools/list regression guard ---');
  const { tools } = await client.listTools();
  assert(tools.length > 0, `tools/list still returns tools (got ${tools.length})`);

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
