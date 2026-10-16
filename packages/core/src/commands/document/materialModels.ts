/** add_material_model / remove_material_model (PHY-02): constitutive and durability laws on a document material. */

import { canonicalJson } from '../../lib/canonicalJson';
import { sha256Hex } from '../../lib/sha256';
import { lawIssues } from '../../model/materialLawCatalog';
import { normalizeLawInput } from '../../model/materialLaws/lawInput';
import { combinationIssues } from '../../model/materialLaws/combination';
import { isLawFailure } from '../../model/materialLaws/resolve';
import { validityIssue } from '../../model/materialLaws/validity';
import type { MaterialFitRecord, MaterialLaw, MaterialModel } from '../../model/materialModel';
import { BASES, type Provenance } from '../../model/propertyModel';
import type { CadDocument, Material } from '../../model/types';
import type { CommandResult } from '../types';
import { defineCommand, z } from '../schema';
import { changed } from '../noop';
import { matlRefusal } from './materialModelRefusal';
import { lawSchema, materialFitSchema, validRangeSchema } from './materialLawSchema';
import { withoutUndefined } from './propertyModelSchema';

const pathOf = (error: z.ZodError, prefix: string): string => [prefix, ...(error.issues[0]?.path ?? []).map(String)].join('.');

export const withMaterialModels = (doc: CadDocument, name: string, material: Material, models: readonly MaterialModel[]): CadDocument => ({
  ...doc,
  materials: { ...doc.materials, [name]: { ...material, materialModels: models } },
});

const materialOf = (doc: CadDocument, name: string): Material | undefined =>
  Object.hasOwn(doc.materials, name) ? doc.materials[name] : undefined;

/** `parametersSha256` = sha256 of the canonical JSON of the stored law (PHY-01 TR-PROP-09 rule). */
export const lawHash = (law: MaterialLaw): string => sha256Hex(canonicalJson(law));

const MODEL_DESCRIPTION =
  'The law, by kind. ELASTIC: elastic_isotropic {E, nu}; elastic_orthotropic {E1,E2,E3,nu12,nu13,nu23,G12,G13,G23}; ' +
  "elastic_transversely_isotropic {isotropyPlane '12'|'23', Ep, Et, nuP, nuPT, Gt}; elastic_anisotropic {stiffness: 21 numbers, upper triangle row-wise in Voigt order 11 22 33 12 13 23 (engineering shear), unit}. " +
  'PLASTIC: j2_plasticity {isotropic: perfect {yieldStress} | linear {yieldStress, modulus, modulusKind plastic|tangent REQUIRED} | multilinear {stressUnit, curves [{temperature?, points [[stress, plasticStrain]…]}], ' +
  'inputMeasure {stress true|engineering, strain plastic|total, strainKind true|engineering, youngModulus? for total} REQUIRED} | voce {yieldStress, Q, b} | johnson_cook {A, B, n, m, meltTemperature, transitionTemperature}; ' +
  "kinematic: none | linear {C} | chaboche {backstresses [{C, gamma}…]}}; ramberg_osgood {form 'calculix' {E, nu, sigma0, alpha, n} | 'engineering' {E, nu, sigma02, n} REQUIRED}. " +
  'HYPERELASTIC (stress parameters {value, unit}, D in 1/stress, D = 0 incompressible): hyper_neo_hooke {C10, D1}; hyper_mooney_rivlin {C10, C01, D1}; hyper_polynomial {order, C {C10…}, D[], stressUnit}; ' +
  "hyper_reduced_polynomial {order, Ci0[], D[], stressUnit}; hyper_yeoh {C10, C20, C30, D[3], compliance}; hyper_ogden {convention 'calculix'|'ogden1972' REQUIRED, terms [{mu, alpha}] (1-3), D[], stressUnit}; " +
  'hyper_arruda_boyce {mu, lambdaM, D}. TIME: visco_prony {shear [{g, tau}], bulk?, shift? wlf|arrhenius}; creep_norton {A, n, m, stressUnit, timeUnit, hardening}; creep_garofalo {A, alpha, n, activationEnergy}; ' +
  'rate_johnson_cook {C, referenceRate}; rate_cowper_symonds {D, q}. DURABILITY (stored and validated structurally, never in a set): sn_basquin, sn_power_law, sn_table, sn_equivalent_stress, ' +
  'en_coffin_manson, cyclic_ramberg_osgood, haigh_table, da_dn_paris, da_dn_walker, da_dn_forman, da_dn_nasgro, da_dn_table, fracture_toughness. ' +
  'A stress-like parameter is {value, unit} or {propertyModelId} (a define_property_model model of the same material, e.g. E(T)).';

