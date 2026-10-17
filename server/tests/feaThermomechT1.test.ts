/**
 * VC-TMC-03 NAFEMS T1 as a finite-element solve (TR-TMC-14, fea_import_field): a thin 20 x 20 mm plate (quarter with symmetry, 0.05 mm thick so
 * the free faces give plane stress), E = 100 GPa, nu = 0.3, thermal strain 0.001 per K, temperature step 1 K inside r < a = 1 mm and 0 outside.
 * That is the pack's "alpha_hot dT with alpha_bulk = 0": the stress depends on the thermal strain field only. The field is a table written by
 * `fea_import_field` on the mesh nodes (two passes: fea_mesh, read the nodes, import, solve), refined by ball fields along the circle.
 *
 * Measured with Gmsh 4.15.2 + CalculiX 2.21, order 2, global size 0.2 mm, ring size = thickness (columns: ring size s, nodes, sigma_y at the node
 * nearest (1.005, 0)): s 0.10: 38k, 35.5 | 0.08: 39k, -31.9 | 0.07: 40k, 43.8 | 0.06: 41k, 25.8 | 0.05: 43k, 48.9 | 0.04: 46k, 50.5 |
 * 0.03: 77k, 52.1 | 0.02 (global 0.1): 171k, 52.9 MPa against 49.5037. Inside the disc every mesh gives -49.5 .. -49.8 (-50 closed form) and
 * from r = 1.2 mm on 35 vs 34.72, 22.2..23.6 vs 22.22, 12.5..13.1 vs 12.50. Within one element of the interface the nodal hoop stress
 * oscillates (the temperature is continuous over the nodes, so the step is smeared over one element and CalculiX averages the extrapolated
 * element stresses at each node): the (1.005, 0) value is mesh noise, not a result - VC-TMC-03.b is NOT judged here, VC-TMC-03.c is.
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { gunzipSync } from 'node:zlib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setGeometryKernel } from '@core/geometry/kernel';
import type { FeMeshArtifact } from '@core/model/analysis';
import { isRecord } from '@lib/isRecord';
import { createManifoldKernel } from '@kernel-manifold/manifoldKernel';
import { HAS_CCX, HAS_GMSH } from './feaTestSupport';
import { dataOf, expectCase, planPath, Workspace, type Session } from './feaThermomechSupport';

const READY = HAS_GMSH && HAS_CCX;
let workspace: Workspace;

beforeAll(async () => {
  workspace = new Workspace();
  setGeometryKernel(await createManifoldKernel());
}, 120_000);

afterAll(() => {
  setGeometryKernel(null);
  workspace.dispose();
});

const THICKNESS = 0.05;
const GLOBAL_SIZE = 0.2;
const RING_SIZE = 0.05;
const A = 1;

/** Node temperature of the step: 1 K inside the disc, 0 outside, 0.5 on the circle itself. */
const stepTemperature = (x: number, y: number): number => {
  const r = Math.hypot(x, y);
  return r < A - 1e-9 ? 1 : r > A + 1e-9 ? 0 : 0.5;
};

const readMesh = (hash: string): FeMeshArtifact =>
  JSON.parse(gunzipSync(readFileSync(path.join(workspace.dir, 'cache', `${hash}.json.gz`))).toString('utf8')) as FeMeshArtifact;

function writeTable(name: string, mesh: FeMeshArtifact, skipLast = false): string {
  const nodes = skipLast ? mesh.nodes.slice(0, -1) : mesh.nodes;
  const file = path.join(workspace.dir, name);
  writeFileSync(file, ['x,y,z,T', ...nodes.map(([, x, y, z]) => `${x},${y},${z},${stepTemperature(x, y)}`)].join('\n'));
  return file;
}

interface Reading {
  readonly name: string;
  readonly nodeId: number;
  readonly nodeDistance: number;
  readonly value: number;
}

async function readings(session: Session, analysisId: string): Promise<Reading[]> {
  const report = await session.cli('fea_report', `analysisId=${analysisId}`);
  const list = dataOf(report.json)['probes'];
  return (Array.isArray(list) ? list : []).flatMap((probe: unknown): Reading[] => {
    if (!isRecord(probe) || !Array.isArray(probe['values'])) return [];
    const last: unknown = probe['values'].at(-1);
    return isRecord(last)
      ? [
          {
            name: String(probe['name']),
            nodeId: Number(probe['nodeId']),
            nodeDistance: Number(probe['nodeDistance']),
            value: Number(last['value']),
          },
        ]
      : [];
  });
}

