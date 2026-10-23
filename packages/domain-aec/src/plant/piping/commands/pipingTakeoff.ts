import { defineCommand, z } from '@core/commands/schema';
import type { CommandResult } from '@core/commands/types';
import { report } from '@core/commands/noop';
import { getPiping, refuse } from '../model';
import { deriveRun } from '../routeParts';
import { takeoffOf, type TakeoffRun } from '../takeoff';

/**
 * @affects none (query: returns the same document; results in `data`)
 * @invariant derived afresh from the stored runs and the current spec (nothing stored); the cut lengths are the ones route_pipe reported
 * @failure unknown run / line -> RTE_UNKNOWN_RUN / RTE_UNKNOWN_LINE; a run that no longer derives -> its RTE_* code (spec, port, angle, short leg)
 */
export const pipingTakeoff = defineCommand({
  name: 'piping_takeoff',
  description:
    'Query: bill of materials and cut list of routed pipe, derived from the stored runs and their spec: part counts by key (elbow90LR, flangeWeldNeck, ' +
    'gasketSpiralWound, boltSet ...), pipePieces (cutLengthMm per straight piece, leg index), joints (buttWeld, flanged, fittingToFitting, with ' +
    'position and gap), studs, totalPipeMm, centrelineLengthMm (legs - 2 x centre-to-end + arcs), legs and turns (angle, nominal angle, ' +
    'deviationDeg, centreToEnd), warnings and unverified (spec not approved or catalogue rows not grade A, with reasons). Lengths in mm. Give runId ' +
    'or lineId; with neither, every run is counted. Refusals: RTE_UNKNOWN_RUN, RTE_UNKNOWN_LINE, or the RTE_* code of a run that no longer ' +
    'derives. Does not modify the document. Next: route_pipe to change the route; check_piping comes with 02 M2.',
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
    for (const id of ids) {
      const run = piping.runs[id];
      if (run === undefined) continue;
      const derivation = deriveRun(doc, run);
      if (!derivation.ok)
        return refuse(
          doc,
          'piping_takeoff',
          derivation.code,
          `run ${id}: ${derivation.message}`,
          [id, ...derivation.ids],
          [...derivation.paths],
          derivation.detail,
        );
      runs.push({ runId: id, derivation });
    }
    const takeoff = takeoffOf(runs);
    return report(
      doc,
      `piping_takeoff: ${runs.length} run(s), ${takeoff.pipePieces.length} pipe piece(s) totalling ${takeoff.totalPipeMm} mm, centreline ${takeoff.centrelineLengthMm} mm, ` +
        `${takeoff.joints.length} joint(s), ${takeoff.studs} stud(s)${takeoff.unverified ? `; unverified: ${takeoff.unverifiedReasons.join('; ')}` : ''}.`,
      { runs: ids, ...takeoff },
    );
  },
});
