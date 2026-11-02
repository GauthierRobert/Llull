/**
 * Joint resolution (plant 01 PSC M4): the parts of the joint between two pipe ends of one size under a spec. A flanged joint is two flanges, a gasket
 * and a bolt set (count, diameter, stud length); welded and threaded joints have no parts. Pure over a `PipeSpec` and its catalogues.
 * @invariant a flanged joint is complete or refused: no part is invented; flange class, facing, bolt count and bolt diameter of the two sides must agree
 */

import type { ComponentType, EndType, Facing, PipingCatalog } from '../catalog/types';
import { inRange, querySize, sizeLabel } from './size';
import { resolveComponent, type ComponentQuery, type ResolveFailure, type ResolvedComponent } from './resolve';
import { ASSUMED_GASKET_MM, quarterInchText, raisedFaceHeightMm, studLengthRule, type StudLength, MM_PER_INCH } from '../catalog/bolting';
import type { PipeSpec } from './types';

export const FLANGE_TYPES = [
  'flangeWeldNeck',
  'flangeSlipOn',
  'flangeBlind',
  'flangeSocketWeld',
  'flangeThreaded',
  'flangeLapJoint',
] as const;
export const GASKET_TYPES = ['gasketSpiralWound', 'gasketSheet', 'gasketRing'] as const;
type FlangeType = (typeof FLANGE_TYPES)[number];
type GasketType = (typeof GASKET_TYPES)[number];

export interface JointQuery {
  readonly nps?: string | number | undefined;
  readonly dn?: string | number | undefined;
  readonly endA: EndType;
  readonly endB: EndType;
  readonly flangeTypeA?: FlangeType | undefined;
  readonly flangeTypeB?: FlangeType | undefined;
  readonly gasketType?: GasketType | undefined;
  readonly class?: number | undefined;
  readonly facing?: Facing | undefined;
  readonly gasketThicknessMm?: number | undefined;
  readonly nutHeightMm?: number | undefined;
}

export interface StudResult {
  readonly method: 'catalogue' | 'rule';
  readonly lengthMm: number;
  readonly lengthIn: string | null;
  readonly verified: boolean;
  readonly rule?: StudLength;
  readonly assumptions: readonly string[];
}

export interface JointResult {
  readonly kind: 'flanged' | 'butt weld' | 'socket weld' | 'threaded';
  readonly sizeLabel: string;
  readonly flangeA?: ResolvedComponent;
  readonly flangeB?: ResolvedComponent;
  readonly gasket?: ResolvedComponent;
  readonly bolts?: ResolvedComponent;
  readonly ratingClass?: number;
  readonly facing?: Facing;
  readonly boltCount?: { readonly value: number; readonly source: string };
  readonly boltDiameterMm?: { readonly value: number; readonly source: string };
  readonly stud?: StudResult;
  /** Why there is no stud length (the joint is otherwise complete). */
  readonly studUnknown?: string;
  readonly verified: boolean;
  readonly unverifiedParts: readonly string[];
}

export type JointOutcome = { readonly ok: true; readonly joint: JointResult } | ResolveFailure;

const failure = (code: string, message: string, ids: readonly string[] = [], paths: readonly string[] = []): ResolveFailure => ({
  ok: false,
  code,
  message,
  ids,
  paths,
});

/** Joints without flanges: the end pairs that mate, by the joint they make. */
function weldedKind(a: EndType, b: EndType): JointResult['kind'] | null {
  if (a === 'BW' && b === 'BW') return 'butt weld';
  if ((a === 'SW' && b === 'PE') || (a === 'PE' && b === 'SW')) return 'socket weld';
  if (a === 'THD' && b === 'THD') return 'threaded';
  return null;
}

const sizeQuery = (query: JointQuery): Pick<ComponentQuery, 'nps' | 'dn'> => ({ nps: query.nps, dn: query.dn });
const classOf = (part: ResolvedComponent): number | undefined => part.row?.class ?? part.component.class;
const facingOf = (part: ResolvedComponent): Facing | undefined => part.row?.facing ?? part.component.facing;
const standardOf = (part: ResolvedComponent): string => part.row?.standard ?? part.component.catalogRef;

