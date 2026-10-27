import { GEOMETRIC_CHARACTERISTICS, ZONE_MODIFIERS, type GeometricTolerancePmi } from '../../model/pmi';
import { fcfText } from '../../geometry/pmiText';
import { nextId } from '../../lib/id';
import type { CommandResult } from '../types';
import { defineCommand, z } from '../schema';
import { changed } from '../noop';
import { facesNearField, featureOf, isRefusal, placementField, placementFor, resolveOn, solidTarget } from './featureOps';
import { REVIEW_REQUIRED, cleanDatums, cleanZone, findPmi, pmiItems, pmiOf, refuse, withItem } from './pmiOps';
import { toleranceFindings } from './rules';

const zoneField = z
  .object({
    value: z.number().describe('Tolerance zone width or diameter, document length units; must be > 0.'),
    diametral: z.boolean().optional().describe('true = cylindrical zone, shown Ø. Not for planar features.'),
    spherical: z.boolean().optional().describe('true = spherical zone, shown SØ.'),
    projectedLength: z.number().optional().describe('Projected tolerance zone length (Ⓟ), document units; must be > 0.'),
    unequallyDisposed: z.number().optional().describe('Profile unequally disposed zone value (UZ), document units, within [0, value].'),
    maxValue: z.number().optional().describe('Maximum value of the tolerance (per-unit-area style limit), document units.'),
  })
  .describe('The tolerance zone: { value, diametral?, spherical?, projectedLength?, unequallyDisposed?, maxValue? }.');

const datumField = z
  .object({
    label: z.string().describe('Datum letter(s) of an existing datum feature on the same solid.'),
    boundary: z.enum(['MMB', 'LMB']).optional().describe('Datum boundary modifier: MMB (maximum material boundary) or LMB.'),
  })
  .describe('One datum reference.');

/**
 * @affects adds 1 GeometricTolerancePmi (a feature control frame); affected = [pmiId]
 * @invariant datums ordered primary -> tertiary, unique, defined on the same solid, none on a form tolerance; zone > 0; MMC / LMC only on a
 *   feature of size; exactly one target form (a feature, a size dimension, or the upper segment of a composite)
 * @failure any rule of check_pmi violated, unknown targetPmiId, point not on a face, no OCC topology -> coded refusal, affected:[]
 */
