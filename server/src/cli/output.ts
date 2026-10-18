/**
 * How the `llull` CLI prints a result. Text mode reuses the MCP shaping (`shapeToolCallContent`:
 * the same size caps an agent gets over MCP); `--json` prints one machine-readable object.
 */

import { shapeToolCallContent } from '@mcp/index';
import { isRecord } from '@lib/isRecord';
import type { CommandOutcome } from '@mcp/restProtocol';
import { formatDuration } from './progress';
import type { SavedFile } from './saveFiles';
import { aliasLine, type PlanAliases } from './aliases';

/** Affected ids printed per plan step in text mode. */
const STEP_IDS_SHOWN = 4;

/** Plan steps at least this slow show their duration in text mode (all do in `--json`). */
const STEP_DURATION_SHOWN_MS = 1000;

export interface PrintableResult extends CommandOutcome {
  readonly saved?: readonly SavedFile[];
  /** `run` only: the plan's `as` aliases that survive in the final document. */
  readonly planAliases?: PlanAliases;
  /** `run --validate` only: advisory warnings that do not fail the dry run. */
  readonly warnings?: readonly string[];
}

/** The full result as one JSON object (`--json`). */
export function resultJson(result: PrintableResult): string {
  return JSON.stringify({
    ok: !result.isError,
    summary: result.summary,
    affected: result.affected,
    changed: result.changed,
    ...(result.data !== undefined ? { data: result.data } : {}),
    ...(result.error !== undefined ? { error: result.error } : {}),
    ...(result.saved !== undefined ? { saved: result.saved } : {}),
    ...(result.warnings !== undefined ? { warnings: result.warnings } : {}),
    ...(result.planAliases !== undefined ? { aliases: result.planAliases.aliases, consumedAliases: result.planAliases.consumed } : {}),
  });
}

function savedLines(saved: readonly SavedFile[] | undefined): string[] {
  return (saved ?? []).map((file) => `Saved ${file.path} (${file.bytes} bytes)${file.note === undefined ? '' : ` -- ${file.note}`}`);
}

/** Summary, affected ids and the data block, as an MCP agent would read them. */
export function resultText(result: PrintableResult): string {
  const shaped = shapeToolCallContent({
    summary: result.summary,
    affected: [...result.affected],
    isError: result.isError,
    data: result.data,
    ...(result.error !== undefined ? { error: result.error } : {}),
  });
  return [...shaped.content.map((block) => block.text), ...savedLines(result.saved)].join('\n');
}

function stepLine(step: unknown): string | null {
  if (!isRecord(step)) return null;
  const ids = Array.isArray(step['affected']) ? step['affected'].map(String) : [];
  const shown = ids.slice(0, STEP_IDS_SHOWN).join(', ');
  const more = ids.length > STEP_IDS_SHOWN ? ` +${ids.length - STEP_IDS_SHOWN}` : '';
  const status = step['ok'] === true ? 'ok  ' : 'FAIL';
  const took =
    typeof step['durationMs'] === 'number' && step['durationMs'] >= STEP_DURATION_SHOWN_MS
      ? ` [${formatDuration(step['durationMs'])}]`
      : '';
  return `  #${String(step['index'])} ${status} ${String(step['command'])}${took}: ${String(step['summary'])}${ids.length > 0 ? ` -> ${shown}${more}` : ''}`;
}

/**
 * A `build_project` report, one line per step (the final scene snapshot is left to `--json` or
 * `exec describe_scene`, so a 300-step plan stays readable).
 */
export function planText(result: PrintableResult): string {
  const data = result.data;
  if (!isRecord(data) || !Array.isArray(data['steps'])) return resultText(result);
  const issues = Array.isArray(data['issues']) ? data['issues'].map((i) => `  ! ${String(i)}`) : [];
  const aliases = result.planAliases === undefined ? null : aliasLine(result.planAliases);
  return [
    result.summary,
    ...data['steps'].map(stepLine).filter((line): line is string => line !== null),
    ...issues,
    ...(result.warnings ?? []).map((warning) => `  warning: ${warning}`),
    ...(aliases ? [aliases] : []),
  ].join('\n');
}
