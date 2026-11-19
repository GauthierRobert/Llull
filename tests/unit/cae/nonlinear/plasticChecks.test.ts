/** NLS-M2c: plastic-zone guardrails of check_nonlinear, the plastic volume fraction of nonlinear_report, and step-<n> load cases in a V&V quantity. */
import { describe, expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import type { FeMeshArtifact, FeResultsArtifact } from '@core/model/analysis';
import type { MaterialModel } from '@core/model/materialModel';
import { elongationAtBreak, hardeningCurveEnd, plasticItems } from '@cae/nonlinear/plasticChecks';
import { elementsAbove, plasticZones } from '@cae/nonlinear/plasticZone';
import { resultsSummary } from '@cae/results/summary';
import { caseOf } from '@cae/shared/access';
import { isQuantityProblem, quantityValue } from '@cae/vnv/studyQuantity';
import { run, SOURCE, T293 } from '../../physics/materials/materialFixtures';
import { hashOf } from '../deckFixtures';
import { solvedPressure, solvedPull, type PlasticOptions, type SolvedCurve } from './limitFixtures';

interface Item {
  code: string;
  severity: string;
  ids: string[];
  message: string;
}
interface CheckData {
  status: string;
  items: Item[];
  notes: string[];
}
interface PlasticVolume {
  fraction: number | null;
  plasticVolume: number;
  totalVolume: number;
  volumeUnit: string;
  threshold: number;
  parts: { entityId: string; fraction: number | null; plasticElements: number; elements: number; elementsAcross: number | null }[];
}

const BAR_NODES = ['1', '2', '3', '4', '5', '6', '7', '8'];
const everyNode = (value: number): Record<string, number> => Object.fromEntries(BAR_NODES.map((node) => [node, value]));

const check = (solved: SolvedCurve): CheckData =>
  execute(solved.doc, 'check_nonlinear', { analysisId: solved.analysisId }, solved.ctx).data as CheckData;
const ofCode = (data: CheckData, code: string): Item[] => data.items.filter((entry) => entry.code === code);

const elongation =
  (value: number, unit = '1'): NonNullable<PlasticOptions['prepare']> =>
  (doc) =>
    run(doc, 'set_material_property', { material: 'steel', property: 'elongation', value, unit, basis: 'A', source: SOURCE }).document;

/** Structured nx x ny x nz grid of unit cubes, each split into the 6 Kuhn tetrahedra along its main diagonal (volume 1/6 each). */
function gridMesh(nx: number, ny: number, nz: number, entityId = 'plate'): FeMeshArtifact {
  const id = (i: number, j: number, k: number): number => 1 + i + (nx + 1) * (j + (ny + 1) * k);
  const nodes: [number, number, number, number][] = [];
  for (let k = 0; k <= nz; k += 1) for (let j = 0; j <= ny; j += 1) for (let i = 0; i <= nx; i += 1) nodes.push([id(i, j, k), i, j, k]);
  const axes = [
    [1, 0, 0],
    [0, 1, 0],
    [0, 0, 1],
  ] as const;
  const elements: number[][] = [];
  for (let k = 0; k < nz; k += 1)
    for (let j = 0; j < ny; j += 1)
      for (let i = 0; i < nx; i += 1)
        for (const [a, first] of axes.entries())
          for (const [b, second] of axes.entries()) {
            if (a === b) continue;
            const corner = (offset: readonly number[]): number => id(i + (offset[0] ?? 0), j + (offset[1] ?? 0), k + (offset[2] ?? 0));
            const both = first.map((value, axis) => value + (second[axis] ?? 0));
            elements.push([elements.length + 1, corner([0, 0, 0]), corner(first), corner(both), corner([1, 1, 1])]);
          }
  return {
    kind: 'fe_mesh',
    unitSystem: 'N-mm-t-s',
    mesher: 'test',
    mesherVersion: '1',
    inputHash: '',
    nodes,
    blocks: [{ type: 'C3D4', entityId, elements }],
    nodeSets: {},
    faceSets: {},
    targets: {},
  };
}

function peeqResults(values: Record<string, number>): FeResultsArtifact {
  return {
    kind: 'fe_results',
    meshHash: '',
    inputHash: '',
    solver: 'CalculiX',
    solverVersion: '2.21',
    steps: [
      {
        step: 1,
        time: 0.5,
        fields: { PE: { components: ['PEEQ'], values: Object.fromEntries(Object.keys(values).map((node) => [node, [0]])) } },
      },
      {
        step: 1,
        time: 1,
        fields: {
          PE: { components: ['PEEQ'], values: Object.fromEntries(Object.entries(values).map(([node, value]) => [node, [value]])) },
        },
      },
    ],
  };
}

const plasticModel = (isotropic: Record<string, unknown>, validity?: readonly Record<string, unknown>[]): MaterialModel =>
  ({
    id: 'law',
    model: { kind: 'j2_plasticity', isotropic, kinematic: { kind: 'none' } },
    ...(validity === undefined ? {} : { validity }),
    basis: 'A',
    provenance: { citation: 'test' },
    parametersSha256: '',
  }) as unknown as MaterialModel;

describe('plasticZones (pure)', () => {
  const mesh = gridMesh(10, 10, 4);

  it('measures a one-element layer as about one element across and a four-layer slab as 2 V / S over h', () => {
    const bottom = Object.fromEntries(mesh.nodes.filter((node) => node[3] === 0).map((node) => [String(node[0]), 0.01]));
    const [layer] = plasticZones(mesh, peeqResults(bottom));
    expect(layer?.plasticElements).toBe(600);
    expect(layer?.plasticVolume).toBeCloseTo(100, 9);
    expect(layer?.volume).toBeCloseTo(400, 9);
    expect(layer?.elementsAcross).toBeCloseTo((2 * 100) / (200 + 40), 9);
    expect(layer?.maxPeeq).toEqual({ value: 0.01, node: 1 });
    const all = Object.fromEntries(mesh.nodes.map((node) => [String(node[0]), 0.02]));
    const [slab] = plasticZones(mesh, peeqResults(all));
    expect(slab?.plasticElements).toBe(2400);
    expect(slab?.elementsAcross).toBeCloseTo((2 * 400) / (200 + 160), 9);
  });

  it('ignores non-finite PE values and a malformed element with fewer than four corners', () => {
    const block = mesh.blocks[0];
    if (block === undefined) throw new Error('no block');
    const broken: FeMeshArtifact = { ...mesh, blocks: [{ ...block, elements: [...block.elements, [9999, 1, 2, 3]] }] };
    const [zone] = plasticZones(broken, peeqResults({ '1': Number.NaN, '2': 0.01, '3': 0.01 }));
    expect(zone?.maxPeeq).toEqual({ value: 0.01, node: 2 });
    expect(zone?.elements).toBe(2401);
    expect(zone?.elementsAcross).not.toBeNull();
  });

  it('gives no plastic element, a null width and a null maximum without PE values, and lists the elements above a limit', () => {
    const [none] = plasticZones(mesh, peeqResults({}));
    expect(none).toMatchObject({ plasticElements: 0, plasticVolume: 0, elementsAcross: null, maxPeeq: null });
    const results = peeqResults({ '1': 0.05 });
    expect(elementsAbove(mesh, results, 'plate', 0.01)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(elementsAbove(mesh, results, 'plate', 0.05)).toEqual([]);
    expect(elementsAbove(mesh, results, 'other', 0)).toEqual([]);
  });
});

describe('hardeningCurveEnd / elongationAtBreak (pure)', () => {
  const peeqValidity = (upper: number): Record<string, unknown>[] => [
    ...T293,
    { variable: 'equivalentPlasticStrain', unit: '1', data: [0, upper] },
  ];

  it('takes the last point of a multilinear curve (smallest over temperature curves), capped by the validity', () => {
    const multilinear = {
      kind: 'multilinear',
      stressUnit: 'MPa',
      curves: [
        {
          temperature: { value: 293, unit: 'K' },
          points: [
            [250, 0],
            [300, 0.1],
          ],
        },
        {
          temperature: { value: 400, unit: 'K' },
          points: [
            [200, 0],
            [260, 0.08],
          ],
        },
      ],
    };
    expect(hardeningCurveEnd(plasticModel(multilinear))?.strain).toBe(0.08);
    expect(hardeningCurveEnd(plasticModel(multilinear, peeqValidity(0.05)))).toMatchObject({ strain: 0.05 });
    expect(hardeningCurveEnd(plasticModel(multilinear, peeqValidity(0.5)))?.source).toContain('last tabulated point');
    expect(hardeningCurveEnd(plasticModel({ kind: 'multilinear', stressUnit: 'MPa', curves: [] }))).toBeNull();
  });

  it('uses the validity of an analytic law and knows no end without one', () => {
    const perfect = { kind: 'perfect', yieldStress: { value: 250, unit: 'MPa' } };
    expect(hardeningCurveEnd(plasticModel(perfect, peeqValidity(0.002)))).toMatchObject({ strain: 0.002 });
    expect(hardeningCurveEnd(plasticModel(perfect, T293))).toBeNull();
    expect(hardeningCurveEnd(plasticModel(perfect))).toBeNull();
    const ramberg = { ...plasticModel(perfect, peeqValidity(0.03)), model: { kind: 'ramberg_osgood' } } as unknown as MaterialModel;
    expect(hardeningCurveEnd(ramberg)).toMatchObject({ strain: 0.03 });
  });

  it('reads the smallest elongation of the record in any unit and notes models it cannot evaluate at room temperature', () => {
    let doc = solvedPressure().doc;
    doc = elongation(0.12)(doc, '', '');
    doc = elongation(10, '%')(doc, '', '');
    doc = elongation(0.5)(doc, '', '');
    doc = run(doc, 'set_material_property', {
      material: 'steel',
      property: 'Ftu',
      value: 400,
      unit: 'MPa',
      basis: 'A',
      source: SOURCE,
    }).document;
    doc = run(doc, 'set_material_property', {
      material: 'steel',
      property: 'elongation',
      unit: '1',
      basis: 'B',
      source: SOURCE,
      temperature: {
        mode: 'absolute',
        temperatureUnit: 'K',
        points: [
          [400, 0.2],
          [500, 0.15],
        ],
      },
    }).document;
    const material = doc.materials['steel'];
    if (material === undefined) throw new Error('no steel');
    const found = elongationAtBreak('steel', material);
    expect(found.value?.value).toBeCloseTo(0.1, 12);
    expect(found.notes).toHaveLength(1);
    expect(found.notes[0]).toContain('not read at 293.15 K');
    expect(elongationAtBreak('steel', { ...material, propertyModels: [] })).toEqual({ value: null, notes: [] });
  });
});

describe('plasticItems (pure, on a finer mesh)', () => {
  const setUp = (): { solved: SolvedCurve; boxId: string } => {
    const solved = solvedPressure(undefined, { peeq: everyNode(0.01), prepare: elongation(0.005) });
    const boxId = Object.keys(caseOf(solved.doc, solved.analysisId)?.parts ?? {})[0] ?? '';
    return { solved, boxId };
  };

  it('lists at most ten element ids, passes a zone 2.2 elements across and notes parts without tetrahedra', () => {
    const { solved, boxId } = setUp();
    const analysis = caseOf(solved.doc, solved.analysisId);
    if (analysis === undefined) throw new Error('no case');
    const grid = gridMesh(10, 10, 4, boxId);
    const all = Object.fromEntries(grid.nodes.map((node) => [String(node[0]), 0.02]));
    const ghost = { ...analysis, parts: { ...analysis.parts, ghost: analysis.parts[boxId] } } as typeof analysis;
    const { items, notes } = plasticItems(solved.doc, ghost, grid, peeqResults(all));
    expect(items.map((entry) => entry.code)).toEqual(['NLS_STRAIN_BEYOND_CURVE', 'NLS_STRAIN_EXCEEDS_ELONGATION']);
    expect(items[0]?.message).toContain('2400 element(s) (1, 2, 3, 4, 5, 6, 7, 8, 9, 10, +2390 more)');
    expect(notes).toEqual(['plastic-zone checks skipped for part(s) without tetrahedra: ghost']);
  });

  it('notes a part without a material or without a plastic law instead of judging its curve', () => {
    const { solved, boxId } = setUp();
    const analysis = caseOf(solved.doc, solved.analysisId);
    const entity = solved.doc.entities[boxId];
    if (analysis === undefined || entity === undefined) throw new Error('no case');
    const { materialId: _dropped, ...bare } = entity;
    const noMaterial = { ...solved.doc, entities: { ...solved.doc.entities, [boxId]: bare } } as typeof solved.doc;
    const results = peeqResults(everyNode(0.01));
    const without = plasticItems(noMaterial, analysis, solved.mesh, results);
    expect(without.items.map((entry) => entry.code)).toEqual(['NLS_MESH_PLASTIC_ADEQUACY']);
    expect(without.notes[0]).toContain('no hardening curve end known');
    const material = solved.doc.materials['steel'];
    if (material === undefined) throw new Error('no steel');
    const noSet = {
      ...solved.doc,
      materials: { ...solved.doc.materials, steel: { ...material, constitutiveSets: [] } },
    } as typeof solved.doc;
    const unset = plasticItems(noSet, analysis, solved.mesh, results);
    expect(unset.items.map((entry) => entry.code)).toEqual(['NLS_STRAIN_EXCEEDS_ELONGATION', 'NLS_MESH_PLASTIC_ADEQUACY']);
  });
});

describe('check_nonlinear plastic-zone guardrails', () => {
  it('warns NLS_STRAIN_BEYOND_CURVE when PEEQ passes the end of the hardening data, not below it', () => {
    const beyond = check(solvedPressure(undefined, { peeq: everyNode(0.01) }));
    const [found] = ofCode(beyond, 'NLS_STRAIN_BEYOND_CURVE');
    expect(found?.severity).toBe('warning');
    expect(found?.message).toContain('validity equivalentPlasticStrain <= 0.001');
    expect(found?.message).toContain('6 element(s)');
    const within = check(solvedPressure(undefined, { peeq: everyNode(0.0005) }));
    expect(ofCode(within, 'NLS_STRAIN_BEYOND_CURVE')).toEqual([]);
  });

  it('judges a multilinear curve by its last point', () => {
    const multilinear: NonNullable<PlasticOptions['prepare']> = (doc, analysisId, boxId) => {
      let next = run(doc, 'add_material_model', {
        material: 'steel',
        id: 'j2ml',
        model: {
          kind: 'j2_plasticity',
          isotropic: {
            kind: 'multilinear',
            stressUnit: 'MPa',
            inputMeasure: { stress: 'true', strain: 'plastic', strainKind: 'true' },
            curves: [
              {
                points: [
                  [250, 0],
                  [300, 0.02],
                  [320, 0.05],
                ],
              },
            ],
          },
          kinematic: { kind: 'none' },
        },
        basis: 'A',
        source: SOURCE,
        validity: T293,
      }).document;
      next = run(next, 'define_constitutive_set', { material: 'steel', set: { id: 'ml', elastic: 'elasticv', plastic: 'j2ml' } }).document;
      return run(next, 'set_part_constitutive_set', { analysisId, entityId: boxId, constitutiveSetId: 'ml' }).document;
    };
    const below = check(solvedPressure(undefined, { peeq: everyNode(0.04), prepare: multilinear }));
    expect(ofCode(below, 'NLS_STRAIN_BEYOND_CURVE')).toEqual([]);
    const above = check(solvedPressure(undefined, { peeq: everyNode(0.06), prepare: multilinear }));
    expect(ofCode(above, 'NLS_STRAIN_BEYOND_CURVE')[0]?.message).toContain('last tabulated point at equivalent plastic strain 0.05');
  });

  it('fails NLS_STRAIN_EXCEEDS_ELONGATION above ln(1 + elongation), and says nothing without an elongation value', () => {
    const solved = solvedPressure(undefined, { peeq: everyNode(0.01), prepare: elongation(0.01) });
    const data = check(solved);
    const [found] = ofCode(data, 'NLS_STRAIN_EXCEEDS_ELONGATION');
    expect(found?.severity).toBe('error');
    expect(found?.ids).toEqual(Object.keys(caseOf(solved.doc, solved.analysisId)?.parts ?? {}));
    expect(data.status).toBe('fail');
    expect(
      ofCode(check(solvedPressure(undefined, { peeq: everyNode(0.0099), prepare: elongation(0.01) })), 'NLS_STRAIN_EXCEEDS_ELONGATION'),
    ).toEqual([]);
    expect(ofCode(check(solvedPressure(undefined, { peeq: everyNode(0.01) })), 'NLS_STRAIN_EXCEEDS_ELONGATION')).toEqual([]);
  });

  it('warns NLS_MESH_PLASTIC_ADEQUACY on a plastic zone one element across and stays silent without plastic strain', () => {
    const coarse = check(solvedPressure(undefined, { peeq: everyNode(0.0005) }));
    const [found] = ofCode(coarse, 'NLS_MESH_PLASTIC_ADEQUACY');
    expect(found?.severity).toBe('warning');
    expect(found?.message).toContain('6 of 6 elements');
    const elastic = check(solvedPressure(undefined, { peeq: everyNode(0) }));
    expect(elastic.items.filter((entry) => /^NLS_(STRAIN_|MESH_PLASTIC)/.test(entry.code))).toEqual([]);
  });

  it('returns findings unique by code + ids (regression)', () => {
    const many = solvedPressure(undefined, { peeq: everyNode(0.02), prepare: elongation(0.005) });
    const turning = solvedPull([1, 2, 3, 2.5, 2], [0.002, 0.004, 0.003, 0.0025, 0.002]);
    for (const solved of [many, turning, solvedPressure()]) {
      const keys = check(solved).items.map((entry) => `${entry.code}|${entry.ids.join(',')}`);
      expect(keys.length).toBeGreaterThan(0);
      expect(new Set(keys).size).toBe(keys.length);
    }
    expect(check(many).items.map((entry) => entry.code)).toEqual(
      expect.arrayContaining(['NLS_STRAIN_BEYOND_CURVE', 'NLS_STRAIN_EXCEEDS_ELONGATION', 'NLS_MESH_PLASTIC_ADEQUACY']),
    );
  });
});

describe('nonlinear_report plasticVolume', () => {
  const volume = (solved: SolvedCurve): PlasticVolume | null =>
    (execute(solved.doc, 'nonlinear_report', { analysisId: solved.analysisId }, solved.ctx).data as { plasticVolume: PlasticVolume | null })
      .plasticVolume;

  it('is 1 for a bar plastic everywhere and 0 for one without plastic strain, in the analysis volume unit', () => {
    const full = volume(solvedPressure(undefined, { peeq: everyNode(0.01) }));
    expect(full).toMatchObject({ fraction: 1, volumeUnit: 'mm^3', threshold: 0 });
    expect(full?.totalVolume).toBeCloseTo(2, 9);
    expect(full?.parts[0]).toMatchObject({ fraction: 1, plasticElements: 6, elements: 6 });
    const none = volume(solvedPressure(undefined, { peeq: everyNode(0) }));
    expect(none).toMatchObject({ fraction: 0, plasticVolume: 0 });
    expect(none?.parts[0]?.elementsAcross).toBeNull();
  });

  it('counts only the elements that touch a plastic node', () => {
    const partial = volume(solvedPressure());
    expect(partial?.fraction).toBeGreaterThan(0);
    expect(partial?.fraction).toBeLessThan(1);
    expect(partial?.plasticVolume).toBeCloseTo((partial?.fraction ?? 0) * 2, 9);
  });
});

describe('V&V study quantity on a nonlinear case (load cases named step <n>)', () => {
  const read = (solved: SolvedCurve, loadCase: string, field: 'von_mises' | 'u_mag'): ReturnType<typeof quantityValue> => {
    const analysis = caseOf(solved.doc, solved.analysisId);
    if (analysis === undefined) throw new Error('no case');
    const summary = resultsSummary(solved.doc, solved.analysisId, solved.mesh, solved.results, hashOf(solved.results));
    return quantityValue(solved.doc, analysis, solved.mesh, solved.results, summary, { kind: 'field_max', field, loadCase });
  };

  it('reads field_max of step 1 and step 2 (by position), and refuses the step name', () => {
    const solved = solvedPressure();
    expect(read(solved, 'step 1', 'von_mises')).toEqual({ value: 200, unit: 'MPa' });
    expect(read(solved, 'step 2', 'u_mag')).toEqual({ value: 0.0005, unit: 'mm' });
    const byName = read(solved, 'up', 'von_mises');
    expect(isQuantityProblem(byName)).toBe(true);
    expect(byName).toMatchObject({ code: 'VNV_QUANTITY_UNAVAILABLE' });
    expect((byName as { message: string }).message).toContain('step 1, step 2');
  });
});
