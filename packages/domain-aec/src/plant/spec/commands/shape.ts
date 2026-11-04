/** `component_shape` (plant 01 PSC M4): the shape recipe, analytic bounds and ports of a catalogue or spec component. */

import { defineCommand, z } from '@core/commands/schema';
import { report } from '@core/commands/noop';
import type { CommandResult } from '@core/commands/types';
import { BUNDLED_CATALOG_ID } from '../../catalog/bundled';
import { refuse } from '../../catalog/codes';
import { resolveCatalogRow, type ResolvedDim, type ResolvedRow } from '../../catalog/lookup';
import { dnToNps, en10220OutsideDiameter, npsToDn, sizePair } from '../../catalog/nominal';
import { buildShape } from '../../catalog/shapes/build';
import type { ShapeSource } from '../../catalog/shapes/shared';
import { allCatalogs, findCatalog } from '../../catalog/store';
import {
  BEND_RADII,
  COMPONENT_TYPES,
  END_TYPES,
  FACINGS,
  type BendRadius,
  type ComponentType,
  type DimensionalStandard,
  type NominalSize,
  type PipingCatalog,
} from '../../catalog/types';
import { resolveChosen, resolveComponent, type ResolvedComponent } from '../resolve';
import { inRange, querySize } from '../size';
import { isLoaded, loadSpec } from './answer';

const nominalParam = z.union([z.number(), z.string()]);
const sizeQuery = (size: NominalSize): { nps?: string; dn?: string } => (size.system === 'NPS' ? { nps: size.key } : { dn: size.key });

/** Pipe outside diameter (mm) at `size` in the dimensional standard: the catalogue's pipe rows (ASME) or the EN 10220 series. */
function pipeOd(catalogs: readonly PipingCatalog[], standard: DimensionalStandard, size: NominalSize): number | undefined {
  const pair = sizePair(size.system === 'NPS' ? { nps: size.key } : { dn: size.key });
  if (pair === null) return undefined;
  if (standard === 'EN') {
    const dn = pair.dn ?? (pair.nps === null ? null : npsToDn(pair.nps));
    return dn === null ? undefined : (en10220OutsideDiameter(dn) ?? undefined);
  }
  const nps = pair.nps ?? (pair.dn === null ? null : dnToNps(pair.dn));
  if (nps === null) return undefined;
  for (const catalog of catalogs)
    for (const family of catalog.families)
      if (family.type === 'pipe' && family.dimensionalStandard === standard) {
        const od = family.sizes.find((row) => row.size.system === 'NPS' && row.size.key === nps.key)?.dims['outsideDiameter'];
        if (od !== undefined) return od.value;
      }
  return undefined;
}

const numbers = (dims: Readonly<Record<string, ResolvedDim>>): Record<string, number> =>
  Object.fromEntries(Object.entries(dims).map(([name, dim]) => [name, dim.value]));

interface Origin {
  readonly dims: Readonly<Record<string, ResolvedDim>>;
  readonly type: ComponentType;
  readonly size: NominalSize;
  readonly branchSize?: NominalSize | undefined;
  readonly row: ResolvedRow | null;
  readonly radius?: BendRadius | undefined;
  readonly ratingClass?: number | undefined;
  readonly facing?: string | undefined;
  readonly wallMm?: number | undefined;
  readonly verified: boolean;
  readonly unverifiedDims: readonly string[];
  readonly unresolved?: string | undefined;
  readonly label: string;
  readonly componentId?: string | undefined;
}

function fromResolved(resolved: ResolvedComponent): Origin {
  return {
    dims: resolved.dims,
    type: resolved.component.type,
    size: resolved.size,
    branchSize: resolved.branchSize,
    row: resolved.row,
    radius: resolved.component.radius ?? resolved.row?.radius,
    ratingClass: resolved.row?.class ?? resolved.component.class,
    facing: resolved.row?.facing ?? resolved.component.facing,
    wallMm: resolved.wallMm,
    verified: resolved.verified,
    unverifiedDims: resolved.unverifiedDims,
    unresolved: resolved.unresolved,
    label: `spec component ${resolved.component.id}`,
    componentId: resolved.component.id,
  };
}

