/**
 * @layer domain-aec
 */

import type { CadDocument, Vec2, Vec3 } from '@core/model/types';
import type { BuildingModel, GridElement, SteelMemberElement } from '@core/model/building';
import type { CommandResult } from '@core/commands/types';
import { defineCommand, z } from '@core/commands/schema';
import { noop } from '@core/commands/noop';
import { elementAffected, elementsOf, fromMm, getBuilding, resolveLevel, toMetres } from '../model';
import { regenerateBuilding } from '../evaluateElements';
import { findProfile } from '../steel/profiles';
import {
  appendMembers,
  baseFixitySchema,
  jointFixitySchema,
  profileSummary,
  type MemberSpec,
} from './memberSupport';
import {
  crossGridLines,
  crossingsOnLine,
  gridLinesOf,
  parseCrossingName,
  samePlanPoint,
  unknownLabels,
} from './gridFraming';
import { levelIdParam } from '../levelParams';

/** Length text with a precision suited to the unit: whole mm, otherwise up to 3 decimals. */
const lengthText = (doc: Pick<CadDocument, 'units'>, value: number): string =>
  `${doc.units === 'mm' ? value.toFixed(0) : String(Math.round(value * 1000) / 1000)} ${doc.units}`;

const tonnes = (kg: number): string => (kg / 1000).toFixed(1);

const profileText = (profile: string): string => {
  const section = findProfile(profile);
  return section ? profileSummary(section) : profile;
};

interface FramingSetup {
  building: BuildingModel;
  levelId: string;
  levelName: string;
  elevation: number;
  height: number;
  lines: GridElement[];
  tolerance: number;
}

function setup(
  doc: CadDocument,
  tool: string,
  {
    profile,
    levelId,
    axes,
  }: { profile: string; levelId?: string | undefined; axes?: string[] | undefined },
): FramingSetup | string {
  if (!findProfile(profile)) {
    return `${tool} failed: unknown steel profile '${profile}' (see list_steel_profiles).`;
  }
  const resolution = resolveLevel(doc, getBuilding(doc), levelId);
  if (!resolution.ok) return `${tool} failed: ${resolution.reason}.`;
  const lines = gridLinesOf(resolution.building);
  if (lines.length < 2) {
    return `${tool} failed: needs at least 2 grid lines (add_grid_line); the building has ${lines.length}.`;
  }
  const bad = unknownLabels(lines, axes ?? []);
  if (bad.length > 0) return `${tool} failed: unknown grid axis label(s) ${bad.join(', ')}.`;
  const { level } = resolution;
  return {
    building: resolution.building,
    levelId: level.id,
    levelName: level.name,
    elevation: level.elevation,
    height: level.height,
    lines,
    tolerance: fromMm(doc, 1),
  };
}

function commit(
  doc: CadDocument,
  tool: string,
  building: BuildingModel,
  levelId: string,
  specs: MemberSpec[],
): { document: CadDocument; ids: string[] } | string {
  const added = appendMembers(building, levelId, specs);
  if ('reason' in added) return `${tool} failed: ${added.reason}.`;
  return { document: regenerateBuilding(doc, added.building), ids: added.ids };
}

const selected = (
  lines: ReadonlyArray<GridElement>,
  axes: ReadonlyArray<string> | undefined,
): GridElement[] =>
  axes === undefined ? [...lines] : lines.filter((line) => axes.includes(line.mark));

/**
 * @command add_grid_columns
 * @pure
 * @affects creates one column member per grid intersection (exact section meshes)
 * @invariant skips intersections already holding a column on the level or a column of any level whose vertical span covers the base level elevation (same plan xy, 1 mm)
 * @failure no grid / unknown profile, axis, level / topLevel not above base / no intersections -> no-op
 */
