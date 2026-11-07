/** A `region` entity as render_view polygons: stroked loops, stroked hatch lines, or filled triangles for a solid hatch. */

import type { RegionEntity, Vec2, Vec3 } from '../../model/types';
import { regionFaces, regionHatchLines } from '../../geometry/region';
import { planeToWorld } from '../../geometry/workPlane';
import { triangulatePolygon } from '../../lib/triangulate';
import type { PreDepthPolygon } from './types';

const stroke = (verts: Vec3[], color: string): PreDepthPolygon => ({ verts, color, normal: [0, 0, 1], stroke: true });

export function regionPolygons(region: RegionEntity): PreDepthPolygon[] {
  const place = (point: Vec2): Vec3 => planeToWorld(region.position, region.rotation, point);
  const { color } = region;
  const outlines = region.loops.map((loop) => stroke([...loop, loop[0] as Vec2].map(place), color));
  const lines = regionHatchLines(region).map(([a, b]) => stroke([place(a), place(b)], color));
  if (region.hatch?.pattern !== 'solid') return [...outlines, ...lines];
  const fills = regionFaces(region.loops).flatMap(({ outer, holes }) => {
    const { vertices, triangles } = triangulatePolygon(outer, holes);
    return triangles.map(
      ([i, j, k]): PreDepthPolygon => ({
        verts: [i, j, k].map((index) => place(vertices[index] as Vec2)),
        color,
        normal: [0, 0, 1],
        stroke: false,
      }),
    );
  });
  return [...fills, ...outlines];
}
