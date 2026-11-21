import { defineCommand, type z } from '@core/commands/schema';
import { flangeParams } from './flangeParams';
import type { CadDocument, Vec2 } from '@core/model/types';
import type { CommandResult } from '@core/commands/types';
import { changed } from '@core/commands/noop';
import { toRadians } from '@lib/angle';
import { normalize2, sub2 } from '@lib/vec2';
import { bendQuantities } from '../sheetMath';
import type { SheetMetalPart, SheetMetalRule, SheetNode } from '@core/model/sheetMetal';
import { bendGeometry, bottomOffset } from '../frames';
import { withFoldedSolid } from '../fold';
import { EPS, moveEdgeInward } from '../geometry2d';
import { legFlat, childBends, type FlatNode, flatOf, nextNodeId, parentBend, withModel, withNodes, withPart } from '../graph';
import { refitBends, trimWithCornerReliefs } from '../flangeTrim';
import { pickEdge, type EdgeHit } from '../pick';
import { bendEnd } from '../reliefGeometry';
import { applyRelief, isReliefFailure, reliefData } from '../reliefOps';
import { fixed, refuser, type Fail } from '../result';
import { insideRadiusOf, isRefusal, partContext } from '../partLookup';
import { maxOf, minOf } from '@lib/arrayExtrema';

/** Overlap length of intervals [a0,a1] and [b0,b1]. */
const overlap = (a0: number, a1: number, b0: number, b1: number): number =>
  Math.min(Math.max(a0, a1), Math.max(b0, b1)) - Math.max(Math.min(a0, a1), Math.min(b0, b1));

/**
 * @affects adds a flat + a bend to the part and re-derives its folded solid; modifies the parent flat only for position material_inside / bend_outside
 * @invariant flat leg = length - setback (tan(theta/2)*(R+T) for outside_mold_line, tan(theta/2)*R for inside_mold_line, none for tangent); the bend line lies on the picked edge
 * @failure unknown part/rule, angle outside (0, 180], R = 0 without allowSharpBends, edge not found / occupied, leg <= 0 -> rejected with error.code
 */
export const addFlange = defineCommand({
  name: 'add_flange',
  description:
    'Add an edge flange (a bend plus a flat leg) to a sheet-metal part on a straight outline edge picked by a world point `edge.near` (any point within one thickness of the edge). ' +
    "angle is the angle bent THROUGH in degrees (90 = right angle; a closed 45-degree angle is a 135-degree bend); direction up bends towards the flat's +normal face. " +
    'length is measured from the bend to the free end along the flange: to the outside mold line (virtual sharp of the outer faces, default for drawings), the inside mold line, or the bend tangent line. ' +
    "position says where the picked edge sits: 'material_outside' = the edge is the bend tangent line (the bend grows outside the profile), " +
    "'material_inside' = the edge is the outside mold line (the flat is trimmed back by the outside setback), 'bend_outside' = the edge is the extreme of the outer bend surface. " +
    'insideRadius defaults to the rule radius. widthStart / widthEnd inset the bend from the edge ends. All lengths are in the document length unit. ' +
    'Refusals: FTR_PART_NOT_FOUND, FTR_BEND_ANGLE_OUT_OF_RANGE, FTR_SHARP_BEND_FORBIDDEN (R = 0), FTR_EDGE_NOT_STRAIGHT (no edge at edge.near), FTR_EDGE_OCCUPIED, FTR_FLANGE_TOO_SHORT. ' +
    'Next: add_relief, add_sheet_cutout, flat_pattern, check_sheet_metal.',
  params: flangeParams,
  run: (doc, params): CommandResult => applyFlange(doc, 'add_flange', params).result,
});

export type FlangeParams = z.output<typeof flangeParams>;

export interface FlangeOptions {
  /** Hem mode: R = 0 is allowed (closed hem) and `extraNodes` are added in the same step. */
  readonly allowZeroRadius?: boolean;
  readonly extraNodes?: (ids: { readonly flatId: string; readonly bendId: string }) => SheetNode[];
  readonly summarySuffix?: string;
}

export interface FlangeOutcome {
  readonly result: CommandResult;
  readonly flatId?: string;
  readonly bendId?: string;
}

type Failer = (...args: Parameters<Fail>) => FlangeOutcome;

type Step<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly outcome: FlangeOutcome };
const proceed = <T>(value: T): Step<T> => ({ ok: true, value });
const stop = (outcome: FlangeOutcome): Step<never> => ({ ok: false, outcome });

