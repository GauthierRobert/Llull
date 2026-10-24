import { defineCommand, z } from '@core/commands/schema';
import type { CommandResult } from '@core/commands/types';
import { changed } from '@core/commands/noop';
import { execute } from '@core/commands/registry';
import type { Vec3 } from '@core/model/vectors';
import type { PipeLine, PipeRun } from '@aec/plant/types';
import { dot3, sub3 } from '@lib/vec3';
import { nextId } from '@lib/id';
import { getBuilding } from '../../../building/model';
import { pipeSizeByOutsideDiameter } from '../../../industrial/piping/pipeSizes';
import { withRunEntities } from '../derive';
import { chooseElbow, turnAngleDeg } from '../fittings';
import { buildPath, unitVector } from '../legs';
import { getPiping, refuse, withPiping } from '../model';
import { deriveRun } from '../routeParts';
import { createSpecLookup, isMiss } from '../specLookup';
import { takeoffOf } from '../takeoff';

/**
 * @affects creates 1 pipe run (and 1 pipe line unless lineId is given) from a legacy building pipe; with `replace` deletes the legacy pipe
 *   (and the pipe supports hosted by it) from the building model
 * @invariant the polyline vertices become the points of intersection (collinear ones merge), world z = level elevation + vertex z; the line number is
 *   the legacy `line` text verbatim; both run ends are open; parts, cut lengths and welds are derived from the spec exactly as for route_pipe
 * @failure unknown pipe -> RTE_UNKNOWN_PIPE; unknown spec / line -> RTE_SPEC_UNKNOWN / RTE_UNKNOWN_LINE; no DN -> RTE_SIZE_MISMATCH; a bend no spec elbow
 *   fits -> RTE_NO_FITTING_FOR_ANGLE (detail.vertices); line number used -> RTE_DUPLICATE_LINE_NUMBER; leg too short -> RTE_SEGMENT_TOO_SHORT
 */
