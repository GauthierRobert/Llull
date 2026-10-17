/**
 * Live OpenCascade: the formed sheet-metal features (aerospace 07 FTR M5/M8). The folded solids stay exact (arcs, revolutions, coincident
 * faces) and their volumes match the closed forms: relief VC-FTR-12, flanged hole VC-FTR-13, bead VC-FTR-14, hem VC-FTR-15.
 */

import { afterAll, describe, expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import { defaultContext } from '@core/commands/context';
import type { CommandResult, ExecutionContext } from '@core/commands/types';
import { setGeometryKernel, type GeometryKernel } from '@core/geometry/kernel';
import { createEmptyDocument, type CadDocument } from '@core/model/types';
import type { BeadForm, FlangedHoleForm } from '@core/model/sheetMetal';
import { lipVolume } from '@aero/sheetmetal/formGeometry';
import { beadVolumeChange } from '../../tests/unit/aero/sheetmetal/plates';
import { liveKernels } from './kernelTestSupport';

const kernels = liveKernels();
afterAll(() => setGeometryKernel(null));
const ctxOf = (kernel: GeometryKernel): ExecutionContext => ({ ...defaultContext(), kernel });

function run(doc: CadDocument, name: string, params: unknown): CommandResult {
  const result = execute(doc, name, params, ctxOf(kernels.occt));
  expect(result.rejected, `${name}: ${result.summary}`).toBeUndefined();
  return result;
}

const volumeOf = (doc: CadDocument, id: string): number =>
  (run(doc, 'mass_properties', { entityId: id }).data as { volume: number }).volume;
const relative = (value: number, expected: number): number => Math.abs(value / expected - 1);

function plate(width: number, height: number, rule: Record<string, unknown>): { doc: CadDocument; part: string } {
  const named = {
    name: 'AL',
    material: '2024-T3',
    temper: 'T3',
    thickness: 1.6,
    insideRadius: 4.8,
    kFactor: 0.44,
    kFactorStandard: 'ansi',
    ...rule,
  };
  const doc = run(createEmptyDocument(), 'create_sheet_metal_rule', named).document;
  const drawn = run(doc, 'draw_rectangle', { width, height, position: [0, 0, 0] });
  const made = run(drawn.document, 'add_sheet_metal_base', { profileId: drawn.affected[0], rule: named.name, side: 'up' });
  return { doc: made.document, part: made.affected[0] as string };
}

const T = 1.6;

describe('relief on add_flange (VC-FTR-12)', () => {
  it('removes exactly width x depth x T: ratio 0.5 gives 0.8 x (R + T) = 0.8 x 6.4 mm', () => {
    const { doc, part } = plate(33.6, 50, { relief: { type: 'rectangular', widthRatio: 0.5 } });
    const flange = {
      id: part,
      edge: { near: [33.6, 25, 0] },
      angle: 90,
      length: 30,
      lengthReference: 'outside_mold_line',
      position: 'material_outside',
      widthStart: 4,
    };
    const relieved = run(doc, 'add_flange', flange);
    const plain = run(doc, 'add_flange', { ...flange, autoRelief: false });
    const removed = volumeOf(plain.document, part) - volumeOf(relieved.document, part);
    expect(Math.abs(removed - 0.8 * 6.4 * T)).toBeLessThan(1e-6);
    expect((relieved.data as { reliefs: Array<{ width: { value: number }; depth: { value: number } }> }).reliefs[0]).toMatchObject({
      width: { value: 0.8 },
      depth: { value: 6.4 },
    });
  });
});

describe('flanged hole (VC-FTR-13)', () => {
  it('is a valid solid whose volume is plate - disc + lip, with the flat cut diameter flagged approximate', () => {
    const { doc, part } = plate(100, 80, {});
    const base = volumeOf(doc, part);
    const result = run(doc, 'add_flanged_hole', {
      id: part,
      face: { near: [50, 40, 0] },
      center: [50, 40, 0],
      holeDiameter: 40,
      flangeHeight: 4,
      flangeAngle: 90,
      lipRadius: 2,
    });
    const form: FlangedHoleForm = {
      kind: 'flanged_hole',
      center: [50, 40],
      holeDiameter: 40,
      flangeHeight: 4,
      angle: Math.PI / 2,
      lipRadius: 2,
      direction: 'up',
    };
    const cutRadius = 20 + T + 2;
    const expected = base - Math.PI * cutRadius ** 2 * T + lipVolume(form, T);
    const volume = volumeOf(result.document, part);
    expect(relative(volume, 11381.155100136742)).toBeLessThan(1e-9);
    expect(relative(volume, expected)).toBeLessThan(1e-6);
    const flat = (result.data as { flatCutDiameter: { value: number; approximate: boolean } }).flatCutDiameter;
    expect(flat.approximate).toBe(true);
    expect(flat.value).toBeCloseTo(2 * (cutRadius - (Math.PI / 2) * (2 + 0.44 * T) - 2), 9);
    const pattern = run(result.document, 'flat_pattern', { id: part }).data as { unverified: boolean };
    expect(pattern.unverified).toBe(true);
  });
});

describe('bead (VC-FTR-14)', () => {
  it('R 3, depth 2, length 60 on a 1.0 mm flat: valid solid with the exact arch volume; flat pattern excludes it', () => {
    const { doc, part } = plate(100, 60, { name: 'AL1', thickness: 1, insideRadius: 3 });
    const base = volumeOf(doc, part);
    const result = run(doc, 'add_bead', {
      id: part,
      face: { near: [50, 30, 0] },
      path: [
        [20, 30, 0],
        [80, 30, 0],
      ],
      radius: 3,
      depth: 2,
      endShape: 'round',
    });
    const form: BeadForm = { kind: 'bead', start: [20, 30], end: [80, 30], radius: 3, depth: 2, endShape: 'round', direction: 'up' };
    const expected = base + beadVolumeChange(form, 1);
    const volume = volumeOf(result.document, part);
    expect(relative(volume, 6144.808986959319)).toBeLessThan(1e-9);
    expect(relative(volume, expected)).toBeLessThan(1e-6);
    const open = run(doc, 'add_bead', {
      id: part,
      face: { near: [50, 30, 0] },
      path: [
        [20, 30, 0],
        [80, 30, 0],
      ],
      radius: 3,
      depth: 2,
      endShape: 'open',
    });
    expect(relative(volumeOf(open.document, part), 6128.0538261401725)).toBeLessThan(1e-9);
    expect(relative(volumeOf(open.document, part), base + beadVolumeChange({ ...form, endShape: 'open' }, 1))).toBeLessThan(1e-6);
    const flat = run(result.document, 'flat_pattern', { id: part }).data as { area: number; formingNotes: unknown[] };
    expect(flat.area).toBeCloseTo(6000, 9);
    expect(flat.formingNotes).toHaveLength(1);
  });
});

describe('hem (VC-FTR-15)', () => {
  it('closed and open hems fold to the exact volume', () => {
    const { doc, part } = plate(40, 30, {});
    const closed = run(doc, 'add_hem', { id: part, edge: { near: [40, 15, 0] }, hemType: 'closed', length: 10 });
    const closedVolume = volumeOf(closed.document, part);
    expect(relative(closedVolume, 2520.6371578978474)).toBeLessThan(1e-9);
    expect(relative(closedVolume, 40 * 30 * T + (Math.PI / 2) * T ** 2 * 30 + 10 * 30 * T)).toBeLessThan(1e-6);
    const open = run(doc, 'add_hem', { id: part, edge: { near: [40, 15, 0] }, hemType: 'open', gap: 3.2, length: 10 });
    const openVolume = volumeOf(open.document, part);
    expect(relative(openVolume, 2761.9114736935444)).toBeLessThan(1e-9);
    expect(relative(openVolume, 40 * 30 * T + (Math.PI / 2) * ((1.6 + T) ** 2 - 1.6 ** 2) * 30 + 10 * 30 * T)).toBeLessThan(1e-6);
  });
});

const VOLUMES: Record<string, number> = { L: 3475.030052642468, Z: 3638.0601052849365, 'Z-return': 4127.490157927407 };

describe('contour flange (VC-FTR-15)', () => {
  it.each([
    ['L', 'bottom', [[0, 30]]],
    [
      'Z',
      'mid',
      [
        [0, 20],
        [15, 20],
      ],
    ],
    [
      'Z-return',
      'top',
      [
        [0, 20],
        [15, 20],
        [15, 5],
      ],
    ],
  ])('%s profile at K 0.5: folded volume = developed area x T', (_name, side, path) => {
    const { doc, part } = plate(40, 30, { name: 'AL5', kFactor: 0.5 });
    const result = run(doc, 'add_contour_flange', { id: part, edge: { near: [40, 15, 0] }, side, path });
    const flat = run(result.document, 'flat_pattern', { id: part }).data as { area: number };
    const volume = volumeOf(result.document, part);
    expect(relative(volume, VOLUMES[_name] as number)).toBeLessThan(1e-9);
    expect(relative(volume, flat.area * T)).toBeLessThan(1e-6);
  });
});
