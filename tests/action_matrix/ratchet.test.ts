import { describe, expect, it } from 'vitest';
import { type Baseline, bless, ratchet } from './baseline';
import { capActions, designsOfShard } from './matrixRunner';
import { findNonFinite, bitsOf } from './runAction';
import { sampled, stableHash } from './stableHash';
import type { Design, MatrixOptions, MatrixReport, MatrixRow } from './types';

const row = (key: string, outcome: MatrixRow['outcome'], errorKind?: MatrixRow['errorKind']): MatrixRow => ({
  key,
  design: key.split('|')[0] ?? '',
  command: 'boolean',
  target: 't',
  outcome,
  ...(errorKind === undefined ? {} : { errorKind }),
  detail: 'summary',
  volumeBits: null,
  volume: null,
  affected: [],
});

const report = (rows: MatrixRow[], fullDesigns: string[] = []): MatrixReport => ({ kernel: 'manifold', rows, costs: [], fullDesigns });
const baseline = (entries: Record<string, 'ok' | 'refused'>, knownErrors: Record<string, string> = {}): Baseline => ({
  version: 1,
  kernels: { manifold: { entries, knownErrors } },
});

describe('baseline ratchet', () => {
  it('fails an action that was ok and no longer is, and reports new passes without failing', () => {
    const result = ratchet(
      baseline({ 'd|a|1': 'ok', 'd|a|2': 'refused', 'd|a|3': 'ok' }),
      report([row('d|a|1', 'refused'), row('d|a|2', 'ok'), row('d|a|3', 'ok'), row('d|a|4', 'ok')]),
    );
    expect(result.regressions).toEqual(['d|a|1: ok -> refused (summary)']);
    expect(result.improvements).toEqual(['d|a|2: refused -> ok', 'd|a|4: new -> ok']);
    expect(result.added).toEqual(['d|a|4']);
  });

  it('flags an ok baseline key a fully run design no longer produces, but not under sampling', () => {
    const base = baseline({ 'd|a|1': 'ok', 'e|a|1': 'ok' });
    expect(ratchet(base, report([], ['d'])).vanished).toEqual(['d|a|1']);
    expect(ratchet(base, report([])).vanished).toEqual([]);
  });

  it('fails every error that is not quarantined and tracks a quarantined one that was fixed', () => {
    const quarantined = baseline({}, { 'd|a|1': 'invalid_solid: x', 'd|a|2': 'invalid_solid: y' });
    const result = ratchet(
      quarantined,
      report([row('d|a|1', 'error', 'invalid_solid'), row('d|a|2', 'ok'), row('d|a|3', 'error', 'throw')]),
    );
    expect(result.errors.map((r) => r.key)).toEqual(['d|a|3']);
    expect(result.fixedErrors).toEqual(['d|a|2']);
  });

  it('bless replaces fully run designs, merges the rest, quarantines solids and never baselines a throw', () => {
    const blessed = bless(
      baseline({ 'd|a|1': 'ok', 'd|a|gone': 'ok', 'e|a|1': 'ok' }),
      report([row('d|a|1', 'refused'), row('d|a|2', 'error', 'invalid_solid'), row('d|a|3', 'error', 'throw'), row('e|a|2', 'ok')], ['d']),
    );
    expect(blessed.kernels.manifold?.entries).toEqual({ 'd|a|1': 'refused', 'e|a|1': 'ok', 'e|a|2': 'ok' });
    expect(Object.keys(blessed.kernels.manifold?.knownErrors ?? {})).toEqual(['d|a|2']);
  });

  it('keeps the other kernel column when blessing one', () => {
    const both: Baseline = { version: 1, kernels: { occt: { entries: { 'x|y|z': 'ok' }, knownErrors: {} } } };
    expect(bless(both, report([row('d|a|1', 'ok')])).kernels.occt?.entries).toEqual({ 'x|y|z': 'ok' });
  });
});

describe('sampling, caps and shards', () => {
  const options: MatrixOptions = { kernel: 'manifold', seed: 7, designSample: 1, actionSample: 1, maxActionsPerDesign: 3 };
  const specs = Array.from({ length: 10 }, (_, i) => ({
    command: 'c',
    params: {},
    target: `t${i}`,
    operands: [] as string[],
    relation: 'none' as const,
  }));
  const designs: Design[] = Array.from({ length: 12 }, (_, i) => ({ id: `d${i}`, corpus: 'golden', actions: [] }));

  it('hashes stably and samples about 1-in-N', () => {
    expect(stableHash('abc', 1)).toBe(stableHash('abc', 1));
    expect(stableHash('abc', 1)).not.toBe(stableHash('abc', 2));
    const kept = Array.from({ length: 400 }, (_, i) => `key${i}`).filter((key) => sampled(key, 20, 1)).length;
    expect(kept).toBeGreaterThan(5);
    expect(kept).toBeLessThan(45);
    expect(sampled('anything', 1, 1)).toBe(true);
  });

  it('caps deterministically, independent of enumeration order', () => {
    const capped = capActions(specs, 'd', options);
    expect(capped).toHaveLength(3);
    expect(
      capActions([...specs].reverse(), 'd', options)
        .map((s) => s.target)
        .sort(),
    ).toEqual(capped.map((s) => s.target).sort());
  });

  it('assigns every design to exactly one shard, by hash and by measured cost', () => {
    const cost = Object.fromEntries(designs.map((d, i) => [d.id, i === 0 ? 100 : 1]));
    for (const costs of [undefined, cost]) {
      const shards = [0, 1, 2].map((index) =>
        designsOfShard(designs, { ...options, shard: { index, count: 3 }, ...(costs ? { costs } : {}) }),
      );
      expect(
        shards
          .flat()
          .map((d) => d.id)
          .sort(),
      ).toEqual(designs.map((d) => d.id).sort());
    }
    const balanced = [0, 1].map((index) => designsOfShard(designs, { ...options, shard: { index, count: 2 }, costs: cost }));
    expect(Math.min(...balanced.map((s) => s.length))).toBeLessThanOrEqual(1);
  });
});

describe('runAction helpers', () => {
  it('finds non-finite numbers in nested data and typed arrays', () => {
    expect(findNonFinite({ a: [1, 2, { b: NaN }] })).toBe('$.a.2.b=NaN');
    expect(findNonFinite({ p: new Float32Array([1, Infinity]) })).toBe('$.p[1]=Infinity');
    expect(findNonFinite({ a: [1, 2], s: 'x' })).toBeNull();
  });

  it('renders float bit patterns', () => {
    expect(bitsOf(1)).toBe('3ff0000000000000');
    expect(bitsOf(null)).toBeNull();
  });
});
