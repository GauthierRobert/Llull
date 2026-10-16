/**
 * Law catalogue (PHY-02 §3.4): per law kind its behaviour slot, owning pack, validator and solver support. Open/closed: a pack adds a
 * row here instead of a `switch` in every caller.
 */

import type { MaterialBehaviour, MaterialLaw, MaterialLawKind } from './materialModel';
import type { HyperLaw } from './materialLaws/hyperResolve';
import { validateDurability } from './materialLaws/validateDurability';
import { validateElastic } from './materialLaws/validateElastic';
import { validateHyper } from './materialLaws/validateHyper';
import { validatePlastic, validateRate } from './materialLaws/validatePlastic';
import { validateCreep, validateViscoelastic } from './materialLaws/validateTime';
import { unitIssues, type MatlIssue, type ValidateContext } from './materialLaws/issues';

export type { MatlIssue, ValidateContext };

interface MaterialLawCatalogEntry {
  readonly kind: MaterialLawKind;
  readonly behaviour: MaterialBehaviour;
  readonly ownerPack: string;
  readonly validate: (law: MaterialLaw, context: ValidateContext) => readonly MatlIssue[];
  readonly targets: { readonly calculix: 'native' | 'unsupported' | 'mfront_v2'; readonly nastran: 'native' | 'unsupported' | 'tbd' };
}

const entry = <K extends MaterialLawKind>(
  kind: K,
  behaviour: MaterialBehaviour,
  ownerPack: string,
  validate: (law: Extract<MaterialLaw, { kind: K }>, context: ValidateContext) => readonly MatlIssue[],
  targets: MaterialLawCatalogEntry['targets'],
): MaterialLawCatalogEntry => ({
  kind,
  behaviour,
  ownerPack,
  validate: (law, context) => validate(law as Extract<MaterialLaw, { kind: K }>, context),
  targets,
});

const NATIVE = { calculix: 'native', nastran: 'native' } as const;
const CCX_ONLY = { calculix: 'native', nastran: 'tbd' } as const;
const NONE = { calculix: 'unsupported', nastran: 'unsupported' } as const;
const hyper = (kind: HyperLaw['kind']): MaterialLawCatalogEntry =>
  entry(kind, 'hyperelastic', 'PHY-02', (law, context) => validateHyper(law as HyperLaw, context), CCX_ONLY);

const CATALOG: readonly MaterialLawCatalogEntry[] = [
  entry('elastic_isotropic', 'elastic', 'PHY-02', validateElastic, NATIVE),
  entry('elastic_orthotropic', 'elastic', 'PHY-02', validateElastic, CCX_ONLY),
  entry('elastic_transversely_isotropic', 'elastic', 'PHY-02', validateElastic, CCX_ONLY),
  entry('elastic_anisotropic', 'elastic', 'PHY-02', validateElastic, CCX_ONLY),
  entry('j2_plasticity', 'plastic', 'PHY-02', validatePlastic, NATIVE),
  entry('ramberg_osgood', 'plastic', 'PHY-02', validatePlastic, { calculix: 'native', nastran: 'unsupported' }),
  hyper('hyper_neo_hooke'),
  hyper('hyper_mooney_rivlin'),
  hyper('hyper_polynomial'),
  hyper('hyper_reduced_polynomial'),
  hyper('hyper_yeoh'),
  hyper('hyper_ogden'),
  hyper('hyper_arruda_boyce'),
  entry('visco_prony', 'viscoelastic', 'PHY-02', validateViscoelastic, { calculix: 'unsupported', nastran: 'tbd' }),
  entry('creep_norton', 'creep', 'PHY-02', validateCreep, { calculix: 'native', nastran: 'tbd' }),
  entry('creep_garofalo', 'creep', 'PHY-02', validateCreep, { calculix: 'mfront_v2', nastran: 'tbd' }),
  entry('rate_johnson_cook', 'rate', 'PHY-02', validateRate, { calculix: 'native', nastran: 'unsupported' }),
  entry('rate_cowper_symonds', 'rate', 'PHY-02', validateRate, NONE),
  entry('sn_basquin', 'fatigue', 'PHY-07', validateDurability, NONE),
  entry('sn_power_law', 'fatigue', 'PHY-07', validateDurability, NONE),
  entry('sn_table', 'fatigue', 'PHY-07', validateDurability, NONE),
  entry('sn_equivalent_stress', 'fatigue', 'PHY-07', validateDurability, NONE),
  entry('en_coffin_manson', 'fatigue', 'PHY-07', validateDurability, NONE),
  entry('cyclic_ramberg_osgood', 'fatigue', 'PHY-07', validateDurability, NONE),
  entry('haigh_table', 'fatigue', 'PHY-07', validateDurability, NONE),
  entry('da_dn_paris', 'crack_growth', 'PHY-08', validateDurability, NONE),
  entry('da_dn_walker', 'crack_growth', 'PHY-08', validateDurability, NONE),
  entry('da_dn_forman', 'crack_growth', 'PHY-08', validateDurability, NONE),
  entry('da_dn_nasgro', 'crack_growth', 'PHY-08', validateDurability, NONE),
  entry('da_dn_table', 'crack_growth', 'PHY-08', validateDurability, NONE),
  entry('fracture_toughness', 'toughness', 'PHY-08', validateDurability, NONE),
];

const BY_KIND: ReadonlyMap<string, MaterialLawCatalogEntry> = new Map(CATALOG.map((row) => [row.kind, row]));

export const behaviourOf = (law: MaterialLaw): MaterialBehaviour => BY_KIND.get(law.kind)?.behaviour ?? 'elastic';

/** Durability variants are never members of a constitutive set. */
export const isConstitutive = (law: MaterialLaw): boolean => {
  const behaviour = behaviourOf(law);
  return behaviour !== 'fatigue' && behaviour !== 'crack_growth' && behaviour !== 'toughness';
};

/** Catalogue validation of a law: parseable units everywhere, then the owning validator. */
export function lawIssues(law: MaterialLaw, context: ValidateContext): readonly MatlIssue[] {
  const units = isConstitutive(law) ? unitIssues(law, 'model') : [];
  if (units.length > 0) return units;
  return BY_KIND.get(law.kind)?.validate(law, context) ?? [];
}