export const addGridColumns = defineCommand({
  name: 'add_grid_columns',
  description:
    'Place one vertical steel column at every intersection of the structural grid (add_grid_line): the ' +
    'way to start framing a building. The column runs from the base level FFL up to topLevelId (a ' +
    'continuous column through intermediate floors) or, by default, to the top of the base level. ' +
    'Restrict with axes (both crossing lines must be listed) and exclude. Intersections that already ' +
    'hold a column on that level, or a continuous column from a lower level passing through it, are skipped. Mark SC, role column; follow with add_grid_beams / add_grid_bracing.',
  params: z.object({
    profile: z.string().describe('Catalogue section name, e.g. "HEB300" (list_steel_profiles).'),
    levelId: levelIdParam.describe(
      'Base level id: columns start at its finished floor level. Default: the active level.',
    ),
    topLevelId: z
      .string()
      .optional()
      .describe(
        'Level id whose FFL is the column top; must be above the base level. Default: base level elevation + base level height.',
      ),
    axes: z
      .array(z.string())
      .optional()
      .describe(
        'Grid line labels (e.g. ["A","B","1","2"]); an intersection is used only when BOTH its lines are listed. Default: all grid lines.',
      ),
    exclude: z
      .array(z.string())
      .optional()
      .describe(
        'Intersections to skip, written "A/1" (the order of the two labels does not matter).',
      ),
    roll: z
      .number()
      .optional()
      .describe('Section rotation about the vertical axis, radians. Default 0.'),
    baseFixity: baseFixitySchema
      .optional()
      .describe(
        '"pinned" (default) or "fixed": the column foot restrains rotation in check_steel_members.',
      ),
    material: z.string().optional().describe('Steel grade. Default S355.'),
  }),
  run: (doc, params): CommandResult => {
    const tool = 'add_grid_columns';
    const prepared = setup(doc, tool, params);
    if (typeof prepared === 'string') return noop(doc, prepared);
    const { building, lines, tolerance } = prepared;
    const excluded: Array<[string, string]> = [];
    for (const name of params.exclude ?? []) {
      const pair = parseCrossingName(name);
      if (!pair) return noop(doc, `${tool} failed: exclude entry '${name}' must look like "A/1".`);
      const unknown = unknownLabels(lines, pair);
      if (unknown.length > 0) {
        return noop(
          doc,
          `${tool} failed: exclude '${name}' has unknown grid label(s) ${unknown.join(', ')}.`,
        );
      }
      excluded.push(pair);
    }
    let top = prepared.height;
    if (params.topLevelId !== undefined) {
      const topLevel = building.levels[params.topLevelId];
      if (!topLevel) return noop(doc, `${tool} failed: unknown top level '${params.topLevelId}'.`);
      top = topLevel.elevation - prepared.elevation;
      if (!(top > 0)) {
        return noop(
          doc,
          `${tool} failed: top level '${topLevel.name}' is not above the base level '${prepared.levelName}'.`,
        );
      }
    }
    const allowed = selected(lines, params.axes);
    const existing = elementsOf(building, 'member').filter((member) => {
      if (member.role !== 'column') return false;
      if (member.levelId === prepared.levelId) return true;
      const memberLevel = building.levels[member.levelId];
      if (!memberLevel) return false;
      const low = memberLevel.elevation + Math.min(member.start[2], member.end[2]);
      const high = memberLevel.elevation + Math.max(member.start[2], member.end[2]);
      return low <= prepared.elevation + tolerance && high > prepared.elevation + tolerance;
    });
    const specs: MemberSpec[] = [];
    const names: string[] = [];
    const planned: Vec2[] = [];
    let skipped = 0;
    let found = 0;
    allowed.forEach((a, index) => {
      for (const b of allowed.slice(index + 1)) {
        const crossing = crossGridLines(a, b, tolerance);
        if (!crossing) continue;
        if (planned.some((point) => samePlanPoint(point, crossing.point, tolerance))) continue;
        planned.push(crossing.point);
        const isExcluded = excluded.some(
          ([p, q]) => (p === a.mark && q === b.mark) || (p === b.mark && q === a.mark),
        );
        if (isExcluded) continue;
        found += 1;
        const [x, y] = crossing.point;
        if (existing.some((m) => samePlanPoint([m.start[0], m.start[1]], [x, y], tolerance))) {
          skipped += 1;
          continue;
        }
        specs.push({
          role: 'column',
          profile: params.profile,
          start: [x, y, 0],
          end: [x, y, top],
          roll: params.roll,
          material: params.material,
          baseFixity: params.baseFixity,
        });
        names.push(`${a.mark}/${b.mark}`);
      }
    });
    if (found === 0) {
      return noop(
        doc,
        planned.length > 0
          ? `${tool} failed: all ${planned.length} intersection(s) excluded; no columns placed.`
          : `${tool} failed: no grid intersections to place columns on.`,
      );
    }
    if (specs.length === 0) {
      return noop(
        doc,
        `${tool}: all ${skipped} intersection(s) already hold a column; nothing added.`,
      );
    }
    const done = commit(doc, tool, building, prepared.levelId, specs);
    if (typeof done === 'string') return noop(doc, done);
    const kg = toMetres(doc, top) * (findProfile(params.profile)?.massPerMetre ?? 0) * specs.length;
    return {
      document: done.document,
      summary:
        `Added ${specs.length} columns ${profileText(params.profile)} at grid intersections ${names[0]} … ${names[names.length - 1]} ` +
        `on level "${prepared.levelName}", ${lengthText(doc, top)} high, ${tonnes(kg)} t; skipped ${skipped} existing.`,
      affected: elementAffected(done.document, done.ids),
      data: { elementIds: done.ids, skipped },
    };
  },
});

