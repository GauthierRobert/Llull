/**
 * One size law over a tangent chain of shared edges (fillet_faces, TECHNICAL_SPEC 13.27) on scripted edges: the chain is found from the end points and tangents of the shared edges (one path or one loop, every joint tangent),
 * t = 0 is the end nearest startNear (else the end of the lowest-numbered edge), and the law is cut into one sub-law per edge in the edge's own direction, continuous at the joints. The native proof is server/tests/nativeBlendChain.test.ts.
 */

import { describe, expect, it } from 'vitest';
import { chainLaws, planChain, type ChainPlan } from '@core/commands/brep/faceBlendChain';
import type { BlendContext } from '@core/commands/brep/faceBlendRun';
import type { Vec3 } from '@core/model/types';

interface Scripted {
  readonly from: Vec3;
  readonly to: Vec3;
  readonly length: number;
  /** Unit tangent at the start; at the end it is `endTangent` (default the same: a straight edge). */
  readonly tangent: Vec3;
  readonly endTangent?: Vec3;
}

/** A context whose edges are the scripted ones (index = position). */
function contextOf(edges: Scripted[]): BlendContext {
  return {
    kernel: {
      faceQuery: {
        edgeSamples: (_shape: unknown, edge: number) => {
          const e = edges[edge];
          return e === undefined
            ? null
            : [
                { t: 0, s: 0, point: e.from, tangent: e.tangent },
                { t: 1, s: e.length, point: e.to, tangent: e.endTangent ?? e.tangent },
              ];
        },
      },
    },
    shape: {},
    topology: { edges: edges.map((e, index) => ({ index, length: e.length })) },
  } as unknown as BlendContext;
}

const X: Vec3 = [1, 0, 0];
const MINUS_X: Vec3 = [-1, 0, 0];
const Y: Vec3 = [0, 1, 0];
/** Three straight edges end to end along x: 0 from 0 to 4, 1 from 4 to 10 and 2 from 10 to 20 (lengths 4, 6, 10). */
const LINE: Scripted[] = [
  { from: [0, 0, 0], to: [4, 0, 0], length: 4, tangent: X },
  { from: [4, 0, 0], to: [10, 0, 0], length: 6, tangent: X },
  { from: [10, 0, 0], to: [20, 0, 0], length: 10, tangent: X },
];

const plan = (value: ReturnType<typeof planChain>): ChainPlan => {
  if ('problem' in value) throw new Error(value.problem);
  return value;
};

describe('planChain', () => {
  it('an open path: the walking order, the arc fractions and the direction of each edge; t = 0 at the end of the lowest edge by default', () => {
    const found = plan(planChain(contextOf(LINE), [2, 0, 1], undefined, 'radiusEnd'));
    expect(found.closed).toBe(false);
    expect(found.total).toBe(20);
    expect(found.edges.map((e) => [e.index, e.forward])).toEqual([
      [0, true],
      [1, true],
      [2, true],
    ]);
    expect(found.edges.map((e) => [e.from, e.to])).toEqual([
      [0, 0.2],
      [0.2, 0.5],
      [0.5, 1],
    ]);
  });

  it('startNear picks the end that starts the law: the walk is reversed and every edge is walked from its end', () => {
    const found = plan(planChain(contextOf(LINE), [0, 1, 2], [19, 1, 0], 'radiusEnd'));
    expect(found.edges.map((e) => [e.index, e.forward])).toEqual([
      [2, false],
      [1, false],
      [0, false],
    ]);
    expect(found.edges.map((e) => [Number(e.from.toFixed(6)), Number(e.to.toFixed(6))])).toEqual([
      [0, 0.5],
      [0.5, 0.8],
      [0.8, 1],
    ]);
  });

  it('an edge stored backwards joins the chain: the shared vertex is found from either of its ends', () => {
    const backwards: Scripted[] = [
      LINE[0] as Scripted,
      { from: [10, 0, 0], to: [4, 0, 0], length: 6, tangent: MINUS_X },
      LINE[2] as Scripted,
    ];
    const found = plan(planChain(contextOf(backwards), [0, 1, 2], undefined, 'law'));
    expect(found.edges.map((e) => [e.index, e.forward])).toEqual([
      [0, true],
      [1, false],
      [2, true],
    ]);
  });

  it('a closed loop starts at the start of the lowest edge and has no start end to pick', () => {
    // two edges end to end that close on each other: 0 from a to b, 1 from b back to a (a thin loop)
    const loop: Scripted[] = [
      { from: [0, 0, 0], to: [4, 0, 0], length: 4, tangent: X, endTangent: X },
      { from: [4, 0, 0], to: [0, 0, 0], length: 4, tangent: X, endTangent: X },
    ];
    const found = plan(planChain(contextOf(loop), [1, 0], undefined, 'radiusEnd'));
    expect(found.closed).toBe(true);
    expect(found.edges[0]).toMatchObject({ index: 0, forward: true, from: 0 });
    const lone = planChain(contextOf(loop), [0, 1], [1, 0, 0], 'radiusEnd');
    expect('problem' in lone && lone.path).toBe('startNear');
  });

  it('refused with the param it is about: a bend at a joint, a branch, two pieces, a closed edge, an edge the kernel cannot sample', () => {
    const bent: Scripted[] = [LINE[0] as Scripted, { from: [4, 0, 0], to: [4, 6, 0], length: 6, tangent: Y }];
    const refused = planChain(contextOf(bent), [0, 1], undefined, 'law');
    expect('problem' in refused && refused.problem).toContain('not one tangent chain');
    expect('problem' in refused && refused.path).toBe('law');
    const branched = planChain(
      contextOf([LINE[0] as Scripted, LINE[1] as Scripted, { from: [4, 0, 0], to: [4, 0, 5], length: 5, tangent: Y }]),
      [0, 1, 2],
      undefined,
      'radiusEnd',
    );
    expect('problem' in branched && branched.problem).toContain('more than two');
    const apart: Scripted[] = [LINE[0] as Scripted, LINE[2] as Scripted];
    const separate = planChain(contextOf(apart), [0, 1], undefined, 'radiusEnd');
    expect('problem' in separate && separate.problem).toContain('2 separate pieces');
    const ring: Scripted[] = [{ from: [0, 0, 0], to: [0, 0, 0], length: 6, tangent: X, endTangent: X }, LINE[1] as Scripted];
    const closedEdge = planChain(contextOf(ring), [0, 1], undefined, 'radiusEnd');
    expect('problem' in closedEdge && closedEdge.problem).toContain('closed');
    const blind = { ...contextOf(LINE), kernel: { faceQuery: { edgeSamples: () => null } } } as unknown as BlendContext;
    const unsampled = planChain(blind, [0, 1], undefined, 'radiusEnd');
    expect('problem' in unsampled && unsampled.problem).toContain('cannot sample');
  });
});

