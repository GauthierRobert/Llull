/**
 * Plant 06 STA follow-up: pipes and cable trays (spec-driven runs with their insulation envelopes) are obstructions of ISO-PLT-HEADROOM.
 * Hand numbers: DN80 hot line at z = 3000 with 50 mm insulation: envelope radius 94.45 mm, underside 2905.55 mm (bare pipe 2955.55 mm).
 */

import { describe, expect, it } from 'vitest';
import { createEmptyDocument, type CadDocument } from '@core/model/types';
import { apply, data, ok } from '../../../helpers/commandAssertions';
import { addTie, cs150Document } from '../piping/rteFixtures';
import { TYPE } from './accessFixtures';

interface Checked {
  findings: Array<{ code: string; measured: { value: number }; limit: { min?: number } }>;
  platforms: Array<{ headroomMm: number | null }>;
  notEvaluated: Array<{ ruleId: string; reason: string }>;
}
const check = (doc: CadDocument): Checked => data<Checked>(doc, 'check_access', { rulesets: ['iso_14122'], include: ['platforms'] });

function hotLine(insulated = true): CadDocument {
  const a = addTie(cs150Document(), 'TP-H1', [0, 0, 3000], [1, 0, 0], { dn: 80 });
  const b = addTie(a.doc, 'TP-H2', [6000, 0, 3000], [-1, 0, 0], { dn: 80 });
  const created = ok(b.doc, 'create_pipeline', {
    service: 'HO',
    sequence: '4001',
    spec: 'CS150',
    dn: 80,
    designTempC: 180,
    ...(insulated ? { insulation: { code: 'H', thickness: 'fromSpec' } } : {}),
  });
  const routed = apply(created.document, 'route_pipe', {
    lineId: created.affected[0] as string,
    from: { portId: a.id },
    to: { portId: b.id },
  });
  return apply(routed, 'add_level', { name: 'Grade', elevation: 0, height: 4000 });
}
const withDeck = (doc: CadDocument, topOffset: number, x0 = 1000): CadDocument =>
  apply(doc, 'add_access_platform', {
    bounds: [
      [x0, -1000],
      [x0 + 4000, 1000],
    ],
    topOffset,
    gratingType: TYPE,
    bearingBarDirection: [1, 0],
    levelId: 'level-1',
  });
const headroom = (doc: CadDocument): number | null => check(doc).platforms[0]?.headroomMm ?? null;

describe('check_access: platform headroom under pipes', () => {
  it('a deck 1000 mm up under the insulated line has 1905.55 mm and fails ISO-PLT-HEADROOM (2100); the bare pipe would read 1955.55', () => {
    const checked = check(withDeck(hotLine(), 1000));
    expect(checked.platforms[0]?.headroomMm).toBeCloseTo(1905.55, 6);
    const finding = checked.findings.find((entry) => entry.code === 'STA_PLATFORM_HEADROOM');
    expect(finding?.measured.value).toBeCloseTo(1905.55, 6);
    expect(finding?.limit.min).toBe(2100);
    expect(headroom(withDeck(hotLine(false), 1000))).toBeCloseTo(1955.55, 6);
  });

  it('a deck 600 mm up has 2305.55 mm and passes', () => {
    const checked = check(withDeck(hotLine(), 600));
    expect(checked.platforms[0]?.headroomMm).toBeCloseTo(2305.55, 6);
    expect(checked.findings.map((entry) => entry.code)).not.toContain('STA_PLATFORM_HEADROOM');
  });

  it('a pipe below the deck, or beside it, is not an obstruction; the notEvaluated text now says pipes are modelled', () => {
    expect(headroom(withDeck(hotLine(), 3500))).toBeNull();
    expect(headroom(withDeck(hotLine(), 1000, 8000))).toBeNull();
    const checked = check(withDeck(hotLine(), 1000));
    expect(checked.notEvaluated.find((row) => row.ruleId === 'ISO-PLT-HEADROOM')?.reason).toContain('pipes and trays are');
  });

  it('a model without pipes is unchanged: nothing above reads null', () => {
    const grade = apply(apply(createEmptyDocument(), 'set_units', { units: 'mm' }), 'add_level', {
      name: 'Grade',
      elevation: 0,
      height: 4000,
    });
    expect(headroom(withDeck(grade, 1000))).toBeNull();
  });
});
