/** check_piping slope rules (02 RTE §5.6, M3): RTE_ADVERSE_SLOPE and RTE_POCKET, graded by the line slope or by the legs that declare one. */

import { describe, expect, it } from 'vitest';
import type { CadDocument } from '@core/model/types';
import { apply, data } from '../../../helpers/commandAssertions';
import { addTie, cs150Line } from './rteFixtures';

interface Issue {
  code: string;
  ids: string[];
  paths: string[];
  detail: Record<string, unknown>;
}
const issues = (doc: CadDocument, code: string): Issue[] =>
  data<{ issues: Issue[] }>(doc, 'check_piping', {}).issues.filter((issue) => issue.code === code);

const FALL = { value: 1, unit: 'percent', fall: true } as const;
const RISE = { value: 1, unit: 'percent', fall: false } as const;

/** DN100 line (optionally with a declared slope) from tie-in A at (0,0,3000) +X, routed by `legs`; returns the document and the run id. */
function route(legs: unknown[], slope?: unknown): { doc: CadDocument; runId: string; lineId: string } {
  const { doc: withLine, lineId } = cs150Line();
  const gravity = slope === undefined ? withLine : withLine;
  const a = addTie(gravity, 'A', [0, 0, 3000], [1, 0, 0]);
  const declared = slope === undefined ? a.doc : apply(a.doc, 'update_pipeline', { lineId, slope });
  const doc = apply(declared, 'route_pipe', { lineId, from: { portId: a.id }, legs });
  return { doc, runId: doc.plant?.piping?.runOrder[0] as string, lineId };
}

describe('RTE_ADVERSE_SLOPE', () => {
  it('a line declared to fall reports each leg that rises along the flow, and not the flat ones', () => {
    const s = route(
      [
        { direction: '+X', length: 2000 },
        { direction: '-Z', length: 1000 },
        { direction: '+X', length: 2000 },
        { direction: '+Z', length: 1000 },
      ],
      FALL,
    );
    const adverse = issues(s.doc, 'RTE_ADVERSE_SLOPE');
    expect(adverse).toHaveLength(1);
    expect(adverse[0]).toMatchObject({
      ids: [s.runId],
      paths: [`runs.${s.runId}.legs.3`],
      detail: { leg: 3, direction: 'rises', source: 'line' },
    });
  });

  it('a leg that declares its own rise overrides the line; one that declares a fall and rises is adverse (edit_route free lift)', () => {
    const rising = route([{ direction: '+X', planLength: 2000, slope: RISE }], FALL);
    expect(issues(rising.doc, 'RTE_ADVERSE_SLOPE')).toEqual([]);
    const drain = route([
      { direction: '+X', planLength: 8000, slope: FALL },
      { direction: '-Z', length: 500 },
    ]);
    expect(issues(drain.doc, 'RTE_ADVERSE_SLOPE')).toEqual([]);
    const lifted = apply(drain.doc, 'edit_route', { runId: drain.runId, op: 'move_pi', index: 0, delta: [0, 0, 200], mode: 'free' });
    expect(issues(lifted, 'RTE_ADVERSE_SLOPE')).toMatchObject([{ detail: { leg: 0, direction: 'rises', source: 'leg' } }]);
  });

  it('a line declared to rise (fall: false) reports the legs that fall', () => {
    const s = route(
      [
        { direction: '+X', length: 1000 },
        { direction: '-Z', length: 1000 },
      ],
      RISE,
    );
    expect(issues(s.doc, 'RTE_ADVERSE_SLOPE')).toMatchObject([{ detail: { leg: 1, direction: 'falls' } }]);
  });

  it('nothing is graded without a declared slope', () => {
    const s = route([
      { direction: '+X', length: 1000 },
      { direction: '+Z', length: 1000 },
    ]);
    expect(issues(s.doc, 'RTE_ADVERSE_SLOPE')).toEqual([]);
    expect(issues(s.doc, 'RTE_POCKET')).toEqual([]);
  });
});

