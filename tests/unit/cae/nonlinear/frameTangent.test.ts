/**
 * The corotational tangent of beam_large_deflection is the exact derivative of the internal forces (review round 1): a central finite difference
 * of F at a deformed state with large rigid rotations (> pi), axial force and end moments, and the quadratic convergence of Newton it gives.
 */
import { describe, expect, it } from 'vitest';
import { assemble, bandedEntry, factor, frameModel, solve } from '@cae/nonlinear/beam/frameModel';

/** Two elements along x, E A I chosen so axial and bending terms are of similar size. */
const coords: [number, number][] = [
  [0, 0],
  [1, 0],
  [2, 0.3],
];
const elements = [
  { a: 0, b: 1, E: 100, A: 2, I: 0.5 },
  { a: 1, b: 2, E: 100, A: 2, I: 0.5 },
];

/** A state rotated rigidly by 3.4 rad (> pi) about the origin, then stretched and bent: N and M nonzero in both elements. */
function deformedState(): Float64Array {
  const angle = 3.4;
  const [c, s] = [Math.cos(angle), Math.sin(angle)];
  const u = new Float64Array(9);
  coords.forEach(([x, y], node) => {
    const stretch = 1.02;
    const [X, Y] = [stretch * (c * x - s * y), stretch * (s * x + c * y) + 0.05 * x * x];
    u[3 * node] = X - x;
    u[3 * node + 1] = Y - y;
    u[3 * node + 2] = angle + [0.08, -0.05, 0.12][node]!;
  });
  return u;
}

describe('corotational tangent', () => {
  it('equals the central finite difference of the internal forces (all 9 dofs free)', () => {
    const model = frameModel(coords, elements, new Set());
    const u = deformedState();
    const { force, stiffness } = assemble(model, u);
    expect(Math.max(...Array.from(force, Math.abs))).toBeGreaterThan(1);
    const h = 1e-6;
    let worst = 0;
    let scale = 0;
    for (let j = 0; j < 9; j++) {
      const plus = Float64Array.from(u);
      const minus = Float64Array.from(u);
      plus[j]! += h;
      minus[j]! -= h;
      const fPlus = assemble(model, plus).force;
      const fMinus = assemble(model, minus).force;
      for (let i = 0; i < 9; i++) {
        const difference = (fPlus[i]! - fMinus[i]!) / (2 * h);
        worst = Math.max(worst, Math.abs(bandedEntry(stiffness, i, j) - difference));
        scale = Math.max(scale, Math.abs(difference));
      }
    }
    expect(worst / scale).toBeLessThan(1e-6);
  });

  it('gives quadratic Newton convergence on a clamped cantilever under a large tip load', () => {
    const n = 4;
    const nodes = Array.from({ length: n + 1 }, (_, k): [number, number] => [k / n, 0]);
    const chain = Array.from({ length: n }, (_, k) => ({ a: k, b: k + 1, E: 1, A: 1e3, I: 1 }));
    const model = frameModel(nodes, chain, new Set([0, 1, 2]));
    const load = new Float64Array(model.dofs);
    load[3 * n + 1] = -1.5;
    let u = new Float64Array(model.dofs);
    const norms: number[] = [];
    for (let iteration = 0; iteration < 12; iteration++) {
      const { force, stiffness } = assemble(model, u);
      const residual = Float64Array.from(model.free, (dof) => load[dof]! - force[dof]!);
      const norm = Math.hypot(...residual);
      norms.push(norm);
      // rounding floor of this model is about 3e-13 (EA / L0 = 4e3); measured 1.5, 276, 0.64, 0.47, 7.2e-5, 2.2e-7, 2.9e-13
      if (norm < 1e-11) break;
      const lu = factor(stiffness);
      expect(lu).not.toBeNull();
      const delta = solve(lu!, residual);
      const next = Float64Array.from(u);
      model.free.forEach((dof, k) => (next[dof] = u[dof]! + delta[k]!));
      u = next;
    }
    // quadratic: once in the basin r_{k+1} <= C r_k^2; at least two consecutive steps gain > 3 orders of magnitude
    const ratios = norms.slice(1).map((norm, k) => norm / norms[k]! ** 2);
    const lateRatios = ratios.filter((_, k) => norms[k]! < 1e-2 && norms[k + 1]! > 1e-11);
    expect(lateRatios.length).toBeGreaterThan(0);
    for (const ratio of lateRatios) expect(ratio).toBeLessThan(100);
    expect(norms.at(-1)!).toBeLessThan(1e-11);
    expect(norms.length).toBeLessThanOrEqual(10);
  });
});
