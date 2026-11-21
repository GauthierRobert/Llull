/**
 * fit_steel_member (TECHNICAL_SPEC §5.7, FR-SCN-15, VC-SCN-23): the native `steel` op fits the member axis to the region, projects the points
 * onto the section plane and ranks the catalogue outlines sent from `STEEL_PROFILES` by the chamfer distance over a roll search. This command
 * converts units, derives the `add_steel_member` roll and returns the ranked candidates. Read-only (TR-SCN-04): nothing is created.
 */

import type { CadDocument } from '@core/model/types';
import type { CommandResult } from '@core/commands/types';
import { defineCommand, z } from '@core/commands/schema';
import { report } from '@core/commands/noop';
import { isRecord } from '@lib/isRecord';
import { refuseScan } from './codes';
import { cloudAccess, isAccess } from './access';
import { isSuccess, runOp } from './compute';
import { pendingExtraction, unverifiedReasons } from './extraction';
import { measuredSection, measuredThickness } from './steelSection';
import { fromM, scanOf, toM, vecFromM } from './model';
import { regionSpec, resolveRegion } from './region';
import { cloudIdParam, regionParam, seedParam } from './schemas';
import { sweepFrame } from '../shared/mesh';
import { dot3, hypot3 } from '@lib/vec3';
import { existingLevelId, getBuilding } from '../building/model';
import { findProfile, profileOutline, STEEL_PROFILES } from '../steel/profiles';

/** Section families searched by default (flat and round bars only when named). */
const DEFAULT_FAMILIES = ['IPE', 'HEA', 'HEB', 'UPN', 'C', 'SHS', 'RHS', 'CHS', 'L'];
/** Named defaults of the parameters (documented in the descriptions). */
const DEFAULT_MAX_CANDIDATES = 5;
const DEFAULT_SEED = 1;
const MIN_HINT_NORM = 1e-9;
const ALL_FAMILIES: string[] = [...new Set(STEEL_PROFILES.map((profile) => profile.family))];

type Vec = readonly [number, number, number];
const vec = (value: unknown): Vec | undefined =>
  Array.isArray(value) && value.length === 3 && value.every((n) => typeof n === 'number') ? (value as unknown as Vec) : undefined;

/** `add_steel_member` roll (radians) that turns the sweep frame's depth (`sweepFrame` at roll 0: u = side, v = up) onto `depth` for the axis start -> end. */
export function memberRoll(start: Vec, end: Vec, depth: Vec): number {
  const frame = sweepFrame(start, end, 0);
  return frame === null ? 0 : Math.atan2(dot3(depth, frame.u), dot3(depth, frame.v));
}

/** Unit direction (the native op takes any non-zero length; a unit vector keeps the job readable). */
const unitHint = (hint: Vec): number[] => {
  const n = hypot3(hint);
  return hint.map((c) => c / n);
};

const mm = (metres: unknown): number => (typeof metres === 'number' ? metres * 1000 : Number.NaN);

function paramProblem(
  families: readonly string[],
  positive: Readonly<Record<string, number | undefined>>,
  axisHint: Vec | undefined,
): { key: string; text: string } | undefined {
  const unknown = families.filter((family) => !ALL_FAMILIES.includes(family));
  if (unknown.length > 0 || families.length === 0)
    return {
      key: 'families',
      text: `families must be a non-empty list of ${ALL_FAMILIES.join(', ')} (got ${unknown.join(', ') || 'none'})`,
    };
  for (const [key, value] of Object.entries(positive)) if (value !== undefined && !(value > 0)) return { key, text: `${key} must be > 0` };
  if (axisHint !== undefined && !(hypot3(axisHint) > MIN_HINT_NORM))
    return { key: 'axisHint', text: 'axisHint must be a finite vector with a norm above 1e-9' };
  return undefined;
}

