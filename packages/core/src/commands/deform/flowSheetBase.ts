/** The base SHEET of flow_on_surface (01 DEF §17.5): the body is laid out on a curved base sheet and moved onto the target, (x, y) arc lengths and w the normal offset on both. */

import type { CadDocument, Vec3 } from '../../model/types';
import { pointsInsideMesh } from '../../geometry/deform/containsPoints';
import {
  type BaseSheetOptions,
  baseCoordinates,
  baseSurfaceGrid,
  buildFlowSurface,
  solveBaseChecked,
  wrappedRange,
} from '../../geometry/deform/flowSurface';
import { worldSurface } from '../../geometry/deform/worldNurbs';
import { closestOnSurface } from '../../lib/nurbs/closest';
import { surfaceDerivatives, surfaceDomain } from '../../lib/nurbs/surface';
import type { NurbsSurfaceData } from '../../lib/nurbs/surfaceTypes';
import { cross3, dot3, len3, normalize3 } from '../../lib/vec3';
import type { DeformPlan } from './request';
import { type DeformTarget, type Refusal, defaultTolerance, resolveTargetFrame } from './target';

/** The target surface in world coordinates and which side its normal points to. */
export interface TargetSurface {
  readonly surface: NurbsSurfaceData;
  /** +1: the normal is S_u x S_v, -1: the opposite (a face of a solid: outward). */
  readonly side: 1 | -1;
}

/** Most body vertices projected on the base sheet to size the table (a stride beyond). */
const MAX_PROJECTED = 800;

/**
 * Which iso-direction of `surface` the wanted world direction follows at parameters `uv`, and the signs of x and y, exactly as for the target.
 * @failure a degenerate tangent plane there -> null
 */
export function orientationAt(
  surface: NurbsSurfaceData,
  side: 1 | -1,
  uv: readonly [number, number],
  wanted: Vec3,
): Pick<BaseSheetOptions, 'xAlong' | 'signX' | 'signY'> | null {
  const derivatives = surfaceDerivatives(surface, uv[0], uv[1], 1);
  const su = (derivatives[1] as Vec3[])[0] as Vec3;
  const sv = (derivatives[0] as Vec3[])[1] as Vec3;
  if (len3(cross3(su, sv)) === 0) return null;
  const normal = normalize3(cross3(su, sv));
  const along = (tangent: Vec3): number => dot3(tangent, normalize3(wanted)) / len3(tangent);
  const xAlong = Math.abs(along(su)) >= Math.abs(along(sv)) ? 'u' : 'v';
  const tangentX = xAlong === 'u' ? su : sv;
  const signX = along(tangentX) >= 0 ? 1 : -1;
  const tangentY = cross3(side === 1 ? normal : [-normal[0], -normal[1], -normal[2]], normalize3(tangentX));
  const across = xAlong === 'u' ? sv : su;
  return { xAlong, signX, signY: dot3(across, tangentY) * signX >= 0 ? 1 : -1 };
}

/** Test-only switch: false skips the focal-point refusal so that a test can reach the warp with the input it shields. */
export const focalCheck = { enabled: true };

/** Samples per direction of the grid of the base sheet searched for its centres of curvature. */
const FOCAL_GRID = 41;

/**
 * The focal surface of the base sheet on a grid: P + N / kappa for each principal curvature kappa (dN = -kappa dP), the points where det of the base map
 * (1 - w kappa_1)(1 - w kappa_2) vanishes and a body laid out on the sheet is torn if it contains one.
 */
function focalPoints(sheet: BaseSheetOptions): Vec3[] {
  const [[u0, u1], [v0, v1]] = surfaceDomain(sheet.surface);
  const out: Vec3[] = [];
  for (let i = 0; i < FOCAL_GRID; i++)
    for (let j = 0; j < FOCAL_GRID; j++) {
      const [u, v] = [u0 + ((u1 - u0) * i) / (FOCAL_GRID - 1), v0 + ((v1 - v0) * j) / (FOCAL_GRID - 1)];
      const d = surfaceDerivatives(sheet.surface, u, v, 2);
      const [point, su, sv] = [(d[0] as Vec3[])[0] as Vec3, (d[1] as Vec3[])[0] as Vec3, (d[0] as Vec3[])[1] as Vec3];
      const [suu, suv, svv] = [(d[2] as Vec3[])[0] as Vec3, (d[1] as Vec3[])[1] as Vec3, (d[0] as Vec3[])[2] as Vec3];
      const raw = cross3(su, sv);
      if (len3(raw) === 0) continue;
      const n = normalize3(raw).map((c) => c * sheet.normalSign) as unknown as Vec3;
      const [e, f, g] = [dot3(su, su), dot3(su, sv), dot3(sv, sv)];
      const [l, m, k] = [dot3(n, suu), dot3(n, suv), dot3(n, svv)];
      // det(II - kappa I) = 0
      const a = e * g - f * f;
      const b = -(e * k + g * l - 2 * f * m);
      const c = l * k - m * m;
      const disc = b * b - 4 * a * c;
      if (!(a > 0) || disc < 0) continue;
      for (const kappa of [(-b + Math.sqrt(disc)) / (2 * a), (-b - Math.sqrt(disc)) / (2 * a)])
        if (Math.abs(kappa) > 1e-12) out.push([point[0] + n[0] / kappa, point[1] + n[1] / kappa, point[2] + n[2] / kappa]);
    }
  return out;
}