describe.skipIf(!READY)('VC-TMC-03 NAFEMS T1 plate with a nodal temperature step (fea_import_field)', () => {
  it('judges the stress inside the hot disc, checks the exterior field against the closed form and refuses a table with an unmatched node', async () => {
    const session = workspace.open('t1');
    const aliases = await session.run(planPath('tmc_nafems_t1'));
    const analysisId = aliases['an']?.[0] ?? '';
    const plate = aliases['plate']?.[0] ?? '';
    for (const r of [1.5, 2]) {
      const added = await session.cli(
        'add_result_probe',
        `analysisId=${analysisId}`,
        `name=r${r}`,
        `point=[${r},0,${THICKNESS / 2}]`,
        'quantity=s_yy',
      );
      expect(added.code).toBe(0);
    }
    const arc = Math.ceil(Math.PI / 2 / (GLOBAL_SIZE * 0.8));
    const ring = Array.from({ length: arc + 1 }, (_, i) => [
      Math.cos((i / arc) * (Math.PI / 2)),
      Math.sin((i / arc) * (Math.PI / 2)),
      THICKNESS / 2,
    ]);
    const refined = await session.cli(
      'set_mesh_controls',
      `analysisId=${analysisId}`,
      `globalSize=${GLOBAL_SIZE}`,
      `refinements=${JSON.stringify([{ target: { entityId: plate, pointsNear: ring }, size: RING_SIZE }])}`,
    );
    expect(refined.code, String(refined.json['summary'])).toBe(0);
    const mesh = readMesh(await session.mesh(analysisId));
    const importArgs = (file: string): string[] => [
      `analysisId=${analysisId}`,
      `file=${file}`,
      'coordinatesUnit=mm',
      'temperatureUnit=degC',
    ];

    // a table that misses a node is refused at deck time (nearest node within 1e-6 x model size), the mesh is still current
    const partial = await session.cli('fea_import_field', ...importArgs(writeTable('partial.csv', mesh, true)));
    expect(partial.code, String(partial.json['summary'])).toBe(0);
    const unmatched = await session.cli('fea_export', `analysisId=${analysisId}`);
    expect(unmatched.code).not.toBe(0);
    expect(String(unmatched.json['summary'])).toContain('TMC_FIELD_TABLE_UNMATCHED');

    const full = await session.cli('fea_import_field', ...importArgs(writeTable('full.csv', mesh)));
    expect(full.code, String(full.json['summary'])).toBe(0);
    expect(dataOf(full.json)['rows']).toBe(mesh.nodes.length);
    await session.solve(analysisId);
    const found = new Map((await readings(session, analysisId)).map((reading) => [reading.name, reading]));

    // inside the hot disc sigma = -E alpha dT / 2 = -50 MPa (VC-TMC-03.c, 2 %), read at the node nearest (0.5, 0)
    expectCase('VC-TMC-03.c', found.get('disc')?.value ?? Number.NaN, 'MPa');
    // far from the interface the nodal field follows the closed form: sigma_yy = 50 (a/r)^2 cos(2 theta) at the actual node (finite plate: the free edges add about 50 (a/W)^2 = 0.5 MPa, so r = 3 mm is out of the 4 % band and is not checked)
    for (const name of ['r1.5', 'r2']) {
      const reading = found.get(name);
      const node = mesh.nodes.find(([id]) => id === reading?.nodeId);
      expect(reading, name).toBeDefined();
      const [x, y] = [node?.[1] ?? Number.NaN, node?.[2] ?? Number.NaN];
      const expected = (50 * A * A * Math.cos(2 * Math.atan2(y, x))) / (x * x + y * y);
      expect(Math.abs((reading?.value ?? Number.NaN) - expected), `${name}: ${reading?.value} vs ${expected}`).toBeLessThan(
        0.04 * expected,
      );
    }
    // the nodal value next to the interface is mesh noise (see the header): only its sign and order of magnitude are asserted
    const near = found.get('ring')?.value ?? Number.NaN;
    expect(near).toBeGreaterThan(20);
    expect(near).toBeLessThan(80);
    expect(existsSync(path.join(workspace.dir, 'full.csv'))).toBe(true);
  }, 300_000);
});
