/** Evaluates a graded platform (pad): pad mesh and outline, daylight line, batter meshes, label. */

import type { Entity, Vec2 } from '@core/model/types';
import type { PlatformObject } from '@core/model/civil';
import { polygonCentroid } from '@lib/polygon';
import { triangulatePolygon } from '@lib/triangulate';
import { civilMesh, civilPolyline, civilText } from '../entities';
import { labelHeight, type CivilContext } from '../context';
import { daylightPoints, type DaylightPoint } from './platformDaylight';
import { surfaceTinById } from '../surface/surfaceTin';
import { elevationAt, type Tin } from '../surface/tin';
import { toMetres } from '@core/model/units';

const CUT_COLOR = '#c0794a';
const FILL_COLOR = '#8fae6b';

const mean = (values: ReadonlyArray<number>): number => values.reduce((sum, value) => sum + value, 0) / values.length;

type MeshBuffer = { positions: number[]; indices: number[] };

/** Pushes a triangle wound so its normal faces up (+Z). */
function pushTriangle(
  mesh: MeshBuffer,
  a: readonly [number, number, number],
  b: readonly [number, number, number],
  c: readonly [number, number, number],
): void {
  const normalZ = (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
  const base = mesh.positions.length / 3;
  mesh.positions.push(...a, ...b, ...c);
  mesh.indices.push(base, normalZ >= 0 ? base + 1 : base + 2, normalZ >= 0 ? base + 2 : base + 1);
}

function batterMeshes(points: ReadonlyArray<DaylightPoint>, elevation: number): Record<'cut' | 'fill', MeshBuffer> {
  const meshes = { cut: { positions: [], indices: [] } as MeshBuffer, fill: { positions: [], indices: [] } as MeshBuffer };
  points.forEach((current, i) => {
    const next = points[(i + 1) % points.length] as DaylightPoint;
    const mode = current.mode === 'none' ? next.mode : current.mode;
    if (mode === 'none' || (current.distance === 0 && next.distance === 0)) return;
    const target = meshes[mode];
    const e0 = [current.edge[0], current.edge[1], elevation] as const;
    const e1 = [next.edge[0], next.edge[1], elevation] as const;
    const d0 = [current.daylight[0], current.daylight[1], current.elevation] as const;
    const d1 = [next.daylight[0], next.daylight[1], next.elevation] as const;
    pushTriangle(target, e0, e1, d1);
    pushTriangle(target, e0, d1, d0);
  });
  return meshes;
}

/** Ground elevation under each daylight point (the batter level where the ground is unknown, e.g. past the TIN). */
function daylightElevations(tin: Tin, points: ReadonlyArray<DaylightPoint>): number[] {
  return points.map((point) => elevationAt(tin, point.daylight) ?? point.elevation);
}

/** Thin horizontal ribbon following the daylight line in 3D, every vertex at ground level. */
function daylightRibbon(tin: Tin, points: ReadonlyArray<DaylightPoint>, width: number): MeshBuffer {
  const ribbon: MeshBuffer = { positions: [], indices: [] };
  const lift = width * 0.3;
  const level = (at: Vec2, fallback: number): number => (elevationAt(tin, at) ?? fallback) + lift;
  points.forEach((current, i) => {
    const next = points[(i + 1) % points.length] as DaylightPoint;
    const dx = next.daylight[0] - current.daylight[0];
    const dy = next.daylight[1] - current.daylight[1];
    const length = Math.hypot(dx, dy);
    if (length < 1e-9) return;
    const nx = (-dy / length) * (width / 2);
    const ny = (dx / length) * (width / 2);
    const corner = (point: DaylightPoint, sign: number): [number, number, number] => {
      const at: Vec2 = [point.daylight[0] + sign * nx, point.daylight[1] + sign * ny];
      return [at[0], at[1], level(at, point.elevation)];
    };
    const a = corner(current, -1);
    const b = corner(next, -1);
    const c = corner(next, 1);
    const d = corner(current, 1);
    pushTriangle(ribbon, a, b, c);
    pushTriangle(ribbon, a, c, d);
  });
  return ribbon;
}

export function evaluatePlatform(context: CivilContext, platform: PlatformObject): Entity[] {
  const outline = platform.boundary;
  if (outline.length < 3) return [];
  const entities: Entity[] = [];
  const pad = triangulatePolygon(outline as Vec2[]);
  const padMesh: MeshBuffer = { positions: [], indices: [] };
  pad.vertices.forEach((vertex) => padMesh.positions.push(vertex[0], vertex[1], platform.elevation));
  pad.triangles.forEach((triangle) => padMesh.indices.push(...triangle));
  entities.push(civilMesh(platform, 'pad', `${platform.name} pad`, 'grading', padMesh));
  entities.push(civilPolyline(platform, 'outline', `${platform.name} outline`, 'grading', outline, true, platform.elevation));
  const tin = surfaceTinById(context.civil, platform.surfaceId);
  if (tin) {
    const points = daylightPoints(tin, outline, platform.elevation, platform.cutSlope, platform.fillSlope);
    if (points.some((point) => point.distance > 0)) {
      entities.push(
        civilPolyline(
          platform,
          'daylight',
          `${platform.name} daylight`,
          'daylight',
          points.map((point) => point.daylight),
          true,
          mean(daylightElevations(tin, points)),
        ),
      );
      const ribbon = daylightRibbon(tin, points, labelHeight(context.doc) / 15);
      if (ribbon.indices.length > 0) {
        entities.push(civilMesh(platform, 'daylight-3d', `${platform.name} daylight (3D)`, 'daylight', ribbon));
      }
      const meshes = batterMeshes(points, platform.elevation);
      if (meshes.cut.indices.length > 0) {
        entities.push(civilMesh(platform, 'batter-cut', `${platform.name} cut batter`, 'grading', meshes.cut, CUT_COLOR));
      }
      if (meshes.fill.indices.length > 0) {
        entities.push(civilMesh(platform, 'batter-fill', `${platform.name} fill batter`, 'grading', meshes.fill, FILL_COLOR));
      }
    }
  }
  const centre = polygonCentroid(outline);
  const level = toMetres(context.doc, platform.elevation).toFixed(2);
  entities.push(
    civilText(
      platform,
      'label',
      `Pad ${platform.name} ${platform.elevation >= 0 ? '+' : ''}${level}`,
      'annotation',
      [centre[0], centre[1], platform.elevation],
      labelHeight(context.doc),
    ),
  );
  return entities;
}
