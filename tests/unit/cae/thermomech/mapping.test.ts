/** PHY-04 TR-TMC-23: mesh-to-mesh temperature mapping by shape-function interpolation. */
import { describe, expect, it } from 'vitest';
import { defaultContext } from '@core/commands/context';
import { execute } from '@core/commands/registry';
import type { FeMeshArtifact } from '@core/model/analysis';
import { mapNodalField } from '@cae/thermomech/mapping';
import { checkThermomechItems } from '@cae/thermomech/check';
import { resolveTemperatureField } from '@cae/thermomech/field';
import { analysisInputHash } from '@cae/hash/inputHash';
import { meshSummary } from '@cae/results/summary';
import { hashOf, portOf, thermoFixture, withThermalSource } from './fixtures';

const mesh = (nodes: FeMeshArtifact['nodes'], elements: readonly (readonly number[])[]): FeMeshArtifact => ({
  kind: 'fe_mesh',
  unitSystem: 'N-mm-t-s',
  mesher: 'test',
  mesherVersion: '0',
  inputHash: 'h',
  nodes,
  blocks: [{ type: elements[0]?.length === 11 ? 'C3D10' : 'C3D4', entityId: 'box', elements }],
  nodeSets: {},
  faceSets: {},
  targets: {},
});

/** The cube [0, 10]^3 as six tetrahedra around the diagonal 1-5 (Kuhn); nodes 1-5 are the corners of the thermo_static fixture mesh. */
const CUBE_NODES: FeMeshArtifact['nodes'] = [
  [1, 0, 0, 0],
  [2, 10, 0, 0],
  [3, 0, 10, 0],
  [4, 0, 0, 10],
  [5, 10, 10, 10],
  [6, 10, 10, 0],
  [7, 10, 0, 10],
  [8, 0, 10, 10],
];
const KUHN = [
  [1, 1, 2, 6, 5],
  [2, 1, 2, 7, 5],
  [3, 1, 3, 6, 5],
  [4, 1, 3, 8, 5],
  [5, 1, 4, 7, 5],
  [6, 1, 4, 8, 5],
] as const;
const cube = (): FeMeshArtifact => mesh(CUBE_NODES, KUHN);
const linear = ([, x, y, z]: readonly number[]): number => 20 + 2 * (x ?? 0) + 3 * (y ?? 0) - (z ?? 0);

/** One tetrahedron of order 2 with straight mid-edge nodes (CalculiX order). */
function tet10(): FeMeshArtifact {
  const corners = [
    [0, 0, 0],
    [4, 0, 0],
    [0, 4, 0],
    [0, 0, 4],
  ] as const;
  const mid = (a: number, b: number): number[] => [0, 1, 2].map((k) => ((corners[a]?.[k] ?? 0) + (corners[b]?.[k] ?? 0)) / 2);
  const points = [...corners.map((c) => [...c]), mid(0, 1), mid(1, 2), mid(2, 0), mid(0, 3), mid(1, 3), mid(2, 3)];
  return mesh(
    points.map((p, i) => [i + 1, p[0] ?? 0, p[1] ?? 0, p[2] ?? 0] as const),
    [[1, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10]],
  );
}

const valuesOf = (source: FeMeshArtifact, f: (node: readonly number[]) => number): Map<number, number> =>
  new Map(source.nodes.map((node) => [node[0], f(node)]));

