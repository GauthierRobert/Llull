/**
 * Corner treatment of fillet_edge (BLD M3, TECHNICAL_SPEC §3, §5.5): picks the vertices (persistent name, point, or every vertex where 3 or more
 * rounded edges meet), gives each setback corner the distance from the vertex at which every edge blend stops, and derives the persistent
 * vertex names to record so a regeneration follows the same corners (REF_LOST / REF_SPLIT when one is gone).
 * @invariant a vertex gets one treatment; a setback corner has a distance for every edge meeting at the vertex (non-degenerate edges)
 * @failure a selector that is not exactly one of name / near / all, an unknown or repeated vertex, a distance missing for an edge, an override
 *   edge that does not meet the vertex -> a problem; a lost / split vertex or edge name -> REF_LOST / REF_SPLIT; a varying or profiled blend with a
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
        'Setback distance in document units, measured along each edge from the vertex, used for every edge meeting there. It must exceed the distance the neighbouring blends reach along that edge (about the radius on a right-angle corner), else BLD_SETBACK_TOO_SHORT names the minimum.',
      )
      .optional(),
    setbacks: z
      .array(
        z.object({
          near: vec3(
            'A point [x, y, z] in document units on or near the edge that meets the vertex. Give exactly one of near or name.',
          ).optional(),
          name: z.string().min(1).describe('Persistent name of the edge. Give exactly one of near or name.').optional(),
          distance: z.number().positive().describe('Setback of this edge from the vertex, document units (> 0).'),
        }),
      )
      .describe('Per-edge setbacks overriding `setback` (each entry names one edge meeting the vertex).')
      .optional(),
  })
  .describe(
    'Corner treatment at one vertex or all: a setback corner (this build: every edge meeting there is a straight convex edge between planar faces, rounded in this step with a constant radius).',
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

const isVarying = (law: EdgeRadius): boolean => law.sizeEnd !== undefined || law.sizes !== undefined || law.size2 !== undefined;

/** The distance of every edge override, by unique-edge index; or why one cannot be resolved. */
function overrides(
  topology: ShapeTopology,
  entry: CornerInput,
  path: string,
): { readonly distances: Map<number, number> } | CornerResolution {
  const distances = new Map<number, number>();
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
    if (distances.has(edge)) return { problem: `${where}: edge ${edge} is given twice` };
    distances.set(edge, override.distance);
  }
  return { distances };
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
          message: `${path}: setback corners need constant circular edge blends in this build (no radiusEnd, sizes, law, size2 or profile)`,
          path,
        },
      };
    for (const edge of resolved.distances.keys())
      if (!targets.some((target) => vertices[target]?.edges.includes(edge)))
        return { problem: `${path}.setbacks: edge ${edge} does not meet ${targets.length === 1 ? 'the vertex' : 'any of the vertices'}` };
    for (const target of targets) {
      const vertex = vertices[target];
      if (vertex === undefined) continue;
      if (claimed.has(target)) return { problem: `${path}: the vertex at [${vertex.point.join(', ')}] already has a corner entry` };
      claimed.add(target);
      // Recorded by name when the name finds exactly this vertex (else by point), with only the overrides of edges that meet it.
      const recordedOverrides = [...resolved.distances]
        .filter(([edge]) => vertex.edges.includes(edge))
        .map(([edge, distance]) => recordedEdge(topology, edge, distance));
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
        const distance = resolved.distances.get(edge) ?? input.setback;
        if (distance === undefined)
          return {
            problem: `${path}: edge ${edge} meets the vertex at [${vertex.point.join(', ')}] but has no setback (give setback or setbacks)`,
          };
        distances.push({ edge, distance });
      }
      corners.push({ vertex: vertex.point, type: 'setback', distances });
    }
  }
  const everyNamed = inputs.every(
    (input) => input.name !== undefined && (input.setbacks ?? []).every((override) => override.name !== undefined),
  );
  return { corners, record: everyNamed ? null : record };
}
