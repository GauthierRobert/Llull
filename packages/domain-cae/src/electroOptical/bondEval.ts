/**
 * Bond path evaluation (PHY-15 TR-EOP-20): series resistance of the elements, the status against the sourced limit, and the findings that stop a path
 * from passing (an insulating or undeclared coating on a bonded interface, joined solids that do not touch, missing data).
 * Resistivities are read through `evaluate_property` (PHY-01, composed via `execute`); contacts through `find_contacts` (the caller passes the pairs).
 */

import { execute } from '@core/commands/registry';
import type { CommandResult, ExecutionContext } from '@core/commands/types';
import { canonicalJson } from '@lib/canonicalJson';
import { convertValue, isUnitFailure } from '@lib/quantity';
import { sha256Hex } from '@lib/sha256';
import type { CadDocument } from '@core/model/types';
import { isRecord } from '@lib/isRecord';
import { electroOpticalOf } from './model';
import { bulkResistance } from './physics';
import type { BondElement, BondPath } from './types';

export type BondStatus = 'pass' | 'fail' | 'unknown';

interface BondElementRow {
  readonly kind: 'joint' | 'strap';
  readonly ohm: number | null;
  /** Fraction of the total, null while any element is unresolved. */
  readonly share: number | null;
  readonly provenance: string;
}

interface Finding {
  readonly code: string;
  readonly message: string;
}

export interface BondRow {
  readonly pathId: string;
  readonly name: string;
  readonly totalOhm: number | null;
  readonly totalMilliohm: number | null;
  readonly elements: readonly BondElementRow[];
  readonly limit?: {
    readonly value: number;
    readonly unit: string;
    readonly limitOhm: number;
    readonly ruleId: string;
    readonly source: string;
    readonly unverified: true;
  };
  readonly status: BondStatus;
  /** The most severe finding's code (null for a pass). */
  readonly code: string | null;
  readonly findings: readonly Finding[];
  readonly unverified: boolean;
  readonly unverifiedReasons: readonly string[];
  readonly reviewRequired: true;
  readonly reviewReason: string;
  /** sha256 of the path definition and its evaluated result: a disposition applies only while it is unchanged. */
  readonly inputsHash: string;
}

const REVIEW_REASON = 'electrical bonding is a design-assurance finding: a qualified EMC / lightning engineer reviews every path';
const LIMIT_UNVERIFIED = 'EOP_LIMIT_UNVERIFIED: the limit is a programme rule entered as given; no command marks it verified';

const FAIL_ORDER = ['EOP_COATING_INSULATES', 'EOP_BOND_RESISTANCE_EXCEEDED'];

/** `a|b` ordered, over the solid at the root of each id (an assembly child `inst/child` counts as `inst`). */
const pairKey = (a: string, b: string): string => [a.split('/')[0], b.split('/')[0]].sort().join('|');

/** Contacting pairs of find_contacts, or the refusal result to return as is. */
export function contactPairs(
  doc: CadDocument,
  paths: readonly BondPath[],
  ctx: ExecutionContext | undefined,
): { readonly pairs: ReadonlySet<string> | null } | { readonly refusal: CommandResult } {
  const ids = [
    ...new Set(paths.flatMap((path) => path.elements.flatMap((element) => (element.kind === 'joint' ? (element.interfaces ?? []) : [])))),
  ].filter((id) => Object.hasOwn(doc.entities, id));
  if (ids.length === 0) return { pairs: null };
  const found = execute(doc, 'find_contacts', { entityIds: ids }, ctx);
  if (found.error !== undefined) return { refusal: found };
  const pairs = isRecord(found.data) && Array.isArray(found.data['pairs']) ? found.data['pairs'] : [];
  const keys = new Set(
    pairs.flatMap((pair) =>
      isRecord(pair) && typeof pair['a'] === 'string' && typeof pair['b'] === 'string' ? [pairKey(pair['a'], pair['b'])] : [],
    ),
  );
  return { pairs: keys };
}

interface Resistivity {
  readonly rho: number;
  readonly unverified: boolean;
  readonly reasons: readonly string[];
  readonly provenance: string;
}

