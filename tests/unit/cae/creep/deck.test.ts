/** PHY-11 §5.3 creep deck (TR-CRP-50): temperature, time points, preload step, *VISCO hold, material cards, refusals, output times. */
import { describe, expect, it } from 'vitest';
import type { CadDocument } from '@core/model/types';
import { writeInp } from '@cae/decks/inpWriter';
import { outputTimesS } from '@cae/creep/times';
import { selectIndices } from '@cae/creep/history';
import { caseOf, withCase } from '@cae/shared/access';
import { creepCube, cubeMesh, type CreepCube } from './support';

function deckOf(c: CreepCube, doc: CadDocument = c.doc): string {
  const written = writeInp(doc, c.analysisId, cubeMesh(c, doc));
  if (!('text' in written)) throw new Error(`${written.code}: ${written.message}`);
  return written.text;
}

const refusalOf = (c: CreepCube, doc: CadDocument = c.doc): { code: string; message: string } => {
  const written = writeInp(doc, c.analysisId, cubeMesh(c, doc));
  if ('text' in written) throw new Error('the deck was written');
  return written;
};

/** The lines from `*INITIAL CONDITIONS` to the end of the deck. */
const procedure = (text: string): string => text.slice(text.indexOf('*INITIAL CONDITIONS'));

/** A creep hold as set_creep_step would store it (a case that set_creep_step itself would refuse). */
const HOLD = {
  preloadStep: true,
  preloadPeriodS: 1e-3,
  durationS: 1000,
  initialIncrementS: 1,
  maxIncrements: 100,
  cetol: 1e-3,
  nlgeom: false,
  temperature: { kind: 'uniform', valueK: 293 },
  outputTimes: { kind: 'log', count: 5 },
} as const;

const withHold = (c: CreepCube, hold: typeof HOLD): CadDocument => {
  const analysis = caseOf(c.doc, c.analysisId);
  if (analysis === undefined) throw new Error('no case');
  return withCase(c.doc, { ...analysis, creep: hold });
};

const withCreep = (c: CreepCube, patch: Record<string, unknown>): CadDocument => {
  const analysis = caseOf(c.doc, c.analysisId);
  if (analysis?.creep === undefined) throw new Error('no creep step');
  return withCase(c.doc, { ...analysis, creep: { ...analysis.creep, ...patch } });
};

