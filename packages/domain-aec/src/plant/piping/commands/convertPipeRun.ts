import { defineCommand, z } from '@core/commands/schema';
import type { CommandResult } from '@core/commands/types';
import { changed } from '@core/commands/noop';
import { withRunEntities } from '../derive';
import { takeoffOf } from '../takeoff';
import { type SupportFollow } from '../supportReconcile';
import type { PipeSupportElement } from '@aec/building/types';
import { buildRun, isRefused, replaceLegacy, resolveLegacy, straightenBends } from './convertPipeRunPhases';

/** One sentence for the summary: the supports that moved onto the run, then how they re-attached (the attach note of followCarrier). */
function supportSentence(follow: SupportFollow): string {
  const moved = follow.moved.map(({ support, by }) => `${support.mark} ${+by.toFixed(3)} mm`).join(', ');
  return [moved === '' ? 'pipe supports already on the run' : `pipe supports moved onto the run: ${moved}`, ...follow.notes.slice(1)].join(
    '. ',
  );
}

/** The support facts of a conversion: what moved onto the run, what re-attached or detached (empty when none was hosted). */
function supportData(hosted: ReadonlyArray<PipeSupportElement>, follow: SupportFollow | undefined): Record<string, unknown> {
  return {
    count: hosted.length,
    ids: hosted.map((support) => support.id),
    maxOffsetMm: follow?.moved.reduce((max, { by }) => Math.max(max, by), 0) ?? 0,
    moved: follow?.moved.map(({ support, by }) => ({ id: support.id, mark: support.mark, offsetMm: by })) ?? [],
    reattached: follow?.reconciliation.reattached ?? [],
    detached: follow?.reconciliation.detached ?? [],
    kept: follow?.reconciliation.kept ?? [],
  };
}

/**
 * @affects creates 1 pipe run (and 1 pipe line unless lineId is given) from a legacy building pipe; with `replace` deletes the legacy pipe from the building model after
 *   moving its pipe supports onto the run (snapped to the nearest point of the new centreline, re-attached to steel; V1c)
 * @invariant the polyline vertices become the points of intersection (vertices that bend by no more than the spec angle tolerance merge), world z = level elevation + vertex z; the line number is
 *   the legacy `line` text verbatim; both run ends are open; parts, cut lengths and welds are derived from the spec exactly as for route_pipe
 * @failure replace with a support farther than one run outside diameter from the new centreline -> RTE_SUPPORT_OFF_RUN (nothing converted); unknown pipe -> RTE_UNKNOWN_PIPE; unknown spec / line -> RTE_SPEC_UNKNOWN / RTE_UNKNOWN_LINE; no DN -> RTE_SIZE_MISMATCH; a bend no spec elbow
 *   fits -> RTE_NO_FITTING_FOR_ANGLE (detail.vertices); line number used -> RTE_DUPLICATE_LINE_NUMBER; leg too short -> RTE_SEGMENT_TOO_SHORT
 */
