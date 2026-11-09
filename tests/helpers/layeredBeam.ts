/**
 * Independent oracle of PHY-16 VC-PRC-30: Euler-Bernoulli beam (plane sections, linear elastic, per unit width) built layer by layer. Each layer is added stress
 * free on the current stack and then receives a uniform eigenstrain; the increment (e0, k) solves N = 0, M = 0 over the stack. Same equations as
 * docs/physics/16-process-physics/validation/generate_prc_reference.py (section 3), whose CSV the oracle test compares with to 1e-9.
 */

interface Layer {
  readonly z0: number;
  readonly z1: number;
  readonly E: number;
}

interface Section {
  readonly A: number;
  readonly B: number;
  readonly D: number;
}

const section = (layers: readonly Layer[]): Section => ({
  A: layers.reduce((sum, { z0, z1, E }) => sum + E * (z1 - z0), 0),
  B: layers.reduce((sum, { z0, z1, E }) => sum + (E * (z1 ** 2 - z0 ** 2)) / 2, 0),
  D: layers.reduce((sum, { z0, z1, E }) => sum + (E * (z1 ** 3 - z0 ** 3)) / 3, 0),
});

export interface LayeredBeam {
  /** Curvature increment of each deposited layer (1/length, the sign of the eigenstrain: negative = the top face shortens). */
  readonly increments: readonly number[];
  readonly total: number;
  /** Curvature added when the substrate is removed after the build. */
  readonly release: number;
}

/**
 * Substrate `substrate` thick (z in [-substrate, 0], modulus `E`) with `count` layers of `thickness` and the same modulus on top, each with eigenstrain `strain`.
 * @invariant the first increment equals the Timoshenko bimetal curvature of two layers
 */
export function layeredBeam(input: { substrate: number; E: number; count: number; thickness: number; strain: number }): LayeredBeam {
  const { substrate, E, count, thickness, strain } = input;
  const layers: Layer[] = [{ z0: -substrate, z1: 0, E }];
  const state: { e0: number; k: number }[] = [{ e0: 0, k: 0 }];
  const increments: number[] = [];
  for (let i = 0; i < count; i++) {
    layers.push({ z0: i * thickness, z1: (i + 1) * thickness, E });
    state.push({ e0: 0, k: 0 });
    const { A, B, D } = section(layers);
    const added = layers[layers.length - 1] as Layer;
    const N = E * strain * (added.z1 - added.z0);
    const M = (E * strain * (added.z1 ** 2 - added.z0 ** 2)) / 2;
    const det = A * D - B * B;
    const de0 = (N * D - B * M) / det;
    const dk = (A * M - B * N) / det;
    for (const entry of state) {
      entry.e0 += de0;
      entry.k += dk;
    }
    increments.push(dk);
  }
  const first = layers[0] as Layer;
  const own = state[0] as { e0: number; k: number };
  const N0 = E * (own.e0 * (first.z1 - first.z0) + (own.k * (first.z1 ** 2 - first.z0 ** 2)) / 2);
  const M0 = E * ((own.e0 * (first.z1 ** 2 - first.z0 ** 2)) / 2 + (own.k * (first.z1 ** 3 - first.z0 ** 3)) / 3);
  const { A, B, D } = section(layers.slice(1));
  const det = A * D - B * B;
  return { increments, total: increments.reduce((sum, value) => sum + value, 0), release: (A * M0 - B * N0) / det };
}