describe('creep deck', () => {
  it('writes temperature, time points, the elastic preload step and the *VISCO hold with the loads restated (golden)', () => {
    const c = creepCube({
      step: { outputTimes: { kind: 'linear', every: { value: 250, unit: 's' } }, maxIncrement: { value: 2, unit: 's' } },
    });
    expect(procedure(deckOf(c))).toBe(
      [
        '*INITIAL CONDITIONS, TYPE=TEMPERATURE',
        'NALL, 293',
        '*TIME POINTS, NAME=TP_HOLD',
        '250, 500, 750, 1000',
        '** step 1: elastic preload (creep is off in *STATIC)',
        '*STEP',
        '*STATIC',
        '0.001, 0.001',
        '*BOUNDARY, OP=NEW',
        'C_fc_9_1, 1, 1',
        'C_fc_10_1, 2, 2',
        'C_fc_11_1, 3, 3',
        '*CLOAD, OP=NEW',
        '*DLOAD, OP=NEW',
        '5, P3, -20',
        '6, P3, -20',
        '*TEMPERATURE',
        'NALL, 293',
        '*END STEP',
        '** step 2: creep hold of 1000 s',
        '*STEP, INC=1000',
        '*VISCO, CETOL=0.001',
        '0.1, 1000, 0.01, 2',
        '*BOUNDARY, OP=NEW',
        'C_fc_9_1, 1, 1',
        'C_fc_10_1, 2, 2',
        'C_fc_11_1, 3, 3',
        '*CLOAD, OP=NEW',
        '*DLOAD, OP=NEW',
        '5, P3, -20',
        '6, P3, -20',
        '*TEMPERATURE',
        'NALL, 293',
        '*NODE FILE, TIME POINTS=TP_HOLD',
        'U',
        '*EL FILE, TIME POINTS=TP_HOLD',
        'S, CEEQ',
        '*END STEP',
        '',
      ].join('\n'),
    );
  });

  it('without a preload step the hold is step 1; NLGEOM and the increment bounds are written; the material is *ELASTIC + *CREEP,LAW=NORTON in MPa', () => {
    const c = creepCube({ step: { preloadStep: false, nlgeom: true, minIncrement: { value: 0.01, unit: 's' } } });
    const text = deckOf(c);
    const steps = procedure(text);
    expect(steps).toContain('** creep hold of 1000 s\n*STEP, NLGEOM, INC=1000\n*VISCO, CETOL=0.001\n0.1, 1000, 0.01, 1000\n');
    expect(steps.match(/\*STEP/g)).toHaveLength(1);
    expect(text).toContain('*MATERIAL,NAME=M_1\n*ELASTIC\n210000.,0.3\n*CREEP,LAW=NORTON\n1e-10,5.,0.\n*DENSITY');
    expect(text).toContain('unverified=none');
  });

  it('with only a maximum increment the minimum is the CalculiX default 1e-5 x duration, capped at the initial increment', () => {
    const only = (initial: number): string =>
      procedure(deckOf(creepCube({ step: { initialIncrement: { value: initial, unit: 's' }, maxIncrement: { value: 5, unit: 's' } } })));
    expect(only(0.1)).toContain('*VISCO, CETOL=0.001\n0.1, 1000, 0.01, 5\n');
    expect(only(0.001)).toContain('*VISCO, CETOL=0.001\n0.001, 1000, 0.001, 5\n');
  });

  it('is byte-deterministic and converts A with the stress unit of the law (A in GPa^-5 s^-1 = 1e-10 MPa^-5 s^-1)', () => {
    const c = creepCube();
    expect(deckOf(c)).toBe(deckOf(c));
    const gpa = creepCube({ law: { A: 1e5, stressUnit: 'GPa' } });
    expect(deckOf(gpa)).toContain('*CREEP,LAW=NORTON\n1e-10,5.,0.\n');
  });

  it('converts a law in hours to the card seconds (A in 1/h = 1/3600 per s at m = 0) instead of refusing it', () => {
    const hours = creepCube({ law: { A: 3.6e-7, timeUnit: 'h' } });
    const card = /\*CREEP,LAW=NORTON\n([^,]+),5\.,0\.\n/.exec(deckOf(hours));
    expect(Number(card?.[1])).toBeCloseTo(1e-10, 20);
  });

  it('refuses by name (no throw, no deck) a law whose time unit is not a time, carried by a hand-written document', () => {
    const c = creepCube();
    const materials = Object.fromEntries(
      Object.entries(c.doc.materials).map(([id, material]) => [
        id,
        {
          ...material,
          materialModels: (material.materialModels ?? []).map((model) =>
            model.model.kind === 'creep_norton' ? { ...model, model: { ...model.model, timeUnit: 'kg' } } : model,
          ),
        },
      ]),
    );
    const bad = { ...c.doc, materials } as unknown as CadDocument;
    const refused = refusalOf(c, bad);
    expect(refused.code).toBe('MATL_CREEP_PARAMS_INVALID');
    expect(refused.message).toContain("'kg'");
  });

  it('marks an unverified law in the deck header and writes no output of the preload step', () => {
    const c = creepCube({ basis: 'typical' });
    const text = deckOf(c);
    expect(text).toContain('** UNVERIFIED: ');
    expect(procedure(text).split('*NODE FILE')).toHaveLength(2);
  });

  it('refuses with the creep code: no hold, no creep law, a temperature outside the law validity', () => {
    expect(refusalOf(creepCube({ step: null })).code).toBe('CRP_STEP_MISSING');
    const none = creepCube({ creep: false, step: null });
    expect(refusalOf(none, withHold(none, HOLD)).code).toBe('CRP_NO_VISCOUS_MATERIAL');
    const c = creepCube();
    const hot = refusalOf(c, withCreep(c, { temperature: { kind: 'uniform', valueK: 500 } }));
    expect(hot.code).toBe('CRP_LAW_OUT_OF_RANGE');
    expect(hot.message).toContain('500 K');
  });

  it('passes the mechanical refusals through: a load whose target has no face in the mesh', () => {
    const c = creepCube();
    const mesh = cubeMesh(c);
    const written = writeInp(c.doc, c.analysisId, { ...mesh, faceSets: {} });
    expect('code' in written && written.code).toBe('FEA_TARGET_UNRESOLVED');
  });
});

describe('outputTimesS', () => {
  const base = { durationS: 1000, initialIncrementS: 1 };

  it('log: the requested count from the first increment to exactly the duration, strictly increasing', () => {
    const times = outputTimesS({ ...base, outputTimes: { kind: 'log', count: 4 } });
    expect(times.map((time) => Number(time.toPrecision(12)))).toEqual([1, 10, 100, 1000]);
    expect(times.at(-1)).toBe(1000);
  });

  it('log: one time when the first increment is the whole hold (equal times written once)', () => {
    expect(outputTimesS({ durationS: 10, initialIncrementS: 50, outputTimes: { kind: 'log', count: 5 } })).toEqual([10]);
  });

  it('linear: every spacing then the end, also when the duration is not a multiple', () => {
    expect(outputTimesS({ ...base, outputTimes: { kind: 'linear', everyS: 300 } })).toEqual([300, 600, 900, 1000]);
    expect(outputTimesS({ ...base, outputTimes: { kind: 'linear', everyS: 250 } })).toEqual([250, 500, 750, 1000]);
  });
});

describe('selectIndices (TR-CRP-52)', () => {
  it('keeps every point up to the limit, and at most `limit` log-spaced ones (first and last kept) above it', () => {
    expect(selectIndices([0, 1, 2], 5)).toEqual([0, 1, 2]);
    const times = Array.from({ length: 1000 }, (_, i) => i);
    const kept = selectIndices(times, 20);
    expect(kept.length).toBeLessThanOrEqual(20);
    expect(kept[0]).toBe(0);
    expect(kept.at(-1)).toBe(999);
    expect(kept).toEqual([...kept].sort((a, b) => a - b));
    expect(new Set(kept).size).toBe(kept.length);
    expect((kept[5] ?? 0) - (kept[4] ?? 0)).toBeLessThan((kept[15] ?? 0) - (kept[14] ?? 0));
  });

  it('all-zero times select without a positive time', () => {
    expect(
      selectIndices(
        Array.from({ length: 10 }, () => 0),
        4,
      ).at(-1),
    ).toBe(9);
  });
});
