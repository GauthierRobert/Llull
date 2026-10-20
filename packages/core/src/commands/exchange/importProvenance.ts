/**
 * Provenance and GVP report of an imported product tree (aerospace 04 XCH M3, TR-XCH-22/24/25): per product what the sender embedded and what
 * llull measured, the unverified flags `mass_properties` and `export_step_ap242` read, the coded warnings and the review reasons.
 * @invariant document-unit values are the millimetre values divided by the exact factor of the unit (25.4 for inch, ...)
 */

import type { DocumentUnit, Vec3 } from '../../model/types';
import type { ExchangePmi, ImportedExchange } from '../../geometry/kernelExchange';
import type { EmbeddedGvp, GvpBand, GvpPolicy, ImportProvenance, UnverifiedReason } from '../../model/exchange';
import type { Step21Summary } from '../../lib/step21/summary';
import { MM_PER_UNIT } from '../../model/units';
import { GVP_POLICY_SOURCES, worstBand } from './gvpBands';
import type { ProductVerification } from './importVerify';
import type { ProductPlacement } from './importTree';

export interface GvpWarning {
  readonly code: 'XCH_GVP_YELLOW' | 'XCH_GVP_RED' | 'XCH_GVP_NOT_CHECKABLE' | 'XCH_PMI_UNMAPPED';
  readonly severity: 'warn' | 'fail';
  readonly message: string;
  readonly entityIds: readonly string[];
  readonly remediation: string;
}

export interface ExchangeReport {
  readonly schemaName: string | null;
  readonly fileUnit: { readonly name: string; readonly mmPerUnit: number } | null;
  /** Exact factor from the file unit to millimetres (25.4 for inch); null when the file names no length unit. */
  readonly unitFactor: number | null;
  readonly products: readonly {
    readonly index: number;
    readonly name: string;
    readonly assembly: boolean;
    readonly componentId?: string;
    readonly entityIds: readonly string[];
    readonly solids: number;
    readonly band: GvpBand;
    readonly embedded?: EmbeddedGvp;
    readonly recomputed?: { readonly volume: number; readonly area: number; readonly centroid: Vec3 };
    /** Semantic PMI the file attaches to this product (lengths in the document unit; faces number the product shape as read). */
    readonly pmi?: ExchangePmi;
    readonly comparisons: readonly {
      readonly property: string;
      readonly sender: unknown;
      readonly receiver: unknown;
      readonly delta: number;
      readonly band: GvpBand;
    }[];
  }[];
  readonly pmiUnmapped: number;
  readonly gvpCheck: { readonly band: GvpBand; readonly verified: boolean; readonly unit: DocumentUnit };
  readonly policy: Readonly<
    Record<keyof GvpPolicy, { readonly value: number; readonly unit: string; readonly source: string; readonly defaulted: boolean }>
  >;
}

const UNIT_NAMES: Readonly<Record<string, ImportProvenance['sourceUnit']>> = {
  mm: 'mm',
  cm: 'cm',
  m: 'm',
  inch: 'in',
  in: 'in',
  foot: 'ft',
  ft: 'ft',
};

const scaleMm = (value: number | undefined, unit: DocumentUnit, power: number): number | undefined =>
  value === undefined ? undefined : value / MM_PER_UNIT[unit] ** power;

/** PMI read in millimetres, expressed in the document unit (angles and the zone / face data are unchanged). */
function pmiInUnit(pmi: ExchangePmi, unit: DocumentUnit): ExchangePmi {
  const length = (value: number): number => value / MM_PER_UNIT[unit];
  return {
    datums: pmi.datums.map((datum) =>
      datum.modifierWithValue === undefined
        ? datum
        : { ...datum, modifierWithValue: { ...datum.modifierWithValue, value: length(datum.modifierWithValue.value) } },
    ),
    tolerances: pmi.tolerances.map((tolerance) => ({
      ...tolerance,
      value: length(tolerance.value),
      ...(tolerance.zoneModifierValue === undefined ? {} : { zoneModifierValue: length(tolerance.zoneModifierValue) }),
      ...(tolerance.maxValue === undefined ? {} : { maxValue: length(tolerance.maxValue) }),
    })),
    dimensions: pmi.dimensions.map((dimension) => {
      const angular = dimension.type === 'size_angular' || dimension.type === 'location_angular';
      const scale = (value: number): number => (angular ? value : length(value));
      return {
        ...dimension,
        value: scale(dimension.value),
        ...(dimension.tolerance === undefined
          ? {}
          : { tolerance: { plus: scale(dimension.tolerance.plus), minus: scale(dimension.tolerance.minus) } }),
        ...(dimension.range === undefined ? {} : { range: { lower: scale(dimension.range.lower), upper: scale(dimension.range.upper) } }),
      };
    }),
  };
}

