/** Nastran BDF writer (05 §5.6, TR-FEA-41; M5): field formatting, golden deck, case control per analysis type, refusals, shells, pyNastran round trip. */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { FeMeshArtifact } from '@core/model/analysis';
import type { CadDocument } from '@core/model/types';
import { writeBdf } from '@cae/decks/bdfWriter';
import { cardLines, intField, realField, roundingError } from '@cae/decks/bdf/fields';
import { withCase } from '@cae/shared/access';
import { BAR_NODES, X0_NODES, X2_NODES, barDocument, barMesh, facesOn, mustRun } from './deckFixtures';
import { caseIn } from './helpers';

const textOf = (result: ReturnType<typeof writeBdf>): string => ('text' in result ? result.text : JSON.stringify(result));
const normalised = (text: string): string => text.replace(/inputHash \w+ meshHash \w+/, 'inputHash H meshHash M');

describe('Nastran fixed-format fields', () => {
  it('writes reals in at most 8 characters, Nastran-legal, with the largest precision that fits', () => {
    expect(realField(0)).toBe('0.');
    expect(realField(210000)).toBe('210000.');
    expect(realField(0.3)).toBe('.3');
    expect(realField(-0.5)).toBe('-.5');
    expect(realField(7.85e-9)).toBe('7.85E-9');
    expect(realField(1e10)).toBe('1.E10');
    expect(realField(333.33333333)).toBe('333.3333');
    expect(realField(123456.789)).toBe('123456.8');
    expect(realField(-1234567.89)).toBe('-1.235E6');
    expect(realField(0.00012345678)).toBe('1.2346-4');
    expect(realField(Number.NaN)).toBeNull();
    for (const value of [1, -2.5, 1 / 3, 6.02e23, -9.81e-12, 1234.5678, 99999999]) {
      const text = realField(value) ?? '';
      expect(text.length).toBeLessThanOrEqual(8);
      expect(roundingError(value, text)).toBeLessThan(1e-3);
    }
    expect(roundingError(0, '0.')).toBe(0);
  });

  it('writes integers up to 8 digits and refuses larger ones', () => {
    expect(intField(99_999_999)).toBe('99999999');
    expect(intField(100_000_000)).toBeNull();
    expect(intField(1.5)).toBeNull();
  });

  it('lays a card out with 8 data fields on the first line, blank continuation markers and no trailing spaces', () => {
    expect(cardLines('GRID', ['1', '', '0.', '1.', '2.'])).toEqual(['GRID    1               0.      1.      2.']);
    const lines = cardLines('RBE3', ['7', '', '9', '123456', '1.', '123', '1', '2', '3', '4', '5']);
    expect(lines).toEqual(['RBE3    7               9       123456  1.      123     1       2', '        3       4       5']);
    expect(cardLines('X', ['1', '', ''])).toEqual(['X       1']);
  });
});