interface SteelCandidate {
  readonly profile: string;
  readonly family: string | null;
  readonly scoreMm: number;
  readonly hMm: number;
  readonly bMm: number;
  readonly hDeltaMm: number | null;
  readonly bDeltaMm: number | null;
  readonly rollDeg: unknown;
  readonly flipped: unknown;
  readonly axis: unknown;
  readonly depthDirection: unknown;
  readonly widthDirection: unknown;
  readonly centre: Vec | null;
}

function candidateOf(doc: CadDocument, candidate: Readonly<Record<string, unknown>>): SteelCandidate {
  const profile = findProfile(candidate['profile']);
  const [hMm, bMm] = [mm(candidate['h']), mm(candidate['b'])];
  const centre = vec(candidate['centre']);
  return {
    profile: String(candidate['profile']),
    family: profile?.family ?? null,
    scoreMm: mm(candidate['score']),
    hMm,
    bMm,
    hDeltaMm: profile === undefined ? null : hMm - profile.h,
    bDeltaMm: profile === undefined ? null : bMm - profile.b,
    rollDeg: candidate['rollDeg'],
    flipped: candidate['flipped'],
    axis: candidate['axisDirection'],
    depthDirection: candidate['depthDirection'],
    widthDirection: candidate['widthDirection'],
    centre: centre === undefined ? null : vecFromM(doc, centre),
  };
}

/**
 * @failure SCN_CLOUD_NOT_FOUND / SCN_ASSET_*; bad region -> SCN_CROP_*; unknown family / non-positive parameter -> SCN_PARAM_INVALID; < 30 points ->
 *   SCN_FIT_TOO_FEW_POINTS; section thinner than 1 cm -> SCN_FIT_NO_MODEL; no hint and a stub region (axial extent < 3 x the
 *   section) -> SCN_STEEL_AXIS_AMBIGUOUS; no outline within the extent gate -> SCN_STEEL_NO_CANDIDATE; unknown levelId -> SCN_PARAM_INVALID;
 *   no binary -> NATIVE_TOOL_MISSING
 */
