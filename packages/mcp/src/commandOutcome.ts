/**
 * @layer mcp
 * The one way a host runs a command and reports it: `execute` + the `CommandOutcome` shape, and the
 * one definition of "this outcome is a failure". Used by the server command bus and the CLI backend.
 */

import type { CadDocument } from '@core/model/types';
import type { ExecutionContext } from '@core/commands/types';
import { execute, getCommand } from '@core/commands/registry';
import { errorMessage } from '@lib/errorMessage';
import { isRecord } from '@lib/isRecord';
import type { CommandOutcome } from './restProtocol';

export interface CommandRun {
  /** The document after the command (the input document when nothing changed or it threw). */
  readonly document: CadDocument;
  readonly outcome: CommandOutcome;
}

/**
 * Run `name` on `doc` through `execute`; a throwing command is an error outcome, never an exception.
 * `changed` = the returned document is not the input document.
 * @pure
 */
export function runCommandOutcome(
  doc: CadDocument,
  name: string,
  params: unknown,
  ctx?: ExecutionContext,
): CommandRun {
  try {
    const result = execute(doc, name, params, ctx);
    return {
      document: result.document,
      outcome: {
        summary: result.summary,
        affected: result.affected,
        isError: result.rejected === true,
        changed: result.document !== doc,
        ...(result.data !== undefined ? { data: result.data } : {}),
      },
    };
  } catch (error) {
    return {
      document: doc,
      outcome: {
        summary: `Command ${name} failed: ${errorMessage(error)}`,
        affected: [],
        isError: true,
        changed: false,
      },
    };
  }
}

/**
 * A result whose status a script can trust: besides a rejection, a failed plan (`data.ok` false)
 * and a mutating command that changed nothing (a graceful no-op such as "add_box failed: …") are
 * failures — except setters (`idempotent`), read-only and history meta-commands, which may change
 * nothing. `mayNoop` overrides that for a caller that knows better (clearing an empty document).
 * @pure
 */
export function outcomeIsFailure(
  name: string,
  outcome: CommandOutcome,
  mayNoop?: boolean,
): boolean {
  if (outcome.isError) return true;
  if (isRecord(outcome.data) && outcome.data['ok'] === false) return true;
  const annotations = getCommand(name)?.annotations;
  const noopAllowed =
    mayNoop ??
    (annotations?.readOnly === true ||
      annotations?.idempotent === true ||
      annotations?.metaHistory === true);
  return !noopAllowed && !outcome.changed && outcome.data === undefined;
}
