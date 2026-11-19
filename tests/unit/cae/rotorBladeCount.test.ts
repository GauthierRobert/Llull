/**
 * 14 FLL-M4b: the blade count stored on the rotor (add_rotor bladeCount), validated on load, and read by check_rotor_resonance as the
 * blade-passing order (the caller's bladeCount / bladeCounts is the fallback for a rotor that stores none; a disagreeing value is refused).
 */
import { describe, expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import { deserializeDocument, serializeDocument } from '@core/commands/persistence/serialization';
import type { CadDocument } from '@core/model/types';
import { flightDocument } from '@dynamics/flight/document';
import { expectNoOp, expectPure } from '../../helpers/expectNoOp';
import { eigenCase, modalDat, type EigenCase } from './eigenFixtures';
import { mustRun } from './deckFixtures';

const F1 = 72.078;

const ROTOR = {
  body: 'frame',
  hub: [0, 0, 0],
  axis: [0, 0, 1],
  spin: 'ccw',
  rpm: 3000,
  diameter: 0.254,
  thrustCoefficient: 0.1,
  powerCoefficient: 0.05,
  source: 'test',
};

/** The solved modal bar as body `frame`, rotor `r3` storing 3 blades and rotor `rx` storing none. */
function setup(): { fixture: EigenCase; doc: CadDocument; analysisId: string } {
  const fixture = eigenCase({ type: 'modal', dat: modalDat([F1, 451.72]) });
  let doc = mustRun(fixture.recorded, 'add_rigid_body', {
    entityIds: [fixture.bar.boxId],
    id: 'frame',
    massKg: 1,
    inertiaKgM2: [0.01, 0.01, 0.01, 0, 0, 0],
  });
  doc = mustRun(doc, 'add_rotor', { ...ROTOR, id: 'r3', bladeCount: 3 });
  doc = mustRun(doc, 'add_rotor', { ...ROTOR, id: 'rx', hub: [10, 0, 0] });
  return { fixture, doc, analysisId: fixture.bar.analysisId };
}

interface RotorData {
  rotorId: string;
  harmonics: number[];
  bladeCount: number | null;
  bladeCountSource: string;
}
const rotorsOf = (result: ReturnType<typeof execute>): RotorData[] => (result.data as { rotors: RotorData[] }).rotors;
const rotorOf = (result: ReturnType<typeof execute>, id: string): RotorData | undefined => rotorsOf(result).find((r) => r.rotorId === id);

const check = (s: ReturnType<typeof setup>, params: Record<string, unknown>, doc: CadDocument = s.doc): ReturnType<typeof execute> =>
  execute(doc, 'check_rotor_resonance', { analysisId: s.analysisId, rpmBand: [1000, 2400], ...params }, s.fixture.ctx);

describe('add_rotor bladeCount', () => {
  it('is stored on the rotor and named in the summary; absent stays absent', () => {
    const s = setup();
    const rotors = (s.doc.flight as unknown as { rotors: Record<string, Record<string, unknown>> }).rotors;
    expect(rotors['r3']?.['bladeCount']).toBe(3);
    expect(rotors['rx'] !== undefined && 'bladeCount' in rotors['rx']).toBe(false);
    const result = execute(s.doc, 'add_rotor', { ...ROTOR, id: 'r2', bladeCount: 2 });
    expect(result.affected).toEqual(['r2']);
    expect(result.summary).toContain('2 blades');
  });

  it('rejects a blade count that is not a whole number in 1..64, unchanged', () => {
    const s = setup();
    for (const bladeCount of [0, 2.5, 65, -1]) expectNoOp(execute(s.doc, 'add_rotor', { ...ROTOR, id: 'rb', bladeCount }), s.doc);
  });

  it('survives save / load and replay', () => {
    const s = setup();
    const loaded = deserializeDocument(serializeDocument(s.doc));
    expect(loaded.flight).toEqual(s.doc.flight);
    expect(execute(s.doc, 'replay_history', {}).document.flight).toEqual(s.doc.flight);
  });

  it('a hostile stored blade count is refused on load, naming its path', () => {
    const s = setup();
    const raw = (JSON.parse(serializeDocument(s.doc)) as { document: Record<string, unknown> }).document;
    expect(flightDocument.validate(raw)).toEqual([]);
    const flight = raw['flight'] as { rotors: Record<string, Record<string, unknown>> };
    const rotor = flight.rotors['r3'] ?? {};
    for (const bladeCount of [0, 2.5, -3, 1e308, '3', null, true]) {
      const errors = flightDocument.validate({ ...raw, flight: { ...flight, rotors: { ...flight.rotors, r3: { ...rotor, bladeCount } } } });
      expect(errors.length, String(bladeCount)).toBeGreaterThan(0);
      for (const error of errors) expect(error).toMatch(/^flight\.rotors\.r3\.bladeCount: /);
    }
  });
});

describe('check_rotor_resonance reads the stored blade count', () => {
  it('a stored count gives the blade-passing order without caller input; a rotor without one stays unassessed', () => {
    const s = setup();
    const result = check(s, {});
    expect(rotorOf(result, 'r3')).toMatchObject({ bladeCount: 3, bladeCountSource: 'rotor (add_rotor bladeCount)', harmonics: [1, 2, 3] });
    expect(rotorOf(result, 'rx')).toMatchObject({ bladeCount: null, bladeCountSource: 'none', harmonics: [1, 2] });
    const data = result.data as { unassessed: { rotorId: string }[]; rows: { rotorId: string; harmonic: number; label: string }[] };
    expect(data.unassessed.map((entry) => entry.rotorId)).toEqual(['rx']);
    expect(data.rows.find((row) => row.rotorId === 'r3' && row.harmonic === 3)?.label).toBe('3P (blade passing)');
  });

  it('falls back to the caller count for a rotor that stores none; an equal caller count is accepted', () => {
    const s = setup();
    const result = check(s, { bladeCounts: { rx: 4, r3: 3 } });
    expect(rotorOf(result, 'rx')).toMatchObject({ bladeCount: 4, bladeCountSource: 'caller', harmonics: [1, 2, 4] });
    expect(rotorOf(result, 'r3')).toMatchObject({ bladeCount: 3, bladeCountSource: 'rotor (add_rotor bladeCount)' });
    expect(rotorOf(check(s, { rotors: ['rx'], bladeCount: 5 }), 'rx')).toMatchObject({ bladeCount: 5, bladeCountSource: 'caller' });
  });

  it('a caller count that disagrees with the stored one is refused (FLL_BLADE_COUNT_CONFLICT), document unchanged', () => {
    const s = setup();
    for (const params of [{ bladeCount: 2 }, { bladeCounts: { r3: 5 } }]) {
      const result = check(s, params);
      expect(result.rejected).toBe(true);
      expect(result.document).toBe(s.doc);
      expect(result.summary).toContain('FLL_BLADE_COUNT_CONFLICT');
      expect(result.summary).toContain("'r3' stores 3 blades");
    }
  });

  it('a stored value that is not a whole count (a document built without the load check) is read as none', () => {
    const s = setup();
    const flight = s.doc.flight as unknown as { rotors: Record<string, Record<string, unknown>> };
    const r3 = flight.rotors['r3'] ?? {};
    const odd = { ...s.doc, flight: { ...flight, rotors: { ...flight.rotors, r3: { ...r3, bladeCount: 2.5 } } } } as unknown as CadDocument;
    expect(rotorOf(check(s, { rotors: ['r3'] }, odd), 'r3')).toMatchObject({ bladeCount: null, bladeCountSource: 'none' });
  });

  it('is pure', () => {
    const s = setup();
    expectPure(s.doc, () => check(s, { bladeCounts: { rx: 4 } }));
  });
});
