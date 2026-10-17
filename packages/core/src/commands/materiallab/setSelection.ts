/** Shared by the material-lab queries: pick the constitutive set of a material and, optionally, an ad-hoc law that fills its slot. */

import { behaviourOf, lawIssues } from '../../model/materialLawCatalog';
import { combinationIssues, findSet, setMembers } from '../../model/materialLaws/combination';
import { normalizeLawInput } from '../../model/materialLaws/lawInput';
import { isLawFailure } from '../../model/materialLaws/resolve';
import type { ConstitutiveSet, MaterialLaw, MaterialModel, SetSlot } from '../../model/materialModel';
import { SET_SLOTS } from '../../model/materialModel';
import type { Material } from '../../model/types';
import { lawSchema } from '../document/materialLawSchema';
import { lawHash } from '../document/materialModels';
import { withoutUndefined } from '../document/propertyModelSchema';

export interface Selection {
  readonly setId: string;
  readonly slots: Readonly<Partial<Record<SetSlot, MaterialModel>>>;
  readonly adHoc: MaterialModel | null;
}

export interface SelectionRefusal {
  readonly code: string;
  readonly message: string;
  readonly path: string;
  readonly ids: readonly string[];
  readonly remediation?: string;
}

const AD_HOC_ID = 'adhoc';
/** An id no stored model of the material has, so the synthetic set resolves the ad-hoc law by slot, never by a name clash. */
const freeAdHocId = (record: Material): string => {
  let id = AD_HOC_ID;
  while ((record.materialModels ?? []).some((model) => model.id === id)) id += '_';
  return id;
};

/** An ad-hoc law (input conventions allowed) as a transient, unverified model; never stored. */
export function adHocModel(record: Material, name: string, input: Record<string, unknown>): MaterialModel | SelectionRefusal {
  const normalized = normalizeLawInput(input);
  if (isLawFailure(normalized))
    return {
      code: normalized.code,
      message: normalized.message,
      path: normalized.path,
      ids: [],
      ...(normalized.remediation !== undefined ? { remediation: normalized.remediation } : {}),
    };
  const parsed = lawSchema.safeParse(normalized.law);
  if (!parsed.success)
    return {
      code: 'MATL_LAW_PARAMS_INVALID',
      message: `the law does not match its kind (${parsed.error.issues[0]?.message ?? ''})`,
      path: ['model', ...(parsed.error.issues[0]?.path ?? []).map(String)].join('.'),
      ids: [],
    };
  const law = withoutUndefined<MaterialLaw>(parsed.data);
  const blocking = lawIssues(law, {
    record: { name, ...(record.propertyModels !== undefined ? { propertyModels: record.propertyModels } : {}) },
  }).find((issue) => issue.severity === 'error');
  if (blocking !== undefined) return { code: blocking.code, message: blocking.message, path: blocking.path, ids: [] };
  return {
    id: freeAdHocId(record),
    model: law,
    basis: 'unspecified',
    provenance: { citation: 'ad-hoc model passed to the query (not stored)' },
    parametersSha256: lawHash(law),
    ...(normalized.conversion !== undefined ? { conversion: normalized.conversion } : {}),
  };
}

/**
 * The slots of the named (else default) constitutive set; an ad-hoc model replaces the slot of its behaviour (replacing a hyperelastic model
 * drops an elastic one and vice versa); without a set the ad-hoc model stands alone.
 * @failure unknown set / no set -> MATL_MODEL_NOT_FOUND; invalid combination -> MATL_COMBINATION_INVALID
 */
export function selectSlots(
  material: Material,
  materialName: string,
  setId: string | undefined,
  adHocInput: Record<string, unknown> | undefined,
): Selection | SelectionRefusal {
  const models = material.materialModels ?? [];
  let adHoc: MaterialModel | null = null;
  if (adHocInput !== undefined) {
    const built = adHocModel(material, materialName, adHocInput);
    if ('code' in built) return built;
    adHoc = built;
  }
  const chosenId = setId ?? (adHoc === null ? material.defaultConstitutiveSet : undefined);
  let set: ConstitutiveSet | undefined;
  if (chosenId !== undefined) {
    set = findSet(material.constitutiveSets, chosenId);
    if (set === undefined)
      return {
        code: 'MATL_MODEL_NOT_FOUND',
        message: `material '${materialName}' has no constitutive set '${chosenId}'`,
        path: 'set',
        ids: [chosenId],
        remediation: 'define it with define_constitutive_set',
      };
  } else if (adHoc === null) {
    return {
      code: 'MATL_MODEL_NOT_FOUND',
      message: `material '${materialName}' has no default constitutive set and none was named`,
      path: 'set',
      ids: [],
      remediation: 'name a set, pass an ad-hoc model, or define_constitutive_set with makeDefault',
    };
  }
  const members: Partial<Record<SetSlot, MaterialModel>> = set === undefined ? {} : setMembers(set, models);
  if (adHoc !== null) {
    const slot = behaviourOf(adHoc.model);
    if (!(SET_SLOTS as readonly string[]).includes(slot))
      return {
        code: 'MATL_COMBINATION_INVALID',
        message: `${adHoc.model.kind} is a durability law, never a member of a set`,
        path: 'model',
        ids: [],
      };
    if (slot === 'elastic') delete members.hyperelastic;
    if (slot === 'hyperelastic') delete members.elastic;
    members[slot as SetSlot] = adHoc;
  }
  const synthetic: ConstitutiveSet = {
    id: set?.id ?? AD_HOC_ID,
    ...Object.fromEntries(SET_SLOTS.flatMap((slot) => (members[slot] === undefined ? [] : [[slot, members[slot]?.id]]))),
  };
  const issue = combinationIssues(synthetic, Object.values(members))[0];
  if (issue !== undefined) return { code: issue.code, message: issue.message, path: issue.path, ids: [synthetic.id] };
  return { setId: set?.id ?? AD_HOC_ID, slots: members, adHoc };
}

export const isRefusal = (value: Selection | SelectionRefusal): value is SelectionRefusal => 'code' in value;
