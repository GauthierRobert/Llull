/**
 * Property catalogue (PHY-01 §3.2): name -> canonical unit (which fixes the dimension), positivity and owning pack. Open/closed: a pack
 * adds its rows here instead of adding `switch`es.
 */

export interface PropertyCatalogEntry {
  readonly name: string;
  readonly canonicalUnit: string;
  readonly positive: boolean;
  readonly strength: boolean;
  readonly ownerPack: string;
  readonly description: string;
}

const row = (
  name: string,
  canonicalUnit: string,
  description: string,
  options: { positive?: boolean; strength?: boolean; ownerPack?: string } = {},
): PropertyCatalogEntry => ({
  name,
  canonicalUnit,
  positive: options.positive ?? true,
  strength: options.strength ?? false,
  ownerPack: options.ownerPack ?? '08 MAT',
  description,
});

const PROPERTY_CATALOG: readonly PropertyCatalogEntry[] = [
  row('density', 'kg/m^3', 'mass density'),
  row('E', 'Pa', "Young's modulus (tension)"),
  row('Ec', 'Pa', "Young's modulus (compression)"),
  row('G', 'Pa', 'shear modulus'),
  row('nu', '1', "Poisson's ratio"),
  row('Ftu', 'Pa', 'ultimate tensile strength', { strength: true }),
  row('Fty', 'Pa', 'tensile yield strength', { strength: true }),
  row('Fcy', 'Pa', 'compressive yield strength', { strength: true }),
  row('Fsu', 'Pa', 'ultimate shear strength', { strength: true }),
  row('Fbru', 'Pa', 'ultimate bearing strength', { strength: true }),
  row('Fbry', 'Pa', 'bearing yield strength', { strength: true }),
  row('elongation', '1', 'elongation at break'),
  row('cte', '1/K', 'coefficient of thermal expansion', { positive: false }),
  row('k', 'W/(m*K)', 'thermal conductivity'),
  row('cp', 'J/(kg*K)', 'specific heat capacity'),
  row('thermalStrain', '1', 'thermal strain (L - L_ref)/L_ref', { positive: false, ownerPack: 'PHY-01' }),
  row('thermalDiffusivity', 'm^2/s', 'thermal diffusivity', { ownerPack: 'PHY-01' }),
  row('diffusionRate', '1/s', 'thermally activated rate (Arrhenius)', { ownerPack: 'PHY-01' }),
  row('rateFactor', '1', 'dimensionless strain-rate multiplier of a flow stress', { ownerPack: 'PHY-01' }),
  row('structuralLossFactor', '1', 'structural (hysteretic) damping loss factor eta, written as *DAMPING,STRUCTURAL', {
    positive: false,
    ownerPack: 'PHY-09',
  }),
];

export function catalogEntry(name: string): PropertyCatalogEntry | undefined {
  return PROPERTY_CATALOG.find((entry) => entry.name === name);
}
