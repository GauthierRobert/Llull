import type { CadDocument, Entity, Vec3 } from '../../model/types';
import { cross3, dot3 } from '../../lib/vec3';
import type { ExecutionContext } from '../types';
import { entityBounds } from '../../geometry/bounds';
import { expandInstance } from '../../geometry/instanceExpansion';
import { polygonArea, polygonCentroid } from '../../lib/polygon';
import { chainLength } from '../../geometry/curveSegments';
import { sweepTriangles } from '../../geometry/sweep';
import { loftTriangles } from '../../geometry/loft';
import { subdivisionTriangles } from '../../geometry/subdivision';
import { currentContext } from '../context';

/** Volume of one solid: how it was computed, or why it could not be. */
export type SolidVolume =
  | {
      readonly volume: number;
      /** 'exact': the kernel's B-rep volume; 'mesh': the display triangles; absent: a closed form. */
      readonly method?: 'exact' | 'mesh';
      /** Set when the figure is a bounding-box approximation (revolution profile crossing its axis). */
      readonly approximation?: string;
    }
  | { readonly error: string };

/**
 * Exact volume of a kernel result (a mesh entity that keeps its B-rep recipe), or null when no
 * kernel with exact topology (OCC) is installed. The display mesh is a coarse tessellation (0.1
 * linear / 0.5 rad angular deflection), so its volume is off by up to ~1 % on small curved parts —
 * too much for a mass check against a drawing.
 */
function exactVolume(e: Entity, ctx: ExecutionContext | undefined): number | null {
  if (e.kind !== 'mesh' || e.brep === undefined) return null;
  const kernel = (ctx ?? currentContext()).kernel;
  const shape = kernel?.evaluate(e.brep) ?? null;
  const topology = shape === null ? null : (kernel?.topology(shape) ?? null);
  return topology !== null && topology.volume > 0 ? topology.volume : null;
}

/** Round sections: annulus area × path length (Pappus); other sections: tessellated volume. */
function sweepVolume(e: Extract<Entity, { kind: 'sweep' }>): number {
  const { section } = e;
  if (section.shape === 'circle' && e.stations === undefined) {
    const bore = section.innerRadius ?? 0;
    return Math.PI * (section.radius ** 2 - bore ** 2) * chainLength(e.path);
  }
  return closedMeshVolume(sweepTriangles(e).flat(2));
}

/** Volume of a closed, outward-wound triangle soup. */
function closedMeshVolume(positions: number[]): number {
  const indices = Array.from({ length: positions.length / 3 }, (_, corner) => corner);
  return Math.abs(meshVolume(positions, indices));
}

/** Signed-tetrahedra volume of a closed, consistently wound indexed mesh (Σ A·(B×C) / 6). */
function meshVolume(positions: ReadonlyArray<number>, indices: ReadonlyArray<number>): number {
  const vertex = (i: number): Vec3 => [
    positions[i * 3] as number,
    positions[i * 3 + 1] as number,
    positions[i * 3 + 2] as number,
  ];
  let sum = 0;
  for (let t = 0; t + 2 < indices.length; t += 3) {
    sum += dot3(
      vertex(indices[t] as number),
      cross3(vertex(indices[t + 1] as number), vertex(indices[t + 2] as number)),
    );
  }
  return Math.abs(sum / 6);
}

/**
 * Volume of one solid entity (instances: the sum of their baked solid children).
 * @pure
 * @failure instance with a missing component, or a non-solid kind -> { error }
 */
export function solidVolume(
  doc: CadDocument,
  e: Entity,
  ctx: ExecutionContext | undefined,
): SolidVolume {
  switch (e.kind) {
    case 'box':
      return { volume: e.size[0] * e.size[1] * e.size[2] };
    case 'cylinder':
      return { volume: Math.PI * e.radius * e.radius * e.height };
    case 'sphere':
      return { volume: (4 / 3) * Math.PI * e.radius * e.radius * e.radius };
    case 'extrusion':
      return { volume: polygonArea(e.profile) * e.depth };
    case 'mesh': {
      const exact = exactVolume(e, ctx);
      return exact === null
        ? { volume: meshVolume(e.mesh.positions, e.mesh.indices), method: 'mesh' }
        : { volume: exact, method: 'exact' };
    }
    case 'cone':
      return { volume: (Math.PI * e.radius * e.radius * e.height) / 3 };
    case 'torus':
      return { volume: 2 * Math.PI * Math.PI * e.ringRadius * e.tubeRadius * e.tubeRadius };
    case 'wedge':
      return { volume: (e.size[0] * e.size[1] * e.size[2]) / 2 };
    case 'pyramid':
      return { volume: (e.baseWidth * e.baseDepth * e.height) / 3 };
    case 'instance': {
      const component = doc.components[e.componentId];
      if (!component)
        return { error: `instance '${e.id}' references missing component '${e.componentId}'.` };
      // Bake the instance (scale, rotation, translation) and sum its solid children.
      let volume = 0;
      for (const child of expandInstance(e, component)) volume += childVolume(doc, child, ctx);
      return { volume };
    }
    case 'revolution': {
      // Pappus: V = sweepAngle * |centroid x| * profile area; profile x = distance from the axis.
      // A profile crossing the axis falls back to the bounding-box volume.
      if (e.profile.some(([x]) => x < 0)) {
        const b = entityBounds(e);
        return {
          volume: (b.max[0] - b.min[0]) * (b.max[1] - b.min[1]) * (b.max[2] - b.min[2]),
          approximation:
            'bounding-box approximation — profile crosses revolution axis; Pappus requires profile x ≥ 0',
        };
      }
      const profileArea = polygonArea(e.profile);
      return {
        volume:
          profileArea < 1e-12
            ? 0
            : (e.angle ?? 2 * Math.PI) * Math.abs(polygonCentroid(e.profile)[0]) * profileArea,
      };
    }
    case 'sweep':
      return { volume: sweepVolume(e) };
    case 'loft':
      return { volume: closedMeshVolume(loftTriangles(e).flat(2)) };
    case 'subdivision':
      return { volume: closedMeshVolume(subdivisionTriangles(e).flat(2)) };
    case 'line':
    case 'polyline':
    case 'arc':
    case 'circle':
    case 'rectangle':
    case 'point':
    case 'ellipse':
    case 'spline':
    case 'text':
    case 'dimension':
    case 'image':
      return {
        error:
          `entity '${e.id}' is kind '${e.kind}'; ` +
          "supported kinds are 'box', 'cylinder', 'sphere', 'extrusion', 'mesh', 'cone', 'torus', 'wedge', 'pyramid', 'revolution', 'sweep', 'loft', 'subdivision', 'instance'.",
      };
  }
}

/** Volume of a baked instance child; 2D and unsupported children weigh nothing. */
export function childVolume(
  doc: CadDocument,
  child: Entity,
  ctx: ExecutionContext | undefined,
): number {
  const part = solidVolume({ ...doc, entities: { [child.id]: child } }, child, ctx);
  return 'error' in part ? 0 : part.volume;
}
