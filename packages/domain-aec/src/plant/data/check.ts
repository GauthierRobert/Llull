/**
 * `check_plant_data` rules (plant 08 DAT §5.13, TR-DAT-30), the MVP set of M1: tag format and uniqueness, required properties, line ends, line size,
 * orphans, unclassified elements, hierarchy, unverified values, reserved tags, and the tag the model object still carries. Port and nozzle rules
 * (DAT_OPEN_PORT, DAT_INFERRED_NOZZLE) arrive with the IFC ports and the nozzle schedule (M2 / M3).
 * @invariant a pure function of the document; findings are ordered by rule, then by natural tag order
 */

import type { CadDocument } from '@core/model/types';
import { resolvedOrNull } from './classes';
import { datFinding, type DataFinding, type FindingSeverity } from './codes';
import { isProcessLine, lineEnds, resolveEnd } from './lines';
import { getPlantData, type PlantDataModel, type PlantObject } from './model';
import { naturalCompare } from './naturalSort';
import { expectedTag } from './objectTag';
import { allProviders, elementOf } from './providers';
import { duplicateTags, objectRegistry } from './registry';

const RULE_ORDER = [
  'DAT_OUTSIDE_HIERARCHY',
  'DAT_TAG_FORMAT',
  'DAT_TAG_DUPLICATE',
  'DAT_TAG_CASE_COLLISION',
  'DAT_REQUIRED_PROPERTY_MISSING',
  'DAT_LINE_END_UNRESOLVED',
  'DAT_LINE_SIZE_MISMATCH',
  'DAT_TAG_MODEL_MISMATCH',
  'DAT_OBJECT_ORPHAN',
  'DAT_UNCLASSIFIED_ELEMENT',
  'DAT_VALUE_UNVERIFIED',
  'DAT_RESERVED_TAG_UNMODELLED',
];

export interface CheckScope {
  /** Objects to check; absent = all of them. */
  readonly objects?: ReadonlySet<string>;
}

const empty = (value: unknown): boolean => value === undefined || value === null || value === '';

/** The plant object and the model object it stands for: what a finding is about. */
const idsOf = (doc: CadDocument, object: PlantObject): string[] => {
  const model = elementOf(doc, object.target);
  return model === null ? [object.id] : [object.id, model.element.id];
};

function objectFindings(doc: CadDocument, data: PlantDataModel, object: PlantObject): DataFinding[] {
  const findings: DataFinding[] = [];
  const ids = idsOf(doc, object);
  const at = (field: string): string => `${object.tag}.${field}`;
  if (data.hierarchy[object.hierarchyId] === undefined)
    findings.push(
      datFinding('DAT_OUTSIDE_HIERARCHY', 'fail', `${object.tag} is placed at the unknown hierarchy node ${object.hierarchyId}`, ids, [
        at('hierarchy'),
      ]),
    );
  const resolved = resolvedOrNull(data, object.className);
  if (resolved === null) return findings;
  const generated = expectedTag(data, object);
  if (!generated.ok)
    findings.push(
      datFinding('DAT_TAG_FORMAT', 'fail', `${object.tag} cannot be generated from its fields: ${generated.message}`, ids, [at('tag')]),
    );
  else if (generated.tag !== object.tag)
    findings.push(
      datFinding(
        'DAT_TAG_FORMAT',
        'fail',
        `tag ${object.tag} does not match the format ${resolved.tagFormat ?? ''} of ${object.className} (it should be ${generated.tag})`,
        ids,
        [at('tag')],
      ),
    );
  for (const definition of resolved.properties)
    if (definition.required === true && empty(object.properties[definition.name]))
      findings.push(
        datFinding('DAT_REQUIRED_PROPERTY_MISSING', 'fail', `${object.tag}: required property ${definition.name} has no value`, ids, [
          at(definition.name),
        ]),
      );
  if (isProcessLine(data, object)) findings.push(...lineFindings(doc, data, object));
  const unverified = Object.entries(object.provenance ?? {}).flatMap(([name, provenance]) =>
    provenance.unverified === true ? [name] : [],
  );
  if (unverified.length > 0)
    findings.push(
      datFinding('DAT_VALUE_UNVERIFIED', 'warn', `${object.tag}: unverified value(s) ${unverified.join(', ')}`, ids, unverified.map(at)),
    );
  if (object.target.kind === 'reserved')
    findings.push(
      datFinding('DAT_RESERVED_TAG_UNMODELLED', 'info', `tag ${object.tag} is reserved and has no model object`, ids, [at('target')]),
    );
  else {
    const model = elementOf(doc, object.target);
    if (model === null)
      findings.push(
        datFinding('DAT_OBJECT_ORPHAN', 'warn', `${object.tag} stands for ${object.target.id}, which no longer exists`, ids, [
          at('target'),
        ]),
      );
    else if (model.element.tag !== undefined && model.element.tag !== object.tag)
      findings.push(
        datFinding(
          'DAT_TAG_MODEL_MISMATCH',
          'warn',
          `${object.tag}: ${model.element.label} carries the tag ${model.element.tag}`,
          [object.id, model.element.id],
          [at('target')],
        ),
      );
  }
  return findings;
}

