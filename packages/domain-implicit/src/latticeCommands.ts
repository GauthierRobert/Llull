/** add_tpms_lattice and add_strut_lattice: periodic lattice fields (05 IMP 4.2, 5.4, 5.5). */

import { defineCommand, vec3, z } from '@core/commands/schema';
import type { CommandResult } from '@core/commands/types';
import { resolveFieldEngine } from '@core/geometry/field/engine';
import type { Vec3 } from '@core/model/types';
import { nextId } from '@lib/id';
import { refuseImplicit } from './codes';
import { fieldOf, type StrutsNode, type TpmsControl, type TpmsNode } from './model';
import { addNode } from './nodeResult';
import { strutGeometry } from './struts';
import { controlInterval, solveRelativeDensity } from './tpmsControl';

const cellSizeSchema = z
  .union([z.number(), vec3('Cell size per axis [x, y, z].')])
  .describe('Unit-cell size in document units: one number (cubic cell) or [x, y, z]. Every size > 0.');

const asVec3 = (cell: number | readonly [number, number, number]): Vec3 => (typeof cell === 'number' ? [cell, cell, cell] : cell);

const badRegion = (doc: Parameters<typeof fieldOf>[0], region: string | undefined): string | undefined =>
  region !== undefined && fieldOf(doc, region) === undefined ? region : undefined;

/**
 * @affects creates 1 tpms node (the infinite lattice field, or its intersection with `region`); data.control is the resolved thickness / level
 * @invariant normalised walls (default) are the stated thickness to first order; a relativeDensity target is solved once (quantile of the sampled cell) and stored as the resolved control next to the target
 * @invariant field-engine-optional: reads ctx.fieldEngine when present, else the built-in TS engine (no kernel is needed)
 * @failure unknown region -> IMP_FIELD_NOT_FOUND; two or no controls -> IMP_PARAM_CONFLICT; control outside its valid interval or density unreachable -> IMP_TPMS_CONTROL_RANGE; cell size <= 0 -> IMP_PARAM_RANGE
 */
export const addTpmsLattice = defineCommand({
  name: 'add_tpms_lattice',
  description:
    'Create a triply periodic minimal surface lattice (gyroid, Schwarz P, diamond) as an implicit FIELD. form "sheet" is a wall around the surface F=0, "network" is the solid side {F <= level}. ' +
    'Give EXACTLY ONE control: thickness (sheet wall in document units; with normalize "gradient", the default, the wall is this thickness to first order; with normalize "none" it is the raw half-width t of {|F| <= t} in F units), ' +
    'level (network level in F units, 0 = half of the volume) or relativeDensity (0..1 solid fraction of the cell, solved once for you). Sheet thickness must be < half the smallest cell. ' +
    'The lattice is infinite: pass region (a bounded field id) to clip it, e.g. a box primitive, or create_implicit_body needs bounds. Next: create_implicit_body, then lattice_properties / check_implicit.',
  params: z.object({
    kind: z.enum(['gyroid', 'schwarz_p', 'diamond']).describe('TPMS family.'),
    cellSize: cellSizeSchema,
    form: z.enum(['sheet', 'network']).describe('sheet: wall of the given thickness around F=0; network: solid {F <= level}.'),
    thickness: z
      .number()
      .optional()
      .describe(
        'Sheet control: wall thickness in document units (normalised) or raw half-width in F units (normalize "none"). Sheet only.',
      ),
    level: z
      .number()
      .optional()
      .describe('Network control: level in F units (gyroid |level| < 1.5, P < 3, diamond < 1); 0 gives half the volume. Network only.'),
    relativeDensity: z.number().optional().describe('Control by target solid fraction of the cell, strictly between 0 and 1.'),
    normalize: z
      .enum(['gradient', 'none'])
      .optional()
      .describe('gradient (default): divide F by its physical gradient so walls have uniform thickness; none: raw F.'),
    origin: vec3('Lattice origin [x, y, z] in document units. Default [0, 0, 0].').optional(),
    rotation: vec3('Lattice Euler XYZ rotation in radians about origin. Default [0, 0, 0].').optional(),
    map: z
      .object({
        kind: z.literal('cylindrical').describe('Wrap the cells around an axis.'),
        origin: vec3('A point on the axis [x, y, z] in document units.'),
        axis: vec3('Axis direction [x, y, z] (non-zero).'),
        cellsAround: z
          .number()
          .describe('Whole cells per full turn (an integer >= 1; a fraction makes the lattice jump at the seam: IMP_MAP_SEAM).'),
        radialCellSize: z.number().describe('Cell size along the radius in document units (> 0). The axial cell size is cellSize[2].'),
      })
      .optional()
      .describe('Conformal cylindrical cell map for sleeves and tubes; replaces origin / rotation. Normalised walls stay uniform.'),
    region: z.string().optional().describe('Id of a field that clips the lattice (the lattice is kept where that field is negative).'),
    name: z.string().optional().describe('Optional label for the node.'),
  }),
  run: (doc, p, ctx): CommandResult => {
    const fail = (code: string, message: string, path: string): CommandResult =>
      refuseImplicit(doc, 'add_tpms_lattice', code, message, [], [`params.${path}`]);
    const cellSize = asVec3(p.cellSize);
    if (!cellSize.every((c) => Number.isFinite(c) && c > 0))
      return fail('IMP_PARAM_RANGE', `cellSize must be > 0 on every axis (got ${JSON.stringify(p.cellSize)})`, 'cellSize');
    if (p.map !== undefined) {
      if (!Number.isInteger(p.map.cellsAround) || p.map.cellsAround < 1)
        return fail(
          'IMP_MAP_SEAM',
          `cellsAround must be a whole number of cells per turn (got ${p.map.cellsAround}): a fraction jumps at the seam`,
          'map.cellsAround',
        );
      if (!(Number.isFinite(p.map.radialCellSize) && p.map.radialCellSize > 0) || Math.hypot(...p.map.axis) === 0)
        return fail('IMP_PARAM_RANGE', 'map needs radialCellSize > 0 and a non-zero axis', 'map');
      if (p.origin !== undefined || p.rotation !== undefined)
        return fail('IMP_PARAM_CONFLICT', 'map replaces origin and rotation: give one or the other', 'origin');
    }
    const absent = badRegion(doc, p.region);
    if (absent !== undefined)
      return refuseImplicit(doc, 'add_tpms_lattice', 'IMP_FIELD_NOT_FOUND', `no region field '${absent}'`, [absent], ['params.region']);
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
      const value = p.thickness ?? p.level ?? 0;
      const inside = interval.name === 'thickness' ? value > interval.low && value < interval.high : Math.abs(value) < interval.high;
      if (!Number.isFinite(value) || !inside)
        return fail(
          'IMP_TPMS_CONTROL_RANGE',
          `${interval.name} ${value} is outside the valid interval (${interval.low}, ${interval.high})`,
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
      ...(p.map === undefined ? {} : { map: p.map }),
      ...(p.region === undefined ? {} : { region: p.region }),
      ...(p.name === undefined ? {} : { name: p.name }),
    };
    return addNode(doc, 'add_tpms_lattice', node, `${p.kind} ${p.form}, cell ${cellSize.join('x')}, ${control.kind} ${control.value}`, {
      control: {
        ...control,
        normalized: request.normalize === 'gradient',
        ...(p.relativeDensity === undefined ? {} : { relativeDensityTarget: p.relativeDensity }),
      },
    });
  },
});