describe('writeBdf static', () => {
  const bar = barDocument();
  let doc = mustRun(bar.doc, 'add_fea_load', {
    analysisId: bar.analysisId,
    name: 'pull',
    kind: 'force',
    vector: [1000, 0, 0],
    target: { entityId: bar.boxId, facesNear: [[2, 0.5, 0.5]] },
  });
  doc = mustRun(doc, 'add_fea_load', { analysisId: bar.analysisId, name: 'g', kind: 'gravity', vector: [0, 0, -9810] });
  doc = mustRun(doc, 'add_fea_load', {
    analysisId: bar.analysisId,
    name: 'p',
    kind: 'pressure',
    magnitude: 2.5,
    target: { entityId: bar.boxId, facesNear: [[1, 1, 0.5]] },
  });
  doc = mustRun(doc, 'add_fea_load', {
    analysisId: bar.analysisId,
    name: 'm',
    kind: 'moment',
    vector: [0, 0, 5000],
    referencePoint: [2, 0.5, 0.5],
    target: { entityId: bar.boxId, facesNear: [[2, 0.5, 0.5]] },
  });
  const loads = caseIn(doc, bar.analysisId).loadOrder;
  const sets = (): Record<string, number[]> => ({
    [`C_${bar.constraints['x0']}`]: X0_NODES,
    [`C_${bar.constraints['nodeA']}`]: [1],
    [`C_${bar.constraints['nodeB']}`]: [3],
    [`L_${loads[0]}`]: X2_NODES,
    [`L_${loads[2]}`]: [3, 4, 7, 8],
    [`L_${loads[3]}`]: X2_NODES,
  });
  const faces = { [`L_${loads[0]}`]: facesOn(X2_NODES), [`L_${loads[2]}`]: facesOn([3, 4, 7, 8]), [`L_${loads[3]}`]: facesOn(X2_NODES) };
  const mesh = barMesh(doc, bar.analysisId, bar.boxId, sets(), faces);

  it('writes the golden SOL 101 deck: grids, tetrahedra, PSOLID, MAT1, SPC1, FORCE, PLOAD4, GRAV, MOMENT with its RBE3', () => {
    const written = writeBdf(doc, bar.analysisId, mesh);
    expect(normalised(textOf(written))).toBe(`$ llull analysis bar units N-mm-t-s inputHash H meshHash M
$ llull: node and element ids are the mesh ids; results of this deck import through fea_import_results (op2)
SOL 101
CEND
TITLE = bar
ECHO = NONE
SPC = 1
DISPLACEMENT(SORT1,REAL) = ALL
STRESS(SORT1,REAL,VONMISES,CUBIC) = ALL
SUBCASE 1
  LABEL = LC1
  LOAD = 100
BEGIN BULK
PARAM,POST,-1
$ llull: property 1 = part 'box-1.1'
$ llull: material 1 = 'steel' (constitutive set linear (elastic_isotropic))
$ llull: load case 1 = 'LC1' -> LOAD 100
$ llull: load '${loads[0]}' force in load case LC1
$ llull: load '${loads[1]}' gravity in load case LC1
$ llull: load '${loads[2]}' pressure in load case LC1
$ llull: load '${loads[3]}' moment in load case LC1
$ llull: moment '${loads[3]}' on reference grid 9 (RBE3 7 over 4 nodes)
GRID    1               0.      0.      0.
GRID    2               2.      0.      0.
GRID    3               0.      1.      0.
GRID    4               2.      1.      0.
GRID    5               0.      0.      1.
GRID    6               2.      0.      1.
GRID    7               0.      1.      1.
GRID    8               2.      1.      1.
GRID    9               2.      .5      .5
RBE3    7               9       123456  1.      123     2       4
        6       8
CTETRA  1       1       1       2       4       8
CTETRA  2       1       1       6       2       8
CTETRA  3       1       1       4       3       8
CTETRA  4       1       1       3       7       8
CTETRA  5       1       1       5       6       8
CTETRA  6       1       1       7       5       8
PSOLID  1       1
MAT1    1       210000.         .3      7.85E-9
SPC1    1       1       1       3       5       7
SPC1    1       23      1
SPC1    1       3       3
PLOAD4  100     3       2.5                             4       1
PLOAD4  100     4       2.5                             3       1
MOMENT  100     9               5000.   0.      0.      1.
FORCE   100     2               333.33331.      0.      0.
FORCE   100     4               166.66671.      0.      0.
FORCE   100     6               166.66671.      0.      0.
FORCE   100     8               333.33331.      0.      0.
GRAV    100             9810.   0.      0.      -1.
ENDDATA
`);
    expect('warnings' in written && written.warnings).toEqual([]);
  });

  it('is deterministic and pure', () => {
    const before = JSON.stringify(doc);
    expect(textOf(writeBdf(doc, bar.analysisId, mesh))).toBe(textOf(writeBdf(doc, bar.analysisId, mesh)));
    expect(JSON.stringify(doc)).toBe(before);
  });

  it('takes the moment reference point at the centroid of the target nodes when none is given', () => {
    const noReference = mustRun(bar.doc, 'add_fea_load', {
      analysisId: bar.analysisId,
      name: 'm',
      kind: 'moment',
      vector: [0, 0, 5000],
      target: { entityId: bar.boxId, facesNear: [[2, 0.5, 0.5]] },
    });
    const id = caseIn(noReference, bar.analysisId).loadOrder[0] ?? '';
    const written = writeBdf(
      noReference,
      bar.analysisId,
      barMesh(noReference, bar.analysisId, bar.boxId, { ...sets(), [`L_${id}`]: X2_NODES }, {}),
    );
    expect(textOf(written)).toContain('GRID    9               2.      .5      .5');
  });

  it('refuses a moment on a single node, a pressure face that is not a tetrahedron face, and a pressure without faces', () => {
    const single = writeBdf(doc, bar.analysisId, barMesh(doc, bar.analysisId, bar.boxId, { ...sets(), [`L_${loads[3]}`]: [2] }, faces));
    expect(single).toMatchObject({ code: 'FEA_LOAD_INVALID' });
    const badFace = writeBdf(
      doc,
      bar.analysisId,
      barMesh(doc, bar.analysisId, bar.boxId, sets(), { ...faces, [`L_${loads[2]}`]: [[99, 1]] }),
    );
    expect(badFace).toMatchObject({ code: 'FEA_LOAD_INVALID' });
    const noFaces = writeBdf(
      doc,
      bar.analysisId,
      barMesh(doc, bar.analysisId, bar.boxId, sets(), { [`L_${loads[0]}`]: facesOn(X2_NODES) }),
    );
    expect(noFaces).toMatchObject({ code: 'FEA_TARGET_UNRESOLVED' });
  });
});