function fromRow(row: ResolvedRow, wallMm: number | undefined): Origin {
  return {
    dims: row.dims,
    type: row.type,
    size: row.size,
    branchSize: row.smallSize,
    row,
    radius: row.radius,
    ratingClass: row.class,
    facing: row.facing,
    wallMm: wallMm ?? row.dims['wall']?.value,
    verified: row.verified,
    unverifiedDims: row.unverifiedDims,
    label: `catalogue row ${row.familyId}`,
  };
}

/** The flange outside diameter a valve envelope needs: the weld-neck flange of the same size and class. */
function flangeOd(catalogs: readonly PipingCatalog[], origin: Origin): number | undefined {
  for (const catalog of catalogs) {
    const outcome = resolveCatalogRow(catalog, {
      type: 'flangeWeldNeck',
      ...sizeQuery(origin.size),
      class: origin.ratingClass,
      facing: origin.row?.facing,
    });
    const od = outcome.ok ? outcome.row.dims['outsideDiameter']?.value : undefined;
    if (od !== undefined) return od;
  }
  return undefined;
}

/**
 * @affects none; data = { type, recipe, bounds: { min, max, size }, ports: [{ id, position, direction, outsideDiameterMm, endType }], hollow, notes, frame, stats, source, verified }
 * @invariant read-only; the recipe is analytic (revolution solids and booleans) in the component's local frame, bounds are exact for it, ports are outward unit directions; a missing dimension is a refusal, an omitted detail is named in notes
 * @failure unknown spec / catalogue -> PSC_SPEC_UNKNOWN / PSC_CATALOG_UNKNOWN; no component or row -> PSC_NO_COMPONENT / PSC_CATALOG_ROW_MISSING; type without a recipe (bolt set, ring-joint gasket ...) -> PSC_SHAPE_UNSUPPORTED; inconsistent row (bend shorter than its tangent) -> PSC_CATALOG_DIM_MISMATCH
 */
