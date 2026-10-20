/**
 * SC-Q3 fuzz runner, identities and minimiser on the in-process Manifold kernel: a stable 20-seed sample must pass, and each check
 * must catch the failure it is for (a wrong step, a cut that adds volume, a join that removes it, a failing command).
 */

import { beforeAll, describe, expect, it } from 'vitest';
import { setGeometryKernel } from '@core/geometry/kernel';
import { createManifoldKernel } from '@kernel-manifold/manifoldKernel';
import { generateFuzzCase } from '@protocol/fuzz/generator';
import { generateBooleanPair, runBooleanIdentity } from '@protocol/fuzz/identities';
import { minimiseFuzzCase, minimiseList } from '@protocol/fuzz/minimise';
import { runFuzzSteps } from '@protocol/fuzz/runner';
import { kindsForKernel, runFuzzSeed, summariseFuzz } from '@protocol/fuzz/session';
import type { FuzzStep } from '@protocol/fuzz/types';

const MESH_KINDS = ['join', 'cut', 'hole', 'pattern'] as const;

beforeAll(async () => {
  setGeometryKernel(await createManifoldKernel());
}, 60_000);

const box = (size: [number, number, number], at: [number, number, number] = [0, 0, 0]): FuzzStep => ({
  kind: 'base',
  effect: 'add',
  label: 'box',
  actions: [
    { command: 'set_units', params: { units: 'mm' } },
    { command: 'add_box', params: { size, anchor: 'base-center', position: at }, as: 'body' },
  ],
});

const combine = (
  kind: FuzzStep['kind'],
  effect: FuzzStep['effect'],
  op: string,
  size: [number, number, number],
  at: [number, number, number],
): FuzzStep => ({
  kind,
  effect,
  label: `${op} ${size.join('x')}`,
  actions: [
    { command: 'add_box', params: { size, anchor: 'base-center', position: at }, as: 'tool' },
    { command: 'boolean', params: { op, a: '$body', b: '$tool' }, as: 'body' },
  ],
});

/** A hole drilled at a face that does not exist: add_hole refuses (FTR_FACE_NOT_FOUND). */
const badHole = (): FuzzStep => ({
  kind: 'hole',
  effect: 'remove',
  label: 'hole off the part',
  actions: [
    {
      command: 'add_hole',
      params: {
        target: '$body',
        face: { near: [900, 0, 0] },
        points: [[900, 0]],
        pointsFrame: 'world_xy',
        hole: { kind: 'simple', diameter: 5 },
        extent: { kind: 'through_all' },
      },
      as: 'body',
    },
  ],
});

describe('fuzz sample (20 seeds, Manifold)', () => {
  it('passes every design and boolean identity check', () => {
    const reports = Array.from({ length: 20 }, (_, k) => runFuzzSeed(k + 1, { kinds: [...MESH_KINDS] }));
    const failures = reports.filter((r) => !r.ok).map((r) => ({ seed: r.seed, design: r.design.failure, identity: r.identity.failure }));
    expect(failures).toEqual([]);
    const summary = summariseFuzz(reports);
    expect(summary).toMatchObject({ seeds: 20, passed: 20, failed: 0 });
    expect(reports.every((r) => r.design.steps.every((s) => (s.volume ?? 0) > 0))).toBe(true);
  }, 60_000);

  it('limits the kinds to what the kernel can do', () => {
    expect(kindsForKernel(null)).toEqual([...MESH_KINDS]);
    expect(kindsForKernel({ supports: () => true })).toEqual(['join', 'cut', 'fillet', 'chamfer', 'shell', 'hole', 'pattern']);
  });
});

describe('runFuzzSteps checks', () => {
  it('reports volumes that grow on joins and shrink on cuts', () => {
    const report = runFuzzSteps(0, [
      box([20, 20, 10]),
      combine('join', 'add', 'union', [10, 10, 5], [0, 0, 10]),
      combine('cut', 'remove', 'subtract', [5, 5, 5], [0, 0, 7.5]),
    ]);
    expect(report.ok).toBe(true);
    expect(report.steps.map((s) => Math.round(s.volume ?? 0))).toEqual([4000, 4500, 4375]);
  });

  it('flags a removal step that adds volume and an addition step that removes it', () => {
    const grows = runFuzzSteps(0, [box([20, 20, 10]), combine('cut', 'remove', 'union', [10, 10, 5], [0, 0, 10])]);
    expect(grows.failure).toMatchObject({ step: 1, kind: 'cut', check: 'volume_added_by_removal' });
    const shrinks = runFuzzSteps(0, [box([20, 20, 10]), combine('join', 'add', 'subtract', [10, 10, 5], [0, 0, 7.5])]);
    expect(shrinks.failure).toMatchObject({ step: 1, kind: 'join', check: 'volume_removed_by_addition' });
  });

  it('flags a failing command and stops there', () => {
    const missing = badHole();
    const report = runFuzzSteps(0, [box([20, 20, 10]), missing, combine('join', 'add', 'union', [5, 5, 5], [0, 0, 10])]);
    expect(report.failure).toMatchObject({ step: 1, check: 'command_failed' });
    expect(report.steps).toHaveLength(2);
  });
});

describe('boolean identities', () => {
  it('hold on generated pairs (curved primitives included: volumes are the kernel’s)', () => {
    for (let seed = 1; seed <= 10; seed++) {
      const report = runBooleanIdentity(generateBooleanPair(seed));
      expect(report.failure).toBeUndefined();
      const v = report.volumes;
      expect(v && Math.abs(v.union + v.intersect - v.a - v.b) / (v.a + v.b)).toBeLessThan(0.002);
    }
  });

  it('fail a pair whose build fails', () => {
    const report = runBooleanIdentity({ seed: 0, label: 'bad', actions: [{ command: 'add_box', params: { size: [-1, 1, 1] }, as: 'a' }] });
    expect(report.failure?.check).toBe('command_failed');
  });
});

describe('minimiser', () => {
  it('ddmin finds the 1-minimal failing subsequence of a synthetic predicate', () => {
    const items = Array.from({ length: 12 }, (_, k) => k);
    const fails = (subset: readonly number[]): boolean => subset.includes(3) && subset.includes(8);
    const { items: minimal, tests } = minimiseList(items, fails);
    expect(minimal).toEqual([0, 3, 8]);
    expect(tests).toBeLessThan(40);
    expect(minimiseList(items, (subset) => subset[0] === 0).items).toEqual([0]);
    expect(minimiseList([], () => true).items).toEqual([]);
  });

  it('reduces a failing fuzz case to the base plus the culprit step', () => {
    const steps = generateFuzzCase(3, { kinds: [...MESH_KINDS] }).steps;
    const culprit = badHole();
    const broken = { seed: 3, steps: [...steps.slice(0, 2), culprit, ...steps.slice(2)] };
    const minimised = minimiseFuzzCase(broken);
    expect(minimised?.steps).toEqual([steps[0], culprit]);
    expect(minimised?.failure).toMatchObject({ step: 1, check: 'command_failed' });
    expect(minimiseFuzzCase({ seed: 3, steps })).toBeNull();
  });
});
