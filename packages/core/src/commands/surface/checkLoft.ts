/** Checks of lofts and swept / lofted sheets for `check_sweep_loft`: seam twist between sections, degenerate skins, the exact-skin note. */

import type { LoftEntity, NurbsSurfaceEntity, Vec3 } from '../../model/types';
import { add3, centroid3, cross3, dot3, len3, normalize3, scale3, sub3 } from '../../lib/vec3';
import { surfaceDomain } from '../../lib/nurbs/surface';
import { surfaceSample } from '../../lib/nurbs/surfaceCurvature';
import type { NurbsSurfaceData } from '../../lib/nurbs/surfaceTypes';
import { ringNormal } from '../../geometry/skin';
import { closureJump } from '../../geometry/loftSkin/closure';
import { REMEDIATION, sig, type Finding } from './checkFindings';

/** Largest angle (radians) between the seam directions of neighbouring section rings (ring point 0 seen from the ring centroid, carried by the minimal rotation between the planes), and where it is. */
export function seamTwist(rings: ReadonlyArray<ReadonlyArray<Vec3>>, closed = false): { value: number; at: number } {
  let worst = { value: 0, at: 0 };
  for (let i = 0; i + (closed ? 0 : 1) < rings.length; i++) {
    const [p, q] = [rings[i] as ReadonlyArray<Vec3>, rings[(i + 1) % rings.length] as ReadonlyArray<Vec3>];
    const [np, nq] = [normalize3(ringNormal(p)), normalize3(ringNormal(q))];
    const flatten = (ring: ReadonlyArray<Vec3>, normal: Vec3): Vec3 => {
      const d = sub3(ring[0] as Vec3, centroid3([...ring]));
      return sub3(d, scale3(normal, dot3(d, normal)));
    };
    const axis = normalize3(add3(np, nq));
    const [a, b] = [flatten(p, axis), flatten(q, axis)];
    if (len3(a) < 1e-12 || len3(b) < 1e-12) continue;
    const angle = Math.atan2(len3(cross3(a, b)), dot3(a, b));
    if (angle > worst.value) worst = { value: angle, at: i / Math.max(1, closed ? rings.length : rings.length - 1) };
  }
  return worst;
}

/** First interior sample of a face where |S_u x S_v| vanishes (a pinch or fold), or null. */
function degenerateSample(surface: NurbsSurfaceData): [number, number] | null {
  const [[u0, u1], [v0, v1]] = surfaceDomain(surface);
  for (let i = 1; i < 12; i++)
    for (let j = 1; j < 12; j++) {
      const u = u0 + ((u1 - u0) * i) / 12;
      const v = v0 + ((v1 - v0) * j) / 12;
      if (surfaceSample(surface, u, v).degenerate) return [u, v];
    }
  return null;
}

export function checkLoft(entity: LoftEntity, endAngle: number, unit: string): Finding[] {
  const findings: Finding[] = [];
  const twist = seamTwist(entity.rings, entity.closed === true);
  if (twist.value > endAngle)
    findings.push({
      code: 'SWG_CHECK_LOFT_TWIST',
      severity: 'warn',
      entityId: entity.id,
      at: sig(twist.at),
      value: sig(twist.value),
      limit: endAngle,
      unit: 'rad',
      remediation: REMEDIATION.SWG_CHECK_LOFT_TWIST as string,
      message: `neighbouring sections start ${sig(twist.value)} rad apart (limit ${endAngle}): the rulings twist`,
    });
  const jump = entity.closed === true ? Math.max(0, ...(entity.faces ?? []).map(closureJump)) : 0;
  if (jump > endAngle)
    findings.push({
      code: 'SWG_CHECK_LOFT_CLOSURE_G1',
      severity: 'warn',
      entityId: entity.id,
      value: sig(jump),
      limit: endAngle,
      unit: 'rad',
      remediation: REMEDIATION.SWG_CHECK_LOFT_CLOSURE_G1 as string,
      message: `the closing seam of the loft kinks by ${sig(jump)} rad (limit ${endAngle}): the last section does not blend smoothly into the first`,
    });
  for (const [index, face] of (entity.faces ?? []).entries()) {
    const bad = degenerateSample(face);
    if (bad !== null)
      findings.push({
        code: 'SWG_CHECK_SURFACE_DEGENERATE',
        severity: 'fail',
        entityId: entity.id,
        value: null,
        limit: null,
        unit,
        remediation: REMEDIATION.SWG_CHECK_SURFACE_DEGENERATE as string,
        message: `face ${index} is pinched or folded at (u, v) = (${sig(bad[0])}, ${sig(bad[1])})`,
      });
  }
  if (entity.faces !== undefined)
    findings.push({
      code: 'SWG_CHECK_FIT_APPROXIMATION',
      severity: 'info',
      entityId: entity.id,
      value: null,
      limit: null,
      unit,
      remediation: REMEDIATION.SWG_CHECK_FIT_APPROXIMATION as string,
      message: `the exact solid is built from ${entity.faces.length} NURBS face(s) skinned in TypeScript; the display rings are a sampled copy`,
    });
  return findings;
}

export function checkSheet(entity: NurbsSurfaceEntity, unit: string): Finding[] {
  const bad = degenerateSample(entity.surface);
  return bad === null
    ? []
    : [
        {
          code: 'SWG_CHECK_SURFACE_DEGENERATE',
          severity: 'fail',
          entityId: entity.id,
          value: null,
          limit: null,
          unit,
          remediation: REMEDIATION.SWG_CHECK_SURFACE_DEGENERATE as string,
          message: `the sheet is pinched or folded at (u, v) = (${sig(bad[0])}, ${sig(bad[1])})`,
        },
      ];
}
