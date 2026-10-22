/** unwrap_face — the flat development of a plane, cylinder or cone face: sector angle and radii, area, outline in chart coordinates (03 WRP M2). */

import type { Vec2, Vec3 } from '../../model/vectors';
import { defineCommand, z } from '../schema';
import { report } from '../noop';
import { sample2 } from '../../lib/nurbs/curve2d';
import type { FaceChart } from '../../geometry/wrapChart';
import { buildFaceChart } from '../../geometry/wrapChart';
import type { CommandResult } from '../types';
import { wrapRejection } from './codes';
import { wrapData } from './conventions';
import { isDevelopableSurface, isRejection, openFace, type FaceSession } from './faceSession';
import { faceRefField } from './schemas';

/** Points kept per outline loop and per reported curve. */
const MAX_OUTLINE_POINTS = 2000;
const CURVE_POINTS = 200;

interface Extent {
  readonly uMin: number;
  readonly uSpan: number;
  readonly vMin: number;
  readonly vMax: number;
}

/** The (u, v) box of the face in the chart's own frame, read from the corners of the face's parameter bounds (3D points mapped back). */
function faceExtent(session: FaceSession, chart: FaceChart): Extent | null {
  const [[uLow, vLow], [uHigh, vHigh]] = session.uvBounds;
  const corners: Vec2[] = [
    [uLow, vLow],
    [uHigh, vLow],
    [uLow, vHigh],
    [uHigh, vHigh],
  ];
  if (!corners.every(([u, v]) => Number.isFinite(u) && Number.isFinite(v))) return null;
  const mine: Vec2[] = [];
  for (const corner of corners) {
    // a cone apex has no normal, so the kernel does not evaluate it: it is the point rho = 0
    const hit = session.query.evaluateFace(session.shape, session.face, [corner])?.[0];
    if (hit !== undefined) mine.push(chart.uvOfPoint(hit.point));
    else if (chart.kind === 'cone') mine.push([Number.NaN, 0]);
    else return null;
  }
  const known = mine.find((uv) => !Number.isNaN(uv[0]));
  if (known === undefined) return null;
  const resolved = mine.map((uv): Vec2 => (Number.isNaN(uv[0]) ? [known[0], 0] : uv));
  const vs = resolved.map((uv) => uv[1]);
  if (chart.kind === 'plane') {
    const us = resolved.map((uv) => uv[0]);
    return { uMin: Math.min(...us), uSpan: Math.max(...us) - Math.min(...us), vMin: Math.min(...vs), vMax: Math.max(...vs) };
  }
  return {
    uMin: (resolved[0] as Vec2)[0],
    uSpan: Math.min(Math.abs(uHigh - uLow), 2 * Math.PI),
    vMin: Math.min(...vs),
    vMax: Math.max(...vs),
  };
}

const thin = (points: Vec2[]): Vec2[] => {
  if (points.length <= MAX_OUTLINE_POINTS) return points;
  const step = points.length / MAX_OUTLINE_POINTS;
  return Array.from({ length: MAX_OUTLINE_POINTS }, (_, k) => points[Math.floor(k * step)] as Vec2);
};

/**
 * @affects none (read-only)
 * @invariant plane, cylinder and cone develop without stretch: the reported area and radii are the face's own, the outline is the face boundary unrolled (an exact rectangle or annular
 *   sector when the face is untrimmed; `outlineExact` says so)
 * @failure unknown id / not a solid / no or several faces / sphere, torus or freeform face -> coded refusal (WRP_FACE_NOT_DEVELOPABLE for K != 0)
 */