/**
 * @affects CadDocument.materials[material].materialModels (adds or, with replace, replaces one model)
 * @invariant stored in the canonical convention with `conversion` recorded; parametersSha256 recomputed from the law, never taken from
 *   params; the catalogue validators pass (elastic laws positive definite, hyperelastic initial modulus > 0, Drucker stable inside the
 *   declared stretch validity); reviewedBy is never set here
 * @failure unknown material -> MAT_RECORD_NOT_FOUND; unknown kind / bad parameter -> MATL_LAW_PARAMS_INVALID; the dedicated MATL_* codes
 *   of §7.1; duplicate id without replace -> MATL_MODEL_EXISTS (all rejections, document unchanged)
 */
export const addMaterialModel = defineCommand({
  name: 'add_material_model',
  description:
    'Attach a constitutive or durability law to a material (create_material first): linear elasticity (isotropic, orthotropic, transversely ' +
    'isotropic, anisotropic), J2 plasticity with isotropic and kinematic hardening, Ramberg-Osgood, hyperelasticity (Neo-Hooke, Mooney-Rivlin, ' +
    'polynomial, Yeoh, Ogden, Arruda-Boyce), Prony viscoelasticity, Norton / Garofalo creep, Johnson-Cook / Cowper-Symonds rate laws, and the ' +
    'fatigue / crack-growth variants. Parameters carry units; conventions are stated, never guessed (linear hardening needs modulusKind plastic ' +
    'or tangent, curves need their measure, Ogden needs its convention, Ramberg-Osgood its form); llull stores the canonical form and records ' +
    'the conversion. Elastic stiffness must be positive definite and a hyperelastic law Drucker-stable inside its declared stretch validity. ' +
    'The parameter hash is recomputed. Next: define_constitutive_set, then material_point_response and check_material_models.',
  params: z.object({
    material: z.string().describe('Material id: the name given to create_material.'),
    id: z.string().min(1).describe('Model id, unique on the material, e.g. "elastic", "plastic.iso", "treloar.yeoh".'),
    model: z.record(z.string(), z.unknown()).describe(MODEL_DESCRIPTION),
    validity: z
      .array(validRangeSchema)
      .optional()
      .describe(
        'Ranges the law is valid in (T, equivalentPlasticStrain, strainRate, time, stretch): REQUIRED for exports, advised for every constitutive law.',
      ),
    basis: z
      .enum(BASES)
      .describe('A | B | S, typical, supplier_unstated, company, unspecified (typical / unstated / unspecified ⇒ unverified).'),
    source: z
      .object({
        citation: z.string().describe('Bibliographic citation of the parameters.'),
        locator: z.string().optional().describe('Table / page / figure in the source.'),
        url: z.string().optional().describe('Where it was read.'),
        accessed: z.string().optional().describe('Access date, YYYY-MM-DD.'),
        sourceId: z.string().optional().describe('Registered source id, when one exists.'),
      })
      .describe('Provenance of the parameters (required).'),
    fit: z
      .record(z.string(), z.unknown())
      .optional()
      .describe('Fit record exactly as returned by fit_material_model (never hand-written).'),
    preferred: z.literal(true).optional().describe('Mark as THE model of its kind on the material (one per kind).'),
    replace: z.boolean().optional().describe('Replace an existing model with the same id (default false: refused with MATL_MODEL_EXISTS).'),
  }),
  run: (doc, params): CommandResult => {
    const command = 'add_material_model';
    const material = materialOf(doc, params.material);
    if (material === undefined)
      return matlRefusal(doc, command, 'MAT_RECORD_NOT_FOUND', `no material '${params.material}'`, [params.material], 'material');
    const normalized = normalizeLawInput(params.model);
    if (isLawFailure(normalized))
      return matlRefusal(doc, command, normalized.code, normalized.message, [params.id], normalized.path, normalized.remediation);
    const parsed = lawSchema.safeParse(normalized.law);
    if (!parsed.success)
      return matlRefusal(
        doc,
        command,
        'MATL_LAW_PARAMS_INVALID',
        `the law does not match its kind (${parsed.error.issues[0]?.message ?? ''})`,
        [params.id],
        pathOf(parsed.error, 'model'),
      );
    const law = withoutUndefined<MaterialLaw>(parsed.data);
    let fit: MaterialFitRecord | undefined;
    if (params.fit !== undefined) {
      const parsedFit = materialFitSchema.safeParse(params.fit);
      if (!parsedFit.success)
        return matlRefusal(
          doc,
          command,
          'MATL_LAW_PARAMS_INVALID',
          'fit is not a fit_material_model record',
          [params.id],
          pathOf(parsedFit.error, 'fit'),
        );
      fit = withoutUndefined<MaterialFitRecord>(parsedFit.data);
    }
    if (params.source.citation.trim() === '' && params.source.sourceId === undefined)
      return matlRefusal(doc, command, 'MAT_PROVENANCE_MISSING', 'source.citation is empty', [params.id], 'source.citation');
    const existing = material.materialModels ?? [];
    const index = existing.findIndex((candidate) => candidate.id === params.id);
    if (index >= 0 && params.replace !== true)
      return matlRefusal(doc, command, 'MATL_MODEL_EXISTS', `'${params.material}' already has a model '${params.id}'`, [params.id], 'id');
    const validity = params.validity === undefined ? undefined : withoutUndefined<NonNullable<MaterialModel['validity']>>(params.validity);
    const rangeIssue = validity === undefined ? null : validityIssue(validity);
    if (rangeIssue !== null) return matlRefusal(doc, command, rangeIssue.code, rangeIssue.message, [params.id], rangeIssue.path);
    const issues = lawIssues(law, {
      record: { name: params.material, ...(material.propertyModels !== undefined ? { propertyModels: material.propertyModels } : {}) },
      ...(validity !== undefined ? { validity } : {}),
    });
    const blocking = issues.find((issue) => issue.severity === 'error');
    if (blocking !== undefined) return matlRefusal(doc, command, blocking.code, blocking.message, [params.id], blocking.path);
    const rival =
      params.preferred === true
        ? existing.find((candidate) => candidate.id !== params.id && candidate.preferred === true && candidate.model.kind === law.kind)
        : undefined;
    if (rival !== undefined)
      return matlRefusal(
        doc,
        command,
        'MAT_PREFERRED_CONFLICT',
        `'${rival.id}' is already the preferred ${law.kind}`,
        [rival.id, params.id],
        'preferred',
      );
    const model: MaterialModel = {
      id: params.id,
      model: law,
      ...(validity !== undefined ? { validity } : {}),
      basis: params.basis,
      provenance: withoutUndefined<Provenance>(params.source),
      parametersSha256: lawHash(law),
      ...(normalized.conversion !== undefined ? { conversion: normalized.conversion } : {}),
      ...(fit !== undefined ? { fit } : {}),
      ...(params.preferred === true ? { preferred: true as const } : {}),
    };
    const models = index >= 0 ? existing.map((candidate) => (candidate.id === model.id ? model : candidate)) : [...existing, model];
    for (const set of material.constitutiveSets ?? []) {
      if (index < 0 || !Object.values(set).includes(model.id)) continue;
      const broken = combinationIssues(set, models)[0];
      if (broken !== undefined)
        return matlRefusal(
          doc,
          command,
          'MATL_COMBINATION_INVALID',
          `replacing '${model.id}' breaks constitutive set '${set.id}' (${broken.message})`,
          [model.id, set.id],
          'id',
        );
    }
    const warnings = issues.filter((issue) => issue.severity !== 'error');
    return {
      ...changed(
        withMaterialModels(doc, params.material, material, models),
        `add_material_model '${params.material}/${model.id}': ${law.kind} (basis ${model.basis}, sha256 ${model.parametersSha256.slice(0, 12)}…)${index >= 0 ? ', replaced' : ''}${
          model.conversion !== undefined ? `; converted from ${model.conversion.from}` : ''
        }${warnings.length > 0 ? `; ${warnings.length} warning(s): ${warnings.map((w) => w.code).join(', ')}` : ''}.`,
        [],
      ),
      data: {
        id: model.id,
        kind: law.kind,
        parametersSha256: model.parametersSha256,
        conversion: model.conversion ?? null,
        warnings,
        defaults: [],
      },
    };
  },
});

