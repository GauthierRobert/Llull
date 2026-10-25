/**
 * `PipingNetwork` of a legacy line (plant 05 ISO §5.3): the building `PipeElement`s of one line number, a polyline with a bend at every interior point,
 * turned into pipes and derived long-radius elbows. A bend of turn angle theta gets centre-to-end A = R x tan(theta / 2) with R the long-radius 90 centre-to-end of
 * the bundled B16.9 catalogue (152.4 mm at DN100); 90 and 45 degree turns (within 1 degree) are ELBOWs with SKEY ELBW, any other turn a derived BEND without a key.
 * No catalogue row (an untabulated DN): R = 1.5 x DN (1.5 x NPS x 25.4 with DN standing for NPS x 25.4), flagged unverified. Every derived fitting is flagged
 * `derived` and listed in one ISO_LEGACY_FITTINGS_DERIVED warning. Pure; z is the level elevation plus the point z; document units are converted to mm.
 */

import type { CadDocument } from '@core/model/types';
import type { Vec3 } from '@core/model/vectors';
import { MM_PER_UNIT } from '@core/model/units';
import { add3, distance3, dot3, normalize3, scale3, sub3 } from '@lib/vec3';
import { elementsOf, getBuilding } from '../../building/model';
import type { PipeElement } from '../../building/types';
import { pipeSizeByOutsideDiameter } from '../../industrial/piping/pipeSizes';
import { bundledCatalog } from '../catalog/bundled';
import { resolveCatalogRow } from '../catalog/lookup';
import { isoIssue } from './codes';
import type { IsoIssue, NetworkComponent, NetworkPoint, PipingNetwork } from './model';

/** A legacy pipe has no end type: from this DN up (NPS 2) it is butt welded; below it no key is inferred (socket weld or threaded). */
const BUTT_WELD_FROM_DN = 50;
/** Turns below this are straight pipe (degrees). */
const STRAIGHT_DEG = 0.5;
/** A turn this close to 90 / 45 degrees is that standard elbow (degrees). */
const STANDARD_TOLERANCE_DEG = 1;
/** Pipe pieces shorter than this are not emitted; a negative length beyond it is a too-short segment (mm). */
const LENGTH_TOLERANCE_MM = 0.05;

/** The pipe elements of the document by line number (a pipe without one is its own line, keyed by its id), in element order. */
export function legacyLines(doc: CadDocument): Map<string, PipeElement[]> {
  const lines = new Map<string, PipeElement[]>();
  for (const pipe of elementsOf(getBuilding(doc), 'pipe')) {
    const key = pipe.line ?? pipe.id;
    lines.set(key, [...(lines.get(key) ?? []), pipe]);
  }
  return lines;
}

const nominalBore = (pipe: PipeElement, mmPerUnit: number): number =>
  pipe.dn ?? pipeSizeByOutsideDiameter(pipe.diameter * mmPerUnit)?.[0] ?? pipe.diameter * mmPerUnit;

interface Radius {
  readonly centreToEnd90: number;
  readonly centreToEnd45: number | undefined;
  readonly unverified: boolean;
}

/** Long-radius centre-to-end of the bundled catalogue at `dn`, or the 1.5 x DN rule. */
function radiusOf(dn: number): Radius {
  const lookup = (type: 'elbow90' | 'elbow45'): { value: number; unverified: boolean } | undefined => {
    const outcome = resolveCatalogRow(bundledCatalog(), { type, dn, radius: 'LR' });
    if (!outcome.ok) return undefined;
    const dim = outcome.row.dims['centreToEnd'];
    return dim === undefined ? undefined : { value: dim.value, unverified: !outcome.row.verified };
  };
  const ninety = lookup('elbow90');
  return {
    centreToEnd90: ninety?.value ?? 1.5 * dn,
    centreToEnd45: lookup('elbow45')?.value,
    unverified: ninety === undefined || ninety.unverified,
  };
}

const bw = (xyz: Vec3, boreMm: number): NetworkPoint => ({ xyz, boreMm, endType: 'BW' });

interface Built {
  readonly components: NetworkComponent[];
  readonly warnings: IsoIssue[];
}