export const componentShape = defineCommand({
  name: 'component_shape',
  description:
    'Shape of one piping component for the 3D builders and routers: an analytic shape recipe (revolution solids and booleans, millimetres, local frame), its exact bounds and its connection ports (position, outward direction, outside diameter, end type). ' +
    'Pick the component from a spec (specId + componentId or type, at nps / dn; branchNps for reducing tees, olets, reducers) or from a catalogue (catalogId, default llull-open-piping, with type, nps / dn and the row keys schedule, class, facing, radius). ' +
    'Supported: pipe (lengthMm), elbow90 / elbow45 (torus segment, bend radius from the row, straight ends when the tabulated centre-to-end exceeds R tan(theta/2); extent of a 90 degree LR NPS 6 elbow: 312.75 x 312.75 x 168.3 mm), tee, reducingTee, reducerConcentric, swage (as a concentric reducer; needs length), reducerEccentric (oblique frustum, ruled loft; flat side +X, small end axis shifted (D - d) / 2), cap (closed end drawn flat; needs length), coupling / union (body bodyOd x length, drawn solid), ' +
    'flanges (disc, raised face, optional hub, bolt holes straddling the axes), gaskets (annulus), valves (envelope box face-to-face by flange diameter), weldolet / sockolet / threadolet (branch body). The wall (spec pipe wall, or wallMm) makes tubes hollow; otherwise the shape is solid and says so. ' +
    'Refuses types without a recipe (bolt sets, ring-joint gaskets: PSC_SHAPE_UNSUPPORTED) and rows missing a needed dimension (PSC_CATALOG_ROW_MISSING; caps, couplings, unions and swages exist only in imported catalogues: the bundled one has no sourced rows for them). The solid is built by the caller through the geometry kernel. Next: resolve_joint for the parts of a joint, the routing commands insert these shapes.',
  params: z.object({
    specId: z.string().describe('Spec id: pick the component from this spec (list_pipe_specs). Omit to pick from a catalogue.').optional(),
    revision: z.number().int().positive().describe('Spec revision. Default: the newest.').optional(),
    componentId: z.string().describe('Spec component id (resolve_spec_component componentId); alternative to type with specId.').optional(),
    catalogId: z.string().describe('Catalogue id for the catalogue mode. Default: the bundled llull-open-piping.').optional(),
    type: z
      .enum(COMPONENT_TYPES)
      .describe('Component type (elbow90, tee, flangeWeldNeck ...). Needed unless componentId is given.')
      .optional(),
    nps: nominalParam.describe('Nominal size, inch designation ("6", "2-1/2") or number. Give nps or dn.').optional(),
    dn: nominalParam.describe('Nominal size as DN.').optional(),
    branchNps: nominalParam.describe('Branch / small-end NPS (reducing tee, olet, reducer).').optional(),
    branchDn: nominalParam.describe('Branch / small-end DN.').optional(),
    schedule: z.string().describe('Catalogue mode: pipe schedule row key.').optional(),
    class: z.number().int().positive().describe('Pressure class row key / filter (150, 3000 ...).').optional(),
    pn: z.number().positive().describe('EN PN row key / filter.').optional(),
    facing: z.enum(FACINGS).describe('Flange facing row key / filter.').optional(),
    radius: z.enum(BEND_RADII).describe('Elbow bend radius filter (LR, SR ...).').optional(),
    ends: z.enum(END_TYPES).describe('End type filter.').optional(),
    standard: z.string().describe('Catalogue mode: standard text filter (e.g. "B16.9").').optional(),
    lengthMm: z.number().positive().describe('Pipe length in mm (type pipe only).').optional(),
    wallMm: z.number().positive().describe('Pipe wall in mm to hollow the shape when the spec / row gives none.').optional(),
  }),
  annotations: { readOnly: true, idempotent: true },
  run: (doc, params): CommandResult => {
    const fail = (code: string, message: string, ids: readonly string[] = [], paths: readonly string[] = []): CommandResult =>
      refuse(doc, 'component_shape', code, message, ids, paths);
    const { specId, revision, componentId, catalogId, type, wallMm, lengthMm, schedule, standard, ...query } = params;
    let origin: Origin;
    let catalogs: readonly PipingCatalog[];
    let dimensionalStandard: DimensionalStandard;
    if (specId !== undefined) {
      const loaded = loadSpec(doc, 'component_shape', specId, revision);
      if (!isLoaded(loaded)) return loaded;
      catalogs = loaded.catalogs;
      dimensionalStandard = loaded.spec.dimensionalStandard;
      if (componentId === undefined && type === undefined)
        return fail('PSC_NO_COMPONENT', 'give componentId or type with specId', [], ['componentId']);
      const component = componentId === undefined ? undefined : loaded.spec.components.find((candidate) => candidate.id === componentId);
      if (componentId !== undefined && component === undefined)
        return fail('PSC_NO_COMPONENT', `spec ${specId} has no component "${componentId}"`, [specId], ['componentId']);
      if (component !== undefined && type !== undefined && component.type !== type)
        return fail('PSC_NO_COMPONENT', `component ${component.id} is a ${component.type}, not a ${type}`, [component.id], ['type']);
      const size = querySize({ nps: query.nps, dn: query.dn });
      const branch =
        query.branchNps !== undefined || query.branchDn !== undefined ? querySize({ nps: query.branchNps, dn: query.branchDn }) : undefined;
      if (size === null || branch === null)
        return fail('PSC_SIZE_UNKNOWN', 'nps / dn (and branchNps / branchDn) must be nominal sizes', [], ['nps']);
      if (component !== undefined && !inRange(size, component.from, component.to))
        return fail('PSC_SIZE_OUT_OF_RANGE', `component ${component.id} does not cover this size`, [component.id], ['nps']);
      const resolved =
        component === undefined
          ? resolveComponent(loaded.spec, loaded.catalogs, { ...query, type: type as ComponentType })
          : resolveChosen(loaded.spec, loaded.catalogs, component, size, branch, { ...query, type: component.type });
      if (!resolved.ok) return fail(resolved.code, resolved.message, resolved.ids, resolved.paths);
      origin = fromResolved(resolved.resolved);
      if (wallMm !== undefined) origin = { ...origin, wallMm };
    } else {
      if (type === undefined) return fail('PSC_NO_COMPONENT', 'give type (catalogue mode) or specId with componentId', [], ['type']);
      const reference = catalogId ?? BUNDLED_CATALOG_ID;
      const catalog = findCatalog(doc, reference);
      if (catalog === undefined) return fail('PSC_CATALOG_UNKNOWN', `no catalogue "${reference}"`, [reference], ['catalogId']);
      catalogs = allCatalogs(doc);
      const outcome = resolveCatalogRow(catalog, {
        type,
        nps: query.nps,
        dn: query.dn,
        smallNps: query.branchNps,
        smallDn: query.branchDn,
        schedule,
        standard,
        class: query.class,
        pn: query.pn,
        facing: query.facing,
        radius: query.radius,
        ends: query.ends,
      });
      if (!outcome.ok) return fail(outcome.code, outcome.message, outcome.ids, ['type']);
      origin = fromRow(outcome.row, wallMm);
      dimensionalStandard = outcome.row.dimensionalStandard;
    }
    const nps = sizePair(sizeQuery(origin.size))?.nps ?? null;
    const source: ShapeSource = {
      type: origin.type,
      standard: origin.row?.standard ?? '',
      npsValue: nps?.value ?? null,
      dims: numbers(origin.dims),
      pipeOdMm: pipeOd(catalogs, dimensionalStandard, origin.size),
      smallPipeOdMm: origin.branchSize === undefined ? undefined : pipeOd(catalogs, dimensionalStandard, origin.branchSize),
      wallMm: origin.wallMm,
      radius: origin.radius,
      ratingClass: origin.ratingClass,
      facing: origin.facing,
      lengthMm,
      flangeOdMm: origin.type.startsWith('valve') ? flangeOd(catalogs, origin) : undefined,
    };
    const built = buildShape(source);
    const ids = origin.componentId === undefined ? [] : [origin.componentId];
    if (!built.ok && built.code === 'PSC_CATALOG_ROW_MISSING' && origin.unresolved !== undefined)
      return fail('PSC_CATALOG_FAMILY_MISSING', origin.unresolved, ids, ['catalogs']);
    if (!built.ok) return fail(built.code, built.message, ids, ['type']);
    const { shape } = built;
    const size = shape.bounds.max.map((high, axis) => high - (shape.bounds.min[axis] as number));
    const warnings = origin.verified
      ? []
      : [
          {
            code: 'PSC_DATA_UNVERIFIED',
            dims: origin.unverifiedDims,
            ...(origin.unresolved === undefined ? {} : { reason: origin.unresolved }),
          },
        ];
    const fmt = (value: number): string => value.toFixed(2);
    return report(
      doc,
      `component_shape: ${origin.type} ${origin.label} (${origin.size.system} ${origin.size.key}): ${shape.stats.leaves} solid(s), ${shape.stats.booleans} boolean(s), bounds ${size.map(fmt).join(' x ')} mm, ${shape.ports.length} port(s)${shape.hollow ? ', hollow' : ', solid'}${origin.verified ? '' : '; UNVERIFIED (PSC_DATA_UNVERIFIED)'}${shape.notes.length === 0 ? '' : `; ${shape.notes.join('; ')}`}.`,
      {
        type: origin.type,
        ...(origin.componentId === undefined ? {} : { componentId: origin.componentId }),
        size: origin.size,
        ...(origin.branchSize === undefined ? {} : { branchSize: origin.branchSize }),
        recipe: shape.recipe,
        bounds: { min: shape.bounds.min, max: shape.bounds.max, size },
        ports: shape.ports,
        hollow: shape.hollow,
        notes: shape.notes,
        frame: shape.frame,
        stats: shape.stats,
        source: {
          dims: source.dims,
          ...(source.pipeOdMm === undefined ? {} : { pipeOdMm: source.pipeOdMm }),
          ...(source.wallMm === undefined ? {} : { wallMm: source.wallMm }),
          ...(origin.row === null ? {} : { catalogId: origin.row.catalogId, familyId: origin.row.familyId, standard: origin.row.standard }),
        },
        verified: origin.verified,
        ...(warnings.length === 0 ? {} : { warnings }),
      },
    );
  },
});
