import { defineCommand, vec3, z } from '@core/commands/schema';
import type { CommandResult } from '@core/commands/types';
import { changed } from '@core/commands/noop';
import type { CadDocument } from '@core/model/types';
import type { InlineComponent, PipeRun } from '@aec/plant/types';
import type { Vec3 } from '@core/model/vectors';
import { add3, scale3, sub3 } from '@lib/vec3';
import type { RunDerivation } from '../deriveTypes';
import { unitVector } from '../legs';
import { getPiping, locateOnRun, refuse, runPoints } from '../model';
import { refuseDerivation, rederive, withRuns } from '../runUpdate';
import { takeoffOf } from '../takeoff';
import { buildInline, inlineAt, inlineFields } from './routeInput';

const UNITS_MESSAGE = (doc: CadDocument): string => `plant lengths and catalogue dimensions are mm; this document is in ${doc.units}`;

/** Compact answer about one component of a derived run (a mutating step's data over 4000 characters is dropped from build_project reports). */
function componentData(run: PipeRun, derivation: RunDerivation, component: InlineComponent): Record<string, unknown> {
  const placed = derivation.inline.find((item) => item.id === component.id);
  const takeoff = takeoffOf([{ runId: run.id, derivation }]);
  const handwheel =
    placed?.stemDirection === undefined
      ? null
      : {
          point: add3(placed.centre, scale3(placed.stemDirection, placed.stemHeightMm ?? 0)),
          stemHeightMm: placed.stemHeightMm ?? 0,
          stemHeightFromCatalogue: placed.stemHeightMm !== null,
        };
  return {
    componentId: component.id,
    runId: run.id,
    type: component.type,
    ...(component.tag === undefined ? {} : { tag: component.tag }),
    leg: component.leg,
    centreDistance: component.centreDistance,
    dn: placed?.dn,
    ...(placed?.dn2 === undefined ? {} : { dn2: placed.dn2 }),
    lengthMm: placed?.lengthMm,
    centre: placed?.centre,
    facePositions: placed?.faces,
    partIds: placed?.partIds,
    ...(placed?.stemDirection === undefined ? {} : { stemDirection: placed.stemDirection }),
    handwheelCentre: handwheel,
    legCutLengthsMm: derivation.legs[component.leg]?.cutLengthsMm,
    pipePieces: takeoff.pipePieces.map((piece) => ({ id: piece.id, dn: piece.dn, leg: piece.leg, cutLengthMm: piece.cutLengthMm })),
    counts: takeoff.counts,
    warnings: takeoff.warnings,
    unverified: takeoff.unverified,
    unverifiedReasons: takeoff.unverifiedReasons,
  };
}

/**
 * Stores `next` in place of the run, derives it and what is attached to it, and answers; refuses (document unchanged) when something no longer derives.
 * A branch fitting colliding with the component is reported as the component not fitting.
 */
function commitComponent(doc: CadDocument, command: string, next: PipeRun, component: InlineComponent, verb: string): CommandResult {
  const result = rederive(withRuns(doc, [next]), [next.id]);
  if (!result.ok) {
    const code =
      result.code === 'RTE_BRANCH_ON_FITTING' || result.code === 'RTE_SEGMENT_TOO_SHORT' ? 'RTE_INLINE_DOES_NOT_FIT' : result.code;
    return refuseDerivation(doc, command, result, next.id, code);
  }
  const derivation = result.derivations[next.id] as RunDerivation;
  const data = componentData(next, derivation, component);
  return {
    ...changed(
      result.document,
      `${command}: ${verb} ${component.type} ${component.id}${component.tag === undefined ? '' : ` "${component.tag}"`} on run ${next.id} leg ${component.leg} at ${+component.centreDistance.toFixed(4)} mm; ` +
        `leg ${component.leg} pipe pieces ${JSON.stringify(derivation.legs[component.leg]?.cutLengthsMm.map((cut) => +cut.toFixed(4)))}; ` +
        `${derivation.warnings.length} warning(s)${derivation.unverified ? `; unverified: ${derivation.unverifiedReasons.join('; ')}` : ''}.`,
      [component.id, next.id],
    ),
    data,
  };
}

const runOf = (doc: CadDocument, command: string, runId: string): PipeRun | CommandResult => {
  const run = getPiping(doc).runs[runId];
  return run === undefined ? refuse(doc, command, 'RTE_UNKNOWN_RUN', `no pipe run "${runId}"`, [], ['runId']) : run;
};

const isRun = (value: PipeRun | CommandResult): value is PipeRun => 'lineId' in value;

const legDirection = (run: PipeRun, leg: number): Vec3 | null => {
  const points = runPoints(run);
  const [a, b] = [points[leg], points[leg + 1]];
  return a === undefined || b === undefined ? null : unitVector(sub3(b, a));
};

