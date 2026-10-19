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
  SRF_CONIC_RHO_RANGE: 'use 0 < rho < 1 (0.4142 = circle quarter for perpendicular tangents, 0.5 = parabola)',
  SRF_CONIC_COLLINEAR: 'move the apex off the chord',
  SRF_ENTITY_NOT_FOUND: 'list ids with describe_scene or find_entities',
  SRF_NOT_NURBS: 'pass the id of a nurbs_curve (create_nurbs_curve, interpolate_curve, create_conic)',
  SRF_PARAM_INVALID: 'give the parameters exactly as the command description states',
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