/**
 * @affects CadDocument.materials[material].materialModels (removes one model)
 * @invariant other models and the constitutive sets are untouched
 * @failure unknown material -> MAT_RECORD_NOT_FOUND; unknown id -> MATL_MODEL_NOT_FOUND; a set lists it -> MATL_MODEL_IN_USE
 */
export const removeMaterialModel = defineCommand({
  name: 'remove_material_model',
  annotations: { destructive: true },
  description: 'Remove one material model from a material. Refused while a constitutive set of the material lists it (MATL_MODEL_IN_USE).',
  params: z.object({
    material: z.string().describe('Material id (create_material name).'),
    id: z.string().describe('Id of the model to remove.'),
  }),
  run: (doc, { material: materialId, id }): CommandResult => {
    const command = 'remove_material_model';
    const material = materialOf(doc, materialId);
    if (material === undefined)
      return matlRefusal(doc, command, 'MAT_RECORD_NOT_FOUND', `no material '${materialId}'`, [materialId], 'material');
    const models = material.materialModels ?? [];
    if (!models.some((candidate) => candidate.id === id))
      return matlRefusal(doc, command, 'MATL_MODEL_NOT_FOUND', `'${materialId}' has no material model '${id}'`, [id], 'id');
    const sets = (material.constitutiveSets ?? []).filter((set) =>
      [set.elastic, set.hyperelastic, set.plastic, set.viscoelastic, set.creep, set.rate].includes(id),
    );
    if (sets.length > 0)
      return matlRefusal(
        doc,
        command,
        'MATL_MODEL_IN_USE',
        `constitutive set(s) ${sets.map((set) => set.id).join(', ')} list '${id}'`,
        sets.map((set) => set.id),
        'id',
      );
    return changed(
      withMaterialModels(
        doc,
        materialId,
        material,
        models.filter((candidate) => candidate.id !== id),
      ),
      `remove_material_model '${materialId}/${id}': removed.`,
      [],
    );
  },
});
