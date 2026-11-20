/** Deterministic 1M-triangle mesh files for the PERF1 mesh gate: a closed torus of `around` x `along` quads as binary STL and as OBJ text. */

const TAU = Math.PI * 2;

function torus(around: number, along: number): { positions: Float64Array; triangles: Uint32Array } {
  const positions = new Float64Array(around * along * 3);
  for (let i = 0; i < around; i += 1) {
    for (let j = 0; j < along; j += 1) {
      const [u, v] = [(i / around) * TAU, (j / along) * TAU];
      const ring = 100 + 30 * Math.cos(v);
      positions.set([Math.fround(ring * Math.cos(u)), Math.fround(ring * Math.sin(u)), Math.fround(30 * Math.sin(v))], (i * along + j) * 3);
    }
  }
  const triangles = new Uint32Array(around * along * 6);
  let at = 0;
  for (let i = 0; i < around; i += 1) {
    for (let j = 0; j < along; j += 1) {
      const [a, b] = [i * along + j, ((i + 1) % around) * along + j];
      const [c, d] = [((i + 1) % around) * along + ((j + 1) % along), i * along + ((j + 1) % along)];
      triangles.set([a, b, c, a, c, d], at);
      at += 6;
    }
  }
  return { positions, triangles };
}

/** Binary STL of the torus: 2 x around x along facets. */
export function torusStl(around: number, along: number): Uint8Array {
  const { positions, triangles } = torus(around, along);
  const count = triangles.length / 3;
  const bytes = new Uint8Array(84 + count * 50);
  const view = new DataView(bytes.buffer);
  view.setUint32(80, count, true);
  for (let t = 0; t < count; t += 1)
    for (let k = 0; k < 3; k += 1)
      for (let a = 0; a < 3; a += 1)
        view.setFloat32(84 + t * 50 + 12 + k * 12 + a * 4, positions[(triangles[t * 3 + k] ?? 0) * 3 + a] ?? 0, true);
  return bytes;
}

/** OBJ text of the same torus (`v x y z` and `f a b c` lines, 1-based). */
export function torusObj(around: number, along: number): Uint8Array {
  const { positions, triangles } = torus(around, along);
  const lines: string[] = ['# torus', 'o torus'];
  for (let v = 0; v < positions.length; v += 3) lines.push(`v ${positions[v]} ${positions[v + 1]} ${positions[v + 2]}`);
  for (let t = 0; t < triangles.length; t += 3)
    lines.push(`f ${(triangles[t] ?? 0) + 1} ${(triangles[t + 1] ?? 0) + 1} ${(triangles[t + 2] ?? 0) + 1}`);
  return new TextEncoder().encode(`${lines.join('\n')}\n`);
}
