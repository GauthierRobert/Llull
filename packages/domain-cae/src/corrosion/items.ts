/** Galvanic compatibility items (PHY-13 FR-COR-04..09, FR-COR-12, FR-COR-17; TR-COR-05..10, TR-COR-13): one item per contacting pair. */

import type { ContactPair } from '@core/geometry/contacts';
import type { CadDocument } from '@core/model/types';
import { jcsJson } from '@lib/jcs';
import { sha256Hex } from '@lib/sha256';
import { REVIEW_REASON, UNVERIFIED_REASON } from './codes';
import { type PartFacts, isolationsOf, materialOfPart, partFacts } from './resolve';
import { ALUMINIUM_GROUPS, CFRP_GROUP, GALVANIC_889D_MATRIX, REMEDIES, type Remedy, limitOf } from './tables';
import type { Acceptance, CorrosionEnvironment, CorrosionScheme } from './types';

export type ItemStatus = 'pass' | 'pass_isolated' | 'warn' | 'fail' | 'unknown';

export interface CompatibilityItem {
  readonly key: string;
  readonly status: ItemStatus;
  readonly code: string;
  readonly ruleId: string;
  readonly ruleGrade: 'A' | 'B' | 'C';
  readonly rule: string;
  readonly ids: readonly [string, string];
  readonly contact: { readonly kind: string; readonly source: string; readonly approximate: boolean };
  readonly inputs: Readonly<Record<string, unknown>>;
  readonly warnings: readonly string[];
  readonly remedies: readonly Remedy[];
  readonly unverified: boolean;
  readonly unverifiedReasons: readonly string[];
  readonly reviewRequired: true;
  readonly reviewReason: string;
  /** Hash of the finding (key, status, code, inputs): an acceptance applies only while it matches. */
  readonly fingerprint: string;
  readonly acceptance?: { readonly decision: Acceptance['decision']; readonly signer: string; readonly signatureId: string };
  readonly staleAcceptance?: true;
}

/** Guard on volt comparisons (spec §5.7). */
const VOLT_GUARD = 1e-12;
const round12 = (value: number): number => Math.round(value * 1e12) / 1e12;

/** The stable fingerprint of a finding. */
const fingerprintOf = (key: string, status: string, code: string, inputs: Readonly<Record<string, unknown>>): string =>
  sha256Hex(jcsJson({ key, status, code, inputs }));

interface Verdict {
  readonly status: ItemStatus;
  readonly code: string;
  readonly ruleId: string;
  readonly rule: string;
  readonly inputs: Record<string, unknown>;
  readonly warnings: string[];
}

const facts = (part: PartFacts): Record<string, unknown> => ({
  id: part.id,
  material: part.material,
  group: part.group,
  groupFrom: part.groupFrom,
  anodicIndexV: part.anodicIndexV,
  indexFrom: part.indexFrom,
  surfaceSystem: part.surfaceSystem,
  surfaceAreaMm2: part.areaMm2,
});

const RULE_ANODIC = 'anodic_index (non-889 rule of thumb)';

function screening(a: PartFacts, b: PartFacts, environment: CorrosionEnvironment, inputs: Record<string, unknown>): Verdict {
  const limit = limitOf(environment)?.maxDifferenceV ?? 0;
  const [ia, ib] = [a.anodicIndexV ?? 0, b.anodicIndexV ?? 0];
  const difference = round12(Math.abs(ia - ib));
  const anode = difference === 0 ? null : ia > ib ? a : b;
  const cathode = anode === null ? null : anode === a ? b : a;
  const compatible = difference <= limit + VOLT_GUARD;
  const full = { ...inputs, differenceV: difference, limitV: limit, anode: anode?.id ?? null, cathode: cathode?.id ?? null };
  const warnings = ['COR_SCREENING_RULE_ONLY'];
  if (!compatible)
    return { status: 'fail', code: 'COR_GALVANIC_INCOMPATIBLE', ruleId: 'COR-R-02', rule: RULE_ANODIC, inputs: full, warnings };
  const [anodeArea, cathodeArea] = [anode?.areaMm2 ?? null, cathode?.areaMm2 ?? null];
  if (anodeArea !== null && cathodeArea !== null && cathodeArea > 0) {
    const areaRatio = round12(anodeArea / cathodeArea);
    const small = areaRatio < 1;
    const sized = {
      ...full,
      anodeAreaMm2: anodeArea,
      cathodeAreaMm2: cathodeArea,
      areaRatio,
      areaBasis: 'box total surface area (MVP closed form)',
    };
    return {
      status: small ? 'warn' : 'pass',
      code: small ? 'COR_SMALL_ANODE' : 'COR_GALVANIC_OK',
      ruleId: small ? 'COR-R-03' : 'COR-R-02',
      rule: RULE_ANODIC,
      inputs: sized,
      warnings,
    };
  }
  return { status: 'pass', code: 'COR_GALVANIC_OK', ruleId: 'COR-R-02', rule: RULE_ANODIC, inputs: full, warnings };
}

