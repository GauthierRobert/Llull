import { SIZE_MODIFIERS, type LocationDimensionPmi, type PmiTolerance, type SizeDimensionPmi } from '../../model/pmi';
import { featureElement, locate, measureSize } from '../../geometry/pmiMeasure';
import { formatNumber, sizeText } from '../../geometry/pmiText';
import { nextId } from '../../lib/id';
import type { CommandResult } from '../types';
import { defineCommand, vec3, z } from '../schema';
import { changed } from '../noop';
import { facesNearField, featureOf, isRefusal, placementField, placementFor, resolveOn, solidTarget } from './featureOps';
import { REVIEW_REQUIRED, refuse, withItem } from './pmiOps';

const bound = (what: string): z.ZodNumber => z.number().describe(`${what} Document length units (degrees for an angle).`);

export const toleranceField = z
  .union([
    z.object({
      type: z.literal('plusMinus').describe('Deviations from the measured nominal.'),
      upper: bound('Upper deviation (>= lower), e.g. 0.021.'),
      lower: bound('Lower deviation (<= upper), e.g. 0 or -0.05.'),
    }),
    z.object({
      type: z.literal('limits').describe('Absolute limits of size.'),
      upper: bound('Upper limit of size (>= lower), e.g. 6.9.'),
      lower: bound('Lower limit of size, e.g. 6.6.'),
    }),
    z.object({
      type: z.literal('fit').describe('ISO fit class code as text with its explicit deviations (no ISO 286 table is shipped).'),
      code: z.string().min(1).describe('Fit code text, e.g. "H7" or "g6".'),
      upper: bound('Upper deviation from the nominal for that code.'),
      lower: bound('Lower deviation from the nominal for that code.'),
    }),
    z.object({ type: z.literal('basic').describe('Theoretically exact dimension, shown boxed, no tolerance.') }),
  ])
  .describe(
    'Tolerance as { type: "plusMinus", upper, lower } deviations, { type: "limits", upper, lower } absolute limits, ' +
      '{ type: "fit", code, upper, lower } or { type: "basic" }.',
  );

type ToleranceInput = z.output<typeof toleranceField>;

/** Why `tolerance` is invalid (upper below lower), or null. */
export const toleranceProblem = (tolerance: ToleranceInput | PmiTolerance): string | null =>
  tolerance.type !== 'basic' && tolerance.lower > tolerance.upper
    ? `tolerance lower ${tolerance.lower} exceeds upper ${tolerance.upper}`
    : null;

/** Whether limits tolerance brackets `nominal` (always true for the other kinds). */
const bracketsNominal = (tolerance: PmiTolerance, nominal: number): boolean =>
  tolerance.type !== 'limits' || (nominal >= tolerance.lower - 1e-9 && nominal <= tolerance.upper + 1e-9);

/**
 * @affects adds 1 SizeDimensionPmi; affected = [pmiId]
 * @invariant the nominal is MEASURED from the B-rep (diameter 2r, width between planes, sphere), never typed; count = distinct holes / features
 * @failure not a feature of size, mixed sizes, kind mismatch, lower > upper, point not on a face, no OCC topology -> coded refusal, affected:[]
 */
export const addSizeDimension = defineCommand({
  name: 'add_size_dimension',
  annotations: { requiresKernel: true },
  description:
    'Add a size dimension with tolerance on a feature of size of a 3D solid: a cylinder (hole / shaft, sizeKind diameter or radius), two ' +
    'opposite parallel planes (width of a slot or tab), or a sphere (spherical_diameter), named by facesNear points. The nominal is measured ' +
    'from the exact B-rep (never typed); a pattern of equal holes (one point per hole) gives nX = the number of holes. Tolerance: ' +
    'plusMinus deviations, absolute limits, a fit code with explicit deviations, or basic. Optional ISO 14405 sizeModifiers (E envelope, LP, GG ...). ' +
    'Needs the OCC kernel. Refusals: GDT_NOT_FOS (a plane alone), GDT_SIZE_MIXED, GDT_SIZE_KIND_MISMATCH, GDT_LIMITS_INVERTED, GDT_POINT_NOT_ON_FACE, ' +
    'GDT_KERNEL_NO_TOPOLOGY. Review required. The pmi id in affected can be the target of add_geometric_tolerance (targetPmiId) and a stack-up contributor (pmiId).',
  params: z.object({
    entityId: z.string().describe('Id of the 3D solid.'),
    facesNear: facesNearField,
    sizeKind: z
      .enum(['diameter', 'radius', 'width', 'spherical_diameter'])
      .describe('Kind of size; decides which faces are valid (see the description).'),
    tolerance: toleranceField,
    sizeModifiers: z
      .array(z.enum(SIZE_MODIFIERS))
      .optional()
      .describe('ISO 14405-1 size modifier codes, stored and shown with the dimension. E = envelope.'),
    placement: placementField.optional(),
  }),
  run: (doc, { entityId, facesNear, sizeKind, tolerance, sizeModifiers, placement }, ctx): CommandResult => {
    const command = 'add_size_dimension';
    const invalid = toleranceProblem(tolerance);
    if (invalid !== null) return refuse(doc, command, 'GDT_LIMITS_INVERTED', invalid, [], ['tolerance']);
    const target = solidTarget(doc, command, entityId, ctx);
    if (isRefusal(target)) return target;
    const resolved = resolveOn(doc, command, target, facesNear, 'facesNear');
    if (isRefusal(resolved)) return resolved;
    const size = measureSize(resolved.faces, sizeKind, resolved.topology, resolved.tolerance);
    if ('code' in size) return refuse(doc, command, size.code, size.message, [entityId], ['facesNear']);
    const id = nextId('pmi');
    const item: SizeDimensionPmi = {
      id,
      kind: 'size_dimension',
      sizeKind,
      tolerance,
      count: size.count,
      ...(sizeModifiers === undefined || sizeModifiers.length === 0 ? {} : { sizeModifiers }),
      feature: featureOf(entityId, facesNear, resolved, size.ofSize),
      placement: placementFor(doc, resolved.faces[0], resolved.diagonal, placement),
      review: REVIEW_REQUIRED,
    };
    const warning = bracketsNominal(tolerance, sizeKind === 'radius' ? size.ofSize.measured / 2 : size.ofSize.measured)
      ? ''
      : ` Warning GDT_NOMINAL_OUTSIDE_LIMITS: the measured size ${formatNumber(size.ofSize.measured)} is outside the limits.`;
    return changed(
      withItem(doc, item),
      `add_size_dimension: ${sizeText(item)} (${id}) on '${entityId}', measured ${formatNumber(size.ofSize.measured)} ${doc.units}${
        size.ofSize.kind === 'cylinder' ? ' diameter' : ''
      }, ${size.count} feature(s); review required.${warning}`,
      [id],
    );
  },
});

