import { describe, expect, it } from 'vitest';
import type { Vec3 } from '@core/model/types';
import { calibrateUnderlay, pixelToLocal, pixelToWorld, underlayCorners, type UnderlayPlacement } from '@core/geometry/imageUnderlay';
import { base64ToUint8Array, uint8ArrayToBase64 } from '@lib/base64';
import { parseImageDataUrl } from '@lib/imageDataUrl';
import { jpegBytes, jpegDataUrl, pngBytes, pngDataUrl } from '../helpers/imageFixtures';

/** 200×100 px image at 1 unit/px, lower-left at [10, 20, 0]. */
const BASE: UnderlayPlacement = { position: [10, 20, 0], rotation: [0, 0, 0], width: 200, height: 100, pixelWidth: 200, pixelHeight: 100 };

const expectClose = (actual: readonly number[], expected: readonly number[]): void => {
  expect(actual).toHaveLength(expected.length);
  actual.forEach((value, i) => expect(value).toBeCloseTo(expected[i] ?? NaN, 9));
};

const distance = (a: Vec3, b: Vec3): number => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

describe('pixel → local → world', () => {
  it('flips pixel y (top-left origin, +y down) into the work plane (+y up)', () => {
    expectClose(pixelToLocal(BASE, [0, 0]), [0, 100]);
    expectClose(pixelToLocal(BASE, [200, 100]), [200, 0]);
    expectClose(pixelToLocal({ ...BASE, width: 400 }, [50, 25]), [100, 75]);
  });
  it('offsets by position and applies the in-plane rotation about the lower-left corner', () => {
    expectClose(pixelToWorld(BASE, [0, 100]), [10, 20, 0]);
    const turned = { ...BASE, rotation: [0, 0, Math.PI / 2] as Vec3 };
    // local [200, 0] (bottom-right) rotated +90° → [0, 200]
    expectClose(pixelToWorld(turned, [200, 100]), [10, 220, 0]);
  });
  it('lifts a plane rotated about X into Z', () => {
    const vertical = { ...BASE, rotation: [Math.PI / 2, 0, 0] as Vec3 };
    expectClose(pixelToWorld(vertical, [0, 0]), [10, 20, 100]);
  });
  it('lists the corners in pixel order', () => {
    const corners = underlayCorners(BASE);
    expectClose(corners.flat(), [10, 120, 0, 210, 120, 0, 210, 20, 0, 10, 20, 0]);
  });
});

