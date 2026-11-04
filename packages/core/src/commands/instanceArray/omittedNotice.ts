/**
 * Surfaces that do not read `doc.instanceArrays` yet (VIS1 next steps): they say so instead of silently leaving the members out.
 * @invariant one choke point (`execute`): a listed command on a document with arrays appends "N instance arrays (M members) not included"
 *   to its summary, whatever its result; remove a name from the list when the command supports arrays
 */

import type { CadDocument } from '../../model/types';
import type { CommandResult } from '../types';

export const ARRAY_UNAWARE_COMMANDS: ReadonlySet<string> = new Set([
  'export_gltf',
  'export_obj',
  'export_stl',
  'export_3mf',
  'export_step_ap242',
  'export_iges',
  'export_code',
  'check_clashes',
  'bill_of_materials',
  'fit_view',
  'render_view',
  'render_walkthrough',
  'explode_instance',
]);

/** The notice for `doc` ('' when it has no array): array and member counts. */
function omittedArraysNotice(doc: CadDocument): string {
  const arrays = Object.values(doc.instanceArrays ?? {});
  if (arrays.length === 0) return '';
  const members = arrays.reduce((sum, array) => sum + array.count, 0);
  return ` Note: ${arrays.length} instance ${arrays.length === 1 ? 'array' : 'arrays'} (${members} members) not included: this command does not read instance arrays yet.`;
}

export function withOmittedArraysNotice(doc: CadDocument, commandName: string, result: CommandResult): CommandResult {
  if (result.rejected === true || !ARRAY_UNAWARE_COMMANDS.has(commandName)) return result;
  const notice = omittedArraysNotice(doc);
  return notice === '' ? result : { ...result, summary: result.summary + notice };
}
