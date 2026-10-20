/** OP2 reader and import (05 §5.7, M5): container, tables, mapping to the results artifact, trust path, VTU export. Fixtures are hand-built (op2Fixture.ts). */
import { describe, expect, it } from 'vitest';
import { defaultContext } from '@core/commands/context';
import { execute } from '@core/commands/registry';
import type { FeMeshArtifact, FeResultsArtifact } from '@core/model/analysis';
import { canonicalJson } from '@lib/canonicalJson';
import { sha256Hex } from '@lib/sha256';
import { readOp2, type Op2Tables } from '@cae/results/op2Reader';
import { op2ToResults } from '@cae/results/op2Results';
import { meshSummary, resultsSummary } from '@cae/results/summary';
import { writeVtu } from '@cae/results/vtuWriter';
import { X0_NODES, barDocument, barMesh, mustRun, portOf } from './deckFixtures';
import { Op2Builder, displacementRow, tetStressElement, word } from './op2Fixture';

const { i, f } = word;

const tables = (bytes: Uint8Array): Op2Tables => {
  const read = readOp2(bytes);
  if ('code' in read) throw new Error(read.message);
  return read;
};

const bar = barDocument();
const mesh = barMesh(bar.doc, bar.analysisId, bar.boxId, {
  [`C_${bar.constraints['x0']}`]: X0_NODES,
  [`C_${bar.constraints['nodeA']}`]: [1],
  [`C_${bar.constraints['nodeB']}`]: [3],
});
const NODE_IDS = mesh.nodes.map((node) => node[0]);
const ELEMENTS = mesh.blocks[0]?.elements ?? [];

/** u = 0.5 x along x for every node (so the bar has a uniform strain). */
const displacements = (scale = 1): ReturnType<typeof displacementRow>[] =>
  mesh.nodes.map(([id, x, y]) => displacementRow(id, [0.5 * x * scale, 0, y * 0, 0, 0, 0]));

/** A static OP2: one subcase with the displacement table and a uniform sxx = 105 on every element (centroid and corners). */
function staticFile(options: { centroidOnly?: boolean; stress?: boolean; little?: boolean; numWide?: number } = {}): Uint8Array {
  const builder = new Op2Builder(options.little ?? true);
  builder.table('OUGV1', [{ approach: 11, tableCode: 1, subcase: 1, numWide: options.numWide ?? 8, data: displacements().flat() }]);
  if (options.stress !== false)
    builder.table('OES1X1', [
      {
        approach: 11,
        tableCode: 5,
        elementType: 39,
        subcase: 1,
        numWide: 109,
        data: ELEMENTS.flatMap((element) =>
          tetStressElement(element[0] ?? 0, element.slice(1), [105, 0, 0, 0, 0, 0], options.centroidOnly),
        ),
        chunks: 2,
      },
    ]);
  return builder.build();
}