describe('calibrateUnderlay', () => {
  it('scales uniformly so the pixel segment measures `distance`, keeping pixelA fixed', () => {
    const before = pixelToWorld(BASE, [20, 50]);
    const result = calibrateUnderlay(BASE, { pixelA: [20, 50], pixelB: [120, 50], distance: 150 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.unitsPerPixel).toBeCloseTo(1.5);
    expect(result.pixelDistance).toBeCloseTo(100);
    expect(result.placement.width).toBeCloseTo(300);
    expect(result.placement.height).toBeCloseTo(150);
    expectClose(pixelToWorld(result.placement, [20, 50]), before);
    const a = pixelToWorld(result.placement, [20, 50]);
    const b = pixelToWorld(result.placement, [120, 50]);
    expect(distance(a, b)).toBeCloseTo(150);
  });
  it('pins an origin pixel to a world point', () => {
    const result = calibrateUnderlay(BASE, {
      pixelA: [0, 0],
      pixelB: [0, 40],
      distance: 20,
      origin: { pixel: [100, 50], world: [0, 0, 0] },
    });
    if (!result.ok) throw new Error(result.error);
    expectClose(pixelToWorld(result.placement, [100, 50]), [0, 0, 0]);
    expectClose(pixelToWorld(result.placement, [140, 50]), [20, 0, 0]);
  });
  it('de-skews a crooked scan: A→B ends up along +x by the smallest turn', () => {
    const skew = (5 * Math.PI) / 180;
    // In pixels (+y down) a segment rising 5° to the right has dy < 0.
    const pixelB: [number, number] = [100 * Math.cos(skew), 50 - 100 * Math.sin(skew)];
    const result = calibrateUnderlay(BASE, { pixelA: [0, 50], pixelB, distance: 10, align: 'x' });
    if (!result.ok) throw new Error(result.error);
    expect(result.placement.rotation[2]).toBeCloseTo(-skew);
    const a = pixelToWorld(result.placement, [0, 50]);
    const b = pixelToWorld(result.placement, pixelB);
    expect(b[1] - a[1]).toBeCloseTo(0, 9);
    expect(b[0] - a[0]).toBeCloseTo(10, 9);
  });
  it('aligns with y, and treats a reversed segment as the same axis (no half turn)', () => {
    const toY = calibrateUnderlay(BASE, { pixelA: [0, 0], pixelB: [10, 0], distance: 10, align: 'y' });
    if (!toY.ok) throw new Error(toY.error);
    expect(toY.placement.rotation[2]).toBeCloseTo(Math.PI / 2);
    const reversed = calibrateUnderlay(BASE, { pixelA: [10, 0], pixelB: [0, 0], distance: 10, align: 'x' });
    if (!reversed.ok) throw new Error(reversed.error);
    expect(reversed.placement.rotation[2]).toBe(0);
  });
  it('keeps rx/ry and the in-plane angle when align is not given', () => {
    const tilted = { ...BASE, rotation: [0.3, 0.2, 0.1] as Vec3 };
    const result = calibrateUnderlay(tilted, { pixelA: [0, 0], pixelB: [3, 4], distance: 10 });
    if (!result.ok) throw new Error(result.error);
    expect(result.placement.rotation).toEqual([0.3, 0.2, 0.1]);
    expect(distance(pixelToWorld(result.placement, [0, 0]), pixelToWorld(result.placement, [3, 4]))).toBeCloseTo(10);
  });
  it.each([
    [{ pixelA: [0, 0], pixelB: [0, 0], distance: 10 }, 'two different pixels'],
    [{ pixelA: [0, 0], pixelB: [1, 0], distance: 0 }, 'distance must be'],
    [{ pixelA: [0, 0], pixelB: [1, 0], distance: Number.NaN }, 'distance must be'],
  ] as const)('fails on %j', (calibration, message) => {
    const result = calibrateUnderlay(BASE, calibration);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain(message);
  });
});

const dataUrl = (mime: string, bytes: Uint8Array): string => `data:${mime};base64,${uint8ArrayToBase64(bytes)}`;

describe('base64ToUint8Array', () => {
  it('inverts uint8ArrayToBase64 for every padding length', () => {
    for (const length of [0, 1, 2, 3, 4, 5, 64]) {
      const bytes = Uint8Array.from({ length }, (_, i) => (i * 37 + 11) & 255);
      expect(base64ToUint8Array(uint8ArrayToBase64(bytes))).toEqual(bytes);
    }
  });
  it('rejects bad length, foreign characters, and padding in the middle', () => {
    expect(base64ToUint8Array('abc')).toBeNull();
    expect(base64ToUint8Array('ab$d')).toBeNull();
    expect(base64ToUint8Array('abéd')).toBeNull();
    expect(base64ToUint8Array('a=bcdefg')).toBeNull();
  });
});

describe('parseImageDataUrl', () => {
  it('reads the PNG IHDR size', () => {
    expect(parseImageDataUrl(pngDataUrl(640, 480))).toEqual({ ok: true, mime: 'image/png', pixelWidth: 640, pixelHeight: 480 });
  });
  it('reads the JPEG SOF size past APP segments and fill bytes (jpg alias, progressive SOF2)', () => {
    expect(parseImageDataUrl(jpegDataUrl(1200, 800))).toMatchObject({ ok: true, mime: 'image/jpeg', pixelWidth: 1200, pixelHeight: 800 });
    expect(parseImageDataUrl(dataUrl('image/jpg', jpegBytes(30, 20, 0xc2)))).toMatchObject({ ok: true, pixelWidth: 30, pixelHeight: 20 });
  });
  it('skips standalone markers before the frame', () => {
    const bytes = jpegBytes(5, 7);
    const withRst = Uint8Array.from([0xff, 0xd8, 0xff, 0xd0, ...bytes.slice(2)]);
    expect(parseImageDataUrl(dataUrl('image/jpeg', withRst))).toMatchObject({ ok: true });
  });
  it.each([
    ['a gif', 'data:image/gif;base64,R0lGODlh', 'must start with'],
    ['a url', 'https://example.com/a.png', 'must start with'],
    ['invalid base64', 'data:image/png;base64,***', 'not valid base64'],
    ['a jpeg labelled png', dataUrl('image/png', jpegBytes(4, 4)), 'not a readable image/png'],
    ['a png labelled jpeg', dataUrl('image/jpeg', pngBytes(4, 4)), 'not a readable image/jpeg'],
    ['a zero-size png', pngDataUrl(0, 10), 'zero pixel size'],
  ])('rejects %s', (_label, url, message) => {
    const parsed = parseImageDataUrl(url);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.error).toContain(message);
  });
  it('rejects JPEG streams with no frame header or broken segments', () => {
    const scanFirst = Uint8Array.from([0xff, 0xd8, 0xff, 0xda, 0, 2, 0xff, 0xd9]);
    const garbage = Uint8Array.from([0xff, 0xd8, 0x00, 0x00, 0, 0]);
    const truncatedSof = jpegBytes(4, 4).slice(0, 25);
    const noFrame = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0, 2]);
    for (const bytes of [scanFirst, garbage, truncatedSof, noFrame]) expect(parseImageDataUrl(dataUrl('image/jpeg', bytes)).ok).toBe(false);
  });
});
