import type { Vec2 } from '@core/model/types';
import { defineCommand, vec2, z } from '@core/commands/schema';
import type { CommandResult } from '@core/commands/types';
import { fromMm, toMetres, toMm } from '@core/model/units';
import { polygonArea } from '@lib/polygon';
import type { BuildingElement, GratingElement, SteelMemberElement } from '@aec/building/types';
import { appendElements, elementsOf, getBuilding, resolveLevel } from '../../../building/model';
import { commitBuilding } from '../../../building/evaluate/evaluateElements';
import { levelIdParam } from '../../../building/levelParams';
import { findTwin, sameRing } from '../../../shared/duplicates';
import { round } from '../../../shared/numeric';
import { refuse } from '../codes';
import { findGratingType } from './gratingTypes';
import {
  bearsUnder,
  barDirection,
  isConvex,
  isPerpendicular,
  ringFromMm,
  ringToMm,
  splitPanels,
  supportLineOf,
  type SupportLine,
} from './gratingSupports';

/** Rounds a plan point to a micrometre-ish grid in document units so clipped corners are stable and twins compare equal. */
const tidy = (ring: ReadonlyArray<Vec2>): Vec2[] => ring.map(([x, y]): Vec2 => [round(x, 4), round(y, 4)]);

/**
 * @affects creates one grating element per support bay (plan polygon on layer S-GRAT, top at level + topOffset)
 * @invariant panels are split at the supports, every panel bears on two members perpendicular (+-5 deg) to its bars with the member top 0..10 mm under the grating underside
 * @failure unknown type -> STA_GRATING_TYPE_UNKNOWN; bad / non-convex region, zero direction, thickness != bar depth -> STA_INVALID_GEOMETRY; no support at an end edge -> STA_NO_SUPPORT_FOUND; unknown member id -> STA_UNKNOWN_ELEMENT; duplicate panel -> no-op
 */