function resolveFlange(
  spec: PipeSpec,
  catalogs: readonly PipingCatalog[],
  query: JointQuery,
  type: ComponentType,
): ResolvedComponent | ResolveFailure {
  const outcome = resolveComponent(spec, catalogs, { type, ...sizeQuery(query), class: query.class, facing: query.facing });
  return outcome.ok ? outcome.resolved : outcome;
}

/** The one gasket type the spec defines at the size (or the asked one). */
function gasketTypeFor(spec: PipeSpec, query: JointQuery): GasketType | ResolveFailure {
  if (query.gasketType !== undefined) return query.gasketType;
  const size = querySize(sizeQuery(query));
  const present = GASKET_TYPES.filter((type) =>
    spec.components.some((component) => component.type === type && size !== null && inRange(size, component.from, component.to)),
  );
  if (present.length === 1) return present[0] as GasketType;
  if (present.length === 0)
    return failure(
      'PSC_JOINT_INCOMPLETE',
      `spec ${spec.id} defines no gasket (${GASKET_TYPES.join(', ')}) for this size: a flanged joint needs one`,
      [spec.id],
      ['type'],
    );
  return failure(
    'PSC_AMBIGUOUS_COMPONENT',
    `spec ${spec.id} defines several gasket types for this size (${present.join(', ')}); give gasketType`,
    [spec.id],
    ['gasketType'],
  );
}

const isFailure = (value: ResolvedComponent | GasketType | ResolveFailure): value is ResolveFailure =>
  typeof value === 'object' && 'ok' in value;

const dimValue = (part: ResolvedComponent, name: string): number | undefined => part.dims[name]?.value;

/** Bolt count or diameter: the bolt-set row first, then the flange row; a disagreement is refused. */
function boltDim(
  name: 'boltCount' | 'boltDiameter',
  bolts: ResolvedComponent,
  flangeA: ResolvedComponent,
  flangeB: ResolvedComponent,
): { readonly value: number; readonly source: string } | ResolveFailure | null {
  const sources: Array<readonly [string, number | undefined]> = [
    [`bolt set ${bolts.component.id}`, dimValue(bolts, name)],
    [`flange ${flangeA.component.id}`, dimValue(flangeA, name)],
    [`flange ${flangeB.component.id}`, dimValue(flangeB, name)],
  ];
  const known = sources.filter((entry): entry is readonly [string, number] => entry[1] !== undefined);
  const first = known[0];
  if (first === undefined) return null;
  const clash = known.find((entry) => Math.abs(entry[1] - first[1]) > 0.01);
  if (clash !== undefined)
    return failure(
      'PSC_END_INCOMPATIBLE',
      `${name} differs between ${first[0]} (${first[1]}) and ${clash[0]} (${clash[1]}): the joint does not bolt up`,
      [bolts.component.id, flangeA.component.id, flangeB.component.id],
      [name],
    );
  return { value: first[1], source: first[0] };
}