describe('readOp2 container and tables', () => {
  it('reads displacements and CTETRA stresses of a static file (single precision, little endian)', () => {
    const read = tables(staticFile());
    expect(read.producer).toBe('NX 12.0');
    expect(read.warnings).toEqual([]);
    expect(read.displacements).toHaveLength(1);
    expect(read.displacements[0]?.nodes.size).toBe(8);
    expect(read.displacements[0]?.nodes.get(2)).toEqual([1, 0, 0, 0, 0, 0]);
    expect(read.stresses[0]?.elements.size).toBe(6);
    const rows = read.stresses[0]?.elements.get(3) ?? [];
    expect(rows.map((row) => row.grid)).toEqual([0, 1, 4, 3, 8]);
    expect(rows[1]?.stress).toEqual([105, 0, 0, 0, 0, 0]);
  });

  it('reads a big-endian file the same way', () => {
    expect(tables(staticFile({ little: false })).displacements[0]?.nodes.get(2)).toEqual([1, 0, 0, 0, 0, 0]);
  });

  it('reads the eigenvalue table (LAMA) and the eigenvector sets with their mode numbers', () => {
    const builder = new Op2Builder();
    builder.eigenTable('LAMA', [
      [i(1), i(1), f(4), f(2), f(0.5), f(1), f(4)],
      [i(2), i(2), f(16), f(4), f(1), f(1), f(16)],
    ]);
    builder.table('OUGV1', [
      { approach: 21, tableCode: 7, subcase: 1, mode: 1, eigenvalue: 4, numWide: 8, data: displacements(1).flat() },
      { approach: 21, tableCode: 7, subcase: 1, mode: 2, eigenvalue: 16, numWide: 8, data: displacements(2).flat() },
    ]);
    const read = tables(builder.build());
    expect(read.eigenvalues).toEqual([
      { mode: 1, order: 1, eigenvalue: 4, radians: 2, cycles: 0.5, generalizedMass: 1, generalizedStiffness: 4 },
      { mode: 2, order: 2, eigenvalue: 16, radians: 4, cycles: 1, generalizedMass: 1, generalizedStiffness: 16 },
    ]);
    expect(read.displacements.map((set) => [set.analysisCode, set.mode, set.eigenvalue])).toEqual([
      [2, 1, 4],
      [2, 2, 16],
    ]);
  });

  it('warns about double precision and other element types instead of guessing; unknown tables are skipped', () => {
    const doublePrecision = tables(staticFile({ numWide: 14 }));
    expect(doublePrecision.displacements).toEqual([]);
    expect(doublePrecision.warnings[0]).toContain('14 words per row');
    const builder = new Op2Builder();
    builder.table('GEOM1', []);
    builder.table('OES1X1', [{ approach: 11, tableCode: 5, elementType: 33, subcase: 1, numWide: 17, data: [] }]);
    const other = tables(builder.build());
    expect(other.stresses).toEqual([]);
    expect(other.warnings[0]).toContain('element type 33');
  });

  it('refuses what is not an OP2: too short, wrong first record, truncated, inconsistent record lengths', () => {
    expect(readOp2(new Uint8Array(4))).toMatchObject({ code: 'FEA_OP2_INVALID' });
    expect(readOp2(new TextEncoder().encode('this is not an op2 file at all'))).toMatchObject({ code: 'FEA_OP2_INVALID' });
    const good = staticFile();
    expect(readOp2(good.slice(0, good.length - 6))).toMatchObject({
      code: 'FEA_OP2_INVALID',
      message: expect.stringContaining('truncated'),
    });
    const broken = good.slice();
    new DataView(broken.buffer).setInt32(8, 99, true);
    expect(readOp2(broken)).toMatchObject({ code: 'FEA_OP2_INVALID' });
  });

  it('keeps what it read of a table whose marker structure breaks, and says so', () => {
    const builder = new Op2Builder();
    builder.table('OUGV1', [], (inner) => {
      inner.marker(5);
      inner.marker(7);
    });
    const read = tables(builder.build());
    expect(read.warnings[0]).toContain('does not have them');
    const odd = new Op2Builder(true, null);
    odd.table('OUGV1', [], (inner) => inner.logical([i(1), i(2)]));
    expect(tables(odd.build()).producer).toBe('');
  });
});

