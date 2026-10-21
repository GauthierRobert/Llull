/**
 * Reads the PDM entities of a Part 21 file back into a `PdmModel`, independently of the writer (shared code: only the record scanner of `@lib/step21/records` and the
 * attribute parser): the self-check of `export_step_pdm` compares what this returns with the model the file was written from.
 * @invariant pure; never throws; unknown records are ignored; a file without the entities of one managed item answers with a reason string
 */

import { parseRecords } from '@lib/step21/records';
import type { LifecycleState } from '@plm/types';
import { type Arg, type Call, asNumber, asRef, asRefs, asString, parseBody } from './args';
import type { ApprovalStatus, PdmModel, PdmSignature, PdmUnitEffectivity } from './model';
import { isoOf } from './part21';
import { PROPERTY } from './write';

interface Instance {
  readonly id: number;
  readonly calls: readonly Call[];
}

const STATES: readonly string[] = ['in_work', 'in_review', 'released', 'superseded', 'obsolete', 'cancelled'];
const STATUSES: readonly string[] = ['approved', 'not yet approved', 'disapproved', 'withdrawn'];

/** The part of a file the reader walks: its instances by entity name and by id. */
class Index {
  readonly byId = new Map<number, Instance>();
  readonly byEntity = new Map<string, Instance[]>();
  constructor(text: string) {
    for (const [id, body] of parseRecords(text).bodies) {
      const calls = parseBody(body);
      if (calls === null) continue;
      const instance = { id, calls };
      this.byId.set(id, instance);
      for (const entity of new Set(calls.map((call) => call.entity)))
        (this.byEntity.get(entity) ?? this.byEntity.set(entity, []).get(entity))?.push(instance);
    }
  }
  all(entity: string): Instance[] {
    return this.byEntity.get(entity) ?? [];
  }
  /** The attribute list of `entity` in instance `id` (a part of a complex instance included). */
  args(id: number | null, entity: string): readonly Arg[] | null {
    return id === null ? null : (this.byId.get(id)?.calls.find((call) => call.entity === entity)?.args ?? null);
  }
}

const argsOf = (instance: Instance, entity: string): readonly Arg[] => instance.calls.find((call) => call.entity === entity)?.args ?? [];

function instantOf(index: Index, id: number | null, dateOnly: boolean): string | null {
  const dateAndTime = index.args(id, 'DATE_AND_TIME');
  const date = index.args(asRef(dateAndTime?.[0]), 'CALENDAR_DATE');
  const time = index.args(asRef(dateAndTime?.[1]), 'LOCAL_TIME');
  const [year, day, month] = [asNumber(date?.[0]), asNumber(date?.[1]), asNumber(date?.[2])];
  if (year === null || day === null || month === null) return null;
  const [hour, minute, second] = [asNumber(time?.[0]) ?? 0, asNumber(time?.[1]) ?? 0, asNumber(time?.[2]) ?? 0];
  return isoOf({ year, month, day, hour, minute, second: Math.trunc(second) }, dateOnly);
}

/** Descriptive items of the property named `name` assigned to `target`: one list of [name, value] pairs per property definition. */
function propertiesOf(index: Index, name: string, target: number): (readonly (readonly [string, string])[])[] {
  const found: (readonly (readonly [string, string])[])[] = [];
  for (const link of index.all('PROPERTY_DEFINITION_REPRESENTATION')) {
    const args = argsOf(link, 'PROPERTY_DEFINITION_REPRESENTATION');
    const definition = index.args(asRef(args[0]), 'PROPERTY_DEFINITION');
    if (definition === null || asString(definition[0]) !== name || asRef(definition[2]) !== target) continue;
    const representation = index.args(asRef(args[1]), 'REPRESENTATION');
    const items = asRefs(representation?.[1]).flatMap((id) => {
      const item = index.args(id, 'DESCRIPTIVE_REPRESENTATION_ITEM');
      const [key, text] = [asString(item?.[0]), asString(item?.[1])];
      return key === null || text === null ? [] : [[key, text] as const];
    });
    found.push(items);
  }
  return found;
}

const itemOf = (items: readonly (readonly [string, string])[], key: string): string | null =>
  items.find(([name]) => name === key)?.[1] ?? null;

type Row = PdmModel['structure'][number];