/**
 * @affects adds 1 inline component to run.inline (plant.piping) and re-derives the run (and the runs attached to it): the leg is cut around the
 *   component (flange sets for a flanged valve), the downstream size changes at a reducer
 * @invariant centre distances are from the leg start; the component's parts, faces and cut lengths are derived from the spec row (face-to-face
 *   or length, flange sets), nothing is stored beyond type, tag, position, dn2 and stem direction
 * @failure unknown run -> RTE_UNKNOWN_RUN; point off the centreline / leg or position outside the run / overlap with a fitting ->
 *   RTE_INLINE_DOES_NOT_FIT; no spec row -> RTE_SPEC_NO_COMPONENT; reducer without dn2, or valve with dn2 -> RTE_SIZE_MISMATCH; a reducer that
 *   makes the run end at another size than its port -> RTE_SIZE_MISMATCH
 */
export const insertInlineComponent = defineCommand({
  name: 'insert_inline_component',
  description:
    'Insert a valve or a concentric reducer into a routed pipe run (route_pipe / auto_route_pipe / add_branch), spec-driven. A flanged valve (the ' +
    'spec row says FL ends) splits the leg: face-to-face from the catalogue, a weld-neck flange + gasket + bolt set on each face, pipe pieces ' +
    'shortened to fit (data.pipePieces, data.legCutLengthsMm); a reducer occupies its end-to-end length and the run continues at dn2 downstream. ' +
    'at: { leg, centreDistance } (leg index of route_pipe data.legs, distance of the centre from the leg start, mm) or { point: [x, y, z] } on the ' +
    'centreline. Valves: stemDirection points to the handwheel (default up, or +X on a vertical pipe); data.handwheelCentre = centre + stem x ' +
    'catalogue stemHeight (0 when the row has none, stemHeightFromCatalogue false). Returns the component id (affected[0]) to pass to ' +
    'move_inline_component / remove_inline_component / check_piping; data = { componentId, runId, type, tag, leg, centreDistance, dn, dn2, lengthMm, ' +
    'centre, facePositions [[x,y,z],[x,y,z]] (upstream, downstream), partIds, stemDirection, handwheelCentre, legCutLengthsMm, pipePieces, counts, ' +
    'warnings, unverified }. Refusals: RTE_UNITS_UNSUPPORTED, RTE_UNKNOWN_RUN, RTE_INLINE_DOES_NOT_FIT (detail names the neighbours and the cut ' +
    'length), RTE_SPEC_NO_COMPONENT, RTE_SIZE_MISMATCH, RTE_NO_CONNECTION_RULE, RTE_RATING_MISMATCH, RTE_FACING_MISMATCH. Next: check_piping ' +
    '(maxHandwheelCentreHeight), piping_takeoff.',
  params: z.object({
    runId: z.string().describe('Pipe run id (affected[0] of route_pipe / auto_route_pipe / add_branch).'),
    ...inlineFields,
    at: z
      .union([inlineAt, z.object({ point: vec3('A point [x, y, z] on the run centreline, within 0.01 mm.') })])
      .describe('Position: { leg, centreDistance } or { point } on the centreline.'),
  }),
  run: (doc, params): CommandResult => {
    if (doc.units !== 'mm') return refuse(doc, 'insert_inline_component', 'RTE_UNITS_UNSUPPORTED', UNITS_MESSAGE(doc));
    const run = runOf(doc, 'insert_inline_component', params.runId);
    if (!isRun(run)) return run;
    const where = 'leg' in params.at ? { leg: params.at.leg, centreDistance: params.at.centreDistance } : locateOnRun(run, params.at.point);
    const direction = where === null ? null : legDirection(run, where.leg);
    if (where === null || direction === null)
      return refuse(
        doc,
        'insert_inline_component',
        'RTE_INLINE_DOES_NOT_FIT',
        'point' in params.at
          ? `point [${params.at.point.join(', ')}] is not on the centreline of run ${run.id}`
          : `run ${run.id} has no leg ${'leg' in params.at ? params.at.leg : ''}`,
        [run.id],
        ['at'],
      );
    const component = buildInline(
      doc,
      'insert_inline_component',
      params,
      { leg: where.leg, centreDistance: 'distance' in where ? where.distance : where.centreDistance },
      direction,
      'inline',
    );
    if ('document' in component) return component;
    return commitComponent(doc, 'insert_inline_component', { ...run, inline: [...(run.inline ?? []), component] }, component, 'inserted');
  },
});

const find = (run: PipeRun, componentId: string): InlineComponent | undefined => run.inline?.find((item) => item.id === componentId);

/**
 * @affects moves 1 inline component along its leg (run.inline) and re-derives the run
 * @failure unknown run / component -> RTE_UNKNOWN_RUN / RTE_UNKNOWN_COMPONENT; neither or both of centreDistance and delta, or a position the run
 *   cannot take -> RTE_INLINE_DOES_NOT_FIT
 */
