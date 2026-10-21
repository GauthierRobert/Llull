import { describe, expect, it } from 'vitest';
import { createEmptyDocument, type CadDocument, type ImageEntity } from '@core/model/types';
import { execute } from '@core/commands/registry';
import { MAX_IMAGE_DATA_URL_LENGTH } from '@core/commands/limits';
import { expectNoOp, expectPure } from '../helpers/expectNoOp';
import { jpegDataUrl, pngDataUrl } from '../helpers/imageFixtures';
import { deserializeDocument, serializeDocument } from '@core/commands/persistence/serialization';
import { validateEntityValue } from '@core/commands/persistence/guards';
import { localBounds } from '@core/geometry/bounds';
import { rotatedEntityBounds } from '@core/geometry/rotatedBounds';

const PNG = pngDataUrl(400, 200);

function withUnderlay(params: Record<string, unknown> = {}): { doc: CadDocument; id: string } {
  const result = execute(createEmptyDocument(), 'add_image_underlay', { dataUrl: PNG, ...params });
  return { doc: result.document, id: result.affected[0] ?? '' };
}

const imageOf = (doc: CadDocument, id: string): ImageEntity => {
  const entity = doc.entities[id];
  if (entity?.kind !== 'image') throw new Error(`${id} is not an image`);
  return entity;
};

interface WorldData {
  world: [number, number, number][];
  xy: [number, number][];
  unitsPerPixel: number;
}

describe('add_image_underlay', () => {
  it('places a png at 1 unit/px by default, lower-left at the origin, half opaque', () => {
    const result = execute(createEmptyDocument(), 'add_image_underlay', { dataUrl: PNG, name: 'pump section' });
    expect(result.affected).toHaveLength(1);
    const image = imageOf(result.document, result.affected[0]!);
    expect(image).toMatchObject({
      kind: 'image',
      pixelWidth: 400,
      pixelHeight: 200,
      width: 400,
      height: 200,
      opacity: 0.5,
      locked: false,
      position: [0, 0, 0],
      rotation: [0, 0, 0],
      name: 'pump section',
    });
    expect(image.dataUrl).toBe(PNG);
    expect(result.summary).toContain('400×200 px');
  });
  it('sizes by width (aspect kept) or by pixelSize, with position/rotation/opacity/locked', () => {
    const byWidth = withUnderlay({ width: 100 });
    expect(imageOf(byWidth.doc, byWidth.id)).toMatchObject({ width: 100, height: 50 });
    const byPixel = withUnderlay({ pixelSize: 1.5, position: [5, 6, 7], rotation: [0, 0, 0.25], opacity: 0.8, locked: true });
    expect(imageOf(byPixel.doc, byPixel.id)).toMatchObject({
      width: 600,
      height: 300,
      position: [5, 6, 7],
      rotation: [0, 0, 0.25],
      opacity: 0.8,
      locked: true,
    });
  });
  it('accepts jpeg', () => {
    const result = execute(createEmptyDocument(), 'add_image_underlay', { dataUrl: jpegDataUrl(64, 32) });
    expect(imageOf(result.document, result.affected[0]!)).toMatchObject({ pixelWidth: 64, pixelHeight: 32 });
    expect(result.summary).toContain('image/jpeg');
  });
  it.each([
    [{ dataUrl: 'data:image/gif;base64,R0lGODlh' }, 'must start with'],
    [{ dataUrl: PNG, width: 10, pixelSize: 1 }, 'not both'],
    [{ dataUrl: PNG, width: -5 }, 'must be > 0'],
    [{ dataUrl: PNG, pixelSize: 0 }, 'must be > 0'],
    [{ dataUrl: PNG, opacity: 1.5 }, 'opacity must be in [0, 1]'],
    [{ dataUrl: pngDataUrl(20_000, 10) }, 'largest side'],
    [{ dataUrl: `data:image/png;base64,${'A'.repeat(MAX_IMAGE_DATA_URL_LENGTH)}` }, 'over the'],
  ])('rejects %#', (params, message) => {
    const doc = createEmptyDocument();
    expectNoOp(execute(doc, 'add_image_underlay', params), doc, message);
  });
  it('is pure', () => {
    const doc = createEmptyDocument();
    expectPure(doc, () => execute(doc, 'add_image_underlay', { dataUrl: PNG }));
  });
});

