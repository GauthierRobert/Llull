/**
 * Load-time validation of `plant.data` (the plugin's `DocumentExtension.validate`, plant 08 DAT §3): structure first, then references,
 * then the semantic invariants (class resolution, tags unique per scope; a tag that drifted from its format is a `check_plant_data` finding, not a load error). A file breaking one is refused.
 * An orphan (a deleted model element) is NOT an error: `check_plant_data` reports it.
 */

import { isRecord } from '@lib/isRecord';
import { resolveClass } from './classes';
import { ifcMappingProblem } from './ifcMapping';
import { kindRank } from './hierarchy';
import { HIERARCHY_KINDS, type PlantDataModel } from './model';
import { definitionProblem } from './properties';
import { parseTagFormat } from './tagFormat';
import { objectErrors, isScalar, orderErrors } from './validateObjects';

const TAG_SCOPES = ['plant', 'site', 'project'];

function settingsErrors(raw: unknown): string[] {
  if (!isRecord(raw)) return ['plant.data.settings must be an object'];
  const errors: string[] = [];
  if (typeof raw['batteryLimitPattern'] !== 'string') errors.push('plant.data.settings.batteryLimitPattern must be a string');
  else
    try {
      new RegExp(raw['batteryLimitPattern']);
    } catch {
      errors.push('plant.data.settings.batteryLimitPattern must be a regular expression');
    }
  if (!TAG_SCOPES.includes(String(raw['defaultTagScope'])))
    errors.push('plant.data.settings.defaultTagScope must be plant, site or project');
  return errors;
}

function hierarchyErrors(raw: Record<string, unknown>): string[] {
  const errors: string[] = [];
  const nodes = raw['hierarchy'];
  if (!isRecord(nodes)) return ['plant.data.hierarchy must be an object'];
  const siblings = new Set<string>();
  for (const [key, node] of Object.entries(nodes)) {
    const path = `plant.data.hierarchy.${key}`;
    if (!isRecord(node)) {
      errors.push(`${path} must be an object`);
      continue;
    }
    if (node['id'] !== key) errors.push(`${path}.id must equal its key`);
    if (typeof node['code'] !== 'string' || node['code'] === '') errors.push(`${path}.code must be a non-empty string`);
    if (typeof node['name'] !== 'string') errors.push(`${path}.name must be a string`);
    const kind = node['kind'];
    if (typeof kind !== 'string' || !(HIERARCHY_KINDS as readonly string[]).includes(kind))
      errors.push(`${path}.kind must be one of ${HIERARCHY_KINDS.join(', ')}`);
    if (!isRecord(node['properties']) || !Object.values(node['properties']).every(isScalar))
      errors.push(`${path}.properties must map names to text, numbers, booleans or null`);
    const parentId = node['parentId'];
    if (parentId === null) {
      if (kind !== 'site') errors.push(`${path}: only a site has no parent`);
    } else if (typeof parentId !== 'string' || !isRecord(nodes[parentId])) errors.push(`${path}.parentId must name a node`);
    else {
      const parent = nodes[parentId] as Record<string, unknown>;
      if (
        typeof kind === 'string' &&
        typeof parent['kind'] === 'string' &&
        (HIERARCHY_KINDS as readonly string[]).includes(parent['kind']) &&
        (HIERARCHY_KINDS as readonly string[]).includes(kind)
      ) {
        if (kindRank(kind as (typeof HIERARCHY_KINDS)[number]) <= kindRank(parent['kind'] as (typeof HIERARCHY_KINDS)[number]))
          errors.push(`${path}: a ${kind} cannot be below a ${String(parent['kind'])} (site > plant > area > unit > system)`);
      }
    }
    const siblingKey = `${String(parentId)}|${String(node['code'])}`;
    if (siblings.has(siblingKey)) errors.push(`${path}.code ${String(node['code'])} is used twice under one parent`);
    siblings.add(siblingKey);
  }
  return [...errors, ...orderErrors(raw['hierarchyOrder'], nodes, 'plant.data.hierarchyOrder')];
}

function classShapeErrors(key: string, cls: Record<string, unknown>): string[] {
  const path = `plant.data.classes.${key}`;
  const errors: string[] = [];
  if (cls['name'] !== key) errors.push(`${path}.name must equal its key`);
  if (cls['parent'] !== null && typeof cls['parent'] !== 'string') errors.push(`${path}.parent must be a class name or null`);
  if (typeof cls['abstract'] !== 'boolean') errors.push(`${path}.abstract must be a boolean`);
  if (cls['source'] !== 'library' && cls['source'] !== 'project') errors.push(`${path}.source must be library or project`);
  for (const field of ['classCode', 'tagFormat'])
    if (cls[field] !== undefined && typeof cls[field] !== 'string') errors.push(`${path}.${field} must be a string`);
  if (typeof cls['tagFormat'] === 'string') {
    const parsed = parseTagFormat(cls['tagFormat']);
    if (!parsed.ok) errors.push(`${path}.tagFormat: ${parsed.problem}`);
  }
  if (cls['tagScope'] !== undefined && !TAG_SCOPES.includes(String(cls['tagScope'])))
    errors.push(`${path}.tagScope must be plant, site or project`);
  const properties = cls['properties'];
  if (!Array.isArray(properties)) errors.push(`${path}.properties must be an array`);
  else
    properties.forEach((definition, index) => {
      if (
        !isRecord(definition) ||
        typeof definition['name'] !== 'string' ||
        typeof definition['displayName'] !== 'string' ||
        typeof definition['type'] !== 'string'
      )
        errors.push(`${path}.properties[${index}] must be { name, displayName, type, ... }`);
      else {
        const problem = definitionProblem(definition as unknown as Parameters<typeof definitionProblem>[0]);
        if (problem !== null) errors.push(`${path}.properties[${index}]: ${problem}`);
      }
    });
  const ifc = cls['ifc'];
  if (ifc !== undefined) {
    if (!isRecord(ifc) || typeof ifc['entity'] !== 'string') errors.push(`${path}.ifc must be { entity, predefinedType?, objectType? }`);
    else {
      const problem = ifcMappingProblem(ifc as unknown as Parameters<typeof ifcMappingProblem>[0]);
      if (problem !== null) errors.push(`${path}.ifc: ${problem}`);
    }
  }
  return errors;
}

function classErrors(raw: Record<string, unknown>): string[] {
  const classes = raw['classes'];
  if (!isRecord(classes)) return ['plant.data.classes must be an object'];
  const errors = Object.entries(classes).flatMap(([key, cls]) =>
    isRecord(cls) ? classShapeErrors(key, cls) : [`plant.data.classes.${key} must be an object`],
  );
  return [...errors, ...orderErrors(raw['classOrder'], classes, 'plant.data.classOrder')];
}

/** Problems of a raw `plant.data` (empty = valid or absent). */
export function plantDataErrors(raw: unknown): string[] {
  if (raw === undefined) return [];
  if (!isRecord(raw)) return ['plant.data must be an object'];
  if (raw['version'] !== 1) return ['plant.data.version must be 1'];
  const structural = [...settingsErrors(raw['settings']), ...hierarchyErrors(raw), ...classErrors(raw)];
  if (structural.length > 0) return structural;
  const data = raw as unknown as PlantDataModel;
  const resolution = data.classOrder.flatMap((name) => {
    const resolved = resolveClass(data, name);
    return resolved.ok ? [] : [`plant.data.classes.${name}: ${resolved.message}`];
  });
  if (resolution.length > 0) return resolution;
  return objectErrors(raw, data);
}
