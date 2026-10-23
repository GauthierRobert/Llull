/** Stable `PSC_*` codes of the piping catalogue and spec commands (01 PSC §7, AF-11) with their one-line remediation. */

import { tableRejection } from '@core/commands/noop';

const REMEDIATION: Readonly<Record<string, string>> = {
  PSC_CATALOG_INVALID: 'Fix the file at the listed paths (format llull-piping-catalog, schemaVersion 1).',
  PSC_CATALOG_CONFLICT: 'Pass replace: true or change the catalogue id.',
  PSC_CATALOG_UNKNOWN: 'Call list_piping_catalogs for the catalogue ids (the bundled one is llull-open-piping).',
  PSC_CATALOG_ROW_MISSING: "Import a catalogue that has the size, or change the spec's catalogRef.",
  PSC_CATALOG_DIM_MISMATCH: 'Correct the value or remove the rule claim (standard) from the family.',
  PSC_PROVENANCE_MISSING: 'Add provenance.citation or provenance.sourceId to the size (or dimProvenance for the value).',
  PSC_UNIT_INVALID: 'Use mm or in for the family unit.',
  PSC_LICENCE_EMBED_FORBIDDEN: 'Store it as a private library (ctx.libraries) and reference it.',
  PSC_LIBRARY_UNRESOLVED: 'Install the library file or ask its owner.',
  PSC_SPEC_INVALID: 'Fix the spec at the listed paths.',
  PSC_SPEC_UNKNOWN: 'Call list_pipe_specs or import_pipe_spec.',
  PSC_SPEC_CONFLICT: 'Pass replace: true (creates a new revision) or rename.',
  PSC_SPEC_IN_USE: 'Reassign those pipes (assign_pipe_spec) or keep the component.',
  PSC_SIZE_OUT_OF_RANGE: 'Use a size in the listed range or another spec.',
  PSC_SIZE_UNKNOWN: 'Use a listed NPS designation (e.g. "2-1/2" or 2.5) or a DN, and give exactly one of nps / dn.',
  PSC_SCHEDULE_UNKNOWN: 'Call lookup_piping_component with type pipe and no schedule to see the schedules at this size.',
  PSC_NO_COMPONENT: 'Add one with edit_pipe_spec, or use a type listed in the message.',
  PSC_AMBIGUOUS_COMPONENT: 'Narrow the query (schedule, class, facing, radius, standard) or set different priorities in the spec.',
  PSC_BRANCH_UNDEFINED: 'Fill the cell with edit_pipe_spec setBranchCell.',
  PSC_PT_RATING_EXCEEDED: 'Use a higher-class spec; a qualified engineer must decide.',
  PSC_PT_TEMPERATURE_OUT_OF_TABLE: 'Import a rating table that covers the temperature or change the material group.',
  PSC_TEMPERATURE_LIMIT: 'Choose a spec whose limits cover it.',
  PSC_WALL_INSUFFICIENT: 'Use the selected schedule in data, or a heavier one.',
  PSC_WALL_THICK_PIPE: 'Thick-wall design is out of scope: needs a qualified engineer.',
  PSC_ALLOWABLE_MISSING: 'Give allowableStress and the factors explicitly (AF-31).',
  PSC_DIM_STANDARD_MIXED: "Use fittings of the spec's dimensional standard.",
  PSC_DIM_STANDARD_ROUNDING: 'Confirm with the fitting vendor.',
  PSC_END_INCOMPATIBLE: 'Add a transition component or align class / facing.',
  PSC_COVERAGE_GAP: 'Add components for the listed sizes.',
  PSC_DATA_UNVERIFIED: 'Have a qualified engineer confirm it, or import a verified catalogue.',
  PSC_SPEC_NOT_APPROVED: 'A qualified reviewer approves it (approve_pipe_spec).',
  PSC_SPEC_REVISION_STALE: 'Re-run assign_pipe_spec or accept knowingly.',
  PSC_PIPE_NO_SPEC: 'assign_pipe_spec.',
  PSC_PIPE_SPEC_MISMATCH: 'Re-run assign_pipe_spec.',
  PSC_SPEC_CHECK_FAILED: 'Fix the fail items first.',
  PSC_HUMAN_GATE: 'A qualified reviewer signs (09 PLM record_signature).',
  PSC_PIPE_UNKNOWN: 'Pass the id of a pipe element (find_entities, building elements of category pipe).',
};

/** Remediation of a `PSC_*` code, for check items. */
export const remediationFor = (code: string): string => REMEDIATION[code] ?? 'See the summary.';

/** Graceful coded refusal of a piping command: unchanged document, `rejected`, code + remediation + ids + paths. */
export const refuse = tableRejection(REMEDIATION);
