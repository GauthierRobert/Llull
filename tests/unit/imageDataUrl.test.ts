import { describe, expect, it } from 'vitest';
import { base64ToUint8Array, uint8ArrayToBase64 } from '@lib/base64';
import { parseImageDataUrl } from '@lib/imageDataUrl';
import { jpegBytes, jpegDataUrl, pngBytes, pngDataUrl } from '../helpers/imageFixtures';

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
    expect(parseImageDataUrl(pngDataUrl(640, 480))).toEqual({
      ok: true,
      mime: 'image/png',
      pixelWidth: 640,
      pixelHeight: 480,
    });
  });

  it('reads the JPEG SOF size past APP segments and fill bytes (jpg alias, progressive SOF2)', () => {
    expect(parseImageDataUrl(jpegDataUrl(1200, 800))).toMatchObject({
      ok: true,
      mime: 'image/jpeg',
      pixelWidth: 1200,
      pixelHeight: 800,
    });
    expect(parseImageDataUrl(dataUrl('image/jpg', jpegBytes(30, 20, 0xc2)))).toMatchObject({
      ok: true,
      pixelWidth: 30,
      pixelHeight: 20,
    });
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