/** An embedded record converted from millimetres into the document unit. */
function inDocumentUnit(embedded: EmbeddedGvp, unit: DocumentUnit): EmbeddedGvp {
  const volume = scaleMm(embedded.volume, unit, 3);
  const area = scaleMm(embedded.area, unit, 2);
  const centroid = embedded.centroid?.map((component) => component / MM_PER_UNIT[unit]) as unknown as Vec3 | undefined;
  return {
    target: embedded.target,
    ...(volume === undefined ? {} : { volume }),
    ...(area === undefined ? {} : { area }),
    ...(centroid === undefined ? {} : { centroid }),
    placeholder: embedded.placeholder,
  };
}

const isPart = (imported: ImportedExchange, index: number): boolean => !(imported.products[index]?.assembly ?? false);

interface ProvenanceInput {
  readonly unit: DocumentUnit;
  readonly imported: ImportedExchange;
  readonly placements: ReadonlyMap<number, ProductPlacement>;
  /** Entity ids of each product's solids (all levels), by product index. */
  readonly solidIds: ReadonlyMap<number, readonly string[]>;
  readonly verifications: readonly ProductVerification[] | null;
  readonly summary: Step21Summary;
  readonly policy: GvpPolicy;
  readonly fileName: string | undefined;
  readonly sha256: string;
}

export interface ProvenanceResult {
  readonly provenance: Record<string, ImportProvenance>;
  readonly report: ExchangeReport;
  readonly warnings: readonly GvpWarning[];
  readonly reasons: readonly string[];
}

