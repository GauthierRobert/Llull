import { describe, expect, it } from 'vitest';
import type { CadDocument } from '@core/model/types';
import { execute } from '@core/commands/registry';
import { pipeWeightPerMetre } from '@aec/industrial/pipeWeight';
import { tributaryLengths } from '@aec/industrial/steelSupportLoads';
import { findProfile } from '@aec/steel/profiles';
import { G, beam, check, column, rowOf, step, twoLevels } from './steelFixtures';
import { hangerDoc, shoeDoc } from './pipeSupportFixtures';

const W = pipeWeightPerMetre(114.3, 1000); // kN/m, DN100 water-filled
const IPE300 = (findProfile('IPE300')?.massPerMetre ?? 0) * G * 1e-3;
const HEB200 = (findProfile('HEB200')?.massPerMetre ?? 0) * G * 1e-3;

const support = (doc: CadDocument, params: Record<string, unknown>): CadDocument =>
  step(doc, 'add_pipe_support', params);

interface LineRow {
  supports: number;
  basis: string;
  carriedKn: number;
}
const lineOf = (doc: CadDocument): LineRow =>
  (check(doc).loads.lines as unknown as LineRow[])[0] as LineRow;

describe('tributaryLengths', () => {
  it('gives half the spans to supports, the whole overhang to a free end', () => {
    expect(tributaryLengths([1000, 3000], 6000)).toEqual([2000, 4000]);
  });

  it('gives only half the span to an end carried by a nozzle or a header', () => {
    expect(tributaryLengths([1000, 3000], 6000, { carriedStart: true, carriedEnd: true })).toEqual([
      1500, 2500,
    ]);
  });

  it('shares the tributary of supports closer than 100 mm and handles none', () => {
    expect(tributaryLengths([1000, 1050], 6000)).toEqual([3000, 3000]);
    expect(tributaryLengths([], 6000)).toEqual([]);
  });
});