export const addGrating = defineCommand({
  name: 'add_grating',
  description:
    'Lay open-bar steel grating over a plan region, split into one panel (one element, marks GR1, GR2 ...) per bay between supporting steel members. ' +
    'Give the region as `boundary` (convex polygon, 3+ [x, y] points) or `bounds` ([[xmin, ymin], [xmax, ymax]]); all lengths in DOCUMENT UNITS. ' +
    '`bearingBarDirection` [x, y] is the plan direction the bars run along: they span between supports, so the supports must be perpendicular to it (+-5 deg). ' +
    '`supportedBy`: "beams" uses every horizontal steel member of role beam, or pass member ids. A support counts when its top of steel is 0..10 mm below the grating underside ' +
    '(top at level elevation + topOffset, minus the bar depth of the type): frame with add_grid_beams { topOffset: -<bar depth> }. ' +
    'The first and last support must lie under the end edges of the region; a panel is the region between two consecutive supports. ' +
    'Result data: panels[] with id, mark, spanMm (centreline), areaM2, massKg, supportIds, and the totals. Check strength and deflection with check_grating.',
  params: z.object({
    gratingType: z.string().describe('Catalogue key from list_grating_types, e.g. "19-W-4 1-1/4x3/16".'),
    bearingBarDirection: vec2('Plan direction of the bearing bars [x, y] (any length, not zero); the supports run across it.'),
    supportedBy: z
      .union([z.literal('beams'), z.array(z.string()).min(1)])
      .describe('"beams" = every steel member of role beam under the region, or the member ids to bear on.'),
    boundary: z
      .array(vec2('Plan point [x, y], document units.'))
      .min(3)
      .optional()
      .describe('Convex region polygon. Give boundary or bounds, not both.'),
    bounds: z
      .tuple([vec2('Minimum corner [x, y].'), vec2('Maximum corner [x, y].')])
      .optional()
      .describe('Rectangular region [[xmin, ymin], [xmax, ymax]], document units. Give boundary or bounds, not both.'),
    topOffset: z.number().optional().describe('Walking-surface height relative to the level elevation, DOCUMENT UNITS. Default 0.'),
    thickness: z
      .number()
      .positive()
      .optional()
      .describe(
        'Panel depth, DOCUMENT UNITS. Optional: it must equal the bar depth of the type (the catalogue decides); refused otherwise.',
      ),
    levelId: levelIdParam,
  }),
  run: (doc, params): CommandResult => {
    const type = findGratingType(params.gratingType);
    if (type === undefined)
      return refuse(doc, 'add_grating', 'STA_GRATING_TYPE_UNKNOWN', `no grating type '${params.gratingType}'`, [], ['gratingType']);
    if ((params.boundary === undefined) === (params.bounds === undefined))
      return refuse(doc, 'add_grating', 'STA_INVALID_GEOMETRY', 'give exactly one of boundary or bounds', [], ['boundary', 'bounds']);
    const [bx, by] = params.bearingBarDirection;
    if (!(Math.hypot(bx, by) > 0))
      return refuse(doc, 'add_grating', 'STA_INVALID_GEOMETRY', 'bearingBarDirection is the zero vector', [], ['bearingBarDirection']);
    if (params.thickness !== undefined && Math.abs(toMm(doc, params.thickness) - type.barDepthMm) > 0.01)
      return refuse(
        doc,
        'add_grating',
        'STA_INVALID_GEOMETRY',
        `thickness must equal the bar depth of ${type.name} (${type.barDepthMm} mm) or be omitted`,
        [],
        ['thickness'],
      );
    const region: Vec2[] =
      params.boundary ??
      (params.bounds === undefined
        ? []
        : [
            [Math.min(params.bounds[0][0], params.bounds[1][0]), Math.min(params.bounds[0][1], params.bounds[1][1])],
            [Math.max(params.bounds[0][0], params.bounds[1][0]), Math.min(params.bounds[0][1], params.bounds[1][1])],
            [Math.max(params.bounds[0][0], params.bounds[1][0]), Math.max(params.bounds[0][1], params.bounds[1][1])],
            [Math.min(params.bounds[0][0], params.bounds[1][0]), Math.max(params.bounds[0][1], params.bounds[1][1])],
          ]);
    const regionMm = ringToMm(doc, region);
    if (!(polygonArea(regionMm) > 1) || !isConvex(regionMm))
      return refuse(
        doc,
        'add_grating',
        'STA_INVALID_GEOMETRY',
        'the region must be a convex polygon with a non-zero area (split an L shape into rectangles)',
        [],
        ['boundary', 'bounds'],
      );

    const resolution = resolveLevel(doc, getBuilding(doc), params.levelId);
    if (!resolution.ok) return refuse(doc, 'add_grating', 'STA_INVALID_GEOMETRY', resolution.reason, [], ['levelId']);
    const { building, level } = resolution;
    const topOffset = params.topOffset ?? 0;
    const undersideMm = toMm(doc, level.elevation + topOffset) - type.barDepthMm;
    const direction = barDirection(Math.atan2(by, bx));

    const named = params.supportedBy === 'beams' ? undefined : params.supportedBy;
    const unknown = (named ?? []).filter((id) => building.elements[id]?.category !== 'member');
    if (unknown.length > 0)
      return refuse(doc, 'add_grating', 'STA_UNKNOWN_ELEMENT', `supportedBy ${unknown.join(', ')} is not a steel member`, unknown, [
        'supportedBy',
      ]);
    const members: SteelMemberElement[] =
      named === undefined
        ? elementsOf(building, 'member').filter((member) => member.role === 'beam')
        : named.flatMap((id) => {
            const element: BuildingElement | undefined = building.elements[id];
            return element?.category === 'member' ? [element] : [];
          });
    const lines = members.flatMap((member) => supportLineOf(doc, building, member, direction) ?? []);
    const bearing: SupportLine[] = lines.filter((line) => isPerpendicular(line) && bearsUnder(line, undersideMm));
    if (named !== undefined) {
      const rejected = named.filter((id) => !bearing.some((line) => line.id === id));
      if (rejected.length > 0)
        return refuse(
          doc,
          'add_grating',
          'STA_NO_SUPPORT_FOUND',
          `${rejected.join(', ')} cannot support the grating: a support is a horizontal member perpendicular (+-5 deg) to the bars with its top 0..10 mm under the underside (${round(undersideMm, 2)} mm)`,
          rejected,
          ['supportedBy'],
        );
    }
    const split = splitPanels(regionMm, direction, bearing);
    if (!split.ok)
      return refuse(
        doc,
        'add_grating',
        'STA_NO_SUPPORT_FOUND',
        `${split.reason} (${members.length} member(s) examined, ${bearing.length} bear under ${round(undersideMm, 2)} mm)`,
        [],
        ['supportedBy'],
      );

    const panels = split.panels.map((panel) => ({ ...panel, boundary: tidy(ringFromMm(doc, panel.ring)) }));
    const twin = panels
      .map((panel) =>
        findTwin(
          building,
          'grating',
          level.id,
          (element) => element.topOffset === topOffset && element.gratingType === type.name && sameRing(element.boundary, panel.boundary),
        ),
      )
      .find((found) => found !== undefined);
    if (twin !== undefined)
      return refuse(
        doc,
        'add_grating',
        'STA_INVALID_GEOMETRY',
        `a panel of this grating already exists as ${twin.id} (${twin.mark}); edit it instead of adding a twin`,
        [twin.id],
      );

    const barAngle = Math.atan2(by, bx);
    const added = appendElements(
      building,
      panels,
      'grating',
      (panel, id, mark): GratingElement => ({
        id,
        category: 'grating',
        mark,
        entityIds: [],
        levelId: level.id,
        boundary: panel.boundary,
        topOffset,
        gratingType: type.name,
        bearingBarAngle: barAngle,
        supportIds: [panel.supports[0].id, panel.supports[1].id],
      }),
    );
    const areaM2 = panels.reduce((sum, panel) => sum + polygonArea(panel.boundary), 0) * toMetres(doc, 1) ** 2;
    const rows = panels.map((panel, index) => ({
      id: added.ids[index] ?? '',
      mark: added.building.elements[added.ids[index] ?? '']?.mark ?? '',
      spanMm: round(panel.supports[1].sMm - panel.supports[0].sMm, 3),
      areaM2: round(polygonArea(panel.boundary) * toMetres(doc, 1) ** 2, 6),
      massKg: round(polygonArea(panel.boundary) * toMetres(doc, 1) ** 2 * type.massKgM2, 3),
      supportIds: [panel.supports[0].id, panel.supports[1].id],
    }));
    const massKg = round(areaM2 * type.massKgM2, 3);
    return commitBuilding(
      doc,
      added.building,
      added.ids,
      `Added ${rows.length} grating panel(s) ${rows.map((row) => row.mark).join(', ')} (${type.name}${type.verified ? '' : ', unverified type'}) at ${round(fromMm(doc, undersideMm + type.barDepthMm), 3)} ${doc.units}: ` +
        `spans ${rows.map((row) => row.spanMm).join(', ')} mm, ${round(areaM2, 3)} m2, ${massKg} kg. Check them with check_grating.`,
      {
        elementIds: added.ids,
        panels: rows,
        gratingType: type.name,
        verifiedType: type.verified,
        areaM2: round(areaM2, 6),
        massKg,
        defaults: params.topOffset === undefined ? ['topOffset 0 (walking surface at the level elevation)'] : [],
      },
    );
  },
});
