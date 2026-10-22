import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { setFontProvider } from '@core/commands/fontPort';
import { execute } from '@core/commands/registry';
import { deserializeDocument, serializeDocument } from '@core/commands/persistence/serialization';
import { setGeometryKernel } from '@core/geometry/kernel';
import { uint8ArrayToBase64 } from '@lib/base64';
import { createEmptyDocument, type CadDocument, type TextEntity } from '@core/model/types';
import { createManifoldKernel } from '@kernel-manifold/manifoldKernel';
import { apply, data, expectRefusal, ok } from '../../helpers/commandAssertions';
import { expectNoOp, expectPure } from '../../helpers/expectNoOp';
import { firaBytes, firaProvider, FIRA_SHA256, glyphReferences, textReferences, withFsType } from './fixtures';

const empty = (): CadDocument => ({ ...createEmptyDocument(), units: 'mm' });
const firaBase64 = (): string => uint8ArrayToBase64(firaBytes());

beforeEach(() => setFontProvider(firaProvider()));
afterEach(() => {
  setFontProvider(null);
  setGeometryKernel(null);
});

const withFira = (): { doc: CadDocument; fontId: string } => {
  const result = ok(empty(), 'import_font', { base64: firaBase64(), sourceSha256: FIRA_SHA256 });
  return { doc: result.document, fontId: result.affected[0] as string };
};

const addLabel = (doc: CadDocument, content: string, extra: Record<string, unknown> = {}): { doc: CadDocument; id: string } => {
  const result = ok(doc, 'add_text', { content, position: [0, 0, 0], height: 10, anchor: 'center', font: 'Fira Sans', ...extra });
  return { doc: result.document, id: result.affected[0] as string };
};

describe('import_font / list_fonts (VC-WRP-19, 20)', () => {
  it('embeds Fira Sans with its metrics, provenance and a font/ttf blob keyed by the raw sha256', () => {
    const result = ok(empty(), 'import_font', {
      base64: firaBase64(),
      sourceSha256: FIRA_SHA256,
      path: 'fixtures/wrp/FiraSans-Regular.ttf',
    });
    const [id] = result.affected;
    const record = result.document.fonts?.[id as string];
    expect(record).toMatchObject({
      family: 'Fira Sans',
      style: 'Regular',
      unitsPerEm: 1000,
      capHeight: 689,
      capHeightSource: 'os2',
      embedding: 'installable',
    });
    expect(record?.provenance.verified).toBe(true);
    expect(record?.blob).toBe(FIRA_SHA256);
    const blob = result.document.blobs?.[FIRA_SHA256];
    expect(blob?.mediaType).toBe('font/ttf');
    expect(blob?.size).toBe(firaBytes().length);
    expect(result.data).toMatchObject({ id, glyphs: 2708, bytes: 456996, unverified: false, existing: false });
  });

  it('marks an unpinned font unverified, and returns the first record when the same bytes are imported twice', () => {
    const first = ok(empty(), 'import_font', { base64: firaBase64() });
    expect(first.data).toMatchObject({ unverified: true });
    const again = ok(first.document, 'import_font', { base64: firaBase64() });
    expect(again.affected).toEqual(first.affected);
    expect(again.data).toMatchObject({ existing: true });
    expect(Object.keys(again.document.fonts ?? {})).toHaveLength(1);
  });

  it('refuses a sha256 mismatch, bad base64, no bytes, non-fonts, unsupported formats, restricted embedding and oversize files', () => {
    const doc = empty();
    expectRefusal(doc, 'import_font', { base64: firaBase64(), sourceSha256: '00'.repeat(32) }, 'WRP_FONT_PARSE', 'sourceSha256');
    expectRefusal(doc, 'import_font', { base64: '***' }, 'WRP_FONT_PARSE', 'base64');
    expectRefusal(doc, 'import_font', {}, 'WRP_FONT_PARSE', 'base64');
    expectRefusal(
      doc,
      'import_font',
      { base64: uint8ArrayToBase64(new TextEncoder().encode('not a font at all, just some text')) },
      'WRP_FONT_PARSE',
    );
    expectRefusal(
      doc,
      'import_font',
      { base64: uint8ArrayToBase64(new TextEncoder().encode('OTTO and the rest of a CFF font file....')) },
      'WRP_FONT_FORMAT_UNSUPPORTED',
    );
    expectRefusal(doc, 'import_font', { base64: uint8ArrayToBase64(withFsType(firaBytes(), 2)) }, 'WRP_FONT_EMBEDDING_RESTRICTED');
    expectRefusal(doc, 'import_font', { base64: uint8ArrayToBase64(new Uint8Array(4 * 1024 * 1024 + 1)) }, 'WRP_FONT_TOO_LARGE');
  });

  it('lists bundled fonts and the document fonts, and is pure', () => {
    const { doc } = withFira();
    const listed = data<{ fonts: Array<{ id: string; source: string; verified: boolean; family: string }> }>(doc, 'list_fonts', {});
    expect(listed.fonts.map((font) => font.source)).toEqual(['bundled', 'document']);
    expect(listed.fonts.every((font) => font.family === 'Fira Sans' && font.verified)).toBe(true);
    setFontProvider(null);
    expect(data<{ fonts: unknown[] }>(empty(), 'list_fonts', {}).fonts).toEqual([]);
    expectPure(doc, () => execute(doc, 'list_fonts', {}));
    expectPure(empty(), () => execute(empty(), 'import_font', { base64: firaBase64() }));
  });

  it('survives save and reload without the font file (VC-WRP-19)', () => {
    const { doc } = withFira();
    const { doc: withText, id } = addLabel(doc, 'LLULL', { font: 'Fira Sans' });
    const before = data<{ area: number }>(withText, 'text_outline', { id });
    setFontProvider(null);
    const reopened = deserializeDocument(serializeDocument(withText));
    expect(reopened.blobs?.[FIRA_SHA256]?.mediaType).toBe('font/ttf');
    expect(data<{ area: number }>(reopened, 'text_outline', { id }).area).toBe(before.area);
  });

  it('refuses a document whose font record has no font blob', () => {
    const { doc } = withFira();
    const broken = JSON.parse(serializeDocument(doc)) as { document: { blobs?: unknown } };
    delete broken.document.blobs;
    expect(() => deserializeDocument(JSON.stringify(broken))).toThrow(/WRP_FONT_UNAVAILABLE/);
    const tampered = JSON.parse(serializeDocument(doc)) as { document: { blobs: Record<string, { bytes: string }> } };
    (tampered.document.blobs[FIRA_SHA256] as { bytes: string }).bytes = 'AAAA';
    expect(() => deserializeDocument(JSON.stringify(tampered))).toThrow(/KRN_BLOB_HASH_MISMATCH/);
  });
});

