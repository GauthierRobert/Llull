/**
 * 14 FLL-M2 with the real solver: the inertial body force (GRAV / CENTRIF / per-element GRAV) the deck writer emits, solved by CalculiX on a
 * 2 x 1 x 1 mm bar of Kuhn tetrahedra with a 3-2-1 free-body support. Oracle: with a balanced load set the supports carry no reaction, so the
 * stress field does not depend on WHERE the 3-2-1 support is (two disjoint patterns give the same stress); an unbalanced set does depend on it.
 * Uniform fields (acceleration, gravity) are integrated exactly; CENTRIF and the per-element angular-acceleration GRAV are lumped at the element
 * centroids, so their pattern dependence is the discretisation error of the body force and must fall as the mesh is refined (FLL-D2).
 * Skipped without CalculiX (LLULL_CCX or ccx on the PATH).
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import type { FeMeshArtifact } from '@core/model/analysis';
import { writeInp } from '@cae/decks/inpWriter';
import { analysisInputHash } from '@cae/hash/inputHash';
import { parseFrd } from '@cae/results/frdReader';
import { requireTool } from '../../requireTool';
import { barDocument } from './deckFixtures';

const CCX = process.env['LLULL_CCX'] ?? 'ccx';
const hasCcx = spawnSync(CCX, ['-v']).error === undefined;

/** Steel density, t/mm^3, and the mass of the 2 x 1 x 1 mm bar. */
const RHO = 7.85e-9;
const MASS_T = 2 * RHO;
const bar = barDocument({ supports: false });

/** Two disjoint 3-2-1 patterns (points in mesh coordinates): A = (0,0,0), (2,0,0), (0,1,0); B = (2,1,1), (0,1,1), (2,0,1). */
const PATTERNS = {
  A: [
    [0, 0, 0],
    [2, 0, 0],
    [0, 1, 0],
  ],
  B: [
    [2, 1, 1],
    [0, 1, 1],
    [2, 0, 1],
  ],
} as const;

/** Kuhn tetrahedra (6 per cell, shared main diagonal) of the 2 x 1 x 1 bar with `n` cells per mm; node id = 1 + i + (2n + 1)(j + (n + 1) k). */
function kuhnBar(
  n: number,
  nodeOf: { (i: number, j: number, k: number): number },
): { nodes: [number, number, number, number][]; tets: number[][] } {
  const nodes: [number, number, number, number][] = [];
  for (let k = 0; k <= n; k++)
    for (let j = 0; j <= n; j++) for (let i = 0; i <= 2 * n; i++) nodes.push([nodeOf(i, j, k), i / n, j / n, k / n]);
  const orders = [
    [0, 1, 2],
    [0, 2, 1],
    [1, 0, 2],
    [1, 2, 0],
    [2, 0, 1],
    [2, 1, 0],
  ];
  const tets: number[][] = [];
  for (let k = 0; k < n; k++)
    for (let j = 0; j < n; j++)
      for (let i = 0; i < 2 * n; i++)
        for (const order of orders) {
          const at = [i, j, k];
          const path = [nodeOf(i, j, k)];
          for (const axis of order) {
            at[axis] = (at[axis] ?? 0) + 1;
            path.push(nodeOf(at[0] ?? 0, at[1] ?? 0, at[2] ?? 0));
          }
          // an odd permutation of the axes mirrors the tetrahedron: swap two nodes to keep a positive Jacobian
          const inversions = order.reduce((sum, axis, index) => sum + order.slice(index + 1).filter((later) => later < axis).length, 0);
          if (inversions % 2 === 1) [path[1], path[2]] = [path[2] ?? 0, path[1] ?? 0];
          tets.push(path);
        }
  return { nodes, tets };
}

