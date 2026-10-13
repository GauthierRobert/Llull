/**
 * Level resolution with the shared failure result of read-only checks and exports.
 * @layer domain-aec
 * @pure
 */

import type { CadDocument } from '@core/model/types';
import type { CommandResult } from '@core/commands/types';
import { noop } from '@core/commands/noop';
import { existingLevelId, getBuilding } from './model';

const noLevel = (doc: CadDocument, command: string, requested: string | undefined): CommandResult =>
  noop(doc, `${command} failed: no level '${requested ?? ''}'.`);

/** The existing level a check runs on (`existingLevelId`), or the no-op result naming `command`. */
export const levelOrFailure = (
  doc: CadDocument,
  command: string,
  requested: string | undefined,
): string | CommandResult =>
  existingLevelId(getBuilding(doc), requested) ?? noLevel(doc, command, requested);

/** The no-op result when `requested` is given but is not a level; undefined otherwise. */
export const unknownLevelFailure = (
  doc: CadDocument,
  command: string,
  requested: string | undefined,
): CommandResult | undefined =>
  requested !== undefined && !getBuilding(doc).levels[requested]
    ? noLevel(doc, command, requested)
    : undefined;
