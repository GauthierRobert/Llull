/**
 * Built-in well-formedness rules of PMI (TECHNICAL_SPEC §5.5): logical consistency that follows from the data model, not quoted clauses of a
 * standard. Pure over `PmiItem`s, used at command time (first error refuses) and by `check_pmi` (all findings).
 */

import { FORM_CHARACTERISTICS, type GeometricTolerancePmi, type PmiItem } from '../../model/pmi';
import { remediationOf } from './pmiOps';

export interface Finding {
  readonly code: string;
  readonly severity: 'error' | 'warning';
  readonly pmiIds: readonly string[];
  readonly message: string;
  readonly remediation: string;
  readonly paths: readonly string[];
}

export const finding = (
  severity: Finding['severity'],
  code: string,
  pmiIds: readonly string[],
  message: string,
  paths: readonly string[] = [],
): Finding => ({ code, severity, pmiIds, message, remediation: remediationOf(code), paths });

type Items = Readonly<Record<string, PmiItem>>;

/** Entity of the solid a tolerance applies to (its own feature, or the targeted size dimension's). */
export function toleranceEntity(item: GeometricTolerancePmi, items: Items): string | undefined {
  if ('feature' in item.target) return item.target.feature.entityId;
  const target = Object.hasOwn(items, item.target.pmiId) ? items[item.target.pmiId] : undefined;
  return target !== undefined && 'feature' in target ? target.feature.entityId : undefined;
}

/** Surface type the tolerance acts on: the feature's, or that of the targeted size dimension ('plane' for a width). */
function targetSurface(item: GeometricTolerancePmi, items: Items): string | undefined {
  if ('feature' in item.target) return item.target.feature.surface;
  const target = Object.hasOwn(items, item.target.pmiId) ? items[item.target.pmiId] : undefined;
  if (target?.kind !== 'size_dimension') return undefined;
  return target.sizeKind === 'width' ? 'plane' : target.feature.surface;
}

/** Whether the tolerance targets a feature of size: a size dimension, or a cylinder / sphere face set. */
function targetsFeatureOfSize(item: GeometricTolerancePmi, items: Items): boolean {
  if ('feature' in item.target) return item.target.feature.surface === 'cylinder' || item.target.feature.surface === 'sphere';
  return Object.hasOwn(items, item.target.pmiId) && items[item.target.pmiId]?.kind === 'size_dimension';
}

const isProfile = (item: GeometricTolerancePmi): boolean =>
  item.characteristic === 'profile_surface' || item.characteristic === 'profile_line';

/** Identity of what a frame applies to: the same size dimension, or the same solid and face points (derived face indices ignored). */
function targetKey(target: GeometricTolerancePmi['target']): string {
  return 'pmiId' in target ? `pmi:${target.pmiId}` : `${target.feature.entityId}|${JSON.stringify(target.feature.facesNear)}`;
}

/** Whether `lower` lists some of `upper` datums, in the same order. */
function isOrderedSubset(lower: GeometricTolerancePmi['datums'], upper: GeometricTolerancePmi['datums']): boolean {
  let at = 0;
  for (const datum of lower) {
    const found = upper.findIndex((candidate, index) => index >= at && candidate.label === datum.label);
    if (found < 0) return false;
    at = found + 1;
  }
  return true;
}

/** Findings of one geometric tolerance against the other PMI `items` (datums are looked up there; `item` itself need not be in it). */
export function toleranceFindings(item: GeometricTolerancePmi, items: Items): Finding[] {
  const out: Finding[] = [];
  const { zone, datums } = item;
  const error = (code: string, message: string, paths: readonly string[]): number =>
    out.push(finding('error', code, [item.id], message, paths));
  if (!(zone.value > 0)) error('GDT_ZONE_NON_POSITIVE', `zone value ${zone.value} must be > 0`, ['zone.value']);
  if (zone.projectedLength !== undefined && !(zone.projectedLength > 0))
    error('GDT_ZONE_NON_POSITIVE', `projected zone length ${zone.projectedLength} must be > 0`, ['zone.projectedLength']);
  if (zone.unequallyDisposed !== undefined && !(zone.unequallyDisposed >= 0 && zone.unequallyDisposed <= zone.value))
    error('GDT_ZONE_NON_POSITIVE', `unequally disposed value ${zone.unequallyDisposed} must be within [0, ${zone.value}]`, [
      'zone.unequallyDisposed',
    ]);
  if (datums.length > 3) error('GDT_DATUM_TOO_MANY', `${datums.length} datum references (at most 3)`, ['datums']);
  const labels = datums.map((datum) => datum.label);
  if (new Set(labels).size !== labels.length)
    error('GDT_DATUM_REPEATED', `datum references repeat a label (${labels.join(', ')})`, ['datums']);
  if (datums.length > 0 && FORM_CHARACTERISTICS.includes(item.characteristic))
    error('GDT_FORM_WITH_DATUM', `${item.characteristic} is a form tolerance and takes no datum references`, ['datums']);
  const entityId = toleranceEntity(item, items);
  for (const [index, label] of labels.entries()) {
    const defined = Object.values(items).some(
      (other) => other.kind === 'datum_feature' && other.label === label && other.feature.entityId === entityId,
    );
    if (!defined)
      error('GDT_DATUM_UNDEFINED', `datum '${label}' is not defined${entityId === undefined ? '' : ` on '${entityId}'`}`, [
        `datums.${index}.label`,
      ]);
  }
  if (item.materialCondition !== 'RFS' && !targetsFeatureOfSize(item, items))
    error('GDT_MC_ON_NON_FOS', `${item.materialCondition} needs a feature of size target; the target is not one`, ['materialCondition']);
  if (zone.diametral === true && targetSurface(item, items) === 'plane')
    error('GDT_DIAMETRAL_ON_PLANE', 'a diametral zone cannot apply to a planar feature', ['zone.diametral']);
  if ((item.modifiers.includes('all_around') || item.modifiers.includes('all_over')) && !isProfile(item))
    error('GDT_MODIFIER_NOT_APPLICABLE', `all_around / all_over apply to profile tolerances, not ${item.characteristic}`, ['modifiers']);
  const upper = item.compositeOf === undefined ? undefined : items[item.compositeOf];
  if (item.compositeOf !== undefined) {
    const valid =
      upper?.kind === 'geometric_tolerance' &&
      upper.compositeOf === undefined &&
      upper.characteristic === item.characteristic &&
      (item.characteristic === 'position' || isProfile(item)) &&
      targetKey(upper.target) === targetKey(item.target) &&
      item.zone.value < upper.zone.value &&
      isOrderedSubset(item.datums, upper.datums);
    if (!valid)
      error(
        'GDT_COMPOSITE_INVALID',
        `composite lower segment of '${item.compositeOf}' must share its characteristic (position or profile) and target (same solid and facesNear, or the same size dimension), have a zone smaller than the upper one, and reference only datums of the upper frame in the same order`,
        ['compositeOf'],
      );
  }
  return out;
}
