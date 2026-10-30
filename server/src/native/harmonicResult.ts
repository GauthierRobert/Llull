import type { HarmonicResult } from '@core/geometry/mesh/engineTypes';

/**
 * The harmonic map a `harmonic_map` job wrote, or null when it is malformed: (u, v, 0) per vertex in `result_positions.f64`, the ascending region vertices in
 * `result_indices.u32` (all below `vertexCount`), a report with whole counts, a known weight kind, a finite residual and four corners that are region vertices.
 */
export function harmonicFrom(
  report: Record<string, unknown>,
  positions: Buffer,
  indices: Buffer,
  vertexCount: number,
  usedCount: number,
): HarmonicResult | null {
  const n = indices.length / 4;
  if (!Number.isInteger(n) || n < 4 || n !== usedCount || positions.length !== n * 24) return null;
  const vertices = Array.from({ length: n }, (_, i) => indices.readUInt32LE(4 * i));
  if (vertices.some((v, i) => v >= vertexCount || (i > 0 && v <= (vertices[i - 1] as number)))) return null;
  const uv: number[] = [];
  for (let i = 0; i < n; i++) {
    const [u, v, z] = [positions.readDoubleLE(24 * i), positions.readDoubleLE(24 * i + 8), positions.readDoubleLE(24 * i + 16)];
    if (![u, v].every((c) => Number.isFinite(c) && c >= -1e-9 && c <= 1 + 1e-9) || z !== 0) return null;
    uv.push(u, v);
  }
  const count = (value: unknown): value is number => typeof value === 'number' && Number.isInteger(value) && value >= 0;
  const { weights, flippedFirst, collapsedInParameters, interiorVertices, boundaryVertices, cgIterations, cgResidual, corners } = report;
  if (
    (weights !== 'cotangent' && weights !== 'mean_value') ||
    !count(flippedFirst) ||
    !count(collapsedInParameters) ||
    !count(interiorVertices) ||
    !count(boundaryVertices) ||
    interiorVertices + boundaryVertices !== n ||
    !count(cgIterations) ||
    typeof cgResidual !== 'number' ||
    !Number.isFinite(cgResidual) ||
    cgResidual < 0 ||
    !Array.isArray(corners) ||
    corners.length !== 4 ||
    !corners.every((c) => count(c) && vertices.includes(c)) ||
    new Set(corners).size !== 4
  )
    return null;
  return {
    vertices,
    uv,
    weights,
    flippedFirst,
    collapsedInParameters,
    interiorVertices,
    boundaryVertices,
    cgIterations,
    cgResidual,
    corners: corners as unknown as HarmonicResult['corners'],
  };
}
