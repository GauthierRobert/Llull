/** Stress tensors `[Sxx, Syy, Szz, Sxy, Syz, Szx]` for the principal-stress tests: textbook states, rotated states with prescribed (often
 * repeated or nearly repeated) principal values, and seeded random tensors over several magnitudes. */
import { seeded } from '../gridMesh';

/** R diag(a, b, c) R^T for the rotation of unit quaternion (w, x, y, z). */
function rotated([a, b, c]: readonly number[], [w = 1, x = 0, y = 0, z = 0]: readonly number[]): number[] {
  const r = [
    [1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w)],
    [2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w)],
    [2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y)],
  ];
  const d = [a ?? 0, b ?? 0, c ?? 0];
  const at = (i: number, j: number): number => [0, 1, 2].reduce((sum, k) => sum + (r[i]?.[k] ?? 0) * (d[k] ?? 0) * (r[j]?.[k] ?? 0), 0);
  return [at(0, 0), at(1, 1), at(2, 2), at(0, 1), at(1, 2), at(2, 0)];
}

export function stressTensors(count = 400): number[][] {
  const random = seeded(4242);
  const quaternion = (): number[] => {
    const q = [random() - 0.5, random() - 0.5, random() - 0.5, random() - 0.5];
    const norm = Math.hypot(...q);
    return q.map((v) => v / norm);
  };
  const tensors: number[][] = [
    [100, 0, 0, 0, 0, 0],
    [-100, 0, 0, 0, 0, 0],
    [0, 0, 0, 50, 0, 0],
    [0, 0, 0, 0, 0, 0],
    [70, 70, 70, 0, 0, 0],
    [-70, -70, -70, 0, 0, 0],
    [100, 100, 0, 0, 0, 0],
    [-100, -100, 0, 0, 0, 0],
    [100, -100, 0, 0, 0, 0],
    [10, 20, 30, 5, 6, 7],
    [3e-9, -1e-9, 2e-9, 4e-10, 0, 1e-10],
    [2e6, -3e6, 1e6, 5e5, -7e5, 2e5],
    [100, 100 + 1e-7, -50, 1e-8, 0, 0],
  ];
  const spectra: Array<() => number[]> = [
    () => [1, 1, -2].map((v) => v * 100 * random()),
    () => [-1, -1, 2].map((v) => v * 100 * random()),
    () => {
      const a = (random() - 0.5) * 400;
      return [a, a * (1 + (random() - 0.5) * 1e-6), (random() - 0.5) * 400];
    },
    () => {
      const a = (random() - 0.5) * 400;
      return [a, -a, (random() - 0.5) * 1e-3];
    },
    () => [(random() - 0.5) * 400, (random() - 0.5) * 400, (random() - 0.5) * 400],
  ];
  for (let i = 0; i < count; i += 1) {
    const kind = i % (spectra.length + 1);
    const spectrum = spectra[kind];
    if (spectrum !== undefined) tensors.push(rotated(spectrum(), quaternion()));
    else {
      const scale = 10 ** Math.floor(random() * 8 - 3);
      tensors.push(Array.from({ length: 6 }, (_, c) => (random() - (c < 3 ? 0.3 : 0.5)) * scale));
    }
  }
  return tensors;
}
