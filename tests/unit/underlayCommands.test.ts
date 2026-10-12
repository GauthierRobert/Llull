import { describe, expect, it } from 'vitest';
import { type CadDocument, type ImageEntity, createEmptyDocument } from '@core/model/types';
import { execute } from '@core/commands/registry';
import { MAX_IMAGE_DATA_URL_LENGTH } from '@core/commands/limits';
import { expectNoOp } from '../helpers/expectNoOp';
import { jpegDataUrl, pngDataUrl } from '../helpers/imageFixtures';

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
    const result = execute(createEmptyDocument(), 'add_image_underlay', {
      dataUrl: PNG,
      name: 'pump section',
    });
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
    const byPixel = withUnderlay({
      pixelSize: 1.5,
      position: [5, 6, 7],
      rotation: [0, 0, 0.25],
      opacity: 0.8,
      locked: true,
    });
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
    const result = execute(createEmptyDocument(), 'add_image_underlay', {
      dataUrl: jpegDataUrl(64, 32),
    });
    expect(imageOf(result.document, result.affected[0]!)).toMatchObject({
      pixelWidth: 64,
      pixelHeight: 32,
    });
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
    const snapshot = JSON.stringify(doc);
    execute(doc, 'add_image_underlay', { dataUrl: PNG });
    expect(JSON.stringify(doc)).toBe(snapshot);
  });
});

describe('calibrate_underlay', () => {
  it('sets the scale from two pixel points and a real distance', () => {
    const { doc, id } = withUnderlay();
    const result = execute(doc, 'calibrate_underlay', {
      id,
      pixelA: [100, 100],
      pixelB: [300, 100],
      distance: 300,
    });
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
    const snapshot = JSON.stringify(doc);
    execute(doc, 'calibrate_underlay', { id, pixelA: [0, 0], pixelB: [1, 1], distance: 2 });
    expect(JSON.stringify(doc)).toBe(snapshot);
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
    expectNoOp(
      execute(doc, 'set_underlay', { id: 'x', opacity: 0.1 }),
      doc,
      "entity 'x' not found",
    );
    expectNoOp(execute(doc, 'set_underlay', { id }), doc, 'give opacity and/or locked');
    expectNoOp(execute(doc, 'set_underlay', { id, opacity: -1 }), doc, 'opacity must be');
  });

  it('is pure', () => {
    const { doc, id } = withUnderlay();
    const snapshot = JSON.stringify(doc);
    execute(doc, 'set_underlay', { id, opacity: 1 });
    expect(JSON.stringify(doc)).toBe(snapshot);
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
    expect(result.document).toBe(doc);
    expect(result.affected).toEqual([]);
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
