/** Refusals carrying a stable code, the offending ids/paths and a remediation (05 §7.1 pattern). */

import type { CadDocument } from '@core/model/types';
import { commandError, rejection } from '@core/commands/noop';
import type { CommandResult } from '@core/commands/types';

/**
 * Document unchanged, `rejected` with `error { code, ids, paths, remediation }`; summary `<command>: <CODE> — <message>; no-op.`.
 * @failure never throws
 */
export function refuse(
  doc: CadDocument,
  command: string,
  code: string,
  message: string,
  remediation: string,
  ids: readonly string[] = [],
  paths: readonly string[] = [],
): CommandResult {
  return rejection(doc, `${command}: ${code} — ${message}; no-op.`, commandError(code, remediation, ids, paths));
}
