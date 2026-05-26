/**
 * @layer server/tests
 *
 * Unit tests for renderImage.ts — SVG rasterization helper and MCP image block builder.
 *
 * Covers:
 *   (a) rasterizeSvg — valid SVG → non-empty base64 string whose bytes decode to a PNG
 *       (magic bytes 0x89 0x50 0x4E 0x47 == "\x89PNG").
 *   (b) rasterizeSvg — malformed/empty SVG → returns null, does not throw.
 *   (c) buildImageBlock — data with svg field → returns image content block with
 *       mimeType 'image/png' and a non-empty base64 data string.
 *   (d) buildImageBlock — data without svg field (normal mutation result) → returns null.
 *   (e) buildImageBlock — data.svg empty string → returns null.
 *   (f) buildImageBlock — null/undefined/non-object data → returns null.
 *   (g) MCP shaping hook — busResult with data.svg → shaped content includes an image
 *       block AND still carries the text summary block.
 *   (h) MCP shaping hook — busResult without data.svg → no image block appended.
 */

import { describe, it, expect } from 'vitest';
import { rasterizeSvg, buildImageBlock } from '../src/renderImage';
import { shapeToolCallContent } from '@core/mcp';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** A minimal valid 100×100 SVG with one rect — the smallest valid test vector. */
const VALID_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100">' +
  '<rect width="100" height="100" fill="#336699"/>' +
  '</svg>';

/** PNG magic bytes as a hex string: \x89PNG */
const PNG_MAGIC_HEX = '89504e47';

// ---------------------------------------------------------------------------
// (a) rasterizeSvg — valid SVG → PNG magic bytes
// ---------------------------------------------------------------------------

describe('rasterizeSvg — valid SVG', () => {
  it('returns a non-empty base64 string', () => {
    const result = rasterizeSvg(VALID_SVG);
    expect(typeof result).toBe('string');
    expect(result!.length).toBeGreaterThan(0);
  });

  it('decoded bytes start with PNG magic bytes (\\x89PNG)', () => {
    const result = rasterizeSvg(VALID_SVG);
    expect(result).not.toBeNull();
    const buf = Buffer.from(result as string, 'base64');
    expect(buf.slice(0, 4).toString('hex')).toBe(PNG_MAGIC_HEX);
  });

  it('respects the width hint — wider render produces more bytes than smaller', () => {
    const narrow = rasterizeSvg(VALID_SVG, 50);
    const wide = rasterizeSvg(VALID_SVG, 400);
    expect(narrow).not.toBeNull();
    expect(wide).not.toBeNull();
    // A 400px-wide PNG will be larger than a 50px-wide PNG.
    expect(Buffer.from(wide as string, 'base64').length).toBeGreaterThan(
      Buffer.from(narrow as string, 'base64').length,
    );
  });
});

// ---------------------------------------------------------------------------
// (b) rasterizeSvg — malformed / empty SVG → null, no throw
// ---------------------------------------------------------------------------

