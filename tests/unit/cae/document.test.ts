import { describe, expect, it } from 'vitest';
import { deserializeDocument, serializeDocument } from '@core/commands/persistence/serialization';
import { execute } from '@core/commands/registry';
import { analysisErrors } from '@cae/model/validate';
import { createEmptyDocument } from '@core/model/types';
import { derivedEntityIds } from '@core/plugins/host';
import { caePlugin } from '@cae/index';
import { caseIn, modelWithAnalysis, run } from './helpers';

function populated(): ReturnType<typeof modelWithAnalysis> {
  const base = modelWithAnalysis('heat_steady');
  const target = { entityId: base.boxId, facesNear: [[5, 5, 0]] };
  let doc = run(base.doc, 'add_fea_constraint', { analysisId: base.analysisId, name: 'c', kind: 'fixed', target }).document;
  doc = run(doc, 'add_fea_load', { analysisId: base.analysisId, name: 'l', kind: 'force', vector: [0, 0, 1], target }).document;
  doc = run(doc, 'add_result_probe', { analysisId: base.analysisId, name: 'p', point: [1, 1, 1], quantity: 'temperature' }).document;
  doc = run(doc, 'set_mesh_controls', { analysisId: base.analysisId, refinements: [{ target, size: 2 }] }).document;
  return { ...base, doc };
}

const asRaw = (doc: ReturnType<typeof populated>['doc']): Record<string, unknown> =>
  JSON.parse(JSON.stringify(doc)) as Record<string, unknown>;

type Path = ReadonlyArray<string | number>;
const REMOVE = Symbol('remove');

/** Set (or REMOVE) the value at `path` below `root`. */
function setAt(root: unknown, path: Path, value: unknown): void {
  let node = root as Record<string | number, unknown>;
  for (const key of path.slice(0, -1)) node = node[key] as Record<string | number, unknown>;
  const last = path[path.length - 1] as string | number;
  if (value === REMOVE) delete node[last];
  else node[last] = value;
}

/** Apply `edits` to the serialized document and load it back; null = accepted. */
function loadEdited(doc: ReturnType<typeof populated>['doc'], edits: ReadonlyArray<readonly [Path, unknown]>): Error | null {
  const envelope = JSON.parse(serializeDocument(doc)) as { document: unknown };
  for (const [path, value] of edits) setAt(envelope.document, path, value === REMOVE ? value : structuredClone(value));
  try {
    deserializeDocument(JSON.stringify(envelope));
    return null;
  } catch (error) {
    return error as Error;
  }
}

