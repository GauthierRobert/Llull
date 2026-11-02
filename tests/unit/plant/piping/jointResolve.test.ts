/** Plant 01 PSC M4: `resolve_joint` (bolt sets, stud length): flanged and welded joints, the named stud rule against its derivation, bolting-table override, refusals. */

import { describe, expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import { createEmptyDocument, type CadDocument } from '@core/model/types';
import { quarterInchText, raisedFaceHeightMm, studLengthRule, threadPitchMm } from '@aec/plant/catalog/bolting';
import { apply, data, expectRefusal } from '../../../helpers/commandAssertions';
import { expectPure } from '../../../helpers/expectNoOp';
import { packJson } from './packData';
import { fixtureSpec, importedDoc, type Json } from './specFixture';

interface Joint {
  kind: string;
  flanged: boolean;
  class?: number;
  facing?: string;
  size: string;
  flangeA: { componentId: string; thicknessMm: number; boltHoleMm: number };
  flangeB: { componentId: string };
  gasket: { componentId: string };
  boltSet: { componentId: string };
  bolts: {
    count: number;
    diameterMm: number;
    diameterIn: string;
    studs: number;
    nuts: number;
    studLengthMm?: number;
    studLengthIn?: string;
    studMethod?: string;
    studVerified?: boolean;
    studAssumptions?: string[];
    studLength?: null;
    studLengthUnknown?: string;
  };
  verified: boolean;
  unverifiedParts: string[];
  warnings?: Array<{ code: string; reason?: string }>;
}
const oracle = packJson<{ stud: { cases: Array<Record<string, number | string>> } }>('psc_m4_oracles.json').stud.cases[0] as Record<
  string,
  number | string
>;
const specDoc = importedDoc();
const flanged = { specId: 'CS150-A1', nps: 4, endA: 'FL', endB: 'FL' };
const joint = (params: Record<string, unknown>, from: CadDocument = specDoc): Joint =>
  data<Joint>(from, 'resolve_joint', { ...flanged, ...params });
const near = (actual: unknown, expected: number, tolerance: number): void =>
  expect(Math.abs((actual as number) - expected), `${String(actual)} vs ${expected}`).toBeLessThanOrEqual(tolerance);

/** A document whose spec also searches an imported bolting table (family asme-b16.5-bolting) with the given sizes. */
function withBolting(sizes: Array<Record<string, unknown>>): CadDocument {
  const imported = apply(specDoc, 'import_piping_catalog', {
    catalog: {
      format: 'llull-piping-catalog',
      schemaVersion: 1,
      id: 'bolting',
      licence: 'open-data',
      families: [{ id: 'asme-b16.5-bolting', type: 'boltSet', standard: 'ASME B16.5 bolting', sizes }],
    },
  });
  return apply(imported, 'edit_pipe_spec', {
    specId: 'CS150-A1',
    ops: [{ op: 'setHeader', fields: { catalogs: ['llull-open-piping', 'bolting'] } }],
  });
}
const boltRow = (extra: Record<string, unknown>): Record<string, unknown> => ({
  nps: 4,
  class: 150,
  facing: 'RF',
  boltCount: 8,
  boltDiameter: 15.875,
  provenance: { citation: 'test bolting table' },
  ...extra,
});

describe('resolve_joint, the flanged NPS 4 Class 150 joint', () => {
  it('returns two weld-neck flanges, the spiral-wound gasket and the bolt set with 8 x 5/8 in studs', () => {
    const result = joint({});
    expect(result.kind).toBe('flanged');
    expect(result.class).toBe(150);
    expect(result.facing).toBe('RF');
    expect([result.flangeA.componentId, result.flangeB.componentId, result.gasket.componentId, result.boltSet.componentId]).toEqual([
      'F-WN',
      'F-WN',
      'G-SW',
      'B-STUD',
    ]);
    expect(result.bolts).toMatchObject({ count: 8, studs: 8, nuts: 16, diameterIn: '5/8' });
    near(result.bolts.diameterMm, 15.875, 1e-9);
    near(result.flangeA.thicknessMm, 22.4, 1e-9);
    near(result.flangeA.boltHoleMm, 19.05, 1e-6);
  });

  it('computes the stud length by the named rule and matches the committed derivation (95.25 mm = 3-3/4 in), marked derived and unverified', () => {
    const result = joint({});
    expect(result.bolts.studMethod).toBe('rule');
    near(result.bolts.studLengthMm, oracle['studLengthMm'] as number, 1e-6);
    expect(result.bolts.studLengthIn).toBe(oracle['studLengthIn']);
    expect(result.bolts.studVerified).toBe(false);
    expect(result.verified).toBe(false);
    expect(result.unverifiedParts).toContain('stud');
    expect(result.bolts.studAssumptions?.some((line) => line.includes('ASSUMED'))).toBe(true);
    expect(result.warnings?.map((warning) => warning.code)).toContain('PSC_DATA_UNVERIFIED');
  });

  it('reproduces the derivation term by term in the rule function (grip, nuts, projections, exact length)', () => {
    const rule = studLengthRule({
      flangeThicknessAMm: oracle['flangeThicknessMm'] as number,
      flangeThicknessBMm: oracle['flangeThicknessMm'] as number,
      raisedFaceAMm: oracle['raisedFaceMm'] as number,
      raisedFaceBMm: oracle['raisedFaceMm'] as number,
      gasketMm: oracle['gasketMm'] as number,
      boltDiameterMm: oracle['boltDiameterMm'] as number,
    });
    near(rule?.gripMm, oracle['gripMm'] as number, 1e-9);
    near(rule?.nutHeightMm, 15.875, 1e-9);
    near(rule?.projectionMm, (oracle['projectionsMm'] as number) / 2, 1e-5);
    near(rule?.exactMm, oracle['exactMm'] as number, 1e-5);
  });

  it('changes with the overrides: a thicker gasket or taller nut lengthens the stud, a thin one rounds to the same quarter inch', () => {
    near(joint({ gasketThicknessMm: 4.5 }).bolts.studLengthMm, 95.25, 1e-6);
    near(joint({ gasketThicknessMm: 8 }).bolts.studLengthMm, 101.6, 1e-6);
    near(joint({ nutHeightMm: 10 }).bolts.studLengthMm, 82.55, 1e-6);
    expect(joint({ gasketThicknessMm: 8 }).bolts.studAssumptions?.[0]).toContain('given by the caller');
  });

  it('uses the stud length of an imported bolting table (overrides the rule) and then the bolt set is a catalogue row', () => {
    const doc = withBolting([boltRow({ studLength: 88.9, verified: true })]);
    const result = joint({}, doc);
    expect(result.bolts.studMethod).toBe('catalogue');
    near(result.bolts.studLengthMm, 88.9, 1e-9);
    expect(result.bolts.studLengthIn).toBe('3-1/2');
    expect(result.bolts.studVerified).toBe(true);
  });

  it('refuses a bolt set whose count or diameter disagrees with the flanges (they would not bolt up)', () => {
    expectRefusal(withBolting([boltRow({ boltCount: 12 })]), 'resolve_joint', flanged, 'PSC_END_INCOMPATIBLE', 'boltCount');
    expectRefusal(withBolting([boltRow({ boltDiameter: 19.05 })]), 'resolve_joint', flanged, 'PSC_END_INCOMPATIBLE', 'boltDiameter');
  });

  it('gives no stud length, with the reason, where the rule cannot apply (untabulated bolt, flange without thickness)', () => {
    const flangeRow = (extra: Record<string, unknown>): Record<string, unknown> => ({
      nps: 4,
      class: 150,
      facing: 'RF',
      outsideDiameter: 228.6,
      boltCircle: 190.5,
      boltCount: 8,
      boltDiameter: 15.875,
      provenance: { citation: 'test flange table' },
      ...extra,
    });
    const withFlange = (row: Record<string, unknown>): CadDocument =>
      apply(
        apply(specDoc, 'import_piping_catalog', {
          catalog: {
            format: 'llull-piping-catalog',
            schemaVersion: 1,
            id: 'odd',
            licence: 'open-data',
            families: [{ id: 'asme-b16.5-odd', type: 'flangeWeldNeck', standard: 'ASME B16.5', sizes: [row] }],
          },
        }),
        'edit_pipe_spec',
        { specId: 'CS150-A1', ops: [{ op: 'setHeader', fields: { catalogs: ['odd', 'llull-open-piping'] } }] },
      );
    const pitch = joint({}, withFlange(flangeRow({ thickness: 22.4, boltDiameter: 14 })));
    expect(pitch.bolts.studLength).toBeNull();
    expect(pitch.bolts.studLengthUnknown).toContain('thread pitch');
    expect(pitch.warnings?.some((warning) => warning.code === 'PSC_CATALOG_ROW_MISSING')).toBe(true);
    expect(pitch.verified).toBe(false);
    const thick = joint({}, withFlange(flangeRow({})));
    expect(thick.bolts.studLengthUnknown).toContain('flange thickness missing');
  });

  it('reports which parts are unverified: the NPS 4 Class 150 flanges are grade A, the gasket outer ring and the unresolved bolt set are not', () => {
    const four = joint({});
    expect(four.unverifiedParts).toEqual(['gasket', 'bolts', 'stud']);
    expect(four.verified).toBe(false);
  });

  it('is read-only and pure', () => {
    expectPure(specDoc, () => execute(specDoc, 'resolve_joint', flanged));
    expect(execute(specDoc, 'resolve_joint', flanged).document).toBe(specDoc);
  });
});

describe('resolve_joint, welded and threaded joints and refusals', () => {
  it('returns no parts for a butt-weld, socket-weld and threaded joint', () => {
    for (const [endA, endB, kind] of [
      ['BW', 'BW', 'butt weld'],
      ['BE', 'BW', 'butt weld'],
      ['SW', 'PE', 'socket weld'],
      ['PE', 'SW', 'socket weld'],
      ['THD', 'THD', 'threaded'],
    ] as const) {
      const result = joint({ endA, endB });
      expect(result.kind).toBe(kind);
      expect(result.flanged).toBe(false);
      expect(result.flangeA).toBeUndefined();
    }
  });

  it('refuses ends that do not mate, wafer ends and sizes outside the spec', () => {
    expectRefusal(specDoc, 'resolve_joint', { ...flanged, endB: 'BW' }, 'PSC_END_INCOMPATIBLE', 'endA');
    expectRefusal(specDoc, 'resolve_joint', { ...flanged, endA: 'BW', endB: 'SW' }, 'PSC_END_INCOMPATIBLE', 'endB');
    expectRefusal(specDoc, 'resolve_joint', { ...flanged, endA: 'WAF', endB: 'FL' }, 'PSC_END_INCOMPATIBLE');
    expectRefusal(specDoc, 'resolve_joint', { ...flanged, endA: 'SW', endB: 'SW' }, 'PSC_END_INCOMPATIBLE');
    expectRefusal(specDoc, 'resolve_joint', { ...flanged, nps: 30 }, 'PSC_SIZE_OUT_OF_RANGE', 'nps');
    expectRefusal(specDoc, 'resolve_joint', { ...flanged, endA: 'BW', endB: 'BW', nps: 30 }, 'PSC_SIZE_OUT_OF_RANGE', 'nps');
    expectRefusal(specDoc, 'resolve_joint', { ...flanged, nps: 4.3 }, 'PSC_SIZE_UNKNOWN', 'nps');
    expectRefusal(specDoc, 'resolve_joint', { ...flanged, specId: 'NOPE' }, 'PSC_SPEC_UNKNOWN', 'specId');
    expectRefusal(specDoc, 'resolve_joint', { ...flanged, nps: 14 }, 'PSC_CATALOG_ROW_MISSING');
  });

  it('refuses a flanged joint without gasket or bolt set, and several gasket types without a choice', () => {
    const noGasket = apply(specDoc, 'edit_pipe_spec', { specId: 'CS150-A1', ops: [{ op: 'removeComponent', id: 'G-SW' }] });
    expectRefusal(noGasket, 'resolve_joint', flanged, 'PSC_JOINT_INCOMPLETE', 'type');
    const noBolts = apply(specDoc, 'edit_pipe_spec', { specId: 'CS150-A1', ops: [{ op: 'removeComponent', id: 'B-STUD' }] });
    expectRefusal(noBolts, 'resolve_joint', flanged, 'PSC_JOINT_INCOMPLETE', 'type');
    const two = apply(specDoc, 'edit_pipe_spec', {
      specId: 'CS150-A1',
      ops: [
        {
          op: 'addComponent',
          component: { id: 'G-SHEET', type: 'gasketSheet', fromNps: 0.5, toNps: 24, class: 150, catalogRef: 'asme-b16.21' },
        },
      ],
    });
    expectRefusal(two, 'resolve_joint', flanged, 'PSC_AMBIGUOUS_COMPONENT', 'gasketType');
    const chosen = data<Joint>(two, 'resolve_joint', { ...flanged, gasketType: 'gasketSpiralWound' });
    expect(chosen.gasket.componentId).toBe('G-SW');
  });

  it('refuses flanges of a different class or facing on the two sides (the pair does not mate)', () => {
    const spec: Json = fixtureSpec();
    (spec['components'] as Json[]).push({
      id: 'F-BL',
      type: 'flangeBlind',
      fromNps: 2,
      toNps: 24,
      facing: 'FF',
      class: 150,
      catalogRef: 'asme-b16.5',
    });
    const doc = apply(createEmptyDocument(), 'import_pipe_spec', { spec });
    expectRefusal(doc, 'resolve_joint', { ...flanged, flangeTypeB: 'flangeBlind' }, 'PSC_END_INCOMPATIBLE', 'facing');
  });
});

describe('bolting rules', () => {
  it('has the standard thread pitches (UNC to 1 in, 8-UN above, ISO coarse for metric)', () => {
    near(threadPitchMm(15.875), 25.4 / 11, 1e-9);
    near(threadPitchMm(12.7), 25.4 / 13, 1e-9);
    near(threadPitchMm(28.575), 25.4 / 8, 1e-9);
    near(threadPitchMm(16), 2, 1e-9);
    expect(threadPitchMm(14)).toBeNull();
  });

  it('has the B16.5 raised-face heights and refuses what it does not tabulate', () => {
    expect(raisedFaceHeightMm('ASME B16.5', 150, 'RF')).toBe(1.6);
    expect(raisedFaceHeightMm('ASME B16.5', 300, 'RF')).toBe(1.6);
    expect(raisedFaceHeightMm('ASME B16.5', 600, 'RF')).toBe(6.4);
    expect(raisedFaceHeightMm('ASME B16.5', 150, 'FF')).toBe(0);
    expect(raisedFaceHeightMm('ASME B16.5', 150, 'RTJ')).toBeNull();
    expect(raisedFaceHeightMm('EN 1092-1', 150, 'RF')).toBeNull();
    expect(raisedFaceHeightMm('ASME B16.5', undefined, 'RF')).toBeNull();
    expect(raisedFaceHeightMm('ASME B16.5', 100, 'RF')).toBeNull();
  });

  it('refuses a stud rule with a non-positive input and formats quarter inches', () => {
    const base = {
      flangeThicknessAMm: 22.4,
      flangeThicknessBMm: 22.4,
      raisedFaceAMm: 1.6,
      raisedFaceBMm: 1.6,
      gasketMm: 4.5,
      boltDiameterMm: 15.875,
    };
    expect(studLengthRule({ ...base, gasketMm: 0 })).toBeNull();
    expect(studLengthRule({ ...base, flangeThicknessAMm: Number.NaN })).toBeNull();
    expect(studLengthRule({ ...base, raisedFaceAMm: -1 })).toBeNull();
    expect(studLengthRule({ ...base, nutHeightMm: 0 })).toBeNull();
    expect(studLengthRule({ ...base, boltDiameterMm: 14 })).toBeNull();
    expect(quarterInchText(95.25)).toBe('3-3/4');
    expect(quarterInchText(88.9)).toBe('3-1/2');
    expect(quarterInchText(6.35)).toBe('1/4');
    expect(quarterInchText(25.4)).toBe('1');
    expect(quarterInchText(30)).toBeNull();
  });
});
