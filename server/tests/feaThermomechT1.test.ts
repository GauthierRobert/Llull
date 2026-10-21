/**
 * VC-TMC-03 NAFEMS T1 as a finite-element solve (TR-TMC-14): a thin plate (quarter of 20 x 20 mm with symmetry) bonded to a hot disc r < a = 1 mm.
 * TWO materials, both E = 100 GPa, nu = 0.3: the disc has thermal strain 0.001 per K (alpha_hot), the plate none (alpha_bulk = 0); the field is a
 * uniform dT = 1 K (reference 0, field 1), so the stress depends on the mismatch only. Geometry from llull commands: the disc is a quarter
 * revolution, the plate a box minus a copy of it (`boolean` subtract), so the parts touch exactly on the quarter cylinder; `set_mesh_controls
 * bonding: conformal` fragments them in ONE Gmsh model, the interface nodes are shared (a bonded joint; element sets and materials per part).
 * The step in alpha is resolved by the mesh topology, not smeared over an element as in a one-material nodal temperature step.
 *
 * Plane stress is the thin-plate limit: within about one thickness h of the interface the free faces break it (3D edge effect, the hoop stress
 * rises towards the plane-strain value: nodes at r = 1.011 / 1.0067 read 59.8 / 62.9 MPa on the h = 0.05 mm plate against 49.4 / 49.7). So
 * the exterior field is read at the plate-only node on the symmetry plane y = 0 nearest r = a + 1.5 h (mid-plane) and moved to the probe
 * radius with its exact law sigma_theta ~ 1/r^2 (r_node/r)^2. Probes sit at the exact coordinates of nodes used by ONE part only: a node shared by both
 * parts averages two different stress states in the CalculiX nodal output. sigma_y on y = 0 is the hoop stress.
 *
 * Measured with Gmsh 4.15.2 + CalculiX 2.21, order 2, global size 0.2 mm, thickness h = ring refinement size on the circle (nodes, node radius r,
 * raw sigma_y there against 50 (a/r)^2, moved to 1.005 against 49.5037, disc node nearest (0.5, 0) against -50):
 * h 0.04: 47k, 1.0593, 44.93 vs 44.56, 49.92 (+0.8 %), -49.55 | h 0.02: 75k, 1.0298, 47.52 vs 47.15, 49.89 (+0.8 %), -49.55 |
 * h 0.01: 179k, 1.0149, 48.90 vs 48.54, 49.87 (+0.7 %), -49.55. The remaining +0.4 MPa is the finite plate (the free edges add about
 * 50 (a/W)^2 = 0.5 MPa, W = 10 mm: the pack notes it); the sequence is converged to 0.1 MPa. The h = 0.01 run (179k nodes) is left out of the suite.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { gunzipSync } from 'node:zlib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setGeometryKernel } from '@core/geometry/kernel';
import type { FeMeshArtifact } from '@core/model/analysis';
import { isRecord } from '@lib/isRecord';
import { createNativeTestKernel, nativeKernelBinary } from './kernelTestSupport';
import { HAS_CCX, HAS_GMSH } from './feaTestSupport';
import { dataOf, expectCase, planPath, Workspace, type Session } from './feaThermomechSupport';

const READY = HAS_GMSH && HAS_CCX && nativeKernelBinary !== null;
let workspace: Workspace;
let occtReady = false;

beforeAll(async () => {
  workspace = new Workspace();
  try {
    setGeometryKernel(createNativeTestKernel());
    occtReady = true;
  } catch {
    occtReady = false;
  }
}, 120_000);

afterAll(() => {
  setGeometryKernel(null);
  workspace.dispose();
});

const GLOBAL_SIZE = 0.2;
const A = 1;
const PROBE_X = 1.005;
/** The plane-stress field is read this many thicknesses away from the interface (see the header). */
const CLEAN_LAYERS = 1.5;
const AXIS_TOLERANCE = 1e-9;

const readMesh = (hash: string): FeMeshArtifact =>
  JSON.parse(gunzipSync(readFileSync(path.join(workspace.dir, 'cache', `${hash}.json.gz`))).toString('utf8')) as FeMeshArtifact;

interface Node {
  readonly id: number;
  readonly point: readonly [number, number, number];
}

/** Nodes used by the elements of `entityId` only, i.e. not shared with another part. */
function ownNodes(mesh: FeMeshArtifact, entityId: string): Node[] {
  const users = new Map<number, Set<string>>();
  for (const block of mesh.blocks)
    for (const row of block.elements)
      for (const id of row.slice(1)) users.set(id, (users.get(id) ?? new Set<string>()).add(block.entityId));
  return mesh.nodes
    .filter(([id]) => users.get(id)?.size === 1 && users.get(id)?.has(entityId))
    .map(([id, x, y, z]) => ({ id, point: [x, y, z] }));
}

const nearest = (nodes: readonly Node[], target: readonly [number, number, number]): Node => {
  const distance = (node: Node): number => Math.hypot(node.point[0] - target[0], node.point[1] - target[1], node.point[2] - target[2]);
  const best = [...nodes].sort((p, q) => distance(p) - distance(q))[0];
  if (best === undefined) throw new Error('no node');
  return best;
};

