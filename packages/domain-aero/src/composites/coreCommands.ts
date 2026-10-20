/** add_core: a chamfered sandwich core region inside a composite part (06 CMP FR-CMP-13, VC-CMP-24). */

import { defineCommand, vec2, z } from '@core/commands/schema';
import type { CommandResult } from '@core/commands/types';
import { changed } from '@core/commands/noop';
import type { CoreRegion } from '@core/model/composites';
import type { Vec2 } from '@core/model/types';
import { nextId } from '@lib/id';
import { polygonArea, selfIntersects, toCounterClockwise } from '@lib/polygon';
import { sig } from '../shared/results';
import { refuseCmp } from './codes';
import { insideOrOn } from './geometry2d';
import { chamferRun, coresOf } from './sandwich';
import { compositesOf, findPart, findPly, pliesOf, withComposites } from './state';

/**
 * @affects creates doc.composites.cores[core-<step>.<k>]
 * @invariant the core sits on top of the plies with stacking order below `afterOrder` (default: the lower half of the stack); its thickness ramps linearly from 0 at the edge at the chamfer slope up to `thickness`; plies above it are lifted by the core thickness
 * @failure unknown part / material / ply -> CMP_REF_MISSING; material not a core form, thickness <= 0, chamfer outside (0, 90], degenerate or out-of-outline boundary -> CMP_CORE_INVALID; name in use -> CMP_NAME_TAKEN
 */
export const addCore = defineCommand({
  name: 'add_core',
  description:
    'Add a sandwich core (honeycomb or foam) region to a composite part. `boundary` is a simple polygon in the part frame (same frame as ' +
    'define_zone), `material` a lamina record with form core_honeycomb or core_foam (its density gives the core mass), `thickness` the full ' +
    'core thickness in document length units and `chamferAngle` the edge slope in degrees in (0, 90] measured from the tool face: the ' +
    'thickness grows linearly from 0 at the edge, so the chamfer run is thickness / tan(chamferAngle) (30 deg and 10 mm give a 17.32 mm run ' +
    'and 5 mm at mid-run). The core sits above the plies up to and including `afterPly` (id or name; default the lower half of the stack); ' +
    'plies above are lifted by the core thickness in core_sample and per-ply solids. laminate_mass adds the core mass. ' +
    'Analyses that treat the stack as a laminate (analyze_laminate, sections, strength ratios) refuse points where a core lies (CMP_CORE_UNSUPPORTED).',
  params: z.object({
    part: z.string().describe('Part id or name.'),
    name: z.string().min(1).describe('Core name, unique in the part; default "Core<n>".').optional(),
    boundary: z
      .array(vec2('A vertex [x, y] in the part frame (document units).'))
      .describe('Simple polygon of at least 3 vertices inside the part outline.'),
    material: z.string().describe('Core material: a lamina record with form core_honeycomb or core_foam (create_lamina_material).'),
    thickness: z.number().describe('Full core thickness, document length units, > 0.'),
    chamferAngle: z.number().describe('Edge chamfer angle from the tool face, degrees, in (0, 90].'),
    afterPly: z.string().describe('Ply id or name the core sits on; default the lower half of the stack.').optional(),
  }),
  run: (doc, { part: partRef, name, boundary, material, thickness, chamferAngle, afterPly }): CommandResult => {
    const model = compositesOf(doc);
    const part = findPart(model, partRef);
    if (part === null) return refuseCmp(doc, 'add_core', 'CMP_REF_MISSING', `no part '${partRef}'`, [], ['params.part']);
    const lamina = model.materials[material];
    if (lamina === undefined)
      return refuseCmp(doc, 'add_core', 'CMP_REF_MISSING', `no lamina material '${material}'`, [], ['params.material']);
    const refuse = (message: string, path: string): CommandResult =>
      refuseCmp(doc, 'add_core', 'CMP_CORE_INVALID', message, [part.id], [path]);
    if (lamina.form !== 'core_honeycomb' && lamina.form !== 'core_foam')
      return refuse(`material "${material}" is a ${lamina.form} lamina, not a core_honeycomb / core_foam`, 'params.material');
    if (!(Number.isFinite(thickness) && thickness > 0)) return refuse('thickness must be a number > 0', 'params.thickness');
    if (!(Number.isFinite(chamferAngle) && chamferAngle > 0 && chamferAngle <= 90))
      return refuse('chamferAngle must be in (0, 90] degrees', 'params.chamferAngle');
    if (boundary.length < 3 || polygonArea(boundary) < 1e-9 || selfIntersects(boundary))
      return refuse('boundary must be a simple polygon of at least 3 vertices', 'params.boundary');
    if (boundary.some((vertex) => !insideOrOn(vertex, part.outline))) return refuse('boundary leaves the part outline', 'params.boundary');
    const existing = coresOf(model, part.id);
    const coreName = name ?? `Core${existing.length + 1}`;
    if (existing.some((core) => core.name === coreName))
      return refuseCmp(
        doc,
        'add_core',
        'CMP_NAME_TAKEN',
        `part "${part.name}" already has a core "${coreName}"`,
        [part.id],
        ['params.name'],
      );
    const plies = pliesOf(model, part.id);
    let afterOrder = Math.floor(plies.length / 2);
    if (afterPly !== undefined) {
      const ply = findPly(model, part.id, afterPly);
      if (ply === null || ply.partId !== part.id)
        return refuseCmp(doc, 'add_core', 'CMP_REF_MISSING', `no ply '${afterPly}'`, [part.id], ['params.afterPly']);
      afterOrder = ply.order + 1;
    }
    const core: CoreRegion = {
      id: nextId('core'),
      partId: part.id,
      name: coreName,
      boundary: toCounterClockwise(boundary).map((p): Vec2 => [p[0], p[1]]),
      materialName: material,
      thickness,
      chamferAngle,
      afterOrder,
    };
    return changed(
      withComposites(doc, { cores: { ...(model.cores ?? {}), [core.id]: core } }),
      `add_core: core "${coreName}" (${core.id}) on part "${part.name}": ${material}, ${thickness} ${doc.units} thick, chamfer ${chamferAngle} deg (run ${sig(chamferRun(core))} ${doc.units}), above ${afterOrder} of ${plies.length} ply(ies).`,
      [core.id],
    );
  },
});
