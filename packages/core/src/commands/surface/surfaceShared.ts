/** Shared pieces of the surface-sheet commands (02 SRF M4-M5): surface lookup, creation fields, analysis targets, rounding. */

import type { CadDocument, Entity, NurbsSurfaceEntity, Vec3 } from '../../model/types';
import type { NurbsSurfaceData } from '../../lib/nurbs/surfaceTypes';
import type { CommandResult } from '../types';
import { colorField, layerIdField, looseVec3, nameField } from '../schema';
import type { z } from '../schema';
import { commitEntity } from '../entity/commitEntity';
import { newEntity } from '../entity/newEntity';
import { nextId } from '../../lib/id';
import { finiteVec3OrZero } from '../../lib/vec3';
import { roundSignificant } from '../../lib/significant';
import { isCurve3D, isSheet } from '../../model/curveKinds';
import { is3D } from '../../model/types';
import { entityToTriangles } from '../../geometry/entityTriangles';
import { placedCurve, placedSurface } from '../../geometry/nurbsSurface';
import type { DeviationShape } from '../../geometry/surfaceAnalysis/types';
import { existingLayerOrDefault } from '../solids/shared';
import { refuseSrf } from './shared';

export const DEFAULT_SURFACE_COLOR = '#9fb4c7';

/** Ten significant digits: the precision reported in `data` of the analysis queries. */
export const sig = (value: number): number => roundSignificant(value, 10);
export const sigVec = (v: Vec3): Vec3 => [sig(v[0]), sig(v[1]), sig(v[2])];

/** The `nurbs_surface` entity `id`, or a coded refusal. */
export function surfaceEntityOf(doc: CadDocument, command: string, id: string): NurbsSurfaceEntity | CommandResult {
  const entity = doc.entities[id];
  if (entity === undefined) return refuseSrf(doc, command, 'SRF_ENTITY_NOT_FOUND', `no entity "${id}"`, [id], ['id']);
  if (entity.kind !== 'nurbs_surface')
    return refuseSrf(doc, command, 'SRF_NOT_SURFACE', `"${id}" is a ${entity.kind}, not a nurbs_surface`, [id], ['id']);
  return entity;
}

/** `position` / `color` / `layerId` / `name` params shared by the commands that create a surface sheet. */
export const surfaceStyleFields = (): {
  position: z.ZodOptional<z.ZodType<Vec3>>;
  color: ReturnType<typeof colorField>;
  layerId: ReturnType<typeof layerIdField>;
  name: ReturnType<typeof nameField>;
} => ({
  position: looseVec3('Origin [x, y, z] of the surface in document units; the poles are relative to it. Defaults to [0, 0, 0].').optional(),
  color: colorField(DEFAULT_SURFACE_COLOR),
  layerId: layerIdField(),
  name: nameField(),
});

export interface SurfaceStyle {
  readonly position?: Vec3 | undefined;
  readonly color?: string | undefined;
  readonly layerId?: string | undefined;
  readonly name?: string | undefined;
}

/** Adds a `nurbs_surface` entity for `surface` to `doc`; `summary` describes it. */
export function commitSurface(
  doc: CadDocument,
  surface: NurbsSurfaceData,
  style: SurfaceStyle,
  summary: (id: string) => string,
): CommandResult {
  const id = nextId('surf');
  const entity = newEntity('nurbs_surface', id, { surface }, finiteVec3OrZero(style.position), style.color ?? DEFAULT_SURFACE_COLOR, {
    layerId: existingLayerOrDefault(doc, style.layerId),
    name: style.name,
  });
  return commitEntity(doc, entity, summary(id));
}

export interface AnalysisTarget {
  readonly entity: Entity;
  readonly shape: DeviationShape;
}

/** The entity `id` as a world-space shape the analysis port understands (sheet, curve or the triangles of a 3D solid), or a coded refusal. */
export function analysisTarget(doc: CadDocument, command: string, id: string, path = 'id'): AnalysisTarget | CommandResult {
  const entity = doc.entities[id];
  if (entity === undefined) return refuseSrf(doc, command, 'SRF_ENTITY_NOT_FOUND', `no entity "${id}"`, [id], [path]);
  if (isSheet(entity)) return { entity, shape: { type: 'surface', surface: placedSurface(entity) } };
  if (isCurve3D(entity)) return { entity, shape: { type: 'curve', curve: placedCurve(entity) } };
  if (is3D(entity) && entity.kind !== 'instance') return { entity, shape: { type: 'mesh', triangles: entityToTriangles(entity, doc) } };
  return refuseSrf(doc, command, 'SRF_NOT_ANALYSABLE', `"${id}" is a ${entity.kind}`, [id], [path]);
}

/** True when `value` is a coded refusal (a `CommandResult`) rather than a lookup hit. */
export const isRefusal = (value: unknown): value is CommandResult =>
  typeof value === 'object' && value !== null && 'summary' in value && 'affected' in value;