/**
 * @command add_grid_beams
 * @pure
 * @affects creates one beam member per bay between consecutive intersections on each grid line
 * @invariant beam axis z = topOffset - section depth / 2 relative to the level FFL
 * @failure no grid / unknown profile, axis, level / nothing to frame -> no-op
 */
export const addGridBeams = defineCommand({
  name: 'add_grid_beams',
  description:
    'Frame beams along the structural grid (add_grid_line): along every listed grid line, one beam per ' +
    'bay between consecutive intersections with the other lines (so it frames column to column when ' +
    'add_grid_columns was run first). The beam top sits at the level FFL + topOffset. Bays that already ' +
    'hold a beam with the same end points and a top of steel within 100 mm are skipped (any section). Mark SB, role beam.',
  params: z.object({
    profile: z.string().describe('Catalogue section name, e.g. "IPE400" (list_steel_profiles).'),
    levelId: levelIdParam.describe(
      'Level id: the beams sit at its finished floor level. Default: the active level.',
    ),
    axes: z
      .array(z.string())
      .optional()
      .describe('Grid line labels to frame along (e.g. ["A","B"]). Default: every grid line.'),
    topOffset: z
      .number()
      .optional()
      .describe(
        'Top of steel relative to the level FFL, in DOCUMENT UNITS (not necessarily mm). Default 0 (top of steel at FFL); negative puts it below the FFL, e.g. minus the grating thickness.',
      ),
    startJoint: jointFixitySchema
      .optional()
      .describe('Joint at each beam start: "pinned" (default) or "rigid" (moment connection).'),
    endJoint: jointFixitySchema
      .optional()
      .describe('Joint at each beam end: "pinned" (default) or "rigid".'),
    material: z.string().optional().describe('Steel grade. Default S355.'),
  }),
  run: (doc, params): CommandResult => {
    const tool = 'add_grid_beams';
    const prepared = setup(doc, tool, params);
    if (typeof prepared === 'string') return noop(doc, prepared);
    const { building, lines, tolerance } = prepared;
    const section = findProfile(params.profile);
    const z = (params.topOffset ?? 0) - fromMm(doc, section?.h ?? 0) / 2;
    const existing = elementsOf(building, 'member').filter(
      (member) => member.role === 'beam' && member.levelId === prepared.levelId,
    );
    const at = (p: Vec3, q: Vec2): boolean => samePlanPoint([p[0], p[1]], q, tolerance);
    // A bay holds a beam already when one spans it with its top of steel within 100 mm, whatever its
    // section: re-running the tool with another profile must not double the framing.
    const sameTopTolerance = fromMm(doc, 100);
    const topOfSteel = (member: SteelMemberElement): number =>
      member.start[2] + fromMm(doc, findProfile(member.profile)?.h ?? 0) / 2;
    const targets = selected(lines, params.axes);
    const specs: MemberSpec[] = [];
    let skipped = 0;
    let length = 0;
    for (const line of targets) {
      const crossings = crossingsOnLine(line, lines, tolerance);
      for (let index = 1; index < crossings.length; index++) {
        const from = crossings[index - 1]?.point;
        const to = crossings[index]?.point;
        if (!from || !to) continue;
        const duplicate = existing.some(
          (m) =>
            Math.abs(topOfSteel(m) - (params.topOffset ?? 0)) <= sameTopTolerance &&
            ((at(m.start, from) && at(m.end, to)) || (at(m.start, to) && at(m.end, from))),
        );
        if (duplicate) {
          skipped += 1;
          continue;
        }
        length += Math.hypot(to[0] - from[0], to[1] - from[1]);
        specs.push({
          role: 'beam',
          profile: params.profile,
          start: [from[0], from[1], z],
          end: [to[0], to[1], z],
          material: params.material,
          startJoint: params.startJoint,
          endJoint: params.endJoint,
        });
      }
    }
    if (specs.length === 0) {
      return noop(
        doc,
        skipped > 0
          ? `${tool}: all ${skipped} bay(s) already hold a beam; nothing added.`
          : `${tool} failed: no bays (fewer than 2 intersections on every selected grid line).`,
      );
    }
    const done = commit(doc, tool, building, prepared.levelId, specs);
    if (typeof done === 'string') return noop(doc, done);
    const kg = toMetres(doc, length) * (section?.massPerMetre ?? 0);
    return {
      document: done.document,
      summary:
        `Added ${specs.length} beams ${profileText(params.profile)} along ${targets.length} grid line(s) on level "${prepared.levelName}", ` +
        `top of steel ${lengthText(doc, params.topOffset ?? 0)} from FFL, total length ${lengthText(doc, length)}, ${kg.toFixed(0)} kg; skipped ${skipped} existing.`,
      affected: elementAffected(done.document, done.ids),
      data: { elementIds: done.ids, skipped },
    };
  },
});

