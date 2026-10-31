/**
 * Corner treatment of fillet_edge (BLD M3, TECHNICAL_SPEC §3, §5.5): picks the vertices (persistent name, point, or every vertex where 3 or more
 * rounded edges meet), gives each setback corner the distance from the vertex at which every edge blend stops, and derives the persistent
 * vertex names to record so a regeneration follows the same corners (REF_LOST / REF_SPLIT when one is gone).
 * @invariant a vertex gets one treatment; a setback corner has a distance for every edge meeting at the vertex (non-degenerate edges) ; the edges marked rollingBall (rounded by the kernel and cut by the
 *   same ball) are listed with distance 0 (not absent: a missing edge is an error of the native builder); at least one edge has a distance > 0
 * @failure a selector that is not exactly one of name / near / all, an unknown or repeated vertex, a distance missing for an edge, an override
 *   edge that does not meet the vertex -> a problem; a lost / split vertex or edge name -> REF_LOST / REF_SPLIT; a smooth, multi-station or profiled blend with a
 *   setback corner -> BLD_CORNER_UNSUPPORTED
 */

import type { EdgeRadius, Vec3 } from '../../model/types';
import type { SetbackCorner } from '../../model/blendTypes';
import type { ShapeTopology } from '../../geometry/kernel';
import { nearestVertex, resolveVertexName, solidVertices } from '../../geometry/blend/vertices';
import { hasNames, resolveNames } from '../../geometry/naming/references';
import { selectEdges } from './edgeSelection';
import { vec3, z } from '../schema';

export const REPICK_VERTICES =
  'Re-pick: edit_step_params on this step with new corners[].name (persistent vertex names look like "v(<edge name>,...)"; inspect_topology lists the edge names), or use corners[].near / all again.';

const CORNER_TYPES = ['rolling_ball', 'setback'] as const;

export const cornerSchema = z
  .object({
    name: z
      .string()
      .min(1)
      .describe(
        'Persistent vertex name "v(<edge name>,...)" (names of the edges meeting there; recorded automatically from the first pick and used on regeneration: a vertex that is gone or split refuses the step with REF_LOST / REF_SPLIT). Give exactly one of name, near or all.',
      )
      .optional(),
    near: vec3(
      'A point [x, y, z] in document units at or near the vertex (the vertex nearest to it is taken). Give exactly one of name, near or all.',
    ).optional(),
    all: z
      .boolean()
      .describe('true = every vertex where 3 or more of the rounded edges meet. Give exactly one of name, near or all.')
      .optional(),
    type: z
      .enum(CORNER_TYPES)
      .describe(
        '"setback" (default): each edge blend stops `setback` away from the vertex and a smooth patch (G1 to the blends and the faces) fills the corner; ' +
          '"rolling_ball": the kernel corner (what happens at a vertex without an entry).',
      )
      .optional(),
    setback: z
      .number()
      .positive()
      .describe(
        'Setback distance in document units, used for every edge meeting there. It must exceed the distance the neighbouring blends reach (about the radius on a right-angle corner), else BLD_SETBACK_TOO_SHORT names the minimum.' +
          ' Two builders, two meanings: on straight edges between planar faces it is measured ALONG each edge from the vertex; where an edge is curved or a face is not planar (a circle, a B-spline, a cylinder, a cone, a free-form face) the blends are the kernel rolling-ball blends and with the same distance on every edge of the vertex it is the RADIUS OF A BALL around the vertex (the ball must exceed the farthest point of the rolling-ball corner, about radius x sqrt(2) on a right-angle corner, else BLD_SETBACK_TOO_SHORT, and must not reach a face that does not meet the vertex); with different distances each edge is cut by a plane normal to it at its own distance ALONG the edge (as on straight edges), and the planes must isolate the vertex ("the cut planes do not isolate the vertex" otherwise). The ball and the plane agree only at the point of the edge. One step uses one builder: vertices of both kinds are refused.',
      )
      .optional(),
    setbacks: z
      .array(
        z.object({
          near: vec3(
            'A point [x, y, z] in document units on or near the edge that meets the vertex. Give exactly one of near or name.',
          ).optional(),
          name: z.string().min(1).describe('Persistent name of the edge. Give exactly one of near or name.').optional(),
          distance: z
            .number()
            .positive()
            .describe(
              'Setback of this edge from the vertex, document units (> 0): along the edge on straight edges between planar faces; on a curved edge or face equal distances at a vertex are the radius of a ball, different ones a plane normal to each edge at its distance along it. Give it, or rollingBall: true.',
            )
            .optional(),
          rollingBall: z
            .boolean()
            .describe(
              'true: this edge gets no setback of its own; the kernel rounds it with the rolling ball like the others and the same ball around the vertex cuts its blend (only at a vertex on a curved edge or face; the analytic builder refuses it by name). Instead of distance.',
            )
            .optional(),
        }),
      )
      .describe('Per-edge setbacks overriding `setback` (each entry names one edge meeting the vertex).')
      .optional(),
  })
  .describe(
    'Corner treatment at one vertex or all: a setback corner (every edge meeting there is rounded in this step with a constant radius: straight edges between planar faces, all convex or all concave, take the analytic builder and a star of exact sub-patches; a circle, a B-spline or a cylinder / cone / free-form face at the vertex takes the rolling-ball blend cut inside a ball of the setback around the vertex, one setback distance per vertex, the hole filled by a star of exact sub-patches, the plate fit as the fallback).',
  );

