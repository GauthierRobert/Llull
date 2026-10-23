import { describe, it, expect } from 'vitest';
import { type CadDocument, createEmptyDocument } from '@core/model/types';
import { execute } from '@core/commands/registry';

type OptionalKey = { [K in keyof CadDocument]-?: undefined extends CadDocument[K] ? K : never }[keyof CadDocument];
/** Optional slices carried over by clear_document (document settings) — every other optional key must be cleared. */
type KeptKey = 'kernelSettings' | 'nextStepNumber';

/** Exhaustive by type: adding an optional key to CadDocument fails compilation here until a probe value is listed. */
const SLICE_PROBES: Record<Exclude<OptionalKey, KeptKey>, unknown> = {
  building: {},
  implicit: {},
  civil: {},
  drawings: {},
  pmi: {},
  dynamics: {},
  prototype: {},
  review: {},
  blobs: { a: {} },
  fonts: { a: {} },
  exchange: {},
  analysis: { cases: {}, caseOrder: [] },
  materialLibraries: { a: {} },
  fasteners: { catalogs: {}, stacks: {} },
  aero: {},
  composites: {},
  cfd: {},
  sheetMetal: {},
  probabilistic: {},
  plm: {},
  plant: {},
  scan: {},
  contactSets: { a: {} },
  explodedViews: { a: {} },
  activeExplodedView: {},
  sketchPlanes: { a: {} },
  sketchLinks: { a: {} },
};

const withProbe = (key: string): CadDocument => ({ ...createEmptyDocument(), [key]: SLICE_PROBES[key as keyof typeof SLICE_PROBES] });

describe('clear_document clears every optional document slice', () => {
  it.each(Object.keys(SLICE_PROBES))('%s alone makes the document non-empty and is removed', (key) => {
    const doc = withProbe(key);
    const result = execute(doc, 'clear_document', {});
    expect(result.summary).not.toContain('already empty');
    expect(key in result.document).toBe(false);
  });

  it('clears all slices at once and keeps units, camera, displayPrecision and kernelSettings', () => {
    const kernelSettings = { maxImportTolerance: 0.5 } as unknown as CadDocument['kernelSettings'];
    const doc = {
      ...createEmptyDocument(),
      ...SLICE_PROBES,
      units: 'in' as const,
      displayPrecision: 5,
      kernelSettings,
      nextStepNumber: 9,
    } as CadDocument;
    const { document } = execute(doc, 'clear_document', {});
    const leftovers = Object.keys(SLICE_PROBES).filter((key) => key in document);
    expect(leftovers).toEqual([]);
    expect(document).toMatchObject({ units: 'in', displayPrecision: 5, kernelSettings, camera: doc.camera });
    expect(document.entities).toEqual({});
  });

  it('a document holding only an airfoil-style aero slice is not already empty', () => {
    const doc = { ...createEmptyDocument(), aero: { airfoils: { 'airfoil-1': {} } } } as unknown as CadDocument;
    const result = execute(doc, 'clear_document', {});
    expect(result.document.aero).toBeUndefined();
    expect(result.summary).toMatch(/^Cleared/);
  });

  it('a document holding only kept settings is already empty (no-op, same document)', () => {
    const doc = { ...createEmptyDocument(), units: 'in' as const, nextStepNumber: 4 } as CadDocument;
    const result = execute(doc, 'clear_document', {});
    expect(result.summary).toBe('Document is already empty.');
    expect(result.document).toBe(doc);
    expect(result.affected).toEqual([]);
  });

  it('keepLayers preserves layers and still clears the slices', () => {
    const base = execute(createEmptyDocument(), 'add_box', { size: [1, 1, 1] }).document;
    const doc = {
      ...base,
      aero: {},
      layers: { ...base.layers, extra: { id: 'extra', name: 'Extra', visible: true, locked: false } },
    } as unknown as CadDocument;
    const result = execute(doc, 'clear_document', { keepLayers: true });
    expect(Object.keys(result.document.layers)).toEqual(Object.keys(doc.layers));
    expect(result.document.aero).toBeUndefined();
    expect(result.document.order).toEqual([]);
  });

  it('is pure: the input document is not mutated', () => {
    const doc = withProbe('plm');
    const before = JSON.stringify(doc);
    execute(doc, 'clear_document', {});
    expect(JSON.stringify(doc)).toBe(before);
  });
});
