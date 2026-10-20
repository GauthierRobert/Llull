/** 03 GDT: doc.pmi survives save / load, rejects malformed files with the first problem, and keeps the step counter safe (VC-GDT-50). */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type CadDocument, createEmptyDocument } from '@core/model/types';
import { execute } from '@core/commands/registry';
import { deserializeDocument, serializeDocument } from '@core/commands/persistence/serialization';
import { setGeometryKernel } from '@core/geometry/kernel';
import { plateKernel } from '../../helpers/pmiPlateKernel';

beforeEach(() => setGeometryKernel(plateKernel()));
afterEach(() => setGeometryKernel(null));

function documentWithPmi(): CadDocument {
  const box = execute(createEmptyDocument(), 'add_box', { size: [120, 80, 12] });
  const entityId = box.affected[0] as string;
  let doc = box.document;
  const run = (name: string, params: Record<string, unknown>): string[] => {
    const result = execute(doc, name, params);
    expect(result.rejected, result.summary).toBeUndefined();
    doc = result.document;
    return result.affected;
  };
  run('set_pmi_standard', { standard: 'ISO_GPS', generalToleranceNote: 'ISO 2768-m' });
  const [a] = run('add_datum_feature', { entityId, facesNear: [[30, 10, 0]], label: 'A' });
  run('add_datum_target', { entityId, label: 'A', targetKind: 'area', areaSize: 4, facesNear: [[90, 70, 0]] });
  const [size] = run('add_size_dimension', {
    entityId,
    facesNear: [[16.7, 20, 6]],
    sizeKind: 'diameter',
    tolerance: { type: 'fit', code: 'H7', upper: 0.021, lower: 0 },
    sizeModifiers: ['E'],
  });
  run('add_location_dimension', { entityId, from: [[60, 0, 6]], to: [[16.7, 20, 6]], measure: 'distance' });
  run('add_geometric_tolerance', {
    characteristic: 'position',
    targetPmiId: size,
    zone: { value: 0.3, diametral: true },
    materialCondition: 'MMC',
    datums: [{ label: 'A' }],
  });
  run('add_surface_texture', { entityId, facesNear: [[30, 10, 0]], parameter: 'Ra', value: 1.6 });
  run('add_pmi_note', { text: 'DEBURR' });
  const [view] = run('create_saved_view', { name: 'V', direction: 'top', pmiIds: [a as string] });
  return execute(doc, 'activate_saved_view', { savedViewId: view }).document;
}

type Json = Record<string, unknown>;

/** Sets the value at `path` of the document JSON, creating nothing: every step must exist. */
function setAt(root: Json, path: readonly string[], value: unknown): void {
  let node: Json = root;
  for (const key of path.slice(0, -1)) node = node[key] as Json;
  node[path.at(-1) as string] = value;
}

