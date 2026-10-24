/**
 * 03 WRP M4: add_decal with an outline font and with mapping wrap (VC-WRP-23). The wrap needs the face under the decal (fake exact kernel); projecting and the block font need no
 * kernel. The patch and the image are the shared pure functions the viewport and the glTF export call.
 */

import { describe, expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import { setGeometryKernel } from '@core/geometry/kernel';
import { decalPatch, scaledDecals } from '@core/geometry/decal';
import { decalImage } from '@core/geometry/decalImage';
import { wrapExtent } from '@core/geometry/decalWrap';
import { packMask, rasterizePolygons, unpackMask } from '@lib/outlineRaster';
import type { Decal, Entity } from '@core/model/types';
import { createEmptyDocument } from '@core/model/types';
import { serializeDocument } from '@core/commands/persistence/serialization';
import { expectRefusal } from '../../helpers/commandAssertions';
import { expectPure } from '../../helpers/expectNoOp';
import { cone, cylinder, sphere, box, make, useFakeKernel } from './support';

const decalsOf = (doc: { entities: Record<string, Entity> }, id: string): readonly Decal[] => doc.entities[id]?.decals ?? [];
const azimuthSpan = (positions: number[]): number => {
  const angles = Array.from({ length: positions.length / 3 }, (_, k) =>
    Math.atan2(positions[3 * k + 1] as number, positions[3 * k] as number),
  );
  return Math.max(...angles) - Math.min(...angles);
};
const SIDE = { text: 'LLULL', at: [20, 0, 0], normal: [1, 0, 0], height: 5 };

describe('add_decal mapping wrap (VC-WRP-23)', () => {
  useFakeKernel();

  it('a decal of width 30 on a cylinder r 20 spans 1.5 rad where the projected one would span 1.69612 rad', () => {
    const { doc, id } = cylinder();
    const result = execute(doc, 'add_decal', { id, ...SIDE, width: 30, mapping: 'wrap' });
    expect(result.rejected, result.summary).toBeUndefined();
    const info = result.data as Record<string, unknown>;
    expect(info).toMatchObject({ mapping: 'wrap', surfaceKind: 'cylinder', widthArc: 30 });
    expect(Math.abs((info['extentRad'] as number) - 1.5)).toBeLessThan(1e-9);
    const decal = decalsOf(result.document, id)[0] as Decal;
    expect(decal.mapping).toBe('wrap');
    expect(Math.abs(azimuthSpan(decalPatch(decal, []).positions) - 1.5)).toBeLessThan(1e-3);
    expect(2 * Math.asin(15 / 20)).toBeCloseTo(1.69612415796, 9);
    // the patch hugs the cylinder (lift 1e-3 of the larger side) and spans the decal height along the axis
    const points = decalPatch(decal, []).positions;
    for (let k = 0; k < points.length; k += 3) expect(Math.hypot(points[k] as number, points[k + 1] as number)).toBeCloseTo(20.03, 2);
    const zs = points.filter((_, k) => k % 3 === 2);
    expect(Math.max(...zs) - Math.min(...zs)).toBeCloseTo(5, 9);
    expect(decalPatch(decal, []).uvs).toHaveLength((points.length / 3) * 2);
    expectPure(doc, () => execute(doc, 'add_decal', { id, ...SIDE, width: 30, mapping: 'wrap' }));
  });

  it('wraps on a cone keeping the width as an arc along the development; scaling the solid scales the wrap surface', () => {
    const { doc, id } = cone();
    const result = execute(doc, 'add_decal', {
      id,
      text: 'LLULL',
      at: [10, 0, 20],
      normal: [1, 0, 0.5],
      height: 4,
      width: 10,
      mapping: 'wrap',
    });
    expect(result.rejected, result.summary).toBeUndefined();
    const decal = decalsOf(result.document, id)[0] as Decal;
    expect(decal.wrap?.type).toBe('cone');
    expect(decalPatch(decal, []).positions.length).toBeGreaterThan(0);
    const bigger = scaledDecals([decal], 2)[0] as Decal;
    expect(bigger.wrap?.type === 'cone' && bigger.wrap.apex[2]).toBeCloseTo(2 * (decal.wrap?.type === 'cone' ? decal.wrap.apex[2] : 0), 9);
    const cylinderDecal = scaledDecals(
      [
        decalsOf(
          execute(cylinder().doc, 'add_decal', { id: 'cyl-1.1', ...SIDE, width: 30, mapping: 'wrap' }).document,
          'cyl-1.1',
        )[0] as Decal,
      ],
      2,
    )[0] as Decal;
    expect(cylinderDecal.wrap?.type === 'cylinder' && cylinderDecal.wrap.radius).toBe(40);
  });

  it('refuses a flat face, a sphere, a width beyond one turn, no kernel and an unreachable point', () => {
    const plate = box();
    expectRefusal(
      plate.doc,
      'add_decal',
      { id: plate.id, text: 'A', at: [0, 0, 5], normal: [0, 0, 1], height: 3, mapping: 'wrap' },
      'WRP_WRAP_NOT_NEEDED',
      'mapping',
    );
    const ball = sphere();
    expectRefusal(
      ball.doc,
      'add_decal',
      { id: ball.id, text: 'A', at: [0, 0, 25], normal: [0, 0, 1], height: 3, mapping: 'wrap' },
      'WRP_FACE_NOT_DEVELOPABLE',
    );
    const { doc, id } = cylinder();
    const wide = expectRefusal(doc, 'add_decal', { id, ...SIDE, width: 130, mapping: 'wrap' }, 'WRP_WRAP_OVERLAP', 'width');
    expect((wide.data as { extentRad: number }).extentRad).toBeCloseTo(6.5, 9);
    setGeometryKernel(null);
    expectRefusal(doc, 'add_decal', { id, ...SIDE, width: 30, mapping: 'wrap' }, 'CMD_KERNEL_UNAVAILABLE');
    const projected = execute(doc, 'add_decal', { id, ...SIDE, width: 30 });
    // projecting needs no kernel: whatever it answers, it is not a kernel refusal
    expect(projected.error?.code).not.toBe('CMD_KERNEL_UNAVAILABLE');
  });

  it('wrapExtent: a cylinder is width over radius, a cone width over rho sin(alpha)', () => {
    expect(
      wrapExtent({ width: 30, center: [20, 0, 0] }, { type: 'cylinder', origin: [0, 0, 0], axis: [0, 0, 1], xDir: [1, 0, 0], radius: 20 }),
    ).toBeCloseTo(1.5, 12);
    expect(
      wrapExtent(
        { width: 5, center: [0, 3, 4] },
        { type: 'cone', apex: [0, 0, 0], axis: [0, 0, 1], xDir: [1, 0, 0], semiAngle: Math.PI / 6 },
      ),
    ).toBeCloseTo(5 / (5 * 0.5), 12);
  });
});

describe('add_decal with an outline font', () => {
  useFakeKernel();

  it('rasterises the text outline into a stored 1-bit mask whose ink fraction is the outline area over the box', () => {
    const { doc, id } = box();
    const result = execute(doc, 'add_decal', { id, text: 'LLULL', at: [0, 0, 5], normal: [0, 0, 1], height: 4, font: 'Fira Sans' });
    expect(result.rejected, result.summary).toBeUndefined();
    const decal = decalsOf(result.document, id)[0] as Decal;
    expect(decal.mask).toBeDefined();
    expect(Object.keys(result.document.fonts ?? {})).toHaveLength(1);
    const image = decalImage(decal);
    expect(image.width).toBe(decal.mask?.width);
    expect(image.aspect).toBeCloseTo(decal.width / decal.height, 12);
    const inked = Array.from({ length: image.width * image.height }, (_, k) => image.rgba[4 * k + 3] as number).filter(
      (alpha) => alpha === 255,
    ).length;
    // LLULL at cap height 4 (scale 4 / 689): ink area 104.886 * (4 / 10)^2 = 16.78 mm^2 over the ink box
    const fraction = inked / (image.width * image.height);
    expect(fraction).toBeGreaterThan(0.2);
    expect(fraction).toBeLessThan(0.6);
    const labelled = execute(result.document, 'add_text', { content: 'LLULL', position: [0, 0, 0], height: 4, font: 'Fira Sans' });
    const area = execute(labelled.document, 'text_outline', { id: labelled.affected[0] }).data as {
      area: number;
      bbox: { min: number[]; max: number[] };
    };
    expect(Math.abs(fraction - area.area / (decal.width * decal.height))).toBeLessThan(0.02);
    expectPure(doc, () => execute(doc, 'add_decal', { id, text: 'LLULL', at: [0, 0, 5], normal: [0, 0, 1], height: 4, font: 'Fira Sans' }));
  });

  it('uses the given width, reports unmapped characters, and works together with wrap', () => {
    const { doc, id } = cylinder();
    const result = execute(doc, 'add_decal', { id, ...SIDE, width: 24, font: 'Fira Sans', mapping: 'wrap', text: 'AB中' });
    expect(result.rejected, result.summary).toBeUndefined();
    const info = result.data as { missingCharacters: string[]; extentRad: number };
    expect(info.missingCharacters).toEqual(['中']);
    expect(info.extentRad).toBeCloseTo(24 / 20, 9);
    expect(result.summary).toContain('Fira Sans');
  });

  it('refuses an unknown font, a text without ink, and a block-font decal keeps working', () => {
    const { doc, id } = box();
    expectRefusal(
      doc,
      'add_decal',
      { id, text: 'A', at: [0, 0, 5], normal: [0, 0, 1], height: 4, font: 'No Such Font' },
      'WRP_FONT_UNAVAILABLE',
      'font',
    );
    expectRefusal(
      doc,
      'add_decal',
      { id, text: '中', at: [0, 0, 5], normal: [0, 0, 1], height: 4, font: 'Fira Sans' },
      'WRP_PROFILE_EMPTY',
    );
    const plain = execute(doc, 'add_decal', { id, text: 'A', at: [0, 0, 5], normal: [0, 0, 1], height: 4 });
    expect(decalsOf(plain.document, id)[0]?.mask).toBeUndefined();
    expect(decalImage(decalsOf(plain.document, id)[0] as Decal).rgba.length).toBeGreaterThan(0);
    void make;
  });
});

describe('lib/outlineRaster', () => {
  it('fills a polygon with a hole by the even-odd rule and round-trips the packed mask', () => {
    const outer: Array<[number, number]> = [
      [0, 0],
      [8, 0],
      [8, 8],
      [0, 8],
    ];
    const hole: Array<[number, number]> = [
      [2, 2],
      [6, 2],
      [6, 6],
      [2, 6],
    ];
    const coverage = rasterizePolygons([outer, hole], { minX: 0, maxX: 8, minY: 0, maxY: 8 }, 8, 8);
    expect(coverage.reduce((sum, v) => sum + v, 0)).toBe(64 - 16);
    expect(coverage[0]).toBe(1);
    expect(coverage[3 * 8 + 3]).toBe(0);
    const packed = packMask(coverage);
    expect(packed).toHaveLength(8);
    expect([...unpackMask(packed, 64)]).toEqual([...coverage]);
    expect([...unpackMask(new Uint8Array(0), 8)]).toEqual([0, 0, 0, 0, 0, 0, 0, 0]);
  });
});

describe('load guard of the wrap and mask fields of a decal', () => {
  useFakeKernel();

  const painted = (extra: Record<string, unknown>): { doc: ReturnType<typeof createEmptyDocument>; id: string; decal: Decal } => {
    const { doc, id } = cylinder();
    const result = execute(doc, 'add_decal', { id, ...SIDE, width: 30, mapping: 'wrap', ...extra });
    return { doc: result.document, id, decal: decalsOf(result.document, id)[0] as Decal };
  };
  const loadWith = (base: ReturnType<typeof painted>, patch: Record<string, unknown>, drop: string[] = []): boolean => {
    const changed = Object.fromEntries(Object.entries({ ...base.decal, ...patch }).filter(([key]) => !drop.includes(key)));
    const broken = {
      ...base.doc,
      entities: { ...base.doc.entities, [base.id]: { ...base.doc.entities[base.id], decals: [changed] } as unknown as Entity },
    };
    return execute(createEmptyDocument(), 'load_document', { json: serializeDocument(broken) }).affected.length > 0;
  };

  it('loads a valid wrap decal and a valid font mask, refuses hostile wrap surfaces', () => {
    const base = painted({});
    expect(loadWith(base, {})).toBe(true);
    const wrap = base.decal.wrap as unknown as Record<string, unknown>;
    expect(loadWith(base, { mapping: 'spin' })).toBe(false);
    expect(loadWith(base, {}, ['wrap'])).toBe(false);
    expect(loadWith(base, { mapping: 'project' })).toBe(false);
    expect(loadWith(base, { wrap: 5 })).toBe(false);
    expect(loadWith(base, { wrap: { ...wrap, radius: 0 } })).toBe(false);
    expect(loadWith(base, { wrap: { ...wrap, axis: [0, 0, 0] } })).toBe(false);
    expect(loadWith(base, { wrap: { ...wrap, origin: [0, 0] } })).toBe(false);
    expect(loadWith(base, { wrap: { ...wrap, type: 'sphere' } })).toBe(false);
    const coneWrap = { type: 'cone', apex: [0, 0, 0], axis: [0, 0, 1], xDir: [1, 0, 0], semiAngle: 0.5 };
    expect(loadWith(base, { wrap: coneWrap })).toBe(true);
    expect(loadWith(base, { wrap: { ...coneWrap, semiAngle: 1.6 } })).toBe(false);
    expect(loadWith(base, { wrap: { ...coneWrap, apex: 'x' } })).toBe(false);
  });

  it('refuses a mask with a huge size, a wrong payload length or no object', () => {
    const { doc, id } = box();
    const made = execute(doc, 'add_decal', { id, text: 'LLULL', at: [0, 0, 5], normal: [0, 0, 1], height: 4, font: 'Fira Sans' });
    const base = { doc: made.document, id, decal: decalsOf(made.document, id)[0] as Decal };
    expect(loadWith(base, {})).toBe(true);
    const mask = base.decal.mask as { width: number; height: number; bits: string };
    expect(loadWith(base, { mask: { ...mask, width: 100000, height: 100000 } })).toBe(false);
    expect(loadWith(base, { mask: { ...mask, width: 0 } })).toBe(false);
    expect(loadWith(base, { mask: { ...mask, bits: mask.bits.slice(4) } })).toBe(false);
    expect(loadWith(base, { mask: { ...mask, bits: 5 } })).toBe(false);
    expect(loadWith(base, { mask: 'x' })).toBe(false);
  });
});
