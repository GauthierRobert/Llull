/** add_tpms_lattice and add_strut_lattice: periodic lattice fields (05 IMP 4.2, 5.4, 5.5, 5.6). */

import { defineCommand, vec3, z } from '@core/commands/schema';
import type { CommandResult } from '@core/commands/types';
import { resolveFieldEngine } from '@core/geometry/field/engine';
import type { Vec3 } from '@core/model/types';
import { nextId } from '@lib/id';
import { refuseImplicit } from './codes';
import { isLawProblem, lawBounds } from './lawCheck';
import { type CellMap, type Law, type StrutsNode, type TpmsControl, type TpmsNode, fieldOf } from './model';
import { addNode } from './nodeResult';
import { strutGeometry } from './struts';
import { controlInterval, solveRelativeDensity } from './tpmsControl';

const cellSizeSchema = z
  .union([z.number(), vec3('Cell size per axis [x, y, z].')])
  .describe('Unit-cell size in document units: one number (cubic cell) or [x, y, z]. Every size > 0.');

const lawSchema = z.union([z.number(), z.string()]);

const asVec3 = (cell: number | readonly [number, number, number]): Vec3 => (typeof cell === 'number' ? [cell, cell, cell] : cell);

const badRegion = (doc: Parameters<typeof fieldOf>[0], region: string | undefined): string | undefined =>
  region !== undefined && fieldOf(doc, region) === undefined ? region : undefined;

const MAP_SCHEMA = z
  .discriminatedUnion('kind', [
    z.object({
      kind: z.literal('cylindrical').describe('Wrap the cells around an axis.'),
      origin: vec3('A point on the axis [x, y, z] in document units.'),
      axis: vec3('Axis direction [x, y, z] (non-zero).'),
      cellsAround: z
        .number()
        .describe('Whole cells per full turn (an integer >= 1; a fraction makes the lattice jump at the seam: IMP_MAP_SEAM).'),
      radialCellSize: z.number().describe('Cell size along the radius in document units (> 0). The axial cell size is cellSize[2].'),
    }),
    z.object({
      kind: z.literal('spherical').describe('Wrap the cells around a point: longitude x colatitude x radius.'),
      origin: vec3('Centre of the sphere [x, y, z] in document units.'),
      cellsAround: z.number().describe('Whole cells per turn of longitude (an integer >= 1, else IMP_MAP_SEAM).'),
      cellsPolar: z.number().describe('Whole cells over the half turn of colatitude pole to pole (an integer >= 1, else IMP_MAP_SEAM).'),
      radialCellSize: z.number().describe('Cell size along the radius in document units (> 0).'),
    }),
    z.object({
      kind: z.literal('surface_uv').describe('Follow a NURBS sheet: cells along its (u, v) and its normal.'),
      sheetId: z.string().describe('Id of a nurbs_surface entity (a sheet; trims are honoured).'),
      cellsU: z.number().describe('Cells over the u range of the sheet (> 0; need not be whole, the patch has no seam).'),
      cellsV: z.number().describe('Cells over the v range of the sheet (> 0).'),
      depth: z.number().describe('Cell size along the sheet normal in document units (> 0).'),
      layers: z
        .number()
        .describe('Cells of depth on the side the normal points to (an integer >= 1): the lattice fills 0 <= distance <= layers * depth.'),
    }),
  ])
  .describe(
    'Conformal cell map (replaces origin / rotation). cylindrical: sleeves and tubes. spherical: shells; the cells collapse at the poles (warning IMP_MAP_POLE). surface_uv: a lattice skin on a nurbs_surface sheet, cells along its (u, v) and normal (IMP_MAP_SINGULAR for a degenerate sheet, IMP_MAP_TOO_LARGE for a grid above 600000 nodes, warning IMP_MAP_STRETCH where the cells are stretched more than 2x). A mapped field is approximate, not a distance; normalised walls stay uniform away from the singularities and the stretch.',
  );

type MapParams = z.infer<typeof MAP_SCHEMA>;

