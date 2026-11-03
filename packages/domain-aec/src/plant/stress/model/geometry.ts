/**
 * The geometry of a built stress model as data (07 PST M4): node positions and element / pipe centrelines in mm, shared by `analyze_pipe_stress` (`include: "geometry"`)
 * and the `render_view` overlay so there is one source. Node ids are `N<k>` (k = index + 1), as in every other result.
 * @invariant pure and deterministic; positions are the solver's nodes (absolute document mm, building pipes and 02 RTE runs alike)
 */

import type { BuiltModel } from './build';

type Point = readonly [number, number, number];

export interface GeometryNode {
  readonly id: string;
  readonly positionMm: Point;
}
export interface GeometryElement {
  readonly id: string;
  readonly pipeId: string;
  readonly kind: 'straight' | 'bend';
  readonly nodeIds: readonly [string, string];
  /** Centreline end points of the element (a bend is the chord of its arc), mm. */
  readonly pointsMm: readonly [Point, Point];
  readonly odMm: number;
  readonly wallMm: number;
  readonly bendRadiusMm: number | null;
}
export interface GeometryPipe {
  readonly id: string;
  readonly kind: 'pipe' | 'run';
  /** The centreline through the points of intersection, mm. */
  readonly pointsMm: readonly Point[];
  readonly elementIds: readonly string[];
}
export interface ModelGeometry {
  readonly nodes: readonly GeometryNode[];
  readonly elements: readonly GeometryElement[];
  readonly pipes: readonly GeometryPipe[];
}

export function modelGeometry(built: BuiltModel): ModelGeometry {
  const { nodes, elements } = built.layout;
  const at = (index: number): Point => nodes[index] ?? [0, 0, 0];
  return {
    nodes: nodes.map((position, index) => ({ id: `N${index + 1}`, positionMm: [position[0], position[1], position[2]] })),
    elements: elements.map((element) => ({
      id: element.id,
      pipeId: element.pipeId,
      kind: element.kind,
      nodeIds: [`N${element.a + 1}`, `N${element.b + 1}`],
      pointsMm: [at(element.a), at(element.b)],
      odMm: element.odMm,
      wallMm: element.wallMm,
      bendRadiusMm: element.bend?.radiusMm ?? null,
    })),
    pipes: built.sources.pipes.map((pipe) => ({
      id: pipe.id,
      kind: pipe.kind,
      pointsMm: pipe.points.map((p) => [p[0], p[1], p[2]] as const),
      elementIds: elements.filter((element) => element.pipeId === pipe.id).map((element) => element.id),
    })),
  };
}
