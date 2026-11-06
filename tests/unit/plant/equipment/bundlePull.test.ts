/**
 * Plant 03 EQP-FU2: the bundle-pull zone of a removable-bundle exchanger in check_clashes. Hand layout of the BEU of the fixtures (mm, shell front edge at 0
 * before the recentring on the middle of the outside overall length): tubesheet [-50, 0], channel [-350, -50], 2:1 bonnet of an 8 mm wall: outside apex
 * -350 - (150 + 8) = -508; U rear: shell [0, 4827] closed by a shell cover, outside apex 4827 + 158 = 4985; shift = (-508 + 4985) / 2 = 2238.5.
 * The zone starts at the outer tubesheet face -50 - 2238.5 = -2288.5 and runs 4877 + 1000 = 5877 outward: x in [-8165.5, -2288.5], y within +-308 of the
 * location y, z within +-308 of the axis elevation 1000.
 */

import { describe, expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import type { CadDocument } from '@core/model/types';
import { apply, data } from '../../../helpers/commandAssertions';
import { bemParams, mmDocument } from './equipmentFixtures';

const exchanger = (temaType: string, extra: object = {}): CadDocument =>
  apply(mmDocument(), 'add_heat_exchanger', {
    ...bemParams,
    temaType,
    ...(temaType === 'BEM' ? {} : { rearChannel: undefined }),
    clearance: 0,
    location: [0, 8000],
    ...extra,
  });
const skid = (doc: CadDocument, mark: string, x: number, y = 8000, height = 1200): CadDocument =>
  apply(doc, 'add_equipment', { name: mark, mark, location: [x, y], size: [500, 500, height], clearance: 0 });

interface Clash {
  a: string;
  b: string;
  kind: string;
  depth: number;
}
const clashes = (doc: CadDocument): Clash[] => data<{ clashes: Clash[] }>(doc, 'check_clashes', {}).clashes;

describe('check_clashes: tube-bundle pull zone', () => {
  it('a skid in front of the removable bundle (x -5000, inside [-8165.5, -2288.5]) is a clearance clash named by the exchanger; depth = overlap along the best axis', () => {
    const found = clashes(skid(exchanger('BEU'), 'S-1', -5000));
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ a: 'equipment-1', b: 'equipment-2', kind: 'clearance' });
    // the 500 mm skid lies wholly inside the zone along x, y (500 of 616) and z: the separating axis with the least overlap is y or z; 500 + ... > 0
    expect(found[0]?.depth).toBeGreaterThan(0);
  });

  it('the same skid beyond the zone end (x -9000 or behind the rear at +3000), or outside the shell height, is no clash', () => {
    expect(clashes(skid(exchanger('BEU'), 'S-1', -9000))).toEqual([]);
    expect(clashes(skid(exchanger('BEU'), 'S-1', 3000))).toEqual([]);
    expect(clashes(skid(exchanger('BEU'), 'S-1', -5000, 8000, 500))).toEqual([]);
    expect(clashes(skid(exchanger('BEU'), 'S-1', -5000, 9000))).toEqual([]);
  });

  it('the zone reaches 5877 mm out from the tubesheet face: a skid just past the bonnet apex (-2746.5) clashes, one overlapping the far end (-8165.5) clashes, one clear of it does not', () => {
    expect(clashes(skid(exchanger('BEU'), 'S-1', -2746.5 - 300))).toHaveLength(1);
    expect(clashes(skid(exchanger('BEU'), 'S-1', -8165.5 + 200))).toHaveLength(1);
    expect(clashes(skid(exchanger('BEU'), 'S-1', -8165.5 - 300))).toEqual([]);
  });

  it('a fixed-tubesheet exchanger (BEM: the bundle cannot be pulled) has no zone', () => {
    expect(clashes(skid(exchanger('BEM'), 'S-1', -5000))).toEqual([]);
  });

  it('follows the plan rotation: turned 90 degrees counter-clockwise the zone points along -Y', () => {
    const turned = exchanger('BEU', { planRotationDeg: 90, angleConvention: 'east_ccw' });
    expect(clashes(skid(turned, 'S-1', 0, 8000 - 5000))).toHaveLength(1);
    expect(clashes(skid(turned, 'S-1', -5000, 8000))).toEqual([]);
  });

  it('is pure: check_clashes returns the document unchanged', () => {
    const doc = skid(exchanger('BEU'), 'S-1', -5000);
    const result = execute(doc, 'check_clashes', {});
    expect(result.document).toBe(doc);
    expect(result.affected).toEqual([]);
  });
});