/**
 * @affects adds 1 LocationDimensionPmi; affected = [pmiId]
 * @invariant measured from the B-rep: plane-plane |(o2-o1).n1| (parallel), axis-axis, axis-plane (parallel); angle between normals / axes in degrees
 * @failure from == to, a side spanning several planes / holes, non-parallel for a distance, lower > upper, point not on a face -> coded refusal
 */
export const addLocationDimension = defineCommand({
  name: 'add_location_dimension',
  annotations: { requiresKernel: true },
  description:
    'Add a location dimension between two features of one 3D solid: the distance between parallel planes, between parallel hole axes, or from ' +
    'a hole axis to a plane, or the angle (degrees) between normals / axes. Each side is named by facesNear points on ONE plane or ONE hole. ' +
    'The value is measured from the exact B-rep. Omit tolerance for a basic (theoretically exact, boxed) dimension, the usual base of a position ' +
    'tolerance. Needs the OCC kernel. Refusals: GDT_LOCATION_AMBIGUOUS, GDT_LOCATION_INVALID, GDT_LOCATION_SAME_FEATURE, GDT_LIMITS_INVERTED, ' +
    'GDT_POINT_NOT_ON_FACE. Review required.',
  params: z.object({
    entityId: z.string().describe('Id of the 3D solid.'),
    from: z
      .array(vec3('World point [x, y, z] on the first feature.'))
      .min(1)
      .describe('Points on the first feature (one plane or one hole).'),
    to: z
      .array(vec3('World point [x, y, z] on the second feature.'))
      .min(1)
      .describe('Points on the second feature (one plane or one hole).'),
    measure: z.enum(['distance', 'angle']).describe('distance in document length units, or angle in degrees.'),
    tolerance: toleranceField.optional().describe('Optional tolerance; omitted = basic dimension.'),
    placement: placementField.optional(),
  }),
  run: (doc, { entityId, from, to, measure, tolerance = { type: 'basic' as const }, placement }, ctx): CommandResult => {
    const command = 'add_location_dimension';
    const invalid = toleranceProblem(tolerance);
    if (invalid !== null) return refuse(doc, command, 'GDT_LIMITS_INVERTED', invalid, [], ['tolerance']);
    const target = solidTarget(doc, command, entityId, ctx);
    if (isRefusal(target)) return target;
    const [first, second] = [resolveOn(doc, command, target, from, 'from'), resolveOn(doc, command, target, to, 'to')];
    if (isRefusal(first)) return first;
    if (isRefusal(second)) return second;
    const shared = first.faces.some((a) => second.faces.some((b) => a.index === b.index));
    if (shared) return refuse(doc, command, 'GDT_LOCATION_SAME_FEATURE', 'from and to share a face', [entityId], ['to']);
    const [a, b] = [featureElement(first.faces, first.tolerance), featureElement(second.faces, second.tolerance)];
    if ('code' in a) return refuse(doc, command, a.code, `from: ${a.message}`, [entityId], ['from']);
    if ('code' in b) return refuse(doc, command, b.code, `to: ${b.message}`, [entityId], ['to']);
    const located = locate(a, b, measure);
    if ('code' in located) return refuse(doc, command, located.code, located.message, [entityId], ['measure']);
    const id = nextId('pmi');
    const item: LocationDimensionPmi = {
      id,
      kind: 'location_dimension',
      measure,
      measured: located.measured,
      tolerance,
      from: featureOf(entityId, from, first),
      to: featureOf(entityId, to, second),
      placement: placementFor(doc, second.faces[0], second.diagonal, placement),
      review: REVIEW_REQUIRED,
    };
    return changed(
      withItem(doc, item),
      `add_location_dimension: ${measure} ${formatNumber(located.measured)} ${measure === 'angle' ? 'deg' : doc.units} (${id}) on '${entityId}'${
        tolerance.type === 'basic' ? ', basic' : ''
      }; review required.`,
      [id],
    );
  },
});