describe('pipe weight through supports', () => {
  it('puts the weight of a shoe-supported pipe on its beam: P = w × 6 m at mid-span', () => {
    const doc = support(shoeDoc(), { pipeId: 'pipe-1', at: [[3000, 2000, 3027.15]] });
    const data = check(doc);
    const line = lineOf(doc);
    expect(line).toMatchObject({ supports: 1, basis: 'supports' });
    expect(line.carriedKn).toBeCloseTo(6 * W, 9);
    // beam 4 m, point load at mid-span: M = P L / 4 = 6w
    const row = rowOf(data, 'SB1');
    expect(row.forces['MEd']).toBeCloseTo(1.35 * (6 * W + (IPE300 * 16) / 8), 2);
    expect(row.checks.some((entry) => entry.name.includes('LTB restrained'))).toBe(true);
    expect(data.warnings.filter((text) => text.includes('rests on no'))).toEqual([]);
    expect(data.warnings.some((text) => text.includes('PS1'))).toBe(false);
  });

  it('shares a run between supports like the resting rule: 2 m and 4 m tributaries', () => {
    let doc = twoLevels();
    for (const x of [1000, 3000]) {
      doc = column(doc, x, 0);
      doc = column(doc, x, 4000);
      doc = beam(doc, [x, 0], [x, 4000]);
    }
    doc = step(doc, 'add_pipe_run', {
      levelId: 'level-1',
      dn: 100,
      points: [
        [0, 2000, 3027.15],
        [6000, 2000, 3027.15],
      ],
    });
    doc = support(doc, {
      pipeId: 'pipe-1',
      at: [
        [1000, 2000, 3027.15],
        [3000, 2000, 3027.15],
      ],
    });
    const data = check(doc);
    expect(lineOf(doc).carriedKn).toBeCloseTo(6 * W, 9);
    const momentOf = (mark: string): number =>
      (rowOf(data, mark).forces['MEd'] ?? 0) / 1.35 - (IPE300 * 16) / 8;
    expect(momentOf('SB1')).toBeCloseTo(2 * W, 2);
    expect(momentOf('SB2')).toBeCloseTo(4 * W, 2);
  });

  it('hangs the pipe from the beam above without restraining its top flange', () => {
    const doc = support(hangerDoc(), {
      pipeId: 'pipe-1',
      at: [[3000, 2000, 2000]],
      type: 'hanger',
    });
    const data = check(doc);
    expect(lineOf(doc).carriedKn).toBeCloseTo(6 * W, 9);
    const row = rowOf(data, 'SB1');
    expect(row.forces['MEd']).toBeCloseTo(1.35 * (6 * W + (IPE300 * 16) / 8), 2);
    expect(row.checks.find((entry) => entry.name.startsWith('bending'))?.name).toContain(
      'LTB checked',
    );
    expect(data.warnings.filter((text) => text.includes('rests on no'))).toEqual([]);
  });

  it('gives only half the span to an end inside equipment (the nozzle carries the rest)', () => {
    let doc = shoeDoc();
    doc = step(doc, 'add_equipment', {
      name: 'Tank',
      location: [0, 2000],
      size: [1000, 1000, 3100],
      levelId: 'level-1',
    });
    doc = support(doc, { pipeId: 'pipe-1', at: [[3000, 2000, 3027.15]] });
    // start in the tank: 3 m / 2 = 1.5 m to the nozzle; this support takes 1.5 m + the 3 m overhang
    expect(lineOf(doc).carriedKn).toBeCloseTo(4.5 * W, 9);
  });

  it('lets a pipe carried by equipment at both ends within the table span rest on its nozzles', () => {
    const between = (length: number): CadDocument => {
      let doc = step(twoLevels(), 'add_steel_member', {
        role: 'beam',
        profile: 'IPE300',
        start: [0, 5000, 100],
        end: [1000, 5000, 100],
        levelId: 'level-1',
      });
      doc = step(doc, 'add_pipe_run', {
        levelId: 'level-1',
        dn: 100,
        points: [
          [0, 0, 500],
          [length, 0, 500],
        ],
      });
      for (const x of [0, length]) {
        doc = step(doc, 'add_equipment', {
          name: `Vessel ${x}`,
          location: [x, 0],
          size: [1000, 1000, 1000],
          levelId: 'level-1',
        });
      }
      return doc;
    };
    const short = between(3500);
    expect(lineOf(short)).toMatchObject({ basis: 'nozzles', supports: 0, carriedKn: 0 });
    expect(check(short).warnings.some((text) => text.includes('rests on no steel beam'))).toBe(
      false,
    );
    expect(
      check(between(6000)).warnings.some((text) => text.includes('rests on no steel beam')),
    ).toBe(true);
  });

  it('warns about an unattached support: it carries nothing', () => {
    const doc = support(shoeDoc(), { pipeId: 'pipe-1', at: [[500, 2000, 3027.15]] });
    const data = check(doc);
    expect(lineOf(doc)).toMatchObject({ supports: 0, carriedKn: 0, basis: 'supports' });
    expect(data.warnings.some((text) => text.includes('support PS1 (shoe on pipe PL1'))).toBe(true);
    expect(data.warnings.some((text) => text.includes('attached to no steel member'))).toBe(true);
    expect(data.warnings.some((text) => text.includes('none of its supports bears on steel'))).toBe(
      true,
    );
    expect(data.warnings.some((text) => text.includes('rests on no steel beam'))).toBe(false);
  });

  it('keeps the resting rule for a pipe without supports and points to add_pipe_support', () => {
    const doc = shoeDoc();
    expect(lineOf(doc)).toMatchObject({ supports: 1, basis: 'resting' });
    const floating = step(twoLevels(), 'add_steel_member', {
      role: 'beam',
      profile: 'IPE300',
      start: [0, 0, -180],
      end: [0, 4000, -180],
      levelId: 'level-2',
    });
    const lone = step(floating, 'add_pipe_run', {
      levelId: 'level-1',
      dn: 100,
      points: [
        [0, 0, 1000],
        [6000, 0, 1000],
      ],
    });
    const warning = check(lone).warnings.find((text) => text.includes('rests on no steel beam'));
    expect(warning).toContain('add_pipe_support');
  });

  it('takes a column-borne support as axial load and notes the bracket eccentricity', () => {
    let doc = twoLevels();
    doc = column(doc, 1000, 1000);
    doc = step(doc, 'add_pipe_run', {
      levelId: 'level-1',
      dn: 100,
      points: [
        [0, 1000, 2000],
        [3000, 1000, 2000],
      ],
    });
    doc = support(doc, { pipeId: 'pipe-1', at: [[1000, 1000, 2000]], type: 'anchor' });
    const data = check(doc);
    // support at 1 m of a 3 m run: 1 m + 2 m overhangs = 3 m of pipe
    expect(lineOf(doc).carriedKn).toBeCloseTo(3 * W, 9);
    expect(rowOf(data, 'SC1').forces['NEd']).toBeCloseTo(1.35 * (3 * W + HEB200 * 3), 2);
    expect(
      data.warnings.some(
        (text) =>
          text.includes('bracketed off column SC1') && text.includes('bracket eccentricity'),
      ),
    ).toBe(true);
  });

  it('carries a pipe standing on a column top concentrically, without a note', () => {
    let doc = twoLevels();
    doc = column(doc, 1000, 1000, 'HEB200', 1942.85);
    doc = step(doc, 'add_pipe_run', {
      levelId: 'level-1',
      dn: 100,
      points: [
        [0, 1000, 2000],
        [3000, 1000, 2000],
      ],
    });
    doc = support(doc, { pipeId: 'pipe-1', at: [[1000, 1000, 2000]] });
    const data = check(doc);
    expect(lineOf(doc).carriedKn).toBeCloseTo(3 * W, 9);
    expect(rowOf(data, 'SC1').forces['NEd']).toBeCloseTo(1.35 * (3 * W + HEB200 * 1.94285), 2);
    expect(data.warnings.some((text) => text.includes('SC1'))).toBe(false);
  });

  it('reports a support on a member the check does not analyse as a floor beam', () => {
    let doc = twoLevels();
    doc = step(doc, 'add_steel_member', {
      role: 'purlin',
      profile: 'IPE200',
      start: [3000, 0, 2800],
      end: [3000, 4000, 2800],
      levelId: 'level-1',
    });
    doc = step(doc, 'add_steel_member', {
      role: 'beam',
      profile: 'IPE300',
      start: [0, 0, 100],
      end: [0, 4000, 100],
      levelId: 'level-1',
    });
    doc = step(doc, 'add_pipe_run', {
      levelId: 'level-1',
      dn: 100,
      points: [
        [2000, 2000, 2957.15],
        [4000, 2000, 2957.15],
      ],
    });
    doc = support(doc, { pipeId: 'pipe-1', at: [[3000, 2000, 2957.15]] });
    const warning = check(doc).warnings.find((text) => text.includes('does not analyse'));
    expect(warning).toContain('bears on purlin');
    expect(warning).toContain('not carried by any checked member');
  });
});

describe('support elements survive execute round trips', () => {
  it('does not change check_steel_members purity', () => {
    const doc = support(shoeDoc(), { pipeId: 'pipe-1', at: [[3000, 2000, 3027.15]] });
    const snapshot = JSON.stringify(doc);
    const result = execute(doc, 'check_steel_members', {});
    expect(result.document).toBe(doc);
    expect(JSON.stringify(doc)).toBe(snapshot);
  });
});
