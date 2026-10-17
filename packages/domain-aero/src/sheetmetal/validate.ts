/** Value validation of the raw `sheetMetal` document slice (persistence rejects the file when it reports errors). */

import { isRecord } from '@lib/isRecord';
import { isVec2List, isVec2 } from '@lib/vec2';
import { isVec3 } from '@lib/vec3';

const positive = (value: unknown): boolean => typeof value === 'number' && Number.isFinite(value) && value > 0;
const nonNegative = (value: unknown): boolean => typeof value === 'number' && Number.isFinite(value) && value >= 0;
const finite = (value: unknown): boolean => typeof value === 'number' && Number.isFinite(value);
const verification = (value: unknown): boolean => value === 'verified' || value === 'unverified';
const nonEmptyText = (value: unknown): boolean => typeof value === 'string' && value.trim() !== '';

function kErrors(path: string, k: unknown): string[] {
  if (!isRecord(k) || (k['standard'] !== 'ansi' && k['standard'] !== 'din')) return [`${path} must have standard 'ansi' or 'din'`];
  const limit = k['standard'] === 'din' ? 1 : 0.5;
  const inRange = (value: unknown): boolean => typeof value === 'number' && value > 0 && value <= limit;
  if (Array.isArray(k['table'])) {
    const errors = (k['table'] as unknown[]).flatMap((row, i) =>
      isRecord(row) && nonNegative(row['rOverT']) && inRange(row['k'])
        ? []
        : [`${path}.table[${i}] must be { rOverT >= 0, k in (0, ${limit}] }`],
    );
    if (!nonEmptyText(k['source'])) errors.push(`${path}.source is required`);
    if (!verification(k['verification'])) errors.push(`${path}.verification must be verified|unverified`);
    return errors;
  }
  return inRange(k['value']) ? [] : [`${path}.value must be in (0, ${limit}]`];
}

function ruleErrors(name: string, rule: unknown): string[] {
  const path = `sheetMetal.rules.${name}`;
  if (!isRecord(rule) || rule['name'] !== name) return [`${path} must be a rule named ${name}`];
  const errors: string[] = [];
  if (!positive(rule['thickness'])) errors.push(`${path}.thickness must be > 0`);
  if (!nonNegative(rule['insideRadius'])) errors.push(`${path}.insideRadius must be >= 0`);
  errors.push(...kErrors(`${path}.k`, rule['k']));
  for (const [key, threshold] of Object.entries(isRecord(rule['thresholds']) ? rule['thresholds'] : {}))
    if (
      !isRecord(threshold) ||
      !nonNegative(threshold['value']) ||
      !nonEmptyText(threshold['source']) ||
      !verification(threshold['verification'])
    )
      errors.push(`${path}.thresholds.${key} must have value >= 0, source and verification`);
  return errors;
}

function rowErrors(index: number, row: unknown): string[] {
  const path = `sheetMetal.radiusTable[${index}]`;
  if (!isRecord(row)) return [`${path} must be an object`];
  const errors: string[] = [];
  if (!nonEmptyText(row['source'])) errors.push(`${path}.source is required`);
  if (!verification(row['verification'])) errors.push(`${path}.verification must be verified|unverified`);
  if (row['units'] !== 'mm' && row['units'] !== 'in') errors.push(`${path}.units must be mm|in`);
  if (!positive(row['thickness']) || !nonNegative(row['minInsideRadius']) || !finite(row['bendAngle']))
    errors.push(`${path} has an invalid number`);
  if (!nonEmptyText(row['material']) || !nonEmptyText(row['temper'])) errors.push(`${path} needs material and temper`);
  return errors;
}

const sideOk = (value: unknown): boolean => value === 'up' || value === 'down';

function formOk(form: unknown): boolean {
  if (!isRecord(form) || !sideOk(form['direction'])) return false;
  if (form['kind'] === 'flanged_hole')
    return (
      isVec2(form['center']) &&
      positive(form['holeDiameter']) &&
      positive(form['flangeHeight']) &&
      positive(form['lipRadius']) &&
      typeof form['angle'] === 'number' &&
      form['angle'] > 0 &&
      form['angle'] <= Math.PI / 2 + 1e-9
    );
  return (
    form['kind'] === 'bead' &&
    isVec2(form['start']) &&
    isVec2(form['end']) &&
    positive(form['radius']) &&
    positive(form['depth']) &&
    (form['endShape'] === 'round' || form['endShape'] === 'open')
  );
}