export const unwrapFace = defineCommand({
  name: 'unwrap_face',
  description:
    'Develop a plane, cylinder or cone face of a solid into the flat: the unrolled outline (rectangle for a cylinder, annular sector for a cone, with its sector angle ' +
    'in radians and inner / outer radius in document units), the area in document units squared, and optionally the curves lying on the face (`includeCurves`: ' +
    'nurbs_curves made by wrap_to_face / project_to_face on this face, given in the same flat coordinates). A cone develops to a sector of angle 2 pi sin(semi-angle) with ' +
    'radii measured from the apex along the generator. Chart coordinates: origin at the start of the face parameter range (cylinder / plane: x = arc length, y = axial; ' +
    'cone: polar about the apex, x = rho cos(phi), y = rho sin(phi)). Sphere, torus and freeform faces refuse with WRP_FACE_NOT_DEVELOPABLE. Needs the exact (native) kernel. ' +
    'Next: wrap_to_face, emboss_on_face.',
  params: z.object({
    id: z.string().describe('Id of the solid.'),
    face: faceRefField,
    includeCurves: z
      .boolean()
      .optional()
      .describe('Also return the nurbs_curves lying on this face, as flat polylines (at most 200 points each). Default false.'),
  }),
  annotations: { requiresKernel: true, readOnly: true },
  run: (doc, params, ctx): CommandResult => {
    const session = openFace(doc, ctx, 'unwrap_face', params.id, params.face);
    if (isRejection(session)) return session;
    if (!isDevelopableSurface(session.surface))
      return wrapRejection(
        doc,
        'unwrap_face',
        'WRP_FACE_NOT_DEVELOPABLE',
        `face ${session.face} is ${session.surface.type} (Gaussian curvature != 0): it has no length-preserving development`,
        [params.id],
        ['face'],
      );
    const details = session.query.faceDetails(session.shape, { samples: 0 });
    const kernelArea = details?.[session.face]?.area ?? null;
    const centroid: Vec3 = details?.[session.face]?.centroid ?? [0, 0, 0];
    const projected = session.query.projectOnFace(session.shape, session.face, [centroid])?.[0] ?? null;
    const chart = buildFaceChart(session.surface, {
      anchorChart: [0, 0],
      anchorOn: projected?.point ?? centroid,
      angleDeg: 0,
      mirror: false,
    });
    if ('error' in chart) return wrapRejection(doc, 'unwrap_face', 'WRP_FACE_NOT_FOUND', chart.error, [params.id], ['face']);
    const extent = faceExtent(session, chart);
    if (extent === null)
      return wrapRejection(doc, 'unwrap_face', 'WRP_FACE_NOT_FOUND', `face ${session.face} has no parameter bounds`, [params.id], ['face']);
    const { surface } = session;
    const fields: Record<string, unknown> = { developable: true, surfaceKind: surface.type, face: session.face, faceArea: kernelArea };
    let outline: Vec2[];
    let area: number;
    if (surface.type === 'cone') {
      const sin = Math.sin(surface.semiAngle);
      const sector = extent.uSpan * sin;
      const [inner, outer] = [extent.vMin, extent.vMax];
      area = 0.5 * sector * (outer * outer - inner * inner);
      const steps = Math.max(8, Math.min(MAX_OUTLINE_POINTS / 2 - 2, Math.ceil(sector / 0.01)));
      const arc = (rho: number): Vec2[] =>
        Array.from({ length: steps + 1 }, (_, k): Vec2 => [rho * Math.cos((sector * k) / steps), rho * Math.sin((sector * k) / steps)]);
      outline = inner < 1e-9 * outer ? [[0, 0], ...arc(outer)] : [...arc(outer), ...arc(inner).reverse()];
      Object.assign(fields, {
        sectorAngleRad: sector,
        sectorAngleDeg: (sector * 180) / Math.PI,
        innerRadius: inner,
        outerRadius: outer,
        semiAngleRad: surface.semiAngle,
        fullTurn: extent.uSpan >= 2 * Math.PI - 1e-9,
      });
    } else {
      const radius = surface.type === 'cylinder' ? surface.radius : 1;
      const width = extent.uSpan * (surface.type === 'cylinder' ? radius : 1);
      const height = extent.vMax - extent.vMin;
      area = width * height;
      outline = [
        [0, 0],
        [width, 0],
        [width, height],
        [0, height],
      ];
      Object.assign(fields, {
        width,
        height,
        ...(surface.type === 'cylinder'
          ? { radius, circumference: 2 * Math.PI * radius, fullTurn: extent.uSpan >= 2 * Math.PI - 1e-9 }
          : {}),
      });
    }
    const trimmed = kernelArea !== null && Math.abs(kernelArea - area) > 1e-6 * Math.max(kernelArea, area);
    if (trimmed && kernelArea !== null) area = kernelArea;
    const curves = params.includeCurves
      ? Object.values(doc.entities).flatMap((entity) => {
          if (entity.kind !== 'nurbs_curve' || entity.onFace?.entityId !== params.id || entity.onFace.faceIndex !== session.face) return [];
          const flat = sample2(entity.onFace.pcurve, CURVE_POINTS).map(([u, v]): Vec2 => {
            if (surface.type === 'cone') {
              const phi = (u - extent.uMin) * Math.sin(surface.semiAngle);
              return [v * Math.cos(phi), v * Math.sin(phi)];
            }
            const scale = surface.type === 'cylinder' ? surface.radius : 1;
            return [(u - extent.uMin) * scale, v - extent.vMin];
          });
          return [{ id: entity.id, chartLength: entity.onFace.chartLength, points: flat }];
        })
      : undefined;
    const data = wrapData(
      doc,
      { ...fields, area, outlineExact: !trimmed, outline: [thin(outline)], ...(curves === undefined ? {} : { curves }) },
      {
        unverified: false,
        provenance: { method: 'length-preserving development of the face', inputs: { id: params.id, face: session.face } },
      },
    );
    const detail =
      surface.type === 'cone'
        ? `sector ${(fields['sectorAngleRad'] as number).toPrecision(9)} rad, radii ${(fields['innerRadius'] as number).toPrecision(8)}..${(fields['outerRadius'] as number).toPrecision(8)} ${doc.units}`
        : `${(fields['width'] as number).toPrecision(8)} x ${(fields['height'] as number).toPrecision(8)} ${doc.units}`;
    return report(
      doc,
      `unwrap_face: ${surface.type} face ${session.face} of '${params.id}' develops to ${detail}, area ${area.toPrecision(10)} ${doc.units}^2${trimmed ? ' (trimmed face: outline is the bounding development)' : ''}.`,
      data,
    );
  },
});
