/** check_clashes: the parts of a circular platform are attached to the vessel that hosts it; unrelated steel through the vessel still clashes. */

import { describe, expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import { createEmptyDocument, type CadDocument } from '@core/model/types';

interface Clash {
  readonly a: string;
  readonly b: string;
  readonly kind: string;
}

function vesselWithRing(): { doc: CadDocument; vesselId: string } {
  let doc = execute(createEmptyDocument(), 'add_level', { name: 'Grade', elevation: 0, height: 7000 }).document;
  const vessel = execute(doc, 'add_equipment', {
    name: 'Column',
    mark: 'C-101',
    location: [0, 0],
    size: [3000, 3000, 18000],
    shape: 'vertical_vessel',
  });
  const vesselId = vessel.affected[0] ?? '';
  doc = execute(vessel.document, 'add_circular_access_platform', {
    equipmentId: vesselId,
    elevation: 6000,
    sweepDeg: 360,
    gap: 100,
    width: 1000,
    railing: { edges: ['outer'] },
  }).document;
  return { doc, vesselId };
}

const clashesOf = (doc: CadDocument): Clash[] => (execute(doc, 'check_clashes', {}).data as { clashes: Clash[] }).clashes;

describe('check_clashes with a circular platform', () => {
  it('reports no clash and no clearance violation between the platform parts and their host vessel', () => {
    const { doc, vesselId } = vesselWithRing();
    expect(clashesOf(doc).filter((clash) => clash.a === vesselId || clash.b === vesselId)).toEqual([]);
  });

  it('still reports a steel member that is not part of the platform and crosses the vessel', () => {
    const { doc, vesselId } = vesselWithRing();
    const beam = execute(doc, 'add_steel_member', { role: 'beam', start: [-3000, 0, 3000], end: [3000, 0, 3000], profile: 'IPE200' });
    const hits = clashesOf(beam.document).filter((clash) => clash.a === vesselId || clash.b === vesselId);
    expect(hits).toHaveLength(1);
    expect(hits[0]?.kind).toBe('hard');
    expect([hits[0]?.a, hits[0]?.b]).toContain(beam.affected[0]);
  });
});
