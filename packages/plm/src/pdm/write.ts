/**
 * Writes a `PdmModel` as an ISO 10303-21 file of AP242 PDM entities, following the CAx-IF / PDM-IF "Usage Guide for the STEP PDM Schema" v1.2 (release 4.3): product /
 * version / view (1.1), part category (2), assembly structure with quantified usage (4), person and organization (13.1), approval (13.2), date and time (13.3),
 * security classification (13.4), general validity period effectivity (14.3). What the practice has no entity for (digital signatures, serial / msn / lot ranges, the
 * lifecycle state, content hashes) travels as named llull properties (PROPERTY_DEFINITION with descriptive items), the mechanism of the CAx-IF validation properties.
 * @invariant pure and deterministic: the same model gives the same bytes; strings are escaped so any text round-trips; no geometry is written
 */

import { type PdmModel } from './model';
import { optional, parseInstant, quoted, real } from './part21';

export const PDM_SCHEMA = 'AP242_MANAGED_MODEL_BASED_3D_ENGINEERING_MIM_LF { 1 0 10303 442 3 1 4 }';

/** Names of the llull properties (PROPERTY_DEFINITION name) the reader looks for. */
export const PROPERTY = {
  signature: 'llull release signature',
  integrity: 'llull release integrity',
  effectivity: 'llull unit effectivity',
} as const;

export interface PdmFileOptions {
  readonly fileName: string;
  readonly timestamp: string;
}

class Records {
  private next = 1;
  readonly lines: string[] = [];
  add(body: string): number {
    const id = this.next++;
    this.lines.push(`#${id}=${body};`);
    return id;
  }
}

const ref = (id: number): string => `#${id}`;
const refs = (ids: readonly number[]): string => `(${ids.map(ref).join(',')})`;