export const convertPipeRun = defineCommand({
  name: 'convert_pipe_run',
  description:
    'Convert a legacy pipe (building element from add_pipe_run: a polyline with a diameter, no fittings) into a spec-driven pipe run: the vertices become ' +
    'the points of intersection (a vertex that bends by no more than the spec elbow-angle tolerance, 1 deg for CS150, is straight pipe and merges; z is the level elevation + the vertex z), every bend gets the spec elbow (a bend no spec angle fits becomes a trimmed 90 elbow or a pipe bend when the spec allows: trimmedAllowed / bendRadiusD, flagged RTE_NONSTANDARD_FITTING), every straight ' +
    'piece its cut length, and both ends stay open (connect them later by routing from "<runId>:start|end" or compare with check_piping, which lists ' +
    'them as RTE_OPEN_END). A pipe line is created with the legacy line number verbatim (or the template DN-service-sequence-spec when the pipe has ' +
    'none), the legacy service, from and to text and size (the pipe dn, else the DN of its diameter in the pipe size table); pass lineId to put the run on ' +
    'an existing line instead (its spec is used and spec may be omitted). The legacy pipe stays unless replace is true, which deletes it after moving its pipe supports onto the run: each support is snapped to the nearest point of the new centreline (the conversion straightens vertices, so a support may shift by up to straightenedMaxOffsetMm), re-attached to the steel in reach (kept, re-attached or DETACHED, as add_pipe_support reports) and ' +
    'keeps its mark; a support farther than one pipe outside diameter from the new centreline cannot sit on the run and the whole conversion is refused (RTE_SUPPORT_OFF_RUN). Keep the legacy pipe to compare, but its geometry then overlaps the run. Returns the run id (affected[0]) and ' +
    'the line id; data = { runId, lineId, lineNumber, lineCreated, dn, dnSource, spec, pis, legs, turns, counts, pipePieces, totalPipeMm, ' +
    'centrelineLengthMm, warnings, unverified, unverifiedReasons, mergedPoints (vertices merged as straight), straightenedMaxOffsetMm (the largest ' +
    'sideways distance of a merged vertex from the straightened leg, 0 when none: the geometry the conversion moved), replaced, supports { count, ids, maxOffsetMm, moved [{ id, mark, offsetMm }], reattached [{ id, mark, from, to }], detached [{ id, mark, from }], kept [mark] } (supports moved onto the run when replace) }. Refusals: RTE_UNITS_UNSUPPORTED, RTE_UNKNOWN_PIPE, RTE_SUPPORT_OFF_RUN (replace, a support of the pipe more than one outside diameter from the new centreline; detail lists them), RTE_UNKNOWN_LINE, ' +
    'RTE_SPEC_UNKNOWN, RTE_SIZE_MISMATCH, RTE_DUPLICATE_LINE_NUMBER, RTE_NO_FITTING_FOR_ANGLE (detail.vertices lists the vertex indices and angles of ' +
    'every bend with no spec elbow, trimmed elbow or bend), RTE_ZERO_LEG, RTE_SEGMENT_TOO_SHORT, RTE_SPEC_NO_COMPONENT. Next: piping_takeoff, check_piping.',
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
    replace: z
      .boolean()
      .optional()
      .describe(
        'Delete the legacy pipe after converting; its pipe supports move onto the run (refused with RTE_SUPPORT_OFF_RUN when one cannot sit on it). Default false.',
      ),
  }),
  run: (doc, params, ctx): CommandResult => {
    const legacy = resolveLegacy(doc, params);
    if (isRefused(legacy)) return legacy.refused;
    const { pipe, existing, specId, dn, hosted } = legacy;
    const straight = straightenBends(doc, legacy);
    if (isRefused(straight)) return straight.refused;
    const built = buildRun(doc, legacy, straight);
    if (isRefused(built)) return built.refused;
    const { path, line, run, runId, derived } = built;
    let result = withRunEntities(built.stored, runId);
    let removed: string[] = [];
    let followed: SupportFollow | undefined;
    if (params.replace === true) {
      const replaced = replaceLegacy(doc, legacy, built, result, ctx);
      if (isRefused(replaced)) return replaced.refused;
      ({ result, removed, followed } = replaced);
    }
    const takeoff = takeoffOf([{ runId, derivation: derived }]);
    return {
      ...changed(
        result,
        `convert_pipe_run: legacy pipe ${pipe.mark} (${pipe.id}) -> run ${runId} on ${existing === undefined ? 'new ' : ''}line ${line.id} ${line.lineNumber} DN${dn} spec ${specId}: ` +
          `${derived.turns.length} elbow(s), ${takeoff.pipePieces.length} pipe piece(s) ${JSON.stringify(takeoff.pipePieces.map((piece) => piece.cutLengthMm))} totalling ${takeoff.totalPipeMm} mm, ` +
          `${takeoff.counts['buttWelds'] ?? 0} butt weld(s), 2 open ends${params.replace === true ? `; legacy pipe deleted (${removed.length} id(s))` : '; legacy pipe kept'}` +
          `${followed === undefined ? '' : `; ${supportSentence(followed)}`}` +
          `${derived.unverified ? `; unverified: ${derived.unverifiedReasons.join('; ')}` : ''}.`,
        [runId, ...(existing === undefined ? [line.id] : []), ...(followed?.affected ?? []), ...removed],
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
        mergedPoints: straight.mergedCount + path.merged,
        straightenedMaxOffsetMm: straight.straightenedMaxOffsetMm,
        replaced: params.replace === true,
        supports: supportData(hosted, followed),
      },
    };
  },
});