interface Leg {
  readonly widthStart: number;
  readonly widthEnd: number;
  readonly theta: number;
  readonly q: ReturnType<typeof bendQuantities> | null;
  readonly setback: number;
  readonly leg: number;
}

/** The flat leg (length less the setback of the length reference) and the width insets, or a refusal. */
function legOf(fail: Failer, params: FlangeParams, R: number, T: number): Step<Leg> {
  const { angle, length, lengthReference } = params;
  const widthStart = params.widthStart ?? 0;
  const widthEnd = params.widthEnd ?? 0;
  if (!(length > 0) || !(widthStart >= 0) || !(widthEnd >= 0))
    return stop(
      fail('FTR_PARAM_INVALID', 'length must be > 0 and widthStart/widthEnd >= 0', 'Give positive lengths.', { paths: ['length'] }),
    );
  const theta = toRadians(angle);
  const q = angle >= 180 ? null : bendQuantities({ theta, insideRadius: R, thickness: T, k: 0.5 });
  const setback =
    lengthReference === 'outside_mold_line' ? (q?.ossb.value ?? 0) : lengthReference === 'inside_mold_line' ? (q?.issb.value ?? 0) : 0;
  const leg = length - setback;
  if (!(leg > EPS))
    return stop(
      fail(
        'FTR_FLANGE_TOO_SHORT',
        `length ${fixed(length)} leaves a flat leg of ${fixed(leg)} after the ${fixed(setback)} setback`,
        `Use a length > ${fixed(setback)} (document length unit).`,
        { paths: ['length'] },
      ),
    );
  return proceed({ widthStart, widthEnd, theta, q, setback, leg });
}

/** The flat outline with the picked edge moved inward by `trim` (corner reliefs follow), or a refusal. */
function trimmedOutline(
  fail: Failer,
  part: SheetMetalPart,
  flat: FlatNode,
  hit: EdgeHit,
  trim: number,
  position: FlangeParams['position'],
  hasParent: boolean,
): Step<{ outline: Vec2[]; reliefTrim: Exclude<ReturnType<typeof trimWithCornerReliefs>, string> }> {
  if (trim > 0 && hasParent)
    return stop(
      fail(
        'FTR_PARAM_INVALID',
        `position ${position} trims the flat, which is itself a flange`,
        'Use position material_outside on flanges (edge flanges of a flange).',
        { ids: [part.id, flat.id], paths: ['position'] },
      ),
    );
  const reliefTrim = trim > 0 ? trimWithCornerReliefs(part, flat, hit.index, trim) : null;
  if (typeof reliefTrim === 'string')
    return stop(
      fail(
        'FTR_PARAM_INVALID',
        `position ${position} cannot trim ${flat.id} by ${fixed(trim)}: ${reliefTrim}`,
        'Use a smaller flange setback, a smaller corner relief size, or position material_outside.',
        { ids: [part.id, flat.id], paths: ['position'] },
      ),
    );
  const outline = reliefTrim !== null ? reliefTrim.outline : trim > 0 ? moveEdgeInward(flat.outline, hit.index, trim) : [...flat.outline];
  if (outline !== null) return proceed({ outline, reliefTrim });
  const neighbours = [(hit.index + flat.outline.length - 1) % flat.outline.length, (hit.index + 1) % flat.outline.length].map((i) => {
    const [from, to] = [flat.outline[i] as Vec2, flat.outline[(i + 1) % flat.outline.length] as Vec2];
    return Math.hypot(to[0] - from[0], to[1] - from[1]);
  });
  const parallel = neighbours.some((edgeLength) => edgeLength <= trim + EPS);
  return stop(
    fail(
      'FTR_PARAM_INVALID',
      parallel
        ? `the picked edge of ${flat.id} cannot be moved inward by ${fixed(trim)}: a neighbouring outline edge is only ${fixed(minOf(neighbours))} long (a corner-relief notch or step at its end, not longer than the trim), so moving the edge would collapse it`
        : `the flat ${flat.id} is too small to trim by ${fixed(trim)}`,
      parallel
        ? 'Reduce the corner-relief size, or use position material_outside.'
        : 'Enlarge the profile or use position material_outside.',
      { ids: [part.id, flat.id], paths: ['position'] },
    ),
  );
}

