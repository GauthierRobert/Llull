/** infill_solid: skin + lattice infill of an existing solid in one call, composed of the field commands (05 IMP 4.3, FR-IMP-23). */

import { defineCommand, vec3, z } from '@core/commands/schema';
import { execute } from '@core/commands/registry';
import type { CommandResult, ExecutionContext } from '@core/commands/types';
import type { CadDocument, Vec3 } from '@core/model/types';
import { meshMeasures } from '@lib/isosurface/measures';
import { refuseImplicit } from './codes';
import { compileField } from './compile';
import { fieldOf } from './model';
import { closedSolidMesh } from './solidMesh';

const lawSchema = z.union([z.number(), z.string()]);

const LATTICE = z
  .discriminatedUnion('type', [
    z.object({
      type: z.literal('tpms').describe('A TPMS infill (see add_tpms_lattice).'),
      kind: z.enum(['gyroid', 'schwarz_p', 'diamond', 'neovius', 'iwp', 'lidinoid', 'fischer_koch_s', 'split_p']).describe('TPMS family.'),
      form: z.enum(['sheet', 'network']).describe('sheet or network.'),
      cellSize: z.union([z.number(), vec3('Cell size per axis.')]).describe('Cell size in document units: a number or [x, y, z].'),
      thickness: lawSchema.optional().describe('Sheet wall thickness (number or scalar field id).'),
      level: lawSchema.optional().describe('Network level (number or scalar field id).'),
      relativeDensity: z.number().optional().describe('Target solid fraction of the cell (0..1) instead of thickness / level.'),
      normalize: z.enum(['gradient', 'none']).optional().describe('Wall normalisation (default gradient).'),
      origin: vec3('Lattice origin [x, y, z]. Default [0, 0, 0].').optional(),
    }),
    z.object({
      type: z.literal('struts').describe('A strut infill (see add_strut_lattice).'),
      cell: z.enum(['cubic', 'bcc', 'fcc', 'octet', 'kelvin', 'diamond', 'bccz', 'fccz', 'reentrant']).describe('Unit cell type.'),
      cellSize: z.union([z.number(), vec3('Cell size per axis.')]).describe('Cell size in document units: a number or [x, y, z].'),
      radius: lawSchema.describe('Strut radius in document units (number or scalar field id).'),
      nodeRadius: z.number().optional().describe('Optional node ball radius.'),
      origin: vec3('Lattice origin [x, y, z]. Default [0, 0, 0].').optional(),
    }),
  ])
  .describe('The infill lattice, clipped to the inside of the skin.');

/** Thrown by the step runner to leave `run` with the refusal of a composed command. */
class Stop {
  constructor(readonly result: CommandResult) {}
}

interface Step {
  readonly command: string;
  readonly ids: readonly string[];
}

/**
 * @affects creates the field nodes of the skin, the inner region, the lattice, their union (and the drain holes / opening cuts), and one implicit body; the source solid moves to the hidden layer
 * @invariant composed of field_from_solid, shell_field, offset_field, add_tpms_lattice | add_strut_lattice, combine_fields and create_implicit_body through `execute`, so every step is validated and replayable; skin = inside shell of the stated wall, infill = the lattice clipped to the solid offset inwards by the wall
 * @failure any composed command's refusal is returned with its own IMP_* code and the step that raised it; the document is unchanged
 */
