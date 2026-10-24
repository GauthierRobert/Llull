/**
 * The patch of a wrap decal (03 WRP M4, TECHNICAL_SPEC §5.7): the decal rectangle (width along the text, height up it, both lengths) carried along a cylinder or cone by the
 * length-preserving chart of the face, so a decal of width 30 on a radius 20 cylinder spans 30 / 20 = 1.5 rad, where the projected decal spans 2 asin(15 / 20) = 1.696 rad.
 * @invariant lengths along the face are kept (develop chart); the patch is lifted off the surface by 1e-3 of the larger side, like the projected one
 */

import type { Decal, Vec3 } from '../model/types';
import type { DecalSurface } from '../model/decal';
import { add3, scale3 } from '../lib/vec3';
import { buildFaceChart } from './wrapChart';
import type { SurfaceParams } from './kernelPorts';

/** Largest angular step of a wrap patch strip, radians (a 0.05 rad chord sags a thousandth of the radius). */
const MAX_STEP = 0.05;
const MAX_STRIPS = 400;

const surfaceOf = (wrap: DecalSurface): SurfaceParams =>
  wrap.type === 'cylinder'
    ? { type: 'cylinder', origin: wrap.origin, axis: wrap.axis, xDir: wrap.xDir, radius: wrap.radius }
    : { type: 'cone', apex: wrap.apex, axis: wrap.axis, xDir: wrap.xDir, semiAngle: wrap.semiAngle };

/** Angle about the axis one decal width spans (rad): width over the cylinder radius, or over the sine-scaled distance from the apex of a cone. */
export function wrapExtent(decal: Pick<Decal, 'width' | 'center'>, wrap: DecalSurface): number {
  if (wrap.type === 'cylinder') return decal.width / wrap.radius;
  const rho = Math.hypot(decal.center[0] - wrap.apex[0], decal.center[1] - wrap.apex[1], decal.center[2] - wrap.apex[2]);
  return decal.width / (rho * Math.sin(wrap.semiAngle));
}

/**
 * Triangles with UVs (glTF convention) of a wrap decal: strips across the width, one row along the (straight) generator.
 * @failure a cone decal reaching the apex, a width beyond one turn -> empty patch
 */
export function wrapPatch(decal: Decal, wrap: DecalSurface): { positions: number[]; uvs: number[] } {
  const chart = buildFaceChart(surfaceOf(wrap), {
    anchorChart: [0, 0],
    anchorOn: decal.center,
    angleDeg: (decal.angle * 180) / Math.PI,
    mirror: false,
  });
  const empty = { positions: [], uvs: [] };
  if ('error' in chart || wrapExtent(decal, wrap) > 2 * Math.PI * (1 + 1e-9)) return empty;
  const strips = Math.min(MAX_STRIPS, Math.max(2, Math.ceil(wrapExtent(decal, wrap) / MAX_STEP)));
  const lift = Math.max(decal.width, decal.height) * 1e-3;
  const corner = (i: number, j: number): { point: Vec3; uv: [number, number] } | null => {
    const x = (i / strips - 0.5) * decal.width;
    const y = (j - 0.5) * decal.height;
    const uv = chart.uvAt([x, y]);
    if (uv === null) return null;
    return { point: add3(chart.pointAt(uv), scale3(chart.normalAt(uv), lift)), uv: [i / strips, 1 - j] };
  };
  const positions: number[] = [];
  const uvs: number[] = [];
  for (let i = 0; i < strips; i++) {
    const quad = [corner(i, 0), corner(i + 1, 0), corner(i + 1, 1), corner(i, 1)];
    if (quad.some((c) => c === null)) return empty;
    const [a, b, c, d] = quad as NonNullable<(typeof quad)[number]>[];
    for (const triangle of [
      [a, b, c],
      [a, c, d],
    ] as const)
      for (const vertex of triangle as ReadonlyArray<NonNullable<(typeof quad)[number]>>) {
        positions.push(...vertex.point);
        uvs.push(...vertex.uv);
      }
  }
  return { positions, uvs };
}
