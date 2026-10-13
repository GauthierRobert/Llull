/** The `image` kind through the rest of the system: render_view, persistence, check, scale, bounds, exports, history. */

import { describe, expect, it } from 'vitest';
import { type CadDocument, type ImageEntity, createEmptyDocument } from '@core/model/types';
import { execute } from '@core/commands/registry';
import { deserializeDocument, serializeDocument } from '@core/commands/persistence/serialization';
import { validateEntityValue } from '@core/commands/persistence/guards';
import { localBounds } from '@core/geometry/bounds';
import { rotatedEntityBounds } from '@core/geometry/rotatedBounds';
import { pngDataUrl } from '../helpers/imageFixtures';

const PNG = pngDataUrl(200, 100);

function scene(): { doc: CadDocument; imageId: string } {
  let doc = createEmptyDocument();
  const image = execute(doc, 'add_image_underlay', { dataUrl: PNG, position: [0, 0, 0] });
  doc = image.document;
  doc = execute(doc, 'add_box', { size: [20, 20, 20], position: [50, 50, 10] }).document;
  return { doc, imageId: image.affected[0]! };
}

const imageOf = (doc: CadDocument, id: string): ImageEntity => doc.entities[id] as ImageEntity;

describe('render_view with an underlay', () => {
  it('embeds the raster as an <image> with an affine transform, behind every polygon', () => {
    const { doc, imageId } = scene();
    const svg = (execute(doc, 'render_view', { view: 'top' }).data as { svg: string }).svg;
    const tag = svg.match(/<image [^>]*\/>/)?.[0] ?? '';
    expect(tag).toContain(`data-id="${imageId}"`);
    expect(tag).toContain(`href="${PNG}"`);
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
    const result = execute(doc, 'render_view', { view: 'top', showLabels: true });
    const data = result.data as { bounds: { min: number[]; max: number[] }; svg: string };
    expect(data.bounds.max[0]).toBe(200);
    expect(data.bounds.max[1]).toBe(100);
    expect(data.svg).toContain('annotation');
  });
});

describe('image entity across the core switches', () => {
  it('has [0, width] × [0, height] local bounds that rotate with the plane', () => {
    const { doc, imageId } = scene();
    const image = imageOf(doc, imageId);
    expect(localBounds(image)).toEqual({ min: [0, 0, 0], max: [200, 100, 0] });
    const turned = rotatedEntityBounds({ ...image, rotation: [0, 0, Math.PI / 2] });
    expect(turned.min[0]).toBeCloseTo(-100);
    expect(turned.max[1]).toBeCloseTo(200);
  });

  it('scale_entity scales the placed size (pixel size unchanged)', () => {
    const { doc, imageId } = scene();
    const scaled = execute(doc, 'scale_entity', { id: imageId, factor: 2 });
    expect(scaled.summary).toContain('new size 400×200');
    expect(imageOf(scaled.document, imageId)).toMatchObject({
      width: 400,
      height: 200,
      pixelWidth: 200,
    });
  });

  it('check_model flags a degenerate underlay', () => {
    const { doc, imageId } = scene();
    const broken = {
      ...doc,
      entities: { ...doc.entities, [imageId]: { ...imageOf(doc, imageId), width: 0 } },
    };
    const issues = (execute(broken, 'check_model', {}).data as { issues: { entityId?: string }[] }).issues;
    expect(issues.some((issue) => issue.entityId === imageId)).toBe(true);
  });

  it('round-trips through save/load and rejects malformed saved underlays', () => {
    const { doc, imageId } = scene();
    const loaded = deserializeDocument(serializeDocument(doc));
    expect(imageOf(loaded, imageId)).toEqual(imageOf(doc, imageId));

    const image = imageOf(doc, imageId);
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
    const code = execute(doc, 'export_code', { language: 'cadquery' }).data as {
      solidCount: number;
      text: string;
    };
    expect(code.solidCount).toBe(1);
    expect(code.text).not.toContain('image');
    const onlyImage = execute(createEmptyDocument(), 'add_image_underlay', { dataUrl: PNG });
    expect(execute(onlyImage.document, 'export_dxf', {}).summary).toContain('nothing to export');
  });

  it('is filterable by kind and replays from history with the same calibration', () => {
    const { doc, imageId } = scene();
    const calibrated = execute(doc, 'calibrate_underlay', {
      id: imageId,
      pixelA: [0, 0],
      pixelB: [100, 0],
      distance: 25,
    }).document;
    const found = execute(calibrated, 'find_entities', { kind: 'image' }).data as {
      ids?: string[];
      entities?: { id: string }[];
    };
    expect(JSON.stringify(found)).toContain(imageId);
    const replayed = execute(calibrated, 'replay_history', {}).document;
    expect(imageOf(replayed, imageId)).toEqual(imageOf(calibrated, imageId));
    expect(imageOf(replayed, imageId).width).toBeCloseTo(50);
  });
});
