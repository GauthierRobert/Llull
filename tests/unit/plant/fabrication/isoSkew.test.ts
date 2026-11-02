/**
 * Plant 05 ISO M5: skew boxes and support marks on the isometric (VC-ISO-21, SC-ISO-08), asserted on `data`, not on pixels.
 */

import { describe, expect, it } from 'vitest';
import { createEmptyDocument } from '@core/model/types';
import { skewGeometry } from '@aec/plant/fabrication/iso/isoSkew';
import { apply, data } from '../../../helpers/commandAssertions';
import { s501 } from './isoM5Fixtures';
import { routedWithSupport } from './isoM5Fixtures';
import { fixturePcf } from './fabricationFixtures';

interface Annotation {
  kind: string;
  text: string;
  [extra: string]: unknown;
}
interface Sheet {
  annotations: Annotation[];
  supports: Array<{ id: string; mark: string; type: string; at: number[]; sheetIndex: number }>;
  files: Array<{ name: string; content: string }>;
  warnings: Array<{ code: string }>;
}

const sheetOf = (doc: ReturnType<typeof s501>, lineId: string, extra: Record<string, unknown> = {}): Sheet =>
  data<Sheet>(doc, 'export_isometric', { lineId, style: 'check', paper: 'A3', formats: ['svg', 'dxf'], ...extra });

describe('skew boxes (VC-ISO-21)', () => {
  const sheet = sheetOf(s501(), 'S-501');
  const skew = sheet.annotations.find((annotation) => annotation.kind === 'skew');

  it('the 45 degree offset of 1000 x 1000 is one skew run of 1414.2135624 mm at 45 degrees with both legs', () => {
    expect(skew).toBeDefined();
    expect(Math.abs((skew?.['lengthMm'] as number) - 1414.2135624)).toBeLessThan(1e-6);
    expect(skew?.['legsMm']).toEqual([1000, 1000]);
    expect(skew?.['legAxes']).toEqual(['E', 'N']);
    expect(skew?.['angleDeg']).toBeCloseTo(45, 9);
    expect(skew?.['plane']).toBe('horizontal');
    expect(skew?.text).toBe('SKEW 1414.2 45 DEG');
  });

  it('each leg is dimensioned with its 3D value, and the figure is in the files (ISO-DIM polyline)', () => {
    const legs = sheet.annotations.filter((annotation) => annotation.kind === 'skew_leg');
    expect(legs.map((leg) => [leg['axis'], leg['valueMm'], leg.text])).toEqual([
      ['E', 1000, '1000'],
      ['N', 1000, '1000'],
    ]);
    const svg = sheet.files.find((file) => file.name.endsWith('.svg'))?.content ?? '';
    expect(svg).toContain('class="iso-dim"');
    expect(svg).toContain('SKEW 1414.2 45 DEG');
    const dxf = sheet.files.find((file) => file.name.endsWith('.dxf'))?.content ?? '';
    expect(dxf).toContain('SKEW 1414.2 45 DEG');
  });

  it('the legacy elbows are reported as derived (warning kept), and the skew run is not dimensioned as an axis run', () => {
    expect(sheet.warnings.map((warning) => warning.code)).toContain('ISO_LEGACY_FITTINGS_DERIVED');
  });

  it('a line with only axis runs has no skew annotation', () => {
    const plain = data<Sheet>(apply(createEmptyDocument(), 'import_pcf', { text: fixturePcf() }), 'export_isometric', { lineId: 'L-101' });
    expect(plain.annotations.some((annotation) => annotation.kind.startsWith('skew'))).toBe(false);
  });
});