function verdictOf(a: PartFacts, b: PartFacts, scheme: CorrosionScheme, environment: CorrosionEnvironment): Verdict {
  const inputs: Record<string, unknown> = { scheme, environment, parts: [facts(a), facts(b)] };
  const unknown = (code: string, ruleId: string, rule: string, extra: Record<string, unknown> = {}): Verdict => ({
    status: 'unknown',
    code,
    ruleId,
    rule,
    inputs: { ...inputs, ...extra },
    warnings: [],
  });
  const noMaterial = [a, b].filter((part) => part.group === null && part.material === null);
  if (noMaterial.length > 0)
    return unknown('COR_MATERIAL_MISSING', 'COR-R-02', RULE_ANODIC, { missing: noMaterial.map((part) => part.id) });
  const noGroup = [a, b].filter((part) => part.group === null);
  if (noGroup.length > 0)
    return unknown('COR_GROUP_MISSING', 'COR-R-02', RULE_ANODIC, { missing: noGroup.map((part) => part.material ?? part.id) });
  if (scheme === 'mil_std_889d')
    return Object.keys(GALVANIC_889D_MATRIX).length === 0
      ? unknown('COR_889_TABLE_MISSING', 'COR-R-01', 'MIL-STD-889D matrix')
      : unknown('COR_889_MATERIAL_MISSING', 'COR-R-01', 'MIL-STD-889D matrix');
  const groups = [a.group, b.group];
  if (groups.includes(CFRP_GROUP) && groups.some((group) => group !== null && ALUMINIUM_GROUPS.includes(group)))
    return {
      status: 'fail',
      code: 'COR_CFRP_ALUMINIUM',
      ruleId: 'COR-R-04',
      rule: 'carbon fibre composite on aluminium',
      inputs,
      warnings: [],
    };
  const valueless = [a, b].filter((part) => part.anodicIndexV === null);
  if (valueless.length > 0)
    return unknown('COR_GROUP_VALUE_MISSING', 'COR-R-02', RULE_ANODIC, { missing: valueless.map((part) => part.group) });
  return screening(a, b, environment, inputs);
}

/**
 * The item of one contact pair: group resolution, screening, area ratio, CFRP rule, then the declared isolations turn a fail / warn into pass_isolated.
 * @invariant every item has reviewRequired true; a missing material, group, index or table is `unknown`, never pass; the verdict is exact on ties (<=)
 */
export function galvanicItem(
  doc: CadDocument,
  pair: Pick<ContactPair, 'a' | 'b' | 'kind' | 'source' | 'approximate' | 'materials'> & { readonly stack?: boolean },
  scheme: CorrosionScheme,
  environment: CorrosionEnvironment,
  acceptances: Readonly<Record<string, Acceptance>>,
): CompatibilityItem {
  const [partA, partB] = [
    partFacts(doc, pair.a, pair.materials[0] ?? materialOfPart(doc, pair.a)),
    partFacts(doc, pair.b, pair.materials[1] ?? materialOfPart(doc, pair.b)),
  ];
  const verdict = verdictOf(partA, partB, scheme, environment);
  const isolations = isolationsOf(doc, pair.a, pair.b);
  const isolated = isolations.length > 0 && (verdict.status === 'fail' || verdict.status === 'warn');
  const status: ItemStatus = isolated ? 'pass_isolated' : verdict.status;
  const key = `galvanic:${pair.a}|${pair.b}`;
  const inputs = {
    ...verdict.inputs,
    isolations: isolations.map(({ id, method, spec }) => ({ id, method, ...(spec === undefined ? {} : { spec }) })),
  };
  const warnings = [...verdict.warnings, ...(pair.approximate ? ['COR_CONTACT_APPROXIMATE'] : [])];
  const fingerprint = fingerprintOf(key, status, verdict.code, inputs);
  const accepted = Object.hasOwn(acceptances, key) ? acceptances[key] : undefined;
  const live = accepted !== undefined && accepted.fingerprint === fingerprint;
  return {
    key,
    status,
    code: verdict.code,
    ruleId: verdict.ruleId,
    ruleGrade: 'B',
    rule: verdict.rule,
    ids: [pair.a, pair.b],
    contact: { kind: pair.kind, source: pair.stack === true ? 'stack' : pair.source, approximate: pair.approximate },
    inputs,
    warnings,
    remedies: status === 'fail' || status === 'warn' ? REMEDIES : [],
    unverified: true,
    unverifiedReasons: [UNVERIFIED_REASON],
    reviewRequired: true,
    reviewReason: REVIEW_REASON,
    fingerprint,
    ...(live ? { acceptance: { decision: accepted.decision, signer: accepted.signer, signatureId: accepted.signatureId } } : {}),
    ...(accepted !== undefined && !live ? { staleAcceptance: true as const } : {}),
  };
}