export const moveInlineComponent = defineCommand({
  name: 'move_inline_component',
  description:
    'Slide a valve or reducer along its leg: give the new centreDistance (from the leg start, mm) or a delta (mm along the leg direction, negative ' +
    'toward the start). The cut lengths of the neighbouring pipe pieces are re-derived; nothing else changes. Refused when the component would ' +
    'overlap an elbow, flange set, tee or another component, or leave the leg (RTE_INLINE_DOES_NOT_FIT, document unchanged). Same data as ' +
    'insert_inline_component. Refusals: RTE_UNKNOWN_RUN, RTE_UNKNOWN_COMPONENT, RTE_INLINE_DOES_NOT_FIT.',
  params: z.object({
    runId: z.string().describe('Pipe run id.'),
    componentId: z.string().describe('Inline component id (affected[0] of insert_inline_component).'),
    centreDistance: z.number().positive().optional().describe('New distance of the centre from the leg start, mm. Give this or delta.'),
    delta: z.number().optional().describe('Shift along the leg direction, mm. Give this or centreDistance.'),
  }),
  run: (doc, params): CommandResult => {
    const run = runOf(doc, 'move_inline_component', params.runId);
    if (!isRun(run)) return run;
    const component = find(run, params.componentId);
    if (component === undefined)
      return refuse(
        doc,
        'move_inline_component',
        'RTE_UNKNOWN_COMPONENT',
        `run ${run.id} has no inline component "${params.componentId}"`,
        [run.id],
        ['componentId'],
      );
    if ((params.centreDistance === undefined) === (params.delta === undefined))
      return refuse(
        doc,
        'move_inline_component',
        'RTE_INLINE_DOES_NOT_FIT',
        'give exactly one of centreDistance and delta',
        [component.id],
        ['centreDistance'],
      );
    const moved: InlineComponent = {
      ...component,
      centreDistance: params.centreDistance ?? component.centreDistance + (params.delta as number),
    };
    if (!(moved.centreDistance > 0))
      return refuse(
        doc,
        'move_inline_component',
        'RTE_INLINE_DOES_NOT_FIT',
        `the new centre distance ${moved.centreDistance} is not on the leg`,
        [component.id],
        ['centreDistance'],
      );
    const next: PipeRun = { ...run, inline: (run.inline ?? []).map((item) => (item.id === component.id ? moved : item)) };
    return commitComponent(doc, 'move_inline_component', next, moved, 'moved');
  },
});

/**
 * @affects removes 1 inline component from run.inline and re-derives the run (a removed reducer restores the upstream size downstream)
 * @failure unknown run / component -> RTE_UNKNOWN_RUN / RTE_UNKNOWN_COMPONENT; the run no longer derives (a removed reducer leaves the end at the
 *   wrong size for its port) -> that code
 */
export const removeInlineComponent = defineCommand({
  name: 'remove_inline_component',
  annotations: { destructive: true },
  description:
    'Remove a valve or reducer from a pipe run: the leg is cut again without it (the pipe pieces around it merge into one) and the downstream size ' +
    'returns to the upstream size for a reducer. Refused with the RTE_* code when the run then no longer derives (e.g. RTE_SIZE_MISMATCH: the end ' +
    'port has the reduced size, RTE_BRANCH_NO_TABLE_ROW for a branch that took the reduced header size) and nothing changes. Refusals: ' +
    'RTE_UNKNOWN_RUN, RTE_UNKNOWN_COMPONENT.',
  params: z.object({
    runId: z.string().describe('Pipe run id.'),
    componentId: z.string().describe('Inline component id (affected[0] of insert_inline_component).'),
  }),
  run: (doc, params): CommandResult => {
    const run = runOf(doc, 'remove_inline_component', params.runId);
    if (!isRun(run)) return run;
    const component = find(run, params.componentId);
    if (component === undefined)
      return refuse(
        doc,
        'remove_inline_component',
        'RTE_UNKNOWN_COMPONENT',
        `run ${run.id} has no inline component "${params.componentId}"`,
        [run.id],
        ['componentId'],
      );
    const { inline, ...rest } = run;
    const remaining = (inline ?? []).filter((item) => item.id !== component.id);
    const next: PipeRun = remaining.length === 0 ? rest : { ...rest, inline: remaining };
    const result = rederive(withRuns(doc, [next]), [next.id]);
    if (!result.ok) return refuseDerivation(doc, 'remove_inline_component', result, next.id);
    const derivation = result.derivations[next.id] as RunDerivation;
    return changed(
      result.document,
      `remove_inline_component: removed ${component.type} ${component.id} from run ${next.id}; leg ${component.leg} pipe pieces ${JSON.stringify(derivation.legs[component.leg]?.cutLengthsMm.map((cut) => +cut.toFixed(4)))}.`,
      [next.id],
    );
  },
});
