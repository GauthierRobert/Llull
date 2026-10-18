/** Mean skin-friction coefficient of one side of a smooth flat plate at Reynolds number Re_L (incompressible). */

export const FRICTION_MODELS = {
  laminar_blasius: 'Cf = 1.328 / √Re_L (Blasius 1908; laminar, Re_L < 5e5)',
  turbulent_power_law: 'Cf = 0.074 / Re_L^0.2 (1/7-power law, turbulent from the leading edge, 5e5 < Re_L < 1e7)',
  turbulent_prandtl_schlichting: 'Cf = 0.455 / (log10 Re_L)^2.58 (Prandtl-Schlichting 1932, turbulent, Re_L < 1e9)',
  ittc_1957: 'CF = 0.075 / (log10 Re - 2)² (ITTC-1957 model-ship correlation line)',
} as const;

export type FrictionModel = keyof typeof FRICTION_MODELS;

export function skinFrictionCoefficient(model: FrictionModel, reynolds: number): number {
  switch (model) {
    case 'laminar_blasius':
      return 1.328 / Math.sqrt(reynolds);
    case 'turbulent_power_law':
      return 0.074 / reynolds ** 0.2;
    case 'turbulent_prandtl_schlichting':
      return 0.455 / Math.log10(reynolds) ** 2.58;
    case 'ittc_1957':
      return 0.075 / (Math.log10(reynolds) - 2) ** 2;
  }
}

/** Validity range [min, max] of Re_L for each model (outside -> warning). */
export const FRICTION_RANGE: Readonly<Record<FrictionModel, readonly [number, number]>> = {
  laminar_blasius: [1e3, 5e5],
  turbulent_power_law: [5e5, 1e7],
  turbulent_prandtl_schlichting: [5e5, 1e9],
  ittc_1957: [1e5, 1e10],
};
