/** The base SHEET of flow_on_surface (01 DEF §17.5): the body is laid out on a curved base sheet and moved onto the target, (x, y) arc lengths and w the normal offset on both. */

import type { CadDocument, Vec3 } from '../../model/types';
import { type BaseSheetOptions, baseCoordinates, baseSurfaceGrid, buildFlowSurface, wrappedRange } from '../../geometry/deform/flowSurface';
import { worldSurface } from '../../geometry/deform/worldNurbs';
import { closestOnSurface } from '../../lib/nurbs/closest';
import { surfaceDerivatives } from '../../lib/nurbs/surface';
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