/**
 * @affects creates 1 struts node (periodic beams, clipped by `region` when given)
 * @invariant struts are cylinders with spherical end caps along the cell's bonds; every node of the four cells lies on a continuing strut, so node balls add nothing unless nodeRadius > radius
 * @failure unknown region -> IMP_FIELD_NOT_FOUND; radius <= 0 -> IMP_PARAM_RANGE; 2 * radius >= the shortest strut length -> IMP_STRUT_RADIUS_RANGE
 */
export const addStrutLattice = defineCommand({
  name: 'add_strut_lattice',
  description:
    'Create a periodic strut (beam) lattice as an implicit FIELD: cubic (3 edges per cell), bcc (8 half body diagonals), fcc (6 face diagonals) or octet (24 bonds, stretch-dominated). ' +
    'Struts are round with the given radius; the radius must stay below half the shortest strut. Pass region (a bounded field id, e.g. a box primitive) to clip the lattice to a body. ' +
    'Next: create_implicit_body for a mesh, lattice_properties for strut counts, length, relative density and the Maxwell count.',
  params: z.object({
    cell: z.enum(['cubic', 'bcc', 'fcc', 'octet']).describe('Unit cell type.'),
    cellSize: cellSizeSchema,
    radius: z.number().describe('Strut radius in document units (> 0, and 2 * radius < the shortest strut length of the cell).'),
    nodeRadius: z
      .number()
      .optional()
      .describe('Optional ball radius at every node in document units; only larger than radius has an effect.'),
    origin: vec3('Lattice origin [x, y, z] (a lattice node) in document units. Default [0, 0, 0].').optional(),
    rotation: vec3('Lattice Euler XYZ rotation in radians about origin. Default [0, 0, 0].').optional(),
    region: z.string().optional().describe('Id of a field that clips the lattice (kept where that field is negative).'),
    name: z.string().optional().describe('Optional label for the node.'),
  }),
  run: (doc, p): CommandResult => {
    const fail = (code: string, message: string, path: string): CommandResult =>
      refuseImplicit(doc, 'add_strut_lattice', code, message, [], [`params.${path}`]);
    const cellSize = asVec3(p.cellSize);
    if (!cellSize.every((c) => Number.isFinite(c) && c > 0))
      return fail('IMP_PARAM_RANGE', `cellSize must be > 0 on every axis (got ${JSON.stringify(p.cellSize)})`, 'cellSize');
    if (!(Number.isFinite(p.radius) && p.radius > 0))
      return fail('IMP_STRUT_RADIUS_RANGE', `radius must be > 0 (got ${p.radius})`, 'radius');
    const absent = badRegion(doc, p.region);
    if (absent !== undefined)
      return refuseImplicit(doc, 'add_strut_lattice', 'IMP_FIELD_NOT_FOUND', `no region field '${absent}'`, [absent], ['params.region']);
    const shortest = Math.min(...strutGeometry(p.cell, cellSize, p.radius, undefined).lengths);
    if (2 * p.radius >= shortest)
      return fail(
        'IMP_STRUT_RADIUS_RANGE',
        `2 * radius (${2 * p.radius}) must stay below the shortest strut length ${shortest} of a ${p.cell} cell`,
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
      ...(p.region === undefined ? {} : { region: p.region }),
      ...(p.name === undefined ? {} : { name: p.name }),
    };
    return addNode(doc, 'add_strut_lattice', node, `${p.cell} strut lattice, cell ${cellSize.join('x')}, radius ${p.radius}`, {
      shortestStrut: shortest,
    });
  },
});
