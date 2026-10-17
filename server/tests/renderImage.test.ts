import { describe, it, expect } from 'vitest';
import { sanitizeSvgForResvg, rasterizeSvg, buildImageBlock, stripSvgFromData, MAX_RASTER_PX } from '../src/renderImage';
import { shapeToolCallContent } from '@mcp/index';

const VALID_SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100"><rect width="100" height="100" fill="#336699"/></svg>';
const PNG_MAGIC_HEX = '89504e47';
const isPng = (base64: string): boolean => Buffer.from(base64, 'base64').subarray(0, 4).toString('hex') === PNG_MAGIC_HEX;
const pngSize = (base64: string): { width: number; height: number } => {
  const bytes = Buffer.from(base64, 'base64');
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
};
const shaped = (data?: unknown): ReturnType<typeof shapeToolCallContent> =>
  shapeToolCallContent({ summary: 'Rendered view.', affected: [], isError: false, ...(data !== undefined ? { data } : {}) });

describe('rasterizeSvg', () => {
  it('returns a non-empty base64 PNG; a wider hint renders more bytes', () => {
    const result = rasterizeSvg(VALID_SVG);
    expect(typeof result).toBe('string');
    expect(result!.length).toBeGreaterThan(0);
    expect(isPng(result!)).toBe(true);
    const narrow = rasterizeSvg(VALID_SVG, 50);
    const wide = rasterizeSvg(VALID_SVG, 400);
    expect(Buffer.from(wide!, 'base64').length).toBeGreaterThan(Buffer.from(narrow!, 'base64').length);
  });

  it('keeps a width within the cap and scales enormous sizes down to MAX_RASTER_PX, keeping the aspect', () => {
    expect(pngSize(rasterizeSvg(VALID_SVG, 400)!)).toEqual({ width: 400, height: 400 });
    expect(pngSize(rasterizeSvg(VALID_SVG, 1_000_000)!)).toEqual({ width: MAX_RASTER_PX, height: MAX_RASTER_PX });
    const tall = '<svg xmlns="http://www.w3.org/2000/svg" width="100" height="400"><rect width="100" height="400"/></svg>';
    expect(pngSize(rasterizeSvg(tall, 100_000)!)).toEqual({ width: MAX_RASTER_PX / 4, height: MAX_RASTER_PX });
    const huge = '<svg xmlns="http://www.w3.org/2000/svg" width="200000" height="100000"><rect width="10" height="10"/></svg>';
    expect(pngSize(rasterizeSvg(huge)!)).toEqual({ width: MAX_RASTER_PX, height: MAX_RASTER_PX / 2 });
  });

  it.each(['', 'not-svg-at-all <<<', '<svg xmlns="http://www.w3.org/2000/svg">'])('returns null (no throw) for %j', (svg) => {
    expect(rasterizeSvg(svg)).toBeNull();
  });
});

describe('rasterizeSvg on content that aborts resvg', () => {
  // A <g opacity> layer lying entirely outside the canvas (a zoomed-in render_view's ground grid) is a Rust panic = process abort.
  const OFFSCREEN_GROUP =
    '<svg xmlns="http://www.w3.org/2000/svg" width="800" height="600"><rect width="800" height="600" fill="#123"/>' +
    '<g opacity="0.18" stroke="#88aacc" stroke-width="0.8"><line x1="-2430" y1="2551" x2="-2430" y2="-1951"/></g></svg>';

  it('rasterizes it (group opacity rewritten) and keeps the process alive', () => {
    const png = rasterizeSvg(OFFSCREEN_GROUP);
    expect(png).not.toBeNull();
    expect(isPng(png!)).toBe(true);
    expect(sanitizeSvgForResvg(OFFSCREEN_GROUP)).toContain('<g stroke-opacity="0.18" fill-opacity="0.18" stroke="#88aacc"');
  });

  it('leaves svg without group opacity untouched', () => {
    expect(sanitizeSvgForResvg(VALID_SVG)).toBe(VALID_SVG);
  });
});

describe('buildImageBlock', () => {
  it.each([{ svg: VALID_SVG, width: 100, height: 100 }, { svg: VALID_SVG }])('builds an image/png block from %#', (data) => {
    const block = buildImageBlock(data);
    expect(block!.type).toBe('image');
    expect(block!.mimeType).toBe('image/png');
    expect(isPng(block!.data)).toBe(true);
  });

  it.each([{ volume: 42, unit: 'mm³' }, {}, { svg: '' }, null, undefined, 'hello', 42, [VALID_SVG]])('returns null for %j', (data) => {
    expect(buildImageBlock(data)).toBeNull();
  });
});

describe('stripSvgFromData', () => {
  it('removes svg, keeps every other field, does not mutate', () => {
    const data = {
      svg: VALID_SVG,
      width: 800,
      height: 600,
      bounds: { minX: 0, maxX: 10 },
      camera: { position: [0, 0, 5] },
      entityCount: 3,
    };
    const stripped = stripSvgFromData(data) as Record<string, unknown>;
    expect('svg' in stripped).toBe(false);
    expect(stripped).toEqual({ ...data, svg: undefined });
    expect('svg' in data).toBe(true);
    expect(stripSvgFromData({})).toEqual({});
  });

  it.each([null, undefined, ['a', 'b'], 'hello'])('returns %j unchanged', (value) => {
    expect(stripSvgFromData(value)).toBe(value);
  });
});

describe('MCP content shaping', () => {
  it('stripped render data: no markup in text, metadata kept in json and structuredContent', () => {
    const result = shaped(stripSvgFromData({ svg: VALID_SVG, width: 800, height: 600, entityCount: 5, view: 'top' }));
    for (const block of result.content) expect(block.text).not.toMatch(/<svg|<polygon|<rect/i);
    const json = result.content.find((b) => b.text.startsWith('```json'))!.text;
    for (const key of ['"width"', '"height"', '"entityCount"', '"view"']) expect(json).toContain(key);
    expect(json).not.toContain('"svg"');
    expect('svg' in result.structuredContent!).toBe(false);
    expect(result.structuredContent!['width']).toBe(800);
    expect(result.structuredContent!['entityCount']).toBe(5);
  });

  it('an svg result keeps its text summary first; the image block goes last', () => {
    const data = { svg: VALID_SVG, width: 100, height: 100 };
    const result = shaped(data);
    expect(result.content[0]?.type).toBe('text');
    expect(result.content[0]?.text).toBe('Rendered view.');
    const content = [...result.content, buildImageBlock(data)!];
    expect(content.length).toBeGreaterThanOrEqual(2);
    expect(content.at(-1)?.type).toBe('image');
  });

  it('a non-svg result is shaped as plain text blocks', () => {
    const result = shapeToolCallContent({ summary: 'Added box e-001.', affected: ['e-001'], isError: false });
    expect(result.content[0]!.text).toBe('Added box e-001.');
    expect(result.content[1]!.text).toBe('Affected entity ids: e-001');
    expect(result.structuredContent).toBeUndefined();
    expect(result.content.every((b) => b.type === 'text')).toBe(true);
  });
});
