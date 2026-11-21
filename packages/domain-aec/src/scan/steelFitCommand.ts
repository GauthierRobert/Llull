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
import { unverifiedReasons } from './extraction';
import { fromM, scanOf, toM, vecFromM } from './model';
import { regionSpec, resolveRegion } from './region';
import { cloudIdParam, regionParam, seedParam } from './schemas';
import { findProfile, profileOutline, STEEL_PROFILES } from '../steel/profiles';

/** Section families searched by default (flat and round bars only when named). */
const DEFAULT_FAMILIES = ['IPE', 'HEA', 'HEB', 'UPN', 'C', 'SHS', 'RHS', 'CHS', 'L'];
/** Named defaults of the parameters (documented in the descriptions). */
const DEFAULT_MAX_CANDIDATES = 5;
const DEFAULT_SEED = 1;
const ALL_FAMILIES: string[] = [...new Set(STEEL_PROFILES.map((profile) => profile.family))];

type Vec = readonly [number, number, number];
const vec = (value: unknown): Vec | undefined =>
  Array.isArray(value) && value.length === 3 && value.every((n) => typeof n === 'number') ? (value as unknown as Vec) : undefined;
const cross = (a: Vec, b: Vec): Vec => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const dot = (a: Vec, b: Vec): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const unitOf = (a: Vec): Vec => {
  const n = Math.hypot(a[0], a[1], a[2]);
  return n > 0 ? [a[0] / n, a[1] / n, a[2] / n] : [0, 0, 0];
};

/** `add_steel_member` roll (radians) that turns the sweep frame's depth onto `depth` for the axis `axis` (shared/mesh.ts sweepFrame). */
export function memberRoll(axis: Vec, depth: Vec): number {
  const d = unitOf(axis);
  const reference: Vec = Math.abs(d[2]) > 0.999 ? [1, 0, 0] : [0, 0, 1];
  const along = dot(reference, d);
  const up = unitOf([reference[0] - d[0] * along, reference[1] - d[1] * along, reference[2] - d[2] * along]);
  return Math.atan2(dot(depth, cross(up, d)), dot(depth, up));
}

const mm = (metres: unknown): number => (typeof metres === 'number' ? metres * 1000 : Number.NaN);