export type CornerInput = z.infer<typeof cornerSchema>;

export interface CornerRefusal {
  readonly code: 'BLD_CORNER_UNSUPPORTED' | 'REF_LOST' | 'REF_SPLIT';
  readonly message: string;
  readonly path: string;
}

export type CornerResolution =
  | {
      /** The setback corners for the recipe (rolling-ball entries are the kernel default and leave no trace). */
      readonly corners: readonly SetbackCorner[];
      /** `corners` with every vertex (and override edge) by persistent name, to record; null when nothing is to be added. */
      readonly record: readonly CornerInput[] | null;
    }
  | { readonly problem: string }
  | { readonly refusal: CornerRefusal };

interface Planned {
  readonly edge: number;
  readonly law: EdgeRadius;
}

/** A radius a setback corner cannot take: anything but a constant one or a straight (linear) one between the two ends of the edge. */
const isVarying = (law: EdgeRadius): boolean =>
  law.sizes !== undefined ||
  law.size2 !== undefined ||
  (law.sizeEnd !== undefined && law.sizeEnd !== law.size && law.interpolation !== 'linear');

/** The distance of every edge override, by unique-edge index (and the edges left to the rolling ball); or why one cannot be resolved. */
function overrides(
  topology: ShapeTopology,
  entry: CornerInput,
  path: string,
): { readonly distances: Map<number, number>; readonly rolling: Set<number> } | CornerResolution {
  const distances = new Map<number, number>();
  const rolling = new Set<number>();
  for (const [at, override] of (entry.setbacks ?? []).entries()) {
    const where = `${path}.setbacks[${at}]`;
    if ((override.near === undefined) === (override.name === undefined)) return { problem: `${where} needs exactly one of near or name` };
    let edge: number | undefined;
    if (override.name !== undefined) {
      const found = hasNames(topology, 'edge') ? resolveNames(topology, 'edge', [override.name]) : null;
      if (found === null) return { problem: `${where}.name: this kernel keeps no edge names` };
      if (!found.ok)
        return {
          refusal: {
            code: found.lost.length > 0 ? 'REF_LOST' : 'REF_SPLIT',
            message: `${where}.name "${override.name}" ${found.lost.length > 0 ? 'is no longer an edge of the solid' : 'now names several edges'}`,
            path: `${where}.name`,
          },
        };
      edge = found.indices[0];
    } else {
      const picked = selectEdges(topology, [], override.near === undefined ? [] : [override.near]);
      edge = 'problem' in picked ? undefined : picked.edges[0];
    }
    if (edge === undefined) return { problem: `${where} found no edge` };
    if (distances.has(edge) || rolling.has(edge)) return { problem: `${where}: edge ${edge} is given twice` };
    if (override.rollingBall === true) {
      if (override.distance !== undefined) return { problem: `${where} gives both distance and rollingBall` };
      rolling.add(edge);
    } else if (override.distance === undefined) return { problem: `${where} needs a distance or rollingBall: true` };
    else distances.set(edge, override.distance);
  }
  return { distances, rolling };
}

/** An override as recorded: its edge by persistent name when the name finds exactly this edge, else by a point on it. */
function recordedEdge(topology: ShapeTopology, edge: number, distance: number): NonNullable<CornerInput['setbacks']>[number] {
  const name = topology.edges[edge]?.name;
  const unique = name !== undefined && hasNames(topology, 'edge') && resolveNames(topology, 'edge', [name]).ok;
  return unique ? { name, distance } : { near: [...(topology.edges[edge]?.mid ?? [0, 0, 0])] as [number, number, number], distance };
}

const isOverride = (
  value: ReturnType<typeof overrides>,
): value is Extract<ReturnType<typeof overrides>, { distances: Map<number, number> }> => 'distances' in value;

const recordedRolling = (topology: ShapeTopology, edge: number): NonNullable<CornerInput['setbacks']>[number] => {
  const name = topology.edges[edge]?.name;
  const unique = name !== undefined && hasNames(topology, 'edge') && resolveNames(topology, 'edge', [name]).ok;
  return unique
    ? { name, rollingBall: true }
    : { near: [...(topology.edges[edge]?.mid ?? [0, 0, 0])] as [number, number, number], rollingBall: true };
};

