/** Structural validation of a raw `analysis.durability` slice (PHY-07 fatigue, PHY-08 fracture): shapes, enums, positivity, references. */

import { isRecord } from '@lib/isRecord';
import { convertValue, isUnitFailure } from '@lib/quantity';
import type { CrackGeometry, LoadHistory } from '@core/model/durability';
import { historyProblem } from '../fatigue/historyData';
import { solvedGeometry } from '../fracture/kSolutions';

type Raw = Record<string, unknown>;

const HISTORY_KINDS = ['stress', 'load_factor', 'strain'];
const REPEATS = ['once', 'repeating'];
const METHODS = ['stress_life', 'strain_life'];
const MEASURES = ['signed_von_mises', 'max_principal'];
const COMPONENTS = ['sxx', 'syy', 'szz', 'sxy', 'syz', 'szx'];
const MEAN_MODELS = ['none', 'goodman', 'gerber', 'soderberg', 'morrow', 'swt'];
const COUNTING_METHODS = ['rainflow_3pt', 'rainflow_4pt', 'rainflow_repeating'];
const RESIDUES = ['half_cycles', 'repeat'];
const LIFE_UNITS = ['cycles', 'blocks', 'flights', 'hours'];
const MODIFIER_NAMES = ['surface', 'size', 'reliability', 'environment', 'other'];
const COMPRESSIVE = ['no_benefit', 'formula'];
const CRACK_KINDS = ['center_through', 'edge_through', 'surface_semi_elliptical'];
const EDGE_FORMS = ['tada', 'polynomial'];
const SEQUENCES = ['cycle_by_cycle', 'rainflow_blocks'];

const BASE = 'analysis.durability';

interface Scope {
  readonly raw: Raw;
  readonly errors: string[];
}

const oneOf = (list: readonly string[], value: unknown): boolean => typeof value === 'string' && list.includes(value);
const isNumber = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const isText = (value: unknown): value is string => typeof value === 'string';
const isFilled = (value: unknown): value is string => typeof value === 'string' && value.trim() !== '';

function isQuantity(value: unknown): value is { value: number; unit: string } {
  return isRecord(value) && isNumber(value['value']) && isText(value['unit']);
}

/** Pushes `${path}: ${message}` when `ok` is false. */
function expect(scope: Scope, ok: boolean, path: string, message: string): boolean {
  if (!ok) scope.errors.push(`${path}: ${message}`);
  return ok;
}

function checkBag(scope: Scope, name: string, bag: unknown, order: unknown, check: (path: string, value: Raw) => void): void {
  const path = `${BASE}.${name}`;
  if (!isRecord(bag)) return void scope.errors.push(`${path}: expected a record`);
  if (!Array.isArray(order) || !order.every(isText)) return void scope.errors.push(`${path}Order: expected a list of ids`);
  const ids: string[] = order;
  if (new Set(ids).size !== ids.length) scope.errors.push(`${path}Order: duplicate ids`);
  for (const id of ids) if (!Object.hasOwn(bag, id)) scope.errors.push(`${path}Order: '${id}' is listed but missing from ${name}`);
  for (const [id, value] of Object.entries(bag)) {
    const where = `${path}.${id}`;
    if (!ids.includes(id)) scope.errors.push(`${where}: missing from ${name}Order`);
    if (!isRecord(value) || value['id'] !== id) scope.errors.push(`${where}: entry is malformed (id must equal its key '${id}')`);
    else check(where, value);
  }
}

function materialModelExists(scope: Scope, recordId: string, modelId: unknown): boolean {
  const materials = scope.raw['materials'];
  const record = isRecord(materials) && Object.hasOwn(materials, recordId) ? materials[recordId] : undefined;
  const models = isRecord(record) ? record['materialModels'] : undefined;
  return Array.isArray(models) && models.some((entry) => isRecord(entry) && entry['id'] === modelId);
}

