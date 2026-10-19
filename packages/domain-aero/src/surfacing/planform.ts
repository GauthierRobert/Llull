/** Trapezoidal planform resolution: any 3 independent values among semi-span, area, aspect ratio, taper, root and tip chord fix the rest. */

export interface PlanformInput {
  readonly semiSpan?: number | undefined;
  readonly rootChord?: number | undefined;
  readonly tipChord?: number | undefined;
  readonly taper?: number | undefined;
  /** Planform area of the complete (both-sided) wing. */
  readonly area?: number | undefined;
  readonly aspectRatio?: number | undefined;
}

export interface ResolvedPlanform {
  readonly semiSpan: number;
  readonly rootChord: number;
  readonly tipChord: number;
}

export type PlanformFailure = {
  readonly code: 'AERO_PLANFORM_UNDERDETERMINED' | 'AERO_PLANFORM_OVERDETERMINED' | 'AERO_PARAM_INVALID';
  readonly message: string;
};

const NAMES = ['semiSpan', 'rootChord', 'tipChord', 'taper', 'area', 'aspectRatio'] as const;

const close = (a: number, b: number): boolean => Math.abs(a - b) <= 1e-9 * Math.max(Math.abs(a), Math.abs(b), 1e-300);

/**
 * Solve S = (cr + ct) s (both sides), AR = 4 s^2 / S, taper = ct / cr from exactly three given values.
 * @failure not exactly 3 values -> UNDER/OVERDETERMINED; non-positive value -> PARAM_INVALID; the three do not fix s, cr and ct, or the
 *   derived values disagree with a given one -> OVERDETERMINED (dependent set)
 */
export function resolvePlanform(input: PlanformInput): ResolvedPlanform | PlanformFailure {
  const given = NAMES.filter((name) => input[name] !== undefined);
  if (given.length < 3)
    return {
      code: 'AERO_PLANFORM_UNDERDETERMINED',
      message: `${given.length} planform value(s) given (${given.join(', ') || 'none'}); exactly 3 are needed`,
    };
  if (given.length > 3)
    return {
      code: 'AERO_PLANFORM_OVERDETERMINED',
      message: `${given.length} planform values given (${given.join(', ')}); exactly 3 are needed`,
    };
  const bad = given.find((name) => !((input[name] as number) > 0 && Number.isFinite(input[name])));
  if (bad !== undefined) return { code: 'AERO_PARAM_INVALID', message: `${bad} must be finite and > 0` };
  let { semiSpan: s, rootChord: cr, tipChord: ct } = input;
  const { taper, area, aspectRatio } = input;
  if (s === undefined && area !== undefined && aspectRatio !== undefined) s = Math.sqrt(aspectRatio * area) / 2;
  if (cr === undefined && ct !== undefined && taper !== undefined) cr = ct / taper;
  if (ct === undefined && cr !== undefined && taper !== undefined) ct = cr * taper;
  const sumOf = (span: number): number | undefined =>
    area !== undefined ? area / span : aspectRatio !== undefined ? (4 * span) / aspectRatio : undefined;
  if (s !== undefined) {
    const sum = sumOf(s);
    if (sum !== undefined) {
      if (cr === undefined && ct !== undefined) cr = sum - ct;
      else if (ct === undefined && cr !== undefined) ct = sum - cr;
      else if (cr === undefined && ct === undefined && taper !== undefined) {
        cr = sum / (1 + taper);
        ct = cr * taper;
      }
    }
  } else if (cr !== undefined && ct !== undefined) {
    // Without a span: S = (cr + ct) s fixes s from the area; AR = 4 s^2 / S = 4 s / (cr + ct) fixes it from the aspect ratio.
    if (area !== undefined) s = area / (cr + ct);
    else if (aspectRatio !== undefined) s = (aspectRatio * (cr + ct)) / 4;
  }
  if (s === undefined || cr === undefined || ct === undefined || !(s > 0 && cr > 0 && ct > 0))
    return given.length === 3 && s !== undefined && cr !== undefined && ct !== undefined
      ? { code: 'AERO_PARAM_INVALID', message: 'the planform values give a non-positive span or chord' }
      : {
          code: 'AERO_PLANFORM_UNDERDETERMINED',
          message: `${given.join(', ')} do not fix the semi-span and both chords (dependent values)`,
        };
  const derived = {
    semiSpan: s,
    rootChord: cr,
    tipChord: ct,
    taper: ct / cr,
    area: (cr + ct) * s,
    aspectRatio: (4 * s * s) / ((cr + ct) * s),
  };
  const clash = given.find((name) => !close(derived[name], input[name] as number));
  if (clash !== undefined)
    return {
      code: 'AERO_PLANFORM_OVERDETERMINED',
      message: `${clash} ${input[clash]} contradicts the other values (they give ${derived[clash]})`,
    };
  return { semiSpan: s, rootChord: cr, tipChord: ct };
}
