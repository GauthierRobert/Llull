/** PMI bookkeeping shared by the pmi commands: the model slice, immutable add / replace / remove, review default, coded refusals. */

import type { DatumReference, GeometricTolerancePmi, PmiItem, PmiModel, SavedView } from '../../model/pmi';
import type { CadDocument } from '../../model/types';
import type { CommandResult } from '../types';
import { tableRejection } from '../noop';

/** Governing standard until `set_pmi_standard` says otherwise. */
const DEFAULT_STANDARD = 'ASME_Y14.5_2018';

export const EMPTY_PMI: PmiModel = { standard: DEFAULT_STANDARD, items: {}, order: [], savedViews: {}, savedViewOrder: [] };

export const pmiOf = (doc: CadDocument): PmiModel => doc.pmi ?? EMPTY_PMI;

/** Items in creation order. */
export const pmiItems = (doc: CadDocument): PmiItem[] =>
  pmiOf(doc).order.flatMap((id) => {
    const item = doc.pmi?.items[id];
    return item === undefined ? [] : [item];
  });

export const findPmi = (doc: CadDocument, id: string): PmiItem | undefined =>
  doc.pmi !== undefined && Object.hasOwn(doc.pmi.items, id) ? doc.pmi.items[id] : undefined;

/** `doc` with `item` added (appended to the order) or replaced. */
export function withItem(doc: CadDocument, item: PmiItem): CadDocument {
  const pmi = pmiOf(doc);
  return {
    ...doc,
    pmi: { ...pmi, items: { ...pmi.items, [item.id]: item }, order: pmi.order.includes(item.id) ? pmi.order : [...pmi.order, item.id] },
  };
}

/** `doc` without the items `ids`; saved views drop them from their `pmiIds`. */
export function withoutItems(doc: CadDocument, ids: readonly string[]): CadDocument {
  const pmi = pmiOf(doc);
  const gone = new Set(ids);
  const views = Object.fromEntries(
    Object.entries(pmi.savedViews).map(([key, view]) => [key, { ...view, pmiIds: view.pmiIds.filter((id) => !gone.has(id)) }]),
  );
  return {
    ...doc,
    pmi: {
      ...pmi,
      items: Object.fromEntries(Object.entries(pmi.items).filter(([id]) => !gone.has(id))),
      order: pmi.order.filter((id) => !gone.has(id)),
      savedViews: views,
    },
  };
}

/** `doc` with saved view `view` added or replaced. */
export function withSavedView(doc: CadDocument, view: SavedView): CadDocument {
  const pmi = pmiOf(doc);
  return {
    ...doc,
    pmi: {
      ...pmi,
      savedViews: { ...pmi.savedViews, [view.id]: view },
      savedViewOrder: pmi.savedViewOrder.includes(view.id) ? pmi.savedViewOrder : [...pmi.savedViewOrder, view.id],
    },
  };
}

/** `doc` without saved view `id`. */
export function withoutSavedView(doc: CadDocument, id: string): CadDocument {
  const pmi = pmiOf(doc);
  return {
    ...doc,
    pmi: {
      ...pmi,
      savedViews: Object.fromEntries(Object.entries(pmi.savedViews).filter(([key]) => key !== id)),
      savedViewOrder: pmi.savedViewOrder.filter((key) => key !== id),
    },
  };
}

/** Review state every command-made item starts with (AF-33): no caller identity is available, so a human must accept it. */
export const REVIEW_REQUIRED = {
  required: true,
  reason: 'created through a command (agent or script) — not approved by a qualified engineer',
} as const;

/** Next free datum letter: A-Z (skipping none by default), then AA, AB, ... */
export function nextDatumLabel(taken: ReadonlySet<string>): string {
  const letters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  for (const letter of letters) if (!taken.has(letter)) return letter;
  for (const first of letters) for (const second of letters) if (!taken.has(`${first}${second}`)) return `${first}${second}`;
  return 'ZZ';
}

