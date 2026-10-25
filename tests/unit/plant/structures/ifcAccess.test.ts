/**
 * Plant 06 STA: IFC export of gratings and railings (VC-STA-12) and of the FL / RD bars. Every enum string written is looked up in the pack's
 * copy of the buildingSMART IFC 4.3 enumerations. Hand numbers: a 4 m guard-rail with 4 posts exports 1 IfcRailing aggregating 4 IfcMember POST;
 * the three SC-STA-06 panels export 3 IfcPlate GRATING.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { CadDocument } from '@core/model/types';
import { apply, data } from '../../../helpers/commandAssertions';
import { gratedFrame } from './accessFixtures';

const ENUMS = path.resolve(__dirname, '../../../../docs/plant/06-plant-structures-access/validation/data/ifc4x3_enums');
const enumItems = (file: string): string[] =>
  [...readFileSync(path.join(ENUMS, file), 'utf8').matchAll(/^### (\w+)$/gm)].map((match) => match[1] as string);

const exported = (doc: CadDocument): string => data<{ ifc: string }>(doc, 'export_ifc', {}).ifc;
const count = (text: string, pattern: RegExp): number => text.match(pattern)?.length ?? 0;

/** Every `#n` a record names exists, and ids are 1..N without a gap. */
function expectClosed(ifc: string): void {
  const records = ifc.split('\n').filter((line) => /^#\d+=/.test(line));
  const ids = records.map((line) => Number(/^#(\d+)=/.exec(line)?.[1]));
  expect(ids).toEqual(ids.map((_, index) => index + 1));
  const known = new Set(ids);
  for (const line of records) {
    for (const ref of line.slice(line.indexOf('=') + 1).matchAll(/#(\d+)/g))
      expect(known.has(Number(ref[1])), `${line} -> #${ref[1]}`).toBe(true);
  }
}

describe('export_ifc: access elements (VC-STA-12)', () => {
  const { doc, ids } = gratedFrame();
  const railed = apply(doc, 'add_railing', {
    path: [
      [0, 0, 0],
      [4000, 0, 0],
    ],
    openings: [{ from: 1000, to: 1800, gate: true }],
  });
  const ifc = exported(railed);

  it('writes the gratings as IfcPlate USERDEFINED with ObjectType GRATING and a property set', () => {
    expect(count(ifc, /=IFCPLATE\(/g)).toBe(ids.length);
    expect(count(ifc, /=IFCPLATE\([^\n]*,'GRATING',[^\n]*\.USERDEFINED\.\);/g)).toBe(3);
    expect(ifc).toContain("'Pset_llullGrating'");
    expect(ifc).toContain("IFCLABEL('19-W-4 1-1/4x3/16')");
    expect(ifc).toContain('IFCBOOLEAN(.T.)');
    expect(enumItems('IfcPlateTypeEnum.md')).toContain('USERDEFINED');
  });

  it('writes the railing as IfcRailing GUARDRAIL aggregating one IfcMember POST per post', () => {
    expect(count(ifc, /=IFCRAILING\(/g)).toBe(1);
    expect(count(ifc, /=IFCRAILING\([^\n]*\.GUARDRAIL\.\);/g)).toBe(1);
    expect(count(ifc, /=IFCMEMBER\([^\n]*\.POST\.\);/g)).toBe(5);
    const aggregate = ifc.split('\n').filter((line) => /=IFCRELAGGREGATES\(/.test(line) && /\(#\d+(,#\d+){4}\)\);$/.test(line));
    expect(aggregate).toHaveLength(1);
    expect(ifc).toContain("'Pset_llullRailing'");
    expect(enumItems('IfcRailingTypeEnum.md')).toEqual(expect.arrayContaining(['GUARDRAIL', 'HANDRAIL']));
    expect(enumItems('IfcMemberTypeEnum.md')).toContain('POST');
  });

  it('writes the tube and flat-bar profiles of the railing as catalogue profile definitions', () => {
    expect(ifc).toContain("IFCCIRCLEHOLLOWPROFILEDEF(.AREA.,'CHS48.3x3.2'");
    expect(ifc).toContain("IFCRECTANGLEPROFILEDEF(.AREA.,'FL100x5'");
  });

  it('stays a closed STEP graph and exports a hand-rail as HANDRAIL', () => {
    expectClosed(ifc);
    const hand = apply(doc, 'add_railing', {
      path: [
        [0, 0, 0],
        [2000, 0, 500],
      ],
      role: 'handrail',
      height: 900,
    });
    expect(exported(hand)).toMatch(/=IFCRAILING\([^\n]*\.HANDRAIL\.\);/);
  });

  it('counts the new products in the summary and ignores a railing whose profile left the catalogue', () => {
    const result = data<{ productCount: number; elementCount: number }>(railed, 'export_ifc', {});
    expect(result.elementCount).toBeGreaterThanOrEqual(ids.length + 1);
    const broken = JSON.parse(JSON.stringify(railed)) as CadDocument;
    const rail = broken.building?.elements['railing-1'];
    if (rail?.category === 'railing') rail.railProfile = 'GONE';
    expect(count(exported(broken), /=IFCRAILING\(/g)).toBe(0);
  });
});

describe('steel members of the FL and RD families', () => {
  it('exports a flat bar as IfcRectangleProfileDef and a round bar as IfcCircleProfileDef', () => {
    let doc = apply(gratedFrame().doc, 'add_steel_member', { profile: 'FL100x10', role: 'brace', start: [0, 0, 500], end: [1000, 0, 500] });
    doc = apply(doc, 'add_steel_member', { profile: 'RD20', role: 'brace', start: [0, 100, 500], end: [1000, 100, 500] });
    const ifc = exported(doc);
    expect(ifc).toContain("IFCRECTANGLEPROFILEDEF(.AREA.,'FL100x10'");
    expect(ifc).toContain("IFCCIRCLEPROFILEDEF(.AREA.,'RD20'");
  });
});
