/** Refusals of the materials commands (AF-11): a stable MAT_* / PROP_* code, the offending ids and path, and a one-line fix. */

import { EXPORT_REMEDIATION } from '../../model/exportGate';
import type { CadDocument } from '../../model/types';
import type { CommandResult } from '../types';
import { commandError, rejection } from '../noop';

const REMEDIATION: Readonly<Record<string, string>> = {
  MAT_UNIT_INVALID: 'use a unit listed by `llull describe convert_quantity` (e.g. g/cm^3, lb/in^3, ksi, MPa, degF)',
  MAT_UNIT_DIMENSION: 'give a unit of the right dimension for the property',
  MAT_BASIS_MISSING: 'add basis (A, B, S, typical, supplier_unstated, company, unspecified)',
  MAT_PROVENANCE_MISSING: 'add source.citation (and source.locator)',
  MAT_PREFERRED_CONFLICT: 'clear preferred on the other value (set_material_property with replace: true and without preferred)',
  MAT_RECORD_NOT_FOUND: 'use get_material or describe_scene to find the material id; define_material_record creates a record',
  MAT_RECORD_EXISTS: 'pass replace: true or choose another id',
  MAT_RECORD_IN_USE: 'reassign those entities (assign_material) first',
  MAT_RECORD_READONLY: 'a record imported from a library is read-only: define a company record with define_material_record',
  MAT_ALLOWABLE_NOT_AVAILABLE:
    'pick a candidate explicitly or supply a sourced value with set_material_property; a basis is never substituted',
  MAT_ALLOWABLE_AMBIGUOUS: 'mark one of the candidates preferred (set_material_property replace: true, preferred: true)',
  MAT_SOURCE_SUPERSEDED: 'use the current MMPDS value (licensed library) for certification',
  MAT_VALUE_UNVERIFIED: 'replace the value with a verified, sourced one (basis A, B, S or company)',
  MAT_TEMPERATURE_OUT_OF_RANGE: 'stay inside the tabulated temperature range; llull never extrapolates',
  MAT_LIBRARY_HASH_MISMATCH: 'import the new version explicitly (give its sha256, or none for an inline library)',
  MAT_LIBRARY_UNRESOLVED: 'register the library file (register_material_library), then run resolve_material_libraries',
  MAT_LIBRARY_INVALID: 'fix the library at the given path (format llull-material-library, schemaVersion 1)',
  MAT_LIBRARY_EXISTS: 'pass replace: true to import another version of this library',
  MAT_LIBRARY_PRIVATE_INLINE: 'register the file with register_material_library, then import by { libraryId, version, sha256 }',
  MAT_LICENCE_EMBED_FORBIDDEN: 'use storage: private (register_material_library) and import by reference',
  ...EXPORT_REMEDIATION,
  MAT_DENSITY_INVALID: 'give the material a density with set_material_property (property density)',
  PROP_FORM_INVALID: 'follow the parameter description in `llull describe set_material_property`',
  PROP_PROPERTY_UNKNOWN: 'use a catalogue property (density, E, Ec, G, nu, Ftu, Fty, Fcy, Fsu, Fbru, Fbry, elongation, cte, k, cp)',
  PROP_TABLE_NOT_MONOTONIC: 'give temperature points in strictly increasing order',
  PROP_RANGE_INVALID: 'give a valid temperature range',
  PROP_MODEL_EXISTS: 'pass replace: true or another id',
  PROP_MODEL_NOT_FOUND: 'use get_material to list the models of the material',
};

/** A rejected result: summary `<command>: <code> — <message>; no-op.`, `error` with the ids / path / fix, optional `data` (query answers). */
export function refuseMaterial(
  doc: CadDocument,
  command: string,
  code: string,
  message: string,
  options: { readonly ids?: readonly string[]; readonly path?: string; readonly remediation?: string; readonly data?: unknown } = {},
): CommandResult {
  const result = rejection(
    doc,
    `${command}: ${code} — ${message}; no-op.`,
    commandError(
      code,
      options.remediation ?? REMEDIATION[code] ?? 'see the command description',
      options.ids ?? [],
      options.path !== undefined ? [options.path] : [],
    ),
  );
  return options.data === undefined ? result : { ...result, data: options.data };
}
