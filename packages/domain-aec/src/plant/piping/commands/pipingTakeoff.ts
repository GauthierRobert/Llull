import { defineCommand, z } from '@core/commands/schema';
import type { CommandResult } from '@core/commands/types';
import { report } from '@core/commands/noop';
import { getPiping, refuse } from '../model';
import { deriveRun } from '../routeParts';
import { insulationTakeoff, takeoffOf, type TakeoffRun } from '../takeoff';

/**
 * @affects none (query: returns the same document; results in `data`)
 * @invariant derived afresh from the stored runs and the current spec (nothing stored); the cut lengths are the ones route_pipe reported
 * @invariant without runId a run that no longer derives is skipped and listed in data.brokenRuns (the rest is counted); with runId it is refused
 * @failure unknown run / line -> RTE_UNKNOWN_RUN / RTE_UNKNOWN_LINE; runId of a run that no longer derives -> its RTE_* code (spec, port, angle, short leg)
 */
export const pipingTakeoff = defineCommand({
  name: 'piping_takeoff',
  description:
    'Query: bill of materials and cut list of routed pipe, derived from the stored runs and their spec: part counts by key (elbow90LR, elbow90LRTrimmed = a 90 elbow cut to the turn, pipeBend, flangeWeldNeck / flangeSocketWeld / flangeThreaded, ' +
    'gasketSpiralWound, boltSet, valveGate, reducerConcentric, reducerEccentric, tee, reducingTee, weldolet, sockolet, threadolet, stubIn ...), pipePieces (cutLengthMm per straight piece, leg index), joints (buttWeld, branchWeld = the set-on weld of an olet or stub-in to the header, socketWeld, threaded, flanged, fittingToFitting, with ' +
    'position, gap and, for socketWeld / threaded, engagementMm = how far the pipe goes into the fitting, which the cut lengths include), counts also hold buttWelds, branchWelds, socketWelds, threadedJoints, flangedJoints and fittingToFitting, studs, totalPipeMm, centrelineLengthMm (legs - 2 x centre-to-end + arcs), legs and turns (angle, nominal angle, ' +
    'deviationDeg, centreToEnd, kind standard | trimmed | bend; a bend part lists radiusMm and developedLengthMm = the pipe in its arc, not counted in totalPipeMm), inline (valves and reducers: faces, part ids, size; valves: operator envelope; eccentric reducers: flat side, offset, invertStepMm), branches (tee / olet / stub-in per branch point), insulation (per insulated line: code, thickness, material, pipeLengthMm of the straight pieces and the outer area of the insulation round them in m2; fittings are not counted), warnings and unverified (spec not approved or catalogue rows not grade A, with reasons). Lengths in mm. Give runId ' +
    'or lineId; with neither, every run is counted. A run that no longer derives (its equipment or tie-in moved or was removed, the spec lost a part: ' +
    'marked broken) is skipped and listed in data.brokenRuns [{ runId, code, message }]; asked for by runId it is refused with its RTE_* code. Refusals: ' +
    'RTE_UNKNOWN_RUN, RTE_UNKNOWN_LINE. Does not modify the document. Next: check_piping for the issues; route_pipe / insert_inline_component / add_branch to change the route.',
  annotations: { readOnly: true, idempotent: true },
  params: z.object({
    runId: z.string().optional().describe('One run (affected[0] of route_pipe).'),
    lineId: z.string().optional().describe('Every run of one line (affected[0] of create_pipeline).'),
  }),
  run: (doc, { runId, lineId }): CommandResult => {
    const piping = getPiping(doc);
    if (runId !== undefined && piping.runs[runId] === undefined)
      return refuse(doc, 'piping_takeoff', 'RTE_UNKNOWN_RUN', `no pipe run "${runId}"`, [], ['runId']);
    if (lineId !== undefined && piping.lines[lineId] === undefined)
      return refuse(doc, 'piping_takeoff', 'RTE_UNKNOWN_LINE', `no pipe line "${lineId}"`, [], ['lineId']);
    const ids = piping.runOrder.filter(
      (id) => (runId === undefined || id === runId) && (lineId === undefined || piping.runs[id]?.lineId === lineId),
    );
    const runs: TakeoffRun[] = [];
    const brokenRuns: Array<{ runId: string; code: string; message: string }> = [];
    for (const id of ids) {
      const run = piping.runs[id];
      if (run === undefined) continue;
      const derivation = deriveRun(doc, run);
      if (!derivation.ok) {
        if (runId !== undefined)
          return refuse(
            doc,
            'piping_takeoff',
            derivation.code,
            `run ${id}: ${derivation.message}`,
            [id, ...derivation.ids],
            [...derivation.paths],
            derivation.detail,
          );
        brokenRuns.push({ runId: id, code: derivation.code, message: derivation.message });
        continue;
      }
      runs.push({ runId: id, derivation });
    }
    const takeoff = takeoffOf(runs);
    return report(
      doc,
      `piping_takeoff: ${runs.length} run(s)${brokenRuns.length === 0 ? '' : ` (${brokenRuns.length} broken skipped: ${brokenRuns.map((run) => `${run.runId} ${run.code}`).join(', ')})`}, ${takeoff.pipePieces.length} pipe piece(s) totalling ${takeoff.totalPipeMm} mm, centreline ${takeoff.centrelineLengthMm} mm, ` +
        `${takeoff.joints.length} joint(s), ${takeoff.studs} stud(s)${takeoff.unverified ? `; unverified: ${takeoff.unverifiedReasons.join('; ')}` : ''}.`,
      { runs: runs.map((run) => run.runId), brokenRuns, ...takeoff, insulation: insulationTakeoff(piping, runs) },
    );
  },
});