describe('chainLaws', () => {
  const found = plan(planChain(contextOf(LINE), [0, 1, 2], undefined, 'radiusEnd'));

  it('a straight law 1 -> 3 is cut at the joints: each edge gets the straight piece between the values at its ends, in its own direction', () => {
    const laws = chainLaws(found, { start: 1, end: 3, law: undefined }, 'radiusEnd');
    expect(Array.isArray(laws) && laws).toEqual([
      { index: 0, size: 1, sizeEnd: 1.4, interpolation: 'linear' },
      { index: 1, size: 1.4, sizeEnd: 2, interpolation: 'linear' },
      { index: 2, size: 2, sizeEnd: 3, interpolation: 'linear' },
    ]);
    const reversed = plan(planChain(contextOf(LINE), [0, 1, 2], [19, 1, 0], 'radiusEnd'));
    const backwards = chainLaws(reversed, { start: 1, end: 3, law: undefined }, 'radiusEnd');
    // walked from x = 20: edge 2 (own direction 10 -> 20) runs from 3 at its end to 2 at its start
    expect(Array.isArray(backwards) && backwards.map((entry) => [entry.index, entry.size, entry.sizeEnd])).toEqual([
      [2, 2, 1],
      [1, 2.6, 2],
      [0, 3, 2.6],
    ]);
  });

  it('an expression law is sampled at the arc fractions of each edge (33 stations by default, straight pieces), equal at every joint', () => {
    const laws = chainLaws(found, { start: 1, end: undefined, law: { expression: '1 + 2*t' } }, 'law');
    if (!Array.isArray(laws)) throw new Error(laws.message);
    expect(laws).toHaveLength(3);
    for (const entry of laws) {
      expect(entry.interpolation).toBe('linear');
      expect(entry.sizes).toHaveLength(31);
    }
    expect(laws[0]?.size).toBeCloseTo(1, 12);
    expect(laws[0]?.sizeEnd).toBeCloseTo(laws[1]?.size as number, 12);
    expect(laws[1]?.sizeEnd).toBeCloseTo(laws[2]?.size as number, 12);
    expect(laws[2]?.sizeEnd).toBeCloseTo(3, 12);
    expect(laws[1]?.sizes?.[14]?.size).toBeCloseTo(1 + 2 * (0.2 + 0.3 * (15 / 32)), 12);
  });

  it('the law must hold over the chain: a loop needs a law that closes, an expression must be > 0 at every station and be an expression of t', () => {
    const loop = plan(
      planChain(
        contextOf([
          { from: [0, 0, 0], to: [4, 0, 0], length: 4, tangent: X, endTangent: X },
          { from: [4, 0, 0], to: [0, 0, 0], length: 4, tangent: X, endTangent: X },
        ]),
        [0, 1],
        undefined,
        'radiusEnd',
      ),
    );
    const open = chainLaws(loop, { start: 1, end: 2, law: undefined }, 'radiusEnd');
    expect(!Array.isArray(open) && open.code).toBe('BLD_LAW_NOT_PERIODIC');
    expect(Array.isArray(chainLaws(loop, { start: 1, end: 1, law: undefined }, 'radiusEnd'))).toBe(true);
    const notClosing = chainLaws(loop, { start: 1, end: undefined, law: { expression: '1 + t' } }, 'law');
    expect(!Array.isArray(notClosing) && [notClosing.code, notClosing.path]).toEqual(['BLD_LAW_NOT_PERIODIC', 'law.expression']);
    expect(Array.isArray(chainLaws(loop, { start: 1, end: undefined, law: { expression: '1 + 0.5*cos(2*pi*t)' } }, 'law'))).toBe(true);
    const negative = chainLaws(found, { start: 1, end: undefined, law: { expression: '0.5 - t' } }, 'law');
    expect(!Array.isArray(negative) && [negative.code, negative.path]).toEqual(['BLD_LAW_INVALID', 'law.expression']);
    const zero = chainLaws(found, { start: 1, end: 0, law: undefined }, 'radiusEnd');
    expect(!Array.isArray(zero) && zero.code).toBe('BLD_LAW_INVALID');
    const unknown = chainLaws(found, { start: 1, end: undefined, law: { expression: 'nonsense(t)' } }, 'law');
    expect(!Array.isArray(unknown) && unknown.code).toBe('BLD_LAW_INVALID');
  });
});