describe('calibrate_underlay', () => {
  it('sets the scale from two pixel points and a real distance', () => {
    const { doc, id } = withUnderlay();
    const result = execute(doc, 'calibrate_underlay', { id, pixelA: [100, 100], pixelB: [300, 100], distance: 300 });
    expect(result.affected).toEqual([id]);
    expect(result.summary).toContain('1.5 units/px');
    expect(imageOf(result.document, id)).toMatchObject({ width: 600, height: 300 });
  });
  it('pins an origin and aligns the segment with y (rotation reported)', () => {
    const { doc, id } = withUnderlay();
    const result = execute(doc, 'calibrate_underlay', {
      id,
      pixelA: [100, 100],
      pixelB: [200, 100],
      distance: 50,
      origin: { pixel: [100, 100], world: [0, 0, 0] },
      align: 'y',
    });
    expect(result.summary).toContain('rotated in-plane to 90°');
    const query = execute(result.document, 'image_to_world', {
      id,
      points: [
        [100, 100],
        [200, 100],
      ],
    });
    const data = query.data as WorldData;
    expect(data.xy[0]).toEqual([0, 0]);
    expect(data.xy[1]![0]).toBeCloseTo(0, 6);
    expect(data.xy[1]![1]).toBeCloseTo(50, 6);
  });
  it('fails without changing the document', () => {
    const { doc, id } = withUnderlay();
    const withBox = execute(doc, 'add_box', { size: [1, 1, 1] });
    const boxId = withBox.affected[0]!;
    const calibrate = (target: CadDocument, params: object, message: string): void => {
      expectNoOp(execute(target, 'calibrate_underlay', params), target, message);
    };
    const points = { pixelA: [0, 0], pixelB: [10, 0] };
    calibrate(doc, { id: 'nope', ...points, distance: 5 }, "entity 'nope' not found");
    calibrate(withBox.document, { id: boxId, ...points, distance: 5 }, "expected 'image'");
    calibrate(doc, { id, ...points, distance: 0 }, 'distance must be');
    calibrate(doc, { id, pixelA: [3, 3], pixelB: [3, 3], distance: 5 }, 'two different pixels');
  });
  it('is pure', () => {
    const { doc, id } = withUnderlay();
    expectPure(doc, () => execute(doc, 'calibrate_underlay', { id, pixelA: [0, 0], pixelB: [1, 1], distance: 2 }));
  });
});

describe('set_underlay', () => {
  it('changes opacity and lock', () => {
    const { doc, id } = withUnderlay();
    const result = execute(doc, 'set_underlay', { id, opacity: 0.2, locked: true });
    expect(result.affected).toEqual([id]);
    expect(imageOf(result.document, id)).toMatchObject({ opacity: 0.2, locked: true });
    const unlocked = execute(result.document, 'set_underlay', { id, locked: false });
    expect(imageOf(unlocked.document, id)).toMatchObject({ opacity: 0.2, locked: false });
  });
  it('rejects missing id, nothing to set, and out-of-range opacity', () => {
    const { doc, id } = withUnderlay();
    expectNoOp(execute(doc, 'set_underlay', { id: 'x', opacity: 0.1 }), doc, "entity 'x' not found");
    expectNoOp(execute(doc, 'set_underlay', { id }), doc, 'give opacity and/or locked');
    expectNoOp(execute(doc, 'set_underlay', { id, opacity: -1 }), doc, 'opacity must be');
  });
  it('is pure', () => {
    const { doc, id } = withUnderlay();
    expectPure(doc, () => execute(doc, 'set_underlay', { id, opacity: 1 }));
  });
});

