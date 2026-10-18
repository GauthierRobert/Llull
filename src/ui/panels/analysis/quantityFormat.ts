// Number formatting for solver results in the Analysis panel: significant figures (never a fixed decimal count), exponent form for
// very small / large values, and one shared display unit per group of values (Pa -> kPa / MPa / GPa, m -> mm).

const SIGNIFICANT_FIGURES = 4;
/** Natural frequencies and buckling factors keep one more digit: modes sit close together. */
export const EIGEN_FIGURES = 5;
const EXPONENT_BELOW = 1e-3;
const EXPONENT_ABOVE = 1e6;

interface DisplayScale {
  readonly factor: number;
  readonly unit: string;
}

/** Display unit for values whose largest magnitude is `maxAbs`; other units are shown as given. */
function displayScale(maxAbs: number, unit: string): DisplayScale {
  if (unit === 'Pa') {
    if (maxAbs >= 1e9) return { factor: 1e-9, unit: 'GPa' };
    if (maxAbs >= 1e6) return { factor: 1e-6, unit: 'MPa' };
    if (maxAbs >= 1e3) return { factor: 1e-3, unit: 'kPa' };
  }
  if (unit === 'm' && maxAbs > 0 && maxAbs < 1) return { factor: 1e3, unit: 'mm' };
  return { factor: 1, unit };
}

/** `value` to 4 significant figures (or `figures`), trailing zeros dropped; exponent form (9.52e-5) outside 1e-3 ... 1e6. */
export function formatSignificant(value: number, figures = SIGNIFICANT_FIGURES): string {
  if (!Number.isFinite(value)) return String(value);
  if (value === 0) return '0';
  const magnitude = Math.abs(value);
  if (magnitude < EXPONENT_BELOW || magnitude >= EXPONENT_ABOVE) {
    const [mantissa = '', exponent = '0'] = value.toExponential(figures - 1).split('e');
    const trimmed = mantissa.includes('.') ? mantissa.replace(/\.?0+$/, '') : mantissa;
    return `${trimmed}e${Number(exponent)}`;
  }
  const text = value.toPrecision(figures);
  return String(Number(text));
}

interface FormattedQuantities {
  readonly texts: readonly string[];
  readonly unit: string;
}

/** Formats values that share a unit: one display unit chosen from the largest magnitude, so a min / max pair stays comparable. */
export function formatQuantities(values: readonly number[], unit: string): FormattedQuantities {
  const maxAbs = values.reduce((largest, v) => (Number.isFinite(v) ? Math.max(largest, Math.abs(v)) : largest), 0);
  const scale = displayScale(maxAbs, unit);
  return { texts: values.map((v) => formatSignificant(v * scale.factor)), unit: scale.unit };
}
