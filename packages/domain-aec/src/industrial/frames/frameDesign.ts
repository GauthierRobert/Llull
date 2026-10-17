/** Portal frame design: iterative up-sizing of frame sections and sizing of moment-connection bolt groups against check_portal_frames. */
import type { CommandResult } from '@core/commands/types';
import { defineCommand, z } from '@core/commands/schema';
import { getBuilding } from '../../building/model';
import { noop } from '@core/commands/noop';
import { regenerateBuilding } from '../../building/evaluate/evaluateElements';
import { designFixedPlates } from '../connections/plateDesign';
import { isValidTargetUtilisation, targetUtilisationParam } from '../common/profileGroups';
import { describeLoads, FRAME_LOAD_SHAPE, resolveFrameLoads } from './frameLoadParams';
import { sizeBoltGroups } from '../connections/frameBoltDesign';
import { checkFrames } from './frameCheckFrames';
import { frameMassKg, scoreRows, sizeFrames, withFixedBases } from './frameDesignLoop';
import { designResult, finalUtilisationText, noChangeResult, utilisationStats } from '../reports/designReport';

/** Fixed bases replace a passing sway-governed pinned design only when the frames weigh less than this fraction of it. */
const FIXED_BASE_MASS_GAIN = 0.75;

/**
 * @affects up-sizes failing rafter / column profiles (all members of that role and section on the
 *          level, keeping frames uniform) and sizes the bolt groups of every moment connection
 * @failure bad loads / unknown level / no frame / no section large enough -> no-op or partial report
 */
export const designPortalFrames = defineCommand({
  name: 'design_portal_frames',
  description:
    'Preliminary design of the portal frames of a level with the same loads, combinations and checks as check_portal_frames (strength, ' +
    'buckling, sway stability, SLS deflections): repeatedly analyses the frames and up-sizes the rafter / column sections that exceed ' +
    'targetUtilisation (uniformly for all frames) — strength / buckling failures to the next heavier profile of the same family, sway and ' +
    'stability failures (column-stiffness driven) by up-sizing the columns only to the section whose inertia the sway ratio asks for, with ' +
    'fixed column bases tried when pinned bases cannot pass (allowFixedBases) — then sizes the bolt groups of the ' +
    'moment connections (bolt diameter M20–M30 and rows) per connection type for every combination. Reports every change and the final ' +
    'utilisations.',
  params: z.object({
    ...FRAME_LOAD_SHAPE,
    targetUtilisation: targetUtilisationParam,
    allowFixedBases: z
      .boolean()
      .optional()
      .describe(
        "Default true: when sway (crane h/400, wind h/150, αcr) governs the pinned-base design, it is repeated with the base plates of the frame columns set to 'fixed' (fixed bases make the columns up to ~4x stiffer against sway) and the fixed design is kept if it passes where pinned does not, or weighs under 75 % of it (the footings then carry base moments: run design_footings). False keeps the base fixity as modelled.",
      ),
  }),
  run: (doc, params): CommandResult => {
    const { targetUtilisation = 0.95, allowFixedBases = true } = params;
    if (!isValidTargetUtilisation(targetUtilisation))
      return noop(doc, 'design_portal_frames failed: targetUtilisation must be in [0.5, 1].');
    const resolved = resolveFrameLoads(doc, params);
    if ('reason' in resolved) return noop(doc, `design_portal_frames failed: ${resolved.reason}.`);
    const { loads, levelId } = resolved;
    const pinned = sizeFrames(doc, levelId, loads, targetUtilisation);
    if (pinned.noFrames) return noop(doc, 'design_portal_frames failed: no analysable portal frame on the level.');
    // Sway is column-stiffness driven: fixed bases (4x stiffer than pinned under a rigid rafter) are tried when pinned bases fail, or cost
    // much more steel than fixed ones.
    let sizing = pinned;
    let baseNote = '';
    const pinnedRows = pinned.settledRows ?? checkFrames(pinned.current, levelId, loads).rows;
    const pinnedScore = scoreRows(pinnedRows, targetUtilisation);
    const columnIds = new Set(pinnedRows.filter((row) => row.kind === 'column').map((row) => row.elementId));
    const fixedStart = allowFixedBases && (pinnedScore.failing > 0 || pinned.swayDriven) ? withFixedBases(doc, levelId, columnIds) : null;
    if (fixedStart) {
      const fixed = sizeFrames(fixedStart.doc, levelId, loads, targetUtilisation);
      const fixedScore = scoreRows(fixed.settledRows ?? checkFrames(fixed.current, levelId, loads).rows, targetUtilisation);
      const [pinnedKg, fixedKg] = [frameMassKg(pinned.current, pinned.analysed), frameMassKg(fixed.current, fixed.analysed)];
      const better =
        pinnedScore.failing > 0
          ? fixedScore.failing < pinnedScore.failing || (fixedScore.failing === pinnedScore.failing && fixedScore.max < pinnedScore.max)
          : fixedScore.failing === 0 && fixedKg < FIXED_BASE_MASS_GAIN * pinnedKg;
      if (better) {
        sizing = fixed;
        for (const id of fixedStart.plateIds) sizing.changed.add(id);
        sizing.changes.unshift(`column bases pinned → fixed (${fixedStart.plateIds.length} plate(s))`);
        baseNote =
          ` Sway governed the pinned-base design (${pinnedScore.failing} check(s) failing, max ${pinnedScore.max.toFixed(2)}, frames ${(pinnedKg / 1000).toFixed(1)} t); ` +
          `fixed bases: max ${fixedScore.max.toFixed(2)}, frames ${(fixedKg / 1000).toFixed(1)} t. ` +
          'The footings now carry base moments: re-run design_footings / check_foundations.';
      }
    }
    const { current, changes, changed, analysed } = sizing;
    let { limited } = sizing;
    const rows = sizing.settledRows ?? checkFrames(current, levelId, loads).rows;
    const bolts = sizeBoltGroups(current, getBuilding(current), rows, targetUtilisation);
    let building = bolts.building;
    changes.push(...bolts.changes);
    for (const id of bolts.changed) changed.add(id);
    if (bolts.limited) limited = true;
    const plates = designFixedPlates(current, building, levelId, loads, targetUtilisation);
    building = plates.building;
    if (plates.changed.length > 0) changes.push(...plates.descriptions);
    for (const id of plates.changed) changed.add(id);
    if (plates.unresolved > 0) limited = true;
    if (changed.size === 0) {
      const final = checkFrames(doc, levelId, loads);
      return noChangeResult(doc, `${final.frames} frame(s)`, final.rows, limited);
    }
    const document = regenerateBuilding(doc, building);
    const final = checkFrames(document, levelId, loads);
    const unanalysedPosts = Object.values(building.elements).some(
      (element) => element.category === 'member' && element.levelId === levelId && element.role === 'column' && !analysed.has(element.id),
    );
    const stats = utilisationStats(final.rows);
    return designResult(
      document,
      `Designed ${final.frames} frame(s) for ${final.combinations.length} ULS combination(s) + SLS (${describeLoads(loads)}): ` +
        `${changes.length > 0 ? changes.join('; ') : 'no change needed'}. ${finalUtilisationText(stats, 'element(s)', limited)}${baseNote} Frames ` +
        `only (verify bracing, foundations and runways with their checks)${unanalysedPosts ? '; gable posts are not analysed' : ''}.`,
      changed,
      changes,
      stats,
    );
  },
});
