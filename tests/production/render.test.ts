import { describe, expect, it } from 'vitest';
import { encodePng } from '@lib/png';
import { createEmptyDocument } from '@core/model/types';
import { renderedViewCriteria } from './criteria/renderedViews';
import { gradeContext } from './grade';
import { readExrHeader } from './oracle/exr';
import { decodePng } from './oracle/png';
import { frameDeliverable, renderIntent, viewDeliverable } from './render/intent';

/**
 * The visualisation scenario's criteria and file readers without the native path tracer (the scenario itself needs llull-compute and runs in
 * `npm run production:scripted`): synthetic pictures stand in for the issued renders.
 */

const { width, height } = renderIntent;

/** A picture with a bright square whose position follows `phase` (0..1) around the frame, like a model seen from a turning camera. */
function picture(phase: number, blank = false): Uint8Array {
  const rgba = new Uint8Array(width * height * 4);
  const cx = Math.round(width / 2 + Math.cos(2 * Math.PI * phase) * width * 0.3);
  const cy = Math.round(height / 2 + Math.sin(2 * Math.PI * phase) * height * 0.3);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const inside = !blank && Math.abs(x - cx) < 40 && Math.abs(y - cy) < 40;
      rgba.set(inside ? [230, 200, 60, 255] : [90, 110, 140, 255], 4 * (y * width + x));
    }
  return encodePng(width, height, rgba, true);
}

/** The header of an RGBA half EXR of the given size (what readExrHeader reads; no pixels). */
function exrHeader(w: number, h: number): Uint8Array {
  const parts: Buffer[] = [Buffer.from([0x76, 0x2f, 0x31, 0x01, 2, 0, 0, 0])];
  const attribute = (name: string, type: string, value: Buffer): void => {
    const size = Buffer.alloc(4);
    size.writeInt32LE(value.length);
    parts.push(Buffer.from(`${name}\0${type}\0`, 'latin1'), size, value);
  };
  const channels = Buffer.concat(
    ['A', 'B', 'G', 'R'].map((name) =>
      Buffer.concat([Buffer.from(`${name}\0`), Buffer.from([1, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0])]),
    ),
  );
  attribute('channels', 'chlist', Buffer.concat([channels, Buffer.from([0])]));
  attribute('compression', 'compression', Buffer.from([0]));
  const box = Buffer.alloc(16);
  [0, 0, w - 1, h - 1].forEach((value, index) => box.writeInt32LE(value, index * 4));
  attribute('dataWindow', 'box2i', box);
  parts.push(Buffer.from([0]));
  return new Uint8Array(Buffer.concat(parts));
}

const base64 = (bytes: Uint8Array): string => Buffer.from(bytes).toString('base64');

function renders(options: { blankViews?: boolean; shuffledFrames?: boolean } = {}): Record<string, string> {
  const provenance = {
    illustration: true,
    deterministic: true,
    seed: renderIntent.seed,
    samples: renderIntent.samples,
    device: 'cpu',
    version: 'test',
  };
  const provided: Record<string, string> = {};
  renderIntent.views.forEach((view, index) => {
    const files = [
      { name: 'render.png', base64: base64(picture(index / renderIntent.views.length, options.blankViews === true)) },
      { name: 'render.exr', base64: base64(exrHeader(width, height)) },
    ];
    provided[viewDeliverable(view)] = JSON.stringify({ ...provenance, files });
  });
  const n = renderIntent.turntable.frames;
  for (let frame = 0; frame < n; frame++) {
    const phase = options.shuffledFrames === true ? ((frame * 5) % n) / n : frame / n;
    provided[frameDeliverable(frame)] = JSON.stringify({ ...provenance, files: [{ name: 'render.png', base64: base64(picture(phase)) }] });
  }
  return provided;
}

function outcome(id: string, provided: Record<string, string>): { pass: boolean; detail: string } {
  const criterion = renderedViewCriteria(renderIntent).find((c) => c.id === id);
  if (criterion === undefined) throw new Error(id);
  return criterion.check(gradeContext(createEmptyDocument(), createEmptyDocument(), provided));
}

describe('visualisation scenario criteria (synthetic renders)', () => {
  it('reads back PNG and EXR headers independently', () => {
    const image = decodePng(picture(0));
    expect([image.width, image.height]).toEqual([width, height]);
    expect(decodePng(encodePng(2, 1, new Uint8Array([255, 0, 0, 255, 0, 0, 255, 255]))).luma[0]).toBeCloseTo(0.2126 * 255, 6);
    expect(readExrHeader(exrHeader(7, 5))).toMatchObject({ width: 7, height: 5, channels: { R: 1, G: 1, B: 1, A: 1 } });
    expect(() => decodePng(new Uint8Array(8))).toThrow(/signature/);
    expect(() => readExrHeader(new Uint8Array(8))).toThrow(/magic/);
  });

  it('passes six distinct views, an ordered turntable and full provenance', () => {
    const provided = renders();
    for (const id of ['rendered-views', 'views-distinct', 'turntable', 'render-provenance'])
      expect(outcome(id, provided).pass, id).toBe(true);
  });

  it('fails blank views, a shuffled turntable and a missing render', () => {
    expect(outcome('rendered-views', renders({ blankViews: true })).detail).toMatch(/blank/);
    expect(outcome('views-distinct', renders({ blankViews: true })).pass).toBe(false);
    expect(outcome('turntable', renders({ shuffledFrames: true })).pass).toBe(false);
    const missing = { ...renders(), [frameDeliverable(3)]: JSON.stringify({ error: 'NATIVE_TOOL_MISSING: no path tracer' }) };
    expect(outcome('turntable', missing).detail).toMatch(/NATIVE_TOOL_MISSING/);
    expect(outcome('render-provenance', missing).pass).toBe(false);
  });

  it('grades the appearance library and its coverage on the document', () => {
    const empty = gradeContext(createEmptyDocument());
    const library = renderedViewCriteria(renderIntent).find((c) => c.id === 'appearance-library');
    expect(library?.check(empty).pass).toBe(false);
    const coverage = renderedViewCriteria(renderIntent).find((c) => c.id === 'appearance-coverage');
    expect(coverage?.check(empty).detail).toMatch(/no plant element/);
  });
});
