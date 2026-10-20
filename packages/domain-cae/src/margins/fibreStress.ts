/**
 * Applied stress of a margin row over the stress fields of one result step. Shell / plane-stress nodes carry the membrane average in `STRESS` and
 * the surface stresses in `STRESS_TOP` / `STRESS_BOT` (05 OQ 7): the row takes the largest of the three, so bending is never averaged away.
 */

type StressField = { readonly values: Readonly<Record<string, readonly number[]>> };

type Fibre = 'mid' | 'top' | 'bottom';

export interface Applied {
  readonly node: number;
  readonly value: number;
  /** Which surface governed; present only when the step has fibre fields. */
  readonly fibre?: Fibre;
}

/**
 * Largest `scalar` over `nodes` in STRESS and, when present, STRESS_TOP / STRESS_BOT (ties keep the membrane value).
 * @invariant non-finite values are skipped; null when no node of the set has a value
 */
export function appliedOverFibres(
  fields: Readonly<Record<string, StressField | undefined>>,
  nodes: readonly number[],
  scalar: (values: readonly number[]) => number,
): Applied | null {
  const wanted = new Set(nodes);
  const candidates: readonly (readonly [Fibre, StressField | undefined])[] = [
    ['mid', fields['STRESS']],
    ['top', fields['STRESS_TOP']],
    ['bottom', fields['STRESS_BOT']],
  ];
  const fibres = fields['STRESS_TOP'] !== undefined || fields['STRESS_BOT'] !== undefined;
  let best: Applied | null = null;
  for (const [fibre, field] of candidates) {
    if (field === undefined) continue;
    for (const [id, values] of Object.entries(field.values)) {
      const node = Number(id);
      if (!wanted.has(node)) continue;
      const value = scalar(values);
      if (Number.isFinite(value) && (best === null || value > best.value)) best = { node, value, ...(fibres ? { fibre } : {}) };
    }
  }
  return best;
}
