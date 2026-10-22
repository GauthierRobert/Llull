/**
 * The less common branches of the 03 WRP commands on the fake exact kernel: face picks on edges, kernels that answer null, parameter bounds that are not finite,
 * partial projections, unmeasured volumes, damaged font blobs and parser fallbacks.
 */

import { describe, expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import { setGeometryKernel } from '@core/geometry/kernel';
import { loadFont } from '@core/commands/wrap/fontStore';
import { parseFont, validateGlyphs, type ParsedFont } from '@lib/font/font';
import { FIRA_SHA256 } from './fixtures';
import { buildFont, type GlyphSpec } from './fontBuilder';
import type { CadDocument } from '@core/model/types';
import { fakeWrapKernel, type FakeWrapOptions } from '../../helpers/fakeWrapKernel';
import { expectRefusal } from '../../helpers/commandAssertions';
import { box, cylinder, emptyDoc, FACE, make, rectangleOn, useFakeKernel } from './support';

const data = (result: ReturnType<typeof execute>): Record<string, unknown> => result.data as Record<string, unknown>;
const withKernel = (options: FakeWrapOptions): void => setGeometryKernel(fakeWrapKernel(options));

describe('face picks and kernel answers', () => {
  useFakeKernel();

  it('a point on an edge or a seam takes the lowest-numbered face that contains it; none containing it is refused', () => {
    const base = cylinder();
    withKernel({ edgePick: true });
    const line = make(base.doc, 'draw_polyline', {
      points: [
        [0, 0],
        [5, 0],
      ],
    });
    expect(execute(line.doc, 'wrap_to_face', { id: base.id, face: FACE, entityIds: [line.id] }).rejected).toBeUndefined();
    withKernel({ edgePick: true, containsNothing: true });
    expectRefusal(line.doc, 'wrap_to_face', { id: base.id, face: FACE, entityIds: [line.id] }, 'WRP_FACE_NOT_FOUND', 'face');
  });

  it('refuses a pick of several faces, a point off the solid, a face without geometry and a solid the kernel cannot build', () => {
    const base = cylinder();
    const line = make(base.doc, 'draw_polyline', {
      points: [
        [0, 0],
        [5, 0],
      ],
    });
    expectRefusal(
      line.doc,
      'wrap_to_face',
      { id: base.id, face: { faceIndex: 1, faceNear: [20, 0, 0] }, entityIds: [line.id] },
      'WRP_FACE_NOT_FOUND',
    );
    expectRefusal(line.doc, 'wrap_to_face', { id: base.id, face: { faceNear: [90, 90, 90] }, entityIds: [line.id] }, 'WRP_FACE_NOT_FOUND');
    withKernel({ noGeometry: true });
    expectRefusal(line.doc, 'wrap_to_face', { id: base.id, face: FACE, entityIds: [line.id] }, 'WRP_FACE_NOT_FOUND');
    withKernel({});
    const torus = make(emptyDoc(), 'add_torus', { ringRadius: 10, tubeRadius: 2 });
    const small = rectangleOn(torus.doc, 1, 1);
    expectRefusal(
      small.doc,
      'wrap_to_face',
      { id: torus.id, face: { faceIndex: 0 }, entityIds: [small.id] },
      'WRP_KERNEL_BUILD_FAILED',
      'id',
    );
  });

  it('refuses an anchor the kernel cannot project and a face whose bounds are not finite', () => {
    const base = cylinder();
    const line = make(base.doc, 'draw_polyline', {
      points: [
        [0, 0],
        [5, 0],
      ],
    });
    withKernel({ noProjectOnFace: true });
    expectRefusal(
      line.doc,
      'wrap_to_face',
      { id: base.id, face: FACE, entityIds: [line.id] },
      'WRP_ANCHOR_OFF_FACE',
      'placement.anchor.on',
    );
    withKernel({ infiniteBounds: true });
    expectRefusal(line.doc, 'unwrap_face', { id: base.id, face: FACE }, 'WRP_FACE_NOT_FOUND', 'face');
    withKernel({ noEvaluate: true });
    expectRefusal(line.doc, 'unwrap_face', { id: base.id, face: FACE }, 'WRP_FACE_NOT_FOUND', 'face');
    withKernel({});
    const flat = box();
    expect(execute(flat.doc, 'unwrap_face', { id: flat.id, face: { faceNear: [0, 0, 5] } }).rejected).toBeUndefined();
  });

  it('an emboss on a kernel without mass properties reports an unmeasured volume change', () => {
    const base = cylinder();
    const rect = rectangleOn(base.doc, 30, 10);
    withKernel({ noMass: true });
    const result = execute(rect.doc, 'emboss_on_face', { id: base.id, face: FACE, profileIds: [rect.id], mode: 'emboss', depth: 1 });
    expect(result.rejected, result.summary).toBeUndefined();
    expect(data(result)['volumeDelta']).toBeNull();
    expect(result.summary).toContain('volume change not measured');
    expect(data(execute(result.document, 'check_wrap', { ids: [result.affected[0]], maxLengthStrain: 0.02 }))['checked']).toMatchObject({
      volumes: 0,
      volumesSkipped: 1,
    });
  });

  it('reports a partly landing sketch and refuses it with requireAll', () => {
    const base = cylinder();
    const plane = make(base.doc, 'create_sketch_plane', { plane: 'yz', offset: 30 });
    const line = make(plane.doc, 'draw_polyline', {
      points: [
        [-22.5, 0],
        [0, 0],
        [22.5, 0],
      ],
    });
    const placed = make(line.doc, 'place_on_sketch_plane', { ids: [line.id], plane: plane.id });
    withKernel({ outside: (point) => point[1] > 0.5 });
    const partial = execute(placed.doc, 'project_to_face', { id: base.id, entityIds: [line.id], direction: [-1, 0, 0] });
    expect(partial.rejected, partial.summary).toBeUndefined();
    const missed = data(partial)['missed'] as Array<{ entityId: string; fraction: number }>;
    expect(missed).toHaveLength(1);
    expect(missed[0]?.fraction).toBeCloseTo(0.75, 6);
    expect(partial.summary).toContain('partly missing');
    const refused = expectRefusal(
      placed.doc,
      'project_to_face',
      { id: base.id, entityIds: [line.id], direction: [-1, 0, 0], requireAll: true },
      'WRP_PROJECTION_MISSES_FACE',
      'entityIds',
    );
    expect(refused.data).toMatchObject({ missed: [expect.objectContaining({ entityId: line.id })] });
  });
});

describe('project_to_face sources and defaults', () => {
  useFakeKernel();

  it('projects a circle (rational source) and a sketch on the far side with the default direction and closest distance', () => {
    const base = cylinder();
    const plane = make(base.doc, 'create_sketch_plane', { plane: 'yz', offset: 30 });
    const circle = make(plane.doc, 'draw_arc', { center: [0, 0], radius: 5 });
    const placed = make(circle.doc, 'place_on_sketch_plane', { ids: [circle.id], plane: plane.id });
    const direct = execute(placed.doc, 'project_to_face', { id: base.id, entityIds: [circle.id], direction: [-1, 0, 0] });
    expect(direct.rejected, direct.summary).toBeUndefined();
    const closest = execute(placed.doc, 'project_to_face', { id: base.id, entityIds: [circle.id], closest: true });
    expect(closest.rejected, closest.summary).toBeUndefined();
    const far = make(base.doc, 'create_sketch_plane', { plane: 'yz', offset: -30 });
    const line = make(far.doc, 'draw_polyline', {
      points: [
        [-5, 0],
        [5, 0],
      ],
    });
    const there = make(line.doc, 'place_on_sketch_plane', { ids: [line.id], plane: far.id });
    const turned = execute(there.doc, 'project_to_face', { id: base.id, entityIds: [line.id] });
    expect(turned.rejected, turned.summary).toBeUndefined();
    expect((data(turned)['direction'] as number[])[0]).toBeGreaterThan(0.99);
  });
});

describe('font blobs and parser fallbacks', () => {
  it('loads no font from a document whose blob is missing, malformed or not a font', () => {
    const base: CadDocument = {
      ...emptyDoc(),
      fonts: {
        'font-1.1': {
          id: 'font-1.1',
          family: 'X',
          style: 'Regular',
          blob: 'a'.repeat(64),
          format: 'truetype',
          unitsPerEm: 1000,
          capHeight: 700,
          capHeightSource: 'os2',
          embedding: 'installable',
          provenance: { verified: false },
        },
      },
    };
    expect(loadFont(base, 'font-1.1')).toMatchObject({ code: 'WRP_FONT_UNAVAILABLE' });
    const malformed: CadDocument = {
      ...base,
      blobs: { ['a'.repeat(64)]: { sha256: 'a'.repeat(64), mediaType: 'font/ttf', bytes: '***', size: 3 } },
    };
    expect(loadFont(malformed, 'font-1.1')).toMatchObject({
      code: 'WRP_FONT_UNAVAILABLE',
      message: expect.stringContaining('lost its bytes'),
    });
    const text = Buffer.from('definitely not a font file, just text').toString('base64');
    const garbage: CadDocument = {
      ...base,
      blobs: { ['a'.repeat(64)]: { sha256: 'a'.repeat(64), mediaType: 'font/ttf', bytes: text, size: 37 } },
    };
    expect(loadFont(garbage, 'font-1.1')).toMatchObject({ code: 'WRP_FONT_PARSE' });
    expect(FIRA_SHA256).toHaveLength(64);
  });

  it('answers a non-font value and a scan that throws something else with WRP_FONT_PARSE', () => {
    const parsed = parseFont(null as never);
    expect(parsed.ok).toBe(false);
    expect(parsed.ok ? '' : parsed.code).toBe('WRP_FONT_PARSE');
    const hostile = {
      scanGlyphs: () => {
        throw new Error('boom');
      },
    } as unknown as ParsedFont;
    expect(validateGlyphs(hostile)).toMatchObject({ ok: false, code: 'WRP_FONT_PARSE' });
  });

  it('reads a contour made only of off-curve points (the implied midpoints close it)', () => {
    const allOff: GlyphSpec = {
      kind: 'simple',
      contours: [
        [
          { x: 0, y: 0, on: false },
          { x: 100, y: 0, on: false },
          { x: 100, y: 100, on: false },
          { x: 0, y: 100, on: false },
        ],
      ],
    };
    const bytes = buildFont({
      glyphs: [
        { kind: 'empty' },
        {
          kind: 'simple',
          contours: [
            [
              { x: 0, y: 0, on: true },
              { x: 0, y: 700, on: true },
              { x: 700, y: 700, on: true },
              { x: 700, y: 0, on: true },
            ],
          ],
        },
        allOff,
      ],
      codePoints: [
        [0x48, 1],
        [0x4f, 2],
      ],
      cmap: 'f4',
      os2: { version: 2, fsType: 0, capHeight: 700 },
    });
    const parsed = parseFont(bytes);
    if (!parsed.ok) throw new Error(parsed.message);
    const [loop] = parsed.font.outline(2);
    expect(loop).toHaveLength(4);
    expect(loop?.every((segment) => segment.kind === 'quad')).toBe(true);
  });
});
