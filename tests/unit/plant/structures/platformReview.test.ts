/**
 * Plant 06 STA M6 review fixes: copying a level with a platform, a circular platform following its moved vessel, STA_PLATFORM_STALE in check_access,
 * edge sampling along the whole edge, the shell closing rule (vessel base), and the guard escape (generation).
 */

import { describe, expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import { createEmptyDocument, type CadDocument } from '@core/model/types';
import { buildingErrors } from '@aec/building/validate';
import { platformAssemblyGuard } from '@aec/plant/structures/platform/platformGuard';
import { apply, data, expectRefusal, ok } from '../../../helpers/commandAssertions';
import { TYPE, rect } from './accessFixtures';

const mmDoc = (): CadDocument => apply(createEmptyDocument(), 'set_units', { units: 'mm' });
const DECK = {
  bounds: [
    [0, 0],
    [3000, 2000],
  ],
  gratingType: TYPE,
  bearingBarDirection: [1, 0],
  railing: {},
};

interface Level {
  doc: CadDocument;
  grade: string;
  upper: string;
}
function twoLevels(): Level {
  let doc = apply(mmDoc(), 'add_level', { name: 'Grade', elevation: 0, height: 4000 });
  const grade = Object.keys(doc.building?.levels ?? {})[0] as string;
  doc = apply(doc, 'add_level', { name: '+4000', elevation: 4000, height: 3000 });
  const upper = Object.keys(doc.building?.levels ?? {}).find((id) => id !== grade) as string;
  return { doc, grade, upper };
}

describe('copy_level_elements and a platform', () => {
  const { doc, grade, upper } = twoLevels();
  const withDeck = apply(doc, 'add_access_platform', { ...DECK, levelId: grade });

  it('only generated parts on the level: nothing to copy, nothing changes', () => {
    const result = execute(withDeck, 'copy_level_elements', { sourceLevelId: grade, targetLevelIds: [upper] });
    expect(result.document).toBe(withDeck);
    expect(result.summary).toContain('generated platform parts');
  });

  it('copies the other elements, skips the platform parts, reports it and the document still validates', () => {
    const mixed = apply(withDeck, 'add_slab', { boundary: rect(10000, 0, 12000, 2000), thickness: 100, levelId: grade });
    const result = ok(mixed, 'copy_level_elements', { sourceLevelId: grade, targetLevelIds: [upper] });
    expect(result.summary).toContain('Skipped 4 generated platform part(s)');
    expect(buildingErrors(result.document.building)).toEqual([]);
    const platformParts = Object.values(result.document.building?.elements ?? {}).filter(
      (element) => 'assemblyId' in element && element.assemblyId !== undefined,
    );
    expect(platformParts.every((part) => part.levelId === grade)).toBe(true);
    // deleting the platform on the source level leaves the copied slab alone
    const removed = apply(result.document, 'delete_building_element', { elementIds: ['assembly-1'] });
    expect(Object.keys(removed.building?.elements ?? {}).sort()).toEqual(['slab-1', 'slab-2']);
  });

  it('move_building_element and delete_level keep the document valid', () => {
    expect(buildingErrors(withDeck.building)).toEqual([]);
    const moved = execute(withDeck, 'move_building_element', { elementIds: ['grating-1'], delta: [10, 0] });
    expect(moved.document).toBe(withDeck);
    const deleted = execute(withDeck, 'delete_level', { levelId: grade });
    expect(buildingErrors(deleted.document.building)).toEqual([]);
  });
});

const vesselDoc = (): CadDocument => {
  let doc = apply(mmDoc(), 'add_level', { name: 'Grade', elevation: 0, height: 6000 });
  doc = apply(doc, 'add_equipment', { name: 'Column', location: [0, 0], size: [3000, 3000, 18000], shape: 'vertical_vessel' });
  return apply(doc, 'add_circular_access_platform', {
    equipmentId: 'equipment-1',
    elevation: 6000,
    width: 1000,
    gap: 150,
    sweepDeg: 180,
    railing: {},
  });
};

describe('a circular platform follows a moved vessel', () => {
  const built = vesselDoc();

  it('move_building_element of the vessel re-derives the platform in the same result, ids and marks kept', () => {
    const result = ok(built, 'move_building_element', { elementIds: ['equipment-1'], delta: [1000, 500] });
    const bracket = result.document.building?.elements['member-1'];
    expect(bracket?.category === 'member' && bracket.start.slice(0, 2)).toEqual([2500, 500]);
    expect(bracket?.category === 'member' && bracket.mark).toBe('BK1');
    const assembly = result.document.building?.elements['assembly-1'];
    expect(assembly?.category === 'assembly' && assembly.generation).toBe(2);
    expect(Object.keys(result.document.building?.elements ?? {})).toEqual(Object.keys(built.building?.elements ?? {}));
    expect(result.affected).toContain('assembly-1');
    const takeoff = data<{ platforms: Array<{ stale: boolean }> }>(result.document, 'access_platform_takeoff', {});
    expect(takeoff.platforms[0]?.stale).toBe(false);
    expect(buildingErrors(result.document.building)).toEqual([]);
  });

  it('refuses the move when the platform cannot follow (stored parameters unreadable), leaving the document unchanged', () => {
    const broken = JSON.parse(JSON.stringify(built)) as CadDocument;
    (broken.building?.elements['assembly-1'] as { params: Record<string, unknown> }).params = { kind: 'circular_platform' };
    const result = execute(broken, 'move_building_element', { elementIds: ['equipment-1'], delta: [1, 1] });
    expect(result.document).toBe(broken);
    expect(result.summary).toContain('no longer parse');
  });
});

describe('check_access reports a stale platform (STA_PLATFORM_STALE)', () => {
  const built = vesselDoc();
  const codes = (doc: CadDocument, ids?: string[]): string[] =>
    data<{ findings: Array<{ code: string }> }>(doc, 'check_access', {
      rulesets: ['iso_14122'],
      edgeDropThresholdMm: 500,
      ...(ids === undefined ? {} : { ids }),
    }).findings.map((finding) => finding.code);

  it('is green while current, fails once the vessel is edited, and is green again after update_access_platform', () => {
    expect(codes(built, ['assembly-1'])).toEqual([]);
    const wider = apply(built, 'update_equipment', { elementId: 'equipment-1', size: [3600, 3600, 18000] });
    expect(codes(wider, ['assembly-1'])).toContain('STA_PLATFORM_STALE');
    expect(codes(wider)).toContain('STA_PLATFORM_STALE');
    expect(codes(wider, ['equipment-1'])).not.toContain('STA_PLATFORM_STALE');
    const stale = data<{
      verdict: string;
      byId: Record<string, { verdict: string }>;
      findings: Array<{ remediation: string; source: string }>;
    }>(wider, 'check_access', { rulesets: ['iso_14122'], ids: ['assembly-1'] });
    expect(stale.verdict).toBe('fail');
    expect(stale.byId['assembly-1']?.verdict).toBe('fail');
    expect(stale.findings[0]?.remediation).toContain('update_access_platform');
    expect(stale.findings[0]?.source).toContain('vessel');
    const fresh = apply(wider, 'update_access_platform', { assemblyId: 'assembly-1' });
    expect(codes(fresh, ['assembly-1'])).toEqual([]);
  });

  it('also fails when the vessel can no longer carry the platform (derivation refused)', () => {
    const short = apply(built, 'update_equipment', { elementId: 'equipment-1', size: [3000, 3000, 5000] });
    expect(codes(short, ['assembly-1'])).toContain('STA_PLATFORM_STALE');
  });
});

describe('open-edge drop is sampled along the whole edge', () => {
  it('flags a gap of 20..40 % of an edge that a neighbouring slab leaves open (3 samples would miss it)', () => {
    const { doc, upper } = twoLevels();
    let model = apply(doc, 'add_slab', { boundary: rect(0, 0, 5000, 3000), thickness: 100, levelId: upper });
    model = apply(model, 'add_slab', { boundary: rect(0, -2000, 1000, 0), thickness: 100, levelId: upper });
    model = apply(model, 'add_slab', { boundary: rect(2000, -2000, 5000, 0), thickness: 100, levelId: upper });
    const checked = data<{ findings: Array<{ code: string; ids: string[]; location?: string }> }>(model, 'check_access', {
      rulesets: ['iso_14122'],
      edgeDropThresholdMm: 500,
      ids: ['slab-1'],
    });
    const south = checked.findings.filter((finding) => finding.code === 'STA_EDGE_UNPROTECTED' && finding.location === 'boundary edge 0');
    expect(south).toHaveLength(1);
  });

  it('a neighbour that covers the whole edge leaves it protected', () => {
    const { doc, upper } = twoLevels();
    let model = apply(doc, 'add_slab', { boundary: rect(0, 0, 5000, 3000), thickness: 100, levelId: upper });
    model = apply(model, 'add_slab', { boundary: rect(0, -2000, 5000, 0), thickness: 100, levelId: upper });
    const checked = data<{ findings: Array<{ location?: string }> }>(model, 'check_access', {
      rulesets: ['iso_14122'],
      edgeDropThresholdMm: 500,
      ids: ['slab-1'],
    });
    expect(checked.findings.filter((finding) => finding.location === 'boundary edge 0')).toEqual([]);
  });
});

describe('a vessel shell closes an edge only when it stands at the surface', () => {
  const edgeFindings = (vesselElevation: number): string[] => {
    let doc = apply(mmDoc(), 'add_level', { name: 'Grade', elevation: 0, height: 3000 });
    doc = apply(doc, 'add_level', { name: 'Vessel base', elevation: vesselElevation, height: 6000 });
    const levels = Object.keys(doc.building?.levels ?? {});
    doc = apply(doc, 'add_equipment', {
      name: 'Column',
      location: [0, 0],
      size: [3000, 3000, 8000],
      shape: 'vertical_vessel',
      levelId: levels[1],
    });
    doc = apply(doc, 'add_slab', { boundary: rect(1650, -1000, 4000, 1000), thickness: 100, offset: 3000, levelId: levels[0] });
    return data<{ findings: Array<{ code: string; location?: string }> }>(doc, 'check_access', {
      rulesets: ['iso_14122'],
      edgeDropThresholdMm: 500,
      ids: ['slab-1'],
    })
      .findings.filter((finding) => finding.code === 'STA_EDGE_UNPROTECTED' && finding.location === 'boundary edge 3')
      .map((finding) => finding.location as string);
  };

  it('a vessel whose base is at or below the surface closes the 150 mm gap of the edge facing it', () => {
    expect(edgeFindings(0)).toEqual([]);
  });

  it('a vessel whose base is above the surface does not', () => {
    expect(edgeFindings(3500)).toEqual(['boundary edge 3']);
  });
});

describe('platform derivation guard: only a regeneration escapes', () => {
  const built = apply(apply(mmDoc(), 'add_level', { name: 'Grade', elevation: 0, height: 4000 }), 'add_access_platform', DECK);
  const withBuilding = (change: (elements: Record<string, Record<string, unknown>>) => void): CadDocument => {
    const copy = JSON.parse(JSON.stringify(built)) as CadDocument;
    change(copy.building?.elements as unknown as Record<string, Record<string, unknown>>);
    return copy;
  };

  it('refuses an edit of the assembly mark together with an edit of a part in one result', () => {
    const next = withBuilding((elements) => {
      (elements['assembly-1'] as Record<string, unknown>)['mark'] = 'AS9';
      (elements['grating-1'] as Record<string, unknown>)['gratingType'] = '19-W-4 1-1/2x3/16';
    });
    expect(platformAssemblyGuard.check(built, next, 'x')).toContain('grating-1');
  });

  it('refuses a deleted assembly whose parts survive, allows a deleted assembly with its parts', () => {
    const orphaned = withBuilding((elements) => delete elements['assembly-1']);
    expect(platformAssemblyGuard.check(built, orphaned, 'x')).toContain('member-1');
    const gone = withBuilding((elements) => {
      for (const id of Object.keys(elements)) delete elements[id];
    });
    expect(platformAssemblyGuard.check(built, gone, 'x')).toBeNull();
  });

  it('allows a regeneration: generation raised, parts changed', () => {
    const next = withBuilding((elements) => {
      (elements['assembly-1'] as Record<string, unknown>)['generation'] = 2;
      (elements['grating-1'] as Record<string, unknown>)['gratingType'] = '19-W-4 1-1/2x3/16';
    });
    expect(platformAssemblyGuard.check(built, next, 'update_access_platform')).toBeNull();
    expectRefusal(built, 'update_grating', { ids: ['grating-1'], gratingType: '19-W-4 1-1/2x3/16' }, 'CMD_DERIVED_GEOMETRY');
  });
});