describe('cae document extension', () => {
  it('round-trips a document with an analysis through save and load', () => {
    const { doc } = populated();
    const loaded = deserializeDocument(serializeDocument(doc));
    expect(loaded.analysis).toEqual(doc.analysis);
    expect(serializeDocument(loaded)).toBe(serializeDocument(doc));
    const viaCommand = execute(createEmptyDocument(), 'load_document', { json: serializeDocument(doc) });
    expect(viaCommand.document.analysis).toEqual(doc.analysis);
  });

  it('derives nothing and restores identically', () => {
    const { doc } = populated();
    expect(derivedEntityIds(doc).size).toBe(0);
    const raw = asRaw(doc);
    expect(caePlugin.document?.restore(raw)).toBe(raw);
    expect(caePlugin.document?.derivedEntityIds(doc).size).toBe(0);
  });

  it('accepts documents without an analysis', () => {
    expect(analysisErrors({})).toEqual([]);
    expect(deserializeDocument(serializeDocument(createEmptyDocument())).analysis).toBeUndefined();
  });

  it('rejects malformed slices on load', () => {
    const { doc, analysisId, boxId } = populated();
    const c = caseIn(doc, analysisId);
    const cid = c.constraintOrder[0] ?? '';
    const lid = c.loadOrder[0] ?? '';
    const pid = Object.keys(c.probes)[0] ?? '';
    const at = (...path: Path): Path => ['analysis', 'cases', analysisId, ...path];
    const edits: Array<[string, ReadonlyArray<readonly [Path, unknown]>, string]> = [
      ['not a record', [[['analysis'], 5]], 'expected { cases, caseOrder }'],
      [
        'duplicate order',
        [
          [
            ['analysis', 'caseOrder'],
            [analysisId, analysisId],
          ],
        ],
        'duplicate ids',
      ],
      [
        'order lists a missing case',
        [
          [
            ['analysis', 'caseOrder'],
            [analysisId, 'ghost'],
          ],
        ],
        "'ghost' is listed but missing",
      ],
      ['case not in order', [[['analysis', 'caseOrder'], []]], 'missing from the order list'],
      ['case id differs from key', [[at('id'), 'other']], 'is malformed'],
      ['unknown type', [[at('type'), 'weird']], 'unknown type'],
      ['unknown unit system', [[at('unitSystem'), 'cgs']], 'unknown unitSystem'],
      ['name not text', [[at('name'), 4]], 'name must be text'],
      ['parts not a record', [[at('parts'), []]], 'parts must be a record'],
      ['missing part entity', [[at('parts', 'ghost'), { kind: 'solid' }]], "part 'ghost' does not exist"],
      ['bad idealization', [[at('parts', boxId), { kind: 'x' }]], 'invalid idealization'],
      ['constraint kind', [[at('constraints', cid, 'kind'), 'x']], 'unknown kind'],
      ['constraint target entity', [[at('constraints', cid, 'target', 'entityId'), 'ghost']], "target entity 'ghost' does not exist"],
      ['constraint target without entity', [[at('constraints', cid, 'target'), {}]], 'target needs an entityId'],
      ['bad target points', [[at('constraints', cid, 'target', 'facesNear'), [[1, 2]]]], 'facesNear must be a list'],
      ['load kind', [[at('loads', lid, 'kind'), 'x']], 'unknown kind'],
      ['load category', [[at('loads', lid, 'category'), 'x']], 'unknown category'],
      ['load vector', [[at('loads', lid, 'vector'), [1]]], 'vector must be three'],
      ['mesh size', [[at('mesh', 'globalSize'), 0]], 'globalSize must be > 0'],
      ['mesh order', [[at('mesh', 'order'), 3]], 'order must be 1 or 2'],
      ['mesh missing', [[at('mesh'), REMOVE]], 'mesh controls missing'],
      ['refinements not a list', [[at('mesh', 'refinements'), {}]], 'refinements must be a list'],
      ['refinement size', [[at('mesh', 'refinements', 0, 'size'), -1]], 'needs size > 0'],
      ['refinement target', [[at('mesh', 'refinements', 0, 'target', 'entityId'), 'ghost']], "target entity 'ghost' does not exist"],
      ['probes not a record', [[at('probes'), 3]], 'probes must be a record'],
      ['probe quantity', [[at('probes', pid, 'quantity'), 'speed']], 'is malformed'],
      ['thermal missing', [[at('thermal'), REMOVE]], 'thermal set-up is required'],
      ['thermomech on heat case', [[at('thermomech'), {}]], 'thermomech set-up is required'],
      ['thermal scale', [[at('thermal', 'temperatureScale'), 'degF']], 'temperatureScale must be degC or K'],
      ['thermal not a record', [[at('thermal'), 4]], 'expected a thermal set-up'],
      ['thermal field type', [[at('thermal', 'amplitudes'), 4]], 'amplitudes must be a record'],
      ['bad summary', [[at('meshSummary'), { meshHash: 'x' }]], 'meshSummary is malformed'],
    ];
    for (const [label, edit, expected] of edits) {
      const error = loadEdited(doc, edit);
      expect(error, label).not.toBeNull();
      expect(error?.message, label).toContain(expected);
    }
  });

  it('validates thermal bcs and limits, and thermo-mechanical setups', () => {
    const { doc, analysisId, boxId } = populated();
    const target = { entityId: boxId, facesNear: [[5, 5, 0]] };
    const at = (...path: Path): Path => ['analysis', 'cases', analysisId, 'thermal', ...path];
    const bc = (id: string, body: Record<string, unknown>): Record<string, unknown> => ({ id, name: id, bc: body });
    const good: ReadonlyArray<readonly [Path, unknown]> = [
      [at('bcOrder'), ['b1', 'b2']],
      [
        at('bcs'),
        {
          b1: bc('b1', { kind: 'temperature', value: { value: 1, unit: 'K' }, target }),
          b2: bc('b2', { kind: 'heat_generation', value: { value: 1, unit: 'W' }, mode: 'total', entityId: boxId }),
        },
      ],
      [at('limitOrder'), ['l1', 'l2']],
      [
        at('limits'),
        {
          l1: { id: 'l1', name: 'a', scope: { target }, source: { citation: 'x' } },
          l2: { id: 'l2', name: 'b', scope: { entityId: boxId }, source: { citation: 'x' } },
        },
      ],
    ];
    expect(loadEdited(doc, good)).toBeNull();
    const failures: Array<[ReadonlyArray<readonly [Path, unknown]>, string]> = [
      [[[at('bcs', 'b1'), {}]], 'is malformed'],
      [[[at('bcs', 'b1', 'bc'), 3]], "'b1' has no bc"],
      [[[at('bcs', 'b1', 'bc', 'target', 'entityId'), 'ghost']], "target entity 'ghost'"],
      [[[at('bcs', 'b2', 'bc', 'entityId'), 'ghost']], 'heat_generation entity does not exist'],
      [[[at('limits', 'l1', 'scope', 'target', 'entityId'), 'ghost']], "target entity 'ghost'"],
      [[[at('limits', 'l2', 'scope', 'entityId'), 'ghost']], "entity 'ghost' does not exist"],
    ];
    for (const [edit, expected] of failures) expect(loadEdited(doc, [...good, ...edit])?.message).toContain(expected);

    const thermo = modelWithAnalysis('thermo_static', { referenceTemperature: { value: 20, unit: 'degC' } });
    const tm = (...path: Path): Path => ['analysis', 'cases', thermo.analysisId, 'thermomech', ...path];
    expect(loadEdited(thermo.doc, [])).toBeNull();
    expect(loadEdited(thermo.doc, [[tm(), REMOVE]])?.message).toContain('thermomech set-up is required');
    expect(loadEdited(thermo.doc, [[tm('referenceTemperature'), 5]])?.message).toContain('referenceTemperature is required');
    expect(loadEdited(thermo.doc, [[tm('thermal'), 5]])?.message).toContain('expected a thermal set-up');
    const coupled = caseIn(populated().doc, populated().analysisId).thermal;
    expect(loadEdited(thermo.doc, [[tm('thermal'), coupled]])).toBeNull();
  });

  it('flags non-finite numbers in memory', () => {
    const { doc, analysisId } = populated();
    const raw = asRaw(doc);
    setAt(raw, ['analysis', 'cases', analysisId, 'mesh', 'globalSize'], Infinity);
    expect(analysisErrors(raw).some((e) => e.includes('is not a finite number'))).toBe(true);
  });
});