function checkMaterialRef(
  scope: Scope,
  where: string,
  material: unknown,
  modelFields: readonly string[],
  optional: readonly string[],
): void {
  if (!expect(scope, isRecord(material), `${where}.material`, 'expected { recordId, modelId }') || !isRecord(material)) return;
  const recordId = material['recordId'];
  if (!expect(scope, isFilled(recordId), `${where}.material.recordId`, 'must be a non-empty text')) return;
  const materials = scope.raw['materials'];
  expect(
    scope,
    isRecord(materials) && isText(recordId) && Object.hasOwn(materials, recordId),
    `${where}.material.recordId`,
    `material '${String(recordId)}' does not exist`,
  );
  for (const field of [...modelFields, ...optional]) {
    const modelId = material[field];
    if (optional.includes(field) && modelId === undefined) continue;
    if (expect(scope, isFilled(modelId), `${where}.material.${field}`, 'must be a non-empty text') && isText(recordId))
      expect(
        scope,
        materialModelExists(scope, recordId, modelId),
        `${where}.material.${field}`,
        `no model '${String(modelId)}' on '${recordId}'`,
      );
  }
}

function checkHistory(scope: Scope, where: string, history: Raw): void {
  expect(scope, isText(history['name']), `${where}.name`, 'must be text');
  const kindOk = expect(scope, oneOf(HISTORY_KINDS, history['kind']), `${where}.kind`, 'must be stress, load_factor or strain');
  const unitOk = expect(scope, isText(history['unit']), `${where}.unit`, 'must be text');
  expect(scope, oneOf(REPEATS, history['repeats']), `${where}.repeats`, 'must be once or repeating');
  const source = history['source'];
  const sourceOk = expect(scope, isRecord(source) && isText(source['citation']), `${where}.source.citation`, 'must be text');
  const data = history['data'];
  let dataOk = false;
  if (!expect(scope, isRecord(data), `${where}.data`, 'expected { form, values | rows }') || !isRecord(data)) return;
  if (data['form'] === 'series') {
    dataOk = expect(
      scope,
      Array.isArray(data['values']) && data['values'].every(isNumber),
      `${where}.data.values`,
      'must be a list of finite numbers',
    );
  } else if (data['form'] === 'blocks') {
    const rows = data['rows'];
    dataOk = expect(scope, Array.isArray(rows), `${where}.data.rows`, 'must be a list');
    if (Array.isArray(rows))
      rows.forEach((row, index) => {
        const rowOk = isRecord(row) && isNumber(row['max']) && isNumber(row['min']) && isNumber(row['cycles']);
        if (!expect(scope, rowOk, `${where}.data.rows[${index}]`, 'needs finite max, min and cycles')) dataOk = false;
      });
  } else expect(scope, false, `${where}.data.form`, 'must be series or blocks');
  if (kindOk && unitOk && sourceOk && dataOk && isRecord(source)) {
    const problem = historyProblem(history['kind'] as LoadHistory['kind'], history['unit'] as string, data as LoadHistory['data'], {
      citation: source['citation'] as string,
    });
    if (problem !== null) scope.errors.push(`${where}.${problem.path}: ${problem.message}`);
  }
}

function checkFactors(scope: Scope, where: string, factors: unknown): void {
  if (!expect(scope, isRecord(factors), where, 'expected a factors record') || !isRecord(factors)) return;
  expect(scope, isNumber(factors['damageLimit']) && factors['damageLimit'] > 0, `${where}.damageLimit`, 'must be a number > 0');
  expect(scope, oneOf(COMPRESSIVE, factors['compressiveMean']), `${where}.compressiveMean`, 'must be no_benefit or formula');
  const scatter = factors['scatter'];
  if (scatter !== undefined)
    expect(
      scope,
      isRecord(scatter) && isNumber(scatter['value']) && scatter['value'] >= 1 && isFilled(scatter['source']),
      `${where}.scatter`,
      'needs value >= 1 and a non-empty source',
    );
  const band = factors['marginalBand'];
  if (band !== undefined) expect(scope, isNumber(band) && band >= 0, `${where}.marginalBand`, 'must be a number >= 0');
  const modifiers = factors['modifiers'];
  if (!expect(scope, Array.isArray(modifiers), `${where}.modifiers`, 'must be a list') || !Array.isArray(modifiers)) return;
  modifiers.forEach((entry, index) =>
    expect(
      scope,
      isRecord(entry) &&
        oneOf(MODIFIER_NAMES, entry['name']) &&
        isNumber(entry['value']) &&
        entry['value'] > 0 &&
        isFilled(entry['justification']),
      `${where}.modifiers[${index}]`,
      'needs a known name, value > 0 and a justification',
    ),
  );
}

