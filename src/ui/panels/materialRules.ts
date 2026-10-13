import { isHexColor } from '@lib/isHexColor';
import { parseNumber } from '@ui/numberText';

export interface MaterialForm {
  readonly name: string;
  readonly density: string;
  readonly color: string;
  readonly metalness: string;
  readonly roughness: string;
}

export interface MaterialDraft {
  readonly name: string;
  readonly density: number;
  readonly color: string;
  readonly metalness: number;
  readonly roughness: number;
}

/** NaN is outside the interval. */
const isUnitInterval = (value: number): boolean => value >= 0 && value <= 1;

/** The `create_material` params, or null while the form is incomplete / out of range. */
export function materialDraftOf(form: MaterialForm): MaterialDraft | null {
  const name = form.name.trim();
  const density = parseNumber(form.density) ?? NaN;
  const metalness = parseNumber(form.metalness) ?? NaN;
  const roughness = parseNumber(form.roughness) ?? NaN;
  const valid = name !== '' && density > 0 && isHexColor(form.color) && isUnitInterval(metalness) && isUnitInterval(roughness);
  return valid ? { name, density, color: form.color, metalness, roughness } : null;
}