/** rho (ohm m) of a material at the path temperature through evaluate_property, or why it is unavailable. */
function resistivityOf(doc: CadDocument, material: string, path: BondPath, ctx: ExecutionContext | undefined): Resistivity | Finding {
  const answer = execute(
    doc,
    'evaluate_property',
    { material, property: 'electricalResistivity', at: path.temperature === undefined ? {} : { T: path.temperature }, outputUnit: 'ohm*m' },
    ctx,
  );
  const data = answer.data;
  if (
    answer.rejected === true ||
    !isRecord(data) ||
    typeof data['value'] !== 'number' ||
    !Number.isFinite(data['value']) ||
    data['value'] <= 0
  )
    return {
      code: 'EOP_RESISTIVITY_UNAVAILABLE',
      message: `strap material '${material}': ${answer.error?.code ?? 'no value'} - ${answer.summary}`,
    };
  const provenance =
    isRecord(data['provenance']) && typeof data['provenance']['citation'] === 'string' ? data['provenance']['citation'] : 'unsourced';
  const reasons = Array.isArray(data['unverifiedReasons'])
    ? data['unverifiedReasons'].filter((reason): reason is string => typeof reason === 'string')
    : [];
  return {
    rho: data['value'],
    unverified: data['unverified'] === true,
    reasons,
    provenance: `${material}: ${provenance} (${String(data['method'] ?? 'model')})`,
  };
}

interface Evaluated {
  readonly row: BondElementRow;
  readonly finding?: Finding;
  readonly unverified: readonly string[];
}

function evaluateElement(doc: CadDocument, element: BondElement, path: BondPath, ctx: ExecutionContext | undefined): Evaluated {
  if (element.kind === 'joint') {
    const ohm = convertValue(element.resistance.value, element.resistance.unit, 'ohm');
    return isUnitFailure(ohm)
      ? {
          row: { kind: 'joint', ohm: null, share: null, provenance: element.source.citation },
          finding: { code: 'EOP_BOND_ELEMENT_INVALID', message: ohm.message },
          unverified: [],
        }
      : { row: { kind: 'joint', ohm: ohm.value, share: null, provenance: element.source.citation }, unverified: [] };
  }
  const length = convertValue(element.length.value, element.length.unit, 'm');
  const area = convertValue(element.crossSection.value, element.crossSection.unit, 'm^2');
  const strap = (ohm: number | null, provenance: string): BondElementRow => ({ kind: 'strap', ohm, share: null, provenance });
  if (isUnitFailure(length) || isUnitFailure(area))
    return {
      row: strap(null, element.material),
      finding: { code: 'EOP_BOND_ELEMENT_INVALID', message: 'strap length or cross-section unit is invalid' },
      unverified: [],
    };
  const rho = resistivityOf(doc, element.material, path, ctx);
  if ('code' in rho) return { row: strap(null, element.material), finding: rho, unverified: [] };
  return {
    row: strap(bulkResistance(rho.rho, length.value, area.value), `${rho.provenance}; R = rho L / A`),
    unverified: rho.unverified ? rho.reasons.map((reason) => `strap ${element.material}: ${reason}`) : [],
  };
}

/** Findings about the coatings and the contact of one joint (an insulating coating breaks the path; an undeclared one is `unknown`). */
function interfaceFindings(
  doc: CadDocument,
  joint: Extract<BondElement, { kind: 'joint' }>,
  contacts: ReadonlySet<string> | null,
): Finding[] {
  const interfaces = joint.interfaces;
  if (interfaces === undefined) return [];
  const findings: Finding[] = [];
  const model = electroOpticalOf(doc);
  const corrosionSystems = Object.values(doc.corrosion?.surfaceSystems ?? {});
  for (const entityId of interfaces) {
    if (!Object.hasOwn(doc.entities, entityId)) {
      findings.push({ code: 'EOP_ENTITY_MISSING', message: `joint solid '${entityId}' no longer exists` });
      continue;
    }
    const bonded = Object.values(model.coatings).filter((item) => item.entityId === entityId && item.location === 'bonded_interface');
    for (const coating of bonded) {
      if (coating.electrical === 'insulating')
        findings.push({
          code: 'EOP_COATING_INSULATES',
          message: `coating '${coating.coating}' (${coating.id}) on ${entityId} is declared insulating: the bond across it is broken`,
        });
      else if (coating.electrical === 'unknown')
        findings.push({
          code: 'EOP_COATING_UNKNOWN',
          message: `coating '${coating.coating}' (${coating.id}) on ${entityId}: electrical effect not declared`,
        });
    }
    const system = corrosionSystems.find((candidate) => candidate.entityIds.includes(entityId));
    if (bonded.length === 0 && system !== undefined)
      findings.push({
        code: 'EOP_COATING_UNKNOWN',
        message: `${entityId} has surface system ${system.id} (${system.layers.map((layer) => layer.class).join(' + ')}) but no bonded_interface coating declares its electrical effect`,
      });
  }
  if (contacts !== null && !contacts.has(pairKey(interfaces[0], interfaces[1])))
    findings.push({
      code: 'EOP_JOINT_NO_CONTACT',
      message: `${interfaces[0]} and ${interfaces[1]} are not in contact (find_contacts): the joint connects nothing`,
    });
  return findings;
}