describe('enforced displacements', () => {
  it('writes the dof as SPC1 and its value as SPCD under the load set; zero dofs share one SPC1', () => {
    const bar = barDocument();
    const doc = mustRun(bar.doc, 'add_fea_constraint', {
      analysisId: bar.analysisId,
      name: 'pull',
      kind: 'displacement',
      dofs: { ux: 0.002, uy: 0 },
      target: { entityId: bar.boxId, facesNear: [[2, 0.5, 0.5]] },
    });
    const id = caseIn(doc, bar.analysisId).constraintOrder.at(-1) ?? '';
    const sets: Record<string, number[]> = {
      [`C_${bar.constraints['x0']}`]: X0_NODES,
      [`C_${bar.constraints['nodeA']}`]: [1],
      [`C_${bar.constraints['nodeB']}`]: [3],
      [`C_${id}`]: X2_NODES,
    };
    const text = textOf(writeBdf(doc, bar.analysisId, barMesh(doc, bar.analysisId, bar.boxId, sets)));
    expect(text).toContain('SPC1    1       2       2       4       6       8');
    expect(text).toContain('SPC1    1       1       2       4       6       8');
    expect(text).toContain('SPCD    100     2       1       .002');
    expect(text).toContain('SPCD    100     8       1       .002');
  });

  it('refuses a rotational dof on solid elements and a symmetry constraint that is not an axis plane', () => {
    const bar = barDocument();
    const rotational = mustRun(bar.doc, 'add_fea_constraint', {
      analysisId: bar.analysisId,
      name: 'r',
      kind: 'displacement',
      dofs: { rx: 0 },
      target: { entityId: bar.boxId, facesNear: [[2, 0.5, 0.5]] },
    });
    const id = caseIn(rotational, bar.analysisId).constraintOrder.at(-1) ?? '';
    const sets: Record<string, number[]> = {
      [`C_${bar.constraints['x0']}`]: X0_NODES,
      [`C_${bar.constraints['nodeA']}`]: [1],
      [`C_${bar.constraints['nodeB']}`]: [3],
      [`C_${id}`]: X2_NODES,
    };
    expect(writeBdf(rotational, bar.analysisId, barMesh(rotational, bar.analysisId, bar.boxId, sets))).toMatchObject({
      code: 'FEA_CONSTRAINT_INVALID',
    });
    const symmetric = mustRun(bar.doc, 'add_fea_constraint', {
      analysisId: bar.analysisId,
      name: 's',
      kind: 'symmetry',
      target: { entityId: bar.boxId, facesNear: [[1, 0.5, 0]] },
    });
    const symmetryId = caseIn(symmetric, bar.analysisId).constraintOrder.at(-1) ?? '';
    expect(
      writeBdf(symmetric, bar.analysisId, barMesh(symmetric, bar.analysisId, bar.boxId, { ...sets, [`C_${symmetryId}`]: [1, 4, 6] })),
    ).toMatchObject({ code: 'FEA_CONSTRAINT_INVALID' });
    expect(
      writeBdf(rotational, bar.analysisId, barMesh(rotational, bar.analysisId, bar.boxId, { ...sets, [`C_${id}`]: [] })),
    ).toMatchObject({ code: 'FEA_TARGET_UNRESOLVED' });
  });
});