/** The replacement nodes of the flat's existing bends after the trim (none without a trim), or a refusal when one cannot follow. */
function refitOf(
  fail: Failer,
  part: SheetMetalPart,
  flat: FlatNode,
  hit: EdgeHit,
  outline: Vec2[],
  trim: number,
  position: FlangeParams['position'],
): Step<{ nodes: SheetNode[] }> {
  const refit = trim > 0 && childBends(part, flat.id).length > 0 ? refitBends(part, flat, hit.index, outline) : { nodes: [] };
  if (!('reason' in refit)) return proceed(refit);
  return stop(
    fail(
      refit.occupied ? 'FTR_EDGE_OCCUPIED' : 'FTR_PARAM_INVALID',
      `position ${position} trims the flat but ${refit.reason}`,
      refit.occupied
        ? 'Pick another edge or use widthStart/widthEnd to leave the existing bend free.'
        : 'Add the material_inside flanges to the base before building flanges on its flanges, or use position material_outside.',
      { ids: [part.id, flat.id], paths: ['position'] },
    ),
  );
}

/** The bend line on the (trimmed) picked edge: its far end `p` and near end `qEnd`; no width left, or an existing bend there, is a refusal. */
function bendLineOf(
  fail: Failer,
  part: SheetMetalPart,
  flat: FlatNode,
  hit: EdgeHit,
  outline: Vec2[],
  hasParent: boolean,
  leg: Leg,
): Step<{ p: Vec2; qEnd: Vec2 }> {
  const a = outline[hit.index] as Vec2;
  const b = outline[(hit.index + 1) % outline.length] as Vec2;
  const along = normalize2(sub2(b, a));
  const edgeLength = Math.hypot(b[0] - a[0], b[1] - a[1]);
  const start = Math.min(leg.widthStart, edgeLength);
  const end = Math.max(start, edgeLength - leg.widthEnd);
  if (end - start <= EPS)
    return stop(
      fail('FTR_PARAM_INVALID', 'widthStart + widthEnd leave no flange width', 'Reduce the insets.', { paths: ['widthStart', 'widthEnd'] }),
    );
  const taken = [
    ...childBends(part, flat.id).map((bend) => bend.lineInFrom),
    ...(hasParent
      ? [
          [
            [0, 0],
            [maxOf(flat.outline.map((point) => point[0])), 0],
          ] as const,
        ]
      : []),
  ].some(([u, v]) => {
    const onLine =
      Math.abs((u[0] - a[0]) * along[1] - (u[1] - a[1]) * along[0]) < 1e-6 &&
      Math.abs((v[0] - a[0]) * along[1] - (v[1] - a[1]) * along[0]) < 1e-6;
    return (
      onLine &&
      overlap((u[0] - a[0]) * along[0] + (u[1] - a[1]) * along[1], (v[0] - a[0]) * along[0] + (v[1] - a[1]) * along[1], start, end) > 1e-6
    );
  });
  if (taken)
    return stop(
      fail(
        'FTR_EDGE_OCCUPIED',
        'the picked edge already carries a bend',
        'Pick another edge or use widthStart/widthEnd to leave the existing bend free.',
        { ids: [part.id, flat.id], paths: ['edge.near'] },
      ),
    );
  return proceed({ p: [a[0] + along[0] * end, a[1] + along[1] * end], qEnd: [a[0] + along[0] * start, a[1] + along[1] * start] });
}

/** Automatic rectangular reliefs at the free ends of the new bend; an end that cannot take one is noted instead. */
function autoReliefs(
  part: SheetMetalPart,
  rule: SheetMetalRule,
  flatId: string,
  bendId: string,
  line: readonly [Vec2, Vec2],
): { part: SheetMetalPart; reliefs: Record<string, unknown>[]; notes: string[] } {
  let nextPart = part;
  const reliefs: Record<string, unknown>[] = [];
  const notes: string[] = [];
  const parentFlat = flatOf(nextPart, flatId);
  for (const end of ['start', 'end'] as const) {
    const location = parentFlat === undefined ? null : bendEnd(parentFlat.outline, line, end);
    if (location === null || location.free <= 1e-6) continue;
    const applied = applyRelief(nextPart, rule, bendId, end);
    if (isReliefFailure(applied)) {
      notes.push(`no automatic relief at the ${end} of ${bendId} (${applied.why})`);
      continue;
    }
    nextPart = applied.part;
    reliefs.push(reliefData(applied, rule.name));
    notes.push(`relief ${applied.id} at the ${end} of ${bendId}: ${fixed(applied.width)} x ${fixed(applied.depth)}`);
  }
  return { part: nextPart, reliefs, notes };
}

/**
 * Flange builder shared by `add_flange` and `add_hem`.
 * @failure see add_flange
 */
