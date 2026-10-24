/**
 * Joint stack and cut-back along one leg (02 RTE §5.3): the occupied intervals measured from the leg start (port stack, elbow centre-to-end,
 * inline component), sorted, and the pipe pieces between them with their cut lengths.
 * @invariant cut = next.start - previous.end - previous.gap - next.gap; cut < -eps refuses; |cut| <= eps is fitting-to-fitting (no piece);
 *   0 < cut < minWeldSpacing is a warning (named default max(4 t, 50 mm)); intervals are never reordered by the caller
 */

export interface Interval {
  /** Id of the part (or `port:start` / `port:end`) that occupies the interval. */
  readonly id: string;
  /** Along the leg, from its start point of intersection. */
  readonly start: number;
  readonly end: number;
  /** Weld root gap deducted from the pipe piece next to this interval (connection rule; named default 0). */
  readonly gap: number;
  /** Why the interval exists: decides the refusal code on overlap. */
  readonly kind: 'fitting' | 'inline' | 'branch';
}

export interface Piece {
  /** Position of the piece ends along the leg (gaps removed). */
  readonly start: number;
  readonly end: number;
  readonly cut: number;
  /** Ids of the intervals on each side. */
  readonly from: string;
  readonly to: string;
}

export interface StackWarning {
  readonly code: 'RTE_WELD_SPACING' | 'RTE_FITTING_TO_FITTING';
  readonly from: string;
  readonly to: string;
  readonly cutLengthMm: number;
  /** RTE_WELD_SPACING: the minimum that was applied. */
  readonly minimumMm?: number;
}

export interface Stack {
  readonly ok: true;
  /** The intervals sorted along the leg (the order the pieces and fitting-to-fitting joints follow). */
  readonly order: readonly Interval[];
  readonly pieces: readonly Piece[];
  /** Neighbouring intervals with no pipe between them. */
  readonly fittingToFitting: ReadonlyArray<{ readonly from: string; readonly to: string; readonly at: number }>;
  readonly warnings: readonly StackWarning[];
}

export interface StackFailure {
  readonly ok: false;
  readonly code: 'RTE_SEGMENT_TOO_SHORT' | 'RTE_INLINE_DOES_NOT_FIT' | 'RTE_BRANCH_ON_FITTING';
  readonly message: string;
  readonly detail: { readonly cutLengthMm: number; readonly from: string; readonly to: string; readonly legLengthMm: number };
}

/** Named default of the minimum weld spacing: max(4 t, 50 mm) for pipe wall t (TECHNICAL_SPEC §5.3, S22). */
export const defaultMinWeldSpacing = (wallMm: number): number => Math.max(4 * wallMm, 50);

/**
 * Cuts the leg of `legLength` between its `intervals`.
 * @param eps zero tolerance for a cut length, document units
 */
export function stackLeg(
  legLength: number,
  intervals: readonly Interval[],
  minWeldSpacing: number,
  eps = 1e-6 * Math.max(1, legLength),
): Stack | StackFailure {
  const sorted = [...intervals].sort((a, b) => a.start - b.start || a.end - b.end);
  const pieces: Piece[] = [];
  const fittingToFitting: Array<{ from: string; to: string; at: number }> = [];
  const warnings: StackWarning[] = [];
  for (let i = 0; i + 1 < sorted.length; i++) {
    const [a, b] = [sorted[i] as Interval, sorted[i + 1] as Interval];
    const start = a.end + a.gap;
    const end = b.start - b.gap;
    const cut = end - start;
    if (cut < -eps) {
      const branch = a.kind === 'branch' || b.kind === 'branch';
      const inline = a.kind === 'inline' || b.kind === 'inline';
      return {
        ok: false,
        code: branch ? 'RTE_BRANCH_ON_FITTING' : inline ? 'RTE_INLINE_DOES_NOT_FIT' : 'RTE_SEGMENT_TOO_SHORT',
        message: `between ${a.id} and ${b.id} the pipe piece would be ${+cut.toFixed(4)} mm long on a ${+legLength.toFixed(4)} mm leg`,
        detail: { cutLengthMm: cut, from: a.id, to: b.id, legLengthMm: legLength },
      };
    }
    if (cut <= eps) {
      fittingToFitting.push({ from: a.id, to: b.id, at: a.end });
      warnings.push({ code: 'RTE_FITTING_TO_FITTING', from: a.id, to: b.id, cutLengthMm: cut });
      continue;
    }
    if (cut < minWeldSpacing)
      warnings.push({ code: 'RTE_WELD_SPACING', from: a.id, to: b.id, cutLengthMm: cut, minimumMm: minWeldSpacing });
    pieces.push({ start, end, cut, from: a.id, to: b.id });
  }
  return { ok: true, order: sorted, pieces, fittingToFitting, warnings };
}