/** The first problem of a map request (before the sheet is read), or null. */
function mapProblem(
  doc: Parameters<typeof fieldOf>[0],
  map: MapParams,
  placed: boolean,
): { code: string; message: string; path: string; ids: readonly string[] } | null {
  if (placed)
    return { code: 'IMP_PARAM_CONFLICT', message: 'map replaces origin and rotation: give one or the other', path: 'origin', ids: [] };
  if (map.kind === 'surface_uv') {
    if (![map.cellsU, map.cellsV, map.depth].every((n) => Number.isFinite(n) && n > 0))
      return { code: 'IMP_PARAM_RANGE', message: 'surface_uv needs cellsU, cellsV and depth > 0', path: 'map', ids: [] };
    if (!(Number.isInteger(map.layers) && map.layers >= 1))
      return { code: 'IMP_PARAM_RANGE', message: `layers must be a whole number >= 1 (got ${map.layers})`, path: 'map.layers', ids: [] };
    const sheet = Object.hasOwn(doc.entities, map.sheetId) ? doc.entities[map.sheetId] : undefined;
    if (sheet === undefined)
      return { code: 'IMP_ENTITY_NOT_FOUND', message: `no sheet '${map.sheetId}'`, path: 'map.sheetId', ids: [map.sheetId] };
    return null;
  }
  const wholeCells = map.kind === 'spherical' ? [map.cellsAround, map.cellsPolar] : [map.cellsAround];
  if (!wholeCells.every((n) => Number.isInteger(n) && n >= 1))
    return {
      code: 'IMP_MAP_SEAM',
      message: `cell counts of a ${map.kind} map must be whole numbers >= 1 (got ${wholeCells.join(', ')}): a fraction jumps at the seam`,
      path: 'map.cellsAround',
      ids: [],
    };
  if (!(Number.isFinite(map.radialCellSize) && map.radialCellSize > 0) || (map.kind === 'cylindrical' && Math.hypot(...map.axis) === 0))
    return { code: 'IMP_PARAM_RANGE', message: 'map needs radialCellSize > 0 and (cylindrical) a non-zero axis', path: 'map', ids: [] };
  return null;
}

/**
 * @affects creates 1 tpms node (the infinite lattice field, or its intersection with `region`); data.control is the resolved thickness / level
 * @invariant normalised walls (default) are the stated thickness to first order; a relativeDensity target is solved once (quantile of the sampled cell) and stored as the resolved control next to the target; a field id as thickness / level grades the lattice
 * @invariant field-engine-optional: reads ctx.fieldEngine when present, else the built-in TS engine (no kernel is needed)
 * @failure unknown region / scalar -> IMP_FIELD_NOT_FOUND; two or no controls -> IMP_PARAM_CONFLICT; control (or the range of a graded one) outside its valid interval or density unreachable -> IMP_TPMS_CONTROL_RANGE; cell size <= 0 -> IMP_PARAM_RANGE; fractional cells in a cylindrical / spherical map -> IMP_MAP_SEAM; surface_uv: unknown sheet -> IMP_ENTITY_NOT_FOUND, not a nurbs_surface -> IMP_PARAM_RANGE, degenerate sheet -> IMP_MAP_SINGULAR, grid above 600000 nodes -> IMP_MAP_TOO_LARGE
 */