async function probeValues(session: Session, analysisId: string): Promise<Record<string, number>> {
  const report = await session.cli('analysis_report', `analysisId=${analysisId}`);
  const list = dataOf(report.json)['probes'];
  const found: Record<string, number> = {};
  for (const probe of Array.isArray(list) ? list : []) {
    if (!isRecord(probe) || !Array.isArray(probe['values'])) continue;
    const last: unknown = probe['values'].at(-1);
    expect(Number(probe['nodeDistance']), String(probe['name'])).toBeLessThan(1e-9);
    if (isRecord(last)) found[String(probe['name'])] = Number(last['value']);
  }
  return found;
}

interface Measurement {
  readonly nodes: number;
  readonly outsideRadius: number;
  readonly outside: number;
  readonly inside: number;
  readonly interfaceNodes: number;
}

/** Fresh T1 document, ring refinement of size `ringSize`, mesh -> probes at own-part nodes -> solve. */
async function solveT1(name: string, thickness: number): Promise<Measurement> {
  const session = workspace.open(name);
  // the fixture is 0.05 mm thick (mid-plane 0.025); this suite runs it at `thickness`
  const plan = path.join(workspace.dir, `${name}.plan.json`);
  writeFileSync(
    plan,
    readFileSync(planPath('tmc_nafems_t1'), 'utf8')
      .replace(/\b0\.025\b/g, String(thickness / 2))
      .replace(/\b0\.05\b/g, String(thickness)),
  );
  const aliases = await session.run(plan);
  const ringSize = thickness;
  const analysisId = aliases['an']?.[0] ?? '';
  const [disc, plate] = [aliases['disc']?.[0] ?? '', aliases['plate']?.[0] ?? ''];
  const arc = Math.ceil(Math.PI / 2 / (GLOBAL_SIZE * 0.8));
  const ring = Array.from({ length: arc + 1 }, (_, i) => [
    A * Math.cos((i / arc) * (Math.PI / 2)),
    A * Math.sin((i / arc) * (Math.PI / 2)),
    thickness / 2,
  ]);
  const refined = await session.cli(
    'set_mesh_controls',
    `analysisId=${analysisId}`,
    `refinements=${JSON.stringify([{ target: { entityId: plate, pointsNear: ring }, size: ringSize }])}`,
  );
  expect(refined.code, String(refined.json['summary'])).toBe(0);
  const mesh = readMesh(await session.mesh(analysisId));
  // y = 0 symmetry plane: the hoop stress there is sigma_y
  const outside = nearest(
    ownNodes(mesh, plate).filter((node) => Math.abs(node.point[1]) < AXIS_TOLERANCE),
    [A + CLEAN_LAYERS * thickness, 0, thickness / 2],
  );
  const inside = nearest(ownNodes(mesh, disc), [0.5, 0, thickness / 2]);
  for (const [probe, node] of [
    ['outside', outside],
    ['inside', inside],
  ] as const) {
    const added = await session.cli(
      'add_result_probe',
      `analysisId=${analysisId}`,
      `name=${probe}`,
      `point=[${node.point.join(',')}]`,
      'quantity=s_yy',
    );
    expect(added.code, String(added.json['summary'])).toBe(0);
  }
  const shared = mesh.nodes.length - ownNodes(mesh, disc).length - ownNodes(mesh, plate).length;
  await session.mesh(analysisId);
  await session.solve(analysisId);
  const values = await probeValues(session, analysisId);
  return {
    nodes: mesh.nodes.length,
    outsideRadius: Math.hypot(outside.point[0], outside.point[1]),
    outside: values['outside'] ?? Number.NaN,
    inside: values['inside'] ?? Number.NaN,
    interfaceNodes: shared,
  };
}

/** The exterior field of the inclusion is sigma_theta = 50 (a/r)^2 (finite plate: + 0.5 MPa of free-edge correction): move a reading to radius `to`. */
const transported = (value: number, from: number, to: number): number => (value * from * from) / (to * to);

describe.skipIf(!READY)('VC-TMC-03 NAFEMS T1: hot disc bonded in a plate (two materials, conformal mesh)', () => {
  it.each([0.04, 0.02])(
    'judges the stress inside the disc and just outside it at thickness = ring size %f',
    async (thickness) => {
      expect(occtReady, 'the OCC kernel is needed for exact conformal STEP parts').toBe(true);
      const found = await solveT1(`t1_${thickness}`, thickness);
      expect(found.interfaceNodes).toBeGreaterThan(50);
      // the raw nodal value follows the closed form at its own radius
      const closedForm = (50 * A * A) / (found.outsideRadius * found.outsideRadius);
      expect(Math.abs(found.outside - closedForm), `${found.outside} vs ${closedForm}`).toBeLessThan(0.02 * closedForm);
      expectCase('VC-TMC-03.c', found.inside, 'MPa');
      expectCase('VC-TMC-03.b', transported(found.outside, found.outsideRadius, PROBE_X), 'MPa');
      expectCase('VC-TMC-03.a', transported(found.outside, found.outsideRadius, A), 'MPa');
    },
    900_000,
  );
});