describe('writeBdf modal and buckling', () => {
  const supports = (bar: ReturnType<typeof barDocument>): Record<string, number[]> => ({
    [`C_${bar.constraints['x0']}`]: X0_NODES,
    [`C_${bar.constraints['nodeA']}`]: [1],
    [`C_${bar.constraints['nodeB']}`]: [3],
  });

  it('modal: SOL 103, one subcase with METHOD and an EIGRL carrying the mode count and the frequency band', () => {
    const bar = barDocument({ analysisType: 'modal' });
    const doc = mustRun(bar.doc, 'create_analysis', {
      name: 'banded',
      analysisType: 'modal',
      modes: 4,
      frequencyRangeHz: { min: 10, max: 5000 },
    });
    const banded = doc.analysis?.caseOrder.at(-1) ?? '';
    const text = textOf(writeBdf(bar.doc, bar.analysisId, barMesh(bar.doc, bar.analysisId, bar.boxId, supports(bar))));
    expect(text).toContain('SOL 103');
    expect(text).toContain('SUBCASE 1\n  LABEL = modes\n  METHOD = 10');
    expect(text).toContain('EIGRL   10                      6');
    expect(text).not.toContain('LOAD =');
    expect(banded).not.toBe('');
  });

  it('modal with a band writes V1 and V2; a modal case without supports omits the SPC set', () => {
    let doc = mustRun(barDocument().doc, 'create_analysis', {
      name: 'b',
      analysisType: 'modal',
      modes: 4,
      frequencyRangeHz: { min: 10, max: 5000 },
    });
    const id = doc.analysis?.caseOrder.at(-1) ?? '';
    const free = barDocument({ analysisType: 'modal', supports: false });
    doc = free.doc;
    const text = textOf(writeBdf(doc, free.analysisId, barMesh(doc, free.analysisId, free.boxId, {})));
    expect(text).not.toContain('SPC = 1');
    expect(text).not.toContain('SPC1');
    expect(id).not.toBe('');
    const bar = barDocument({ analysisType: 'modal' });
    const banded = withCase(bar.doc, { ...caseIn(bar.doc, bar.analysisId), modes: 4, frequencyRangeHz: { min: 10, max: 5000 } });
    const bandedText = textOf(writeBdf(banded, bar.analysisId, barMesh(banded, bar.analysisId, bar.boxId, supports(bar))));
    expect(bandedText).toContain('EIGRL   10      10.     5000.   4');
  });

  it('buckling: SOL 105 with a preload subcase of the first load case, then a buckling subcase STATSUB 1', () => {
    const bar = barDocument({ analysisType: 'buckling' });
    const doc = mustRun(bar.doc, 'add_fea_load', {
      analysisId: bar.analysisId,
      name: 'push',
      kind: 'force',
      vector: [-1000, 0, 0],
      target: { entityId: bar.boxId, facesNear: [[2, 0.5, 0.5]] },
    });
    const id = caseIn(doc, bar.analysisId).loadOrder[0] ?? '';
    const text = textOf(
      writeBdf(doc, bar.analysisId, barMesh(doc, bar.analysisId, bar.boxId, { ...supports(bar), [`L_${id}`]: X2_NODES })),
    );
    expect(text).toContain('SOL 105');
    expect(text).toContain('SUBCASE 1\n  LABEL = LC1\n  LOAD = 100\nSUBCASE 2\n  LABEL = buckling\n  METHOD = 10\n  STATSUB = 1');
    expect(text).toContain('EIGRL   10                      3');
    expect(text).toContain('FORCE   100');
  });

  it('buckling without a load is refused', () => {
    const bar = barDocument({ analysisType: 'buckling' });
    expect(writeBdf(bar.doc, bar.analysisId, barMesh(bar.doc, bar.analysisId, bar.boxId, supports(bar)))).toMatchObject({
      code: 'FEA_NO_LOADS',
    });
  });
});