function paramProblem(
  families: readonly string[],
  positive: Readonly<Record<string, number | undefined>>,
  axisHint: readonly number[] | undefined,
): { key: string; text: string } | undefined {
  const unknown = families.filter((family) => !ALL_FAMILIES.includes(family));
  if (unknown.length > 0 || families.length === 0)
    return {
      key: 'families',
      text: `families must be a non-empty list of ${ALL_FAMILIES.join(', ')} (got ${unknown.join(', ') || 'none'})`,
    };
  for (const [key, value] of Object.entries(positive)) if (value !== undefined && !(value > 0)) return { key, text: `${key} must be > 0` };
  if (axisHint !== undefined && axisHint.every((component) => component === 0))
    return { key: 'axisHint', text: 'axisHint must not be the zero vector' };
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
 *   SCN_FIT_TOO_FEW_POINTS; section thinner than 1 cm -> SCN_FIT_NO_MODEL; no outline within the extent gate -> SCN_STEEL_NO_MATCH;
 *   no binary -> NATIVE_TOOL_MISSING
 */
export const fitSteelMember = defineCommand({
  name: 'fit_steel_member',
  description:
    'Read-only: identify a steel member in a region of the cloud against the llull catalogue (IPE, HEA, HEB, UPN, C, SHS, RHS, CHS, L; FL / RD ' +
    'only when named in `families`). Native: the axis is the largest-variance direction of the region points (or axisHint, needed for a member ' +
    'shorter than its section), the points are projected onto the section plane, and every catalogue outline is scored by the RMS distance ' +
    'of the section points to the outline over a roll search with the section seen from either end. Put the region around ONE member. data: ' +
    'candidates[] best first (profile, family, scoreMm, measured hMm / bMm of the rotated extents, hDeltaMm / bDeltaMm against the catalogue, ' +
    "axis, depthDirection, widthDirection), `member` = the best candidate's axis (start, end, direction), measured section (hMm, bMm; tw / tf " +
    'null: not resolvable from a scan below 10 sigma, reason given) and `addSteelMember` = { profile, start, end, roll } ready for add_steel_member ' +
    '(z relative to the level), plus warnings: SCN_STEEL_NO_MATCH when the best score exceeds the inlier band (non-catalogue or built-up ' +
    'section: model manually). The result is a proposal; creating the member stays a separate add_steel_member call.',
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
        '[x, y, z] direction of the member axis (document frame, any length): needed when the region is shorter than the section is deep.',
      ),
    noiseSigma: z.number().optional().describe('Scanner noise sigma in document units, when known: the no-match band is 3 sigma.'),
    distanceThreshold: z
      .number()
      .optional()
      .describe('Explicit no-match band for the best score, document units (default 3 x sigma, else 2.5 x median spacing).'),
    seed: seedParam,
  }),
  run: (doc, params, ctx): CommandResult => {
    const command = 'fit_steel_member';
    const { cloudId, region, axisHint, noiseSigma, distanceThreshold } = params;
    const families = params.families ?? DEFAULT_FAMILIES;
    const maxCandidates = params.maxCandidates ?? DEFAULT_MAX_CANDIDATES;
    const seed = params.seed ?? DEFAULT_SEED;
    const problem = paramProblem(families, { noiseSigma, distanceThreshold }, axisHint);
    if (problem !== undefined) return refuseScan(doc, command, 'SCN_PARAM_INVALID', problem.text, [cloudId], [problem.key]);
    const access = cloudAccess(doc, command, cloudId, ctx);
    if (!isAccess(access)) return access;
    const resolved = resolveRegion(doc, region);
    if (!resolved.ok) return refuseScan(doc, command, resolved.code, resolved.message, [cloudId], ['region']);
    const outlines = STEEL_PROFILES.filter((profile) => families.includes(profile.family)).map((profile) => ({
      name: profile.name,
      loopXy: profileOutline(profile).outer.map(([x, y]) => [x / 1000, y / 1000]),
    }));
    const native: Record<string, unknown> = { region: resolved.region, outlines, maxCandidates, seed };
    if (axisHint !== undefined) native['axisHint'] = axisHint;
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
    const warnings = (Array.isArray(result['warnings']) ? result['warnings'] : [])
      .filter(isRecord)
      .flatMap((w) => (typeof w['code'] === 'string' ? [{ code: w['code'], message: String(w['message'] ?? '') }] : []));
    const reasons = unverifiedReasons(scanOf(doc), access.cloud, []);
    const [startDoc, endDoc] = [vecFromM(doc, start), vecFromM(doc, end)];
    const length = fromM(doc, Number(result['length']));
    const provenance = {
      method: 'pca axis + chamfer section match',
      algorithmVersion: `${ran.provenance.binary}/steel-1`,
      seed,
      device: ran.provenance.device,
      deterministic: ran.provenance.deterministic,
    };
    const codes = [...new Set(warnings.map((w) => w.code))];
    return report(
      doc,
      `fit_steel_member on ${cloudId}: best ${best?.profile} (score ${(best?.scoreMm ?? 0).toFixed(2)} mm, h ${(best?.hMm ?? 0).toFixed(1)} x b ${(best?.bMm ?? 0).toFixed(1)} mm), ` +
        `${candidates.length} candidate(s), length ${length.toPrecision(5)} ${doc.units}${codes.length > 0 ? ` [${codes.join(', ')}]` : ''}. ` +
        'Create it with add_steel_member data.addSteelMember.',
      {
        cloudId,
        unit: doc.units,
        region: regionSpec(region),
        candidates,
        axis: { direction: axis, start: startDoc, end: endDoc },
        member: { start: startDoc, end: endDoc, direction: axis, length },
        measured: {
          hMm: best?.hMm,
          bMm: best?.bMm,
          rollDeg: best?.rollDeg,
          twMm: null,
          tfMm: null,
          twTfReason: 'web and flange thickness are below 10 sigma of a scan in general; read them from the catalogue candidate',
        },
        addSteelMember: { profile: best?.profile, start: startDoc, end: endDoc, roll: memberRoll(axis, depth) },
        rms: fromM(doc, Number(result['rms'])),
        pointsInRegion: result['pointsInRegion'],
        threshold: isRecord(result['threshold']) ? result['threshold'] : null,
        warnings,
        unverified: reasons.length > 0,
        unverifiedReasons: reasons,
        provenance,
      },
    );
  },
});
