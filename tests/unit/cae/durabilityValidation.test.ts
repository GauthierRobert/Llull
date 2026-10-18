import { describe, expect, it } from 'vitest';
import { deserializeDocument, serializeDocument } from '@core/commands/persistence/serialization';
import { execute } from '@core/commands/registry';
import type { CadDocument } from '@core/model/types';
import { analysisErrors } from '@cae/model/validate';
import { FAT_PLANS, runPlanBefore } from './fatigue/support';
import { build, materialDoc } from './fracture/support';

type Json = Record<string, unknown>;
type Path = ReadonlyArray<string | number>;

function fatigueDoc(): { doc: CadDocument; caseId: string; historyId: string } {
  const base = runPlanBefore(`${FAT_PLANS}/fat_history_only_miner.plan.json`, 'define_load_history').document;
  const history = execute(base, 'define_load_history', {
    name: 'h',
    kind: 'stress',
    unit: 'MPa',
    data: { form: 'series', values: [-200, 100, -300, 500, -100, 300, -400, 400, -200] },
    source: { citation: 'test' },
  });
  const historyId = history.affected[0] ?? '';
  const created = execute(history.document, 'create_fatigue_case', {
    name: 'c',
    method: 'stress_life',
    mapping: [{ historyId, scale: 1 }],
    material: { recordId: 'mat_test', modelId: 'sn1' },
    requiredLife: { value: 1000, unit: 'blocks' },
  });
  const caseId = created.affected[0] ?? '';
  const factors = execute(created.document, 'set_fatigue_factors', { caseId, scatter: { value: 3, source: 'case input' } });
  return { doc: factors.document, caseId, historyId };
}

const rawOf = (doc: CadDocument): Json => JSON.parse(JSON.stringify(doc)) as Json;
const at = (root: unknown, path: Path): unknown => path.reduce<unknown>((node, key) => (node as Json)[key], root);
function edit(raw: Json, path: Path, value: unknown): Json {
  const copy = structuredClone(raw);
  const parent = at(copy, path.slice(0, -1)) as Json;
  const last = path[path.length - 1] as string;
  if (value === undefined) delete parent[last];
  else parent[last] = value;
  return copy;
}

const fatigue = fatigueDoc();
const fracture = build({ extra: { factors: { scatterInterval: { value: 2, source: 'rule' } } } });

describe('durability load validation: valid documents', () => {
  it('has no errors for documents produced by the commands and for an absent durability slice', () => {
    expect(analysisErrors(rawOf(fatigue.doc))).toEqual([]);
    expect(analysisErrors(rawOf(fracture.doc))).toEqual([]);
    expect(analysisErrors(rawOf(materialDoc()))).toEqual([]);
  });

  it('round-trips through serialize / deserialize with identical compute_fatigue and compute_crack_growth results', () => {
    const loadedFatigue = deserializeDocument(serializeDocument(fatigue.doc));
    const before = execute(fatigue.doc, 'compute_fatigue', { caseId: fatigue.caseId });
    const after = execute(loadedFatigue, 'compute_fatigue', { caseId: fatigue.caseId });
    expect(after.error).toBeUndefined();
    expect(after.data).toEqual(before.data);
    expect(after.summary).toBe(before.summary);

    const loadedFracture = deserializeDocument(serializeDocument(fracture.doc));
    const growthBefore = execute(fracture.doc, 'compute_crack_growth', { caseId: fracture.caseId });
    const growthAfter = execute(loadedFracture, 'compute_crack_growth', { caseId: fracture.caseId });
    expect(growthAfter.error).toBeUndefined();
    expect(growthAfter.data).toEqual(growthBefore.data);
    expect(growthAfter.summary).toBe(growthBefore.summary);
  });

  it('rejects a malformed durability slice at load time', () => {
    const envelope = JSON.parse(serializeDocument(fatigue.doc)) as { document: Json };
    const d = (envelope.document['analysis'] as Json)['durability'] as Json;
    (d['histories'] as Json)[fatigue.historyId] = 7;
    expect(() => deserializeDocument(JSON.stringify(envelope))).toThrow();
  });
});