/** The usage rows under product definition `parent`: simple and quantified NEXT_ASSEMBLY_USAGE_OCCURRENCE. */
function usagesOf(index: Index, parent: number): Row[] {
  const rows: Row[] = [];
  for (const usage of index.all('NEXT_ASSEMBLY_USAGE_OCCURRENCE')) {
    const quantified = usage.calls.find((call) => call.entity === 'QUANTIFIED_ASSEMBLY_COMPONENT_USAGE');
    const args =
      quantified === undefined ? argsOf(usage, 'NEXT_ASSEMBLY_USAGE_OCCURRENCE') : argsOf(usage, 'PRODUCT_DEFINITION_RELATIONSHIP');
    if (asRef(args[3]) !== parent) continue;
    let quantity = 1;
    if (quantified !== undefined) {
      const measure = index.args(asRef(quantified.args[0]), 'MEASURE_WITH_UNIT');
      const counted = measure?.[0];
      quantity = typeof counted === 'object' && counted !== null && 'typed' in counted ? (asNumber(counted.value) ?? 0) : 0;
    }
    const definition = index.args(asRef(args[4]), 'PRODUCT_DEFINITION');
    const formation = index.args(asRef(definition?.[2]), 'PRODUCT_DEFINITION_FORMATION');
    const product = index.args(asRef(formation?.[2]), 'PRODUCT');
    rows.push({
      partNumber: asString(product?.[0]) ?? '',
      name: asString(product?.[1]) ?? '',
      revision: asString(formation?.[0]) ?? '',
      quantity,
    });
  }
  return rows;
}

/** The version chain of `top`: formation ids in sequence order. */
function chainOf(index: Index, top: number): number[] {
  const formations = index
    .all('PRODUCT_DEFINITION_FORMATION')
    .filter((formation) => asRef(argsOf(formation, 'PRODUCT_DEFINITION_FORMATION')[2]) === top);
  const next = new Map<number, number>();
  for (const link of index.all('PRODUCT_DEFINITION_FORMATION_RELATIONSHIP')) {
    const args = argsOf(link, 'PRODUCT_DEFINITION_FORMATION_RELATIONSHIP');
    const [from, to] = [asRef(args[3]), asRef(args[4])];
    if (from !== null && to !== null) next.set(from, to);
  }
  const targets = new Set(next.values());
  const first = formations.find((formation) => !targets.has(formation.id));
  const chain: number[] = [];
  for (let at = first?.id; at !== undefined && !chain.includes(at) && chain.length <= formations.length; at = next.get(at)) chain.push(at);
  return chain;
}