/** Pipes and derived elbows of one element (`points` in world mm). */
function buildElement(pipe: PipeElement, points: readonly Vec3[], out: Built, mmPerUnit: number): void {
  const distinct = points.filter((point, index) => index === 0 || distance3(point, points[index - 1] as Vec3) >= LENGTH_TOLERANCE_MM);
  if (distinct.length < 2) return;
  const bore = nominalBore(pipe, mmPerUnit);
  const radius = radiusOf(bore);
  let pipes = 0;
  let fittings = 0;
  let pieceStart = distinct[0] as Vec3;
  let lastFitting: string | undefined;
  const addPipe = (end: Vec3, direction: Vec3, before: string | undefined, after: string | undefined): void => {
    const length = dot3(sub3(end, pieceStart), direction);
    if (length < -LENGTH_TOLERANCE_MM)
      out.warnings.push(
        isoIssue(
          'ISO_SEGMENT_TOO_SHORT',
          'error',
          `the segment between ${before ?? 'the line start'} and ${after ?? 'the line end'} of ${pipe.id} is ${(-length).toFixed(1)} mm too short for its bends`,
          [pipe.id, ...[before, after].filter((id): id is string => id !== undefined)],
        ),
      );
    else if (length > LENGTH_TOLERANCE_MM) {
      pipes += 1;
      out.components.push({ id: `${pipe.id}/pipe-${pipes}`, type: 'PIPE', ends: [bw(pieceStart, bore), bw(end, bore)] });
    }
  };
  for (let index = 1; index < distinct.length - 1; index++) {
    const vertex = distinct[index] as Vec3;
    const incoming = normalize3(sub3(vertex, distinct[index - 1] as Vec3));
    const outgoing = normalize3(sub3(distinct[index + 1] as Vec3, vertex));
    const turnDeg = (Math.acos(Math.min(1, Math.max(-1, dot3(incoming, outgoing)))) * 180) / Math.PI;
    if (turnDeg < STRAIGHT_DEG) continue;
    const standard =
      Math.abs(turnDeg - 90) <= STANDARD_TOLERANCE_DEG ? 90 : Math.abs(turnDeg - 45) <= STANDARD_TOLERANCE_DEG ? 45 : undefined;
    const centreToEnd =
      standard === 90
        ? radius.centreToEnd90
        : standard === 45 && radius.centreToEnd45 !== undefined
          ? radius.centreToEnd45
          : radius.centreToEnd90 * Math.tan((turnDeg * Math.PI) / 360);
    fittings += 1;
    const id = `${pipe.id}/${standard === undefined ? 'bend' : 'elbow'}-${fittings}`;
    addPipe(sub3(vertex, scale3(incoming, centreToEnd)), incoming, lastFitting, id);
    const exit = add3(vertex, scale3(outgoing, centreToEnd));
    out.components.push({
      id,
      type: standard === undefined ? 'BEND' : 'ELBOW',
      ends: [bw(sub3(vertex, scale3(incoming, centreToEnd)), bore), bw(exit, bore)],
      centre: vertex,
      ...(standard === undefined || bore < BUTT_WELD_FROM_DN ? {} : { skey: 'ELBW' }),
      derived: true,
      ...(radius.unverified ? { unverified: true as const } : {}),
    });
    pieceStart = exit;
    lastFitting = id;
  }
  const last = distinct[distinct.length - 1] as Vec3;
  addPipe(last, normalize3(sub3(last, distinct[distinct.length - 2] as Vec3)), lastFitting, undefined);
  for (const [which, end] of [
    ['start', distinct[0]],
    ['end', last],
  ] as const) {
    if ((which === 'start' ? pipe.from : pipe.to) === undefined)
      out.warnings.push(
        isoIssue(
          'ISO_OPEN_END',
          'warning',
          `the ${which} of ${pipe.id} at (${(end as Vec3).map((v) => v.toFixed(1)).join(', ')}) is an open end: no from / to`,
          [pipe.id],
        ),
      );
  }
}

/**
 * The network of legacy line `lineId` (null when no pipe carries it).
 * @invariant elements in document order; each element is its own polyline (no joins between elements are inferred)
 */
export function legacyNetwork(doc: CadDocument, lineId: string): PipingNetwork | null {
  const pipes = legacyLines(doc).get(lineId);
  if (pipes === undefined) return null;
  const building = getBuilding(doc);
  const mmPerUnit = MM_PER_UNIT[doc.units];
  const built: Built = { components: [], warnings: [] };
  for (const pipe of pipes)
    buildElement(
      pipe,
      pipe.points.map(
        (point): Vec3 => [
          point[0] * mmPerUnit,
          point[1] * mmPerUnit,
          (point[2] + (building.levels[pipe.levelId]?.elevation ?? 0)) * mmPerUnit,
        ],
      ),
      built,
      mmPerUnit,
    );
  const derived = built.components.filter((component) => component.derived === true).map((component) => component.id);
  const warnings: IsoIssue[] = [
    ...(derived.length === 0
      ? []
      : [
          isoIssue(
            'ISO_LEGACY_FITTINGS_DERIVED',
            'warning',
            `${derived.length} fitting(s) of line ${lineId} are derived from the polyline (long-radius elbows), not placed by a spec`,
            derived,
          ),
        ]),
    ...built.warnings,
  ];
  const specId = pipes.find((pipe) => pipe.spec !== undefined)?.spec?.specId;
  const project = doc.building?.project.name.trim().replace(/\s+/g, '-') || 'llull';
  return {
    lineId,
    attributes: { ...(specId === undefined ? {} : { 'PIPING-SPEC': specId }), 'PROJECT-IDENTIFIER': project },
    components: built.components,
    source: 'legacy',
    warnings,
  };
}