export const addTpmsLattice = defineCommand({
  name: 'add_tpms_lattice',
  description:
    'Create a triply periodic minimal surface lattice (gyroid, schwarz_p, diamond, neovius, iwp, lidinoid, fischer_koch_s, split_p) as an implicit FIELD. form "sheet" is a wall around the surface F=0, "network" is the solid side {F <= level}. ' +
    'Give EXACTLY ONE control: thickness (sheet wall in document units; with normalize "gradient", the default, the wall is this thickness to first order; with normalize "none" it is the raw half-width t of {|F| <= t} in F units), ' +
    'level (network level in F units, 0 = half of the volume for gyroid / P / diamond / Neovius / Fischer-Koch S) or relativeDensity (0..1 solid fraction of the cell, solved once for you). thickness and level accept a scalar field id (create_scalar_field) to GRADE the lattice. Sheet thickness must be < half the smallest cell. ' +
    'The lattice is infinite: pass region (a bounded field id) to clip it, e.g. a box primitive, or create_implicit_body needs bounds. Next: create_implicit_body, then lattice_properties / check_implicit.',
  params: z.object({
    kind: z
      .enum(['gyroid', 'schwarz_p', 'diamond', 'neovius', 'iwp', 'lidinoid', 'fischer_koch_s', 'split_p'])
      .describe('TPMS family (equations in the llull spec: Schoen, Lidin & Larsson, Fischer & Koch, Al-Ketan & Abu Al-Rub).'),
    cellSize: cellSizeSchema,
    form: z.enum(['sheet', 'network']).describe('sheet: wall of the given thickness around F=0; network: solid {F <= level}.'),
    thickness: lawSchema
      .optional()
      .describe(
        'Sheet control: wall thickness in document units (normalised) or raw half-width in F units (normalize "none"); a number or a scalar field id (graded). Sheet only.',
      ),
    level: lawSchema
      .optional()
      .describe(
        'Network control: level in F units (gyroid |level| < 1.5, P < 3, diamond < 1); 0 gives half the volume; a number or a scalar field id. Network only.',
      ),
    relativeDensity: z.number().optional().describe('Control by target solid fraction of the cell, strictly between 0 and 1.'),
    normalize: z
      .enum(['gradient', 'none'])
      .optional()
      .describe('gradient (default): divide F by its physical gradient so walls have uniform thickness; none: raw F.'),
    origin: vec3('Lattice origin [x, y, z] in document units. Default [0, 0, 0].').optional(),
    rotation: vec3('Lattice Euler XYZ rotation in radians about origin. Default [0, 0, 0].').optional(),
    map: MAP_SCHEMA.optional(),
    region: z.string().optional().describe('Id of a field that clips the lattice (the lattice is kept where that field is negative).'),
    name: z.string().optional().describe('Optional label for the node.'),
  }),
  run: (doc, p, ctx): CommandResult => {
    const fail = (code: string, message: string, path: string, ids: readonly string[] = []): CommandResult =>
      refuseImplicit(doc, 'add_tpms_lattice', code, message, ids, [`params.${path}`]);
    const cellSize = asVec3(p.cellSize);
    if (!cellSize.every((c) => Number.isFinite(c) && c > 0))
      return fail('IMP_PARAM_RANGE', `cellSize must be > 0 on every axis (got ${JSON.stringify(p.cellSize)})`, 'cellSize');
    if (p.map !== undefined) {
      const problem = mapProblem(doc, p.map, p.origin !== undefined || p.rotation !== undefined);
      if (problem !== null) return fail(problem.code, problem.message, problem.path, problem.ids);
    }
    const absent = badRegion(doc, p.region);
    if (absent !== undefined) return fail('IMP_FIELD_NOT_FOUND', `no region field '${absent}'`, 'region', [absent]);
    const given = [p.thickness, p.level, p.relativeDensity].filter((v) => v !== undefined).length;
    if (given !== 1) return fail('IMP_PARAM_CONFLICT', `give exactly one of thickness, level, relativeDensity (got ${given})`, 'thickness');
    if (p.form === 'sheet' && p.level !== undefined)
      return fail('IMP_PARAM_CONFLICT', 'a sheet is controlled by thickness (or relativeDensity), not level', 'level');
    if (p.form === 'network' && p.thickness !== undefined)
      return fail('IMP_PARAM_CONFLICT', 'a network is controlled by level (or relativeDensity), not thickness', 'thickness');
    const request = { kind: p.kind, cellSize, form: p.form, normalize: p.normalize ?? 'gradient' } as const;
    const interval = controlInterval(request);
    let control: TpmsControl;
    if (p.relativeDensity !== undefined) {
      if (p.map !== undefined)
        return fail(
          'IMP_PARAM_CONFLICT',
          'relativeDensity is solved on a rectangular cell and is not valid for a mapped (wrapped) lattice: give thickness or level',
          'relativeDensity',
        );
      if (!(p.relativeDensity > 0 && p.relativeDensity < 1))
        return fail(
          'IMP_TPMS_CONTROL_RANGE',
          `relativeDensity must be strictly between 0 and 1 (got ${p.relativeDensity})`,
          'relativeDensity',
        );
      const solved = solveRelativeDensity(request, p.relativeDensity, resolveFieldEngine(ctx?.fieldEngine));
      if (typeof solved === 'string') return fail('IMP_TPMS_CONTROL_RANGE', solved, 'relativeDensity');
      control = solved;
    } else {
      const value: Law = (p.thickness ?? p.level) as Law;
      const range = lawBounds(doc, value);
      if (isLawProblem(range)) return fail(range.code, range.message, interval.name, range.ids);
      const inside = (v: number): boolean =>
        interval.name === 'thickness' ? v > interval.low && v < interval.high : Math.abs(v) < interval.high;
      if ((Number.isFinite(range.lo) && !inside(range.lo)) || (Number.isFinite(range.hi) && !inside(range.hi)))
        return fail(
          'IMP_TPMS_CONTROL_RANGE',
          `${interval.name} ${typeof value === 'number' ? value : `of '${value}' (range ${range.lo}..${range.hi})`} is outside the valid interval (${interval.low}, ${interval.high})`,
          interval.name,
        );
      control = { kind: interval.name, value };
    }
    const node: TpmsNode = {
      id: nextId('fld'),
      op: 'tpms',
      kind: p.kind,
      cellSize,
      origin: p.origin ?? [0, 0, 0],
      rotation: p.rotation ?? [0, 0, 0],
      form: p.form,
      control,
      ...(p.relativeDensity === undefined ? {} : { relativeDensityTarget: p.relativeDensity }),
      normalize: request.normalize,
      ...(p.map === undefined ? {} : { map: p.map as CellMap }),
      ...(p.region === undefined ? {} : { region: p.region }),
      ...(p.name === undefined ? {} : { name: p.name }),
    };
    return addNode(doc, 'add_tpms_lattice', node, `${p.kind} ${p.form}, cell ${cellSize.join('x')}, ${control.kind} ${control.value}`, {
      control: {
        ...control,
        normalized: request.normalize === 'gradient',
        graded: typeof control.value === 'string',
        ...(p.relativeDensity === undefined ? {} : { relativeDensityTarget: p.relativeDensity }),
      },
    });
  },
});