function nodeErrors(path: string, node: unknown, nodes: Record<string, unknown>): string[] {
  if (!isRecord(node) || typeof node['id'] !== 'string') return [`${path} must be a node with an id`];
  const flat = (id: unknown): boolean => typeof id === 'string' && isRecord(nodes[id]) && nodes[id]['type'] === 'flat';
  switch (node['type']) {
    case 'flat': {
      const frame = node['frame'];
      const frameOk = isRecord(frame) && isVec3(frame['origin']) && isVec3(frame['xDir']) && isVec3(frame['normal']);
      const cutoutsOk =
        Array.isArray(node['cutouts']) &&
        node['cutouts'].every(
          (cutout) =>
            isRecord(cutout) && isVec2List(cutout['points']) && (cutout['form'] === undefined || typeof cutout['form'] === 'string'),
        );
      return isVec2List(node['outline']) && (node['outline'] as unknown[]).length >= 3 && frameOk && cutoutsOk
        ? []
        : [`${path} is a malformed flat`];
    }
    case 'bend': {
      const line = node['lineInFrom'];
      const ok =
        flat(node['from']) &&
        flat(node['to']) &&
        Array.isArray(line) &&
        line.length === 2 &&
        line.every(isVec2) &&
        finite(node['angle']) &&
        nonNegative(node['insideRadius']);
      return ok ? [] : [`${path} is a malformed bend`];
    }
    case 'joggle':
      return flat(node['on']) && flat(node['incline']) && flat(node['after']) && positive(node['angle']) && positive(node['offset'])
        ? []
        : [`${path} is a malformed joggle`];
    case 'relief':
      return typeof node['bend'] === 'string' && positive(node['width']) && positive(node['depth'])
        ? []
        : [`${path} is a malformed relief`];
    case 'corner_relief':
      return flat(node['on']) && isVec2(node['corner']) && positive(node['size']) ? [] : [`${path} is a malformed corner relief`];
    case 'form':
      return flat(node['on']) && formOk(node['form']) ? [] : [`${path} is a malformed form`];
    case 'hem':
      return typeof node['bend'] === 'string' &&
        flat(node['flat']) &&
        (node['hemType'] === 'closed' || node['hemType'] === 'open') &&
        nonNegative(node['gap']) &&
        positive(node['length'])
        ? []
        : [`${path} is a malformed hem`];
    default:
      return [`${path} has an unknown type`];
  }
}

function partErrors(key: string, part: unknown, rules: Record<string, unknown>): string[] {
  const path = `sheetMetal.parts.${key}`;
  if (!isRecord(part) || part['id'] !== key) return [`${path} must be a part with id ${key}`];
  const nodes = part['nodes'];
  if (!isRecord(nodes) || !Array.isArray(part['order'])) return [`${path} needs nodes and order`];
  const errors: string[] = [];
  if (typeof part['rule'] !== 'string' || rules[part['rule']] === undefined) errors.push(`${path}.rule must name an existing rule`);
  if (part['side'] !== 'up' && part['side'] !== 'down' && part['side'] !== 'mid') errors.push(`${path}.side must be up|down|mid`);
  for (const key of ['materialId', 'layerId'])
    if (part[key] !== undefined && typeof part[key] !== 'string') errors.push(`${path}.${key} must be a string`);
  const rootNode = typeof part['root'] === 'string' ? nodes[part['root']] : undefined;
  if (!isRecord(rootNode) || rootNode['type'] !== 'flat') errors.push(`${path}.root must be a flat`);
  for (const [id, node] of Object.entries(nodes)) {
    errors.push(...nodeErrors(`${path}.nodes.${id}`, node, nodes));
    if (isRecord(node) && node['id'] !== id) errors.push(`${path}.nodes.${id}.id must equal its key`);
  }
  if (
    (part['order'] as unknown[]).length !== Object.keys(nodes).length ||
    !(part['order'] as unknown[]).every((id) => typeof id === 'string' && id in nodes)
  )
    errors.push(`${path}.order must list every node once`);
  return errors;
}

/** Value errors of a raw `sheetMetal` slice (empty when valid). */
export function sheetMetalErrors(raw: unknown): string[] {
  if (!isRecord(raw)) return ['sheetMetal must be an object'];
  const rules = raw['rules'];
  const parts = raw['parts'];
  const table = raw['radiusTable'];
  if (!isRecord(rules) || !isRecord(parts) || !Array.isArray(table)) return ['sheetMetal needs rules, parts and radiusTable'];
  return [
    ...Object.entries(rules).flatMap(([name, rule]) => ruleErrors(name, rule)),
    ...table.flatMap((row, index) => rowErrors(index, row)),
    ...Object.entries(parts).flatMap(([key, part]) => partErrors(key, part, rules)),
  ];
}
