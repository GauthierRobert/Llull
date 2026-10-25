/**
 * Plant 06 STA M2 (review fixes): a support line must carry the whole panel width, end-to-end members share one support side, a clear span
 * can collapse, the convexity test rejects a pentagram. Frames are built member by member: IPE200 (top of steel at -32 mm, the grating
 * underside at -31.75 mm) running along y at the given x.
 */

import { describe, expect, it } from 'vitest';
import { createEmptyDocument, type CadDocument } from '@core/model/types';
import { isConvex, uncoveredStretch } from '@aec/plant/structures/grating/gratingSupports';
import { apply, data, expectRefusal, ok } from '../../../helpers/commandAssertions';
import { TYPE } from './accessFixtures';

const base = (): CadDocument =>
  apply(apply(createEmptyDocument(), 'set_units', { units: 'mm' }), 'add_level', { name: 'Grade', elevation: 0, height: 4000 });

/** Adds beams along y: [x, y0, y1]. Returns the document and the member ids in order. */
function framed(beams: ReadonlyArray<readonly [number, number, number]>): { doc: CadDocument; ids: string[] } {
  let doc = base();
  const ids: string[] = [];
  for (const [x, y0, y1] of beams) {
    const added = ok(doc, 'add_steel_member', { profile: 'IPE200', role: 'beam', start: [x, y0, -132], end: [x, y1, -132] });
    doc = added.document;
    ids.push(added.affected[0] as string);
  }
  return { doc, ids };
}

const grating = (extra: Record<string, unknown>): Record<string, unknown> => ({
  supportedBy: 'beams',
  gratingType: TYPE,
  bearingBarDirection: [1, 0],
  ...extra,
});

interface Check {
  panels: Array<{ findings: Array<{ code: string; ruleId: string; source: string }>; spanMm?: number; verdict: string }>;
}
const check = (doc: CadDocument, params: Record<string, unknown> = {}): Check =>
  data<Check>(doc, 'check_grating', { uniformLoadKPa: 1, deflectionLimitMm: 10, ...params });

describe('support lines carry the panel width', () => {
  it('refuses a beam that covers only a third of the panel width, naming the unsupported stretch', () => {
    const { doc } = framed([
      [0, 0, 3000],
      [1000, 0, 1000],
    ]);
    const refused = expectRefusal(
      doc,
      'add_grating',
      grating({
        bounds: [
          [0, 0],
          [1000, 3000],
        ],
      }),
      'STA_NO_SUPPORT_FOUND',
      'supportedBy',
    );
    expect(refused.summary).toMatch(/leaves 1000\.\.3000 mm across the bars unsupported/);
  });

  it('accepts two end-to-end beams on one line as one support side and stores both', () => {
    const { doc, ids } = framed([
      [0, 0, 3000],
      [1000, 0, 1500],
      [1000, 1500, 3000],
    ]);
    const result = ok(
      doc,
      'add_grating',
      grating({
        bounds: [
          [0, 0],
          [1000, 3000],
        ],
      }),
    );
    const element = result.document.building?.elements['grating-1'];
    expect(element?.category === 'grating' && element.supportIds).toEqual([[ids[0]], [ids[1], ids[2]]]);
    expect(check(result.document).panels[0]?.verdict).toBe('pass');
  });

  it('finds the second beam of a line deleted or moved away', () => {
    const { doc, ids } = framed([
      [0, 0, 3000],
      [1000, 0, 1500],
      [1000, 1500, 3000],
    ]);
    const grated = apply(
      doc,
      'add_grating',
      grating({
        bounds: [
          [0, 0],
          [1000, 3000],
        ],
      }),
    );
    const deleted = apply(grated, 'delete_building_element', { elementIds: [ids[2]] });
    expect(check(deleted).panels[0]?.findings.map((finding) => finding.code)).toEqual(['STA_NO_SUPPORT_FOUND']);
    const shortened = apply(grated, 'update_steel_member', { memberId: ids[2], start: [1000, 2200, -132], end: [1000, 3000, -132] });
    const finding = check(shortened).panels[0]?.findings[0];
    expect(finding?.code).toBe('STA_NO_SUPPORT_FOUND');
    expect(finding?.source).toContain('NAAMM');
    const survived = check(grated).panels[0];
    expect(survived?.verdict).toBe('pass');
  });

  it('ignores a beam on the same line that lies outside the region across the bars', () => {
    const { doc } = framed([
      [0, 0, 3000],
      [1000, 0, 3000],
      [500, 5000, 6000],
    ]);
    const result = ok(
      doc,
      'add_grating',
      grating({
        bounds: [
          [0, 0],
          [1000, 3000],
        ],
      }),
    );
    expect((result.data as { panels: unknown[] }).panels).toHaveLength(1);
  });

  it('reports a covering gap helper result', () => {
    const line = (pMin: number, pMax: number): Parameters<typeof uncoveredStretch>[0][number] => ({
      id: 'm',
      sMm: 0,
      pMin,
      pMax,
      halfWidthMm: 50,
      topMm: 0,
      parallelism: 0,
    });
    expect(uncoveredStretch([line(0, 1500), line(1500, 3000)], 0, 3000)).toBeNull();
    expect(uncoveredStretch([line(0, 1000), line(1600, 3000)], 0, 3000)).toEqual([1000, 1600]);
    expect(uncoveredStretch([line(500, 3000)], 0, 3000)).toEqual([0, 500]);
    expect(uncoveredStretch([line(0, 2000)], 0, 3000)).toEqual([2000, 3000]);
  });
});

describe('check_grating clear span', () => {
  it('gives a finding instead of allowables when the flanges leave no clear span', () => {
    const { doc } = framed([
      [0, 0, 3000],
      [100, 0, 3000],
    ]);
    const grated = apply(
      doc,
      'add_grating',
      grating({
        bounds: [
          [0, 0],
          [100, 3000],
        ],
      }),
    );
    expect(check(grated).panels[0]?.spanMm).toBe(100);
    const clear = check(grated, { spanBasis: 'clear' }).panels[0];
    expect(clear?.verdict).toBe('fail');
    expect(clear?.findings.map((finding) => [finding.code, finding.ruleId])).toEqual([['STA_INVALID_GEOMETRY', 'NAAMM-SPAN']]);
    expect(clear?.spanMm).toBeUndefined();
  });
});

describe('add_grating convexity', () => {
  it('refuses a pentagram (all turns the same way but two revolutions) and keeps a pentagon', () => {
    const vertex = (k: number): number[] => [
      Math.round(3000 * Math.cos(Math.PI / 2 + (2 * Math.PI * k) / 5)),
      Math.round(3000 * Math.sin(Math.PI / 2 + (2 * Math.PI * k) / 5)),
    ];
    const star = [0, 2, 4, 1, 3].map(vertex) as Array<[number, number]>;
    const pentagon = [0, 1, 2, 3, 4].map(vertex) as Array<[number, number]>;
    expect(isConvex(star)).toBe(false);
    expect(isConvex(pentagon)).toBe(true);
    const { doc } = framed([[0, 0, 3000]]);
    expectRefusal(doc, 'add_grating', grating({ boundary: star }), 'STA_INVALID_GEOMETRY', 'boundary');
  });
});