export function describeProvenance(input: ProvenanceInput): ProvenanceResult {
  const { unit, imported, placements, solidIds, verifications, summary, policy } = input;
  const fileUnit = summary.lengthUnit;
  const sourceUnit: ImportProvenance['sourceUnit'] = fileUnit === null ? 'unknown' : (UNIT_NAMES[fileUnit.name.toLowerCase()] ?? 'unknown');
  const provenance: Record<string, ImportProvenance> = {};
  const warnings: GvpWarning[] = [];
  const reasons = new Set<string>();
  const products: ExchangeReport['products'][number][] = [];
  /** A part nobody compared on its own is covered by the band of the nearest assembly above it that was compared. */
  const parentOf = new Map(imported.occurrences.map((use) => [use.product, use.parent] as const));
  const effectiveBand = (index: number, depth = 0): GvpBand => {
    const own = verifications?.find((entry) => entry.product === index)?.check.band ?? 'not-checkable';
    const parent = parentOf.get(index);
    return own !== 'not-checkable' || parent === undefined || depth > 8 ? own : effectiveBand(parent, depth + 1);
  };
  const childrenOf = new Map<number, number[]>();
  for (const use of imported.occurrences) childrenOf.set(use.parent, [...(childrenOf.get(use.parent) ?? []), use.product]);
  const RANK: Readonly<Record<GvpBand, number>> = { 'not-checkable': 0, green: 1, yellow: 2, red: 3 };
  /** A part: its effective band. An assembly: the worst band of itself and its whole subtree, so a red child makes every ancestor red. */
  const subtreeBand = (index: number, depth = 0): GvpBand => {
    let worst = effectiveBand(index);
    if (isPart(imported, index) || depth > 32) return worst;
    for (const child of childrenOf.get(index) ?? []) {
      const childBand = subtreeBand(child, depth + 1);
      if (RANK[childBand] > RANK[worst]) worst = childBand;
    }
    return worst;
  };
  /** The unverified reasons of a product; an assembly carries those of every part below it. */
  const reasonsOf = (index: number, band: GvpBand, depth = 0): UnverifiedReason[] => {
    if (verifications === null) return ['verify_skipped'];
    if (band === 'red') return ['import_gvp_red'];
    if (isPart(imported, index)) return band === 'not-checkable' ? ['import_gvp_not_checkable'] : [];
    if (depth > 32) return [];
    const inherited = (childrenOf.get(index) ?? []).flatMap((child) => reasonsOf(child, subtreeBand(child), depth + 1));
    return [...new Set(inherited)];
  };
  for (const [index, product] of imported.products.entries()) {
    const verification = verifications?.find((entry) => entry.product === index);
    const placement = placements.get(index);
    const componentId = placement?.componentId;
    const entityIds = placement === undefined ? [] : componentId === undefined ? placement.topLevel : [componentId, ...placement.topLevel];
    const band: GvpBand = subtreeBand(index);
    const unverifiedReasons: UnverifiedReason[] = reasonsOf(index, band);
    products.push({
      index,
      name: product.name,
      assembly: product.assembly,
      ...(componentId === undefined ? {} : { componentId }),
      entityIds: placement?.topLevel ?? [],
      solids: product.solids.length,
      band,
      ...(verification?.embedded === undefined ? {} : { embedded: verification.embedded }),
      ...(verification?.recomputed === undefined ? {} : { recomputed: verification.recomputed }),
      ...(product.pmi === undefined ? {} : { pmi: pmiInUnit(product.pmi, unit) }),
      comparisons: verification?.check.comparisons ?? [],
    });
    if (placement === undefined) continue;
    const record: ImportProvenance = {
      format: 'step',
      schemaName: summary.fileSchema,
      fileName: input.fileName ?? '',
      sha256: input.sha256,
      productName: product.name,
      sourceUnit,
      ...(verification?.embedded === undefined
        ? {}
        : {
            embeddedGvp: [
              inDocumentUnit({ ...verification.embedded, target: product.assembly ? 'assembly' : verification.embedded.target }, unit),
            ],
          }),
      ...(verification === undefined ? {} : { gvpCheck: verification.check }),
      unverified: { value: unverifiedReasons.length > 0, reasons: unverifiedReasons },
    };
    for (const id of entityIds) provenance[id] = record;
    if (isPart(imported, index) && componentId === undefined) for (const id of solidIds.get(index) ?? []) provenance[id] = record;
    if (verifications === null) continue;
    const where = entityIds.length > 0 ? entityIds : [product.name];
    const worst = verification?.check.comparisons
      .filter((entry) => entry.band === band)
      .map((entry) => `${entry.property} delta ${entry.delta.toPrecision(3)}`);
    if (band === 'yellow') {
      reasons.add('import_gvp_yellow');
      warnings.push({
        code: 'XCH_GVP_YELLOW',
        severity: 'warn',
        message: `product '${product.name}': validation properties deviate from the sender's (${worst?.join(', ')})`,
        entityIds: where,
        remediation: 'report the numbers to the owner; continue only if the owner accepts the deviation',
      });
    } else if (band === 'red') {
      reasons.add('import_gvp_red');
      warnings.push({
        code: 'XCH_GVP_RED',
        severity: 'fail',
        message: `product '${product.name}': validation properties disagree with the sender's beyond the yellow limit (${worst?.join(', ')})`,
        entityIds: where,
        remediation: 'do not deliver; a qualified reviewer decides (the import completed and the bodies are marked unverified)',
      });
    } else if (band === 'not-checkable' && isPart(imported, index)) {
      reasons.add('import_gvp_not_checkable');
      warnings.push({
        code: 'XCH_GVP_NOT_CHECKABLE',
        severity: 'warn',
        message: `product '${product.name}': the sender embedded no usable validation property (absent or all zero)`,
        entityIds: where,
        remediation: 'ask the sender for validation properties or proceed with review; the geometry is marked unverified',
      });
    }
  }
  if ((imported.pmiUnmapped ?? 0) > 0) {
    reasons.add('pmi_unmapped');
    warnings.push({
      code: 'XCH_PMI_UNMAPPED',
      severity: 'warn',
      message: `${imported.pmiUnmapped} PMI item(s) in the file name no face of an imported product or an unsupported characteristic`,
      entityIds: [],
      remediation: 'listed for the reviewer; no PMI is silently dropped (the unsupported items stay in the original file)',
    });
  }
  const factors = (['greenRel', 'yellowRel', 'greenCentroidPerDiag', 'yellowCentroidMm'] as const).map((key) => [
    key,
    {
      value: policy[key],
      unit: key === 'yellowCentroidMm' ? 'mm' : key === 'greenCentroidPerDiag' ? 'x bounding-box diagonal' : 'relative',
      source: GVP_POLICY_SOURCES[key],
      defaulted: true,
    },
  ]);
  return {
    provenance,
    report: {
      schemaName: summary.fileSchema,
      fileUnit,
      unitFactor: fileUnit !== null && Number.isFinite(fileUnit.mmPerUnit) ? fileUnit.mmPerUnit : null,
      products,
      pmiUnmapped: imported.pmiUnmapped ?? 0,
      gvpCheck: {
        band: verifications === null ? 'not-checkable' : worstBand(products.filter((entry) => !entry.assembly).map((entry) => entry.band)),
        verified: verifications !== null,
        unit,
      },
      policy: Object.fromEntries(factors) as ExchangeReport['policy'],
    },
    warnings,
    reasons: [...reasons],
  };
}