describe('RTE_FLAT_ON_SLOPED_LINE', () => {
  it('a horizontal leg on a line (or leg) that declares a slope is reported once per leg, a vertical one is not', () => {
    const s = route(
      [
        { direction: '+X', length: 2000 },
        { direction: '-Z', length: 1000 },
        { direction: '+X', length: 2000 },
      ],
      FALL,
    );
    const flat = issues(s.doc, 'RTE_FLAT_ON_SLOPED_LINE');
    expect(flat.map((issue) => issue.detail['leg'])).toEqual([0, 2]);
    expect(flat[0]).toMatchObject({ detail: { source: 'line' }, ids: [s.runId] });
    const leg = route([
      { direction: '+X', planLength: 2000, slope: FALL },
      { direction: '-Z', length: 500 },
    ]);
    expect(issues(leg.doc, 'RTE_FLAT_ON_SLOPED_LINE')).toEqual([]);
  });

  it('is a warning and needs a declaration: an undeclared flat run is silent', () => {
    const s = route([{ direction: '+X', length: 2000 }]);
    expect(issues(s.doc, 'RTE_FLAT_ON_SLOPED_LINE')).toEqual([]);
    const declared = route([{ direction: '+X', length: 2000 }], FALL);
    expect(data<{ status: string }>(declared.doc, 'check_piping', {}).status).toBe('warn');
  });
});

describe('RTE_POCKET', () => {
  const LOW = [
    { direction: '+X', length: 2000 },
    { direction: '-Z', length: 1000 },
    { direction: '+X', length: 2000 },
    { direction: '+Z', length: 1000 },
  ];
  const HIGH = [
    { direction: '+X', length: 1000 },
    { direction: '+Z', length: 1000 },
    { direction: '+X', length: 2000 },
    { direction: '-Z', length: 1000 },
  ];

  it('a low point without a drain and a high point without a vent are reported once each, after the leg that ends at it', () => {
    const low = route(LOW, FALL);
    expect(issues(low.doc, 'RTE_POCKET')).toMatchObject([
      { detail: { kind: 'low', needs: 'drain', legs: [1, 3], pi: 1 }, paths: [`runs.${low.runId}.pis.1`] },
    ]);
    const high = route(HIGH, FALL);
    expect(issues(high.doc, 'RTE_POCKET')).toMatchObject([{ detail: { kind: 'high', needs: 'vent', legs: [1, 3] } }]);
  });

  it('a branch leaving downward on the low run is the drain, one leaving upward on the high run is the vent', () => {
    const low = route(LOW, FALL);
    const drained = apply(low.doc, 'add_branch', {
      runId: low.runId,
      at: { leg: 2, distance: 1000 },
      dn: 100,
      legs: [{ direction: '-Z', length: 800 }],
    });
    expect(issues(drained, 'RTE_POCKET')).toEqual([]);
    const sideways = apply(low.doc, 'add_branch', {
      runId: low.runId,
      at: { leg: 2, distance: 1000 },
      dn: 100,
      legs: [{ direction: '+Y', length: 800 }],
    });
    expect(issues(sideways, 'RTE_POCKET')).toHaveLength(1);
    const high = route(HIGH, FALL);
    const vented = apply(high.doc, 'add_branch', {
      runId: high.runId,
      at: { leg: 2, distance: 1000 },
      dn: 100,
      legs: [{ direction: '+Z', length: 800 }],
    });
    expect(issues(vented, 'RTE_POCKET')).toEqual([]);
    const wrongWay = apply(high.doc, 'add_branch', {
      runId: high.runId,
      at: { leg: 2, distance: 1000 },
      dn: 100,
      legs: [{ direction: '-Z', length: 800 }],
    });
    expect(issues(wrongWay, 'RTE_POCKET')).toHaveLength(1);
  });

  it('needs both legs graded: a profile whose only declared leg is the fall is not a pocket', () => {
    const s = route([
      { direction: '+X', planLength: 2000, slope: FALL },
      { direction: '-Z', length: 500 },
      { direction: '+X', length: 1000 },
      { direction: '+Z', length: 600 },
    ]);
    expect(issues(s.doc, 'RTE_POCKET')).toEqual([]);
  });

  it('status is warn, never fail, for slope findings', () => {
    const s = route(LOW, FALL);
    const result = data<{ status: string; counts: { errors: number } }>(s.doc, 'check_piping', {});
    expect(result.counts.errors).toBe(0);
    expect(result.status).toBe('warn');
  });
});
