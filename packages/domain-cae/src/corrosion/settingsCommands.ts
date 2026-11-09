/** set_service_environment / set_galvanic_group (PHY-13 FR-COR-06, FR-COR-16): the document environment and the galvanic group of a material. */

import { defineCommand, z } from '@core/commands/schema';
import { changed } from '@core/commands/noop';
import type { CommandResult } from '@core/commands/types';
import { refuseCor } from './codes';
import { corrosionOf, withCorrosion } from './model';
import { ANODIC_GROUPS, groupOf, limitOf } from './tables';
import type { CorrosionEnvironment, CorrosionScheme } from './types';

const VALID: Readonly<Record<CorrosionScheme, readonly CorrosionEnvironment[]>> = {
  anodic_index: ['harsh', 'normal', 'controlled'],
  mil_std_889d: ['artificial_seawater'],
};

/**
 * @affects doc.corrosion.environment (replaces it; affected: [])
 * @invariant no default environment exists: the check refuses (COR_ENVIRONMENT_UNSET) until this is called
 * @failure environment not valid for the scheme -> COR_ENVIRONMENT_INVALID (document unchanged)
 */
export const setServiceEnvironment = defineCommand({
  name: 'set_service_environment',
  description:
    'Record the service environment of the whole document for the corrosion checks (there is no default). scheme anodic_index (non-MIL-STD screening rule of thumb) ' +
    'takes environment harsh (max anodic-index difference 0.15 V: outdoor, humid, salt), normal (0.25 V: indoor, uncontrolled) or controlled (0.50 V: temperature and humidity controlled); ' +
    "scheme mil_std_889d takes artificial_seawater (the standard's own condition; its matrix is not shipped, so a check under it reports COR_889_TABLE_MISSING). " +
    'Next: set_galvanic_group per material, then check_material_compatibility.',
  params: z.object({
    scheme: z.enum(['anodic_index', 'mil_std_889d']).describe('Rule scheme: anodic_index (screening) or mil_std_889d.'),
    environment: z
      .enum(['harsh', 'normal', 'controlled', 'artificial_seawater'])
      .describe('Environment valid for the scheme (see the description).'),
  }),
  run: (doc, { scheme, environment }): CommandResult => {
    if (!VALID[scheme].includes(environment))
      return refuseCor(
        doc,
        'set_service_environment',
        'COR_ENVIRONMENT_INVALID',
        `'${environment}' is not valid for scheme '${scheme}' (valid: ${VALID[scheme].join(', ')})`,
        [],
        ['environment'],
      );
    const limit = limitOf(environment);
    return changed(
      withCorrosion(doc, { environment: { scheme, value: environment } }),
      `set_service_environment: ${scheme} / ${environment}${limit === undefined ? '' : ` (max anodic-index difference ${limit.maxDifferenceV} V, ${limit.source}, grade B rule of thumb)`}.`,
      [],
    );
  },
});

/**
 * @affects doc.corrosion.materials[material] (replaces it; affected: [material])
 * @invariant the group must be a row of the anodic-index table; anodicIndexV (volts) overrides the group's table value and needs its own source
 * @failure unknown material -> COR_MATERIAL_NOT_FOUND; unknown group -> COR_GROUP_UNKNOWN; blank citation or non-finite index -> COR_PARAMS_INVALID (document unchanged)
 */
export const setGalvanicGroup = defineCommand({
  name: 'set_galvanic_group',
  description:
    'Assign a galvanic group (anodic-index table row) to a material, with the source of the assignment (required). Groups: ' +
    `${ANODIC_GROUPS.map((group) => group.id).join(', ')} (list_compatibility_rules shows each with its index and source). ` +
    "anodicIndexV (volts) optionally overrides the group's table index for this material and needs its own citation. The group of a plated part comes from its surface system " +
    '(assign_surface_system), not from the base material. Next: check_material_compatibility.',
  params: z.object({
    material: z.string().describe('Material id (the name given to create_material).'),
    galvanicGroup: z.string().describe('Group id of the anodic-index table, e.g. "aluminium_wrought_other" for 7075.'),
    anodicIndexV: z.number().optional().describe('Anodic index override in volts (finite, between -5 and 5).'),
    source: z
      .object({
        citation: z.string().describe('Where this assignment comes from (a standard, a data sheet). Required, non-blank.'),
        locator: z.string().optional().describe('Table, page or section of the source.'),
      })
      .describe('Provenance of the assignment.'),
  }),
  run: (doc, { material, galvanicGroup, anodicIndexV, source }): CommandResult => {
    const fail = (code: string, message: string, ids: readonly string[], path: string): CommandResult =>
      refuseCor(doc, 'set_galvanic_group', code, message, ids, [path]);
    if (!Object.hasOwn(doc.materials, material)) return fail('COR_MATERIAL_NOT_FOUND', `no material '${material}'`, [material], 'material');
    if (groupOf(galvanicGroup) === undefined)
      return fail('COR_GROUP_UNKNOWN', `no galvanic group '${galvanicGroup}'`, [material], 'galvanicGroup');
    if (source.citation.trim() === '')
      return fail('COR_PARAMS_INVALID', 'source.citation must not be blank', [material], 'source.citation');
    if (anodicIndexV !== undefined && !(Number.isFinite(anodicIndexV) && Math.abs(anodicIndexV) <= 5))
      return fail('COR_PARAMS_INVALID', 'anodicIndexV must be finite and within [-5, 5] V', [material], 'anodicIndexV');
    const entry = {
      galvanicGroup,
      ...(anodicIndexV === undefined ? {} : { anodicIndexV }),
      source: { citation: source.citation, ...(source.locator === undefined ? {} : { locator: source.locator }) },
    };
    return changed(
      withCorrosion(doc, { materials: { ...corrosionOf(doc).materials, [material]: entry } }),
      `set_galvanic_group: '${material}' -> ${galvanicGroup}${anodicIndexV === undefined ? '' : ` (anodic index override ${anodicIndexV} V)`}; source ${source.citation}.`,
      [material],
    );
  },
});
