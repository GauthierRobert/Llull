/**
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
 */
export function runCommandOutcome(doc: CadDocument, name: string, params: unknown, ctx?: ExecutionContext): CommandRun {
  try {
    const result = execute(doc, name, params, ctx);
    return {
      document: result.document,
      outcome: {
        summary: result.summary,
        affected: result.affected,
        isError: result.rejected === true || result.error !== undefined,
        changed: result.document !== doc,
        ...(result.data !== undefined ? { data: result.data } : {}),
        ...(result.error !== undefined ? { error: result.error } : {}),
      },
    };
  } catch (error) {
    return { document: doc, outcome: failedOutcome(name, error) };
  }
}

/** The outcome of a command that threw (`execute` or the caller's own follow-up work). */
export function failedOutcome(name: string, error: unknown): CommandOutcome {
  return { summary: `Command ${name} failed: ${errorMessage(error)}`, affected: [], isError: true, changed: false };
}

/**
 * A result whose status a script can trust: besides a rejection, a command's own machine-readable refusal (`error`, e.g.
 * FAST_PITCH on a read-only query), a failed plan (`data.ok` false), a mutating command that changed nothing (a graceful no-op such as
 * "add_box failed: …") and a read-only command that answered nothing (no data, no ids: a refused query such as "mass_properties failed: …")
 * are failures — except setters (`idempotent`) and history meta-commands, which may change nothing. `mayNoop` overrides that for a
 * caller that knows better (clearing an empty document).
 */
export function outcomeIsFailure(name: string, outcome: CommandOutcome, mayNoop?: boolean): boolean {
  if (outcome.isError || outcome.error !== undefined) return true;
  if (isRecord(outcome.data) && outcome.data['ok'] === false) return true;
  if (outcome.changed || outcome.data !== undefined) return false;
  const annotations = getCommand(name)?.annotations;
  if (annotations?.readOnly === true) return outcome.affected.length === 0 && mayNoop !== true;
  return !(mayNoop ?? (annotations?.idempotent === true || annotations?.metaHistory === true));
}

/** `outcome` with `isError` raised when `outcomeIsFailure` says so: the one status every surface (REST, CLI) reports. */
export function withFailureStatus<T extends CommandOutcome>(name: string, outcome: T): T {
  return !outcome.isError && outcomeIsFailure(name, outcome) ? { ...outcome, isError: true } : outcome;
}