describe('image_to_world', () => {
  it('maps pixels to world points (y flipped, scaled, offset) without touching the document', () => {
    const { doc, id } = withUnderlay({ pixelSize: 0.5, position: [10, 0, 2] });
    const result = execute(doc, 'image_to_world', {
      id,
      points: [
        [0, 0],
        [400, 200],
        [100, 50],
      ],
    });
    expectNoOp(result, doc);
    const data = result.data as WorldData;
    expect(data.unitsPerPixel).toBe(0.5);
    expect(data.world).toEqual([
      [10, 100, 2],
      [210, 0, 2],
      [60, 75, 2],
    ]);
    expect(data.xy).toEqual([
      [10, 100],
      [210, 0],
      [60, 75],
    ]);
    expect(result.summary).toContain('3 point(s)');
  });
  it('feeds extrude_profile directly', () => {
    const { doc, id } = withUnderlay();
    const { xy } = execute(doc, 'image_to_world', {
      id,
      points: [
        [0, 200],
        [100, 200],
        [100, 100],
      ],
    }).data as WorldData;
    const solid = execute(doc, 'extrude_profile', { profile: xy, depth: 5 });
    expect(solid.affected).toHaveLength(1);
  });
  it('rejects an empty point list and a non-image id', () => {
    const { doc, id } = withUnderlay();
    expectNoOp(execute(doc, 'image_to_world', { id, points: [] }), doc, 'give 1..');
    expectNoOp(execute(doc, 'image_to_world', { id: 'missing', points: [[0, 0]] }), doc);
  });
});

const PNG2 = pngDataUrl(200, 100);

function scene(): { doc: CadDocument; imageId: string } {
  let doc = createEmptyDocument();
  const image = execute(doc, 'add_image_underlay', { dataUrl: PNG2, position: [0, 0, 0] });
  doc = image.document;
  doc = execute(doc, 'add_box', { size: [20, 20, 20], position: [50, 50, 10] }).document;
  return { doc, imageId: image.affected[0]! };
}

const imageOf2 = (doc: CadDocument, id: string): ImageEntity => doc.entities[id] as ImageEntity;

describe('render_view with an underlay', () => {
  it('embeds the raster as an <image> with an affine transform, behind every polygon', () => {
    const { doc, imageId } = scene();
    const svg = (execute(doc, 'render_view', { mode: 'vector', view: 'top' }).data as { svg: string }).svg;
    const tag = svg.match(/<image [^>]*\/>/)?.[0] ?? '';
    expect(tag).toContain(`data-id="${imageId}"`);
    expect(tag).toContain(`href="${PNG2}"`);
    expect(tag).toContain('width="200" height="100"');
    expect(tag).toContain('opacity="0.5"');
    const matrix = /matrix\(([^)]*)\)/.exec(tag)?.[1]?.split(' ').map(Number) ?? [];
    expect(matrix).toHaveLength(6);
    // Top view, +y up on screen: pixel x → screen x (a > 0, b = 0), pixel y (down) → screen y (d > 0).
    const [a, b, c, d] = matrix as [number, number, number, number];
    expect(a).toBeGreaterThan(0);
    expect(b).toBeCloseTo(0, 6);
    expect(c).toBeCloseTo(0, 6);
    expect(d).toBeCloseTo(a, 6);
    expect(svg.indexOf('<image')).toBeLessThan(svg.indexOf('<polygon'));
  });
  it('frames the scene on the underlay bounds and labels it as an annotation', () => {
    const { doc } = scene();
    const result = execute(doc, 'render_view', { mode: 'vector', view: 'top', showLabels: true });
    const data = result.data as { bounds: { min: number[]; max: number[] }; svg: string };
    expect(data.bounds.max[0]).toBe(200);
    expect(data.bounds.max[1]).toBe(100);
    expect(data.svg).toContain('annotation');
  });
});