function studFor(
  query: JointQuery,
  parts: { flangeA: ResolvedComponent; flangeB: ResolvedComponent; gasket: ResolvedComponent; bolts: ResolvedComponent },
  diameter: number,
  facing: Facing | undefined,
): { readonly stud: StudResult } | { readonly unknown: string } {
  const listed = parts.bolts.dims['studLength'];
  if (listed !== undefined)
    return {
      stud: {
        method: 'catalogue',
        lengthMm: listed.value,
        lengthIn: quarterInchText(listed.value),
        verified: listed.verified,
        assumptions: [`stud length from bolt set ${parts.bolts.component.id}`],
      },
    };
  const thicknessA = dimValue(parts.flangeA, 'thickness');
  const thicknessB = dimValue(parts.flangeB, 'thickness');
  if (thicknessA === undefined || thicknessB === undefined)
    return {
      unknown: `flange thickness missing in ${thicknessA === undefined ? parts.flangeA.component.id : parts.flangeB.component.id}; import a bolting table with studLength`,
    };
  const rfA = raisedFaceHeightMm(standardOf(parts.flangeA), classOf(parts.flangeA), facing);
  const rfB = raisedFaceHeightMm(standardOf(parts.flangeB), classOf(parts.flangeB), facing);
  if (rfA === null || rfB === null)
    return {
      unknown: `raised-face height of ${standardOf(parts.flangeA)} class ${classOf(parts.flangeA) ?? 'n/a'} facing ${facing ?? 'n/a'} is not tabulated; import a bolting table with studLength`,
    };
  const gasketType = parts.gasket.component.type;
  const gasketRow = dimValue(parts.gasket, 'thickness');
  const assumed = ASSUMED_GASKET_MM[gasketType];
  const gasketMm = query.gasketThicknessMm ?? gasketRow ?? assumed;
  if (gasketMm === undefined) return { unknown: `gasket thickness unknown for ${gasketType}; give gasketThicknessMm` };
  const rule = studLengthRule({
    flangeThicknessAMm: thicknessA,
    flangeThicknessBMm: thicknessB,
    raisedFaceAMm: rfA,
    raisedFaceBMm: rfB,
    gasketMm,
    boltDiameterMm: diameter,
    nutHeightMm: query.nutHeightMm,
  });
  if (rule === null) return { unknown: `thread pitch of a ${diameter} mm bolt is not tabulated; import a bolting table with studLength` };
  const assumptions = [
    query.gasketThicknessMm !== undefined
      ? `gasket thickness ${gasketMm} mm given by the caller`
      : gasketRow !== undefined
        ? `gasket thickness ${gasketMm} mm from the gasket row`
        : `gasket thickness ${gasketMm} mm ASSUMED for ${gasketType} (no thickness in the catalogue row)`,
    query.nutHeightMm !== undefined
      ? `nut height ${rule.nutHeightMm} mm given by the caller`
      : `nut height ${rule.nutHeightMm} mm = nominal bolt diameter (conservative)`,
    `thread projection ${rule.projectionMm.toFixed(2)} mm = 2 pitches of ${rule.pitchMm.toFixed(3)} mm`,
    `raised faces ${rfA} + ${rfB} mm`,
  ];
  return {
    stud: { method: 'rule', lengthMm: rule.lengthMm, lengthIn: quarterInchText(rule.lengthMm), verified: false, rule, assumptions },
  };
}

