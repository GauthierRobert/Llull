/**
 * Exact loft (loft v3): `loft_sections` through nurbs_curve entities keeps every section as the curve it is (no 24-point resampling), so
 * the exact kernel and STEP export see the section unchanged. The section curve is closed by a straight edge when its ends differ.
 */

import type { CadDocument, NurbsCurveEntity, Vec3 } from '../../model/types';
import type { CommandResult } from '../types';
import { failer } from '../noop';
import { idOrNext } from '../entity/explicitId';
import { newEntity } from '../entity/newEntity';
import { applyEulerXYZ, isZeroRotation } from '../../lib/eulerRotation';
import { reverseCurve } from '../../lib/nurbs/edit';
import type { NurbsCurveData } from '../../lib/nurbs/types';
import { add3, centroid3, distance3, dot3, sub3 } from '../../lib/vec3';
import { hasClosingEdge, sectionChain, sectionRing } from '../../geometry/sectionChain';
import { poleExtent } from '../../geometry/nurbsCurve';
import { ringNormal } from '../../geometry/skin';
import { commitSolid, existingLayerOrDefault } from './shared';

/** The curve of `entity` in world coordinates (its position and rotation applied to every pole). */
function worldCurve(entity: NurbsCurveEntity): NurbsCurveData {
  const place = (pole: Vec3): Vec3 =>
    isZeroRotation(entity.rotation)
      ? add3(entity.position, pole)
      : applyEulerXYZ(add3(entity.position, pole), entity.position, entity.rotation);
  return { ...entity.curve, poles: entity.curve.poles.map(place) };
}

/** True when every id of `sectionIds` is a nurbs_curve entity of `doc`. */
export const allNurbsCurves = (doc: CadDocument, sectionIds: ReadonlyArray<string>): boolean =>
  sectionIds.length > 0 && sectionIds.every((id) => doc.entities[id]?.kind === 'nurbs_curve');

/**
 * @affects creates 1 loft entity carrying `sections` (exact) and `rings` (display fallback), positioned at the first section's centre
 * @invariant sections are wound counter-clockwise about the direction of travel (reversed when needed); equal Bézier span counts and closing-edge status
 * @failure fewer than 2 / more than `max` sections, rational or degree > 3 sections, mismatching spans or closing edge, coincident centres, duplicate id -> no-op
 */
export function exactLoft(
  doc: CadDocument,
  sectionIds: ReadonlyArray<string>,
  ruled: boolean,
  style: { layerId?: string | undefined; color: string; id?: string | undefined },
  max: number,
): CommandResult {
  const fail = failer(doc, 'loft_sections');
  if (sectionIds.length < 2 || sectionIds.length > max) return fail(`a loft needs 2..${max} sections (got ${sectionIds.length})`);
  const curves = sectionIds.map((id) => worldCurve(doc.entities[id] as NurbsCurveEntity));
  const chains = curves.map(sectionChain);
  const unsupported = chains.findIndex((chain) => chain === null);
  if (unsupported >= 0)
    return fail(`section ${unsupported} ("${sectionIds[unsupported]}") is rational or above degree 3: use degree 1..3 non-rational curves`);
  const first = chains[0] as NonNullable<(typeof chains)[number]>;
  const mismatch = curves.findIndex(
    (curve, i) =>
      (chains[i] as typeof first).length !== first.length || hasClosingEdge(curve) !== hasClosingEdge(curves[0] as NurbsCurveData),
  );
  if (mismatch > 0)
    return fail(
      `section ${mismatch} ("${sectionIds[mismatch]}") has a different number of Bézier spans or closing edge than section 0: build every section the same way`,
    );
  const centres = curves.map((curve) => {
    const { min, max } = poleExtent(curve);
    return centroid3([min, max]);
  });
  for (let i = 1; i < centres.length; i++)
    if (distance3(centres[i] as Vec3, centres[i - 1] as Vec3) < 1e-6)
      return fail(`sections ${i - 1} and ${i} share the same centre; space them along the loft`);
  const oriented = curves.map((curve, i) => {
    const travel = sub3(centres[Math.min(i + 1, centres.length - 1)] as Vec3, centres[Math.max(i - 1, 0)] as Vec3);
    return dot3(ringNormal(sectionRing(curve)), travel) >= 0 ? curve : reverseCurve(curve);
  });
  const origin = centres[0] as Vec3;
  const sections = oriented.map((curve) => ({ ...curve, poles: curve.poles.map((pole) => sub3(pole, origin)) }));
  const rings = sections.map(sectionRing);
  const id = idOrNext(style.id, 'loft');
  const entity = newEntity('loft', id, { rings, ruled, sections }, origin, style.color, {
    layerId: existingLayerOrDefault(doc, style.layerId),
  });
  return commitSolid(
    doc,
    entity,
    `loft_sections: created exact ${ruled ? 'ruled' : 'smooth'} loft "${id}" through ${sections.length} NURBS sections (not resampled; ${first.length} spans each)`,
  );
}