/** Remediation text per stable code (TECHNICAL_SPEC §7.2). */
const REMEDIATION: Readonly<Record<string, string>> = {
  GDT_KERNEL_NO_TOPOLOGY: 'rerun with the OCC kernel (LLULL_KERNEL=occt-native, the desktop default) — PMI needs exact faces',
  GDT_ENTITY_NOT_SOLID: 'pass the id of a 3D solid (llull describe_scene lists entities)',
  GDT_POINT_NOT_ON_FACE: 'pick a point on the face (inspect_faces lists face centroids and sample points)',
  GDT_FACE_AMBIGUOUS: 'move the point to the face interior, away from edges',
  GDT_DATUM_LABEL_INVALID: 'use the next free letter (omit label)',
  GDT_DATUM_DUPLICATE: 'choose another letter or update_pmi the existing datum',
  GDT_DATUM_UNDEFINED: 'add_datum_feature with that label first',
  GDT_DATUM_REPEATED: 'list each datum once, primary to tertiary',
  GDT_DATUM_TOO_MANY: 'keep at most 3 datum references',
  GDT_DATUM_REFERENCED: 'delete or edit those FCFs, or pass cascade: true',
  GDT_ZONE_NON_POSITIVE: 'tolerance values are > 0 in document units',
  GDT_MC_ON_NON_FOS: 'target a size dimension (targetPmiId) or drop the material condition',
  GDT_DIAMETRAL_ON_PLANE: 'remove diametral for planar features',
  GDT_FORM_WITH_DATUM: 'form tolerances take no datum references',
  GDT_NOT_FOS: 'use add_location_dimension for planes',
  GDT_SIZE_MIXED: 'split into one size dimension per size',
  GDT_SIZE_KIND_MISMATCH: 'use diameter or radius on cylinders, width on two opposite planes, spherical_diameter on a sphere',
  GDT_LIMITS_INVERTED: 'swap the limits (lower must not exceed upper)',
  GDT_LOCATION_AMBIGUOUS: 'give one plane or one hole per side of the location dimension',
  GDT_LOCATION_INVALID: 'use parallel planes / parallel axes for a distance, or measure: angle',
  GDT_LOCATION_SAME_FEATURE: 'from and to must be different features',
  GDT_TARGET_FORM: 'give exactly one of facesNear (with entityId) or targetPmiId',
  GDT_PMI_UNKNOWN: 'list_pmi for valid ids',
  GDT_FIELD_INVALID_FOR_KIND: 'llull describe update_pmi lists the fields; each kind takes only its own',
  GDT_VIEW_REF_UNKNOWN: 'remove the id or create the item',
  GDT_SURFACE_PARAMETER_UNKNOWN: 'use one of Ra, Rz, Rq, Rsk, Rku, Rmax, Sa, Sz',
  GDT_NOTE_EMPTY: 'give non-empty text',
  GDT_ITEM_KIND_UNSUPPORTED: 'only size dimensions can carry ISO 14405 size modifiers',
  GDT_MODIFIER_NOT_APPLICABLE: 'all_around and all_over apply to profile tolerances only',
  GDT_FEATURE_UNRESOLVED: 'update_pmi with a point on the new face',
  GDT_SURFACE_TYPE_CHANGED: 're-attach the item',
  GDT_TARGET_DANGLING: 'delete or retarget the FCF',
  GDT_DATUM_UNUSED: 'reference it or delete it',
  GDT_NOMINAL_OUTSIDE_LIMITS: 'check the model or the limits',
  GDT_REVIEW_REQUIRED: 'a qualified engineer must accept_pmi_review in the desktop app',
  GDT_UNVERIFIED_INPUT: 'link the contributor to a PMI item or confirm the value with its source',
  GDT_FEATURE_UNTOLERANCED: 'add PMI or set_pmi_standard generalToleranceNote',
  GDT_COMPOSITE_INVALID: 'the upper segment must be an existing position / profile FCF on the same target, and not itself a lower segment',
  GDT_REVIEW_HUMAN_ONLY: 'ask the owner to have a qualified engineer review in the desktop app and pass the signed confirmation',
};

const pmiRefusal = tableRejection(REMEDIATION);

/** Remediation text of a stable code. */
export const remediationOf = (code: string): string => REMEDIATION[code] ?? 'see the command description';

/** A coded refusal that also carries the error in `data.error` (TR-GDT-20). */
export function refuse(
  doc: CadDocument,
  command: string,
  code: string,
  message: string,
  ids: readonly string[] = [],
  paths: readonly string[] = [],
): CommandResult {
  const result = pmiRefusal(doc, command, code, message, ids, paths);
  return { ...result, data: { error: result.error } };
}

/** A zone / datum list from command params without `undefined` members (exactOptionalPropertyTypes). */
export const cleanZone = (zone: {
  value: number;
  diametral?: boolean | undefined;
  spherical?: boolean | undefined;
  projectedLength?: number | undefined;
  unequallyDisposed?: number | undefined;
  maxValue?: number | undefined;
}): GeometricTolerancePmi['zone'] => ({
  value: zone.value,
  ...(zone.diametral === undefined ? {} : { diametral: zone.diametral }),
  ...(zone.spherical === undefined ? {} : { spherical: zone.spherical }),
  ...(zone.projectedLength === undefined ? {} : { projectedLength: zone.projectedLength }),
  ...(zone.unequallyDisposed === undefined ? {} : { unequallyDisposed: zone.unequallyDisposed }),
  ...(zone.maxValue === undefined ? {} : { maxValue: zone.maxValue }),
});

export const cleanDatums = (datums: readonly { label: string; boundary?: 'MMB' | 'LMB' | undefined }[]): DatumReference[] =>
  datums.map((d) => ({ label: d.label, ...(d.boundary === undefined ? {} : { boundary: d.boundary }) }));