describe('op2ToResults', () => {
  const imported = (read: Op2Tables, doc = bar.doc, m: FeMeshArtifact = mesh): ReturnType<typeof op2ToResults> =>
    op2ToResults(doc, bar.analysisId, m, 'meshhash', read);

  it('static: DISP and nodal STRESS per subcase, von Mises through the same summariser as a ccx run', () => {
    const result = imported(tables(staticFile()));
    if (!('artifact' in result)) throw new Error(result.message);
    expect(result.artifact).toMatchObject({ kind: 'fe_results', solver: 'nastran', solverVersion: 'NX 12.0', meshHash: 'meshhash' });
    expect(result.artifact.steps).toHaveLength(1);
    expect(result.artifact.steps[0]?.fields['DISP']?.values['2']).toEqual([1, 0, 0]);
    expect(result.artifact.steps[0]?.fields['STRESS']?.values['5']).toEqual([105, 0, 0, 0, 0, 0]);
    const summary = resultsSummary(bar.doc, bar.analysisId, mesh, result.artifact, 'hash');
    expect(summary.loadCases[0]?.maxVonMises.value).toBeCloseTo(105, 4);
    expect(summary.loadCases[0]?.maxDisplacement.value).toBeCloseTo(1, 6);
  });

  it('a centroid-only stress table gives the element value to its corner nodes; a file without stresses keeps DISP and warns', () => {
    const centroid = imported(tables(staticFile({ centroidOnly: true })));
    expect('artifact' in centroid && centroid.artifact.steps[0]?.fields['STRESS']?.values['8']).toEqual([105, 0, 0, 0, 0, 0]);
    const none = imported(tables(staticFile({ stress: false })));
    expect('warnings' in none && none.warnings.join(' ')).toContain('no CTETRA stress table');
    expect('artifact' in none && none.artifact.steps[0]?.fields['STRESS']).toBeUndefined();
  });

  it('modal: one step per mode with the frequency as time and the eigenvalue table in dat', () => {
    const modal = barDocument({ analysisType: 'modal' });
    const modalMesh = barMesh(modal.doc, modal.analysisId, modal.boxId, {});
    const builder = new Op2Builder();
    builder.eigenTable('LAMA', [[i(1), i(1), f(4), f(2), f(0.5), f(1), f(4)]]);
    builder.table('OUGV1', [{ approach: 21, tableCode: 7, subcase: 1, mode: 1, eigenvalue: 4, numWide: 8, data: displacements().flat() }]);
    const result = op2ToResults(modal.doc, modal.analysisId, modalMesh, 'm', tables(builder.build()));
    if (!('artifact' in result)) throw new Error(result.message);
    expect(result.artifact.steps).toEqual([expect.objectContaining({ step: 1, time: 0.5 })]);
    const summary = resultsSummary(modal.doc, modal.analysisId, modalMesh, result.artifact, 'h');
    expect(summary.frequenciesHz).toEqual([0.5]);
    const noLama = new Op2Builder();
    noLama.table('OUGV1', [{ approach: 21, tableCode: 7, subcase: 1, mode: 1, eigenvalue: 4, numWide: 8, data: displacements().flat() }]);
    const derived = op2ToResults(modal.doc, modal.analysisId, modalMesh, 'm', tables(noLama.build()));
    expect('artifact' in derived && derived.artifact.steps[0]?.time).toBeCloseTo(2 / (2 * Math.PI), 6);
  });

  it('buckling: the post-buckling sets give the factor table; a preload set (analysis code 1) is not a mode', () => {
    const buckling = barDocument({ analysisType: 'buckling' });
    const bucklingMesh = barMesh(buckling.doc, buckling.analysisId, buckling.boxId, {});
    const builder = new Op2Builder();
    builder.table('OUGV1', [
      { approach: 11, tableCode: 1, subcase: 1, numWide: 8, data: displacements().flat() },
      { approach: 81, tableCode: 7, subcase: 2, mode: 1, eigenvalue: 3.5, numWide: 8, data: displacements().flat() },
    ]);
    const result = op2ToResults(buckling.doc, buckling.analysisId, bucklingMesh, 'm', tables(builder.build()));
    if (!('artifact' in result)) throw new Error(result.message);
    expect(result.artifact.steps).toHaveLength(1);
    const summary = resultsSummary(buckling.doc, buckling.analysisId, bucklingMesh, result.artifact, 'h');
    expect(summary.bucklingFactors).toEqual([3.5]);
  });

  it('refuses an OP2 of another mesh, without the displacement kind needed, of a thermal case or with non-finite values', () => {
    const other: FeMeshArtifact = { ...mesh, nodes: [...mesh.nodes, [50, 9, 9, 9]] };
    expect(imported(tables(staticFile()), bar.doc, other)).toMatchObject({ code: 'FEA_OP2_MESH_MISMATCH' });
    const small: FeMeshArtifact = { ...mesh, nodes: mesh.nodes.filter((node) => node[0] !== 3) };
    expect(imported(tables(staticFile()), bar.doc, small)).toMatchObject({
      code: 'FEA_OP2_MESH_MISMATCH',
      message: expect.stringContaining('grid 3'),
    });
    const modalOnly = new Op2Builder();
    modalOnly.table('OUGV1', [
      { approach: 21, tableCode: 7, subcase: 1, mode: 1, eigenvalue: 4, numWide: 8, data: displacements().flat() },
    ]);
    expect(imported(tables(modalOnly.build()))).toMatchObject({ code: 'FEA_OP2_NO_RESULTS' });
    const thermal = mustRun(bar.doc, 'create_analysis', { name: 't', analysisType: 'heat_steady' });
    expect(op2ToResults(thermal, thermal.analysis?.caseOrder.at(-1) ?? '', mesh, 'm', tables(staticFile()))).toMatchObject({
      code: 'FEA_ANALYSIS_TYPE_UNSUPPORTED',
    });
    expect(op2ToResults(bar.doc, 'nope', mesh, 'm', tables(staticFile()))).toMatchObject({ code: 'FEA_ANALYSIS_NOT_FOUND' });
    const nan = new Op2Builder();
    nan.table('OUGV1', [
      {
        approach: 11,
        tableCode: 1,
        subcase: 1,
        numWide: 8,
        data: mesh.nodes.flatMap(([id]) => displacementRow(id, [Number.NaN, 0, 0, 0, 0, 0])),
      },
    ]);
    expect(imported(tables(nan.build()))).toMatchObject({ code: 'FEA_SOLVER_FAILED' });
  });

  it('drops the reference grids of moment loads (ids above the mesh) and records through the trust path of record_fea_results', () => {
    const builder = new Op2Builder();
    builder.table('OUGV1', [
      { approach: 11, tableCode: 1, subcase: 1, numWide: 8, data: [...displacements().flat(), ...displacementRow(9, [1, 1, 1, 0, 0, 0])] },
    ]);
    const result = imported(tables(builder.build()));
    expect('artifact' in result && Object.keys(result.artifact.steps[0]?.fields['DISP']?.values ?? {})).not.toContain('9');
    const solved = barDocument();
    const fullMesh = barMesh(solved.doc, solved.analysisId, solved.boxId, {
      [`C_${solved.constraints['x0']}`]: X0_NODES,
      [`C_${solved.constraints['nodeA']}`]: [1],
      [`C_${solved.constraints['nodeB']}`]: [3],
    });
    const meshHash = sha256Hex(canonicalJson(fullMesh));
    const meshed = execute(
      solved.doc,
      'record_fe_mesh',
      { analysisId: solved.analysisId, summary: meshSummary(fullMesh, meshHash) },
      { ...defaultContext(), feaArtifacts: portOf(fullMesh) },
    );
    expect(meshed.rejected).not.toBe(true);
    const artifact = op2ToResults(meshed.document, solved.analysisId, fullMesh, meshHash, tables(staticFile()));
    if (!('artifact' in artifact)) throw new Error(artifact.message);
    const resultsHash = sha256Hex(canonicalJson(artifact.artifact));
    const recorded = execute(
      meshed.document,
      'record_fea_results',
      {
        analysisId: solved.analysisId,
        summary: resultsSummary(meshed.document, solved.analysisId, fullMesh, artifact.artifact, resultsHash),
      },
      { ...defaultContext(), feaArtifacts: portOf(fullMesh, artifact.artifact) },
    );
    expect(recorded.rejected).not.toBe(true);
    expect(recorded.summary).toContain('record_fea_results');
  });
});

