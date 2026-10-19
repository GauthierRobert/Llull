/** Verdict element quality of a mesh artifact (05 §5.5): tetrahedra, triangles and quadrilaterals on corner nodes (midside nodes do not enter). */

import type { FeMeshArtifact, QualitySummary } from '@core/model/analysis';
import type { Vec3 } from '@core/model/vectors';
import { quadMetrics, tetMetrics, triMetrics } from './verdict';

type Metric = { min: number; max: number; p01: number; p99: number; outsideAcceptable: number };

/** Acceptable ranges quoted from the Verdict manual (05 §5.5): tet AR [1, 3], tet SJ [0.5, 1], quad AR [1, 1.3], quad SJ [0.3, 1], quad skew [0, 0.5], tri min angle [30, 60]. */
const TET_AR_MAX = 3;
const TET_SJ_MIN = 0.5;
const QUAD_AR_MAX = 1.3;
const QUAD_SJ_MIN = 0.3;
const QUAD_SKEW_MAX = 0.5;
const TRI_MIN_ANGLE = 30;
/** llull's own screen (not a Verdict range): longest / shortest edge of a tet above 3. */
const EDGE_RATIO_MAX = 3;

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

const TRIANGLES: ReadonlySet<string> = new Set(['CPS3', 'CPS6', 'S3', 'S6']);
const QUADS: ReadonlySet<string> = new Set(['CPS4', 'CPS8', 'S4', 'S8']);

/**
 * Quality of every element. Tetrahedra (C3D4 / C3D10): `tet_scaled_jacobian` (`J sqrt(2) / lambdaMax`, 1 regular, <= 0 inverted), `tet_aspect_ratio`
 * (`Lmax / (2 sqrt(6) r_in)`) and `tet_edge_ratio` (longest / shortest edge). Triangles: `tri_min_angle_deg`. Quadrilaterals: `quad_aspect_ratio`,
 * `quad_scaled_jacobian`, `quad_skew` and `quad_warpage`; warpage is reported in the histogram only (never outside the acceptable range): its Verdict
 * range [0.3, 1] flags every flat quad (open question 10). Only the metrics of the element families present are returned. Deterministic.
 * @invariant `inverted` counts elements with scaled Jacobian <= 0 (tet, quad) or a zero-area triangle
 */
export function meshQuality(mesh: FeMeshArtifact): QualitySummary {
  const coordinates = new Map<number, Vec3>(mesh.nodes.map((node) => [node[0], [node[1], node[2], node[3]]]));
  const series: Record<string, number[]> = {};
  const push = (name: string, value: number): void => void (series[name] ??= []).push(value);
  let inverted = 0;
  for (const block of mesh.blocks)
    for (const element of block.elements) {
      const count = TRIANGLES.has(block.type) ? 3 : QUADS.has(block.type) ? 4 : 4;
      const corners = element.slice(1, 1 + count).map((id) => coordinates.get(id));
      if (corners.length < count || corners.some((corner) => corner === undefined)) continue;
      const [a, b, c, d] = corners as [Vec3, Vec3, Vec3, Vec3];
      if (TRIANGLES.has(block.type)) {
        const tri = triMetrics(a, b, c);
        push('tri_min_angle_deg', tri.minAngleDeg);
        if (!(tri.area > 0)) inverted++;
      } else if (QUADS.has(block.type)) {
        const quad = quadMetrics(a, b, c, d);
        push('quad_aspect_ratio', quad.aspectRatio);
        push('quad_scaled_jacobian', quad.scaledJacobian);
        push('quad_skew', quad.skew);
        push('quad_warpage', quad.warpage);
        if (quad.scaledJacobian <= 0) inverted++;
      } else {
        const tet = tetMetrics(a, b, c, d);
        push('tet_scaled_jacobian', tet.scaledJacobian);
        push('tet_aspect_ratio', tet.aspectRatio);
        push('tet_edge_ratio', tet.edgeRatio);
        if (tet.scaledJacobian <= 0) inverted++;
      }
    }
  const outside: Record<string, (value: number) => boolean> = {
    tet_scaled_jacobian: (value) => value < TET_SJ_MIN,
    tet_aspect_ratio: (value) => value > TET_AR_MAX,
    tet_edge_ratio: (value) => value > EDGE_RATIO_MAX,
    tri_min_angle_deg: (value) => value < TRI_MIN_ANGLE,
    quad_aspect_ratio: (value) => value > QUAD_AR_MAX,
    quad_scaled_jacobian: (value) => value < QUAD_SJ_MIN,
    quad_skew: (value) => value > QUAD_SKEW_MAX,
    quad_warpage: () => false,
  };
  return {
    metrics: Object.fromEntries(Object.entries(series).map(([name, values]) => [name, metric(values, outside[name] ?? (() => false))])),
    inverted,
  };
}