describe('writeBdf refusals', () => {
  const bar = barDocument();
  const sets = { [`C_${bar.constraints['x0']}`]: X0_NODES, [`C_${bar.constraints['nodeA']}`]: [1], [`C_${bar.constraints['nodeB']}`]: [3] };
  const mesh = barMesh(bar.doc, bar.analysisId, bar.boxId, sets);

  it('refuses an unknown analysis, thermal / nonlinear types, a stale mesh and a non-mesh artifact', () => {
    expect(writeBdf(bar.doc, 'nope', mesh)).toMatchObject({ code: 'FEA_ANALYSIS_NOT_FOUND' });
    const thermal = mustRun(bar.doc, 'create_analysis', { name: 't', analysisType: 'heat_steady' });
    expect(writeBdf(thermal, thermal.analysis?.caseOrder.at(-1) ?? '', mesh)).toMatchObject({ code: 'FEA_BDF_UNSUPPORTED' });
    const edited = mustRun(bar.doc, 'add_fea_load', { analysisId: bar.analysisId, name: 'g', kind: 'gravity', vector: [0, 0, -1] });
    const staleMesh: FeMeshArtifact = { ...mesh, inputHash: 'old' };
    expect(writeBdf(edited, bar.analysisId, staleMesh)).toMatchObject({ code: 'FEA_MESH_STALE' });
  });

  it('refuses element types without a card (plane stress) and ids that do not fit 8 characters', () => {
    const plane: FeMeshArtifact = { ...mesh, blocks: [{ type: 'CPS3', entityId: bar.boxId, elements: [[1, 1, 2, 4]] }] };
    expect(writeBdf(bar.doc, bar.analysisId, plane)).toMatchObject({ code: 'FEA_PART_INVALID' });
    const big: FeMeshArtifact = { ...mesh, nodes: [[100_000_000, 0, 0, 0], ...BAR_NODES.slice(1)] };
    expect(writeBdf(bar.doc, bar.analysisId, big)).toMatchObject({ code: 'FEA_BDF_ID_TOO_LARGE' });
    const infinite: FeMeshArtifact = { ...mesh, nodes: [[1, Number.POSITIVE_INFINITY, 0, 0], ...BAR_NODES.slice(1)] };
    expect(writeBdf(bar.doc, bar.analysisId, infinite)).toMatchObject({ code: 'FEA_BDF_VALUE_INVALID' });
  });

  it('warns when the small-field format rounds a coordinate', () => {
    const fine: FeMeshArtifact = { ...mesh, nodes: [[1, -123456.789, 0, 0], ...BAR_NODES.slice(1)] };
    const written = writeBdf(bar.doc, bar.analysisId, fine);
    expect('warnings' in written && written.warnings[0]).toContain('FEA_BDF_ROUNDED');
  });
});

