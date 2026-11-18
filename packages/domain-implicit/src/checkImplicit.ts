/** check_implicit: manufacturability findings of an implicit body (05 IMP 4.4, FR-IMP-40..45; MVP set). */

import { defineCommand, vec3, z } from '@core/commands/schema';
import type { CommandResult } from '@core/commands/types';
import { resolveFieldEngine } from '@core/geometry/field/engine';
import { refuseImplicit } from './codes';
import { compileField } from './compile';
import {
  type ProcessOutcome,
  checkReport,
  closingFindings,
  componentFindings,
  fullMeshOf,
  isRefusal,
  meshFindings,
  newFindings,
  noProcessFinding,
  processFindings,
  recipeFeatures,
  resolveBody,
} from './checkImplicitPhases';
import { measureVoxel, signComponentsOf } from './measure';
import { measureWalls } from './wallChecks';

/**
 * @affects none (read-only); data = status (pass / warn / fail), findings[] {code, severity, ids, value, limit, unit, location, remediation}, limits (named, with source), reviewRequired, reviewReason
 * @invariant no printer table is shipped: process limits come from the caller (with a source) and are echoed; without them IMP_CHECK_NO_PROCESS_LIMITS is always reported; unverified inputs always add IMP_CHECK_INPUT_UNVERIFIED; wall / strut sizes are the recipe's declared sizes (shell thickness, sheet thickness, strut diameter)
 * @invariant field-engine-optional: reads ctx.fieldEngine when present, else the built-in TS engine (no kernel is needed)
 * @failure unknown body -> IMP_FIELD_NOT_FOUND
 */
export const checkImplicit = defineCommand({
  name: 'check_implicit',
  description:
    'Check an implicit body (id from create_implicit_body) for printing / release: mesh closed and edge-manifold, enclosed voids that powder or resin cannot leave (IMP_TRAPPED_VOID, with void volume and a point inside), ' +
    'more than one solid component (IMP_DISCONNECTED), features thinner than 2 voxels (IMP_CHECK_RESOLUTION_COARSE: halve the voxel), and walls / struts below the process limits you give. ' +
    'llull ships NO printer table: pass process {minWallMm, minStrutMm, source} from your machine data sheet, otherwise IMP_CHECK_NO_PROCESS_LIMITS is always reported. ' +
    'purpose "release" marks the result reviewRequired: computed by llull, not approved, a qualified engineer must review. Returns status pass / warn / fail and a findings list.',
  annotations: { readsMeshTriangles: true, readOnly: true },
  params: z.object({
    id: z.string().describe('Id of the implicit body (the entity id returned by create_implicit_body).'),
    process: z
      .object({
        minWallMm: z.number().optional().describe('Smallest printable wall in millimetres.'),
        minPoreMm: z
          .number()
          .optional()
          .describe('Smallest printable pore / channel in millimetres (measured by the distance transform, +-2.5 voxels).'),
        buildDirection: vec3(
          'Build direction [x, y, z] pointing away from the plate; with criticalAngleDeg it enables the overhang analysis.',
        ).optional(),
        criticalAngleDeg: z
          .number()
          .optional()
          .describe(
            'Smallest self-supporting inclination of a face to the build plate in degrees (0..90), from your process data; required with buildDirection (never defaulted).',
          ),
        minStrutMm: z.number().optional().describe('Smallest printable strut diameter in millimetres.'),
        source: z
          .string()
          .describe(
            'Where the limits come from (machine data sheet, owner-supplied...). Required: limits without a source are not accepted.',
          ),
      })
      .optional()
      .describe('Process limits in millimetres, from your machine data. Never defaulted.'),
    purpose: z.enum(['design', 'release']).optional().describe('design (default) or release; release adds the review-required statement.'),
  }),
  run: (doc, { id, process, purpose = 'design' }, ctx): CommandResult => {
    const body = resolveBody(doc, id);
    if (isRefusal(body)) return body;
    const compiled = compileField(doc, body.field);
    if (!compiled.ok) return refuseImplicit(doc, 'check_implicit', compiled.code, compiled.message, compiled.ids);
    const unit = doc.units;
    const sink = newFindings(unit);
    const full = fullMeshOf(doc, id, ctx);
    if (full !== null && isRefusal(full)) return full;
    const features = recipeFeatures(doc, compiled.nodes);
    meshFindings(sink, id, unit, full, body, features);
    const engine = resolveFieldEngine(ctx?.fieldEngine);
    const voxel = measureVoxel(body.bounds, undefined, body.voxel);
    const parts = signComponentsOf(engine, compiled.program, body.bounds, voxel);
    const componentNote = componentFindings(sink, id, unit, parts);
    const walls = measureWalls(engine, compiled.program, body.bounds, body.voxel);
    const outcome: ProcessOutcome = { limits: [], notEvaluated: [], overhangResult: null };
    if (process === undefined) noProcessFinding(sink, id);
    else processFindings(doc, id, sink, process, walls, full, features, outcome);
    if (componentNote !== null) outcome.notEvaluated.push('components');
    closingFindings(sink, id, compiled.unverified, outcome.notEvaluated);
    return checkReport(doc, {
      id,
      purpose,
      findings: sink.list,
      limits: outcome.limits,
      features,
      walls,
      overhangResult: outcome.overhangResult,
      notEvaluated: outcome.notEvaluated,
      componentNote,
      compiled,
      engine,
      voxel,
    });
  },
});