describe('add_text with a font (VC-WRP-21)', () => {
  it('embeds the bundled font on first use by family name and reuses it afterwards', () => {
    const first = addLabel(empty(), 'LLULL');
    const text = first.doc.entities[first.id] as TextEntity;
    expect(Object.keys(first.doc.fonts ?? {})).toEqual([text.font]);
    expect(first.doc.fonts?.[text.font as string]?.provenance).toEqual({
      verified: true,
      source: expect.stringContaining('bundled:fira-sans-regular'),
    });
    const second = addLabel(first.doc, 'WRAP', { font: 'fira sans regular' });
    expect((second.doc.entities[second.id] as TextEntity).font).toBe(text.font);
    expect(Object.keys(second.doc.fonts ?? {})).toHaveLength(1);
  });

  it('takes a record id from import_font and stores the layout fields', () => {
    const { doc, fontId } = withFira();
    const { doc: next, id } = addLabel(doc, 'LL', {
      font: fontId,
      verticalAnchor: 'cap_middle',
      letterSpacing: 1,
      kerning: false,
      lineSpacing: 1.5,
    });
    expect(next.entities[id]).toMatchObject({
      font: fontId,
      verticalAnchor: 'cap_middle',
      letterSpacing: 1,
      kerning: false,
      lineSpacing: 1.5,
    });
  });

  it('reports unmapped characters as a warning and still creates the text', () => {
    const result = ok(empty(), 'add_text', { content: 'A\u{1F600}', position: [0, 0, 0], height: 10, font: 'Fira Sans' });
    expect(result.affected).toHaveLength(1);
    expect(result.summary).toContain('WRP_GLYPH_MISSING');
    expect(result.data).toMatchObject({ warnings: [{ code: 'WRP_GLYPH_MISSING', characters: ['\u{1F600}'] }] });
  });

  it('refuses an unknown font and an over-long text, and keeps annotations without a font unchanged', () => {
    expectRefusal(
      empty(),
      'add_text',
      { content: 'x', position: [0, 0, 0], height: 10, font: 'Comic Nowhere' },
      'WRP_FONT_UNAVAILABLE',
      'font',
    );
    expectRefusal(
      empty(),
      'add_text',
      { content: 'x'.repeat(2001), position: [0, 0, 0], height: 10, font: 'Fira Sans' },
      'WRP_TEXT_TOO_LONG',
      'content',
    );
    setFontProvider(null);
    expectRefusal(empty(), 'add_text', { content: 'x', position: [0, 0, 0], height: 10, font: 'Fira Sans' }, 'WRP_FONT_UNAVAILABLE');
    const plain = ok(empty(), 'add_text', { content: 'note', position: [0, 0, 0], height: 3 });
    expect((plain.document.entities[plain.affected[0] as string] as TextEntity).font).toBeUndefined();
    expect(plain.data).toBeUndefined();
    expectPure(empty(), () => execute(empty(), 'add_text', { content: 'x', position: [0, 0, 0], height: 10, font: 'Fira Sans' }));
  });

  it('scale_entity scales the letter spacing with the height', () => {
    const { doc, id } = addLabel(empty(), 'LL', { letterSpacing: 2 });
    const scaled = apply(doc, 'scale_entity', { id, factor: 2 });
    expect(scaled.entities[id]).toMatchObject({ height: 20, letterSpacing: 4 });
  });
});

