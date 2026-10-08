import { describe, expect, it } from 'vitest';
import {
  MAX_AFFECTED_IDS_SHOWN,
  MAX_CODE_TEXT_CHARS,
  MAX_JSON_TEXT_CHARS,
  shapeToolCallContent,
} from '@mcp/dispatch';

const ids = (count: number): string[] => Array.from({ length: count }, (_, i) => `box-${i}.1`);
const totalChars = (blocks: Array<{ text: string }>): number =>
  blocks.reduce((sum, block) => sum + block.text.length, 0);

describe('shapeToolCallContent size limits', () => {
  it('lists every affected id up to the cap, unchanged format', () => {
    const shaped = shapeToolCallContent({
      summary: 's',
      affected: ids(MAX_AFFECTED_IDS_SHOWN),
      isError: false,
    });
    expect(shaped.content[1]?.text.startsWith('Affected entity ids: box-0.1, ')).toBe(true);
    expect(shaped.content[1]?.text).not.toContain('more not listed');
  });

  it('keeps every affected id in structuredContent, with or without data', () => {
    const all = ids(5000);
    const noData = shapeToolCallContent({ summary: 's', affected: all, isError: false });
    expect(noData.structuredContent).toEqual({ affected: all });
    const withData = shapeToolCallContent({
      summary: 's',
      affected: all,
      isError: false,
      data: { created: 5000 },
    });
    expect(withData.structuredContent).toEqual({ created: 5000, affected: all });
    const wrapped = shapeToolCallContent({
      summary: 's',
      affected: all,
      isError: false,
      data: [1],
    });
    expect(wrapped.structuredContent).toEqual({ data: [1], affected: all });
  });

  it('adds no structuredContent for a small mutation, and keeps a data record own affected key', () => {
    expect(
      shapeToolCallContent({ summary: 's', affected: ids(3), isError: false }).structuredContent,
    ).toBeUndefined();
    const own = shapeToolCallContent({
      summary: 's',
      affected: ids(3),
      isError: false,
      data: { affected: 'mine' },
    });
    expect(own.structuredContent).toEqual({ affected: 'mine' });
  });

  it('shows only the first ids past the cap and says how many are missing', () => {
    const shaped = shapeToolCallContent({ summary: 's', affected: ids(5000), isError: false });
    const text = shaped.content[1]?.text ?? '';
    expect(text).toContain(`first ${MAX_AFFECTED_IDS_SHOWN} of 5000`);
    expect(text).toContain(`${5000 - MAX_AFFECTED_IDS_SHOWN} more not listed`);
    expect(text).toContain('box-0.1');
    expect(text).not.toContain('box-4999.1');
    expect(text.length).toBeLessThan(10_000);
  });

  it('keeps small data pretty-printed and complete', () => {
    const shaped = shapeToolCallContent({
      summary: 's',
      affected: [],
      isError: false,
      data: { a: 1 },
    });
    expect(shaped.content[1]?.text).toBe('```json\n{\n  "a": 1\n}\n```');
  });

  it('clips huge data in the text but keeps the full data in structuredContent', () => {
    const data = {
      entities: Array.from({ length: 20_000 }, (_, i) => ({ id: `e-${i}`, kind: 'box' })),
    };
    const shaped = shapeToolCallContent({ summary: 's', affected: [], isError: false, data });
    const text = shaped.content[1]?.text ?? '';
    expect(text.length).toBeLessThan(MAX_JSON_TEXT_CHARS + 500);
    expect(text).toMatch(/truncated \d+ of \d+ characters/);
    expect(text).toContain('structuredContent');
    expect(text.endsWith('```')).toBe(true);
    expect((shaped.structuredContent as typeof data).entities).toHaveLength(20_000);
  });

  it('bounds a 3000-entity-scale result to a small multiple of the caps', () => {
    const shaped = shapeToolCallContent({
      summary: 's',
      affected: ids(3000),
      isError: false,
      data: { stl: 'x'.repeat(11_000_000) },
    });
    expect(totalChars(shaped.content)).toBeLessThan(MAX_JSON_TEXT_CHARS + 12_000);
  });

  it('clips verbatim source code past its own, larger cap', () => {
    const small = shapeToolCallContent({
      summary: 's',
      affected: [],
      isError: false,
      data: { format: 'code', text: 'print(1)\n'.repeat(1000) },
    });
    expect(small.content[2]?.text).toBe('print(1)\n'.repeat(1000));
    const huge = 'x = 1\n'.repeat(MAX_CODE_TEXT_CHARS);
    const shaped = shapeToolCallContent({
      summary: 's',
      affected: [],
      isError: false,
      data: { format: 'code', text: huge },
    });
    const text = shaped.content[2]?.text ?? '';
    expect(text.length).toBeLessThan(MAX_CODE_TEXT_CHARS + 300);
    expect(text).toContain('structuredContent.text');
    expect((shaped.structuredContent as { text: string }).text).toBe(huge);
  });
});