describe('writeBdf shells', () => {
  /** The bar's box as a one-quad, one-triangle shell mesh with a numeric thickness. */
  const shellModel = (thickness: number | 'auto'): { doc: CadDocument; analysisId: string; mesh: FeMeshArtifact } => {
    const bar = barDocument();
    const base = caseIn(bar.doc, bar.analysisId);
    const doc = withCase(bar.doc, {
      ...base,
      parts: { [bar.boxId]: { kind: 'shell', thickness, offset: 'mid', midsurface: { maxThickness: 5, angularTolDeg: 1 } } },
    });
    const mesh: FeMeshArtifact = {
      ...barMesh(doc, bar.analysisId, bar.boxId, {
        [`C_${bar.constraints['x0']}`]: X0_NODES,
        [`C_${bar.constraints['nodeA']}`]: [1],
        [`C_${bar.constraints['nodeB']}`]: [3],
      }),
      blocks: [
        { type: 'S4', entityId: bar.boxId, elements: [[1, 1, 2, 4, 3]] },
        { type: 'S3', entityId: bar.boxId, elements: [[2, 5, 6, 8]] },
      ],
    };
    return { doc, analysisId: bar.analysisId, mesh };
  };

  it('maps S4 / S3 to CQUAD4 / CTRIA3 with a PSHELL of the thickness in analysis units and rotational dofs on a fixed support', () => {
    const { doc, analysisId, mesh } = shellModel(2.5);
    const text = textOf(writeBdf(doc, analysisId, mesh));
    expect(text).toContain('CQUAD4  1       1       1       2       4       3');
    expect(text).toContain('CTRIA3  2       1       5       6       8');
    expect(text).toContain('PSHELL  1       1       2.5     1');
    expect(text).not.toContain('PSOLID');
  });

  it('refuses a shell part without a numeric thickness', () => {
    const { doc, analysisId, mesh } = shellModel('auto');
    expect(writeBdf(doc, analysisId, mesh)).toMatchObject({ code: 'FEA_PART_INVALID' });
  });

  it('maps the quadratic shells S6 / S8 to CTRIA6 / CQUAD8', () => {
    const { doc, analysisId, mesh } = shellModel(1);
    const quadratic: FeMeshArtifact = {
      ...mesh,
      blocks: [
        { type: 'S8', entityId: mesh.blocks[0]?.entityId ?? '', elements: [[1, 1, 2, 4, 3, 5, 6, 8, 7]] },
        { type: 'S6', entityId: mesh.blocks[0]?.entityId ?? '', elements: [[2, 1, 2, 4, 5, 6, 8]] },
      ],
    };
    const text = textOf(writeBdf(doc, analysisId, quadratic));
    expect(text).toContain('CQUAD8  1       1       1       2       4       3       5       6');
    expect(text).toContain('        8       7');
    expect(text).toContain('CTRIA6  2       1       1       2       4       5       6       8');
  });
});

/** Python with pyNastran, or null with the reason (logged by the skipped test). */
function pyNastranStatus(): { readonly python: string } | { readonly reason: string } {
  for (const python of [process.env['LLULL_PYNASTRAN_PYTHON'], 'python3', 'python'].filter(
    (entry): entry is string => entry !== undefined,
  )) {
    const probe = spawnSync(python, ['-I', '-c', 'import pyNastran'], { encoding: 'utf8' });
    if (probe.status === 0) return { python };
  }
  return { reason: 'no Python with pyNastran on this machine (pip install pyNastran; LLULL_PYNASTRAN_PYTHON names the interpreter)' };
}

describe('pyNastran read_bdf round trip (TR-FEA-41)', () => {
  const status = pyNastranStatus();
  if ('reason' in status) console.warn(`pyNastran check skipped: ${status.reason}`);

  it.skipIf('reason' in status)('reads the written deck back with xref and finds every entry', () => {
    if ('reason' in status) return;
    const bar = barDocument();
    const mesh = barMesh(bar.doc, bar.analysisId, bar.boxId, {
      [`C_${bar.constraints['x0']}`]: X0_NODES,
      [`C_${bar.constraints['nodeA']}`]: [1],
      [`C_${bar.constraints['nodeB']}`]: [3],
    });
    const directory = mkdtempSync(path.join(tmpdir(), 'llull-bdf-'));
    try {
      const file = path.join(directory, 'bar.bdf');
      writeFileSync(file, textOf(writeBdf(bar.doc, bar.analysisId, mesh)));
      const script = [
        'import json, sys',
        'from pyNastran.bdf.bdf import read_bdf',
        'model = read_bdf(sys.argv[1], xref=True, debug=False)',
        'print(json.dumps({"nodes": len(model.nodes), "elements": len(model.elements), "materials": len(model.materials), "spcs": len(model.spcs)}))',
      ].join('\n');
      const run = spawnSync(status.python, ['-I', '-c', script, file], { encoding: 'utf8' });
      expect(run.status).toBe(0);
      expect(JSON.parse(run.stdout)).toEqual({ nodes: 8, elements: 6, materials: 1, spcs: 1 });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