/**
 * @command add_grid_bracing
 * @pure
 * @affects creates 2 (x) or 1 (diagonal) brace members in one bay of one grid line
 * @invariant skips braces whose end points (either direction, 1 mm) already exist on the level
 * @failure unknown profile / label / level, from == to, axis parallel or not crossing, zero height, all braces exist -> no-op
 */
export const addGridBracing = defineCommand({
  name: 'add_grid_bracing',
  description:
    'Add vertical bracing in one bay of one grid line for one storey: the bay lies in the plane of grid ' +
    'line axis between the crossing lines from and to. pattern "x" gives two crossing diagonals, "diagonal" ' +
    'one from bottom at from to top at to. Bottom nodes sit at the base level FFL + bottomOffset, top nodes ' +
    'at the next storey FFL (base elevation + level height) + topOffset. Mark BR, role brace.',
  params: z.object({
    profile: z
      .string()
      .describe('Catalogue section name, e.g. "L100x10" or "CHS114.3x4" (list_steel_profiles).'),
    axis: z.string().describe('Label of the grid line the bracing lies in, e.g. "A".'),
    from: z
      .string()
      .describe('Label of the grid line crossing axis that bounds the bay at one side, e.g. "1".'),
    to: z
      .string()
      .describe(
        'Label of the grid line crossing axis that bounds the bay at the other side, e.g. "2".',
      ),
    levelId: levelIdParam.describe(
      'Storey base level id: bracing starts at its FFL and rises one level height. Default: the active level.',
    ),
    pattern: z
      .enum(['x', 'diagonal'])
      .optional()
      .describe(
        '"x" (default): two crossing diagonals; "diagonal": one, from bottom at from to top at to.',
      ),
    bottomOffset: z
      .number()
      .optional()
      .describe(
        'Bottom node height relative to the base level FFL, in DOCUMENT UNITS (not necessarily mm). Default 0 (at the FFL).',
      ),
    topOffset: z
      .number()
      .optional()
      .describe(
        'Top node height relative to the NEXT storey FFL (base elevation + level height), in DOCUMENT UNITS (not necessarily mm). Default 0 (at the next FFL); negative puts the node under the floor beams.',
      ),
    material: z.string().optional().describe('Steel grade. Default S355.'),
  }),
  run: (doc, params): CommandResult => {
    const tool = 'add_grid_bracing';
    const prepared = setup(doc, tool, params);
    if (typeof prepared === 'string') return noop(doc, prepared);
    const { lines, tolerance } = prepared;
    const bad = unknownLabels(lines, [params.axis, params.from, params.to]);
    if (bad.length > 0) {
      return noop(doc, `${tool} failed: unknown grid label(s) ${bad.join(', ')}.`);
    }
    if (params.from === params.to) {
      return noop(doc, `${tool} failed: from and to must be different grid lines.`);
    }
    const find = (label: string): GridElement | undefined => lines.find((l) => l.mark === label);
    const axis = find(params.axis);
    const crossWith = (label: string): ReturnType<typeof crossGridLines> => {
      const other = find(label);
      return axis && other && label !== params.axis ? crossGridLines(axis, other, tolerance) : null;
    };
    const [p, q] = [crossWith(params.from), crossWith(params.to)];
    if (!p || !q) {
      return noop(
        doc,
        `${tool} failed: grid lines '${params.from}' and '${params.to}' must both cross axis '${params.axis}' within the drawn lines.`,
      );
    }
    const bottom = params.bottomOffset ?? 0;
    const top = prepared.height + (params.topOffset ?? 0);
    if (!(top - bottom > 0)) return noop(doc, `${tool} failed: bay height is zero or negative.`);
    const node = (point: Vec2, height: number): Vec3 => [point[0], point[1], height];
    const pairs: Array<[Vec3, Vec3]> = [[node(p.point, bottom), node(q.point, top)]];
    if (params.pattern !== 'diagonal') pairs.push([node(q.point, bottom), node(p.point, top)]);
    const atPoint = (a: Vec3, b: Vec3): boolean =>
      Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]) <= tolerance;
    const existingBraces = elementsOf(prepared.building, 'member').filter(
      (member) => member.role === 'brace' && member.levelId === prepared.levelId,
    );
    const isDuplicate = ([start, end]: [Vec3, Vec3]): boolean =>
      existingBraces.some(
        (m) =>
          (atPoint(m.start, start) && atPoint(m.end, end)) ||
          (atPoint(m.start, end) && atPoint(m.end, start)),
      );
    const fresh = pairs.filter((pair) => !isDuplicate(pair));
    const skipped = pairs.length - fresh.length;
    if (fresh.length === 0) {
      return noop(
        doc,
        `${tool}: ${skipped} brace(s) with the same end points already exist in grid ${params.axis} between ${params.from} and ${params.to} on level "${prepared.levelName}"; nothing added.`,
      );
    }
    const specs: MemberSpec[] = fresh.map(([start, end]) => ({
      role: 'brace',
      profile: params.profile,
      start,
      end,
      material: params.material,
    }));
    const done = commit(doc, tool, prepared.building, prepared.levelId, specs);
    if (typeof done === 'string') return noop(doc, done);
    const bay = Math.hypot(p.point[0] - q.point[0], p.point[1] - q.point[1]);
    const marks = done.ids.map((id) => done.document.building?.elements[id]?.mark ?? id);
    return {
      document: done.document,
      summary:
        `Added ${specs.length} ${params.pattern === 'diagonal' ? 'diagonal' : 'X'} brace(s) ${marks.join(', ')} ${profileText(params.profile)} ` +
        `in grid ${params.axis} between ${params.from} and ${params.to} (bay ${lengthText(doc, bay)}) on level "${prepared.levelName}"${skipped > 0 ? `; skipped ${skipped} existing` : ''}.`,
      affected: elementAffected(done.document, done.ids),
      data: { elementIds: done.ids, skipped },
    };
  },
});
