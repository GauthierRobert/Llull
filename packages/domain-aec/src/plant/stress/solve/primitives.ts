/** Primitive loads of a stress model (07 PST §5.4): weight W, thermal Tn, pressure Pn, forces Fn, as frame3d loads. */

import type { FrameLoadCase } from '@lib/frame3d/types';
import { isCteRefusal, materialCteProvider, type CteBasis } from '@core/model/materialCte';
import type { CadDocument } from '@core/model/types';
import { carbonSteelStrain, TABLE_RANGE_C } from '../code/thermalStrain';
import type { BuiltModel } from '../model/build';
import type { OperatingConditions, StressModel } from '../model/schema';

const KELVIN = 273.15;
const GRAVITY = 9.80665;
const BAR_TO_MPA = 0.1;

export interface PrimitiveFailure {
  readonly ok: false;
  readonly code: string;
  readonly message: string;
  readonly path: string;
}

export interface CaseLoads {
  readonly load: FrameLoadCase;
  /** Global uniform load per element (N/mm), 3 per element: for the mid-element stress stations. */
  readonly uniform: Float64Array;
  /** Largest gauge pressure of the primitives, bar (0 when none). */
  readonly pressureBar: number;
  /** Largest metal temperature of the thermal primitives, degC (null when none). */
  readonly maxTempC: number | null;
  /** Imposed displacements of anchor nodes (D primitives): 6 values per node (mm, rad), summed per node. */
  readonly prescribed: ReadonlyMap<number, readonly number[]>;
  /** Reasons the thermal strain source is not verified (PST_MATERIAL_UNVERIFIED). */
  readonly unverified: readonly string[];
}

const CODE_OF_CAUSE: Readonly<Record<string, string>> = {
  MAT_RECORD_NOT_FOUND: 'PST_MATERIAL_NOT_FOUND',
  TMC_PROPERTY_OUT_OF_RANGE: 'PST_TEMPERATURE_OUT_OF_TABLE',
};

/** Free thermal strain from the installation temperature to `tempC`, or why it is not available. Never extrapolates. */
export function thermalStrain(
  doc: Pick<CadDocument, 'materials'>,
  conditions: OperatingConditions,
  tempC: number,
): { readonly ok: true; readonly strain: number; readonly unverified: readonly string[] } | PrimitiveFailure {
  const source = conditions.material.thermal;
  if ('table' in source) {
    const from = carbonSteelStrain(conditions.installTempC);
    const to = carbonSteelStrain(tempC);
    if (from === null || to === null)
      return {
        ok: false,
        code: 'PST_TEMPERATURE_OUT_OF_TABLE',
        message: `${from === null ? conditions.installTempC : tempC} degC is outside the carbon-steel-c1 table (${TABLE_RANGE_C.minC.toFixed(1)} to ${TABLE_RANGE_C.maxC.toFixed(1)} degC)`,
        path: 'conditions',
      };
    return { ok: true, strain: to.strain - from.strain, unverified: [] };
  }
  if ('meanCtePerK' in source)
    return {
      ok: true,
      strain: source.meanCtePerK * (tempC - conditions.installTempC),
      unverified: ['meanCtePerK is a caller-supplied coefficient'],
    };
  const basis: CteBasis =
    source.cteReferenceC === undefined ? { kind: 'unstated' } : { kind: 'secant', referenceKelvin: source.cteReferenceC + KELVIN };
  const provider = materialCteProvider(doc.materials, source.materialId, basis, 'materialId');
  if (isCteRefusal(provider))
    return {
      ok: false,
      code: CODE_OF_CAUSE[provider.code] ?? 'PST_MATERIAL_NO_DATA',
      message: `${provider.reason} (${provider.code})`,
      path: provider.path,
    };
  const result = provider.strainAt(tempC + KELVIN, conditions.installTempC + KELVIN);
  if (isCteRefusal(result))
    return {
      ok: false,
      code: CODE_OF_CAUSE[result.code] ?? 'PST_MATERIAL_NO_DATA',
      message: `${result.reason} (${result.code})`,
      path: result.path,
    };
  return { ok: true, strain: result.strain, unverified: result.unverifiedReasons };
}

/** Distinct primitives named by the cases that solve loads (not EXP). */
export const primitivesOf = (model: Pick<StressModel, 'loadCases'>): string[] => [
  ...new Set(model.loadCases.flatMap((loadCase) => (loadCase.type === 'EXP' ? [] : (loadCase.basic ?? [])))),
];

/**
 * The frame3d load case of the primitives `basic`.
 * @failure unknown primitive (no such T / P / F) -> PST_LOADCASE_INVALID; thermal strain unavailable -> its code
 */
