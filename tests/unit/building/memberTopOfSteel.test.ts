import { describe, expect, it } from 'vitest';
import type { SteelMemberElement } from '@core/model/building';
import { execute } from '@core/commands/registry';
import { createEmptyDocument, type CadDocument } from '@core/model/types';

function withMember(start: number[], end: number[], role = 'beam'): CadDocument {
  return execute(createEmptyDocument(), 'add_steel_member', {
    profile: 'IPE450',
    role,
    start,
    end,
  }).document;
}

const member = (doc: CadDocument): SteelMemberElement =>
  doc.building?.elements['member-1'] as SteelMemberElement;

describe('update_steel_member keepTopOfSteel', () => {
  it('lowers a beam axis by half the depth increase so the top of steel stays', () => {
    const doc = withMember([0, 0, -255], [6000, 0, -255]);
    const result = execute(doc, 'update_steel_member', {
      memberId: 'member-1',
      profile: 'IPE600',
      keepTopOfSteel: true,
    });
    expect(member(result.document).start[2]).toBeCloseTo(-330);
    expect(member(result.document).end[2]).toBeCloseTo(-330);
    expect(result.summary).toMatch(/axis moved down 75\.0 mm to keep the top of steel/);
    expect(member(doc).start[2]).toBe(-255);
  });

  it('raises the axis when the section gets shallower', () => {
    const doc = withMember([0, 0, -255], [6000, 0, -255]);
    const result = execute(doc, 'update_steel_member', {
      memberId: 'member-1',
      profile: 'IPE300',
      keepTopOfSteel: true,
    });
    expect(member(result.document).start[2]).toBeCloseTo(-180);
    expect(result.summary).toMatch(/axis moved up 75\.0 mm/);
  });

  it('keeps the axis by default, for columns, and when new end points are given', () => {
    const beam = withMember([0, 0, -255], [6000, 0, -255]);
    const plain = execute(beam, 'update_steel_member', { memberId: 'member-1', profile: 'IPE600' });
    expect(member(plain.document).start[2]).toBe(-255);
    expect(plain.summary).not.toMatch(/axis moved/);

    const column = withMember([0, 0, 0], [0, 0, 6000], 'column');
    const upsized = execute(column, 'update_steel_member', {
      memberId: 'member-1',
      profile: 'HEB300',
      keepTopOfSteel: true,
    });
    expect(member(upsized.document).end).toEqual([0, 0, 6000]);

    const moved = execute(beam, 'update_steel_member', {
      memberId: 'member-1',
      profile: 'IPE600',
      start: [0, 0, -100],
      end: [6000, 0, -100],
      keepTopOfSteel: true,
    });
    expect(member(moved.document).start[2]).toBe(-100);
  });
});