export function applyFlange(doc: CadDocument, command: string, params: FlangeParams, options: FlangeOptions = {}): FlangeOutcome {
  const refuseFlange = refuser(doc, command);
  const fail: Failer = (...args) => ({ result: refuseFlange(...args) });
  const found = partContext(doc, params.id, refuseFlange);
  if (isRefusal(found)) return { result: found.refusal };
  const { model, part, rule } = found;
  const { angle, length, lengthReference, position } = params;
  const T = rule.thickness;
  if (!(angle > 0 && angle <= 180) || (angle >= 180 && lengthReference !== 'tangent'))
    return fail(
      'FTR_BEND_ANGLE_OUT_OF_RANGE',
      `angle ${angle} degrees is not allowed`,
      'Bend angle is the angle bent through, 0 < angle < 180 degrees (180 only with lengthReference tangent).',
      { paths: ['angle'] },
    );
  const R = insideRadiusOf(found, params.insideRadius, refuseFlange, options.allowZeroRadius === true);
  if (isRefusal(R)) return { result: R.refusal };
  const legStep = legOf(fail, params, R, T);
  if (!legStep.ok) return legStep.outcome;
  const { theta, q, setback, leg } = legStep.value;

  const hit = pickEdge(part, T, params.edge.near);
  if (hit === null || hit.distance > T + 1e-6)
    return fail(
      'FTR_EDGE_NOT_STRAIGHT',
      `no straight flat edge within one thickness of ${JSON.stringify(params.edge.near)}`,
      'Pick a point on a straight edge of a flat face.',
      { ids: [part.id], paths: ['edge.near'] },
    );
  const { flat } = hit;
  const trim =
    position === 'material_inside'
      ? (q?.ossb.value ?? 0)
      : position === 'bend_outside'
        ? (R + T) * Math.sin(Math.min(theta, Math.PI / 2))
        : 0;
  const hasParent = parentBend(part, flat.id) !== undefined;
  const trimmed = trimmedOutline(fail, part, flat, hit, trim, position, hasParent);
  if (!trimmed.ok) return trimmed.outcome;
  const { outline, reliefTrim } = trimmed.value;
  const refitStep = refitOf(fail, part, flat, hit, outline, trim, position);
  if (!refitStep.ok) return refitStep.outcome;
  const refit = refitStep.value;
  const lineStep = bendLineOf(fail, part, flat, hit, outline, hasParent, legStep.value);
  if (!lineStep.ok) return lineStep.outcome;
  const { p, qEnd } = lineStep.value;

  const signed = params.direction === 'down' ? -theta : theta;
  const bottom = bottomOffset(part.side, T);
  const geometry = bendGeometry(flat.frame, [p, qEnd], signed, R, T, bottom);
  const width = Math.hypot(qEnd[0] - p[0], qEnd[1] - p[1]);
  const flatId = nextNodeId(part, 'f');
  const bendId = nextNodeId(part, 'b');
  const nodes: SheetNode[] = [
    { ...flat, outline },
    ...(reliefTrim?.nodes ?? []),
    ...refit.nodes,
    legFlat(flatId, width, leg, geometry.child),
    { id: bendId, type: 'bend', from: flat.id, to: flatId, lineInFrom: [p, qEnd], angle: signed, insideRadius: R },
  ];
  const extra = options.extraNodes?.({ flatId, bendId }) ?? [];
  const withBend = withNodes(part, [...nodes, ...extra]);
  const relieve = options.extraNodes === undefined && params.autoRelief !== false && rule.relief?.type === 'rectangular';
  const {
    part: nextPart,
    reliefs,
    notes,
  } = relieve ? autoReliefs(withBend, rule, flat.id, bendId, [p, qEnd]) : { part: withBend, reliefs: [], notes: [] };
  const next = withFoldedSolid(withModel(doc, withPart(model, nextPart)), nextPart, rule);
  return {
    result: {
      ...changed(
        next,
        `${command}: part "${part.id}" flange ${flatId} via bend ${bendId}: ${angle} degrees ${params.direction ?? 'up'}, R=${fixed(R)}, flat leg ${fixed(leg)} (length ${fixed(length)} to ${lengthReference}, setback ${fixed(setback)}), width ${fixed(width)}${trim > 0 ? `, base trimmed by ${fixed(trim)}` : ''}.${options.summarySuffix ?? ''}${notes.length > 0 ? ` Automatic ${notes.join('; ')}.` : ''}`,
        [part.id],
      ),
      data: { flangeFlat: flatId, bend: bendId, reliefs },
    },
    flatId,
    bendId,
  };
}
