import { describe, expect, it } from 'vitest';
import { deserializeDocument, serializeDocument } from '@core/commands/persistence/serialization';
import { compositesDocument } from '@aero/composites/document';
import { apply, data, expectRefusal } from '../../../helpers/commandAssertions';
import { createEmptyDocument } from '@core/model/types';
import { panel } from './fixtures';

const { doc, part } = panel();
const text = serializeDocument(doc);

type Model = Record<string, Record<string, Record<string, unknown>>>;
const withEdit = (edit: (model: Model) => void): string => {
  const parsed = JSON.parse(text) as { document: { composites: Model } };
  edit(parsed.document.composites);
  return JSON.stringify(parsed);
};
const first = (table: Record<string, Record<string, unknown>> | undefined): string => Object.keys(table ?? {})[0] as string;

describe('analyze_laminate on a part', () => {
  it('analyses the stack at a point of the panel and agrees with the equivalent angle list', () => {
    const atBase = data<{ anglesDeg: number[]; thicknessMm: number; A: number[][] }>(doc, 'analyze_laminate', { part, point: [50, 50, 0] });
    expect(atBase.anglesDeg).toEqual([45, -45, 0, 90, 90, 0, -45, 45]);
    expect(atBase.thicknessMm).toBeCloseTo(1, 12);
    const listed = data<{ A: number[][] }>(doc, 'analyze_laminate', { laminate: '[45/-45/0/90]s', material: 'T300_5208' });
    expect(atBase.A).toEqual(listed.A);
    const atHole = data<{ plyCount: number }>(doc, 'analyze_laminate', { part, point: [300, 200, 0] });
    expect(atHole.plyCount).toBe(24);
  });

  it('refuses points off the part and parts without plies', () => {
    expectRefusal(doc, 'analyze_laminate', { part, point: [-10, -10, 0] }, 'CMP_POINT_OFF_PART');
    expectRefusal(doc, 'analyze_laminate', { part }, 'CMP_POINT_OFF_PART');
  });
});

describe('composites document extension', () => {
  it('round-trips and reports no errors for a valid model', () => {
    expect(compositesDocument.validate(JSON.parse(text).document)).toEqual([]);
    expect(compositesDocument.validate({})).toEqual([]);
    expect(serializeDocument(deserializeDocument(text))).toBe(text);
  });

  it('rejects malformed tables, references and values', () => {
    const rejects = (edit: (model: Model) => void, pattern: RegExp): void =>
      expect(() => deserializeDocument(withEdit(edit))).toThrow(pattern);
    rejects((m) => ((m as unknown as Record<string, unknown>)['materials'] = []), /materials must be an object/);
    rejects((m) => ((m['materials'] as Model[string])['T300_5208'] = 5 as never), /must be an object/);
    rejects((m) => ((m['materials'] as Model[string])['T300_5208']!['name'] = 'other'), /name must equal its key/);
    rejects((m) => ((m['materials'] as Model[string])['T300_5208']!['density'] = -1), /density must be > 0/);
    rejects((m) => ((m['materials'] as Model[string])['T300_5208']!['form'] = 'x'), /form is unknown/);
    rejects((m) => ((m['materials'] as Model[string])['T300_5208']!['basis'] = 'x'), /basis is unknown/);
    rejects((m) => ((m['materials'] as Model[string])['T300_5208']!['source'] = 1), /source must be text/);
    rejects((m) => ((m['rosettes'] as Model[string])[first(m['rosettes'])]!['origin'] = 'x'), /needs origin/);
    rejects((m) => ((m['rosettes'] as Model[string])[first(m['rosettes'])]!['id'] = 'x'), /rosettes\..*\.id/);
    rejects((m) => ((m['parts'] as Model[string])[first(m['parts'])]!['id'] = 'x'), /parts\..*\.id/);
    rejects((m) => ((m['parts'] as Model[string])[first(m['parts'])]!['surface'] = { type: 'torus' }), /surface\.type/);
    rejects((m) => ((m['parts'] as Model[string])[first(m['parts'])]!['rosetteId'] = 'x'), /missing rosette/);
    rejects((m) => ((m['parts'] as Model[string])[first(m['parts'])]!['toolFaces'] = []), /toolFaces/);
    rejects((m) => ((m['parts'] as Model[string])[first(m['parts'])]!['toolFaces'] = [{ entityId: 'ghost' }]), /missing tool entity/);
    rejects((m) => ((m['zones'] as Model[string])[first(m['zones'])]!['partId'] = 'x'), /missing part/);
    rejects((m) => ((m['zones'] as Model[string])[first(m['zones'])]!['boundary'] = [[0, 0]]), /boundary/);
    rejects((m) => ((m['zones'] as Model[string])[first(m['zones'])]!['angles'] = []), /angles/);
    rejects((m) => ((m['plies'] as Model[string])[first(m['plies'])]!['partId'] = 'x'), /plies\..*missing part/);
    rejects((m) => ((m['plies'] as Model[string])[first(m['plies'])]!['rosetteId'] = 'x'), /plies\..*missing rosette/);
    rejects((m) => ((m['plies'] as Model[string])[first(m['plies'])]!['orientation'] = 'x'), /orientation and order/);
    rejects((m) => ((m['plies'] as Model[string])[first(m['plies'])]!['boundary'] = { kind: 'x' }), /whole_face or polygons/);
    rejects((m) => ((m as unknown as Record<string, unknown>)['plyOrder'] = ['ghost']), /plyOrder/);
    rejects((m) => ((m as unknown as Record<string, unknown>)['waivers'] = { w: { code: 1 } }), /waivers/);
  });

  it('keeps unknown derived ids out of the saved file and skips restore on an invalid slice', () => {
    expect(compositesDocument.restore({ entities: {}, order: [] })).toEqual({ entities: {}, order: [] });
    const raw = { composites: { materials: 5 }, entities: {}, order: [] };
    expect(compositesDocument.restore(raw)).toBe(raw);
    expect(compositesDocument.derivedEntityIds(createEmptyDocument()).size).toBe(0);
    const stale = apply(doc, 'delete_zone', { part, zone: 'Z-hole' });
    expect(compositesDocument.derivedEntityIds(stale).size).toBe(compositesDocument.derivedEntityIds(doc).size);
  });
});
