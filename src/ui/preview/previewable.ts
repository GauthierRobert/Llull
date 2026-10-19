// Which registry commands get a live ghost in their dialog: any mutating, non-destructive command with a numeric field
// (extrude depth, fillet radius, shell thickness, move distance, ...). Queries and meta/session commands never do.

import type { CommandDefinition } from '@core/commands/types';
import type { FormField } from '@ui/components/commandPalette/paramForm';

/** @pure */
export function isPreviewable(command: Pick<CommandDefinition<unknown>, 'annotations'>, fields: readonly FormField[]): boolean {
  const a = command.annotations;
  if (a?.readOnly === true || a?.destructive === true || a?.metaHistory === true || a?.session === true) return false;
  return fields.some((field) => field.kind === 'number');
}
