/**
 * Bond path evaluation (PHY-15 TR-EOP-20): series resistance of the elements, the status against the sourced limit, and the findings that stop a path
 * from passing (an insulating or undeclared coating on a bonded interface, joined solids that do not touch or were not tested, missing data).
 * Resistivities are read through `evaluate_property` (PHY-01), the rest of the document through `BondContext` (read-only commands composed via `execute`).
 */

import type { ExecutionContext } from '@core/commands/types';
import { canonicalJson } from '@lib/canonicalJson';
import { convertValue, isUnitFailure } from '@lib/quantity';
import { sha256Hex } from '@lib/sha256';
import type { CadDocument } from '@core/model/types';
import { type BondContext, pairKey } from './bondContext';
import { electroOpticalOf } from './model';
import { bulkResistance } from './physics';
import { resistivityOf } from './resistivity';
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
  /** Warnings that do not change the status (a CFRP strap). */
  readonly warnings: readonly Finding[];
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

/** A composite material cannot replace a metallic bond path: its record names a composite product form or designation (a heuristic on the record text, stated in the warning). */
const COMPOSITE_TEXT = /cfrp|carbon|composite|laminate|prepreg|fabric|gfrp|kevlar/i;

interface Evaluated {
  readonly row: BondElementRow;
  readonly finding?: Finding;
  readonly warning?: Finding;
  readonly unverified: readonly string[];
}

function evaluateElement(
  doc: CadDocument,
  element: BondElement,
  index: number,
  path: BondPath,
  ctx: ExecutionContext | undefined,
): Evaluated {
  if (element.kind === 'joint') {
    const ohm = convertValue(element.resistance.value, element.resistance.unit, 'ohm');
    const unchecked =
      element.interfaces === undefined
        ? [`EOP_JOINT_UNCHECKED: joint ${index} names no solids, so its contact and coating are not checked`]
        : [];
    return isUnitFailure(ohm)
      ? {
          row: { kind: 'joint', ohm: null, share: null, provenance: element.source.citation },
          finding: { code: 'EOP_BOND_ELEMENT_INVALID', message: ohm.message },
          unverified: unchecked,
        }
      : { row: { kind: 'joint', ohm: ohm.value, share: null, provenance: element.source.citation }, unverified: unchecked };
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
  const rho = resistivityOf(doc, element.material, path.temperature, ctx);
  if ('code' in rho)
    return { row: strap(null, element.material), finding: { code: rho.code, message: `strap ${rho.message}` }, unverified: [] };
  const record = Object.hasOwn(doc.materials, element.material) ? doc.materials[element.material]?.record : undefined;
  const composite = COMPOSITE_TEXT.test(`${record?.productForm ?? ''} ${record?.designation ?? ''}`);
  return {
    row: strap(bulkResistance(rho.rho, length.value, area.value), `${rho.provenance}; R = rho L / A`),
    ...(composite
      ? {
          warning: {
            code: 'EOP_CFRP_IN_PATH',
            message: `strap material '${element.material}' is a composite (record productForm / designation): it cannot replace a metallic bond path; its resistivity is anisotropic and direction is not evaluated`,
          },
        }
      : {}),
    unverified: rho.unverified ? rho.reasons.map((reason) => `strap ${element.material}: ${reason}`) : [],
  };
}

/** Findings about the coatings and the contact of one joint (an insulating coating breaks the path; an undeclared one, an untested or missing contact is `unknown`). */
function interfaceFindings(doc: CadDocument, joint: Extract<BondElement, { kind: 'joint' }>, context: BondContext): Finding[] {
  const interfaces = joint.interfaces;
  if (interfaces === undefined) return [];
  const findings: Finding[] = [];
  const model = electroOpticalOf(doc);
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
    const system = context.systems.find((candidate) => candidate.entityIds.includes(entityId));
    if (bonded.length === 0 && system !== undefined)
      findings.push({
        code: 'EOP_COATING_UNKNOWN',
        message: `${entityId} has surface system ${system.id} (${system.layers.join(' + ')}) but no bonded_interface coating declares its electrical effect`,
      });
  }
  const key = pairKey(interfaces[0], interfaces[1]);
  if (context.contacts !== null && !context.stackPairs.has(key)) {
    const reason = context.untested.get('*') ?? interfaces.map((id) => context.untested.get(id)).find((why) => why !== undefined);
    if (reason !== undefined)
      findings.push({
        code: 'EOP_CONTACT_NOT_TESTED',
        message: `${interfaces[0]} and ${interfaces[1]}: find_contacts did not test them (${reason})`,
      });
    else if (!context.contacts.has(key))
      findings.push({
        code: 'EOP_JOINT_NO_CONTACT',
        message: `${interfaces[0]} and ${interfaces[1]} are not in contact (find_contacts) nor in a fastener stack: the joint connects nothing`,
      });
  }
  return findings;
}

const severity = (finding: Finding): number => {
  const fail = FAIL_ORDER.indexOf(finding.code);
  return fail >= 0 ? fail : FAIL_ORDER.length;
};

/** The row of one path. */
export function bondRow(doc: CadDocument, path: BondPath, context: BondContext, ctx: ExecutionContext | undefined): BondRow {
  const evaluated = path.elements.map((element, index) => evaluateElement(doc, element, index, path, ctx));
  const findings: Finding[] = evaluated.flatMap((item) => (item.finding === undefined ? [] : [item.finding]));
  for (const element of path.elements) if (element.kind === 'joint') findings.push(...interfaceFindings(doc, element, context));
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
  const warnings = evaluated.flatMap((item) => (item.warning === undefined ? [] : [item.warning]));
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
  const core = {
    path,
    totalOhm,
    status,
    codes: ordered.map((finding) => finding.code),
    warnings: warnings.map((warning) => warning.code),
    elements: elements.map((element) => element.ohm),
  };
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
    warnings,
    unverified: unverifiedReasons.length > 0,
    unverifiedReasons,
    reviewRequired: true,
    reviewReason: REVIEW_REASON,
    inputsHash: sha256Hex(canonicalJson(core)),
  };
}