describe('writeVtu', () => {
  const results: FeResultsArtifact = {
    kind: 'fe_results',
    meshHash: 'm',
    inputHash: 'i',
    solver: 'nastran',
    solverVersion: 'x',
    steps: [
      {
        step: 1,
        time: 1,
        fields: {
          DISP: { components: ['D1', 'D2', 'D3'], values: { '1': [0, 0, 0], '2': [1, 0, 0] } },
          STRESS: { components: ['SXX', 'SYY', 'SZZ', 'SXY', 'SYZ', 'SZX'], values: { '2': [100, 0, 0, 0, 0, 0] } },
        },
      },
    ],
  };

  it('writes ASCII points, cells, part / element ids and per-set point arrays', () => {
    const { text, cells, dropped } = writeVtu(mesh, results);
    expect(cells).toBe(6);
    expect(dropped).toBe(0);
    expect(text).toContain('<VTKFile type="UnstructuredGrid"');
    expect(text).toContain('<Piece NumberOfPoints="8" NumberOfCells="6">');
    expect(text).toContain('Name="connectivity" NumberOfComponents="1" format="ascii">0 1 3 7');
    expect(text).toContain('Name="types" NumberOfComponents="1" format="ascii">10 10 10 10 10 10');
    expect(text).toContain('Name="U_1" NumberOfComponents="3" format="ascii">0 0 0 1 0 0');
    expect(text).toContain('Name="von_mises_1"');
    expect(text).toContain('Name="S_1" NumberOfComponents="6"');
    expect(text).toContain('Name="element_id"');
  });

  it('writes the mesh alone, base64 arrays with a separately encoded length header, quadratic cell types, and drops elements with unknown nodes', () => {
    const plain = writeVtu(mesh, null, 'base64');
    expect(plain.text).not.toContain('<PointData>');
    expect(plain.text).toContain('format="binary"');
    // Points: 24 doubles = 192 bytes -> header base64 of 192 little endian = "wAAAAA=="
    expect(plain.text).toContain('format="binary">wAAAAA==');
    const quadratic: FeMeshArtifact = {
      ...mesh,
      blocks: [
        { type: 'C3D10', entityId: bar.boxId, elements: [[1, 1, 2, 3, 4, 5, 6, 7, 8, 1, 2]] },
        {
          type: 'S4',
          entityId: 'shell',
          elements: [
            [2, 1, 2, 4, 3],
            [3, 1, 2, 4, 99],
          ],
        },
        { type: 'S8', entityId: 'shell', elements: [[4, 1, 2, 4, 3, 5, 6, 8, 7]] },
      ],
    };
    const written = writeVtu(quadratic, null);
    expect(written.dropped).toBe(1);
    expect(written.cells).toBe(3);
    expect(written.text).toContain('Name="types" NumberOfComponents="1" format="ascii">24 9 23');
    expect(NODE_IDS).toHaveLength(8);
  });
});