const severity = (finding: Finding): number => {
  const fail = FAIL_ORDER.indexOf(finding.code);
  return fail >= 0 ? fail : FAIL_ORDER.length;
};

/** The row of one path. `contacts` is null when no joint names interfaces. */
export function bondRow(
  doc: CadDocument,
  path: BondPath,
  contacts: ReadonlySet<string> | null,
  ctx: ExecutionContext | undefined,
): BondRow {
  const evaluated = path.elements.map((element) => evaluateElement(doc, element, path, ctx));
  const findings: Finding[] = evaluated.flatMap((item) => (item.finding === undefined ? [] : [item.finding]));
  for (const element of path.elements) if (element.kind === 'joint') findings.push(...interfaceFindings(doc, element, contacts));
  const resolved = evaluated.every((item) => item.row.ohm !== null);
  const totalOhm = resolved ? evaluated.reduce((sum, item) => sum + (item.row.ohm === null ? 0 : item.row.ohm), 0) : null;
  const elements = evaluated.map(
    (item): BondElementRow => ({ ...item.row, share: totalOhm === null || item.row.ohm === null ? null : item.row.ohm / totalOhm }),
  );
  const limitOhm = path.limit === undefined ? null : convertValue(path.limit.value, path.limit.unit, 'ohm');
  if (path.limit === undefined)
    findings.push({ code: 'EOP_BOND_LIMIT_MISSING', message: 'the path has no sourced limit (define_bond_path limit)' });
  else if (limitOhm !== null && !isUnitFailure(limitOhm) && totalOhm !== null && totalOhm > limitOhm.value)
    findings.push({
      code: 'EOP_BOND_RESISTANCE_EXCEEDED',
      message: `${(totalOhm * 1000).toPrecision(7)} mohm exceeds the limit ${path.limit.value} ${path.limit.unit} (${path.limit.ruleId})`,
    });
  const failing = findings.filter((finding) => FAIL_ORDER.includes(finding.code));
  const status: BondStatus = failing.length > 0 ? 'fail' : findings.length > 0 ? 'unknown' : 'pass';
  const ordered = [...findings].sort((x, y) => severity(x) - severity(y));
  const unverifiedReasons = [...(path.limit === undefined ? [] : [LIMIT_UNVERIFIED]), ...evaluated.flatMap((item) => item.unverified)];
  const limit =
    path.limit === undefined || limitOhm === null || isUnitFailure(limitOhm)
      ? {}
      : {
          limit: {
            value: path.limit.value,
            unit: path.limit.unit,
            limitOhm: limitOhm.value,
            ruleId: path.limit.ruleId,
            source: path.limit.source.citation,
            unverified: true as const,
          },
        };
  const core = { path, totalOhm, status, codes: ordered.map((finding) => finding.code), elements: elements.map((element) => element.ohm) };
  return {
    pathId: path.id,
    name: path.name,
    totalOhm,
    totalMilliohm: totalOhm === null ? null : totalOhm * 1000,
    elements,
    ...limit,
    status,
    code: ordered[0]?.code ?? null,
    findings: ordered,
    unverified: unverifiedReasons.length > 0,
    unverifiedReasons,
    reviewRequired: true,
    reviewReason: REVIEW_REASON,
    inputsHash: sha256Hex(canonicalJson(core)),
  };
}
