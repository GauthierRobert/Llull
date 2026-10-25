/** Sections of an advanced loft as exact world NURBS curves: nurbs_curve ids, closed 2D sketches, and inline circle / ellipse / polygon sections. */

import type { CadDocument, NurbsCurveEntity, Vec3 } from '../../model/types';
import { applyEulerXYZ, isZeroRotation } from '../../lib/eulerRotation';
import { add3 } from '../../lib/vec3';
import type { NurbsCurveData } from '../../lib/nurbs/types';
import { chainCurve, ellipseCurve, polygonCurve } from '../../geometry/sectionCurve';
import { isVec2 } from '../../lib/vec2';
import type { SectionSpec } from './sectionSpecs';
import { entityCurves } from '../../geometry/entityCurves';
import { sketchLoop } from './sketchCurves';

/** `curve` with every pole moved by the plane placement (rotation about `origin`, then `origin` added). */
export function placeCurve(curve: NurbsCurveData, origin: Vec3, rotation: Vec3): NurbsCurveData {
  const place = (pole: Vec3): Vec3 => (isZeroRotation(rotation) ? add3(origin, pole) : applyEulerXYZ(add3(origin, pole), origin, rotation));
  return { ...curve, poles: curve.poles.map(place) };
}

/** The curve of a `nurbs_curve` entity in world coordinates. */
export const worldCurveOf = (entity: NurbsCurveEntity): NurbsCurveData => placeCurve(entity.curve, entity.position, entity.rotation);

/** A closed 2D sketch as an exact world curve, or the reason it is unusable. */
export function sketchSectionCurve(doc: CadDocument, id: string): NurbsCurveData | string {
  const loop = sketchLoop(doc, [id]);
  if (typeof loop === 'string') return loop;
  const curve = chainCurve(loop.curves);
  return curve === null ? `sketch "${id}" has a degenerate arc` : placeCurve(curve, loop.origin, loop.rotation);
}

/** Any 2D or 3D curve entity as an exact world curve (a centreline), or the reason it is unusable. */
export function anyWorldCurve(doc: CadDocument, id: string): NurbsCurveData | string {
  const entity = doc.entities[id];
  if (entity === undefined) return `no entity "${id}"`;
  if (entity.kind === 'nurbs_curve') return worldCurveOf(entity);
  const own = entityCurves(entity);
  if (own === null) return `entity "${id}" (kind="${entity.kind}") is not a curve`;
  const curve = chainCurve(own.curves);
  return curve === null ? `"${id}" has a degenerate arc` : placeCurve(curve, entity.position, entity.rotation);
}

/** An inline section spec (plus its plane) as a world curve, or the reason it is unusable. */
export function specCurve(doc: CadDocument, spec: SectionSpec & { center: Vec3; rotation?: Vec3 | undefined }): NurbsCurveData | string {
  const { radius, radiusX, radiusY, section, sectionId } = spec;
  const ellipse = radiusX !== undefined || radiusY !== undefined;
  if ([radius !== undefined, ellipse, section !== undefined, sectionId !== undefined].filter(Boolean).length !== 1)
    return 'give exactly one of radius, radiusX+radiusY, section or sectionId';
  const rotation = spec.rotation ?? [0, 0, 0];
  if (radius !== undefined || ellipse) {
    const rx = radius ?? radiusX ?? 0;
    const ry = radius ?? radiusY ?? 0;
    return rx > 0 && ry > 0 ? placeCurve(ellipseCurve(rx, ry), spec.center, rotation) : `radii must be > 0 (got ${rx} × ${ry})`;
  }
  if (section !== undefined) {
    if (section.length < 3 || !section.every(isVec2)) return 'section needs >= 3 finite [x, y] points';
    return placeCurve(polygonCurve(section as Array<readonly [number, number]>), spec.center, rotation);
  }
  // an inline sketch section keeps only its local shape: the spec's centre and rotation place it
  const local = sketchLoop(doc, [sectionId as string]);
  if (typeof local === 'string') return local;
  const chain = chainCurve(local.curves);
  return chain === null ? 'the section sketch has a degenerate arc' : placeCurve(chain, spec.center, rotation);
}