const D = 'analysis.durability';
const H = (id: string): string => `${D}.histories.${id}`;

describe('durability load validation: malformed variants', () => {
  const cases = (): ReadonlyArray<readonly [string, Json, string]> => {
    const f = rawOf(fatigue.doc);
    const g = rawOf(fracture.doc);
    const hid = fatigue.historyId;
    const cid = fatigue.caseId;
    const fc = (...rest: Array<string | number>): Path => ['analysis', 'durability', 'fatigueCases', cid, ...rest];
    const gh = (...rest: Array<string | number>): Path => ['analysis', 'durability', 'histories', fracture.historyId, ...rest];
    const gk = (...rest: Array<string | number>): Path => ['analysis', 'durability', 'cracks', fracture.crackId, ...rest];
    const gc = (...rest: Array<string | number>): Path => ['analysis', 'durability', 'crackGrowthCases', fracture.caseId, ...rest];
    const fcPath = `${D}.fatigueCases.${cid}`;
    const gcPath = `${D}.crackGrowthCases.${fracture.caseId}`;
    return [
      ['durability not a record', edit(f, ['analysis', 'durability'], []), `${D}: expected a record`],
      ['histories not a record', edit(f, ['analysis', 'durability', 'histories'], []), `${D}.histories: expected a record`],
      ['order not a list', edit(f, ['analysis', 'durability', 'historyOrder'], 'x'), `${D}.historiesOrder`],
      ['order missing entry', edit(f, ['analysis', 'durability', 'historyOrder'], []), `${H(hid)}: missing from historiesOrder`],
      ['order duplicate', edit(f, ['analysis', 'durability', 'historyOrder'], [hid, hid]), 'duplicate ids'],
      ['order dangling', edit(f, ['analysis', 'durability', 'crackOrder'], ['ghost']), `'ghost' is listed but missing`],
      ['entry id mismatch', edit(f, ['analysis', 'durability', 'histories', hid, 'id'], 'other'), `${H(hid)}: entry is malformed`],
      ['history kind enum', edit(f, ['analysis', 'durability', 'histories', hid, 'kind'], 'force'), `${H(hid)}.kind`],
      ['history name', edit(f, ['analysis', 'durability', 'histories', hid, 'name'], 3), `${H(hid)}.name`],
      ['history repeats', edit(f, ['analysis', 'durability', 'histories', hid, 'repeats'], 'always'), `${H(hid)}.repeats`],
      ['history values non-array', edit(f, ['analysis', 'durability', 'histories', hid, 'data', 'values'], 'abc'), `${H(hid)}.data.values`],
      ['history one value', edit(f, ['analysis', 'durability', 'histories', hid, 'data', 'values'], [1]), `${H(hid)}.data.values`],
      ['history form', edit(f, ['analysis', 'durability', 'histories', hid, 'data', 'form'], 'curve'), `${H(hid)}.data.form`],
      ['history data missing', edit(f, ['analysis', 'durability', 'histories', hid, 'data'], undefined), `${H(hid)}.data`],
      ['history unit not a stress', edit(f, ['analysis', 'durability', 'histories', hid, 'unit'], 'furlong'), `${H(hid)}.unit`],
      ['history source', edit(f, ['analysis', 'durability', 'histories', hid, 'source'], undefined), `${H(hid)}.source.citation`],
      [
        'history empty citation',
        edit(f, ['analysis', 'durability', 'histories', hid, 'source', 'citation'], ' '),
        `${H(hid)}.source.citation`,
      ],
      [
        'blocks rows non-array',
        edit(g, ['analysis', 'durability', 'histories', fracture.historyId, 'data', 'rows'], {}),
        `${D}.histories.${fracture.historyId}.data.rows`,
      ],
      [
        'blocks row without cycles',
        edit(g, [...gh('data', 'rows', 0, 'cycles')], undefined),
        `${D}.histories.${fracture.historyId}.data.rows[0]`,
      ],
      ['blocks row cycles <= 0', edit(g, gh('data', 'rows', 0, 'cycles'), 0), `${D}.histories.${fracture.historyId}.data.rows.0`],
      ['case name', edit(f, fc('name'), undefined), `${fcPath}.name`],
      ['case method enum', edit(f, fc('method'), 'ratchet'), `${fcPath}.method`],
      ['case mapping non-array', edit(f, fc('mapping'), {}), `${fcPath}.mapping`],
      ['case mapping empty', edit(f, fc('mapping'), []), `${fcPath}.mapping`],
      ['case dangling history', edit(f, fc('mapping', 0, 'historyId'), 'lh-ghost'), `${fcPath}.mapping[0].historyId`],
      ['case scale type', edit(f, fc('mapping', 0, 'scale'), '1'), `${fcPath}.mapping[0].scale`],
      ['case dangling analysis', edit(f, fc('analysisId'), 'ghost'), `${fcPath}.analysisId`],
      ['case measure enum', edit(f, fc('measure'), 'tresca'), `${fcPath}.measure`],
      ['case mean model enum', edit(f, fc('meanStress'), 'kinked'), `${fcPath}.meanStress`],
      ['case locations count', edit(f, fc('locations', 'count'), 0), `${fcPath}.locations`],
      ['case dangling material', edit(f, fc('material', 'recordId'), 'ghost'), `${fcPath}.material.recordId`],
      ['case dangling model', edit(f, fc('material', 'modelId'), 'ghost'), `${fcPath}.material.modelId`],
      ['case material missing', edit(f, fc('material'), undefined), `${fcPath}.material`],
      ['case notch', edit(f, fc('notch'), { kt: 0.5, q: 2, feIncludesKt: 'no' }), `${fcPath}.notch`],
      ['case counting enum', edit(f, fc('counting', 'method'), 'peaks'), `${fcPath}.counting`],
      ['case counting gate', edit(f, fc('counting', 'gate'), -1), `${fcPath}.counting`],
      ['case life negative', edit(f, fc('requiredLife', 'value'), -5), `${fcPath}.requiredLife.value`],
      ['case life unit enum', edit(f, fc('requiredLife', 'unit'), 'years'), `${fcPath}.requiredLife.unit`],
      ['case flights without blocksPerUnit', edit(f, fc('requiredLife', 'unit'), 'flights'), `${fcPath}.requiredLife.blocksPerUnit`],
      ['case factors missing', edit(f, fc('factors'), undefined), `${fcPath}.factors`],
      ['case damageLimit', edit(f, fc('factors', 'damageLimit'), 0), `${fcPath}.factors.damageLimit`],
      ['case scatter < 1', edit(f, fc('factors', 'scatter', 'value'), 0.5), `${fcPath}.factors.scatter`],
      ['case modifiers non-array', edit(f, fc('factors', 'modifiers'), {}), `${fcPath}.factors.modifiers`],
      [
        'case modifier value',
        edit(f, fc('factors', 'modifiers'), [{ name: 'surface', value: -1, justification: 'x' }]),
        `${fcPath}.factors.modifiers[0]`,
      ],
      ['case compressiveMean', edit(f, fc('factors', 'compressiveMean'), 'maybe'), `${fcPath}.factors.compressiveMean`],
      ['case marginalBand', edit(f, fc('factors', 'marginalBand'), -1), `${fcPath}.factors.marginalBand`],
      ['strain_life without cyclic model', edit(f, fc('method'), 'strain_life'), `${fcPath}.material.cyclicModelId`],
      ['crack kind enum', edit(g, gk('geometry', 'kind'), 'hole'), `${D}.cracks.${fracture.crackId}.geometry.kind`],
      ['crack width negative', edit(g, gk('geometry', 'W', 'value'), -200), `${D}.cracks.${fracture.crackId}.geometry.W`],
      ['crack a zero', edit(g, gk('geometry', 'a', 'value'), 0), `${D}.cracks.${fracture.crackId}.geometry.a`],
      ['crack a quantity', edit(g, gk('geometry', 'a'), 5), `${D}.cracks.${fracture.crackId}.geometry.a`],
      ['crack unit not a length', edit(g, gk('geometry', 't', 'unit'), 'MPa'), `${D}.cracks.${fracture.crackId}.geometry.t`],
      ['crack a >= W/2', edit(g, gk('geometry', 'a', 'value'), 150), `${D}.cracks.${fracture.crackId}.geometry:`],
      ['crack reference stress', edit(g, gk('referenceStress', 'source'), 'fe'), `${D}.cracks.${fracture.crackId}.referenceStress.source`],
      ['crack missing name', edit(g, gk('name'), undefined), `${D}.cracks.${fracture.crackId}.name`],
      ['growth dangling crack', edit(g, gc('crackId'), 'cr-ghost'), `${gcPath}.crackId`],
      ['growth dangling growth model', edit(g, gc('material', 'growthModelId'), 'ghost'), `${gcPath}.material.growthModelId`],
      ['growth dangling toughness model', edit(g, gc('material', 'toughnessModelId'), 'ghost'), `${gcPath}.material.toughnessModelId`],
      ['growth dangling material', edit(g, gc('material', 'recordId'), 'ghost'), `${gcPath}.material.recordId`],
      ['growth histories empty', edit(g, gc('histories'), []), `${gcPath}.histories`],
      ['growth histories non-array', edit(g, gc('histories'), 'h'), `${gcPath}.histories`],
      ['growth dangling history', edit(g, gc('histories', 0, 'historyId'), 'ghost'), `${gcPath}.histories[0].historyId`],
      ['growth sequence enum', edit(g, gc('sequence'), 'random'), `${gcPath}.sequence`],
      ['growth maxDaOverA zero', edit(g, gc('integration', 'maxDaOverA'), 0), `${gcPath}.integration.maxDaOverA`],
      ['growth maxDaOverA large', edit(g, gc('integration', 'maxDaOverA'), 0.9), `${gcPath}.integration.maxDaOverA`],
      ['growth aInitial negative', edit(g, gc('growth', 'aInitial', 'value'), -1), `${gcPath}.growth.aInitial`],
      ['growth aInitial missing', edit(g, gc('growth', 'aInitial'), undefined), `${gcPath}.growth.aInitial`],
      ['growth aDetectable unit', edit(g, gc('growth', 'aDetectable', 'unit'), 'MPa'), `${gcPath}.growth.aDetectable`],
      ['growth growth missing', edit(g, gc('growth'), undefined), `${gcPath}.growth`],
      [
        'growth residual stress unit',
        edit(g, gc('residualStrengthStress'), { value: 100, unit: 'mm' }),
        `${gcPath}.residualStrengthStress`,
      ],
      ['growth factor < 1', edit(g, gc('factors', 'scatterInterval', 'value'), 0.1), `${gcPath}.factors.scatterInterval`],
      ['growth factors missing', edit(g, gc('factors'), undefined), `${gcPath}.factors`],
      ['growth marginalBand', edit(g, gc('factors', 'marginalBand'), -3), `${gcPath}.factors.marginalBand`],
    ];
  };

  it.each(cases().map((entry, index) => [entry[0], index] as const))('rejects: %s', (_label, index) => {
    const [, raw, expected] = cases()[index] ?? ['', {}, ''];
    const errors = analysisErrors(raw);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.some((error) => error.includes(expected))).toBe(true);
  });

  it('accepts the optional parts when valid (walker, component measure, hours with blocksPerUnit, residual stress)', () => {
    const f = edit(
      edit(
        edit(rawOf(fatigue.doc), ['analysis', 'durability', 'fatigueCases', fatigue.caseId, 'meanStress'], { walker: 0.6 }),
        ['analysis', 'durability', 'fatigueCases', fatigue.caseId, 'measure'],
        { component: 'sxy' },
      ),
      ['analysis', 'durability', 'fatigueCases', fatigue.caseId, 'requiredLife'],
      { value: 5, unit: 'hours', blocksPerUnit: 2 },
    );
    expect(analysisErrors(f)).toEqual([]);
    const g = edit(rawOf(fracture.doc), ['analysis', 'durability', 'crackGrowthCases', fracture.caseId, 'residualStrengthStress'], {
      value: 100,
      unit: 'MPa',
    });
    expect(analysisErrors(g)).toEqual([]);
  });
});