export const fitSteelMember = defineCommand({
  name: 'fit_steel_member',
  description:
    'Read-only: identify a steel member in a region of the cloud against the llull catalogue (IPE, HEA, HEB, UPN, C, SHS, RHS, CHS, L; FL / RD ' +
    'only when named in `families`). Native: the axis is the largest-variance direction of the region points (or axisHint: REQUIRED for a region shorter than about 3 x the larger ' +
    'section dimension, else SCN_STEEL_AXIS_AMBIGUOUS), the points are projected onto the section plane, and every catalogue outline is scored by the RMS distance ' +
    'of the section points to the outline over a roll search with the section seen from either end. Put the region around ONE member. data: ' +
    'candidates[] best first (profile, family, scoreMm, measured hMm / bMm of the rotated extents, hDeltaMm / bDeltaMm against the catalogue, ' +
    "axis, depthDirection, widthDirection), `member` = the best candidate's axis (start, end, direction), measured section (hMm, bMm; for an " +
    'I section IPE / HEA / HEB also twMm / tfMm with twResidualMm / tfResidualMm and the catalogue values, else null with twTfReason) and ' +
    '`addSteelMember` = { profile, start, end, roll } ready for add_steel_member ' +
    '(start / end z relative to `levelId`, whose elevation is subtracted; default the active level). The member axis is refined from the fitted face planes ' +
    '(data.axisRefinement: applied, deltaDeg, faces, residual, or the reason it was kept). Warnings: SCN_STEEL_NO_MATCH when the best score exceeds ' +
    'the inlier band (non-catalogue or built-up section: model manually), SCN_STEEL_LOW_COVERAGE (occluded / one-sided: h, b, centre are of the visible part) and ' +
    'SCN_STEEL_THICKNESS_MISMATCH (tw or tf further from the catalogue profile than the scan band; field-verify). data.extractions[0].extraction is a record ready for ' +
    'commit_asbuilt_extraction, which creates the as-built member; creating a member by hand stays a separate add_steel_member call.',
  annotations: { readOnly: true },
  params: z.object({
    cloudId: cloudIdParam,
    region: regionParam,
    families: z
      .array(z.string())
      .optional()
      .describe(`Section families to search (${ALL_FAMILIES.join(', ')}). Default ${DEFAULT_FAMILIES.join(', ')}.`),
    maxCandidates: z.number().int().min(1).max(20).optional().describe('Ranked candidates returned (default 5).'),
    axisHint: z
      .array(z.number())
      .length(3)
      .optional()
      .describe(
        '[x, y, z] direction of the member axis (document frame, any length): required when the region is shorter than about 3 x the larger section dimension.',
      ),
    noiseSigma: z.number().optional().describe('Scanner noise sigma in document units, when known: the no-match band is 3 sigma.'),
    distanceThreshold: z
      .number()
      .optional()
      .describe('Explicit no-match band for the best score, document units (default 3 x sigma, else 2.5 x median spacing).'),
    levelId: z
      .string()
      .optional()
      .describe(
        'Level id add_steel_member will be called on (default: the active level, else the first): its elevation is subtracted from start / end z.',
      ),
    seed: seedParam,
  }),
  run: (doc, params, ctx): CommandResult => {
    const command = 'fit_steel_member';
    const { cloudId, region, noiseSigma, distanceThreshold } = params;
    const axisHint = vec(params.axisHint);
    const families = params.families ?? DEFAULT_FAMILIES;
    const maxCandidates = params.maxCandidates ?? DEFAULT_MAX_CANDIDATES;
    const seed = params.seed ?? DEFAULT_SEED;
    const problem = paramProblem(families, { noiseSigma, distanceThreshold }, axisHint);
    if (problem !== undefined) return refuseScan(doc, command, 'SCN_PARAM_INVALID', problem.text, [cloudId], [problem.key]);
    const building = getBuilding(doc);
    const levelId = existingLevelId(building, params.levelId);
    if (params.levelId !== undefined && levelId === undefined)
      return refuseScan(
        doc,
        command,
        'SCN_PARAM_INVALID',
        `unknown level '${params.levelId}' (levels: ${building.levelOrder.join(', ') || 'none'})`,
        [cloudId],
        ['levelId'],
      );
    const level = levelId === undefined ? undefined : building.levels[levelId];
    const elevation = level === undefined ? 0 : level.elevation;
    const access = cloudAccess(doc, command, cloudId, ctx);
    if (!isAccess(access)) return access;
    const resolved = resolveRegion(doc, region);
    if (!resolved.ok) return refuseScan(doc, command, resolved.code, resolved.message, [cloudId], ['region']);
    const outlines = STEEL_PROFILES.filter((profile) => families.includes(profile.family)).map((profile) => ({
      name: profile.name,
      loopXy: profileOutline(profile).outer.map(([x, y]) => [x / 1000, y / 1000]),
      ...(profile.shape === 'I' ? { tw: profile.tw / 1000, tf: profile.tf / 1000 } : {}),
    }));
    const native: Record<string, unknown> = { region: resolved.region, outlines, maxCandidates, seed };
    if (axisHint !== undefined) native['axisHint'] = unitHint(axisHint);
    if (noiseSigma !== undefined) native['noiseSigma'] = toM(doc, noiseSigma);
    if (distanceThreshold !== undefined) native['distanceThreshold'] = toM(doc, distanceThreshold);
    const ran = runOp(doc, command, access.port, 'steel', [access.cloud], native);
    if (!isSuccess(ran)) return ran;
    const result = ran.result;
    const raw = (Array.isArray(result['candidates']) ? result['candidates'] : []).filter(isRecord);
    const start = vec(result['start']);
    const end = vec(result['end']);
    const axis = vec(raw[0]?.['axisDirection']);
    const depth = vec(raw[0]?.['depthDirection']);
    if (raw.length === 0 || start === undefined || end === undefined || axis === undefined || depth === undefined)
      return refuseScan(doc, command, 'NATIVE_PROTOCOL', 'the steel fit answered without candidates', [cloudId]);
    const candidates = raw.map((candidate) => candidateOf(doc, candidate));
    const best = candidates[0];
    if (best === undefined) return refuseScan(doc, command, 'NATIVE_PROTOCOL', 'the steel fit answered without candidates', [cloudId]);
    const nativeWarnings = (Array.isArray(result['warnings']) ? result['warnings'] : [])
      .filter(isRecord)
      .flatMap((w) => (typeof w['code'] === 'string' ? [{ code: w['code'], message: String(w['message'] ?? '') }] : []));
    const nativeThreshold = result['threshold'];
    const bandMm = isRecord(nativeThreshold) ? mm(nativeThreshold['value']) : Number.POSITIVE_INFINITY;
    const thickness = measuredThickness(result['thickness'], findProfile(best.profile), bandMm);
    const warnings = [...nativeWarnings, ...thickness.warnings];
    const reasons = unverifiedReasons(
      scanOf(doc),
      access.cloud,
      warnings.map((w) => w.code),
    );
    const [startDoc, endDoc] = [vecFromM(doc, start), vecFromM(doc, end)];
    const length = fromM(doc, Number(result['length']));
    const relative = (point: Vec): Vec => [point[0], point[1], point[2] - elevation];
    const threshold = isRecord(nativeThreshold)
      ? {
          ...nativeThreshold,
          value: fromM(doc, Number(nativeThreshold['value'])),
          spacing: fromM(doc, Number(nativeThreshold['spacing'])),
          unit: doc.units,
        }
      : null;
    const provenance = {
      method: 'pca axis + chamfer section match',
      algorithmVersion: `${ran.provenance.binary}/steel-2`,
      seed,
      device: ran.provenance.device,
      deterministic: ran.provenance.deterministic,
    };
    const codes = [...new Set(warnings.map((w) => w.code))];
    const extraction = pendingExtraction(
      access.cloud,
      regionSpec(region),
      {
        profile: best.profile,
        start,
        end,
        direction: axis,
        length: Number(result['length']),
        roll: memberRoll(startDoc, endDoc, depth),
        depthDirection: depth,
        widthDirection: vec(raw[0]?.['widthDirection']) ?? null,
        hMm: best.hMm,
        bMm: best.bMm,
        twMm: thickness.tw?.mm ?? null,
        tfMm: thickness.tf?.mm ?? null,
        scoreMm: best.scoreMm,
      },
      undefined,
      reasons,
      provenance,
      'steel_member',
    );
    return report(
      doc,
      `fit_steel_member on ${cloudId}: best ${best.profile} (score ${best.scoreMm.toFixed(2)} mm, h ${best.hMm.toFixed(1)} x b ${best.bMm.toFixed(1)} mm), ` +
        `${candidates.length} candidate(s), length ${length.toPrecision(5)} ${doc.units}${codes.length > 0 ? ` [${codes.join(', ')}]` : ''}. ` +
        'Create it with add_steel_member data.addSteelMember.',
      {
        cloudId,
        unit: doc.units,
        region: regionSpec(region),
        candidates,
        axis: { direction: axis, start: startDoc, end: endDoc },
        member: { start: startDoc, end: endDoc, direction: axis, length },
        measured: measuredSection({ hMm: best.hMm, bMm: best.bMm, rollDeg: best.rollDeg }, thickness),
        axisRefinement: result['axisRefinement'] ?? null,
        addSteelMember: {
          profile: best.profile,
          start: relative(startDoc),
          end: relative(endDoc),
          roll: memberRoll(startDoc, endDoc, depth),
          ...(levelId === undefined ? {} : { levelId }),
        },
        extractions: [{ profile: best.profile, unverified: reasons.length > 0, extraction }],
        rms: fromM(doc, Number(result['rms'])),
        pointsInRegion: result['pointsInRegion'],
        threshold,
        warnings,
        unverified: reasons.length > 0,
        unverifiedReasons: reasons,
        provenance,
      },
    );
  },
});
