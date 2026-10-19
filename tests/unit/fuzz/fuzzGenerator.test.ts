/** SC-Q3 fuzz generator: deterministic per seed, on the 2.5 mm grid, real registry commands, only `$body` crosses steps. */

import { describe, expect, it } from 'vitest';
import { getCommand } from '@core/commands/registry';
import { fuzzPlan, generateFuzzCase, MAX_FUZZ_FEATURES } from '@protocol/fuzz/generator';
import { generateBooleanPair } from '@protocol/fuzz/identities';
import { createPrng, floorToGrid, FUZZ_GRID_MM } from '@protocol/fuzz/prng';
import { FUZZ_FEATURE_KINDS, type FuzzAction } from '@protocol/fuzz/types';

const SEEDS = Array.from({ length: 200 }, (_, k) => k + 1);
const onGrid = (value: number): boolean => Math.abs(value / FUZZ_GRID_MM - Math.round(value / FUZZ_GRID_MM)) < 1e-9;
const BLEND_KEYS = new Set(['radius', 'distance', 'thickness']);

/** Lengths that must sit on the grid: sizes, radii, heights, depths, diameters, offsets, hole points; box bounds. */
function gridLengths(action: FuzzAction): number[] {
  const p = action.params as Record<string, unknown>;
  const numbers = (value: unknown): number[] => (typeof value === 'number' ? [value] : Array.isArray(value) ? value.flatMap(numbers) : []);
  switch (action.command) {
    case 'add_box': {
      const size = numbers(p['size']);
      const at = numbers(p['position']);
      // base-center anchor: x/y bounds at centre ± size/2, z from the position up.
      return [...size, (at[0] ?? 0) - (size[0] ?? 0) / 2, (at[1] ?? 0) - (size[1] ?? 0) / 2, at[2] ?? 0];
    }
    case 'add_cylinder':
    case 'add_sphere':
      return [...numbers(p['radius']), ...numbers(p['height']), ...numbers(p['position'])];
    case 'extrude_profile':
    case 'revolve_profile':
      return [...numbers(p['profile']), ...numbers(p['depth'])];
    case 'add_hole':
      return [...numbers(p['points']), ...numbers((p['hole'] as Record<string, unknown>)['diameter'])];
    case 'array_linear':
      return numbers(p['offset']);
    default:
      return Object.entries(p)
        .filter(([key, value]) => typeof value === 'number' && !BLEND_KEYS.has(key))
        .map(([, value]) => value as number);
  }
}

describe('fuzz PRNG', () => {
  it('is deterministic and uniform enough', () => {
    const a = createPrng(42);
    const b = createPrng(42);
    const values = Array.from({ length: 1000 }, () => a.next());
    expect(values).toEqual(Array.from({ length: 1000 }, () => b.next()));
    expect(values.every((v) => v >= 0 && v < 1)).toBe(true);
    expect(Math.abs(values.reduce((s, v) => s + v, 0) / values.length - 0.5)).toBeLessThan(0.05);
    expect(createPrng(43).next()).not.toBe(createPrng(42).next());
  });

  it('draws grid multiples and integers inside their bounds', () => {
    const prng = createPrng(7);
    for (let k = 0; k < 500; k++) {
      const value = prng.grid(2, 6);
      expect(onGrid(value) && value >= 5 && value <= 15).toBe(true);
      const n = prng.int(-3, 3);
      expect(Number.isInteger(n) && n >= -3 && n <= 3).toBe(true);
    }
    expect(prng.int(4, 2)).toBe(4);
    expect(floorToGrid(7.4)).toBe(5);
    expect(floorToGrid(-7.4)).toBe(-5);
  });
});

describe('generateFuzzCase', () => {
  it('is a pure function of (seed, options)', () => {
    for (const seed of SEEDS.slice(0, 30)) expect(generateFuzzCase(seed)).toEqual(generateFuzzCase(seed));
    expect(generateFuzzCase(1)).not.toEqual(generateFuzzCase(2));
  });

  it('starts from a box, extrusion or revolve and adds 1..8 known feature steps', () => {
    const bases = new Set<string>();
    const kinds = new Set<string>();
    for (const seed of SEEDS) {
      const { steps } = generateFuzzCase(seed);
      const [base, ...features] = steps;
      expect(base?.kind).toBe('base');
      expect(base?.actions[0]).toEqual({ command: 'set_units', params: { units: 'mm' } });
      bases.add(base?.actions[1]?.command ?? '');
      expect(features.length).toBeGreaterThanOrEqual(1);
      expect(features.length).toBeLessThanOrEqual(MAX_FUZZ_FEATURES);
      for (const step of features) kinds.add(step.kind);
      expect(steps.filter((s) => s.kind === 'shell').length).toBeLessThanOrEqual(1);
    }
    expect([...bases].sort()).toEqual(['add_box', 'extrude_profile', 'revolve_profile']);
    expect([...kinds].sort()).toEqual([...FUZZ_FEATURE_KINDS].sort());
  });

  it('uses only registered commands, ending each step by rebinding $body', () => {
    for (const seed of SEEDS) {
      for (const step of generateFuzzCase(seed).steps) {
        for (const action of step.actions) expect(getCommand(action.command), action.command).toBeDefined();
        expect(step.actions.at(-1)?.as).toBe('body');
      }
    }
  });

  it('puts every length and placement on the 2.5 mm grid (blend sizes excepted)', () => {
    for (const seed of SEEDS) {
      for (const step of generateFuzzCase(seed).steps)
        for (const action of step.actions) {
          if (action.command === 'array_polar' || action.command === 'set_units') continue;
          for (const value of gridLengths(action)) expect(onGrid(value), `${seed} ${action.command} ${value}`).toBe(true);
        }
    }
  });

  it('honours options.kinds and options.maxFeatures', () => {
    for (const seed of SEEDS.slice(0, 50)) {
      const meshOnly = generateFuzzCase(seed, { kinds: ['join', 'cut', 'hole', 'pattern'] });
      expect(meshOnly.steps.some((s) => ['fillet', 'chamfer', 'shell'].includes(s.kind))).toBe(false);
      expect(generateFuzzCase(seed, { maxFeatures: 2 }).steps.length).toBeLessThanOrEqual(3);
      expect(generateFuzzCase(seed, { kinds: [] }).steps.map((s) => s.kind)).toEqual(['base']);
    }
  });

  it('fuzzPlan concatenates the step actions into one build_project plan', () => {
    const { steps } = generateFuzzCase(5);
    expect(fuzzPlan(steps).actions).toEqual(steps.flatMap((s) => s.actions));
  });
});

describe('generateBooleanPair', () => {
  it('is deterministic and places B centred inside A', () => {
    for (const seed of SEEDS.slice(0, 50)) {
      const pair = generateBooleanPair(seed);
      expect(generateBooleanPair(seed)).toEqual(pair);
      const [, a, b] = pair.actions;
      expect(a?.as).toBe('a');
      expect(b?.as).toBe('b');
      expect(a?.params['position']).toEqual([0, 0, 0]);
      const center = b?.params['position'] as number[];
      expect(center.every(onGrid)).toBe(true);
    }
  });
});