export interface SheetBaseInput {
  readonly sheetId?: string | undefined;
  readonly origin?: Vec3 | undefined;
  readonly uDirection?: Vec3 | undefined;
  readonly flipNormal?: boolean | undefined;
}

/**
 * The plan of a flow whose base is a curved sheet. The body and both sheets stay in world coordinates (the frame is the world one).
 * @failure the base sheet missing / not a nurbs_surface / degenerate -> DEF_FLOW_BASE_INVALID; the body off the base sheet -> DEF_FLOW_BASE_OUTSIDE; the target as for the plane base
 */
export function planSheetBase(
  doc: CadDocument,
  target: DeformTarget,
  found: TargetSurface,
  input: SheetBaseInput,
  targetOrigin: Vec3 | undefined,
  targetUDirection: Vec3 | undefined,
  tolerance: number | undefined,
): DeformPlan | Refusal {
  const invalidBase = (message: string, path = ''): Refusal => ({ code: 'DEF_FLOW_BASE_INVALID', message, paths: [`params.base${path}`] });
  const baseEntity = input.sheetId === undefined ? undefined : doc.entities[input.sheetId];
  if (baseEntity?.kind !== 'nurbs_surface')
    return invalidBase(
      baseEntity === undefined
        ? `base sheet '${String(input.sheetId)}' not found`
        : `'${String(input.sheetId)}' is a ${baseEntity.kind}, not a nurbs_surface`,
      '.sheetId',
    );
  const resolved = resolveTargetFrame(target, { origin: [0, 0, 0], axis: [0, 0, 1], reference: [1, 0, 0] }, 'centre');
  if ('code' in resolved) return resolved;
  const baseSurface = worldSurface(baseEntity);
  const baseSide: 1 | -1 = input.flipNormal === true ? -1 : 1;
  const centre: Vec3 = [0, 1, 2].map((a) => (target.min[a] as number) / 2 + (target.max[a] as number) / 2) as unknown as Vec3;
  const baseFoot = closestOnSurface(baseSurface, input.origin ?? centre);
  const baseOrientation = orientationAt(baseSurface, baseSide, [baseFoot.u, baseFoot.v], input.uDirection ?? [1, 0, 0]);
  if (baseOrientation === null) return invalidBase('the base sheet has a degenerate tangent plane at the base origin');
  const sheet: BaseSheetOptions = { surface: baseSurface, origin: [baseFoot.u, baseFoot.v], normalSign: baseSide, ...baseOrientation };
  const { positions } = target.mesh;
  const vertices = positions.length / 3;
  const stride = Math.max(1, Math.ceil(vertices / MAX_PROJECTED));
  const points: Vec3[] = [];
  for (let v = 0; v < vertices; v += stride)
    points.push([positions[v * 3] as number, positions[v * 3 + 1] as number, positions[v * 3 + 2] as number]);
  const { coordinates, period } = baseCoordinates(sheet, points);
  const slack = Math.max(1e-6 * target.diagonal, tolerance ?? 0);
  if (coordinates.some((c) => c[3] > slack))
    return {
      code: 'DEF_FLOW_BASE_OUTSIDE',
      message:
        'the body reaches beyond the edge of the base sheet (a vertex does not project inside it): enlarge the base sheet or move the body',
      paths: ['params.base.sheetId'],
    };
  const range = (read: (c: readonly [number, number, number, number]) => number): [number, number] => [
    Math.min(...coordinates.map(read)),
    Math.max(...coordinates.map(read)),
  ];
  const xRange: [number, number] =
    period === null
      ? range((c) => c[0])
      : wrappedRange(
          coordinates.map((c) => c[0]),
          period,
        );
  const [yRange, wRange] = [range((c) => c[1]), range((c) => c[2])];
  // a body that contains a centre of curvature of the base (an axis of a closed cylinder, say) is torn: det J of the base map vanishes there, it never reaches the floor
  const box = (a: number): [number, number] => [target.min[a] as number, target.max[a] as number];
  const near = focalPoints(sheet).filter((p) => [0, 1, 2].every((a) => (p[a] as number) >= box(a)[0] && (p[a] as number) <= box(a)[1]));
  if (focalCheck.enabled && pointsInsideMesh(near, positions, target.mesh.indices).length > 0)
    return {
      code: 'DEF_FOLDOVER',
      message:
        'the body contains a centre of curvature of the base sheet (its focal surface): the laid-out coordinates are not single-valued there and the body would be torn; keep it on one side of the axis',
      paths: ['params.base.sheetId'],
    };
  const targetSide = found.side;
  const origin = closestOnSurface(found.surface, targetOrigin ?? ([baseFoot.point[0], baseFoot.point[1], baseFoot.point[2]] as Vec3));
  const targetOrientation = orientationAt(
    found.surface,
    targetSide,
    [origin.u, origin.v],
    targetUDirection ?? input.uDirection ?? [1, 0, 0],
  );
  if (targetOrientation === null)
    return {
      code: 'DEF_FLOW_TARGET_INVALID',
      message: 'the target has a degenerate tangent plane at the target origin',
      paths: ['params.target'],
    };
  const resolvedTolerance = tolerance ?? defaultTolerance(target.diagonal);
  const law = buildFlowSurface({
    surface: found.surface,
    origin: [origin.u, origin.v],
    ...targetOrientation,
    normalSign: targetSide,
    xRange,
    yRange,
    offset: Math.max(Math.abs(wRange[0]), Math.abs(wRange[1])),
    tolerance: resolvedTolerance,
    base: sheet,
  });
  if (typeof law === 'string') {
    const refusals: Record<string, Refusal> = {
      OVERLAP: {
        code: 'DEF_FLOW_OVERLAP',
        message: 'the body is longer than one closed turn of the target: it would overlap itself; shorten it or use a larger target',
        paths: ['params.target'],
      },
      BASE_OVERLAP: {
        code: 'DEF_FLOW_OVERLAP',
        message:
          'the body is longer than one closed turn of the base sheet: its arc lengths would overlap; shorten it or use a larger base',
        paths: ['params.base.sheetId'],
      },
      OUTSIDE: {
        code: 'DEF_FLOW_OUTSIDE_BASE',
        message: 'the body reaches beyond the edge of the target surface from the target origin: move targetOrigin or shorten the body',
        paths: ['params.targetOrigin'],
      },
      BASE_OUTSIDE: {
        code: 'DEF_FLOW_BASE_OUTSIDE',
        message: 'the body reaches beyond the edge of the base sheet: enlarge the base sheet or move the body',
        paths: ['params.base.sheetId'],
      },
      BASE_DEGENERATE: invalidBase('the base sheet has a degenerate normal in the laid-out area'),
    };
    return (
      refusals[law] ?? {
        code: 'DEF_FLOW_TARGET_INVALID',
        message: 'the target surface has a degenerate normal in the wrapped area',
        paths: ['params.target'],
      }
    );
  }
  // the Newton solve on the table must find the foot the closest-point projection found (else a vertex is outside the table or past a focal point)
  const agreement = Math.max(4 * resolvedTolerance, 1e-6 * target.diagonal);
  const scale = Math.max(law.hx * law.nx, law.hy * law.ny, 1);
  const unsolved = points.some((point, k) => {
    const [cx, cy, cw] = coordinates[k] as readonly [number, number, number, number];
    const { u, residual } = solveBaseChecked(law, point);
    const dx = u[0] - cx;
    const wrapped = period === null ? dx : dx - period * Math.round(dx / period);
    return (
      !(residual <= 1e-9 * scale) || Math.abs(wrapped) > agreement || Math.abs(u[1] - cy) > agreement || Math.abs(u[2] - cw) > agreement
    );
  });
  if (unsolved)
    return {
      code: 'DEF_FLOW_BASE_OUTSIDE',
      message:
        'the base coordinates of a body vertex cannot be solved on the base table (it lies past the sheet or at its centre of curvature): move the body onto the base sheet',
      paths: ['params.base.sheetId'],
    };
  return {
    law,
    frame: resolved.frame,
    extent: resolved.extent,
    defaulted: [],
    // the extent box is not the body: the pre-check and the analysis sample the body's own vertices and a grid of the base coordinates
    samples: positions,
    gridSamples: baseSurfaceGrid(law, xRange, yRange, wRange),
  };
}