/** The joint of `query.endA` and `query.endB` at one size under `spec`. */
export function resolveJoint(spec: PipeSpec, catalogs: readonly PipingCatalog[], query: JointQuery): JointOutcome {
  const size = querySize(sizeQuery(query));
  if (size === null) return failure('PSC_SIZE_UNKNOWN', 'nps or dn is missing or not a nominal size', [], ['nps']);
  if (!inRange(size, spec.sizeRange.from, spec.sizeRange.to))
    return failure(
      'PSC_SIZE_OUT_OF_RANGE',
      `${sizeLabel(size)} is outside the size range of spec ${spec.id}: ${sizeLabel(spec.sizeRange.from)} to ${sizeLabel(spec.sizeRange.to)}`,
      [spec.id],
      ['nps'],
    );
  const normal = (end: EndType): EndType => (end === 'BE' ? 'BW' : end);
  const [a, b] = [normal(query.endA), normal(query.endB)];
  const label = sizeLabel(size);
  if (a !== 'FL' || b !== 'FL') {
    const kind = weldedKind(a, b);
    if (kind === null)
      return failure(
        'PSC_END_INCOMPATIBLE',
        `end ${query.endA} cannot meet end ${query.endB}: mating pairs are FL-FL, BW-BW (BE = BW), SW-PE, THD-THD; use a transition component or a flange (wafer / lug ends are not modelled)`,
        [spec.id],
        ['endA', 'endB'],
      );
    return { ok: true, joint: { kind, sizeLabel: label, verified: true, unverifiedParts: [] } };
  }
  const flangeA = resolveFlange(spec, catalogs, query, query.flangeTypeA ?? 'flangeWeldNeck');
  if ('ok' in flangeA) return flangeA;
  const flangeB = resolveFlange(spec, catalogs, query, query.flangeTypeB ?? 'flangeWeldNeck');
  if ('ok' in flangeB) return flangeB;
  for (const [what, valueA, valueB] of [
    ['class', classOf(flangeA), classOf(flangeB)],
    ['facing', facingOf(flangeA), facingOf(flangeB)],
  ] as const)
    if (valueA !== undefined && valueB !== undefined && valueA !== valueB)
      return failure(
        'PSC_END_INCOMPATIBLE',
        `the flanges ${flangeA.component.id} and ${flangeB.component.id} differ in ${what} (${valueA} vs ${valueB}) and do not mate`,
        [flangeA.component.id, flangeB.component.id],
        [what],
      );
  const ratingClass = classOf(flangeA) ?? classOf(flangeB) ?? query.class;
  const facing = facingOf(flangeA) ?? facingOf(flangeB) ?? query.facing;
  const gasketType = gasketTypeFor(spec, query);
  if (isFailure(gasketType)) return gasketType;
  const gasketOutcome = resolveComponent(spec, catalogs, { type: gasketType, ...sizeQuery(query), class: ratingClass });
  if (!gasketOutcome.ok) return gasketOutcome;
  const boltsOutcome = resolveComponent(spec, catalogs, { type: 'boltSet', ...sizeQuery(query), class: ratingClass, facing });
  if (!boltsOutcome.ok)
    return boltsOutcome.code === 'PSC_NO_COMPONENT'
      ? failure('PSC_JOINT_INCOMPLETE', `spec ${spec.id} defines no boltSet for ${label}: ${boltsOutcome.message}`, boltsOutcome.ids, [
          'type',
        ])
      : boltsOutcome;
  const gasket = gasketOutcome.resolved;
  const bolts = boltsOutcome.resolved;
  const count = boltDim('boltCount', bolts, flangeA, flangeB);
  const diameter = boltDim('boltDiameter', bolts, flangeA, flangeB);
  if (count !== null && 'ok' in count) return count;
  if (diameter !== null && 'ok' in diameter) return diameter;
  if (count === null || diameter === null)
    return failure(
      'PSC_JOINT_INCOMPLETE',
      `neither bolt set ${bolts.component.id} nor the flanges give ${count === null ? 'boltCount' : 'boltDiameter'}; import a catalogue that has it`,
      [bolts.component.id, flangeA.component.id],
      [count === null ? 'boltCount' : 'boltDiameter'],
    );
  const studOutcome = studFor(query, { flangeA, flangeB, gasket, bolts }, diameter.value, facing);
  const parts = { flangeA, flangeB, gasket, bolts };
  const unverifiedParts = Object.entries(parts)
    .filter(([, part]) => !part.verified)
    .map(([name]) => name);
  if ('stud' in studOutcome && !studOutcome.stud.verified) unverifiedParts.push('stud');
  if ('unknown' in studOutcome) unverifiedParts.push('stud');
  return {
    ok: true,
    joint: {
      kind: 'flanged',
      sizeLabel: label,
      ...parts,
      ...(ratingClass === undefined ? {} : { ratingClass }),
      ...(facing === undefined ? {} : { facing }),
      boltCount: count,
      boltDiameterMm: diameter,
      ...('stud' in studOutcome ? { stud: studOutcome.stud } : { studUnknown: studOutcome.unknown }),
      verified: unverifiedParts.length === 0,
      unverifiedParts,
    },
  };
}

/** Inch designation of a bolt diameter in mm (`"5/8"`), or null when it is not a multiple of 1/16 in. */
export function boltDiameterInches(mm: number): string | null {
  const sixteenths = mm / MM_PER_INCH / (1 / 16);
  if (Math.abs(sixteenths - Math.round(sixteenths)) > 0.01) return null;
  const n = Math.round(sixteenths);
  const whole = Math.floor(n / 16);
  let rest = n - whole * 16;
  let denominator = 16;
  while (rest > 0 && rest % 2 === 0) {
    rest /= 2;
    denominator /= 2;
  }
  return rest === 0 ? String(whole) : whole === 0 ? `${rest}/${denominator}` : `${whole}-${rest}/${denominator}`;
}