function checkMapping(scope: Scope, where: string, mapping: unknown, histories: unknown): void {
  if (!expect(scope, Array.isArray(mapping) && mapping.length > 0, where, 'must be a list with >= 1 entry') || !Array.isArray(mapping))
    return;
  mapping.forEach((entry, index) => {
    const path = `${where}[${index}]`;
    if (!expect(scope, isRecord(entry), path, 'expected { historyId, scale }') || !isRecord(entry)) return;
    expect(scope, isNumber(entry['scale']), `${path}.scale`, 'must be a finite number');
    if (entry['loadCase'] !== undefined) expect(scope, isText(entry['loadCase']), `${path}.loadCase`, 'must be text');
    const id = entry['historyId'];
    if (expect(scope, isText(id), `${path}.historyId`, 'must be a history id'))
      expect(
        scope,
        isRecord(histories) && Object.hasOwn(histories, String(id)),
        `${path}.historyId`,
        `history '${String(id)}' does not exist`,
      );
  });
}

function checkMeasureAndMean(scope: Scope, where: string, fatigueCase: Raw): void {
  const measure = fatigueCase['measure'];
  expect(
    scope,
    oneOf(MEASURES, measure) || (isRecord(measure) && oneOf(COMPONENTS, measure['component'])),
    `${where}.measure`,
    'must be signed_von_mises, max_principal or { component }',
  );
  const mean = fatigueCase['meanStress'];
  expect(
    scope,
    oneOf(MEAN_MODELS, mean) || (isRecord(mean) && isNumber(mean['walker'])),
    `${where}.meanStress`,
    'must be none, goodman, gerber, soderberg, morrow, swt or { walker }',
  );
  const locations = fatigueCase['locations'];
  expect(
    scope,
    isRecord(locations) && locations['mode'] === 'hotspots' && isNumber(locations['count']) && locations['count'] >= 1,
    `${where}.locations`,
    'needs mode hotspots and count >= 1',
  );
  const notch = fatigueCase['notch'];
  if (notch !== undefined)
    expect(
      scope,
      isRecord(notch) &&
        isNumber(notch['kt']) &&
        notch['kt'] >= 1 &&
        isNumber(notch['q']) &&
        notch['q'] >= 0 &&
        notch['q'] <= 1 &&
        typeof notch['feIncludesKt'] === 'boolean',
      `${where}.notch`,
      'needs kt >= 1, q in [0, 1] and boolean feIncludesKt',
    );
}

