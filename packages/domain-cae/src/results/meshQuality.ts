/** Tetrahedron quality of a mesh artifact (corner nodes only; midside nodes of C3D10 do not enter). */

import type { FeMeshArtifact, QualitySummary } from '@core/model/analysis';
import { sub3 } from '@lib/vec3';

type Metric = { min: number; max: number; p01: number; p99: number; outsideAcceptable: number };

/** tet scaled Jacobian must stay in [0.5, 1] (Verdict range, 05 §5.5); edge ratio lmax/lmin is flagged above 3. */
const SJ_ACCEPTABLE_MIN = 0.5;
const EDGE_RATIO_ACCEPTABLE_MAX = 3;

function percentile(sorted: readonly number[], fraction: number): number {
  if (sorted.length === 0) return 0;
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.round(fraction * (sorted.length - 1))))] ?? 0;
}

function metric(values: readonly number[], outside: (value: number) => boolean): Metric {
  const sorted = [...values].sort((a, b) => a - b);
  return {
    min: sorted[0] ?? 0,
    max: sorted[sorted.length - 1] ?? 0,
    p01: percentile(sorted, 0.01),
    p99: percentile(sorted, 0.99),
    outsideAcceptable: values.filter(outside).length,
  };
}

type P = readonly [number, number, number];
const length = (a: P): number => Math.hypot(a[0], a[1], a[2]);
const triple = (a: P, b: P, c: P): number =>
  a[0] * (b[1] * c[2] - b[2] * c[1]) - a[1] * (b[0] * c[2] - b[2] * c[0]) + a[2] * (b[0] * c[1] - b[1] * c[0]);

/**
 * Quality of every tetrahedron: `tet_scaled_jacobian` = sqrt(2) * 6V / lambdaMax (1 = regular, <= 0 = inverted; llull normalisation of the
 * Verdict metric) and `tet_edge_ratio` = longest / shortest edge. Deterministic.
 * @invariant `inverted` counts elements with scaled Jacobian <= 0
 */
export function meshQuality(mesh: FeMeshArtifact): QualitySummary {
  const coordinates = new Map<number, P>(mesh.nodes.map((node) => [node[0], [node[1], node[2], node[3]]]));
  const scaledJacobian: number[] = [];
  const edgeRatio: number[] = [];
  for (const block of mesh.blocks)
    for (const element of block.elements) {
      const corners = [1, 2, 3, 4].map((index) => coordinates.get(element[index] ?? -1));
      const [a, b, c, d] = corners;
      if (a === undefined || b === undefined || c === undefined || d === undefined) continue;
      const volume6 = triple(sub3(b, a), sub3(c, a), sub3(d, a));
      const edges = [sub3(b, a), sub3(c, a), sub3(d, a), sub3(c, b), sub3(d, b), sub3(d, c)].map(length);
      const at = (vertex: number): number => {
        const incident: number[] = vertex === 0 ? [0, 1, 2] : vertex === 1 ? [0, 3, 4] : vertex === 2 ? [1, 3, 5] : [2, 4, 5];
        return incident.reduce((product, edge) => product * (edges[edge] ?? 0), 1);
      };
      const lambdaMax = Math.max(at(0), at(1), at(2), at(3));
      scaledJacobian.push(lambdaMax > 0 ? (Math.SQRT2 * volume6) / lambdaMax : 0);
      const shortest = Math.min(...edges);
      edgeRatio.push(shortest > 0 ? Math.max(...edges) / shortest : Number.MAX_SAFE_INTEGER);
    }
  return {
    metrics: {
      tet_scaled_jacobian: metric(scaledJacobian, (value) => value < SJ_ACCEPTABLE_MIN),
      tet_edge_ratio: metric(edgeRatio, (value) => value > EDGE_RATIO_ACCEPTABLE_MAX),
    },
    inverted: scaledJacobian.filter((value) => value <= 0).length,
  };
}