describe('mapNodalField', () => {
  it('reproduces a linear field exactly at interior and coincident nodes of a C3D4 mesh', () => {
    const source = cube();
    const target = mesh(
      [
        [1, 0, 0, 0],
        [2, 5, 5, 5],
        [3, 1, 2, 3],
        [4, 9.5, 0.5, 7],
        [5, 10, 10, 10],
      ],
      [[1, 1, 2, 3, 4]],
    );
    const mapped = mapNodalField(source, valuesOf(source, linear), target);
    expect(mapped.ok).toBe(true);
    if (!mapped.ok) return;
    mapped.values.forEach((value, i) => {
      const [, x, y, z] = target.nodes[i] ?? [0, 0, 0, 0];
      expect(value).toBeCloseTo(20 + 2 * (x ?? 0) + 3 * (y ?? 0) - (z ?? 0), 10);
    });
    expect(mapped.report).toMatchObject({ outside: 0, maxMappingDistance: 0, coincidentNodes: 2 });
    expect(mapped.report.coincidentMaxError).toBe(0);
  });

  it('reproduces a quadratic field exactly with C3D10 shape functions', () => {
    const source = tet10();
    const quadratic = ([, x, y, z]: readonly number[]): number => 1 + (x ?? 0) ** 2 + 0.5 * (x ?? 0) * (y ?? 0) - (z ?? 0) ** 2 + (y ?? 0);
    const target = mesh(
      [
        [1, 1, 1, 1],
        [2, 0.5, 2, 0.25],
        [3, 0, 0, 0],
      ],
      [[1, 1, 2, 3]],
    );
    const mapped = mapNodalField(source, valuesOf(source, quadratic), target);
    expect(mapped.ok).toBe(true);
    if (!mapped.ok) return;
    target.nodes.forEach((node, i) => expect(mapped.values[i]).toBeCloseTo(quadratic(node), 10));
  });

  it('projects a node outside every element on the nearest one, counts it and reports the distance', () => {
    const source = cube();
    const target = mesh(
      [
        [1, 5, 5, 5],
        [2, 11, 5, 5],
        [3, 5, 5, -2],
      ],
      [[1, 1, 2, 3, 3]],
    );
    const mapped = mapNodalField(source, valuesOf(source, linear), target);
    expect(mapped.ok).toBe(true);
    if (!mapped.ok) return;
    expect(mapped.report.outside).toBe(2);
    expect(mapped.report.maxMappingDistance).toBeCloseTo(2, 10);
    // the value at the nearest point of the cube: (10, 5, 5) and (5, 5, 0)
    expect(mapped.values[1]).toBeCloseTo(linear([0, 10, 5, 5]), 9);
    expect(mapped.values[2]).toBeCloseTo(linear([0, 5, 5, 0]), 9);
  });

  it('is deterministic and refuses unusable sources', () => {
    const source = cube();
    const target = mesh([[1, 5, 5, 5]], [[1, 1, 1, 1, 1]]);
    const first = mapNodalField(source, valuesOf(source, linear), target);
    expect(mapNodalField(source, valuesOf(source, linear), target)).toEqual(first);
    const partial = valuesOf(source, linear);
    partial.delete(1);
    expect(mapNodalField(source, partial, target)).toMatchObject({ ok: false });
    const wrong = mesh(CUBE_NODES, [[1, 1, 2, 3]]);
    expect(mapNodalField(wrong, valuesOf(wrong, linear), target)).toMatchObject({ ok: false, message: expect.stringContaining('C3D4') });
    const broken = mesh(CUBE_NODES, [[1, 1, 2, 3, 99]]);
    expect(mapNodalField(broken, valuesOf(broken, linear), target)).toMatchObject({ ok: false });
    const flat = mesh(
      [
        [1, 0, 0, 0],
        [2, 1, 0, 0],
        [3, 0, 1, 0],
        [4, 1, 1, 0],
      ],
      [[1, 1, 2, 3, 4]],
    );
    expect(mapNodalField(flat, valuesOf(flat, linear), target)).toMatchObject({
      ok: false,
      message: expect.stringContaining('degenerate'),
    });
  });
});

describe('thermal_result field with mapping interpolate', () => {
  it('maps between two different discretisations of the same geometry; same_mesh refuses them', () => {
    const base = thermoFixture();
    const source = withThermalSource(base, { mesh: cube() });
    const { doc, analysisId, mesh: target } = source.fixture;
    expect(resolveTemperatureField(doc, analysisId, target, source.artifacts)).toMatchObject({ code: 'TMC_MESH_MISMATCH' });
    const interpolated = execute(doc, 'set_temperature_field', {
      analysisId,
      source: { kind: 'thermal_result', analysisId: source.thermalId, time: 'last', mapping: 'interpolate' },
    });
    expect(interpolated.document.analysis?.cases[analysisId]?.thermomech?.field).toMatchObject({ mapping: 'interpolate' });
    const field = resolveTemperatureField(interpolated.document, analysisId, target, source.artifacts);
    expect(field).toMatchObject({ ok: true, values: [101, 102, 103, 104, 105], mapping: { outside: 0, coincidentNodes: 5 } });
    expect(field.ok && field.description).toContain('mapped by interpolation');
    const items = checkThermomechItems(interpolated.document, analysisId, source.artifacts).filter((item) => item.severity === 'error');
    expect(items).toEqual([]);
  });

  it('warns about projected nodes in check_thermo_mechanical and refuses without the thermal mesh in the store', () => {
    const base = thermoFixture();
    const smaller = mesh(
      [
        [1, 0, 0, 0],
        [2, 5, 0, 0],
        [3, 0, 5, 0],
        [4, 0, 0, 5],
      ],
      [[1, 1, 2, 3, 4]],
    );
    const source = withThermalSource(base, { mesh: smaller });
    const { doc, analysisId } = source.fixture;
    const interpolated = execute(doc, 'set_temperature_field', {
      analysisId,
      source: { kind: 'thermal_result', analysisId: source.thermalId, time: 'last', mapping: 'interpolate' },
    }).document;
    const target = { ...source.fixture.mesh, inputHash: analysisInputHash(interpolated, analysisId, 'mesh') };
    const field = resolveTemperatureField(interpolated, analysisId, target, source.artifacts);
    expect(field).toMatchObject({ ok: true, mapping: { outside: 4 } });
    const withoutMesh = { get: (hash: string) => (hash === source.resultsHash ? source.results : null) };
    expect(resolveTemperatureField(interpolated, analysisId, target, withoutMesh)).toMatchObject({ ok: false });

    // recorded mesh of the mechanical case: the check warns about the projected nodes (and has no error)
    const targetHash = hashOf(target);
    const port = portOf({ [targetHash]: target, [source.resultsHash]: source.results, [hashOf(source.thermalMesh)]: source.thermalMesh });
    const recorded = execute(
      interpolated,
      'record_fe_mesh',
      { analysisId, summary: meshSummary(target, targetHash) },
      { ...defaultContext(), feaArtifacts: port },
    );
    const items = checkThermomechItems(recorded.document, analysisId, port);
    expect(items.filter((item) => item.severity === 'error')).toEqual([]);
    expect(items.map((item) => item.code)).toContain('TMC_MAPPING_PROJECTED');
  });
});