describe('skew runs in a vertical plane and oblique runs', () => {
  const rolling = apply(apply(createEmptyDocument(), 'add_level', { name: 'Grade', elevation: 0 }), 'add_pipe_run', {
    points: [
      [0, 0, 2000],
      [2000, 0, 2000],
      [3000, 0, 3000],
      [5000, 0, 3000],
      [6000, 1000, 4000],
      [8000, 1000, 4000],
    ],
    dn: 100,
    line: 'RO-1',
    service: 'steam',
  });
  const skews = sheetOf(rolling, 'RO-1').annotations.filter((annotation) => annotation.kind === 'skew');

  it('a 45 degree rise in a vertical plane has the legs east and up, an oblique run has three legs and its angle from the horizontal', () => {
    expect(skews.map((skew) => [skew['plane'], skew['legAxes']])).toEqual([
      ['vertical_E', ['E', 'U']],
      ['oblique', ['E', 'N', 'U']],
    ]);
    expect(skews[0]?.['angleDeg']).toBeCloseTo(45, 9);
    expect(skews[1]?.['legsMm']).toEqual([1000, 1000, 1000]);
    expect(skews[1]?.['angleDeg']).toBeCloseTo((Math.atan(1000 / Math.hypot(1000, 1000)) * 180) / Math.PI, 9);
    expect(Math.abs((skews[1]?.['lengthMm'] as number) - Math.sqrt(3) * 1000)).toBeLessThan(1e-6);
  });

  it('a falling skew run draws the leg downwards with the same value', () => {
    const falling = apply(apply(createEmptyDocument(), 'add_level', { name: 'Grade', elevation: 0 }), 'add_pipe_run', {
      points: [
        [0, 0, 3000],
        [2000, 0, 3000],
        [2000, -1000, 2000],
        [2000, -3000, 2000],
      ],
      dn: 100,
      line: 'FA-1',
      service: 'water',
    });
    const skew = sheetOf(falling, 'FA-1').annotations.find((annotation) => annotation.kind === 'skew');
    expect(skew?.['plane']).toBe('vertical_N');
    expect(skew?.['legsMm']).toEqual([1000, 1000]);
  });
});

describe('skewGeometry', () => {
  it('measures a triangle from its longer leg and an oblique run from the horizontal plane', () => {
    expect(skewGeometry([1000, 1000, 0])).toMatchObject({ plane: 'horizontal', angleDeg: 45 });
    const flat = skewGeometry([3000, 1000, 0]);
    expect(flat.angleDeg).toBeCloseTo((Math.atan(1 / 3) * 180) / Math.PI, 9);
    expect(skewGeometry([0, 1000, 500])).toMatchObject({ plane: 'vertical_N' });
    expect(skewGeometry([-1000, 0, -1000])).toMatchObject({ plane: 'vertical_E', angleDeg: 45 });
    const oblique = skewGeometry([1000, 1000, 1414.2135623730951]);
    expect(oblique.plane).toBe('oblique');
    expect(oblique.angleDeg).toBeCloseTo(45, 6);
    expect(oblique.legs).toHaveLength(3);
  });
});

describe('support marks', () => {
  it('both shoes of S-501 are drawn on their pipes and listed with mark, type and 3D position', () => {
    const sheet = sheetOf(s501(), 'S-501');
    expect(sheet.supports.map((support) => [support.mark, support.type, support.at])).toEqual([
      ['PS1', 'shoe', [1000, 0, 2000]],
      ['PS2', 'shoe', [4000, 1000, 2000]],
    ]);
    expect(sheet.annotations.filter((annotation) => annotation.kind === 'support').map((annotation) => annotation.text)).toEqual([
      'PS1',
      'PS2',
    ]);
    expect(sheet.files[0]?.content).toContain('PS1');
  });

  it('a routed line draws its guide; an imported line draws the SUPPORT records it holds', () => {
    const { doc, lineId } = routedWithSupport();
    expect(sheetOf(doc, lineId).supports.map((support) => support.type)).toEqual(['guide']);
    const text = fixturePcf().replace(
      'MATERIALS\n',
      'SUPPORT\n    COMPONENT-IDENTIFIER 16\n    CO-ORDS 1000.0 0.0 3000.0\n    SUPPORT-TYPE ANCHOR\nMATERIALS\n',
    );
    const imported = sheetOf(apply(createEmptyDocument(), 'import_pcf', { text }), 'L-101');
    expect(imported.supports.map((support) => [support.type, support.at])).toEqual([['anchor', [1000, 0, 3000]]]);
  });

  it('a support off every pipe of the line is not drawn and not listed', () => {
    const text = fixturePcf().replace('MATERIALS\n', 'SUPPORT\n    COMPONENT-IDENTIFIER 16\n    CO-ORDS 1000.0 500.0 3000.0\nMATERIALS\n');
    expect(sheetOf(apply(createEmptyDocument(), 'import_pcf', { text }), 'L-101').supports).toEqual([]);
  });

  it('the sheet is deterministic with supports and skew boxes', () => {
    const doc = s501();
    expect(sheetOf(doc, 'S-501').files[0]?.content).toBe(sheetOf(doc, 'S-501').files[0]?.content);
  });
});