/** mulberry32 */
function rng(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const JUNK: readonly unknown[] = [undefined, null, 'x', '', -1, 0, 1e308, 0.5, NaN, Infinity, [], {}, [1], { value: 1 }, true, 'MPa', 'mm'];

function leafPaths(node: unknown, prefix: Path, out: Path[]): void {
  out.push(prefix);
  if (Array.isArray(node)) node.forEach((item, index) => leafPaths(item, [...prefix, index], out));
  else if (node !== null && typeof node === 'object')
    for (const [key, value] of Object.entries(node)) leafPaths(value, [...prefix, key], out);
}

function runAll(doc: CadDocument, ids: { caseId: string; historyId: string; crackId?: string; fatigue: boolean }): void {
  const params: Json = { caseId: ids.caseId, historyId: ids.historyId, crackId: ids.crackId, stress: { value: 100, unit: 'MPa' } };
  const names = ids.fatigue
    ? ['compute_fatigue', 'check_fatigue', 'count_cycles', 'update_fatigue_case', 'set_fatigue_factors']
    : [
        'compute_crack_growth',
        'compute_residual_strength',
        'compute_inspection_interval',
        'check_damage_tolerance',
        'stress_intensity',
        'update_crack',
      ];
  for (const name of names) execute(doc, name, params);
}

describe('durability load validation: fuzz', () => {
  it.each([
    ['fatigue', true],
    ['fracture', false],
  ] as const)('no %s command throws on a randomly corrupted document that passed validation', (_label, isFatigue) => {
    const source = rawOf(isFatigue ? fatigue.doc : fracture.doc);
    const paths: Path[] = [];
    leafPaths(source['analysis'] && (source['analysis'] as Json)['durability'], ['analysis', 'durability'], paths);
    const random = rng(isFatigue ? 7 : 11);
    const ids = isFatigue
      ? { caseId: fatigue.caseId, historyId: fatigue.historyId, fatigue: true }
      : { caseId: fracture.caseId, historyId: fracture.historyId, crackId: fracture.crackId, fatigue: false };
    let rejected = 0;
    let accepted = 0;
    for (let round = 0; round < 400; round += 1) {
      let raw = source;
      for (let hits = 0; hits < 1 + Math.floor(random() * 2); hits += 1) {
        const path = paths[Math.floor(random() * (paths.length - 1)) + 1] ?? paths[1] ?? [];
        try {
          raw = edit(raw, path, JUNK[Math.floor(random() * JUNK.length)]);
        } catch {
          // the path no longer exists after an earlier corruption
        }
      }
      const errors = analysisErrors(raw);
      if (errors.length > 0) {
        rejected += 1;
        continue;
      }
      accepted += 1;
      expect(() => runAll(raw as unknown as CadDocument, ids)).not.toThrow();
    }
    expect(rejected).toBeGreaterThan(100);
    expect(accepted).toBeGreaterThan(0);
  });
});
