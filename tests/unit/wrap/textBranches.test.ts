/**
 * Failure branches of text on a curve, of the outline of crossing contours and of the decal commands that need a kernel: each is a coded refusal, not a throw.
 */

import { describe, expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import { uint8ArrayToBase64 } from '@lib/base64';
import { setFontProvider } from '@core/commands/fontPort';
import { bundledProvider } from './fixtures';
import { setGeometryKernel } from '@core/geometry/kernel';
import { textOutline } from '@core/geometry/textOutline';
import { parseFont, type ParsedFont } from '@lib/font/font';
import type { CadDocument, Entity } from '@core/model/types';
import { expectRefusal } from '../../helpers/commandAssertions';
import { fakeWrapKernel } from '../../helpers/fakeWrapKernel';
import { box, cylinder, emptyDoc, make, useFakeKernel } from './support';
import { buildFont, type GlyphPointSpec } from './fontBuilder';

const square = (x: number, y: number, size: number, clockwise: boolean): GlyphPointSpec[] => {
  const corners: Array<[number, number]> = [
    [x, y],
    [x, y + size],
    [x + size, y + size],
    [x + size, y],
  ];
  return (clockwise ? corners : corners.reverse()).map(([px, py]) => ({ x: px, y: py, on: true }));
};

const fontOf = (contours: GlyphPointSpec[][]): ParsedFont => {
  const parsed = parseFont(
    buildFont({
      glyphs: [{ kind: 'empty' }, { kind: 'simple', contours }],
      advances: [600, 600],
      metrics: 2,
      codePoints: [[0x41, 1]],
      os2: { version: 3, fsType: 0, capHeight: 700 },
    }),
  );
  if (!parsed.ok) throw new Error(parsed.message);
  return parsed.font;
};

describe('textOutline of damaged contours', () => {
  it('reports crossing contours as self_intersect and lets a failure that is not a font error through', () => {
    const crossing = fontOf([square(0, 0, 500, true), square(250, 250, 500, true), square(400, 100, 200, false)]);
    const result = textOutline({ content: 'A', height: 10, anchor: 'left' }, crossing);
    expect(result).toMatchObject({ error: 'self_intersect' });
    const broken = { ...crossing, glyphIndex: () => 1, outline: () => ({}) as never } as unknown as ParsedFont;
    expect(() => textOutline({ content: 'A', height: 10, anchor: 'left' }, broken)).toThrow();
  });
});

describe('text on a curve: single-line strokes and the end of the curve', () => {
  useFakeKernel();

  const lineWith = (doc: CadDocument, length: number): { doc: CadDocument; id: string } =>
    make(doc, 'draw_polyline', {
      points: [
        [0, 0],
        [length, 0],
      ],
    });

  it('bends single-line strokes along the curve, and refuses text longer than its curve', () => {
    setFontProvider(bundledProvider());
    const base = cylinder();
    const curve = lineWith(base.doc, 80);
    const text = make(curve.doc, 'add_text', {
      content: 'LLULL',
      position: [0, 0, 0],
      height: 6,
      font: 'LLULL Single Line',
      onCurve: { curveId: curve.id },
    });
    const outline = execute(text.doc, 'text_outline', { id: text.id });
    expect(outline.rejected, outline.summary).toBeUndefined();
    expect((outline.data as { onCurve: unknown }).onCurve).toMatchObject({ curveId: curve.id });
    const short = lineWith(base.doc, 5);
    const long = make(short.doc, 'add_text', {
      content: 'LLULL',
      position: [0, 0, 0],
      height: 6,
      font: 'LLULL Single Line',
      onCurve: { curveId: short.id },
    });
    const cut = execute(long.doc, 'text_outline', { id: long.id });
    expect(cut.rejected).toBe(true);
    expect(cut.summary).toContain('beyond the end');
    const filled = make(short.doc, 'add_text', {
      content: 'LLULL',
      position: [0, 0, 0],
      height: 6,
      font: 'Fira Sans',
      onCurve: { curveId: short.id },
    });
    expect(execute(filled.doc, 'text_outline', { id: filled.id }).rejected).toBe(true);
  });

  it('refuses when its curve is gone, is not a 2D curve, lies in another plane, or has no length', () => {
    const base = cylinder();
    const curve = lineWith(base.doc, 60);
    const text = make(curve.doc, 'add_text', {
      content: 'LL',
      position: [0, 0, 0],
      height: 6,
      font: 'Fira Sans',
      onCurve: { curveId: curve.id },
    });
    const replaced = (patch: (entity: Entity) => Entity): CadDocument => ({
      ...text.doc,
      entities: { ...text.doc.entities, [curve.id]: patch(text.doc.entities[curve.id] as Entity) },
    });
    const withoutCurve: CadDocument = {
      ...text.doc,
      entities: Object.fromEntries(Object.entries(text.doc.entities).filter(([id]) => id !== curve.id)),
    };
    expectRefusal(withoutCurve, 'text_outline', { id: text.id }, 'WRP_TEXT_CURVE_INVALID');
    expectRefusal(
      replaced(() => base.doc.entities[base.id] as Entity),
      'text_outline',
      { id: text.id },
      'WRP_TEXT_CURVE_INVALID',
    );
    expectRefusal(
      replaced((entity) => ({ ...entity, rotation: [0, 0.5, 0] }) as Entity),
      'text_outline',
      { id: text.id },
      'WRP_TEXT_CURVE_PLANE',
    );
    expectRefusal(
      replaced((entity) => ({ ...entity, end: (entity as unknown as { start: [number, number] }).start }) as Entity),
      'text_outline',
      { id: text.id },
      'WRP_TEXT_CURVE_INVALID',
    );
  });
});

describe('add_decal needs the kernel to read the face under a wrapped decal', () => {
  useFakeKernel();

  const wrapped = { text: 'AB', at: [20, 0, 0], normal: [1, 0, 0], height: 5, width: 10, mapping: 'wrap' };

  it('refuses a solid the kernel cannot build, a point that is on no face, and a flat or doubly curved face', () => {
    const wedge = make(emptyDoc(), 'add_wedge', { size: [10, 10, 10] });
    expectRefusal(wedge.doc, 'add_decal', { id: wedge.id, ...wrapped, at: [5, 0, 0] }, 'WRP_KERNEL_BUILD_FAILED');
    const { doc, id } = cylinder();
    setGeometryKernel(fakeWrapKernel({ noProjectOnFace: true }));
    expectRefusal(doc, 'add_decal', { id, ...wrapped }, 'WRP_FACE_NOT_FOUND');
    setGeometryKernel(fakeWrapKernel());
    const plate = box();
    expectRefusal(plate.doc, 'add_decal', { id: plate.id, ...wrapped, at: [0, 0, 5], normal: [0, 0, 1] }, 'WRP_WRAP_NOT_NEEDED');
  });

  it('caps the mask of a very wide font text at 1024 pixels', () => {
    const { doc, id } = box();
    const text = 'M'.repeat(60);
    const result = execute(doc, 'add_decal', { id, text, at: [0, 0, 5], normal: [0, 0, 1], height: 3, font: 'Fira Sans' });
    expect(result.rejected, result.summary).toBeUndefined();
    const mask = (result.document.entities[id] as unknown as { decals: Array<{ mask: { width: number; height: number } }> }).decals[0]
      ?.mask;
    expect(mask?.width).toBe(1024);
    expect(mask?.height).toBeGreaterThanOrEqual(1);
  });
});

describe('add_decal wrap and font failure branches', () => {
  useFakeKernel();

  const wrapped = { text: 'AB', at: [20, 0, 0], normal: [1, 0, 0], height: 5, width: 10, mapping: 'wrap' };

  it('refuses a kernel without face queries and a freeform face under a wrapped decal', () => {
    const { doc, id } = cylinder();
    setGeometryKernel(fakeWrapKernel({ noFaceQuery: true }));
    expectRefusal(doc, 'add_decal', { id, ...wrapped }, 'CMD_KERNEL_UNAVAILABLE');
    setGeometryKernel(fakeWrapKernel({ freeform: true }));
    expectRefusal(doc, 'add_decal', { id, ...wrapped }, 'WRP_FACE_NOT_DEVELOPABLE');
  });

  it('refuses a font whose outline crosses itself and a font record whose bytes are gone', () => {
    const crossing = buildFont({
      glyphs: [
        { kind: 'empty' },
        { kind: 'simple', contours: [square(0, 0, 500, true), square(250, 250, 500, true), square(400, 100, 200, false)] },
      ],
      advances: [600, 600],
      metrics: 2,
      codePoints: [[0x41, 1]],
      os2: { version: 3, fsType: 0, capHeight: 700 },
    });
    const imported = execute(emptyDoc(), 'import_font', { base64: uint8ArrayToBase64(crossing) });
    expect(imported.rejected, imported.summary).toBeUndefined();
    const solid = make(imported.document, 'add_box', { size: [60, 40, 10] });
    const params = { id: solid.id, text: 'A', at: [0, 0, 5], normal: [0, 0, 1], height: 4, font: imported.affected[0] };
    expectRefusal(solid.doc, 'add_decal', params, 'WRP_PROFILE_SELF_INTERSECT');
    const noBytes = { ...solid.doc, blobs: {} } as CadDocument;
    expect(execute(noBytes, 'add_decal', params).rejected).toBe(true);
  });
});
