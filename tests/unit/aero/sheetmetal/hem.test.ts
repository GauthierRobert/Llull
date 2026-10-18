import { describe, expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import type { FtrCheckData } from '@core/model/manufacturing';
import type { SheetMetalPart } from '@core/model/sheetMetal';
import { meshBounds, meshVolume } from './helpers';
import { apply, data, expectRefusal, ok } from '../../../helpers/commandAssertions';
import { plate } from './plates';

interface FlatData {
  extents: [number, number];
  unverified: boolean;
  unverifiedInputs: Array<{ kind: string; id: string }>;
  bends: Array<{ id: string; angleDeg: number; ossb: number | null; bd: number | null; hem: string | null; ba: number }>;
  hems: Array<{ id: string; hemType: string; gap: number; returnLeg: number; developedLength: { value: number; verification: string } }>;
}

const T = 1.6;
const K = 0.44;
const hemParams = (part: string, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: part,
  edge: { near: [40, 15, 0] },
  hemType: 'closed',
  length: 10,
  ...extra,
});

describe('add_hem (FR-FTR-12, VC-FTR-15)', () => {
  it('closes a hem with inside radius 0 even though the rule forbids sharp bends, and develops it with its own formula', () => {
    const { doc, part } = plate(40, 30);
    const result = ok(doc, 'add_hem', hemParams(part));
    expect(result.affected).toEqual([part]);
    expect(result.summary).toContain('Hem h1 (closed, gap 0)');
    const info = result.data as { developedLength: { value: number; verification: string; source: string }; bendAllowance: number };
    const ba = Math.PI * K * T;
    expect(info.bendAllowance).toBeCloseTo(ba, 12);
    expect(info.developedLength.value).toBeCloseTo(ba + 10, 12);
    expect(info.developedLength.verification).toBe('unverified');
    expect(info.developedLength.source).toContain('not verified');
    const flat = data<FlatData>(result.document, 'flat_pattern', { id: part });
    expect(flat.extents[0]).toBeCloseTo(40 + ba + 10, 9);
    expect(flat.extents[1]).toBeCloseTo(30, 9);
    expect(flat.bends[0]).toMatchObject({ angleDeg: 180, ossb: null, bd: null, hem: 'h1' });
    expect(flat.bends[0]?.ba).toBeCloseTo(ba, 12);
    expect(flat.hems[0]).toMatchObject({ id: 'h1', hemType: 'closed', gap: 0, returnLeg: 10 });
    expect(flat.unverified).toBe(true);
    expect(flat.unverifiedInputs.some((input) => input.kind === 'preset' && input.id === `hem:${part}/h1`)).toBe(true);
    const node = (result.document.sheetMetal?.parts[part] as SheetMetalPart).nodes['h1'];
    expect(node).toMatchObject({ type: 'hem', bend: 'b1', flat: 'f2', hemType: 'closed', gap: 0, length: 10 });
  });

  it('folds the closed hem against the flat: analytic volume and total height 2T', () => {
    const { doc, part } = plate(40, 30);
    const { document } = ok(doc, 'add_hem', hemParams(part));
    const expected = 40 * 30 * T + (Math.PI / 2) * T ** 2 * 30 + 10 * 30 * T;
    expect(Math.abs(meshVolume(document, part) / expected - 1)).toBeLessThan(1e-3);
    expect(meshBounds(document, part).max[2]).toBeCloseTo(2 * T, 6);
    const check = data<FtrCheckData>(document, 'check_sheet_metal', { id: part });
    expect(check.findings.some((finding) => finding.code === 'FTR_SHARP_BEND_FORBIDDEN')).toBe(false);
  });

  it('folds an open hem with a gap: inside radius gap/2, developed length pi*(gap/2+K*T)+leg', () => {
    const { doc, part } = plate(40, 30);
    const { document } = ok(doc, 'add_hem', hemParams(part, { hemType: 'open', gap: 3.2 }));
    const ba = Math.PI * (1.6 + K * T);
    const flat = data<FlatData>(document, 'flat_pattern', { id: part });
    expect(flat.extents[0]).toBeCloseTo(40 + ba + 10, 9);
    expect(flat.hems[0]?.developedLength.value).toBeCloseTo(ba + 10, 9);
    const expected = 40 * 30 * T + (Math.PI / 2) * ((1.6 + T) ** 2 - 1.6 ** 2) * 30 + 10 * 30 * T;
    expect(Math.abs(meshVolume(document, part) / expected - 1)).toBeLessThan(1e-3);
    expect(meshBounds(document, part).max[2]).toBeCloseTo(T + 3.2 + T, 6);
    const dxf = data<{ dxf: string }>(document, 'export_flat_pattern_dxf', { id: part }).dxf;
    expect(dxf).toContain('HEM h1 OPEN');
    expect(dxf).toContain('UNVERIFIED MODEL');
  });

  it('hems towards -normal with direction down and insets with widthStart', () => {
    const { doc, part } = plate(40, 30);
    const down = ok(doc, 'add_hem', hemParams(part, { direction: 'down', widthStart: 5 }));
    expect(meshBounds(down.document, part).min[2]).toBeCloseTo(-T, 6);
    expect(data<FlatData>(down.document, 'flat_pattern', { id: part }).bends[0]).toMatchObject({ angleDeg: 180, hem: 'h1' });
  });

  it('refuses inconsistent gaps, short legs, missing edges, occupied edges and unknown parts', () => {
    const { doc, part } = plate(40, 30);
    expectRefusal(doc, 'add_hem', hemParams(part, { hemType: 'open' }), 'FTR_PARAM_INVALID', 'gap');
    expectRefusal(doc, 'add_hem', hemParams(part, { hemType: 'open', gap: 0 }), 'FTR_PARAM_INVALID', 'gap');
    expectRefusal(doc, 'add_hem', hemParams(part, { gap: 1 }), 'FTR_PARAM_INVALID', 'gap');
    expectRefusal(doc, 'add_hem', hemParams(part, { length: 0 }), 'FTR_PARAM_INVALID', 'length');
    expectRefusal(doc, 'add_hem', hemParams(part, { edge: { near: [20, 15, 40] } }), 'FTR_EDGE_NOT_STRAIGHT', 'edge.near');
    expectRefusal(doc, 'add_hem', hemParams('nope'), 'FTR_PART_NOT_FOUND', 'id');
    expectRefusal(apply(doc, 'add_hem', hemParams(part)), 'add_hem', hemParams(part), 'FTR_EDGE_OCCUPIED');
  });

  it('is pure', () => {
    const { doc, part } = plate(40, 30);
    const before = JSON.stringify(doc);
    execute(doc, 'add_hem', hemParams(part));
    expect(JSON.stringify(doc)).toBe(before);
  });
});