describe('text_outline (VC-WRP-13, 15, 40)', () => {
  const reference = (text: string): ReturnType<typeof textReferences>[number] =>
    textReferences().find((entry) => entry.text === text) as ReturnType<typeof textReferences>[number];

  it('LLULL at cap 10 mm: exact area, 5 loops, outline length, advance width, unit fields, provenance', () => {
    const { doc, id } = addLabel(empty(), 'LLULL', { kerning: false });
    const result = ok(doc, 'text_outline', { id });
    const expected = reference('LLULL');
    const info = result.data as Record<string, unknown>;
    expect(Math.abs((info['area'] as number) / expected.areaMm2 - 1)).toBeLessThan(1e-9);
    expect(info).toMatchObject({ loops: 5, outerLoops: 5, holes: 0, areaUnit: 'mm^2', lengthUnit: 'mm', unverified: false, exact: true });
    expect(Math.abs((info['outlineLength'] as number) / expected.outlineLengthMm - 1)).toBeLessThan(2e-6);
    expect(Math.abs((info['advanceWidth'] as number) / expected.advanceWidthNoKerningMm - 1)).toBeLessThan(1e-6);
    expect(info['font']).toEqual({ family: 'Fira Sans', sha256: FIRA_SHA256 });
    expect(info['provenance']).toMatchObject({ method: expect.stringContaining('Green'), inputs: { content: 'LLULL', height: 10 } });
    expect(result.summary).toContain('5 loops');
  });

  it('matches the reference topology and areas glyph by glyph, and the width of "LLULL CAD 2026" without kerning', () => {
    const { doc, id } = addLabel(empty(), 'OB8%AgL', { kerning: false });
    const glyphs = data<{ glyphs: Array<{ char: string; contours: number; holes: number; areaFontUnits2: number }> }>(doc, 'text_outline', {
      id,
      output: 'glyphs',
    }).glyphs;
    for (const entry of glyphs) {
      const expected = glyphReferences().find((glyph) => glyph.char === entry.char);
      expect(entry.contours, entry.char).toBe(expected?.contours);
      expect(entry.holes, entry.char).toBe(expected?.holes);
      expect(Math.abs(entry.areaFontUnits2 / (expected?.areaFontUnits2 as number) - 1), entry.char).toBeLessThan(1e-9);
    }
    const wide = addLabel(empty(), 'LLULL CAD 2026', { height: 5, kerning: false });
    const width = data<{ advanceWidth: number }>(wide.doc, 'text_outline', { id: wide.id, kerning: false }).advanceWidth;
    expect(Math.abs(width / reference('LLULL CAD 2026').advanceWidthNoKerningMm - 1)).toBeLessThan(1e-6);
  });

  it('pages the glyph records, returns thinned region polylines, and reports a missing glyph', () => {
    const { doc, id } = addLabel(empty(), 'OA\u{1F600}');
    const page = data<{ glyphs: unknown[]; missingCharacters: string[] }>(doc, 'text_outline', {
      id,
      output: 'glyphs',
      offset: 1,
      limit: 1,
    });
    expect(page.glyphs).toHaveLength(1);
    expect(page.missingCharacters).toEqual(['\u{1F600}']);
    const loops = data<{ regions: Array<{ outer: number[][]; holes: number[][][] }> }>(doc, 'text_outline', { id, output: 'loops' });
    expect(loops.regions.length).toBe(2);
    expect(loops.regions.some((region) => region.holes.length === 1)).toBe(true);
  });

  it('marks results from an unpinned font unverified', () => {
    const imported = ok(empty(), 'import_font', { base64: firaBase64() });
    const { doc, id } = addLabel(imported.document, 'L', { font: imported.affected[0] });
    expect(data<{ unverified: boolean }>(doc, 'text_outline', { id }).unverified).toBe(true);
  });

  it('refuses unknown ids, text without a font, other entities, a lost font and over-long text', () => {
    const { doc, id } = addLabel(empty(), 'L');
    expectRefusal(doc, 'text_outline', { id: 'nope' }, 'WRP_ENTITY_NOT_FOUND', 'id');
    const plain = ok(doc, 'add_text', { content: 'note', position: [0, 0, 0], height: 3 });
    expectRefusal(plain.document, 'text_outline', { id: plain.affected[0] }, 'WRP_TEXT_NO_FONT');
    const box = ok(doc, 'add_box', { size: [1, 1, 1] });
    expectRefusal(box.document, 'text_outline', { id: box.affected[0] }, 'WRP_TEXT_NO_FONT');
    const lost: CadDocument = { ...doc, fonts: {} };
    expectRefusal(lost, 'text_outline', { id }, 'WRP_FONT_UNAVAILABLE');
    const wrecked: CadDocument = { ...doc, blobs: {} };
    expectRefusal(wrecked, 'text_outline', { id }, 'WRP_FONT_UNAVAILABLE');
    const long: CadDocument = {
      ...doc,
      entities: { ...doc.entities, [id]: { ...(doc.entities[id] as TextEntity), content: 'x'.repeat(2001) } },
    };
    expectRefusal(long, 'text_outline', { id }, 'WRP_TEXT_TOO_LONG');
    expectPure(doc, () => execute(doc, 'text_outline', { id }));
  });
});

