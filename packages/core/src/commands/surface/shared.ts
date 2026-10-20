/** Shared pieces of the surfacing commands (02 SRF): stable refusal codes, curve lookup, creation fields. */

import type { CadDocument, NurbsCurveEntity, Vec3 } from '../../model/types';
import type { NurbsCurveData } from '../../lib/nurbs/types';
import type { CommandResult } from '../types';
import { colorField, layerIdField, looseVec3, nameField } from '../schema';
import type { z } from '../schema';
import { tableRejection } from '../noop';
import { commitEntity } from '../entity/commitEntity';
import { newEntity } from '../entity/newEntity';
import { nextId } from '../../lib/id';
import { finiteVec3OrZero } from '../../lib/vec3';
import { existingLayerOrDefault } from '../solids/shared';

export const DEFAULT_CURVE_COLOR = '#2a7ab0';

/** Largest number of poles / input points of one curve command. */
export const MAX_CURVE_POINTS = 10_000;

const REMEDIATION: Readonly<Record<string, string>> = {
  SRF_NURBS_INVALID: 'fix the named array; omit `knots` for clamped uniform knots, give end multiplicities degree + 1',
  SRF_POINTS_INSUFFICIENT: 'add points or lower `degree`',
  SRF_POINTS_COINCIDENT: 'remove the duplicate point',
  SRF_TOLERANCE_UNREACHABLE: 'raise tolerance or maxPoles, or allow a higher degreeMax; noisy data needs a tolerance above the noise',
  SRF_CONIC_RHO_RANGE: 'use 0 < rho < 1 (0.4142 = circle quarter for perpendicular tangents, 0.5 = parabola)',
  SRF_CONIC_COLLINEAR: 'move the apex off the chord',
  SRF_ENTITY_NOT_FOUND: 'list ids with describe_scene or find_entities',
  SRF_NOT_NURBS: 'pass the id of a nurbs_curve (create_nurbs_curve, interpolate_curve, create_conic)',
  SRF_PARAM_INVALID: 'give the parameters exactly as the command description states',
  SRF_NOT_SURFACE: 'pass the id of a nurbs_surface (create_nurbs_surface, surface_from_points, loft_surface, fill_surface, loft_fuselage)',
  SRF_NOT_ANALYSABLE: 'pass a nurbs_surface, a nurbs_curve or a 3D solid',
  SRF_LOFT_SECTIONS_TOO_FEW: 'give at least 2 section curves',
  SRF_LOFT_GUIDE_MISSES_SECTION:
    'snap the guide to the section curves (interpolate_curve through section points) or raise `guideTolerance`',
  SRF_LOFT_GUIDE_NOT_CONTAINED: 'use fewer or better aligned guides, or add sections near where the guides bend',
  SRF_FILL_LOOP_OPEN: 'give 3 to 12 curves whose ends meet end to end; `tolerance` is the largest gap bridged',
  SRF_FILL_UNSUPPORTED: 'fill 3 to 12 boundary curves of the same kind (all non-rational) whose ends meet',
  SRF_FILL_NEIGHBOUR_MISMATCH: 'name a curve of boundaryIds that IS a boundary edge of the sheet, within tolerance (e.g. made by interpolating that edge)',
  SRF_TRIM_MISS: 'the curve must project onto the sheet: use projectAlong with a direction that hits it, or move the curve onto the sheet',
  SRF_TRIM_LOOP_INVALID: 'give curves that chain end to end within tolerance, without self-crossings; an open curve must cross the sheet edge to edge',
  SRF_TRIM_AMBIGUOUS: 'give keepPoint, a point on the side of the cut to keep',
  SRF_TRIM_UNSUPPORTED: 'trim an untrimmed sheet, or add holes inside the kept region of a trimmed one',
  SRF_BLEND_DEGENERATE: 'blend two edges with a gap between them and a regular (non-pole) surface along them; use check_continuity if they already touch',
  SRF_BLEND_FOLD: 'choose the edges that face each other (each sheet must leave its edge towards the other one), or flip / reorder the sheets',
  SRF_TRIM_RANGE: 'give u and v intervals [from, to] inside the surface domain (see inspect_surface)',
  SRF_SEW_NOT_MERGEABLE: 'the surfaces must share one whole edge within `tolerance`; fill or move the edges, or raise `tolerance`',
  SRF_THICKEN_FAILED: 'thicken a surface with at least one non-degenerate normal',
  SRF_THICKEN_SELF_INTERSECT: 'reduce thickness below the radius of curvature reported, or thicken the other side',
  SRF_CONTINUITY_MISMATCH: 'give two curves or two surfaces (a curve cannot be joined to a surface here)',
  SRF_CHECK_NO_JOINT: 'the edges do not meet: check the ids and the sides, or leave `side` empty to detect it',
};

/** Coded refusal of a surfacing command: unchanged document, `SRF_*` code, offending ids / param paths, one-line fix. */
export const refuseSrf = tableRejection(REMEDIATION);

/** The `nurbs_curve` entity `id`, or a coded refusal. */
export function curveEntityOf(doc: CadDocument, command: string, id: string): NurbsCurveEntity | CommandResult {
  const entity = doc.entities[id];
  if (entity === undefined) return refuseSrf(doc, command, 'SRF_ENTITY_NOT_FOUND', `no entity "${id}"`, [id], ['id']);
  if (entity.kind !== 'nurbs_curve')
    return refuseSrf(doc, command, 'SRF_NOT_NURBS', `"${id}" is a ${entity.kind}, not a nurbs_curve`, [id], ['id']);
  return entity;
}

/** `position` / `color` / `layerId` / `name` params shared by the commands that create a curve. */
export const curveStyleFields = (): {
  position: z.ZodOptional<z.ZodType<Vec3>>;
  color: ReturnType<typeof colorField>;
  layerId: ReturnType<typeof layerIdField>;
  name: ReturnType<typeof nameField>;
} => ({
  position: looseVec3('Origin [x, y, z] of the curve in document units; the poles are relative to it. Defaults to [0, 0, 0].').optional(),
  color: colorField(DEFAULT_CURVE_COLOR),
  layerId: layerIdField(),
  name: nameField(),
});

interface CurveStyle {
  readonly position?: Vec3 | undefined;
  readonly color?: string | undefined;
  readonly layerId?: string | undefined;
  readonly name?: string | undefined;
}

/** Adds a `nurbs_curve` entity for `curve` to `doc`; `summary` describes it. */
export function commitCurve(doc: CadDocument, curve: NurbsCurveData, style: CurveStyle, summary: (id: string) => string): CommandResult {
  const id = nextId('curve');
  const entity = newEntity('nurbs_curve', id, { curve }, finiteVec3OrZero(style.position), style.color ?? DEFAULT_CURVE_COLOR, {
    layerId: existingLayerOrDefault(doc, style.layerId),
    name: style.name,
  });
  return commitEntity(doc, entity, summary(id));
}