export const addGeometricTolerance = defineCommand({
  name: 'add_geometric_tolerance',
  annotations: { readsMeshTriangles: true, requiresKernel: true },
  description:
    'Add a feature control frame (geometric tolerance) to a 3D solid: characteristic (straightness, flatness, roundness, cylindricity, ' +
    'profile_line, profile_surface, angularity, perpendicularity, parallelism, position, concentricity, coaxiality, symmetry, circular_runout, ' +
    'total_runout), zone, optional material condition (MMC / LMC, only on a feature of size), zone modifiers (free_state, tangent_plane, ' +
    'statistical, separate_requirement, all_around / all_over for profiles ...) and up to 3 ordered datum references. Target ONE of: entityId + ' +
    'facesNear (a face set), targetPmiId (a size dimension, so MMC applies to its size), or compositeOf (the lower segment of a composite FCF: ' +
    "it inherits the upper frame's target, takes the same position / profile characteristic and a zone no larger than the upper one). " +
    'Form tolerances (straightness, flatness, roundness, cylindricity) take no datums. Needs the OCC kernel. Refusals carry a GDT_* code: ' +
    'GDT_DATUM_UNDEFINED, GDT_DATUM_REPEATED, GDT_DATUM_TOO_MANY, GDT_ZONE_NON_POSITIVE, GDT_MC_ON_NON_FOS, GDT_DIAMETRAL_ON_PLANE, ' +
    'GDT_FORM_WITH_DATUM, GDT_MODIFIER_NOT_APPLICABLE, GDT_COMPOSITE_INVALID, GDT_PMI_UNKNOWN. Review required.',
  params: z.object({
    characteristic: z.enum(GEOMETRIC_CHARACTERISTICS).describe('The geometric characteristic (see the description).'),
    zone: zoneField,
    entityId: z.string().optional().describe('Solid id; with facesNear, targets a face set.'),
    facesNear: facesNearField.optional(),
    targetPmiId: z.string().optional().describe('Id of a size dimension (add_size_dimension) the frame applies to, e.g. "$holeSize".'),
    compositeOf: z
      .string()
      .optional()
      .describe('Id of the upper position / profile FCF this is the lower segment of; target is inherited.'),
    materialCondition: z.enum(['MMC', 'LMC', 'RFS']).optional().describe('Material condition of the tolerance; default RFS (no symbol).'),
    modifiers: z.array(z.enum(ZONE_MODIFIERS)).optional().describe('Zone modifiers; default none.'),
    datums: z.array(datumField).optional().describe('Ordered datum references, primary first, at most 3; default none.'),
    placement: placementField.optional(),
  }),
  run: (doc, params, ctx): CommandResult => {
    const command = 'add_geometric_tolerance';
    const { characteristic, zone, entityId, facesNear, targetPmiId, compositeOf, placement } = params;
    const forms = [compositeOf !== undefined, targetPmiId !== undefined, entityId !== undefined || facesNear !== undefined].filter(Boolean);
    if (forms.length !== 1 || (entityId === undefined) !== (facesNear === undefined))
      return refuse(
        doc,
        command,
        'GDT_TARGET_FORM',
        'give exactly one of (entityId with facesNear), targetPmiId, compositeOf',
        [],
        ['entityId'],
      );
    const items = pmiOf(doc).items;
    let target: GeometricTolerancePmi['target'];
    if (compositeOf !== undefined) {
      const upper = findPmi(doc, compositeOf);
      if (upper?.kind !== 'geometric_tolerance')
        return refuse(
          doc,
          command,
          upper === undefined ? 'GDT_PMI_UNKNOWN' : 'GDT_COMPOSITE_INVALID',
          `'${compositeOf}' is not a feature control frame`,
          [compositeOf],
          ['compositeOf'],
        );
      target = upper.target;
    } else if (targetPmiId !== undefined) {
      const size = findPmi(doc, targetPmiId);
      if (size === undefined)
        return refuse(doc, command, 'GDT_PMI_UNKNOWN', `no PMI item '${targetPmiId}'`, [targetPmiId], ['targetPmiId']);
      if (size.kind !== 'size_dimension')
        return refuse(
          doc,
          command,
          'GDT_TARGET_FORM',
          `targetPmiId '${targetPmiId}' is a ${size.kind}, not a size dimension`,
          [targetPmiId],
          ['targetPmiId'],
        );
      target = { pmiId: targetPmiId };
    } else {
      target = { feature: { entityId: entityId as string, facesNear: facesNear ?? [], faceIndices: [], surface: 'other' } };
    }
    const anchorSource = 'pmiId' in target ? findPmi(doc, target.pmiId) : undefined;
    const sourceFeature =
      'feature' in target ? target.feature : anchorSource !== undefined && 'feature' in anchorSource ? anchorSource.feature : undefined;
    if (sourceFeature === undefined)
      return refuse(doc, command, 'GDT_TARGET_DANGLING', 'the target of the composite upper frame is missing', [], ['compositeOf']);
    const anchor = { entityId: sourceFeature.entityId, points: sourceFeature.facesNear };
    const solid = solidTarget(doc, command, anchor.entityId, ctx);
    if (isRefusal(solid)) return solid;
    const resolved = resolveOn(doc, command, solid, anchor.points, 'facesNear');
    if (isRefusal(resolved)) return resolved;
    if ('feature' in target) target = { feature: featureOf(anchor.entityId, anchor.points, resolved) };
    const id = nextId('pmi');
    const item: GeometricTolerancePmi = {
      id,
      kind: 'geometric_tolerance',
      characteristic,
      target,
      zone: cleanZone(zone),
      materialCondition: params.materialCondition ?? 'RFS',
      modifiers: params.modifiers ?? [],
      datums: cleanDatums(params.datums ?? []),
      ...(compositeOf === undefined ? {} : { compositeOf }),
      placement: placementFor(doc, resolved.faces[0], resolved.diagonal, placement),
      review: REVIEW_REQUIRED,
    };
    const problem = toleranceFindings(item, items).find((f) => f.severity === 'error');
    if (problem !== undefined)
      return refuse(
        doc,
        command,
        problem.code,
        problem.message,
        problem.pmiIds.filter((p) => p !== id),
        problem.paths,
      );
    return changed(
      withItem(doc, item),
      `add_geometric_tolerance: ${fcfText(item)} (${id}) ${'pmiId' in target ? `on size dimension ${target.pmiId}` : `on '${anchor.entityId}' face(s) ${resolved.faces.map((f) => f.index).join(', ')}`}${compositeOf === undefined ? '' : `, composite lower segment of ${compositeOf}`}; ${pmiItems(doc).length + 1} PMI item(s); review required.`,
      [id],
    );
  },
});
