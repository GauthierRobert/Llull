/**
 * llull-mesh (Rust, Gmsh C API) answers exactly what the Python bridge op `mesh` it replaces answers: same nodes, elements, sets, residuals
 * and error messages, for solid (STL), shell midsurface and failing requests. Skipped unless both meshers can run.
 */

import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { callBridge } from '../src/pythonExchange';
import { callNativeMesher } from '../src/fea/nativeMesher';
import { BRIDGE, MESH_BIN, PYTHON } from './feaTestSupport';

const HAS_PYTHON_GMSH = spawnSync(PYTHON, ['-c', 'import gmsh, numpy'], { stdio: 'ignore' }).status === 0;
const HAS_NATIVE = MESH_BIN !== null && /\(Gmsh /.test(spawnSync(MESH_BIN, ['--version'], { encoding: 'utf8' }).stdout ?? '');

/** Binary STL of the box [0, a] x [0, b] x [0, c]. */
function boxStl(a: number, b: number, c: number): string {
  const corner = (i: number): number[] => [i & 1 ? a : 0, i & 2 ? b : 0, i & 4 ? c : 0];
  const quads = [
    [0, 2, 3, 1],
    [4, 5, 7, 6],
    [0, 1, 5, 4],
    [2, 6, 7, 3],
    [0, 4, 6, 2],
    [1, 3, 7, 5],
  ];
  const buffer = Buffer.alloc(84 + 12 * 50);
  buffer.writeUInt32LE(12, 80);
  let offset = 84;
  for (const [p, q, r, s] of quads as [number, number, number, number][]) {
    for (const triangle of [
      [p, q, r],
      [p, r, s],
    ]) {
      offset += 12;
      for (const vertex of triangle) for (const value of corner(vertex)) offset = buffer.writeFloatLE(value, offset);
      offset += 2;
    }
  }
  return buffer.toString('base64');
}

const REQUESTS: Record<string, Record<string, unknown>> = {
  solid: {
    op: 'mesh',
    lengthScale: 0.001,
    parts: [{ entityId: 'box-1', geometry: { kind: 'stl', stlBase64: boxStl(20, 10, 10) } }],
    targets: [
      { key: 'C_fix', entityId: 'box-1', facesNear: [[0, 5, 5]] },
      { key: 'L_end', entityId: 'box-1', facesNear: [[20, 5, 5]] },
      { key: 'P_tip', entityId: null, pointsNear: [[20, 10, 10]] },
    ],
    controls: { order: 2, elementFamily: 'tet', globalSize: 4, refinements: [{ key: 'C_fix', size: 2 }] },
  },
  shell: {
    op: 'mesh',
    lengthScale: 1,
    parts: [
      {
        entityId: 'wall',
        geometry: {
          kind: 'midsurface',
          element: 'plane_stress',
          thickness: 2,
          faces: [
            {
              outer: [
                [0, 0, 0],
                [30, 0, 0],
                [30, 10, 0],
                [0, 10, 0],
              ],
              holes: [
                [
                  [10, 4, 0],
                  [12, 4, 0],
                  [12, 6, 0],
                  [10, 6, 0],
                ],
              ],
              normal: [0, 0, 1],
            },
            {
              outer: [
                [30, 0, 0],
                [30, 10, 0],
                [30, 10, 15],
                [30, 0, 15],
              ],
              normal: [1, 0, 0],
            },
          ],
        },
      },
    ],
    targets: [
      { key: 'F', entityId: 'wall', facesNear: [[5, 5, 0.5]] },
      { key: 'E', entityId: 'wall', edgesNear: [[0, 5, 0]] },
      { key: 'S', entityId: 'wall', facesNear: [[30, 5, 7]] },
    ],
    controls: { order: 2, elementFamily: 'shell_quad', globalSize: 1.5, refinements: [{ key: 'E', size: 0.8 }] },
  },
  unresolved: {
    op: 'mesh',
    lengthScale: 0.001,
    parts: [{ entityId: 'box-1', geometry: { kind: 'stl', stlBase64: boxStl(20, 10, 10) } }],
    targets: [{ key: 'C_far', entityId: 'box-1', facesNear: [[0, 5, 500]] }],
    controls: { order: 1, elementFamily: 'tet', globalSize: 4, refinements: [] },
  },
};

describe.skipIf(!HAS_PYTHON_GMSH || !HAS_NATIVE)('llull-mesh parity with the Python mesher', () => {
  it.each(Object.keys(REQUESTS))('%s request', async (name) => {
    const request = REQUESTS[name] ?? {};
    const python = await callBridge(PYTHON, BRIDGE, request, 300_000);
    const native = await callNativeMesher(MESH_BIN ?? '', request, 300_000, process.env);
    const reference = Object.fromEntries(Object.entries(python).filter(([key]) => key !== 'log'));
    expect(native).toEqual(python.ok ? { faceMap: [], defeatured: [], ...reference } : reference);
    if (name === 'unresolved') expect(native.code).toBe('FEA_TARGET_UNRESOLVED');
    else expect(native.ok).toBe(true);
  });
});