/** The nodal stress (6 components) of the bar of `n` cells per mm solved with pattern `pattern` and the exported `command`; mounts act on `mountNodes`. */
function solve(
  n: number,
  pattern: keyof typeof PATTERNS,
  command: Record<string, unknown>,
  mountNodes: 'end' | 'all' = 'end',
): Map<string, readonly number[]> {
  const supported = execute(bar.doc, 'set_free_body_support', {
    analysisId: bar.analysisId,
    entityId: bar.boxId,
    points: PATTERNS[pattern],
  });
  const exported = execute(supported.document, 'export_flight_loads', { analysisId: bar.analysisId, ...command });
  if (exported.rejected === true) throw new Error(exported.summary);
  const doc = exported.document;
  const analysis = doc.analysis?.cases[bar.analysisId];
  const nodeOf = (i: number, j: number, k: number): number => 1 + i + (2 * n + 1) * (j + (n + 1) * k);
  const { nodes, tets } = kuhnBar(n, nodeOf);
  const at = (point: readonly number[]): number =>
    nodeOf(Math.round((point[0] ?? 0) * n), Math.round((point[1] ?? 0) * n), Math.round((point[2] ?? 0) * n));
  const sets: Record<string, readonly number[]> = {};
  (analysis?.constraintOrder ?? []).forEach((id, index) => (sets[`C_${id}`] = [at(PATTERNS[pattern][index] ?? [0, 0, 0])]));
  for (const id of analysis?.loadOrder ?? [])
    if (['force', 'moment'].includes(analysis?.loads[id]?.kind ?? ''))
      sets[`L_${id}`] = mountNodes === 'all' ? nodes.map((node) => node[0]) : nodes.filter((node) => node[1] === 2).map((node) => node[0]);
  const mesh: FeMeshArtifact = {
    kind: 'fe_mesh',
    unitSystem: 'N-mm-t-s',
    mesher: 'test',
    mesherVersion: '1',
    inputHash: analysisInputHash(doc, bar.analysisId, 'mesh'),
    nodes,
    blocks: [{ type: 'C3D4', entityId: bar.boxId, elements: tets.map((tet, index) => [index + 1, ...tet]) }],
    nodeSets: sets,
    faceSets: {},
    targets: {},
  };
  const written = writeInp(doc, bar.analysisId, mesh);
  if (!('text' in written)) throw new Error(`${written.code}: ${written.message}`);
  const dir = mkdtempSync(join(tmpdir(), 'llull-ccx-relief-'));
  try {
    writeFileSync(join(dir, 'job.inp'), written.text);
    const ran = spawnSync(CCX, ['-i', 'job'], { cwd: dir, encoding: 'utf8' });
    if (ran.status !== 0) throw new Error(`ccx failed: ${ran.stdout}\n${ran.stderr}`);
    const steps = parseFrd(readFileSync(join(dir, 'job.frd'), 'utf8'));
    return new Map(Object.entries(steps[0]?.fields['STRESS']?.values ?? {}));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * Largest stress component difference between two solves over the largest stress of the first, on the middle cross-section x = 1 (a point
 * support makes the stress next to it grow without bound as the mesh is refined, whatever its reaction: the far field carries the balance).
 */
function relativeDifference(a: Map<string, readonly number[]>, b: Map<string, readonly number[]>, n: number): number {
  const middle = [...a].filter(([node]) => (Number(node) - 1) % (2 * n + 1) === n);
  let [largest, scale] = [0, 0];
  for (const [node, row] of middle)
    row.forEach((value, k) => {
      largest = Math.max(largest, Math.abs(value - (b.get(node)?.[k] ?? NaN)));
      scale = Math.max(scale, Math.abs(value));
    });
  return largest / scale;
}

/** Pattern dependence of the mid-section stress: 0 = the supports carry nothing. */
const dependence = (n: number, command: Record<string, unknown>, mounts: 'end' | 'all' = 'end'): number =>
  relativeDifference(solve(n, 'A', command, mounts), solve(n, 'B', command, mounts), n);

/** 1e5 m/s^2 (10^4 g) along x: sigma = rho a L = 1.57 MPa at the loaded end, F = m a = 1.57 N. */
const ACCEL = { linearAccel: [1e5, 0, 0], angularVelocity: [0, 0, 0], angularAccel: [0, 0, 0] };
const FORCE = MASS_T * 1e8;
const mount = (force: readonly number[]): Record<string, unknown> => ({
  name: 'end',
  target: { entityId: bar.boxId, facesNear: [[1, 0, 0]] },
  force,
});
const AT_CENTRE = { referencePoint: [1, 0.5, 0.5] };

describe.skipIf(requireTool('calculix', hasCcx))('inertial relief with CalculiX', () => {
  it("a free bar under uniform acceleration with the balancing mount force: the supports carry nothing (d'Alembert), sigma = rho a (x_free - x)", () => {
    const command = { state: ACCEL, mounts: [mount([FORCE, 0, 0])] };
    expect(dependence(1, command)).toBeLessThan(1e-6);
    const largest = Math.max(...[...solve(2, 'A', command).values()].map((row) => Math.abs(row[0] ?? 0)));
    expect(largest).toBeGreaterThan(0.7 * RHO * 1e8 * 2);
    expect(largest).toBeLessThan(1.4 * RHO * 1e8 * 2);
  });

  it('an unbalanced mount force (60 % of m a) makes the supports react: the stress depends on where they are', () => {
    expect(dependence(1, { state: ACCEL, mounts: [mount([0.6 * FORCE, 0, 0])] })).toBeGreaterThan(0.05);
  });

  it('gravity plus the inertial state: a hover (a = 0, mount force = weight at the centre of mass) is balanced, 70 % of the weight is not', () => {
    const weight = MASS_T * 9810;
    const state = { linearAccel: [0, 0, 0], angularVelocity: [0, 0, 0], angularAccel: [0, 0, 0], gravity: [0, 0, -9.81] };
    expect(dependence(1, { state, mounts: [mount([0, 0, weight])] }, 'all')).toBeLessThan(1e-6);
    expect(dependence(1, { state, mounts: [mount([0, 0, 0.7 * weight])] }, 'all')).toBeGreaterThan(0.05);
  });

  it('a spinning free bar (CENTRIF about its centre) is in tension, sigma_xx of the order rho w^2 l^2 / 2, and the imbalance of the lumped body force falls with the mesh', () => {
    const omega = 3000;
    const command = { state: { linearAccel: [0, 0, 0], angularVelocity: [0, 0, omega], angularAccel: [0, 0, 0] }, ...AT_CENTRE };
    const field = solve(4, 'A', command);
    const rod = (RHO * omega ** 2 * 1) / 2;
    const largest = Math.max(...[...field.values()].map((row) => row[0] ?? 0));
    expect(largest).toBeGreaterThan(0.5 * rod);
    expect(largest).toBeLessThan(1.3 * rod);
    expect(Math.min(...[...field.values()].map((row) => row[0] ?? 0))).toBeGreaterThan(-0.5 * rod);
    const [coarse, fine] = [dependence(1, command), dependence(4, command)];
    expect(fine).toBeLessThan(coarse / 3);
    expect(fine).toBeLessThan(0.1);
  });

  it('an angular acceleration about the centre (one GRAV per element) is balanced to the centroid lumping, which falls as the mesh is refined (9 % to 1 % of the stress over 6 to 384 tetrahedra)', () => {
    // the torque that drives alpha = 1e7 rad/s^2: I_zz alpha, I_zz = m (2^2 + 1^2) / 12 of the 2 x 1 x 1 bar
    const torque = { name: 'torque', target: { entityId: bar.boxId, facesNear: [[1, 0, 0]] }, moment: [0, 0, ((MASS_T * 5) / 12) * 1e7] };
    const command = {
      state: { linearAccel: [0, 0, 0], angularVelocity: [0, 0, 0], angularAccel: [0, 0, 1e7] },
      mounts: [torque],
      ...AT_CENTRE,
    };
    const [coarse, fine] = [dependence(1, command), dependence(4, command)];
    expect(fine).toBeLessThan(coarse / 3);
    expect(fine).toBeLessThan(0.1);
    // without the torque the supports carry I alpha: the stress depends on them at once
    expect(dependence(4, { ...command, mounts: undefined })).toBeGreaterThan(0.5);
  });
});
