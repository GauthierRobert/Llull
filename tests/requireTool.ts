/**
 * Required-tool lanes (TR-INT-13). A suite that needs an external tool (CalculiX, a python with CadQuery / OCP, a native llull-* binary,
 * an oracle program) declares it with `describe.skipIf(requireTool('calculix', hasCcx))`. The call returns the skip condition and records
 * the skip per worker under `.cache/test-skips/<run>/`; `tests/requireToolTeardown.ts` (vitest globalSetup of the root, server and desktop
 * configs) prints the counts and fails the run (`TST_REQUIRED_TOOL_SKIPPED`) when `LLULL_REQUIRE_TOOLS` lists a tool that caused skips.
 */
import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { threadId } from 'node:worker_threads';

/** `calculix`, `python`, `native` (any `native:<binary>`) or `oracle` (any `oracle:<program>`). */
export type ToolId = 'calculix' | 'python' | `native:${string}` | `oracle:${string}`;
export type ToolFamily = 'calculix' | 'python' | 'native' | 'oracle';

export const TOOL_FAMILIES: readonly ToolFamily[] = ['calculix', 'python', 'native', 'oracle'];
export const SKIP_RUN_ENV = 'LLULL_TEST_SKIPS_RUN';

export interface SkipRecord {
  readonly tool: string;
  readonly family: ToolFamily;
}

export function skipRoot(): string {
  return join(dirname(fileURLToPath(import.meta.url)), '..', '.cache', 'test-skips');
}

export function toolFamily(tool: ToolId): ToolFamily {
  return tool.split(':')[0] as ToolFamily;
}

/** Returns true when the suite must skip (`available` false) and records that skip against `tool`. */
export function requireTool(tool: ToolId, available: boolean): boolean {
  if (available) return false;
  const directory = join(skipRoot(), process.env[SKIP_RUN_ENV] ?? 'adhoc');
  const record: SkipRecord = { tool, family: toolFamily(tool) };
  try {
    mkdirSync(directory, { recursive: true });
    appendFileSync(join(directory, `${process.pid}-${threadId}.jsonl`), `${JSON.stringify(record)}\n`);
  } catch {
    // The skip still happens; only its accounting is lost (read-only checkout).
  }
  return true;
}

/** Several tools at once: every missing one is recorded (no short-circuit); true when any is missing. */
export function requireTools(tools: ReadonlyArray<readonly [ToolId, boolean]>): boolean {
  return tools.map(([tool, available]) => requireTool(tool, available)).some(Boolean);
}