export const infillSolid = defineCommand({
  name: 'infill_solid',
  description:
    'Lighten an existing closed 3D solid in one call: an inside skin of `wall` (document units) plus a lattice infill (TPMS or struts) clipped to the solid shrunk by the wall, realised as an implicit body at `voxel`. ' +
    'It runs field_from_solid, shell_field, offset_field, add_tpms_lattice / add_strut_lattice, combine_fields and create_implicit_body for you (their ids are in data.steps), hides the source solid, and reports the volumes. ' +
    'openBy (a field id) removes skin and infill where that field is negative (an opening to drain or inspect); drainHoles {diameter, count} subtracts vertical (z) through-holes: one on the axis, or `count` on a circle, so powder or resin can leave (run check_implicit and look for IMP_TRAPPED_VOID). ' +
    'Pick voxel at most wall / 2 (the check warns below that). Next: implicit_properties, check_implicit, export_3mf / export_stl.',
  params: z.object({
    entityId: z.string().describe('Id of the closed 3D solid (box, extrusion, boolean result, mesh...) to lighten.'),
    wall: z.number().describe('Skin thickness in document units (> 0).'),
    lattice: LATTICE,
    voxel: z
      .number()
      .describe('Grid spacing of the realised body in document units (> 0); halve it for 4x smaller error and 8x more samples.'),
    openBy: z.string().optional().describe('Id of a field: skin and infill are removed where it is negative.'),
    drainHoles: z
      .object({
        diameter: z.number().describe('Hole diameter in document units (> 0).'),
        count: z.number().describe('Number of holes (integer 1..16): 1 on the axis of the solid, more on a circle.'),
      })
      .optional()
      .describe('Vertical (z) through-holes for powder / resin drainage.'),
    maxTriangles: z.number().optional().describe('Refuse a body with more triangles than this (see create_implicit_body).'),
    name: z.string().optional().describe('Optional name of the body.'),
    color: z.string().optional().describe('Optional hex colour of the body.'),
  }),
  run: (doc, p, ctx): CommandResult => {
    const fail = (code: string, message: string, ids: readonly string[] = []): CommandResult =>
      refuseImplicit(doc, 'infill_solid', code, message, ids);
    if (!(Number.isFinite(p.wall) && p.wall > 0)) return fail('IMP_PARAM_RANGE', `wall must be > 0 (got ${p.wall})`);
    if (!(Number.isFinite(p.voxel) && p.voxel > 0)) return fail('IMP_PARAM_RANGE', `voxel must be > 0 (got ${p.voxel})`);
    const solid = closedSolidMesh(doc, p.entityId);
    if (!solid.ok) return fail(solid.code, solid.message, [p.entityId]);
    if (p.openBy !== undefined && fieldOf(doc, p.openBy) === undefined)
      return fail('IMP_FIELD_NOT_FOUND', `no field '${p.openBy}'`, [p.openBy]);
    if (
      p.drainHoles !== undefined &&
      !(p.drainHoles.diameter > 0 && Number.isInteger(p.drainHoles.count) && p.drainHoles.count >= 1 && p.drainHoles.count <= 16)
    )
      return fail('IMP_PARAM_RANGE', 'drainHoles needs diameter > 0 and an integer count 1..16');
    let current: CadDocument = doc;
    const steps: Step[] = [];
    const run = (command: string, params: Record<string, unknown>): { id: string; data: Record<string, unknown> } => {
      const result = execute(current, command, params, ctx as ExecutionContext | undefined);
      if (result.error !== undefined || result.rejected === true)
        throw new Stop(
          refuseImplicit(
            doc,
            'infill_solid',
            result.error?.code ?? 'IMP_PARAM_RANGE',
            `step ${steps.length + 1} (${command}): ${result.summary}`,
            result.error?.ids ?? [],
          ),
        );
      current = result.document;
      steps.push({ command, ids: result.affected });
      return { id: result.affected[0] ?? '', data: (result.data ?? {}) as Record<string, unknown> };
    };
    try {
      const source = run('field_from_solid', { entityId: p.entityId });
      const skin = run('shell_field', { field: source.id, thickness: p.wall, side: 'inside' });
      const inner = run('offset_field', { field: source.id, distance: -p.wall });
      const { type, ...lattice } = p.lattice;
      const infill = run(type === 'tpms' ? 'add_tpms_lattice' : 'add_strut_lattice', { ...lattice, region: inner.id });
      let part = run('combine_fields', { op: 'union', a: skin.id, b: infill.id });
      const compiled = compileField(current, source.id);
      if (p.drainHoles !== undefined && compiled.ok && compiled.program.bounds !== null) {
        const { min, max } = compiled.program.bounds;
        const centre: Vec3 = [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2];
        const ring = (0.35 * Math.min(max[0] - min[0], max[1] - min[1])) / 2;
        const height = max[2] - min[2] + 2 * p.wall;
        const holes: string[] = [];
        for (let k = 0; k < p.drainHoles.count; k += 1) {
          const angle = (2 * Math.PI * k) / p.drainHoles.count;
          const position: Vec3 =
            p.drainHoles.count === 1 ? centre : [centre[0] + ring * Math.cos(angle), centre[1] + ring * Math.sin(angle), centre[2]];
          const hole = run('add_field_primitive', { shape: 'cylinder', radius: p.drainHoles.diameter / 2, height, position });
          holes.push(hole.id);
        }
        part = run('combine_fields', { op: 'subtract', a: part.id, b: holes });
      }
      if (p.openBy !== undefined) {
        part = run('combine_fields', { op: 'subtract', a: part.id, b: p.openBy });
      }
      const body = run('create_implicit_body', {
        field: part.id,
        voxel: p.voxel,
        hideSource: [p.entityId],
        ...(p.maxTriangles === undefined ? {} : { maxTriangles: p.maxTriangles }),
        ...(p.name === undefined ? {} : { name: p.name }),
        ...(p.color === undefined ? {} : { color: p.color }),
      });
      const volumeBody = body.data['volumeMesh'] as number;
      const volumeSolid = meshMeasures(solid.mesh).volume;
      const saved = volumeSolid > 0 ? 1 - volumeBody / volumeSolid : null;
      return {
        document: current,
        summary: `infill_solid: ${p.entityId} -> body ${body.id} (${p.lattice.type === 'tpms' ? `${p.lattice.kind} ${p.lattice.form}` : `${p.lattice.cell} struts`} infill, skin ${p.wall}): volume ${volumeBody.toPrecision(6)} of ${volumeSolid.toPrecision(6)} ${doc.units}^3${saved === null ? '' : ` (${(100 * saved).toFixed(1)} % lighter)`}, ${String(body.data['triangles'])} triangles, ${steps.length} commands. Next: check_implicit id=${body.id}.`,
        affected: [body.id, ...steps.flatMap((step) => step.ids).filter((id) => id.startsWith('fld-'))],
        data: {
          id: body.id,
          sourceEntity: p.entityId,
          fields: { source: source.id, skin: skin.id, inner: inner.id, lattice: infill.id, part: part.id },
          steps,
          volumeBody,
          volumeSolid,
          volumeUnit: `${doc.units}^3`,
          lighterFraction: saved,
          body: body.data,
          unit: doc.units,
        },
      };
    } catch (error) {
      if (error instanceof Stop) return error.result;
      throw error;
    }
  },
});