describe('extrude_profile of font text (VC-WRP-35, FR-WRP-22)', () => {
  let kernel: Awaited<ReturnType<typeof createManifoldKernel>>;
  beforeAll(async () => {
    kernel = await createManifoldKernel();
  });

  const volumeOf = (doc: CadDocument, id: string): number => data<{ volume: number }>(doc, 'mass_properties', { entityId: id }).volume;

  it('extrudes LLULL on the Manifold mesh kernel to A d (tessellated) and keeps the text', () => {
    setGeometryKernel(kernel);
    const { doc, id } = addLabel(empty(), 'LLULL');
    const result = ok(doc, 'extrude_profile', { id, depth: 2 });
    expect(result.document.entities[id]).toBeDefined();
    const mesh = result.document.entities[result.affected[0] as string];
    expect(mesh?.kind).toBe('mesh');
    const expected = 2 * reference('LLULL').areaMm2;
    expect(Math.abs(volumeOf(result.document, result.affected[0] as string) / expected - 1)).toBeLessThan(2e-3);
    expect(result.data).toMatchObject({ regions: 5, loops: 5, depth: 2, unverified: false });
  });

  it('keeps the holes of O and B: volume A d of the filled-minus-holes area', () => {
    setGeometryKernel(kernel);
    const { doc, id } = addLabel(empty(), 'OB');
    const result = ok(doc, 'extrude_profile', { id, depth: 1, position: [5, 5, 5] });
    const area = data<{ area: number }>(doc, 'text_outline', { id }).area;
    expect(Math.abs(volumeOf(result.document, result.affected[0] as string) / area - 1)).toBeLessThan(2e-3);
  });

  it('refuses without a kernel, with depth <= 0, a bad axis, text without a font and a blank outline', () => {
    const { doc, id } = addLabel(empty(), 'L');
    expectNoOp(execute(doc, 'extrude_profile', { id, depth: 1 }), doc, 'kernel');
    setGeometryKernel(kernel);
    expectNoOp(execute(doc, 'extrude_profile', { id, depth: 0 }), doc, 'depth must be');
    expectNoOp(execute(doc, 'extrude_profile', { id, depth: 1, axis: [0, 0, 0] }), doc, 'axis');
    const plain = ok(doc, 'add_text', { content: 'note', position: [0, 0, 0], height: 3 });
    expectNoOp(execute(plain.document, 'extrude_profile', { id: plain.affected[0], depth: 1 }), plain.document, 'WRP_TEXT_NO_FONT');
    const blank = addLabel(empty(), '   ', { content: ' x' });
    const spaces: CadDocument = {
      ...blank.doc,
      entities: { ...blank.doc.entities, [blank.id]: { ...(blank.doc.entities[blank.id] as TextEntity), content: '  ' } },
    };
    expectRefusal(spaces, 'extrude_profile', { id: blank.id, depth: 1 }, 'WRP_PROFILE_EMPTY');
    expectPure(doc, () => execute(doc, 'extrude_profile', { id, depth: 1 }));
  });

  function reference(text: string): { areaMm2: number } {
    return textReferences().find((entry) => entry.text === text) as { areaMm2: number };
  }
});