describe('analysis reference guard', () => {
  it('refuses to delete an entity an analysis still uses, then allows it after delete_analysis', () => {
    const { doc, boxId, analysisId } = populated();
    const refused = run(doc, 'delete_entities', { ids: [boxId] });
    expect(refused.rejected).toBe(true);
    expect(refused.document).toBe(doc);
    expect(refused.summary).toContain(`used by analysis '${analysisId}'`);
    const removed = run(run(doc, 'delete_analysis', { analysisId }).document, 'delete_entities', { ids: [boxId] });
    expect(removed.rejected).not.toBe(true);
    expect(removed.document.entities[boxId]).toBeUndefined();
  });

  it('does not interfere with unrelated edits or documents without analyses', () => {
    const { doc } = populated();
    const other = run(doc, 'add_box', { size: [1, 1, 1] });
    expect(run(other.document, 'delete_entities', { ids: [other.affected[0] ?? ''] }).rejected).not.toBe(true);
    expect(run(createEmptyDocument(), 'add_box', { size: [1, 1, 1] }).rejected).not.toBe(true);
  });

  it('a cleared document drops the analysis without tripping the guard', () => {
    const { doc } = populated();
    const cleared = run(doc, 'clear_document', {});
    expect(cleared.rejected).not.toBe(true);
    expect(cleared.document.analysis).toBeUndefined();
  });
});
