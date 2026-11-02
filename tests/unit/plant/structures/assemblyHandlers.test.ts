/** The assembly registry (building/assemblyHandlers): hosts follow through the installed handlers; an assembly of an unhandled kind is refused and reported. */

import { describe, expect, it } from 'vitest';
import { createEmptyDocument, type CadDocument } from '@core/model/types';
import type { AssemblyElement, BuildingModel } from '@aec/building/types';
import { assemblyStaleReason, followAssemblyHosts } from '@aec/building/assemblyHandlers';
import { apply } from '../../../helpers/commandAssertions';

const rackDoc = (): CadDocument => {
  let doc = apply(createEmptyDocument(), 'set_units', { units: 'mm' });
  doc = apply(doc, 'add_level', { name: 'Grade', elevation: 0, height: 4000 });
  return apply(doc, 'add_pipe_rack', {
    origin: [0, 0],
    direction: [1, 0],
    length: 6000,
    bentSpacing: 3000,
    width: 3000,
    tiers: [2500],
    columnProfile: 'HEB200',
    tierBeamProfile: 'IPE200',
  });
};
const withAssembly = (doc: CadDocument, change: Record<string, unknown>): BuildingModel => {
  const building = JSON.parse(JSON.stringify(doc.building)) as BuildingModel;
  building.elements['assembly-1'] = { ...(building.elements['assembly-1'] as AssemblyElement), ...change } as AssemblyElement;
  return building;
};

describe('assembly handlers', () => {
  const doc = rackDoc();

  it('re-derives an assembly whose host moved, keeping its part ids', () => {
    const hosted = withAssembly(doc, { hostId: 'level-1' });
    const followed = followAssemblyHosts(doc, hosted, new Set(['level-1']));
    expect(followed.ok).toBe(true);
    if (followed.ok) {
      expect(followed.ids[0]).toBe('assembly-1');
      expect(followed.ids).toHaveLength(14);
      expect((followed.building.elements['assembly-1'] as AssemblyElement).generation).toBe(2);
      expect((followed.building.elements['assembly-1'] as AssemblyElement).partIds).toEqual(
        (hosted.elements['assembly-1'] as AssemblyElement).partIds,
      );
    }
  });

  it('ignores assemblies of other hosts and refuses one whose parameters no longer parse or whose kind nobody handles', () => {
    expect(followAssemblyHosts(doc, withAssembly(doc, { hostId: 'level-1' }), new Set(['other'])).ok).toBe(true);
    const broken = followAssemblyHosts(doc, withAssembly(doc, { hostId: 'level-1', params: {} }), new Set(['level-1']));
    expect(broken.ok ? '' : broken.message).toContain('no longer parse');
    const unhandled = withAssembly(doc, { hostId: 'level-1', kind: 'tower' });
    const refused = followAssemblyHosts(doc, unhandled, new Set(['level-1']));
    expect(refused.ok ? '' : refused.message).toContain('no installed plugin');
    expect(assemblyStaleReason(doc, unhandled, unhandled.elements['assembly-1'] as AssemblyElement)).toContain(
      "no installed plugin handles 'tower'",
    );
  });

  it('a rack that cannot be rebuilt (its level is gone) cannot follow, and is stale', () => {
    const building = JSON.parse(JSON.stringify(doc.building)) as BuildingModel;
    building.levels = {};
    const refused = followAssemblyHosts(doc, withAssembly({ ...doc, building }, { hostId: 'level-1' }), new Set(['level-1']));
    expect(refused.ok ? '' : refused.message).toContain('cannot follow');
    expect(assemblyStaleReason(doc, building, building.elements['assembly-1'] as AssemblyElement)).toContain("unknown level 'level-1'");
  });
});