describe('pmi persistence', () => {
  it('round-trips every item kind, the saved views and the active view', () => {
    const doc = documentWithPmi();
    const loaded = deserializeDocument(serializeDocument(doc));
    expect(loaded.pmi).toEqual(doc.pmi);
    expect(serializeDocument(loaded)).toBe(serializeDocument(doc));
    expect(
      Object.values(loaded.pmi?.items ?? {})
        .map((i) => i.kind)
        .sort(),
    ).toEqual(['datum_feature', 'datum_target', 'geometric_tolerance', 'location_dimension', 'note', 'size_dimension', 'surface_texture']);
    expect(deserializeDocument(serializeDocument(createEmptyDocument())).pmi).toBeUndefined();
  });

  it('keeps the step counter ahead of pmi ids minted by steps', () => {
    const doc = documentWithPmi();
    const raw = JSON.parse(serializeDocument(doc)) as { document: Json };
    delete raw.document['nextStepNumber'];
    expect(deserializeDocument(JSON.stringify(raw)).nextStepNumber).toBeGreaterThan(Object.keys(doc.pmi?.items ?? {}).length);
  });

  it('rejects malformed pmi with the first problem', () => {
    const doc = documentWithPmi();
    const ids = Object.keys(doc.pmi?.items ?? {});
    const byKind = (kind: string): string => ids.find((id) => doc.pmi?.items[id]?.kind === kind) as string;
    const viewId = doc.pmi?.savedViewOrder[0] as string;
    const item = (kind: string, ...rest: string[]): string[] => ['items', byKind(kind), ...rest];
    const view = (...rest: string[]): string[] => ['savedViews', viewId, ...rest];
    const cases: Array<[string, string[], unknown]> = [
      ['pmi must be', ['items'], 1],
      ['pmi.standard', ['standard'], 'DIN'],
      ['generalToleranceNote', ['generalToleranceNote'], 3],
      ['does not match item.id', ['items', ids[0] as string, 'id'], 'other'],
      ['unknown kind', ['items', ids[0] as string, 'kind'], 'mystery'],
      ['placement needs', ['items', ids[0] as string, 'placement'], {}],
      ['review.required', ['items', ids[0] as string, 'review'], {}],
      ['datum label must match', item('datum_feature', 'label'), 'a'],
      ['feature.facesNear', item('datum_feature', 'feature', 'facesNear'), []],
      ['feature.faceIndices', item('datum_feature', 'feature', 'faceIndices'), ['x']],
      ['feature.ofSize', item('size_dimension', 'feature', 'ofSize'), { kind: 'cylinder', measured: -1 }],
      ['feature.entityId', item('datum_feature', 'feature', 'entityId'), 3],
      ['feature must be an object', item('datum_feature', 'feature'), 3],
      ['datum target needs', item('datum_target', 'targetKind'), 'blob'],
      ['unknown sizeKind', item('size_dimension', 'sizeKind'), 'volume'],
      ['count must be', item('size_dimension', 'count'), 0],
      ['sizeModifiers', item('size_dimension', 'sizeModifiers'), ['zz']],
      ['tolerance.type', item('size_dimension', 'tolerance'), { type: 'x' }],
      ['upper and lower', item('size_dimension', 'tolerance'), { type: 'limits', upper: 'a', lower: 1 }],
      ['needs a code', item('size_dimension', 'tolerance'), { type: 'fit', upper: 1, lower: 0 }],
      ['tolerance must be an object', item('size_dimension', 'tolerance'), 4],
      ['measure and measured', item('location_dimension', 'measure'), 'mass'],
      ['unknown characteristic', item('geometric_tolerance', 'characteristic'), 'wiggle'],
      ['target must be an object', item('geometric_tolerance', 'target'), 1],
      ['target.pmiId must be a string', item('geometric_tolerance', 'target'), { pmiId: 1 }],
      ["target.pmiId 'ghost' is not a PMI item", item('geometric_tolerance', 'target'), { pmiId: 'ghost' }],
      ['zone.value', item('geometric_tolerance', 'zone'), { value: 0 }],
      ['zone.projectedLength', item('geometric_tolerance', 'zone'), { value: 1, projectedLength: -1 }],
      ['materialCondition', item('geometric_tolerance', 'materialCondition'), 'X'],
      ['modifiers must', item('geometric_tolerance', 'modifiers'), ['nope']],
      ['datums must be', item('geometric_tolerance', 'datums'), [1, 2, 3, 4]],
      ['compositeOf must', item('geometric_tolerance', 'compositeOf'), 1],
      ['surface texture needs', item('surface_texture', 'value'), 0],
      ['a note needs non-empty text', item('note', 'text'), ''],
      ['does not reference a known item', ['order'], [...ids, 'ghost']],
      ['is missing item', ['order'], []],
      ['duplicate ids', ['order'], [...ids, ids[0]]],
      ['pmi.savedViews', ['savedViews'], 3],
      ['camera needs', view('camera'), {}],
      ['pmiIds must be', view('pmiIds'), 3],
      ["unknown item 'ghost'", view('pmiIds'), ['ghost']],
      ['entityIds must be', view('entityIds'), 3],
      ['section needs', view('section'), { direction: 'x', offset: 1 }],
      ['name must be a string', view('name'), 3],
      ['must match its key', view('id'), 'other'],
      ['savedViewOrder must list', ['savedViewOrder'], []],
      ['activeSavedViewId', ['activeSavedViewId'], 'ghost'],
    ];
    for (const [expected, path, value] of cases) {
      const raw = JSON.parse(serializeDocument(doc)) as { document: { pmi: Json } };
      setAt(raw.document.pmi, path, value);
      expect(() => deserializeDocument(JSON.stringify(raw)), expected).toThrow(expected);
    }
    const reserved = JSON.parse(serializeDocument(doc)) as { document: { pmi: { items: Json } } };
    Object.defineProperty(reserved.document.pmi.items, 'constructor', { value: {}, enumerable: true });
    expect(() => deserializeDocument(JSON.stringify(reserved))).toThrow();
    const rejected = execute(createEmptyDocument(), 'load_document', {
      json: JSON.stringify({
        ...(JSON.parse(serializeDocument(doc)) as Json),
        document: { ...(JSON.parse(serializeDocument(doc)) as { document: Json }).document, pmi: 1 },
      }),
    });
    expect(rejected.affected).toEqual([]);
  });

  it('validates sheet pmiMode and view pmiIds', () => {
    const doc = documentWithPmi();
    const withSheet = execute(doc, 'create_sheet', { name: 'S', views: ['front'] });
    const sheetId = withSheet.affected[0] as string;
    const viewId = withSheet.affected[1] as string;
    const ok = execute(withSheet.document, 'update_sheet', { sheetId, pmiMode: 'auto' }).document;
    const withIds = execute(ok, 'update_drawing_view', { sheetId, viewId, pmiIds: [Object.keys(doc.pmi?.items ?? {})[0]] }).document;
    expect(deserializeDocument(serializeDocument(withIds)).drawings?.sheets[sheetId]).toMatchObject({ pmiMode: 'auto' });
    const broken = (path: string[], value: unknown): string => {
      const raw = JSON.parse(serializeDocument(withIds)) as { document: { drawings: { sheets: Json } } };
      setAt(raw.document.drawings.sheets, [sheetId, ...path], value);
      return JSON.stringify(raw);
    };
    expect(() => deserializeDocument(broken(['pmiMode'], 'both'))).toThrow('pmiMode must be off or auto');
    expect(() => deserializeDocument(broken(['views', '0', 'pmiIds'], ['a b']))).toThrow('pmiIds must be an array of PMI ids');
  });
});