/**
 * @affects creates 1 struts node (periodic beams, clipped by `region` when given)
 * @invariant struts are cylinders with spherical end caps along the cell's bonds; every node lies on a continuing strut, so node balls add nothing unless nodeRadius > radius; a field id as radius grades the lattice (the radius is read at the sample point)
 * @failure unknown region / scalar -> IMP_FIELD_NOT_FOUND; radius <= 0 -> IMP_STRUT_RADIUS_RANGE; 2 * radius >= the shortest strut length (also of the range of a graded radius) -> IMP_STRUT_RADIUS_RANGE
 */
export const addStrutLattice = defineCommand({
  name: 'add_strut_lattice',
  description:
    'Create a periodic strut (beam) lattice as an implicit FIELD: cubic (3 edges per cell), bcc (8 half body diagonals), fcc (6 face diagonals), octet (24 bonds, stretch-dominated), diamond (diamond cubic, 16 bonds), kelvin (bitruncated cubic honeycomb, 24 bonds), ' +
    'bccz (bcc + vertical z edges), fccz (fcc + vertical z edges) or reentrant (auxetic: corner nodes + six face nodes pushed a quarter cell inward, 24 struts). ' +
    'Struts are round with the given radius (a number, or a scalar field id to grade it: create_scalar_field); the radius must stay below half the shortest strut. Pass region (a bounded field id, e.g. a box primitive) to clip the lattice to a body. ' +
    'Next: create_implicit_body for a mesh, lattice_properties for strut counts, length, relative density and the Maxwell count, export_3mf beamLattice for a slicer-native beam file.',
  params: z.object({
    cell: z.enum(['cubic', 'bcc', 'fcc', 'octet', 'kelvin', 'diamond', 'bccz', 'fccz', 'reentrant']).describe('Unit cell type.'),
    cellSize: cellSizeSchema,
    radius: lawSchema.describe(
      'Strut radius in document units: a number (> 0, and 2 * radius < the shortest strut length of the cell) or a scalar field id (graded; its range must satisfy the same bound where known).',
    ),
    nodeRadius: z
      .number()
      .optional()
      .describe('Optional ball radius at every node in document units; only larger than radius has an effect (constant radius only).'),
    origin: vec3('Lattice origin [x, y, z] (a lattice node) in document units. Default [0, 0, 0].').optional(),
    rotation: vec3('Lattice Euler XYZ rotation in radians about origin. Default [0, 0, 0].').optional(),
    map: MAP_SCHEMA.optional().describe(
      'Conformal cell map (replaces origin / rotation): the periodic cell is laid on the cells of a cylindrical, spherical or surface_uv map (cell sizes as cellSize, the map as described for add_tpms_lattice). A mapped strut lattice is approximate, not a distance: the strut distance is divided by the mean local stretch of the map.',
    ),
    region: z.string().optional().describe('Id of a field that clips the lattice (kept where that field is negative).'),
    name: z.string().optional().describe('Optional label for the node.'),
  }),
  run: (doc, p): CommandResult => {
    const fail = (code: string, message: string, path: string, ids: readonly string[] = []): CommandResult =>
      refuseImplicit(doc, 'add_strut_lattice', code, message, ids, [`params.${path}`]);
    const cellSize = asVec3(p.cellSize);
    if (!cellSize.every((c) => Number.isFinite(c) && c > 0))
      return fail('IMP_PARAM_RANGE', `cellSize must be > 0 on every axis (got ${JSON.stringify(p.cellSize)})`, 'cellSize');
    if (p.map !== undefined) {
      const problem = mapProblem(doc, p.map, p.origin !== undefined || p.rotation !== undefined);
      if (problem !== null) return fail(problem.code, problem.message, problem.path, problem.ids);
    }
    const absent = badRegion(doc, p.region);
    if (absent !== undefined) return fail('IMP_FIELD_NOT_FOUND', `no region field '${absent}'`, 'region', [absent]);
    const range = lawBounds(doc, p.radius);
    if (isLawProblem(range)) return fail(range.code, range.message, 'radius', range.ids);
    if (typeof p.radius === 'number' && !(Number.isFinite(p.radius) && p.radius > 0))
      return fail('IMP_STRUT_RADIUS_RANGE', `radius must be > 0 (got ${p.radius})`, 'radius');
    if (typeof p.radius === 'string' && p.nodeRadius !== undefined)
      return fail('IMP_PARAM_CONFLICT', 'nodeRadius applies to a constant radius only', 'nodeRadius');
    const shortest = Math.min(...strutGeometry(p.cell, cellSize, Number.isFinite(range.hi) ? range.hi : 1e-6, undefined).lengths);
    if (Number.isFinite(range.hi) && 2 * range.hi >= shortest)
      return fail(
        'IMP_STRUT_RADIUS_RANGE',
        `2 * radius (${2 * range.hi}) must stay below the shortest strut length ${shortest} of a ${p.cell} cell`,
        'radius',
      );
    const node: StrutsNode = {
      id: nextId('fld'),
      op: 'struts',
      cell: p.cell,
      cellSize,
      origin: p.origin ?? [0, 0, 0],
      rotation: p.rotation ?? [0, 0, 0],
      radius: p.radius,
      ...(p.nodeRadius === undefined ? {} : { nodeRadius: p.nodeRadius }),
      ...(p.map === undefined ? {} : { map: p.map }),
      ...(p.region === undefined ? {} : { region: p.region }),
      ...(p.name === undefined ? {} : { name: p.name }),
    };
    return addNode(doc, 'add_strut_lattice', node, `${p.cell} strut lattice, cell ${cellSize.join('x')}, radius ${p.radius}`, {
      shortestStrut: shortest,
      radiusGraded: typeof p.radius === 'string',
    });
  },
});
