/** The resolve memo (07 MSH TECHNICAL_SPEC 13.9): keyed by object identity, never keeps a run that saw a deferred engine answer, bounded, dropped on dispose. */

import { describe, expect, it } from 'vitest';
import { createResolveMemo } from '@core/commands/resolveMemo';
import { deferMeshOp } from '@core/geometry/mesh/engine';

describe('ResolveMemo.once', () => {
  it('computes a value once per (owner, tag) and serves it afterwards, by identity of the owner', () => {
    const memo = createResolveMemo();
    const owner = {};
    let computed = 0;
    const compute = (): number[] => [++computed];
    expect(memo.once(owner, 'a', compute)).toBe(memo.once(owner, 'a', compute));
    expect(computed).toBe(1);
    memo.once(owner, 'b', compute);
    memo.once({}, 'a', compute);
    expect(computed).toBe(3);
    expect(memo.size).toBe(3);
  });

  it('keeps a null and an undefined result like any other value', () => {
    const memo = createResolveMemo();
    const owner = {};
    let computed = 0;
    const nothing = (): null => (computed++, null);
    expect(memo.once(owner, 'null', nothing)).toBeNull();
    expect(memo.once(owner, 'null', nothing)).toBeNull();
    expect(computed).toBe(1);
  });

  it('does not keep a throw', () => {
    const memo = createResolveMemo();
    const owner = {};
    expect(() =>
      memo.once(owner, 'boom', () => {
        throw new Error('boom');
      }),
    ).toThrow('boom');
    expect(memo.size).toBe(0);
    expect(memo.once(owner, 'boom', () => 7)).toBe(7);
  });

  it('allows a computation to use the memo for the same owner itself', () => {
    const memo = createResolveMemo();
    const owner = {};
    const outer = memo.once(owner, 'outer', () => memo.once(owner, 'inner', () => 1) + 1);
    expect(outer).toBe(2);
    expect(memo.once(owner, 'inner', () => 99)).toBe(1);
    expect(memo.size).toBe(2);
  });
});

describe('ResolveMemo and deferred engine answers', () => {
  it('keeps what a run computed before the first deferral and nothing from then on, and keeps again in the next run', () => {
    const memo = createResolveMemo();
    const [first, second, third] = [{}, {}, {}];
    memo.beginRun();
    memo.once(first, 'step', () => 'before');
    memo.once(second, 'step', () => (deferMeshOp('quad_remesh'), 'the step that deferred'));
    memo.once(third, 'step', () => 'after, on a placeholder');
    expect(memo.size).toBe(1);
    memo.beginRun();
    expect(memo.once(first, 'step', () => 'again')).toBe('before');
    expect(memo.once(second, 'step', () => 'now with the result')).toBe('now with the result');
    expect(memo.size).toBe(2);
  });
});

describe('ResolveMemo bounds', () => {
  it('stops keeping at the entry limit and keeps the earliest entries (the prefix the next run reads first)', () => {
    const memo = createResolveMemo({ maxEntries: 3 });
    const owners = Array.from({ length: 5 }, () => ({}));
    owners.forEach((owner, i) => memo.once(owner, 'step', () => i));
    expect(memo.size).toBe(3);
    expect(owners.map((owner) => memo.once(owner, 'step', () => -1))).toEqual([0, 1, 2, -1, -1]);
  });

  it('stops keeping at the weight limit; a value heavier than the whole budget is never kept; weight may depend on the value', () => {
    const memo = createResolveMemo({ maxWeight: 10 });
    const [a, b, c, d] = [{}, {}, {}, {}];
    memo.once(
      a,
      'm',
      () => [1, 2, 3, 4, 5, 6],
      (value) => value.length,
    );
    expect(memo.weight).toBe(6);
    memo.once(
      b,
      'm',
      () => [1, 2, 3, 4, 5],
      (value) => value.length,
    );
    expect(memo.size).toBe(1);
    memo.once(c, 'm', () => 'x', 4);
    expect(memo.weight).toBe(10);
    memo.once(d, 'm', () => 'y', 11);
    expect(memo.size).toBe(2);
  });
});

describe('ResolveMemo.dispose', () => {
  it('drops every entry and keeps nothing afterwards', () => {
    const memo = createResolveMemo();
    const owner = {};
    memo.once(owner, 'a', () => 1, 5);
    memo.dispose();
    expect(memo.size).toBe(0);
    expect(memo.weight).toBe(0);
    expect(memo.once(owner, 'a', () => 2)).toBe(2);
    expect(memo.size).toBe(0);
  });
});
