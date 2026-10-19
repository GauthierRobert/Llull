/**
 * Design-language errors: a stable code, the source line, what was wrong and one fix. Thrown inside the compiler / interpreter and turned
 * into a `CommandError` at the command boundary (commands never throw for user error).
 */

import { commandError } from '@core/commands/noop';
import type { CommandError } from '@core/commands/types';

export type DesignErrorCode =
  | 'DESIGN_SYNTAX'
  | 'DESIGN_UNKNOWN_COMMAND'
  | 'DESIGN_UNKNOWN_PARAM'
  | 'DESIGN_BAD_VALUE'
  | 'DESIGN_BAD_ENUM'
  | 'DESIGN_UNKNOWN_ALIAS'
  | 'DESIGN_ALIAS_CONSUMED'
  | 'DESIGN_UNKNOWN_ANCHOR'
  | 'DESIGN_UNIT_NOT_SUPPORTED'
  | 'DESIGN_UNKNOWN_PARAMETER'
  | 'DESIGN_LOOP_LIMIT'
  | 'DESIGN_STEP_FAILED'
  | 'DESIGN_CHECK_FAILED'
  | 'DESIGN_NO_DESIGN';

export class DesignError extends Error {
  constructor(
    readonly code: DesignErrorCode,
    readonly line: number,
    readonly detail: string,
    readonly fix: string,
  ) {
    super(line > 0 ? `line ${line}: ${detail}` : detail);
  }
}

/** `fn()`'s value, or the DesignError it threw (any other error propagates: a bug, not user input). */
export function attempt<T>(fn: () => T): T | DesignError {
  try {
    return fn();
  } catch (error) {
    if (error instanceof DesignError) return error;
    throw error;
  }
}

/** The machine-readable form of `error` (path `line N`). */
export function toCommandError(error: DesignError): CommandError {
  return commandError(error.code, error.fix, [], error.line > 0 ? [`line ${error.line}`] : []);
}