export function caseLoads(
  doc: Pick<CadDocument, 'materials'>,
  built: BuiltModel,
  conditions: OperatingConditions,
  name: string,
  basic: readonly string[],
): CaseLoads | PrimitiveFailure {
  const { elements } = built.layout;
  const nodal: NonNullable<FrameLoadCase['nodal']>[number][] = [];
  const elemental: NonNullable<FrameLoadCase['elemental']>[number][] = [];
  const uniform = new Float64Array(elements.length * 3);
  let pressureBar = 0;
  let maxTempC: number | null = null;
  const unverified: string[] = [];
  const prescribed = new Map<number, readonly number[]>();
  const E = conditions.material.youngsModulusMPa;
  for (const primitive of basic) {
    if (primitive === 'W' || primitive === 'WW') {
      const contents = primitive === 'WW' ? (conditions.hydro?.fluidDensityKgM3 ?? 0) : conditions.fluidDensityKgM3;
      const insulation = conditions.insulation;
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
        const q = GRAVITY * 1e-9 * (conditions.material.densityKgM3 * steel + contents * fluid + insulated);
        elemental.push({ element: index, uniform: [0, 0, -q] });
        uniform[index * 3 + 2] = (uniform[index * 3 + 2] as number) - q;
        if (element.component !== undefined && element.component.weightKg !== null) {
          // the stated weight of a valve / flange acts at its end nodes, shared over the elements it is split into
          const half = (element.component.weightKg * GRAVITY) / element.component.elements / 2;
          nodal.push({ node: element.a, force: [0, 0, -half] }, { node: element.b, force: [0, 0, -half] });
        }
      });
      for (const point of built.pointWeights) nodal.push({ node: point.node, force: [0, 0, -point.kg * GRAVITY] });
    } else if (primitive.startsWith('T')) {
      const entry = conditions.temperatures.find((candidate) => candidate.name === primitive);
      if (entry === undefined)
        return {
          ok: false,
          code: 'PST_LOADCASE_INVALID',
          message: `case ${name}: no temperature ${primitive} in the operating conditions`,
          path: 'loadCases',
        };
      const strain = thermalStrain(doc, conditions, entry.tempC);
      if (!strain.ok) return strain;
      unverified.push(...strain.unverified);
      elements.forEach((_, index) => elemental.push({ element: index, freeStrain: strain.strain }));
      maxTempC = Math.max(maxTempC ?? entry.tempC, entry.tempC);
    } else if (primitive.startsWith('P')) {
      const entry = conditions.pressures.find((candidate) => candidate.name === primitive);
      if (entry === undefined)
        return {
          ok: false,
          code: 'PST_LOADCASE_INVALID',
          message: `case ${name}: no pressure ${primitive} in the operating conditions`,
          path: 'loadCases',
        };
      pressureBar = Math.max(pressureBar, entry.gaugeBar);
      if (conditions.poissonPressure)
        elements.forEach((element, index) => {
          const hoop = (entry.gaugeBar * BAR_TO_MPA * element.odMm) / (2 * element.wallMm);
          elemental.push({ element: index, freeStrain: (-conditions.material.poisson * hoop) / E });
        });
    } else if (primitive === 'HP') {
      if (conditions.hydro === undefined)
        return {
          ok: false,
          code: 'PST_LOADCASE_INVALID',
          message: `case ${name}: HP needs the hydrotest conditions (set_pipe_operating_conditions hydrotest)`,
          path: 'loadCases',
        };
      pressureBar = Math.max(pressureBar, conditions.hydro.testPressureBar);
    } else if (primitive.startsWith('D')) {
      const moved = built.displacements.find((entry) => entry.name === primitive);
      if (moved === undefined)
        return {
          ok: false,
          code: 'PST_LOADCASE_INVALID',
          message: `case ${name}: no imposed displacement ${primitive} (set_stress_load_cases displacements)`,
          path: 'loadCases',
        };
      const sum = prescribed.get(moved.node) ?? [0, 0, 0, 0, 0, 0];
      prescribed.set(
        moved.node,
        sum.map((value, dof) => value + (moved.values[dof] as number)),
      );
    } else if (primitive.startsWith('F')) {
      const loads = built.forces.filter((force) => force.name === primitive);
      if (loads.length === 0)
        return {
          ok: false,
          code: 'PST_LOADCASE_INVALID',
          message: `case ${name}: no force ${primitive} (set_stress_load_cases forces)`,
          path: 'loadCases',
        };
      for (const force of loads) nodal.push({ node: force.node, force: force.force, moment: force.moment });
    }
  }
  return { load: { name, nodal, elemental }, uniform, pressureBar, maxTempC, prescribed, unverified };
}
