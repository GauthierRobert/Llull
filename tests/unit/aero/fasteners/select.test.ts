/** 08 MAT M5: select_fastener (VC-MAT-07, 08, 09, 24 codes, 26 named defaults). Driven by validation/expected_results.json. */
import { describe, expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import { type CadDocument } from '@core/model/types';
import { expectPure } from '../../../helpers/expectNoOp';
import { dataOf, docWith, inchDocument, ok, readValidation, sampleCatalogFile } from './fixtures';

const expectedResults = readValidation('expected_results.json') as {
  boltGripSelection: Array<{
    id: string;
    input: { family: string; diameterDash: string; stack_in: number };
    expected: Record<string, unknown>;
  }>;
  hiLokGripSelection: Array<{
    id: string;
    input: { family: string; diameterDash32nds: number; stack_in: number };
    expected: Record<string, unknown>;
  }>;
  rivetSelection: Array<{
    id: string;
    input: { family: string; material: string; diameterDash: string; stack_in: number };
    expected: Record<string, number | string>;
  }>;
  agentFirst: Array<{ id: string; expected: Record<string, { value: unknown; source: string; defaulted: boolean }> }>;
};

const doc = docWith(sampleCatalogFile(), inchDocument());
const inchStack = (value: number): { value: number; unit: string } => ({ value, unit: 'in' });

describe('select_fastener bolts (VC-MAT-07)', () => {
  it.each(expectedResults.boltGripSelection)('$id', ({ input, expected }) => {
    const params = {
      family: input.family,
      diameterDash: input.diameterDash,
      stack: inchStack(input.stack_in),
      washer: 'NAS1149',
      ...(input.diameterDash === '3' ? { nut: 'MS21042' } : {}),
    };
    const result = execute(doc, 'select_fastener', params);
    const data = dataOf(result);
    expect(result.document).toBe(doc);
    if (expected['ok'] === false) {
      expect(data['ok']).toBe(false);
      expect(result.error?.code).toBe('FAST_STACK_OUT_OF_RANGE');
      return;
    }
    expect(result.error, result.summary).toBeUndefined();
    expect(data).toMatchObject({ ok: true, partNumber: expected['partNumber'] });
    expect(data['gripIn']).toBeCloseTo(expected['grip_in'] as number, 9);
    expect(data['lengthIn']).toBeCloseTo(expected['length_in'] as number, 9);
    expect(data['gapIn']).toBeCloseTo(expected['gap_in'] as number, 9);
    expect(data['washersIn']).toEqual(expected['washersUnderNut_in']);
    if (expected['protrusionBeyondNutMaxHeight_in'] !== undefined) {
      expect(data['protrusionIn']).toBeCloseTo(expected['protrusionBeyondNutMaxHeight_in'] as number, 9);
      expect(data['protrusion']).toMatchObject({ status: 'ok', requiredIn: 0.03125 });
      expect((data['nut'] as Record<string, unknown>)['partNumber']).toBe(expected['nut']);
    }
  });

  it('AC-7: names the washer, the nut and the washer part number descriptor', () => {
    const data = dataOf(
      execute(doc, 'select_fastener', {
        family: 'NAS6203-6220',
        diameterDash: '3',
        stack: inchStack(0.51),
        nut: 'MS21042',
        washer: 'NAS1149',
      }),
    );
    expect(data['washers']).toEqual([{ partNumber: 'NAS1149(.063)', thicknessIn: 0.063 }]);
    expect(data['nut']).toMatchObject({ partNumber: 'MS21042L3', heightMaxIn: 0.188 });
  });

  it('fills a gap with the smallest-cardinality washer set (0.016 + 0.032 = 0.048 is short of 0.0525, so 0.032 + 0.032)', () => {
    const custom = docWith(withThicknesses([0.032, 0.016]), inchDocument());
    const data = dataOf(
      execute(custom, 'select_fastener', { family: 'NAS6203-6220', diameterDash: '3', stack: inchStack(0.51), washer: 'NAS1149' }),
    );
    expect(data['washersIn']).toEqual([0.032, 0.032]);
    expect(data['washerTotalIn']).toBeCloseTo(0.064, 9);
  });

  it('refuses a gap that no washer set within the limit can fill (FAST_WASHER_GAP) and a missing washer family', () => {
    const tight = execute(doc, 'select_fastener', {
      family: 'NAS6203-6220',
      diameterDash: '3',
      stack: inchStack(0.51),
      washer: 'NAS1149',
      maxWasherTotal: { value: 0.01, unit: 'in' },
    });
    expect(tight.error?.code).toBe('FAST_WASHER_GAP');
    expect(dataOf(tight)['rules']).toMatchObject({ maxWasherTotal: { value: 0.01, defaulted: false, source: 'caller' } });
    const bare = execute(doc, 'select_fastener', { family: 'NAS6203-6220', diameterDash: '3', stack: inchStack(0.51) });
    expect(bare.error?.code).toBe('FAST_WASHER_GAP');
    expect(bare.error?.remediation).not.toBe('');
  });

  it('flags a short protrusion (FAST_PROTRUSION_SHORT) and an unknown nut height (FAST_PROTRUSION_UNKNOWN warning, not a pass)', () => {
    const tallNut = docWith(withNutHeight({ min: 0.35, max: 0.4 }), inchDocument());
    const short = execute(tallNut, 'select_fastener', {
      family: 'NAS6203-6220',
      diameterDash: '3',
      stack: inchStack(0.5625),
      nut: 'MS21042',
    });
    expect(short.error?.code).toBe('FAST_PROTRUSION_SHORT');
    expect(dataOf(short)['protrusion']).toMatchObject({ status: 'short' });
    const unknown = docWith(withNutHeight(null), inchDocument());
    const result = execute(unknown, 'select_fastener', {
      family: 'NAS6203-6220',
      diameterDash: '3',
      stack: inchStack(0.5625),
      nut: 'MS21042',
    });
    expect(result.error).toBeUndefined();
    expect(dataOf(result)['protrusion']).toMatchObject({ status: 'unknown' });
    expect((dataOf(result)['warnings'] as Array<{ code: string }>).map((w) => w.code)).toContain('FAST_PROTRUSION_UNKNOWN');
  });

  it('refuses unknown families and sizes, a missing stack, a non-selectable family and unknown nut / washer', () => {
    const code = (params: Record<string, unknown>): string | undefined => execute(doc, 'select_fastener', params).error?.code;
    expect(code({ family: 'NOPE', diameterDash: '3', stack: inchStack(0.5) })).toBe('FAST_FAMILY_UNKNOWN');
    expect(code({ family: 'NAS6203-6220', diameterDash: '99', stack: inchStack(0.5) })).toBe('FAST_SIZE_UNKNOWN');
    expect(code({ family: 'NAS6203-6220', diameterDash: '3' })).toBe('FAST_STACK_MISSING');
    expect(code({ family: 'NAS6203-6220', diameterDash: '3', stack: inchStack(-1) })).toBe('FAST_STACK_MISSING');
    expect(code({ family: 'NAS6203-6220', diameterDash: '3', stack: { value: 1, unit: 'furlong' } })).toBe('FAST_STACK_MISSING');
    expect(code({ family: 'MS21042', diameterDash: '3', stack: inchStack(0.5) })).toBe('FAST_FAMILY_NOT_SELECTABLE');
    expect(code({ family: 'NAS6203-6220', diameterDash: '3', stack: inchStack(0.5625), nut: 'NOPE' })).toBe('FAST_FAMILY_UNKNOWN');
    expect(code({ family: 'NAS6203-6220', diameterDash: '4', stack: inchStack(0.5625), nut: 'MS21042' })).toBe('FAST_SIZE_UNKNOWN');
    expect(code({ family: 'NAS6203-6220', diameterDash: '3', stack: inchStack(0.5625), washer: 'NOPE' })).toBe('FAST_FAMILY_UNKNOWN');
    expectPure(doc, () =>
      execute(doc, 'select_fastener', { family: 'NAS6203-6220', diameterDash: '3', stack: inchStack(0.51), washer: 'NAS1149' }),
    );
  });
});

describe('select_fastener Hi-Lok pins (VC-MAT-08)', () => {
  it.each(expectedResults.hiLokGripSelection)('$id', ({ input, expected }) => {
    const result = execute(doc, 'select_fastener', {
      family: input.family,
      diameterDash: String(input.diameterDash32nds),
      stack: inchStack(input.stack_in),
    });
    const data = dataOf(result);
    expect(data).toMatchObject({ ok: true, partNumber: expected['partNumber'] });
    expect(data['gripRangeIn']).toEqual(expected['gripRange_in']);
    expect(result.error).toBeUndefined();
  });

  it('refuses a stack beyond the largest grip and warns that collars are not selected', () => {
    const tooThick = execute(doc, 'select_fastener', { family: 'HL19', diameterDash: '8', stack: inchStack(3) });
    expect(tooThick.error?.code).toBe('FAST_STACK_OUT_OF_RANGE');
    const withNut = dataOf(execute(doc, 'select_fastener', { family: 'HL19', diameterDash: '8', stack: inchStack(0.6), nut: 'MS21042' }));
    expect((withNut['warnings'] as Array<{ code: string }>).map((w) => w.code)).toContain('FAST_PROTRUSION_UNKNOWN');
  });
});

describe('select_fastener rivets (VC-MAT-09)', () => {
  it.each(expectedResults.rivetSelection)('$id', ({ input, expected }) => {
    const result = execute(doc, 'select_fastener', {
      family: input.family,
      diameterDash: input.diameterDash,
      stack: inchStack(input.stack_in),
      codes: { material: input.material },
    });
    const data = dataOf(result);
    expect(data['partNumber']).toBe(expected['partNumber']);
    expect(data['rawLengthIn']).toBeCloseTo(expected['rawLength_in'] as number, 4);
    expect(data['lengthIn']).toBeCloseTo(expected['length_in'] as number, 4);
    expect(data['shopHeadMinDiameterIn']).toBeCloseTo(expected['shopHeadMinDiameter_in'] as number, 4);
    expect(data['shopHeadMinHeightIn']).toBeCloseTo(expected['shopHeadMinHeight_in'] as number, 4);
    expect(data['minEdgeDistanceIn']).toBeCloseTo(expected['minEdgeDistance_in'] as number, 4);
    expect(data['minPitchIn']).toBeCloseTo(expected['minPitch_in'] as number, 4);
  });

  it('rounds to the nearest step when asked and names a defaulted code choice', () => {
    const nearest = dataOf(
      execute(doc, 'select_fastener', {
        family: 'MS20470',
        diameterDash: '4',
        stack: inchStack(0.08),
        rivetRounding: 'nearest',
        codes: { material: 'AD' },
      }),
    );
    expect(nearest['partNumber']).toBe('MS20470AD4-4');
    expect(nearest['rules']).toMatchObject({ rivetLengthRounding: { value: 'nearest', defaulted: false, source: 'caller' } });
    const defaulted = dataOf(execute(doc, 'select_fastener', { family: 'MS20470', diameterDash: '4', stack: inchStack(0.125) }));
    expect(defaulted['partNumber']).toBe('MS20470AD4-5');
    expect(defaulted['partNumberDefaultedCodes']).toEqual(['material']);
  });
});

describe('select_fastener named defaults (VC-MAT-26)', () => {
  const expected = expectedResults.agentFirst.find((entry) => entry.id === 'VC-MAT-26')?.expected ?? {};

  it('lists the bolt defaults with source and defaulted: true', () => {
    const rules = dataOf(
      execute(doc, 'select_fastener', {
        family: 'NAS6203-6220',
        diameterDash: '3',
        stack: inchStack(0.51),
        nut: 'MS21042',
        washer: 'NAS1149',
      }),
    )['rules'] as Record<string, Record<string, unknown>>;
    expect(rules['maxWasherTotal']).toMatchObject({
      value: expected['maxWasherTotal']?.value,
      unit: 'in',
      source: expected['maxWasherTotal']?.source,
      defaulted: true,
    });
    expect(rules['minProtrusion']).toMatchObject({ source: expected['minProtrusion']?.source, defaulted: true });
  });

  it('lists the rivet defaults with source and defaulted: true', () => {
    const rules = dataOf(
      execute(doc, 'select_fastener', { family: 'MS20470', diameterDash: '4', stack: inchStack(0.125), codes: { material: 'AD' } }),
    )['rules'] as Record<string, Record<string, unknown>>;
    expect(rules['rivetLengthRounding']).toMatchObject({ value: 'up', step: { value: 0.0625, unit: 'in' }, defaulted: true });
    expect(String(rules['rivetLengthRounding']?.['source'])).toContain('OQ-MAT-04');
    expect(rules['rivetMinEdgeDistance']).toMatchObject({
      source: expected['rivetMinEdgeDistance']?.source,
      defaulted: true,
      valueIn: 0.25,
    });
    expect(rules['rivetMinPitch']).toMatchObject({ source: expected['rivetMinPitch']?.source, defaulted: true, valueIn: 0.375 });
  });
});

describe('select_fastener stack measurement (stackIds)', () => {
  function plates(extra: Record<string, unknown> = {}): { doc: CadDocument; a: string; b: string } {
    const first = ok(doc, 'add_box', { size: [2, 1, 0.25], anchor: 'min', position: [0, 0, 0] });
    const second = ok(first.document, 'add_box', { size: [2, 1, 0.26], anchor: 'min', position: [0, 0, 0.25], ...extra });
    return { doc: second.document, a: first.affected[0] as string, b: second.affected[0] as string };
  }
  const params = (a: string, b: string): Record<string, unknown> => ({
    family: 'NAS6203-6220',
    diameterDash: '3',
    stackIds: [a, b],
    axisPoint: [1, 0.5, 0],
    axis: [0, 0, 1],
    nut: 'MS21042',
    washer: 'NAS1149',
  });

  it('measures the two plates of the AERO plan: 0.51 in -> NAS6203-9 with one 0.063 washer and 0.124 in protrusion', () => {
    const { doc: scene, a, b } = plates();
    const result = execute(scene, 'select_fastener', params(a, b));
    const data = dataOf(result);
    expect(data).toMatchObject({ ok: true, partNumber: 'NAS6203-9', stackSource: 'measured', washersIn: [0.063], protrusionIn: 0.124 });
    expect((data['layers'] as unknown[]).length).toBe(2);
    expect(data['stackIn']).toBeCloseTo(0.51, 6);
  });

  it('measures in a millimetre document too', () => {
    const mm = ok(docWith(), 'add_box', { size: [50, 30, 6.35], anchor: 'min', position: [0, 0, 0] });
    const result = execute(mm.document, 'select_fastener', {
      family: 'NAS6203-6220',
      diameterDash: '3',
      stackIds: mm.affected,
      axisPoint: [25, 15, 0],
      washer: 'NAS1149',
    });
    expect(dataOf(result)['stackIn']).toBeCloseTo(0.25, 6);
    expect(dataOf(result)['partNumber']).toBe('NAS6203-4');
  });

  it('refuses a gap between plates, an axis that misses a plate, a missing id and a non-solid, with coded errors', () => {
    const { doc: scene, a, b } = plates({ position: [0, 0, 0.3] });
    expect(execute(scene, 'select_fastener', params(a, b)).error).toMatchObject({ code: 'FAST_LAYER_GAP', ids: [a, b] });
    const flat = plates().doc;
    expect(execute(flat, 'select_fastener', { ...params(a, b), axisPoint: [5, 5, 0] }).error?.code).toBe('FAST_AXIS_MISS');
    expect(execute(flat, 'select_fastener', params(a, 'ghost')).error).toMatchObject({ code: 'FAST_LAYER_MISSING', ids: ['ghost'] });
    const line = ok(flat, 'draw_polyline', {
      points: [
        [0, 0],
        [1, 0],
      ],
    });
    expect(execute(line.document, 'select_fastener', params(a, line.affected[0] as string)).error?.code).toBe('FAST_LAYER_MISSING');
    expect(execute(flat, 'select_fastener', { ...params(a, b), axisPoint: undefined }).error?.code).toBe('FAST_STACK_MISSING');
    expect(execute(flat, 'select_fastener', { ...params(a, b), axis: [0, 0, 0] }).error?.code).toBe('FAST_STACK_MISSING');
  });

  it('warns FAST_AXIS_ANGLE when the axis is more than 2 degrees off the face normal', () => {
    const { doc: scene, a, b } = plates();
    const tilted = execute(scene, 'select_fastener', { ...params(a, b), axis: [0.1, 0, 1] });
    expect((dataOf(tilted)['warnings'] as Array<{ code: string }>).map((w) => w.code)).toContain('FAST_AXIS_ANGLE');
  });
});

/** The sample catalogue with the washer thickness options replaced. */
function withThicknesses(options: number[]): Record<string, unknown> {
  const file = sampleCatalogFile();
  const families = file['families'] as Array<{ id: string; sizes: Array<{ dims: { thickness: { options: number[] } } }> }>;
  for (const size of families.find((family) => family.id === 'NAS1149')?.sizes ?? []) size.dims.thickness.options = options;
  return file;
}

/** The sample catalogue with the MS21042 nut height replaced (null: no height listed). */
function withNutHeight(height: { min: number; max: number } | null): Record<string, unknown> {
  const file = sampleCatalogFile();
  const families = file['families'] as Array<{ id: string; sizes: Array<{ dims: Record<string, unknown> }> }>;
  const size = families.find((family) => family.id === 'MS21042')?.sizes[0];
  if (size !== undefined)
    size.dims['height'] = height === null ? undefined : { ...height, unit: 'in', provenance: { citation: 'fixture' } };
  if (size !== undefined && height === null) delete size.dims['height'];
  return file;
}