/**
 * The corners `inputs` ask for on `topology`, for a fillet of `planned` edges.
 * @failure see the module doc
 */
export function resolveCorners(
  topology: ShapeTopology | null,
  planned: readonly Planned[],
  inputs: readonly CornerInput[],
  profiled: boolean,
): CornerResolution {
  if (topology === null) return { problem: 'corners need the exact topology of the native kernel' };
  const vertices = solidVertices(topology);
  const rounded = new Set(planned.map((entry) => entry.edge));
  const corners: SetbackCorner[] = [];
  const record: CornerInput[] = [];
  const claimed = new Set<number>();
  for (const [position, input] of inputs.entries()) {
    const path = `corners[${position}]`;
    const selectors = [input.name, input.near, input.all === true ? true : undefined].filter((selector) => selector !== undefined);
    if (selectors.length !== 1) return { problem: `${path} needs exactly one of name, near or all` };
    const type = input.type ?? 'setback';
    let targets: number[];
    if (input.name !== undefined) {
      const found = resolveVertexName(vertices, input.name);
      if (!found.ok)
        return {
          refusal: {
            code: found.lost ? 'REF_LOST' : 'REF_SPLIT',
            message: `${path}.name "${input.name}" ${found.lost ? 'is no longer a vertex of the solid' : 'now names several vertices'}`,
            path: `${path}.name`,
          },
        };
      targets = [found.index];
    } else if (input.near !== undefined) {
      const nearest = nearestVertex(vertices, input.near as Vec3);
      if (nearest < 0) return { problem: `${path}.near found no vertex` };
      targets = [nearest];
    } else {
      targets = vertices.flatMap((vertex, at) => (vertex.edges.filter((edge) => rounded.has(edge)).length >= 3 ? [at] : []));
      if (targets.length === 0) return { problem: `${path}: no vertex has 3 or more rounded edges` };
    }
    const resolved = overrides(topology, input, path);
    if (!isOverride(resolved)) return resolved;
    if (type === 'setback' && (profiled || planned.some((entry) => isVarying(entry.law))))
      return {
        refusal: {
          code: 'BLD_CORNER_UNSUPPORTED',
          message: `${path}: setback corners need circular edge blends whose radius is constant or linear between the two ends of the edge in this build (edges[] with sizeEnd and interpolation "linear"; no smooth radiusEnd, sizes, law, size2 or profile)`,
          path,
        },
      };
    for (const edge of [...resolved.distances.keys(), ...resolved.rolling])
      if (!targets.some((target) => vertices[target]?.edges.includes(edge)))
        return { problem: `${path}.setbacks: edge ${edge} does not meet ${targets.length === 1 ? 'the vertex' : 'any of the vertices'}` };
    for (const target of targets) {
      const vertex = vertices[target];
      if (vertex === undefined) continue;
      if (claimed.has(target)) return { problem: `${path}: the vertex at [${vertex.point.join(', ')}] already has a corner entry` };
      claimed.add(target);
      // Recorded by name when the name finds exactly this vertex (else by point), with only the overrides of edges that meet it.
      const recordedOverrides = [
        ...[...resolved.distances]
          .filter(([edge]) => vertex.edges.includes(edge))
          .map(([edge, distance]) => recordedEdge(topology, edge, distance)),
        ...[...resolved.rolling].filter((edge) => vertex.edges.includes(edge)).map((edge) => recordedRolling(topology, edge)),
      ];
      record.push({
        ...(vertex.name !== undefined && resolveVertexName(vertices, vertex.name).ok
          ? { name: vertex.name }
          : { near: [...vertex.point] as [number, number, number] }),
        type,
        ...(input.setback === undefined ? {} : { setback: input.setback }),
        ...(recordedOverrides.length === 0 ? {} : { setbacks: recordedOverrides }),
      });
      if (type === 'rolling_ball') continue;
      const distances: SetbackCorner['distances'][number][] = [];
      for (const edge of vertex.edges) {
        if (resolved.rolling.has(edge)) {
          distances.push({ edge, distance: 0 });
          continue;
        }
        const distance = resolved.distances.get(edge) ?? input.setback;
        if (distance === undefined)
          return {
            problem: `${path}: edge ${edge} meets the vertex at [${vertex.point.join(', ')}] but has no setback (give setback or setbacks)`,
          };
        distances.push({ edge, distance });
      }
      if (!distances.some((entry) => entry.distance > 0))
        return {
          problem: `${path}: at least one edge at the vertex at [${vertex.point.join(', ')}] needs a setback distance (it is the radius of the ball that cuts the blends); not every edge can be rollingBall`,
        };
      corners.push({ vertex: vertex.point, type: 'setback', distances });
    }
  }
  const everyNamed = inputs.every(
    (input) => input.name !== undefined && (input.setbacks ?? []).every((override) => override.name !== undefined),
  );
  return { corners, record: everyNamed ? null : record };
}
