/** M6 shell decks and results: *SHELL SECTION (plain, composite), plane-stress sections, shell boundaries / pressures, BDF shells, fibre results. */

import { describe, expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import type { FeMeshArtifact, FeResultsArtifact } from '@core/model/analysis';
import type { CadDocument } from '@core/model/types';
import { writeBdf } from '@cae/decks/bdfWriter';
import { writeInp } from '@cae/decks/inpWriter';
import { analysisInputHash } from '@cae/hash/inputHash';
import { resultsSummary } from '@cae/results/summary';
import { mapShellResults, parseFrdNodes } from '@cae/shell/shellResults';
import { composites, must, plateDocument } from './shellFixtures';

const NODES: FeMeshArtifact['nodes'] = [
  [1, 0, 0, 1],
  [2, 50, 0, 1],
  [3, 100, 0, 1],
  [4, 0, 50, 1],
  [5, 50, 50, 1],
  [6, 100, 50, 1],
];

interface ShellCase {
  readonly doc: CadDocument;
  readonly plateId: string;
  readonly analysisId: string;
  readonly ids: Record<string, string>;
}

/** Plate as a shell with: fixed side x = 0, symmetry y = 0, displacement rx at x = 100, pressure on top (5) and from below (5). */
function shellCase(
  idealization: Record<string, unknown> = { idealization: 'shell' },
  document?: (doc: CadDocument, plateId: string) => CadDocument,
): ShellCase {
  const plate = plateDocument();
  let doc = document === undefined ? plate.doc : document(plate.doc, plate.plateId);
  const { plateId, analysisId } = plate;
  doc = must(doc, 'set_part_idealization', { analysisId, entityId: plateId, ...idealization });
  const ids: Record<string, string> = {};
  const add = (role: string, command: string, params: Record<string, unknown>): void => {
    const result = execute(doc, command, { analysisId, name: role, ...params });
    if (result.rejected === true) throw new Error(result.summary);
    doc = result.document;
    ids[role] = result.affected[0] ?? '';
  };
  add('fixed', 'add_fea_constraint', { kind: 'fixed', target: { entityId: plateId, facesNear: [[0, 25, 1]] } });
  add('sym', 'add_fea_constraint', { kind: 'symmetry', target: { entityId: plateId, facesNear: [[50, 0, 1]] } });
  add('rot', 'add_fea_constraint', {
    kind: 'displacement',
    dofs: { rx: 0.01, uz: 0 },
    target: { entityId: plateId, facesNear: [[100, 25, 1]] },
  });
  add('top', 'add_fea_load', {
    kind: 'pressure',
    magnitude: 5,
    loadCase: 'LC1',
    category: 'limit',
    target: { entityId: plateId, facesNear: [[25, 25, 2]] },
  });
  add('under', 'add_fea_load', {
    kind: 'pressure',
    magnitude: 5,
    loadCase: 'LC1',
    category: 'limit',
    target: { entityId: plateId, facesNear: [[75, 25, 0]] },
  });
  return { doc, plateId, analysisId, ids };
}

function shellMesh(
  c: ShellCase,
  type = 'S4',
  elements: readonly (readonly number[])[] = [
    [1, 1, 2, 5, 4],
    [2, 2, 3, 6, 5],
  ],
  nodes = NODES,
): FeMeshArtifact {
  return {
    kind: 'fe_mesh',
    unitSystem: 'N-mm-t-s',
    mesher: 'test',
    mesherVersion: '1',
    inputHash: analysisInputHash(c.doc, c.analysisId, 'mesh'),
    nodes,
    blocks: [{ type: type as FeMeshArtifact['blocks'][number]['type'], entityId: c.plateId, elements }],
    nodeSets: {
      [`C_${c.ids['fixed']}`]: [1, 4],
      [`C_${c.ids['sym']}`]: [1, 2, 3],
      [`C_${c.ids['rot']}`]: [3, 6],
      [`L_${c.ids['top']}`]: [1, 2, 4, 5],
      [`L_${c.ids['under']}`]: [2, 3, 5, 6],
    },
    faceSets: { [`L_${c.ids['top']}`]: [[1, 1]], [`L_${c.ids['under']}`]: [[2, 2]] },
    targets: {},
  };
}

const deckText = (doc: CadDocument, analysisId: string, mesh: FeMeshArtifact): string => {
  const result = writeInp(doc, analysisId, mesh);
  if ('code' in result) throw new Error(result.message);
  return result.text;
};

describe('INP shell deck', () => {
  it('writes S4 elements, the shell section, shell boundaries and signed P pressures', () => {
    const c = shellCase();
    const text = deckText(c.doc, c.analysisId, shellMesh(c));
    expect(text).toContain(`*ELEMENT, TYPE=S4, ELSET=P_${c.plateId.replace(/[^A-Za-z0-9_]/g, '_')}`);
    expect(text).toMatch(/\*SHELL SECTION, ELSET=P_\w+, MATERIAL=M_1, OFFSET=0\n2\n/);
    expect(text).toMatch(/C_\w+, 1, 6\n/);
    expect(text).toMatch(/C_\w+, 2, 2\nC_\w+, 4, 4\nC_\w+, 6, 6\n/);
    expect(text).toMatch(/C_\w+, 4, 4, 0\.01\n/);
    // ccx 2.21 moves a shell along its normal under a positive P: a push from the top (into the material) is written negative
    expect(text).toContain('1, P, -5\n2, P, 5\n');
  });

  it('writes OFFSET 0.5 for a top-surface shell and refuses an unresolved thickness', () => {
    const top = shellCase({ idealization: 'shell', offset: 'top' });
    expect(deckText(top.doc, top.analysisId, shellMesh(top))).toContain('OFFSET=0.5\n');
    const c = shellCase();
    const part = c.doc.analysis?.cases[c.analysisId]?.parts[c.plateId];
    if (part?.kind !== 'shell') throw new Error('fixture');
    const auto = structuredClone(c.doc) as CadDocument & { analysis: NonNullable<CadDocument['analysis']> };
    const analysis = auto.analysis.cases[c.analysisId];
    if (analysis === undefined) throw new Error('fixture');
    auto.analysis = {
      ...auto.analysis,
      cases: { [c.analysisId]: { ...analysis, parts: { [c.plateId]: { ...part, thickness: 'auto' } } } },
    };
    expect(writeInp(auto, c.analysisId, shellMesh({ ...c, doc: auto }))).toMatchObject({ code: 'FEA_PART_INVALID' });
  });

  it('writes a composite section with lamina materials and ply orientations on S8R elements', () => {
    const c = shellCase({ idealization: 'shell', compositePartId: 'cp-1', maxThickness: 3 }, (doc, id) => ({
      ...doc,
      composites: composites(id),
    }));
    expect(writeInp(c.doc, c.analysisId, shellMesh(c))).toMatchObject({ code: 'FEA_COMPOSITE_ELEMENT' });
    const nodes: FeMeshArtifact['nodes'] = [...NODES, [7, 25, 0, 1], [8, 50, 25, 1], [9, 25, 50, 1], [10, 0, 25, 1]];
    const text = deckText(c.doc, c.analysisId, shellMesh(c, 'S8', [[1, 1, 2, 5, 4, 7, 8, 9, 10]], nodes));
    expect(text).toContain('TYPE=S8R');
    expect(text).toContain('*ELASTIC, TYPE=ENGINEERING CONSTANTS\n135000, 10000, 10000, 0.3, 0.3, 0.428571428571, 5000, 5000\n3500\n');
    expect(text).toMatch(/\*ORIENTATION, NAME=OR_\w+_2\n1, 0, 0, 0, 1, 0\n3, 90\n/);
    expect(text).toMatch(/\*SHELL SECTION, ELSET=P_\w+, COMPOSITE, OFFSET=0\n0\.125, , L_\w+_1, OR_\w+_1\n0\.125, , L_\w+_1, OR_\w+_2\n/);
    expect(text).not.toContain('*MATERIAL, NAME=M_1');
  });

  it('projects a tilted rosette axis on the shell and refuses non-planar parts, a missing G23 and an implausible density', () => {
    const tilted = (doc: CadDocument, id: string): CadDocument => {
      const model = composites(id);
      return { ...doc, composites: { ...model, rosettes: { 'ro-1': { ...model.rosettes['ro-1']!, axis0: [1, 0, 1] } } } };
    };
    const c = shellCase({ idealization: 'shell', compositePartId: 'cp-1', maxThickness: 3 }, tilted);
    const nodes: FeMeshArtifact['nodes'] = [
      ...NODES,
      [7, 25, 0, 1],
      [8, 50, 25, 1],
      [9, 25, 50, 1],
      [10, 0, 25, 1],
      [11, 75, 0, 1],
      [12, 100, 25, 1],
      [13, 75, 50, 1],
    ];
    const flat = deckText(c.doc, c.analysisId, shellMesh(c, 'S8', [[1, 1, 2, 5, 4, 7, 8, 9, 10]], nodes));
    expect(flat).toMatch(/\*ORIENTATION, NAME=OR_\w+_1\n1, 0, 0, 0, 1, 0\n/);
    const bent: FeMeshArtifact['nodes'] = nodes.map(([id, x, y, z]) => [id, x, y, x > 50 ? z + (x - 50) : z]);
    const twoFaces = shellMesh(
      c,
      'S8',
      [
        [1, 1, 2, 5, 4, 7, 8, 9, 10],
        [2, 2, 3, 6, 5, 11, 12, 13, 8],
      ],
      bent,
    );
    expect(writeInp(c.doc, c.analysisId, twoFaces)).toMatchObject({ code: 'FEA_COMPOSITE_NOT_PLANAR' });
    expect(writeBdf(c.doc, c.analysisId, twoFaces)).toMatchObject({ code: 'FEA_COMPOSITE_NOT_PLANAR' });
    const lamina =
      (change: Record<string, unknown>) =>
      (doc: CadDocument, id: string): CadDocument => {
        const model = composites(id);
        return { ...doc, composites: { ...model, materials: { tape: { ...model.materials['tape']!, ...change } } } };
      };
    for (const change of [{ G23: undefined }, { density: 1600 }]) {
      const bad = shellCase({ idealization: 'shell', compositePartId: 'cp-1', maxThickness: 3 }, lamina(change));
      const mesh = shellMesh(bad, 'S8', [[1, 1, 2, 5, 4, 7, 8, 9, 10]], nodes);
      expect(writeInp(bad.doc, bad.analysisId, mesh)).toMatchObject({ code: 'FEA_COMPOSITE_INVALID' });
      expect(writeBdf(bad.doc, bad.analysisId, mesh)).toMatchObject({ code: 'FEA_COMPOSITE_INVALID' });
    }
  });

  it('writes plane-stress sections and refuses pressure on them', () => {
    const plate = plateDocument();
    let doc = must(plate.doc, 'set_part_idealization', {
      analysisId: plate.analysisId,
      entityId: plate.plateId,
      idealization: 'plane_stress',
      thickness: 2,
      sourceFacesNear: [[50, 25, 0]],
    });
    const fixed = execute(doc, 'add_fea_constraint', {
      analysisId: plate.analysisId,
      name: 'f',
      kind: 'fixed',
      target: { entityId: plate.plateId, facesNear: [[0, 25, 1]] },
    });
    doc = fixed.document;
    const mesh: FeMeshArtifact = {
      kind: 'fe_mesh',
      unitSystem: 'N-mm-t-s',
      mesher: 'test',
      mesherVersion: '1',
      inputHash: analysisInputHash(doc, plate.analysisId, 'mesh'),
      nodes: NODES.map(([id, x, y]) => [id, x, y, 0]),
      blocks: [
        {
          type: 'CPS4',
          entityId: plate.plateId,
          elements: [
            [1, 1, 2, 5, 4],
            [2, 2, 3, 6, 5],
          ],
        },
      ],
      nodeSets: { [`C_${fixed.affected[0] ?? ''}`]: [1, 4] },
      faceSets: {},
      targets: {},
    };
    const text = deckText(doc, plate.analysisId, mesh);
    expect(text).toMatch(/\*SOLID SECTION, ELSET=P_\w+, MATERIAL=M_1\n2\n/);
    expect(text).toMatch(/C_\w+, 1, 2\n/);
    const pressed = must(doc, 'add_fea_load', {
      analysisId: plate.analysisId,
      name: 'p',
      kind: 'pressure',
      magnitude: 1,
      loadCase: 'LC1',
      category: 'limit',
      target: { entityId: plate.plateId, facesNear: [[0, 25, 1]] },
    });
    expect(writeInp(pressed, plate.analysisId, { ...mesh, inputHash: analysisInputHash(pressed, plate.analysisId, 'mesh') })).toMatchObject(
      { code: 'FEA_LOAD_INVALID' },
    );
  });
});

describe('BDF shell deck', () => {
  it('writes PSHELL, shell PLOAD4 along the element normal and symmetry rotations', () => {
    const c = shellCase();
    const result = writeBdf(c.doc, c.analysisId, shellMesh(c));
    if ('code' in result) throw new Error(result.message);
    expect(result.text).toMatch(/^PSHELL {2}1 {7}1 {7}2\. {6}1 {15}1/m);
    expect(result.text).toMatch(/^PLOAD4 {2}100 {5}1 {7}-5\.\s*$/m);
    expect(result.text).toMatch(/^PLOAD4 {2}100 {5}2 {7}5\.\s*$/m);
    expect(result.text).toMatch(/^SPC1 {4}1 {7}246/m);
  });

  it('refuses offset plain shells and writes composite shells as PCOMP + MAT8 on the rosette material system', () => {
    const top = shellCase({ idealization: 'shell', offset: 'top' });
    expect(writeBdf(top.doc, top.analysisId, shellMesh(top))).toMatchObject({ code: 'FEA_BDF_UNSUPPORTED' });
    const comp = shellCase({ idealization: 'shell', compositePartId: 'cp-1', maxThickness: 3 }, (doc, id) => ({
      ...doc,
      composites: composites(id),
    }));
    const result = writeBdf(comp.doc, comp.analysisId, shellMesh(comp));
    if ('code' in result) throw new Error(result.message);
    expect(result.text).toMatch(/^CQUAD4 {2}1 {7}1 {7}1 {7}2 {7}5 {7}4 {7}101\s*$/m);
    expect(result.text).toMatch(/^CORD2R {2}101 {13}0\. {6}0\. {6}0\. {6}0\. {6}0\. {6}1\./m);
    expect(result.text).toMatch(/^MAT8 {4}2 {7}135000. 10000. {2}\.3 {6}5000\. {3}5000\. {3}3500\. {3}1\.6E-9/m);
    expect(result.text).toMatch(/^PCOMP {3}1 {7}-\.125/m);
    expect(result.text).toMatch(/^\s+2 {7}.125 {4}0. {6}YES {5}2 {7}.125 {4}90. {5}YES/m);
    expect(result.text).not.toContain('MAT1');
  });

  it('reads a stored laminate section and refuses unknown sections', () => {
    const sectioned = (doc: CadDocument, id: string): CadDocument => {
      const model = composites(id, true);
      return {
        ...doc,
        composites: {
          ...model,
          sections: {
            's-1': {
              id: 's-1',
              partId: 'cp-1',
              name: 'zone A',
              plies: [
                { material: 'tape', thickness: 0.125, angleDeg: 45 },
                { material: 'tape', thickness: 0.125, angleDeg: -45 },
                { material: 'tape', thickness: 0.125, angleDeg: 0 },
              ],
              thickness: 0.375,
              laminateSide: 'negative_normal',
            },
          },
        },
      };
    };
    const c = shellCase({ idealization: 'shell', compositePartId: 'cp-1', laminateSectionId: 's-1', maxThickness: 3 }, sectioned);
    const nodes: FeMeshArtifact['nodes'] = [...NODES, [7, 25, 0, 1], [8, 50, 25, 1], [9, 25, 50, 1], [10, 0, 25, 1]];
    const text = deckText(c.doc, c.analysisId, shellMesh(c, 'S8', [[1, 1, 2, 5, 4, 7, 8, 9, 10]], nodes));
    // negative_normal stacks against the element normal: the plies are written top-down, 0 / -45 / 45.
    expect(text).toMatch(/\n3, 0\n[\s\S]*\n3, -45\n[\s\S]*\n3, 45\n/);
    expect(
      execute(c.doc, 'set_part_idealization', {
        analysisId: c.analysisId,
        entityId: c.plateId,
        idealization: 'shell',
        compositePartId: 'cp-1',
        laminateSectionId: 'nope',
      }).error?.code,
    ).toBe('FEA_COMPOSITE_INVALID');
  });
});

const fmt = (value: number): string => {
  const [mantissa = '0', exponent = '0'] = value.toExponential(5).split('e');
  const power = Number(exponent);
  return `${mantissa}E${power < 0 ? '-' : '+'}${String(Math.abs(power)).padStart(2, '0')}`.padStart(12);
};
const valueLine = (id: number, values: readonly number[]): string => ` -1${String(id).padStart(10)}${values.map(fmt).join('')}`;

/** Expanded .frd: top fibre nodes 100 + n at z = 2, bottom 200 + n at z = 0; top x-displacement +1, bottom -1; top sxx 100, bottom -100. */
function expandedFrd(withNodes = true, ids: 'expanded' | 'original' = 'expanded'): string {
  const nodeIds = NODES.map(([id]) => id);
  const lines = withNodes
    ? [
        '    2C                            12                                     1',
        ...NODES.flatMap(([id, x, y]) => [valueLine(100 + id, [x, y, 2]), valueLine(200 + id, [x, y, 0])]),
        ' -3',
      ]
    : [];
  const block = (name: string, components: readonly string[], top: number[], bottom: number[]): string[] => [
    '    1PSTEP                         1           1           1',
    '  100CL  101 1.000000000          12                     0    1           1',
    ` -4  ${name.padEnd(8)}${String(components.length).padStart(4)}    1`,
    ...components.map((component, index) => ` -5  ${component.padEnd(8)}    1    2    ${index + 1}    0`),
    ...(ids === 'expanded'
      ? nodeIds.flatMap((id) => [valueLine(100 + id, top), valueLine(200 + id, bottom)])
      : nodeIds.map((id) => valueLine(id, top))),
    ' -3',
  ];
  return [
    ...lines,
    ...block('DISP', ['D1', 'D2', 'D3'], [1, 0, 0.1], [-1, 0, 0.1]),
    ...block('STRESS', ['SXX', 'SYY', 'SZZ', 'SXY', 'SYZ', 'SZX'], [100, 0, 0, 0, 0, 0], [-100, 0, 0, 0, 0, 0]),
  ].join('\n');
}

describe('shell results (OQ 7: fibres from the CalculiX expansion)', () => {
  it('maps expanded fibre nodes back onto the mesh nodes with top / bottom stresses', async () => {
    const c = shellCase();
    const mesh = shellMesh(c);
    const text = expandedFrd();
    expect(parseFrdNodes(text).get(101)).toEqual([0, 0, 2]);
    const { parseFrd } = await import('@cae/results/frdReader');
    const mapped = mapShellResults(c.doc, c.analysisId, mesh, parseFrd(text), text);
    if ('code' in mapped) throw new Error(mapped.message);
    const fields = mapped.steps[0]?.fields;
    expect(Object.keys(fields?.DISP?.values ?? {})).toEqual(['1', '2', '3', '4', '5', '6']);
    expect(fields?.DISP?.values['1']).toEqual([0, 0, 0.1]);
    expect(fields?.STRESS?.values['2']?.[0]).toBe(0);
    expect(fields?.STRESS_TOP?.values['2']?.[0]).toBe(100);
    expect(fields?.STRESS_BOT?.values['2']?.[0]).toBe(-100);
    const results: FeResultsArtifact = {
      kind: 'fe_results',
      meshHash: 'm',
      inputHash: 'i',
      solver: 'calculix',
      solverVersion: '2.21',
      steps: mapped.steps,
    };
    expect(resultsSummary(c.doc, c.analysisId, mesh, results, 'r').loadCases[0]?.maxVonMises.value).toBeCloseTo(100);
  });

  it('keeps 2D output on the original nodes, refuses unmapped nodes and passes solid meshes through', async () => {
    const { parseFrd } = await import('@cae/results/frdReader');
    const c = shellCase();
    const mesh = shellMesh(c);
    const flat = expandedFrd(false, 'original');
    const kept = mapShellResults(c.doc, c.analysisId, mesh, parseFrd(flat), flat);
    expect('steps' in kept ? kept.steps[0]?.fields.STRESS_TOP : 'refused').toBeUndefined();
    const lost = expandedFrd(false, 'expanded');
    expect(mapShellResults(c.doc, c.analysisId, mesh, parseFrd(lost), lost)).toMatchObject({ code: 'FEA_SHELL_RESULTS_UNMAPPED' });
    const solid: FeMeshArtifact = { ...mesh, blocks: [{ type: 'C3D4', entityId: c.plateId, elements: [] }] };
    const steps = parseFrd(lost);
    expect(mapShellResults(c.doc, c.analysisId, solid, steps, lost)).toEqual({ steps });
  });
});
