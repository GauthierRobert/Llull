/** Stable fastener codes (AF-11) with their one-line remediation, and the refusal builder every command shares. */

import { type CadDocument } from '@core/model/types';
import { type CommandResult, type CommandError } from '@core/commands/types';
import { commandError, noop } from '@core/commands/noop';

const REMEDIATION: Readonly<Record<string, string>> = {
  FAST_PART_NUMBER_UNKNOWN: 'Call list_fastener_families to see the catalogued families, or import_fastener_catalog to add the family.',
  FAST_FAMILY_UNKNOWN: 'Call list_fastener_families for the ids in this document, or import_fastener_catalog to add the family.',
  FAST_SIZE_UNKNOWN: 'Call list_fastener_families: each family lists its size dashes.',
  FAST_FAMILY_NOT_SELECTABLE: 'Choose a bolt, Hi-Lok pin or rivet family; nuts and washers are passed as nut / washer.',
  FAST_STACK_MISSING: 'Give stack { value, unit }, or stackIds with axisPoint (and axis) so the thickness can be measured.',
  FAST_STACK_OUT_OF_RANGE: 'Pick another diameter or family, or check the stack thickness.',
  FAST_WASHER_GAP: 'Use the next grip dash, a different washer set, or raise maxWasherTotal knowingly.',
  FAST_PROTRUSION_SHORT: 'Use the next grip dash.',
  FAST_PROTRUSION_UNKNOWN: 'Import the nut dimensions (height max) and the bolt threadsPerInch.',
  FAST_LAYER_GAP: 'Close the gap between the plates or select the right solids.',
  FAST_LAYER_MISSING: 'Select existing 3D solids (list_entities); a stack layer was deleted or replaced.',
  FAST_INSTANCE_MISSING: 'Delete the stack with delete_fastener_stack and insert it again.',
  FAST_AXIS_MISS: 'Move axisPoint onto the plates or correct axis.',
  FAST_AXIS_ANGLE: 'Angled or countersunk fasteners are out of scope: align axis with the face normal.',
  FAST_HOLE_DIAMETER_UNKNOWN:
    'Give holeDiameter { value, unit }, or import the size hole diameter (holeDiameter) into the catalogue, or use holeMode "none".',
  FAST_KERNEL_REQUIRED: 'Install a geometry kernel (--kernel occt on the desktop) or use holeMode "none".',
  FAST_HOLE_CUT_FAILED:
    'The kernel could not cut the hole; check the plates are closed 3D solids (not instances) and the hole is inside them.',
  FAST_EDGE_DISTANCE: 'Move the row away from the plate edge, or pass allowViolations to accept the warning.',
  FAST_PITCH: 'Increase the pitch or reduce the count, or pass allowViolations to accept the warning.',
  FAST_STACK_NOT_FOUND: 'Call check_fastener_layout without stackIds to list the stacks in the document.',
  FAST_ROW_INVALID: 'Give from and to as different points and either pitch or count (count >= 1).',
  FAST_CATALOG_INVALID: 'Fix the catalogue file at the listed paths (format llull-fastener-catalog, schemaVersion 1).',
  FAST_CATALOG_CONFLICT: 'Pass replace: true to overwrite the family, or rename the family id.',
  FAST_LICENCE_EMBED_FORBIDDEN:
    'Keep the catalogue in a private library (not supported for fastener catalogues yet); use a public-domain or company-proprietary family.',
  MAT_UNIT_INVALID: 'Use a unit listed by `llull describe convert_quantity`.',
  MAT_UNIT_DIMENSION: 'Give a unit of the right dimension.',
  MAT_PROVENANCE_MISSING: 'Add provenance.citation (or sourceId) to the value.',
};

export const remediationFor = (code: string): string => REMEDIATION[code] ?? 'See the summary.';

/** A `CommandError` for a fastener code with its standard remediation. */
export const fastenerError = (code: string, ids: readonly string[] = [], paths: readonly string[] = []): CommandError =>
  commandError(code, remediationFor(code), ids, paths);

/** Graceful refusal: unchanged document, `affected: []`, the code on `error` (AF-11). */
export function refuse(
  doc: CadDocument,
  command: string,
  code: string,
  why: string,
  ids: readonly string[] = [],
  paths: readonly string[] = [],
): CommandResult {
  return { ...noop(doc, `${command}: ${why}; no-op (${code}).`), error: fastenerError(code, ids, paths) };
}