export const convertPipeRun = defineCommand({
  name: 'convert_pipe_run',
  description:
    'Convert a legacy pipe (building element from add_pipe_run: a polyline with a diameter, no fittings) into a spec-driven pipe run: the vertices become ' +
    'the points of intersection (collinear vertices merge; z is the level elevation + the vertex z), every bend gets the spec elbow, every straight ' +
    'piece its cut length, and both ends stay open (connect them later by routing from "<runId>:start|end" or compare with check_piping, which lists ' +
    'them as RTE_OPEN_END). A pipe line is created with the legacy line number verbatim (or the template DN-service-sequence-spec when the pipe has ' +
    'none), the legacy service, from and to text and size (the pipe dn, else the DN of its diameter in the pipe size table); pass lineId to put the run on ' +
    'an existing line instead (its spec is used and spec may be omitted). The legacy pipe stays unless replace is true, which deletes it with the pipe ' +
    'supports hosted on it (delete_building_element); keep it to compare, but its geometry then overlaps the run. Returns the run id (affected[0]) and ' +
    'the line id; data = { runId, lineId, lineNumber, lineCreated, dn, dnSource, spec, pis, legs, turns, counts, pipePieces, totalPipeMm, ' +
    'centrelineLengthMm, warnings, unverified, unverifiedReasons, replaced }. Refusals: RTE_UNITS_UNSUPPORTED, RTE_UNKNOWN_PIPE, RTE_UNKNOWN_LINE, ' +
    'RTE_SPEC_UNKNOWN, RTE_SIZE_MISMATCH, RTE_DUPLICATE_LINE_NUMBER, RTE_NO_FITTING_FOR_ANGLE (detail.vertices lists the vertex indices and angles of ' +
    'every bend with no spec elbow), RTE_ZERO_LEG, RTE_SEGMENT_TOO_SHORT, RTE_SPEC_NO_COMPONENT. Next: piping_takeoff, check_piping.',
  params: z.object({
    pipeId: z.string().describe('Id of the legacy pipe: the building element id (affected[0] of add_pipe_run, e.g. "pipe-3").'),
    spec: z
      .string()
      .min(1)
      .optional()
      .describe("Id of the piping spec to build the run from (import_pipe_spec), e.g. 'CS150'. Required unless lineId is given."),
    lineId: z
      .string()
      .optional()
      .describe('Existing pipe line to put the run on (its spec and size must suit the pipe). Default: a new line.'),
    replace: z.boolean().optional().describe('Delete the legacy pipe (and its hosted pipe supports) after converting. Default false.'),
  }),
  run: (doc, params, ctx): CommandResult => {
    if (doc.units !== 'mm')
      return refuse(
        doc,
        'convert_pipe_run',
        'RTE_UNITS_UNSUPPORTED',
        `plant lengths and catalogue dimensions are mm; this document is in ${doc.units}`,
      );
    const building = getBuilding(doc);
    const pipe = building.elements[params.pipeId];
    if (pipe === undefined || pipe.category !== 'pipe')
      return refuse(doc, 'convert_pipe_run', 'RTE_UNKNOWN_PIPE', `no legacy pipe "${params.pipeId}" in the building model`, [], ['pipeId']);
    const piping = getPiping(doc);
    const existing = params.lineId === undefined ? undefined : piping.lines[params.lineId];
    if (params.lineId !== undefined && existing === undefined)
      return refuse(doc, 'convert_pipe_run', 'RTE_UNKNOWN_LINE', `no pipe line "${params.lineId}"`, [], ['lineId']);
    const specId = existing?.spec ?? params.spec;
    if (specId === undefined)
      return refuse(doc, 'convert_pipe_run', 'RTE_SPEC_UNKNOWN', 'give spec (or lineId of a line that has one)', [], ['spec']);
    const lookup = createSpecLookup(doc, specId);
    if (isMiss(lookup)) return refuse(doc, 'convert_pipe_run', lookup.miss, lookup.detail, [...lookup.ids], ['spec']);
    const fromDiameter = pipe.dn === undefined ? pipeSizeByOutsideDiameter(pipe.diameter)?.[0] : undefined;
    const dn = existing?.dn ?? pipe.dn ?? fromDiameter;
    if (dn === undefined)
      return refuse(
        doc,
        'convert_pipe_run',
        'RTE_SIZE_MISMATCH',
        `the legacy pipe has no dn and its diameter ${pipe.diameter} mm matches no DN in the pipe size table`,
        [pipe.id],
        ['pipeId'],
      );
    if (existing !== undefined && pipe.dn !== undefined && pipe.dn !== existing.dn)
      return refuse(
        doc,
        'convert_pipe_run',
        'RTE_SIZE_MISMATCH',
        `the legacy pipe is DN${pipe.dn}, line ${existing.id} is DN${existing.dn}`,
        [pipe.id, existing.id],
        ['lineId'],
      );
    const elevation = building.levels[pipe.levelId]?.elevation ?? 0;
    const world = pipe.points.map((point): Vec3 => [point[0], point[1], point[2] + elevation]);
    const tolerance = lookup.elbowAngles().toleranceDeg;
    // Every bend must have a spec elbow: list them all, not only the first.
    const unfit: Array<{ vertex: number; angleDeg: number }> = [];
    for (let i = 1; i + 1 < world.length; i++) {
      const [before, after] = [
        unitVector(sub3(world[i] as Vec3, world[i - 1] as Vec3)),
        unitVector(sub3(world[i + 1] as Vec3, world[i] as Vec3)),
      ];
      if (dot3(before, after) > 1 - 1e-12) continue;
      const choice = chooseElbow(lookup, dn, turnAngleDeg(before, after), tolerance);
      if ('code' in choice) unfit.push({ vertex: i, angleDeg: turnAngleDeg(before, after) });
    }
    if (unfit.length > 0)
      return refuse(
        doc,
        'convert_pipe_run',
        'RTE_NO_FITTING_FOR_ANGLE',
        `bend(s) at vertex ${unfit.map((bend) => `${bend.vertex} (${+bend.angleDeg.toFixed(4)} deg)`).join(', ')} have no spec elbow (angles ${lookup.elbowAngles().anglesDeg.join(', ')} deg, tolerance ${tolerance} deg)`,
        [pipe.id],
        unfit.map((bend) => `points.${bend.vertex}`),
        {
          vertices: unfit.map((bend) => bend.vertex),
          anglesDegAtVertices: unfit.map((bend) => bend.angleDeg),
          anglesDeg: lookup.elbowAngles().anglesDeg,
          toleranceDeg: tolerance,
        },
      );
    const path = buildPath({ point: world[0] as Vec3 }, undefined, [], world.slice(1), tolerance);
    if (!path.ok)
      return refuse(
        doc,
        'convert_pipe_run',
        path.code,
        path.message,
        [pipe.id],
        path.paths.map((p) => p.replace('via', 'points')),
        path.detail,
      );
    const lineNumber = pipe.line ?? `${dn}-${pipe.service}-${pipe.mark}-${specId}`;
    const clash = piping.lineOrder.find((id) => piping.lines[id]?.lineNumber === lineNumber);
    if (existing === undefined && clash !== undefined)
      return refuse(
        doc,
        'convert_pipe_run',
        'RTE_DUPLICATE_LINE_NUMBER',
        `line number ${lineNumber} is used by ${clash}; pass lineId: "${clash}" to put the run on that line`,
        [clash, pipe.id],
        ['lineId'],
      );
    const line: PipeLine =
      existing ??
      ({
        id: nextId('line'),
        lineNumber,
        service: pipe.service,
        sequence: pipe.line ?? pipe.mark,
        spec: specId,
        dn,
        ...(pipe.from === undefined ? {} : { from: pipe.from }),
        ...(pipe.to === undefined ? {} : { to: pipe.to }),
      } satisfies PipeLine);
    const runId = nextId('run');
    const run: PipeRun = {
      id: runId,
      lineId: line.id,
      start: { point: path.points[0] as Vec3 },
      end: { point: path.points.at(-1) as Vec3 },
      pis: path.points.slice(1, -1),
    };
    const lines = existing === undefined ? { ...piping.lines, [line.id]: line } : piping.lines;
    const lineOrder = existing === undefined ? [...piping.lineOrder, line.id] : piping.lineOrder;
    const stored = withPiping(doc, {
      ...piping,
      lines,
      lineOrder,
      runs: { ...piping.runs, [runId]: run },
      runOrder: [...piping.runOrder, runId],
    });
    const derived = deriveRun(stored, run);
    if (!derived.ok)
      return refuse(doc, 'convert_pipe_run', derived.code, derived.message, [...derived.ids], [...derived.paths], derived.detail);
    let result = withRunEntities(stored, runId);
    let removed: string[] = [];
    if (params.replace === true) {
      const deleted = execute(result, 'delete_building_element', { elementIds: [pipe.id] }, ctx);
      result = deleted.document;
      removed = deleted.affected;
    }
    const takeoff = takeoffOf([{ runId, derivation: derived }]);
    return {
      ...changed(
        result,
        `convert_pipe_run: legacy pipe ${pipe.mark} (${pipe.id}) -> run ${runId} on ${existing === undefined ? 'new ' : ''}line ${line.id} ${line.lineNumber} DN${dn} spec ${specId}: ` +
          `${derived.turns.length} elbow(s), ${takeoff.pipePieces.length} pipe piece(s) ${JSON.stringify(takeoff.pipePieces.map((piece) => piece.cutLengthMm))} totalling ${takeoff.totalPipeMm} mm, ` +
          `${takeoff.counts['buttWelds'] ?? 0} butt weld(s), 2 open ends${params.replace === true ? `; legacy pipe deleted (${removed.length} id(s))` : '; legacy pipe kept'}` +
          `${derived.unverified ? `; unverified: ${derived.unverifiedReasons.join('; ')}` : ''}.`,
        [runId, ...(existing === undefined ? [line.id] : []), ...removed],
      ),
      data: {
        runId,
        lineId: line.id,
        lineNumber: line.lineNumber,
        lineCreated: existing === undefined,
        dn,
        dnSource: pipe.dn !== undefined || existing !== undefined ? 'legacy pipe / line' : `pipe size table, diameter ${pipe.diameter} mm`,
        spec: derived.spec,
        pis: run.pis,
        legs: takeoff.legs.map((leg) => ({
          index: leg.index,
          direction: leg.direction,
          lengthMm: leg.lengthMm,
          cutLengthsMm: leg.cutLengthsMm,
        })),
        turns: takeoff.turns.map((turn) => ({
          index: turn.index,
          turnDeg: turn.turnDeg,
          nominalDeg: turn.nominalDeg,
          deviationDeg: turn.deviationDeg,
        })),
        counts: takeoff.counts,
        pipePieces: takeoff.pipePieces.map((piece) => ({ id: piece.id, leg: piece.leg, cutLengthMm: piece.cutLengthMm })),
        totalPipeMm: takeoff.totalPipeMm,
        centrelineLengthMm: takeoff.centrelineLengthMm,
        warnings: takeoff.warnings,
        unverified: takeoff.unverified,
        unverifiedReasons: takeoff.unverifiedReasons,
        replaced: params.replace === true,
      },
    };
  },
});