describe('image entity across the core switches', () => {
  it('has [0, width] × [0, height] local bounds that rotate with the plane', () => {
    const { doc, imageId } = scene();
    const image = imageOf2(doc, imageId);
    expect(localBounds(image)).toEqual({ min: [0, 0, 0], max: [200, 100, 0] });
    const turned = rotatedEntityBounds({ ...image, rotation: [0, 0, Math.PI / 2] });
    expect(turned.min[0]).toBeCloseTo(-100);
    expect(turned.max[1]).toBeCloseTo(200);
  });
  it('scale_entity scales the placed size (pixel size unchanged)', () => {
    const { doc, imageId } = scene();
    const scaled = execute(doc, 'scale_entity', { id: imageId, factor: 2 });
    expect(scaled.summary).toContain('new size 400×200');
    expect(imageOf2(scaled.document, imageId)).toMatchObject({ width: 400, height: 200, pixelWidth: 200 });
  });
  it('check_model flags a degenerate underlay', () => {
    const { doc, imageId } = scene();
    const broken = { ...doc, entities: { ...doc.entities, [imageId]: { ...imageOf2(doc, imageId), width: 0 } } };
    const issues = (execute(broken, 'check_model', {}).data as { issues: { entityId?: string }[] }).issues;
    expect(issues.some((issue) => issue.entityId === imageId)).toBe(true);
  });
  it('round-trips through save/load and rejects malformed saved underlays', () => {
    const { doc, imageId } = scene();
    const loaded = deserializeDocument(serializeDocument(doc));
    expect(imageOf2(loaded, imageId)).toEqual(imageOf2(doc, imageId));
    const image = imageOf2(doc, imageId);
    expect(validateEntityValue(image)).toBeNull();
    expect(validateEntityValue({ ...image, dataUrl: 'data:image/gif;base64,AAAA' })).toContain('dataUrl');
    expect(validateEntityValue({ ...image, dataUrl: 'x'.repeat(8_000_001) })).toContain('dataUrl');
    expect(validateEntityValue({ ...image, dataUrl: `data:image/png;base64,${'A'.repeat(8_000_000)}` })).toContain('exceeds');
    expect(validateEntityValue({ ...image, opacity: 2 })).toContain('opacity');
    expect(validateEntityValue({ ...image, locked: 'yes' })).toContain('locked');
    expect(validateEntityValue({ ...image, pixelWidth: 0 })).toContain('pixelWidth');
  });
  it('is skipped by solid exports, code export and DXF', () => {
    const { doc } = scene();
    const stl = execute(doc, 'export_stl', {}).data as { triangleCount: number };
    expect(stl.triangleCount).toBe(12);
    const code = execute(doc, 'export_code', { language: 'cadquery' }).data as { solidCount: number; text: string };
    expect(code.solidCount).toBe(1);
    expect(code.text).not.toContain('image');
    const onlyImage = execute(createEmptyDocument(), 'add_image_underlay', { dataUrl: PNG2 });
    expect(execute(onlyImage.document, 'export_building_dxf', {}).summary).toContain('nothing to export');
  });
  it('is filterable by kind and replays from history with the same calibration', () => {
    const { doc, imageId } = scene();
    const calibrated = execute(doc, 'calibrate_underlay', { id: imageId, pixelA: [0, 0], pixelB: [100, 0], distance: 25 }).document;
    const found = execute(calibrated, 'find_entities', { kind: 'image' }).data as { ids?: string[]; entities?: { id: string }[] };
    expect(JSON.stringify(found)).toContain(imageId);
    const replayed = execute(calibrated, 'replay_history', {}).document;
    expect(imageOf2(replayed, imageId)).toEqual(imageOf2(calibrated, imageId));
    expect(imageOf2(replayed, imageId).width).toBeCloseTo(50);
  });
});