function lineFindings(doc: CadDocument, data: PlantDataModel, line: PlantObject): DataFinding[] {
  const findings: DataFinding[] = [];
  const ends = lineEnds(doc, line);
  for (const end of ['from', 'to'] as const) {
    const status = resolveEnd(doc, data, line, ends[end]);
    if (status === 'unresolved')
      findings.push(
        datFinding(
          'DAT_LINE_END_UNRESOLVED',
          'fail',
          `line ${line.tag}: ${end} "${ends[end] ?? ''}" is neither a tag nor a battery limit (${data.settings.batteryLimitPattern})`,
          idsOf(doc, line),
          [`${line.tag}.${end}`],
        ),
      );
    else if (status === 'unset')
      findings.push(
        datFinding('DAT_LINE_END_UNRESOLVED', 'warn', `line ${line.tag} has no ${end}`, idsOf(doc, line), [`${line.tag}.${end}`]),
      );
  }
  const model = elementOf(doc, line.target);
  const dn = model?.provider.dn?.(doc, model.element.id);
  const size = line.properties['nominalSize'];
  if (dn !== undefined && typeof size === 'number' && size !== dn)
    findings.push(
      datFinding(
        'DAT_LINE_SIZE_MISMATCH',
        'warn',
        `line ${line.tag}: nominalSize ${size} but the pipe is DN${dn}`,
        [line.id, ...(model ? [model.element.id] : [])],
        [`${line.tag}.nominalSize`],
      ),
    );
  return findings;
}

function tagFindings(data: PlantDataModel, scoped: (ids: readonly string[]) => boolean): DataFinding[] {
  const registry = objectRegistry(data);
  const findings: DataFinding[] = [];
  for (const { tag, ids } of duplicateTags(data, registry))
    if (scoped(ids))
      findings.push(
        datFinding('DAT_TAG_DUPLICATE', 'fail', `tag ${tag} is held by ${ids.length} objects in colliding scopes: ${ids.join(', ')}`, ids, [
          tag,
        ]),
      );
  for (const tags of registry.byScope.values()) {
    const byLower = new Map<string, Array<{ tag: string; ids: readonly string[] }>>();
    for (const [tag, ids] of tags) byLower.set(tag.toLowerCase(), [...(byLower.get(tag.toLowerCase()) ?? []), { tag, ids }]);
    for (const group of byLower.values()) {
      const ids = group.flatMap((entry) => entry.ids);
      if (group.length > 1 && scoped(ids))
        findings.push(
          datFinding(
            'DAT_TAG_CASE_COLLISION',
            'warn',
            `tags ${group.map((entry) => entry.tag).join(', ')} differ only by case`,
            ids,
            group.map((entry) => entry.tag),
          ),
        );
    }
  }
  return findings;
}

function unclassified(doc: CadDocument, data: PlantDataModel): DataFinding[] {
  const claimed = objectRegistry(data).byTarget;
  return allProviders().flatMap((provider) =>
    provider
      .elements(doc)
      .filter((element) => element.needsClass && !claimed.has(`${provider.id}:${element.id}`))
      .map((element) => datFinding('DAT_UNCLASSIFIED_ELEMENT', 'warn', `${element.label} has no plant object`, [element.id], [element.id])),
  );
}

const rank = (finding: DataFinding): number => RULE_ORDER.indexOf(finding.code);

export function checkFindings(doc: CadDocument, scope: CheckScope): DataFinding[] {
  const data = getPlantData(doc);
  const findings: DataFinding[] = [];
  const included = (id: string): boolean => scope.objects === undefined || scope.objects.has(id);
  for (const id of data.objectOrder) {
    const object = data.objects[id];
    if (object !== undefined && included(id)) findings.push(...objectFindings(doc, data, object));
  }
  findings.push(...tagFindings(data, (ids) => ids.some(included)));
  if (scope.objects === undefined) findings.push(...unclassified(doc, data));
  return findings.sort((a, b) => rank(a) - rank(b) || naturalCompare(a.paths[0] ?? a.ids[0] ?? '', b.paths[0] ?? b.ids[0] ?? ''));
}

export function checkStatus(findings: readonly DataFinding[]): 'pass' | 'warn' | 'fail' {
  if (findings.some((finding) => finding.severity === 'fail')) return 'fail';
  return findings.some((finding) => finding.severity === 'warn') ? 'warn' : 'pass';
}

const SEVERITY_RANK: Readonly<Record<FindingSeverity, number>> = { info: 0, warn: 1, fail: 2 };

/** Findings at or above `minimum`. */
export const atLeast = (findings: readonly DataFinding[], minimum: FindingSeverity): DataFinding[] =>
  findings.filter((finding) => SEVERITY_RANK[finding.severity] >= SEVERITY_RANK[minimum]);