function checkFatigueCase(scope: Scope, where: string, fatigueCase: Raw): void {
  const durability = (scope.raw['analysis'] as Raw)['durability'] as Raw;
  expect(scope, isText(fatigueCase['name']), `${where}.name`, 'must be text');
  const method = fatigueCase['method'];
  expect(scope, oneOf(METHODS, method), `${where}.method`, 'must be stress_life or strain_life');
  const analysisId = fatigueCase['analysisId'];
  if (analysisId !== undefined) {
    const cases = (scope.raw['analysis'] as Raw)['cases'];
    expect(
      scope,
      isText(analysisId) && isRecord(cases) && Object.hasOwn(cases, analysisId),
      `${where}.analysisId`,
      'analysis case does not exist',
    );
  }
  checkMapping(scope, `${where}.mapping`, fatigueCase['mapping'], durability['histories']);
  checkMeasureAndMean(scope, where, fatigueCase);
  checkMaterialRef(scope, where, fatigueCase['material'], ['modelId'], ['cyclicModelId']);
  if (method === 'strain_life' && isRecord(fatigueCase['material']))
    expect(
      scope,
      isFilled(fatigueCase['material']['cyclicModelId']),
      `${where}.material.cyclicModelId`,
      'strain_life needs a cyclicModelId',
    );
  const counting = fatigueCase['counting'];
  const countingOk =
    isRecord(counting) &&
    oneOf(COUNTING_METHODS, counting['method']) &&
    oneOf(RESIDUES, counting['residue']) &&
    (counting['gate'] === undefined || (isNumber(counting['gate']) && counting['gate'] >= 0));
  expect(scope, countingOk, `${where}.counting`, 'needs a rainflow method, a residue rule and an optional gate >= 0');
  const life = fatigueCase['requiredLife'];
  if (expect(scope, isRecord(life), `${where}.requiredLife`, 'expected { value, unit }') && isRecord(life)) {
    expect(scope, isNumber(life['value']) && life['value'] > 0, `${where}.requiredLife.value`, 'must be a number > 0');
    if (expect(scope, oneOf(LIFE_UNITS, life['unit']), `${where}.requiredLife.unit`, 'must be cycles, blocks, flights or hours')) {
      const perUnit = life['blocksPerUnit'];
      const needed = life['unit'] === 'flights' || life['unit'] === 'hours';
      expect(
        scope,
        perUnit === undefined ? !needed : isNumber(perUnit) && perUnit > 0,
        `${where}.requiredLife.blocksPerUnit`,
        needed ? 'must be a number > 0 for flights and hours' : 'must be a number > 0 when present',
      );
    }
  }
  checkFactors(scope, `${where}.factors`, fatigueCase['factors']);
}

function checkCrack(scope: Scope, where: string, crack: Raw): void {
  expect(scope, isText(crack['name']), `${where}.name`, 'must be text');
  const reference = crack['referenceStress'];
  expect(scope, isRecord(reference) && reference['source'] === 'history', `${where}.referenceStress.source`, "must be 'history'");
  const geometry = crack['geometry'];
  if (!expect(scope, isRecord(geometry) && oneOf(CRACK_KINDS, geometry['kind']), `${where}.geometry.kind`, 'unknown crack kind')) return;
  if (!isRecord(geometry)) return;
  const lengths =
    geometry['kind'] === 'center_through' ? ['a', 'W', 't'] : geometry['kind'] === 'edge_through' ? ['a', 'b', 't'] : ['a', 'c', 't', 'b'];
  let shapeOk = true;
  for (const name of lengths) {
    const quantity = geometry[name];
    const path = `${where}.geometry.${name}`;
    if (!isQuantity(quantity)) shapeOk = expect(scope, false, path, 'must be { value, unit }');
    else if (isUnitFailure(convertValue(quantity.value, quantity.unit, 'm')))
      shapeOk = expect(scope, false, path, `unit '${quantity.unit}' is not a length`);
    else if (!expect(scope, quantity.value > 0, path, 'must be a length > 0')) shapeOk = false;
  }
  if (geometry['kind'] === 'edge_through')
    shapeOk = expect(scope, oneOf(EDGE_FORMS, geometry['form']), `${where}.geometry.form`, 'must be tada or polynomial') && shapeOk;
  if (shapeOk) {
    const solved = solvedGeometry(geometry as unknown as CrackGeometry);
    if (typeof solved === 'string') scope.errors.push(`${where}.geometry: ${solved}`);
  }
}

function checkLength(scope: Scope, path: string, quantity: unknown, dimension: 'm' | 'MPa'): void {
  if (!expect(scope, isQuantity(quantity), path, 'must be { value, unit }') || !isQuantity(quantity)) return;
  if (isUnitFailure(convertValue(quantity.value, quantity.unit, dimension)))
    expect(scope, false, path, `unit '${quantity.unit}' is not ${dimension === 'm' ? 'a length' : 'a stress'}`);
  else expect(scope, quantity.value > 0, path, `must be ${dimension === 'm' ? 'a length' : 'a stress'} > 0`);
}

