/**
 * STA-FU: a guard-rail along the whole shared boundary of two touching surfaces cuts the access graph. Deck A (0..3000 x 0..2000) and deck B (3000..6000 x 0..2000) at +3000;
 * a steel stair from grade arrives on A. The boundary is x = 3000, 2000 mm long.
 */

import { describe, expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import { createEmptyDocument, type CadDocument } from '@core/model/types';
import { apply, data } from '../../../helpers/commandAssertions';
import { expectPure } from '../../../helpers/expectNoOp';
import { rect } from './accessFixtures';

interface Graph {
  surfaces: Array<{ id: string; connected: boolean; route: string[] | null }>;
}

function decks(): { doc: CadDocument; upper: string } {
  let doc = apply(apply(createEmptyDocument(), 'set_units', { units: 'mm' }), 'add_level', { name: 'Grade', elevation: 0, height: 3000 });
  doc = apply(doc, 'add_level', { name: '+3000', elevation: 3000, height: 3000 });
  const [grade, upper] = Object.keys(doc.building?.levels ?? {}) as [string, string];
  doc = apply(doc, 'add_slab', { boundary: rect(0, 0, 3000, 2000), thickness: 30, levelId: upper });
  doc = apply(doc, 'add_slab', { boundary: rect(3000, 0, 6000, 2000), thickness: 30, levelId: upper });
  doc = apply(doc, 'add_steel_stair', {
    start: [-4480, 1000, 0],
    angle: 0,
    toSurfaceId: 'slab-1',
    riserMax: 180,
    going: 280,
    levelId: grade,
  });
  return { doc, upper };
}
const graph = (doc: CadDocument): Graph => data<Graph>(doc, 'access_graph', {});
const connectedB = (doc: CadDocument): boolean => graph(doc).surfaces.find((surface) => surface.id === 'slab-2')?.connected ?? false;
const rail = (doc: CadDocument, upper: string, extra: Record<string, unknown> = {}): CadDocument =>
  apply(doc, 'add_railing', {
    path: [
      [3000, 0, 0],
      [3000, 2000, 0],
    ],
    levelId: upper,
    ...extra,
  });

describe('guard-rails as barriers between touching surfaces', () => {
  const { doc, upper } = decks();

  it('without a railing the touching deck B is reached through deck A', () => {
    expect(graph(doc).surfaces.map((surface) => surface.id)).toEqual(['slab-1', 'slab-2']);
    expect(connectedB(doc)).toBe(true);
    expect(graph(doc).surfaces[1]?.route).toEqual(['grade', 'steelStair-1', 'slab-1', 'slab-2']);
  });

  it('a guard-rail along the whole boundary cuts it: deck B has no route', () => {
    const closed = rail(doc, upper);
    expect(Object.values(closed.building?.elements ?? {}).filter((element) => element.category === 'railing')).toHaveLength(1);
    expect(connectedB(closed)).toBe(false);
    expect(graph(closed).surfaces.find((surface) => surface.id === 'slab-1')?.connected).toBe(true);
  });

  it('check_reachability sees it: an operating point over deck B is STA_ACCESS_NO_EGRESS', () => {
    const closed = rail(doc, upper);
    const answer = data<{ targets: Array<{ findings: Array<{ code: string }> }> }>(closed, 'check_reachability', {
      targets: [{ tag: 'HV-1', kind: 'valve_handwheel', point: [4500, 1000, 4000] }],
      operatingHeightMm: { min: 0, max: 1800, source: 'test' },
      maxHorizontalReachMm: 100,
    });
    expect(answer.targets[0]?.findings.map((finding) => finding.code)).toContain('STA_ACCESS_NO_EGRESS');
  });

  it('a gap or a gate keeps the decks connected; a hand-rail and a rail on only half the boundary are no barrier', () => {
    const gapped = rail(doc, upper, { openings: [{ from: 800, to: 1400, gate: false }] });
    expect(connectedB(gapped)).toBe(true);
    const gated = rail(doc, upper, { openings: [{ from: 800, to: 1400, gate: true }] });
    expect(connectedB(gated)).toBe(true);
    expect(connectedB(rail(doc, upper, { role: 'handrail', height: 1000 }))).toBe(true);
    const half = apply(doc, 'add_railing', {
      path: [
        [3000, 0, 0],
        [3000, 1000, 0],
      ],
      levelId: upper,
    });
    expect(connectedB(half)).toBe(true);
  });

  it('a railing at the height of another level does not cut a surface it does not stand on', () => {
    const wrongLevel = apply(doc, 'add_railing', {
      path: [
        [3000, 0, 0],
        [3000, 2000, 0],
      ],
      levelId: Object.keys(doc.building?.levels ?? {})[0],
    });
    expect(connectedB(wrongLevel)).toBe(true);
  });

  it('is read-only and pure', () => {
    const closed = rail(doc, upper);
    expectPure(closed, () => execute(closed, 'access_graph', {}));
  });
});
