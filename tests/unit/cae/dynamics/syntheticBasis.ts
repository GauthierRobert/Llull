/** Seeded synthetic random-response jobs for the native comparison (VC-DYN-48): modal bases independent of any mesh or solver. */
import type { RandomFieldInput } from '@cae/dynamics/nodalField';
import { integrationGrid } from '@cae/dynamics/math/randomResponse';
import { seeded } from '../gridMesh';

const GEVS: [number, number][] = [
  [20, 0.026],
  [50, 0.16],
  [800, 0.16],
  [2000, 0.026],
];

/** `modes` sorted frequencies in 30..2500 Hz, `nodes` x `modes` x 9 modal values in [-50, 50), viscous or structural damping. */
export function syntheticInput(seed: number, nodes: number, modes: number, structural: boolean): RandomFieldInput {
  const random = seeded(seed);
  const fHz = Array.from({ length: modes }, () => 30 + random() * 2470).sort((a, b) => a - b);
  const omega = fHz.map((f) => 2 * Math.PI * f);
  const zeta = fHz.map(() => 0.005 + random() * 0.05);
  const grid = integrationGrid(
    GEVS,
    [20, 2000],
    fHz.map((f, j) => ({ fHz: f, zeta: zeta[j] ?? 0 })),
  );
  const dampingA = omega.map((w, j) => (structural ? 2 * (zeta[j] ?? 0) * w * w : 0));
  const dampingB = omega.map((w, j) => (structural ? 0 : 2 * (zeta[j] ?? 0) * w));
  const components = [
    ...[0, 1, 2].map((source) => ({ source, kind: 'relative' as const, unity: false, scale: 9806.65 })),
    ...[0, 1, 2].map((source) => ({ source, kind: 'absolute' as const, unity: source === 2, scale: 1 })),
    ...[3, 4, 5, 6, 7, 8].map((source) => ({ source, kind: 'relative' as const, unity: false, scale: 9806.65 })),
  ];
  return {
    job: {
      nodeCount: nodes,
      modes,
      sources: 9,
      basis: { omega, dampingA, dampingB },
      gamma: fHz.map(() => (random() - 0.5) * 2),
      grid,
      components,
    },
    modal: Float64Array.from({ length: nodes * modes * 9 }, () => (random() - 0.5) * 100),
    nodeIds: Array.from({ length: nodes }, (_, i) => i + 1),
    components: components.map((_, i) => `c${i}`),
    units: components.map(() => '-'),
  };
}