/** The Part 21 text of `model`. */
export function writePdm(model: PdmModel, file: PdmFileOptions): string {
  const out = new Records();
  const cache = new Map<string, number>();
  const once = (key: string, make: () => number): number => {
    const known = cache.get(key);
    if (known !== undefined) return known;
    const id = make();
    cache.set(key, id);
    return id;
  };

  const context = out.add("APPLICATION_CONTEXT('mechanical design')");
  out.add(
    `APPLICATION_PROTOCOL_DEFINITION('international standard','ap242_managed_model_based_3d_engineering_mim_lf',2022,${ref(context)})`,
  );
  const productContext = out.add(`PRODUCT_CONTEXT('',${ref(context)},'mechanical')`);
  const designContext = out.add(`PRODUCT_DEFINITION_CONTEXT('part definition',${ref(context)},'design')`);
  const organization = out.add(`ORGANIZATION(${quoted(model.organization.id)},${quoted(model.organization.name)},$)`);
  const utc = out.add('COORDINATED_UNIVERSAL_TIME_OFFSET(0,$,.EXACT.)');
  const objectRole = (name: string): number => once(`object-role:${name}`, () => out.add(`OBJECT_ROLE(${quoted(name)},$)`));

  const people = (userId: string): number =>
    once(`person:${userId}`, () => {
      const person = out.add(`PERSON(${quoted(userId)},${quoted(userId)},$,$,$,$)`);
      return out.add(`PERSON_AND_ORGANIZATION(${ref(person)},${ref(organization)})`);
    });
  const dateAndTime = (iso: string, dateOnly: boolean): number | null => {
    const at = parseInstant(iso);
    if (at === null) return null;
    const date = out.add(`CALENDAR_DATE(${at.year},${at.day},${at.month})`);
    const time = out.add(`LOCAL_TIME(${dateOnly ? 0 : at.hour},${dateOnly ? 0 : at.minute},${real(dateOnly ? 0 : at.second)},${ref(utc)})`);
    return out.add(`DATE_AND_TIME(${ref(date)},${ref(time)})`);
  };

  // Property mechanism: PROPERTY_DEFINITION + DESCRIPTIVE_REPRESENTATION_ITEMs in a non-geometric representation.
  const representationContext = once('rep-context', () => out.add("REPRESENTATION_CONTEXT('llull','plm data')"));
  const property = (name: string, description: string, target: number, items: readonly (readonly [string, string])[]): void => {
    const definition = out.add(`PROPERTY_DEFINITION(${quoted(name)},${quoted(description)},${ref(target)})`);
    const ids = items.map(([key, value]) => out.add(`DESCRIPTIVE_REPRESENTATION_ITEM(${quoted(key)},${quoted(value)})`));
    const representation = out.add(`REPRESENTATION('',${refs(ids)},${ref(representationContext)})`);
    out.add(`PROPERTY_DEFINITION_REPRESENTATION(${ref(definition)},${ref(representation)})`);
  };

  // Product, versions, view (1.1.1) and category (2).
  const products = new Map<string, number>();
  const productOf = (partNumber: string, name: string): number => {
    const known = products.get(partNumber);
    if (known !== undefined) return known;
    const id = out.add(`PRODUCT(${quoted(partNumber)},${quoted(name)},'',${refs([productContext])})`);
    products.set(partNumber, id);
    return id;
  };
  const top = productOf(model.partNumber, model.name);
  const formations = new Map<string, number>();
  const formationOf = (partNumber: string, revision: string, description: string): number => {
    const key = `${partNumber}@${revision}`;
    const known = formations.get(key);
    if (known !== undefined) return known;
    const id = out.add(
      `PRODUCT_DEFINITION_FORMATION(${quoted(revision)},${quoted(description)},${ref(productOf(partNumber, partNumber))})`,
    );
    formations.set(key, id);
    return id;
  };
  let previous: { readonly id: number; readonly label: string } | undefined;
  for (const label of model.revisions) {
    const formation = formationOf(model.partNumber, label, label === model.revision ? (model.reason ?? '') : '');
    if (previous !== undefined)
      out.add(
        `PRODUCT_DEFINITION_FORMATION_RELATIONSHIP(${quoted(`${previous.label}-${label}`)},'sequence',$,${ref(previous.id)},${ref(formation)})`,
      );
    previous = { id: formation, label };
  }
  const current = formations.get(`${model.partNumber}@${model.revision}`) as number;
  const view = out.add(`PRODUCT_DEFINITION('design','design view',${ref(current)},${ref(designContext)})`);
  const idOwner = out.add("ORGANIZATION_ROLE('id owner')");
  out.add(`APPLIED_ORGANIZATION_ASSIGNMENT(${ref(organization)},${ref(idOwner)},${refs([top])})`);

  // Structure (4.1): NEXT_ASSEMBLY_USAGE_OCCURRENCE, quantified when more than one.
  const viewOf = (partNumber: string, name: string, revision: string, context: number): number => {
    const key = `${partNumber}@${revision}@${context}`;
    return once(`view:${key}`, () => {
      productOf(partNumber, name);
      const formation = formationOf(partNumber, revision, '');
      return out.add(`PRODUCT_DEFINITION('design','design view',${ref(formation)},${ref(context)})`);
    });
  };
  const usages = (parent: number, rows: PdmModel['structure']): void => {
    for (const row of rows) {
      if (row.quantity <= 0) continue;
      const child = viewOf(row.partNumber, row.name, row.revision, designContext);
      if (row.quantity === 1) {
        out.add(`NEXT_ASSEMBLY_USAGE_OCCURRENCE(${quoted(row.partNumber)},'single instance usage','',${ref(parent)},${ref(child)},$)`);
        continue;
      }
      const exponents = once('count-exponents', () => out.add(`DIMENSIONAL_EXPONENTS(${[0, 0, 0, 0, 0, 0, 0].map(real).join(',')})`));
      const unit = once('count-unit', () => out.add(`NAMED_UNIT(${ref(exponents)})`));
      const quantity = out.add(`MEASURE_WITH_UNIT(COUNT_MEASURE(${real(row.quantity)}),${ref(unit)})`);
      out.add(
        `(ASSEMBLY_COMPONENT_USAGE($) NEXT_ASSEMBLY_USAGE_OCCURRENCE() PRODUCT_DEFINITION_RELATIONSHIP(${quoted(row.partNumber)},'quantified instance usage','',${ref(parent)},${ref(child)}) PRODUCT_DEFINITION_USAGE() QUANTIFIED_ASSEMBLY_COMPONENT_USAGE(${ref(quantity)}))`,
      );
    }
  };
  usages(view, model.structure);
  if (model.structure.some((row) => row.quantity > 0)) {
    const assembly = out.add(`PRODUCT_DEFINITION_CONTEXT('assembly definition',${ref(context)},'')`);
    const role = out.add("PRODUCT_DEFINITION_CONTEXT_ROLE('part definition type',$)");
    out.add(`PRODUCT_DEFINITION_CONTEXT_ASSOCIATION(${ref(view)},${ref(assembly)},${ref(role)})`);
  }
  if (model.mbom !== null) {
    const manufacturing = out.add(`PRODUCT_DEFINITION_CONTEXT('part definition',${ref(context)},'manufacturing')`);
    const mbomView = out.add(`PRODUCT_DEFINITION('manufacturing',${quoted(model.mbom.name)},${ref(current)},${ref(manufacturing)})`);
    usages(mbomView, model.mbom.lines);
    property('llull manufacturing bom', model.mbom.id, mbomView, [['id', model.mbom.id]]);
  }
  // Categories last: every product, including those only the MBOM uses, is a part.
  const partCategory = out.add(`PRODUCT_RELATED_PRODUCT_CATEGORY('part',$,${refs([...products.values()])})`);
  const subCategory = out.add(`PRODUCT_RELATED_PRODUCT_CATEGORY(${quoted(model.category)},$,${refs([top])})`);
  out.add(`PRODUCT_CATEGORY_RELATIONSHIP('',$,${ref(partCategory)},${ref(subCategory)})`);

  // Approval (13.2): one APPROVAL per recorded role approval, one for the release.
  const approvalRole = once('approval-role', () => out.add("APPROVAL_ROLE('approver')"));
  const approve = (status: string, level: string, userId: string | null, at: string | null): void => {
    const statusId = once(`approval-status:${status}`, () => out.add(`APPROVAL_STATUS(${quoted(status)})`));
    const approval = out.add(`APPROVAL(${ref(statusId)},${quoted(level)})`);
    out.add(`APPLIED_APPROVAL_ASSIGNMENT(${ref(approval)},${refs([current])})`);
    if (userId !== null) out.add(`APPROVAL_PERSON_ORGANIZATION(${ref(people(userId))},${ref(approval)},${ref(approvalRole)})`);
    const when = at === null ? null : dateAndTime(at, false);
    if (when !== null) {
      const dated = out.add(`APPROVAL_DATE_TIME(${ref(when)},${ref(approval)})`);
      out.add(`ROLE_ASSOCIATION(${ref(objectRole('actual'))},${ref(dated)})`);
    }
  };
  for (const entry of model.approvals) approve('approved', entry.role, entry.userId, entry.at);
  if (model.state !== 'in_work' && model.state !== 'in_review')
    approve(model.approvalStatus, 'release', model.release?.by ?? null, model.release?.at ?? null);

  // Security classification (13.4) of the version and its view.
  const level = out.add(`SECURITY_CLASSIFICATION_LEVEL(${quoted(model.marking.classification ?? 'unclassified')})`);
  const classification = out.add(
    `SECURITY_CLASSIFICATION(${quoted(model.marking.regime)},${quoted(model.marking.statement ?? '')},${ref(level)})`,
  );
  out.add(`APPLIED_SECURITY_CLASSIFICATION_ASSIGNMENT(${ref(classification)},${refs([current, view])})`);

  // Effectivity: dated ranges as general validity periods (14.3); serial / msn / lot as an llull property.
  for (const [index, range] of model.dateEffectivity.entries()) {
    const start = dateAndTime(range.from, true);
    const end = range.to === null ? null : dateAndTime(range.to, true);
    const effectivity = out.add(
      `DATED_EFFECTIVITY('eff-${index + 1}',${end === null ? '$' : ref(end)},${start === null ? '$' : ref(start)})`,
    );
    const assignment = out.add(`APPLIED_EFFECTIVITY_ASSIGNMENT(${ref(effectivity)},${refs([current])})`);
    out.add(`ROLE_ASSOCIATION(${ref(objectRole('planned period'))},${ref(assignment)})`);
  }
  if (model.unitEffectivity.length > 0)
    property(
      PROPERTY.effectivity,
      'serial / msn / lot ranges of the version (not expressible as a general validity period)',
      view,
      model.unitEffectivity.map((range) => [range.kind, JSON.stringify([range.from, range.to])] as const),
    );

  // Signatures and integrity (llull properties).
  for (const signature of model.signatures)
    property(PROPERTY.signature, `Ed25519 signature (${signature.meaning}) of ${signature.target}`, view, [
      ['algorithm', 'Ed25519'],
      ['keyId', signature.keyId],
      ['publicKey', signature.publicKey],
      ['meaning', signature.meaning],
      ['signer', signature.signerId],
      ['signedAt', signature.signedAt],
      ['target', signature.target],
      ['signedSha256', signature.signedSha256],
      ['signature', signature.signature],
    ]);
  property(PROPERTY.integrity, 'lifecycle state and release hashes of the version', view, [
    ['state', model.state],
    ...(model.integrity.contentHash === null ? [] : ([['contentHash', model.integrity.contentHash]] as const)),
    ...(model.integrity.packageSha256 === null ? [] : ([['packageSha256', model.integrity.packageSha256]] as const)),
  ]);

  const header = [
    'ISO-10303-21;',
    'HEADER;',
    `FILE_DESCRIPTION((${quoted('llull PDM export')},${quoted('ViewDefinition [PDM]')}),'2;1');`,
    `FILE_NAME(${quoted(file.fileName)},${quoted(file.timestamp)},(''),(${optional(model.organization.name)}),'llull','llull','');`,
    `FILE_SCHEMA((${quoted(PDM_SCHEMA)}));`,
    'ENDSEC;',
    'DATA;',
  ];
  return `${[...header, ...out.lines, 'ENDSEC;', 'END-ISO-10303-21;'].join('\n')}\n`;
}
