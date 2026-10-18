/** define_crack / update_crack / delete_crack (PHY-08 FR-FRC-01): crack geometries of the durability slice. */

import type { Crack } from '@core/model/durability';
import { defineCommand, z } from '@core/commands/schema';
import { changed } from '@core/commands/noop';
import type { CommandResult } from '@core/commands/types';
import { nextId } from '@lib/id';
import { quantitySchema } from '../shared/schemas';
import { crackOf, durabilityOf, withCrack, withoutCrack } from '../fatigue/store';
import { refuseFracture } from './codes';
import { solvedGeometry } from './kSolutions';

const length = (what: string): z.ZodObject<{ value: z.ZodNumber; unit: z.ZodString }> =>
  quantitySchema.describe(`${what}: a length { value > 0, unit } e.g. { value: 10, unit: "mm" }.`);

export const crackGeometrySchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z
      .literal('center_through')
      .describe('Centre through-thickness crack in a finite-width plate (K = sigma sqrt(pi a) sqrt(sec(pi a / W)), valid a/W <= 0.4).'),
    a: length('a: HALF-length of the crack'),
    W: length('W: FULL plate width'),
    t: length('t: thickness'),
  }),
  z.object({
    kind: z.literal('edge_through').describe('Single edge through crack in tension (Tada or polynomial form).'),
    a: length('a: crack depth from the edge'),
    b: length('b: plate width'),
    t: length('t: thickness'),
    form: z.enum(['tada', 'polynomial']).describe('tada (any a/b <= 0.9, 0.5 %) or polynomial (a/b <= 0.6, 0.5 %).'),
  }),
  z.object({
    kind: z
      .literal('surface_semi_elliptical')
      .describe('Semi-elliptical surface crack (Newman-Raju 1981; indicative K only, no growth integration).'),
    a: length('a: depth'),
    c: length('c: half surface length (a/c <= 1)'),
    t: length('t: thickness (a < t)'),
    b: length('b: plate HALF-width'),
  }),
]);

const referenceStressSchema = z.object({
  source: z.literal('history').describe('history: the stress comes from the load histories of the growth case.'),
});

/**
 * @affects doc.analysis.durability.cracks (adds 1 crack; affected: [crackId])
 * @invariant ids `cr-<step>.<k>`; every length > 0 in a length unit; a < W/2 (centre), a < b (edge), a < t and a <= c (surface)
 * @failure bad geometry -> FRC_CRACK_INVALID (unchanged doc); fe_seam / corner / hole cracks are not built (rejected by the schema)
 */
export const defineCrack = defineCommand({
  name: 'define_crack',
  description:
    'Define a crack for stress-intensity and crack-growth calculations: center_through (a = HALF-length, W = full width, t), edge_through (a, b, t, form tada | polynomial) ' +
    'or surface_semi_elliptical (a, c, t, b; Newman-Raju, indicative only). Lengths are { value, unit }. The stress comes from load histories (referenceStress.source "history"). ' +
    'The size here is the crack size for stress_intensity; a growth case starts from its own growth.aInitial. Returns the crack id in affected[0]. Next: stress_intensity for K, or create_crack_growth_case.',
  params: z.object({
    name: z.string().min(1).describe('Display name of the crack.'),
    geometry: crackGeometrySchema.describe('Crack geometry.'),
    referenceStress: referenceStressSchema.optional().describe('Where the stress comes from (only "history" is built).'),
  }),
  run: (doc, params): CommandResult => {
    const solved = solvedGeometry(params.geometry);
    if (typeof solved === 'string') return refuseFracture(doc, 'define_crack', 'FRC_CRACK_INVALID', solved, [], ['geometry']);
    const id = nextId('cr');
    const crack: Crack = { id, name: params.name, geometry: params.geometry, referenceStress: { source: 'history' } };
    return changed(
      withCrack(doc, crack),
      `Defined crack ${id} '${params.name}' (${params.geometry.kind}, a = ${(solved.a * 1000).toPrecision(5)} mm).`,
      [id],
    );
  },
});

/**
 * @affects doc.analysis.durability.cracks[crackId] (replaces name and / or geometry)
 * @failure unknown id -> FRC_CRACK_NOT_FOUND; invalid geometry -> FRC_CRACK_INVALID (unchanged doc)
 */
export const updateCrack = defineCommand({
  name: 'update_crack',
  description:
    'Change the name and / or the geometry of a crack (the whole geometry object is replaced). Growth cases that use the crack see the new geometry on their next compute.',
  params: z.object({
    crackId: z.string().describe('Crack id (affected[0] of define_crack).'),
    name: z.string().min(1).optional().describe('New display name.'),
    geometry: crackGeometrySchema.optional().describe('New geometry (replaces the old one).'),
  }),
  run: (doc, params): CommandResult => {
    const current = crackOf(doc, params.crackId);
    if (current === undefined)
      return refuseFracture(doc, 'update_crack', 'FRC_CRACK_NOT_FOUND', `no crack '${params.crackId}'`, [params.crackId], ['crackId']);
    const geometry = params.geometry ?? current.geometry;
    const solved = solvedGeometry(geometry);
    if (typeof solved === 'string') return refuseFracture(doc, 'update_crack', 'FRC_CRACK_INVALID', solved, [params.crackId], ['geometry']);
    return changed(
      withCrack(doc, { ...current, name: params.name ?? current.name, geometry }),
      `Updated crack ${current.id} (${geometry.kind}, a = ${(solved.a * 1000).toPrecision(5)} mm).`,
      [current.id],
    );
  },
});

/**
 * @affects doc.analysis.durability.cracks (removes 1 crack)
 * @failure unknown id -> FRC_CRACK_NOT_FOUND; used by a crack-growth case -> FRC_CRACK_IN_USE (unchanged doc)
 */
export const deleteCrack = defineCommand({
  name: 'delete_crack',
  description: 'Delete a crack that no crack-growth case uses (refused with FRC_CRACK_IN_USE otherwise).',
  annotations: { destructive: true },
  params: z.object({ crackId: z.string().describe('Crack id.') }),
  run: (doc, params): CommandResult => {
    if (crackOf(doc, params.crackId) === undefined)
      return refuseFracture(doc, 'delete_crack', 'FRC_CRACK_NOT_FOUND', `no crack '${params.crackId}'`, [params.crackId], ['crackId']);
    const users = Object.values(durabilityOf(doc).crackGrowthCases)
      .filter((c) => c.crackId === params.crackId)
      .map((c) => c.id);
    if (users.length > 0)
      return refuseFracture(
        doc,
        'delete_crack',
        'FRC_CRACK_IN_USE',
        `crack is used by ${users.join(', ')}`,
        [params.crackId, ...users],
        ['crackId'],
      );
    return changed(withoutCrack(doc, params.crackId), `Deleted crack ${params.crackId}.`, [params.crackId]);
  },
});