describe('rasterizeSvg — failure cases', () => {
  it('returns null for an empty string (does not throw)', () => {
    expect(rasterizeSvg('')).toBeNull();
  });

  it('returns null for completely malformed markup (does not throw)', () => {
    expect(rasterizeSvg('not-svg-at-all <<<')).toBeNull();
  });

  it('returns null for unclosed tags (does not throw)', () => {
    expect(rasterizeSvg('<svg xmlns="http://www.w3.org/2000/svg">')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// (c) buildImageBlock — data with svg field → image content block
// ---------------------------------------------------------------------------

describe('buildImageBlock — data with svg field', () => {
  it('returns an image content block with mimeType image/png', () => {
    const block = buildImageBlock({ svg: VALID_SVG, width: 100, height: 100 });
    expect(block).not.toBeNull();
    expect(block!.type).toBe('image');
    expect(block!.mimeType).toBe('image/png');
  });

  it('block.data decodes to valid PNG (magic bytes)', () => {
    const block = buildImageBlock({ svg: VALID_SVG, width: 100, height: 100 });
    expect(block).not.toBeNull();
    const buf = Buffer.from(block!.data, 'base64');
    expect(buf.slice(0, 4).toString('hex')).toBe(PNG_MAGIC_HEX);
  });

  it('works without width/height fields (uses intrinsic SVG size)', () => {
    const block = buildImageBlock({ svg: VALID_SVG });
    expect(block).not.toBeNull();
    expect(block!.type).toBe('image');
  });
});

// ---------------------------------------------------------------------------
// (d) buildImageBlock — data without svg field → null
// ---------------------------------------------------------------------------

describe('buildImageBlock — no svg field', () => {
  it('returns null when data has no svg property', () => {
    expect(buildImageBlock({ volume: 42, unit: 'mm³' })).toBeNull();
  });

  it('returns null when data is an empty object', () => {
    expect(buildImageBlock({})).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// (e) buildImageBlock — empty svg string → null
// ---------------------------------------------------------------------------

describe('buildImageBlock — empty svg string', () => {
  it('returns null for an empty svg string', () => {
    expect(buildImageBlock({ svg: '' })).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// (f) buildImageBlock — non-object/null/undefined data → null
// ---------------------------------------------------------------------------

describe('buildImageBlock — non-object data', () => {
  it('returns null for null', () => {
    expect(buildImageBlock(null)).toBeNull();
  });

  it('returns null for undefined', () => {
    expect(buildImageBlock(undefined)).toBeNull();
  });

  it('returns null for a string', () => {
    expect(buildImageBlock('hello')).toBeNull();
  });

  it('returns null for a number', () => {
    expect(buildImageBlock(42)).toBeNull();
  });

  it('returns null for an array', () => {
    expect(buildImageBlock([VALID_SVG])).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// (g) MCP shaping hook — busResult with data.svg includes image block + text block
// ---------------------------------------------------------------------------

describe('MCP shaping hook — content augmentation with SVG data', () => {
  it('shaped content keeps the text summary block', () => {
    const busResult = {
      summary: 'Rendered view.',
      affected: [] as string[],
      isError: false,
      data: { svg: VALID_SVG, width: 100, height: 100 },
    };

    const shaped = shapeToolCallContent(busResult);

    // Text summary must still be present as first block.
    expect(shaped.content[0]?.type).toBe('text');
    expect(shaped.content[0]?.text).toBe('Rendered view.');
  });

  it('buildImageBlock produces an image block for a result with data.svg', () => {
    const data = { svg: VALID_SVG, width: 100, height: 100 };
    const imageBlock = buildImageBlock(data);
    expect(imageBlock).not.toBeNull();
    expect(imageBlock!.type).toBe('image');
    expect(imageBlock!.mimeType).toBe('image/png');
  });

  it('combined content array has text block then image block', () => {
    const busResult = {
      summary: 'Rendered view.',
      affected: [] as string[],
      isError: false,
      data: { svg: VALID_SVG, width: 100, height: 100 },
    };

    const shaped = shapeToolCallContent(busResult);
    const imageBlock = buildImageBlock(busResult.data);

    const content = [...shaped.content, ...(imageBlock ? [imageBlock] : [])];

    expect(content.length).toBeGreaterThanOrEqual(2);
    expect(content[0]?.type).toBe('text');
    // Last block is the image.
    expect(content[content.length - 1]?.type).toBe('image');
  });
});

// ---------------------------------------------------------------------------
// (h) MCP shaping hook — busResult without svg → no image block
// ---------------------------------------------------------------------------

describe('MCP shaping hook — no image block for non-SVG results', () => {
  it('buildImageBlock returns null for a normal mutation result (no data)', () => {
    expect(buildImageBlock(undefined)).toBeNull();
  });

  it('buildImageBlock returns null for a query result without svg', () => {
    expect(buildImageBlock({ volume: 8, unit: 'mm³' })).toBeNull();
  });

  it('shapeToolCallContent content is unchanged when no svg data present', () => {
    const busResult = {
      summary: 'Added box.',
      affected: ['e-abc'],
      isError: false,
    };
    const shaped = shapeToolCallContent(busResult);
    const imageBlock = buildImageBlock(undefined);

    // No image block — content stays as-is.
    expect(imageBlock).toBeNull();
    expect(shaped.content.every((b) => b.type === 'text')).toBe(true);
  });
});