function checkGrowthFactors(scope: Scope, where: string, factors: unknown): void {
  if (!expect(scope, isRecord(factors), where, 'expected a factors record') || !isRecord(factors)) return;
  for (const name of ['scatterThreshold', 'scatterInterval']) {
    const factor = factors[name];
    if (factor !== undefined)
      expect(
        scope,
        isRecord(factor) && isNumber(factor['value']) && factor['value'] >= 1 && isFilled(factor['source']),
        `${where}.${name}`,
        'needs value >= 1 and a non-empty source',
      );
  }
  const band = factors['marginalBand'];
  if (band !== undefined) expect(scope, isNumber(band) && band >= 0, `${where}.marginalBand`, 'must be a number >= 0');
}

function checkGrowthCase(scope: Scope, where: string, growthCase: Raw): void {
  const durability = (scope.raw['analysis'] as Raw)['durability'] as Raw;
  expect(scope, isText(growthCase['name']), `${where}.name`, 'must be text');
  const crackId = growthCase['crackId'];
  if (expect(scope, isText(crackId), `${where}.crackId`, 'must be a crack id'))
    expect(
      scope,
      isRecord(durability['cracks']) && Object.hasOwn(durability['cracks'], String(crackId)),
      `${where}.crackId`,
      `crack '${String(crackId)}' does not exist`,
    );
  checkMaterialRef(scope, where, growthCase['material'], ['growthModelId', 'toughnessModelId'], []);
  const histories = growthCase['histories'];
  if (expect(scope, Array.isArray(histories) && histories.length > 0, `${where}.histories`, 'must be a list with >= 1 entry'))
    checkMapping(scope, `${where}.histories`, histories, durability['histories']);
  expect(scope, oneOf(SEQUENCES, growthCase['sequence']), `${where}.sequence`, 'must be cycle_by_cycle or rainflow_blocks');
  const integration = growthCase['integration'];
  const step = isRecord(integration) ? integration['maxDaOverA'] : undefined;
  expect(scope, isNumber(step) && step > 0 && step <= 0.5, `${where}.integration.maxDaOverA`, 'must be a number in (0, 0.5]');
  const growth = growthCase['growth'];
  if (expect(scope, isRecord(growth), `${where}.growth`, 'expected { aInitial, ... }') && isRecord(growth)) {
    checkLength(scope, `${where}.growth.aInitial`, growth['aInitial'], 'm');
    for (const name of ['aDetectable', 'aTarget'])
      if (growth[name] !== undefined) checkLength(scope, `${where}.growth.${name}`, growth[name], 'm');
  }
  if (growthCase['residualStrengthStress'] !== undefined)
    checkLength(scope, `${where}.residualStrengthStress`, growthCase['residualStrengthStress'], 'MPa');
  checkGrowthFactors(scope, `${where}.factors`, growthCase['factors']);
}

/** Errors of the `analysis.durability` slice of a raw document (call after the analysis shell is known to be a record). */
export function durabilityErrors(raw: Raw): string[] {
  const analysis = raw['analysis'];
  const durability = isRecord(analysis) ? analysis['durability'] : undefined;
  if (durability === undefined) return [];
  if (!isRecord(durability)) return [`${BASE}: expected a record`];
  const scope: Scope = { raw, errors: [] };
  checkBag(scope, 'histories', durability['histories'], durability['historyOrder'], (where, value) => checkHistory(scope, where, value));
  checkBag(scope, 'cracks', durability['cracks'], durability['crackOrder'], (where, value) => checkCrack(scope, where, value));
  checkBag(scope, 'fatigueCases', durability['fatigueCases'], durability['fatigueCaseOrder'], (where, value) =>
    checkFatigueCase(scope, where, value),
  );
  checkBag(scope, 'crackGrowthCases', durability['crackGrowthCases'], durability['crackGrowthCaseOrder'], (where, value) =>
    checkGrowthCase(scope, where, value),
  );
  return scope.errors;
}
