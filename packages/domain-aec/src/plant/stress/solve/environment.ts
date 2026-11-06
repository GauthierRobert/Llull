/**
 * Weight, wind and static acceleration loads of a stress model (07 PST §5.4): the weight field of the elements (metal, contents, insulation, stated
 * component weights), wind as cross-flow drag on every element, and uniform acceleration loads as fractions of that weight field.
 */

import type { BuiltModel } from '../model/build';
import type { OperatingConditions, StressAcceleration, StressWind } from '../model/schema';

export const GRAVITY = 9.80665;
/** 1 kPa = 1e-3 N/mm^2. */
const KPA_TO_N_PER_MM2 = 1e-3;

export interface WeightField {
  /** Weight per unit length of each element, N/mm (positive; acts along -Z for gravity). */
  readonly perLength: Float64Array;
  /** Weights concentrated at nodes, N (positive; stated component weights and tee / olet weights). */
  readonly nodal: readonly { readonly node: number; readonly newtons: number }[];
}

/** The weight field with `contentsKgM3` in the pipe (the service fluid for W, the test water for WW). */
export function weightField(built: BuiltModel, conditions: OperatingConditions, contentsKgM3: number): WeightField {
  const { elements } = built.layout;
  const insulation = conditions.insulation;
  const perLength = new Float64Array(elements.length);
  const nodal: { node: number; newtons: number }[] = [];
  elements.forEach((element, index) => {
    const inner = element.odMm - 2 * element.wallMm;
    const stated = element.component?.weightKg !== undefined && element.component.weightKg !== null;
    const steel = stated ? 0 : (Math.PI / 4) * (element.odMm ** 2 - inner ** 2);
    const fluid = (Math.PI / 4) * inner ** 2;
    const outer = element.odMm + 2 * (insulation?.thicknessMm ?? 0);
    const insulated =
      stated || insulation === undefined
        ? 0
        : insulation.densityKgM3 * (Math.PI / 4) * (outer ** 2 - element.odMm ** 2) + insulation.claddingKgM2 * 1e3 * Math.PI * outer;
    perLength[index] = GRAVITY * 1e-9 * (conditions.material.densityKgM3 * steel + contentsKgM3 * fluid + insulated);
    if (element.component !== undefined && element.component.weightKg !== null) {
      // the stated weight of a valve / flange acts at its end nodes, shared over the elements it is split into
      const half = (element.component.weightKg * GRAVITY) / element.component.elements / 2;
      nodal.push({ node: element.a, newtons: half }, { node: element.b, newtons: half });
    }
  });
  for (const point of built.pointWeights) nodal.push({ node: point.node, newtons: point.kg * GRAVITY });
  return { perLength, nodal };
}

type Vec = readonly [number, number, number];

const unit = (vector: Vec): Vec => {
  const size = Math.hypot(...vector);
  return [vector[0] / size, vector[1] / size, vector[2] / size];
};

/**
 * Wind drag per unit length on each element, N/mm, global axes. Cross-flow (independence) principle: only the wind component normal to the element axis
 * loads it, f = q Cf D_e |w_n| w_n with w the unit wind direction, w_n = w - (w . a) a, D_e the outside diameter plus twice the insulation.
 * @invariant an element parallel to the wind carries nothing; an element normal to it carries q Cf D_e
 */
export function windLoads(built: BuiltModel, conditions: OperatingConditions, wind: StressWind): Float64Array {
  const direction = unit(wind.direction);
  const out = new Float64Array(built.layout.elements.length * 3);
  built.layout.elements.forEach((element, index) => {
    const a = built.layout.nodes[element.a] as Vec;
    const b = built.layout.nodes[element.b] as Vec;
    const axis = unit([b[0] - a[0], b[1] - a[1], b[2] - a[2]]);
    const along = direction[0] * axis[0] + direction[1] * axis[1] + direction[2] * axis[2];
    const normal: Vec = [direction[0] - along * axis[0], direction[1] - along * axis[1], direction[2] - along * axis[2]];
    const size = Math.hypot(...normal);
    const effective = element.odMm + 2 * (conditions.insulation?.thicknessMm ?? 0);
    const scale = wind.pressureKPa * KPA_TO_N_PER_MM2 * wind.dragCoefficient * effective * size;
    for (let i = 0; i < 3; i++) out[index * 3 + i] = scale * (normal[i] as number);
  });
  return out;
}

/** Static acceleration load: `gFactors` x the weight field (per length and concentrated), in the stated direction. */
export function accelerationLoads(
  field: WeightField,
  acceleration: StressAcceleration,
): { readonly uniform: Float64Array; readonly nodal: readonly { readonly node: number; readonly force: Vec }[] } {
  const uniform = new Float64Array(field.perLength.length * 3);
  field.perLength.forEach((weight, index) => {
    for (let i = 0; i < 3; i++) uniform[index * 3 + i] = weight * (acceleration.gFactors[i] as number);
  });
  const nodal = field.nodal.map(({ node, newtons }) => ({
    node,
    force: [newtons * acceleration.gFactors[0], newtons * acceleration.gFactors[1], newtons * acceleration.gFactors[2]] as Vec,
  }));
  return { uniform, nodal };
}
