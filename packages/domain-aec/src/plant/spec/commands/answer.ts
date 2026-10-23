/** Shared pieces of the spec commands: loading a spec revision with its catalogues, and the `data` / summary of a resolved component. */

import { refuse } from '../../catalog/codes';
import { flatKeys } from '../../catalog/lookup';
import type { CadDocument } from '@core/model/types';
import type { CommandResult } from '@core/commands/types';
import type { PipingCatalog } from '../../catalog/types';
import type { ResolvedComponent } from '../resolve';
import { sizeLabel } from '../size';
import { findSpec, getSpecModel, specCatalogs } from '../store';
import type { PipeSpec } from '../types';

export interface LoadedSpec {
  readonly spec: PipeSpec;
  readonly catalogs: readonly PipingCatalog[];
}

/** The spec revision (newest when omitted) and its catalogues, or the coded refusal (PSC_SPEC_UNKNOWN / PSC_CATALOG_UNKNOWN). */
export function loadSpec(
  doc: CadDocument,
  command: string,
  specId: string,
  revision: number | undefined,
  requireCatalogs = true,
): LoadedSpec | CommandResult {
  const spec = findSpec(doc, specId, revision);
  if (spec === undefined) {
    const known = getSpecModel(doc).specOrder;
    return refuse(
      doc,
      command,
      'PSC_SPEC_UNKNOWN',
      `no spec "${specId}"${revision === undefined ? '' : ` revision ${revision}`} (specs in this document: ${known.join(', ') || 'none'})`,
      [specId],
      ['specId'],
    );
  }
  const found = specCatalogs(doc, spec);
  if (requireCatalogs && found.missing.length > 0)
    return refuse(
      doc,
      command,
      'PSC_CATALOG_UNKNOWN',
      `spec ${spec.id} searches catalogue(s) ${found.missing.join(', ')}, which are neither bundled nor imported`,
      [...found.missing],
      ['catalogs'],
    );
  return { spec, catalogs: found.catalogs };
}

export const isLoaded = (value: LoadedSpec | CommandResult): value is LoadedSpec => 'spec' in value;

/** `data` of a resolved component: selection, schedule, wall, dimensions (flat `<dim>Mm` keys and the full dims), trust and source. */
export function componentData(spec: PipeSpec, resolved: ResolvedComponent): Record<string, unknown> {
  const { component, row } = resolved;
  const warnings: Array<Record<string, unknown>> = [];
  if (!resolved.verified)
    warnings.push({
      code: 'PSC_DATA_UNVERIFIED',
      dims: resolved.unverifiedDims,
      ...(resolved.unresolved === undefined ? {} : { reason: resolved.unresolved }),
    });
  if (resolved.unresolved !== undefined) warnings.push({ code: 'PSC_CATALOG_ROW_MISSING', reason: resolved.unresolved });
  return {
    specId: spec.id,
    revision: spec.revision,
    specStatus: spec.status,
    dimensionalStandard: resolved.dimensionalStandard ?? spec.dimensionalStandard,
    componentId: component.id,
    type: component.type,
    catalogRef: component.catalogRef,
    ...(component.ends === undefined ? {} : { ends: component.ends }),
    ...(component.radius === undefined ? {} : { radius: component.radius }),
    ...(component.class === undefined ? {} : { class: component.class }),
    ...(component.pn === undefined ? {} : { pn: component.pn }),
    ...(component.facing === undefined ? {} : { facing: component.facing }),
    size: resolved.size,
    ...(resolved.size.system === 'NPS' ? { nps: resolved.size.key } : { dn: resolved.size.value }),
    ...(resolved.branchSize === undefined ? {} : { branchSize: resolved.branchSize }),
    ...flatKeys(resolved),
    ...(resolved.schedule === undefined ? {} : { schedule: resolved.schedule }),
    ...(resolved.wallMm === undefined ? {} : { wallMm: resolved.wallMm }),
    ...(resolved.outsideDiameterMm === undefined ? {} : { outsideDiameterMm: resolved.outsideDiameterMm }),
    dims: resolved.dims,
    ...(component.commodityCode === undefined ? {} : { commodityCode: component.commodityCode }),
    ...(component.description === undefined ? {} : { description: component.description }),
    ...(component.material === undefined ? {} : { material: component.material }),
    ...(row === null
      ? {}
      : { catalogId: row.catalogId, catalogVersion: row.catalogVersion, familyId: row.familyId, standard: row.standard }),
    ...(row?.note === undefined ? {} : { note: row.note }),
    ...(resolved.pipe === undefined ? {} : { pipe: resolved.pipe }),
    verified: resolved.verified,
    unverifiedDims: resolved.unverifiedDims,
    ...(warnings.length === 0 ? {} : { warnings }),
  };
}

/** One-line description of a resolved component for a summary. */
export function componentLine(resolved: ResolvedComponent): string {
  const { component } = resolved;
  const dims = Object.entries(resolved.dims)
    .filter(([, dim]) => dim.unit === 'mm')
    .slice(0, 4)
    .map(([name, dim]) => `${name} ${dim.value}`)
    .join(', ');
  return `${component.id} (${component.type}, ${sizeLabel(resolved.size)}${resolved.schedule === undefined ? '' : `, sch ${resolved.schedule}`}${resolved.wallMm === undefined ? '' : `, wall ${resolved.wallMm} mm`})${dims === '' ? '' : ` ${dims} mm`}; ${resolved.verified ? 'verified' : 'UNVERIFIED (PSC_DATA_UNVERIFIED)'}`;
}