/** The PDM model a file holds, or why it holds none. */
export function readPdm(text: string): PdmModel | string {
  const index = new Index(text);
  const owner = index.all('APPLIED_ORGANIZATION_ASSIGNMENT').find((assignment) => {
    const role = index.args(asRef(argsOf(assignment, 'APPLIED_ORGANIZATION_ASSIGNMENT')[1]), 'ORGANIZATION_ROLE');
    return asString(role?.[0]) === 'id owner';
  });
  if (owner === undefined) return 'no product with an id owner (APPLIED_ORGANIZATION_ASSIGNMENT)';
  const ownerArgs = argsOf(owner, 'APPLIED_ORGANIZATION_ASSIGNMENT');
  const top = asRefs(ownerArgs[2])[0];
  const topProduct = index.args(top ?? null, 'PRODUCT');
  const organization = index.args(asRef(ownerArgs[0]), 'ORGANIZATION');
  if (top === undefined || topProduct === null || organization === null)
    return 'the id owner assignment does not name a product and an organization';
  const chain = chainOf(index, top);
  const labels = chain.map((id) => asString(index.args(id, 'PRODUCT_DEFINITION_FORMATION')?.[0]) ?? '');
  const current = chain.at(-1);
  if (current === undefined) return 'the product has no version';
  const currentArgs = index.args(current, 'PRODUCT_DEFINITION_FORMATION') ?? [];
  const views = index.all('PRODUCT_DEFINITION').filter((view) => asRef(argsOf(view, 'PRODUCT_DEFINITION')[2]) === current);
  const design = views.find((view) => asString(argsOf(view, 'PRODUCT_DEFINITION')[0]) === 'design');
  if (design === undefined) return 'the current version has no design view (PRODUCT_DEFINITION)';
  const manufacturing = views.find((view) => asString(argsOf(view, 'PRODUCT_DEFINITION')[0]) === 'manufacturing');

  const approvals: PdmModel['approvals'][number][] = [];
  let release: PdmModel['release'] = null;
  let approvalStatus: ApprovalStatus = 'not yet approved';
  for (const assignment of index.all('APPLIED_APPROVAL_ASSIGNMENT')) {
    const args = argsOf(assignment, 'APPLIED_APPROVAL_ASSIGNMENT');
    if (!asRefs(args[1]).includes(current)) continue;
    const approvalId = asRef(args[0]);
    const approval = index.args(approvalId, 'APPROVAL');
    const level = asString(approval?.[1]) ?? '';
    const status = asString(index.args(asRef(approval?.[0]), 'APPROVAL_STATUS')?.[0]) ?? '';
    const who = index
      .all('APPROVAL_PERSON_ORGANIZATION')
      .find((link) => asRef(argsOf(link, 'APPROVAL_PERSON_ORGANIZATION')[1]) === approvalId);
    const personAndOrganization = index.args(
      asRef(who === undefined ? undefined : argsOf(who, 'APPROVAL_PERSON_ORGANIZATION')[0]),
      'PERSON_AND_ORGANIZATION',
    );
    const userId = asString(index.args(asRef(personAndOrganization?.[0]), 'PERSON')?.[0]);
    const when = index.all('APPROVAL_DATE_TIME').find((link) => asRef(argsOf(link, 'APPROVAL_DATE_TIME')[1]) === approvalId);
    const at = instantOf(index, asRef(when === undefined ? undefined : argsOf(when, 'APPROVAL_DATE_TIME')[0]), false);
    if (level === 'release') {
      approvalStatus = STATUSES.includes(status) ? (status as ApprovalStatus) : 'not yet approved';
      release = userId === null ? null : { by: userId, at };
    } else approvals.push({ role: level, userId: userId ?? '', at });
  }

  const classification = index
    .all('APPLIED_SECURITY_CLASSIFICATION_ASSIGNMENT')
    .find((assignment) => asRefs(argsOf(assignment, 'APPLIED_SECURITY_CLASSIFICATION_ASSIGNMENT')[1]).includes(current));
  const classified = index.args(
    asRef(classification === undefined ? undefined : argsOf(classification, 'APPLIED_SECURITY_CLASSIFICATION_ASSIGNMENT')[0]),
    'SECURITY_CLASSIFICATION',
  );
  const regime = asString(classified?.[0]) ?? 'undetermined';
  const level = asString(index.args(asRef(classified?.[2]), 'SECURITY_CLASSIFICATION_LEVEL')?.[0]) ?? 'unclassified';
  const statement = asString(classified?.[1]) ?? '';

  const dateEffectivity: PdmModel['dateEffectivity'][number][] = [];
  for (const assignment of index.all('APPLIED_EFFECTIVITY_ASSIGNMENT')) {
    const args = argsOf(assignment, 'APPLIED_EFFECTIVITY_ASSIGNMENT');
    if (!asRefs(args[1]).includes(current)) continue;
    const effectivity = index.args(asRef(args[0]), 'DATED_EFFECTIVITY');
    // The schema order is effectivity_end_date, then effectivity_start_date (both optional); a range with no start is not one llull writes.
    const from = instantOf(index, asRef(effectivity?.[2]), true);
    if (from !== null) dateEffectivity.push({ from, to: instantOf(index, asRef(effectivity?.[1]), true) });
  }
  const unitEffectivity = (propertiesOf(index, PROPERTY.effectivity, design.id)[0] ?? []).flatMap(([kind, range]): PdmUnitEffectivity[] => {
    try {
      const [from, to] = JSON.parse(range) as [string, string | null];
      return [{ kind, from, to }];
    } catch {
      return [];
    }
  });

  const signatures: PdmSignature[] = propertiesOf(index, PROPERTY.signature, design.id).map((items) => ({
    keyId: itemOf(items, 'keyId') ?? '',
    publicKey: itemOf(items, 'publicKey') ?? '',
    meaning: itemOf(items, 'meaning') ?? '',
    signerId: itemOf(items, 'signer') ?? '',
    signedAt: itemOf(items, 'signedAt') ?? '',
    target: itemOf(items, 'target') ?? '',
    signedSha256: itemOf(items, 'signedSha256') ?? '',
    signature: itemOf(items, 'signature') ?? '',
  }));
  const integrity = propertiesOf(index, PROPERTY.integrity, design.id)[0] ?? [];
  const state = itemOf(integrity, 'state') ?? '';
  if (!STATES.includes(state)) return `the version has no llull lifecycle state property (got '${state}')`;
  const mbomName = manufacturing === undefined ? null : asString(argsOf(manufacturing, 'PRODUCT_DEFINITION')[1]);
  const mbomId =
    manufacturing === undefined ? null : (propertiesOf(index, 'llull manufacturing bom', manufacturing.id)[0]?.[0]?.[1] ?? null);
  const categories = index.all('PRODUCT_CATEGORY_RELATIONSHIP');
  const subCategory = categories
    .map((link) => asString(index.args(asRef(argsOf(link, 'PRODUCT_CATEGORY_RELATIONSHIP')[3]), 'PRODUCT_RELATED_PRODUCT_CATEGORY')?.[0]))
    .find((name) => name === 'assembly' || name === 'detail');
  return {
    organization: { id: asString(organization[0]) ?? '', name: asString(organization[1]) ?? '' },
    partNumber: asString(topProduct[0]) ?? '',
    name: asString(topProduct[1]) ?? '',
    category: subCategory === 'assembly' ? 'assembly' : 'detail',
    revisions: labels,
    revision: labels.at(-1) ?? '',
    reason: (asString(currentArgs[1]) ?? '') === '' ? null : asString(currentArgs[1]),
    state: state as LifecycleState,
    approvalStatus,
    approvals,
    release,
    marking: { regime, classification: level === 'unclassified' ? null : level, statement: statement === '' ? null : statement },
    dateEffectivity,
    unitEffectivity,
    structure: usagesOf(index, design.id),
    mbom: manufacturing === undefined ? null : { id: mbomId ?? '', name: mbomName ?? '', lines: usagesOf(index, manufacturing.id) },
    signatures,
    integrity: { contentHash: itemOf(integrity, 'contentHash'), packageSha256: itemOf(integrity, 'packageSha256') },
  };
}
