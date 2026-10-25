/**
 * `PipingNetwork` of a routed line (plant 05 ISO §3, §5.2; the 02 RTE writer of §13.10 evolved into the 05 reader port): the derived parts of the runs of
 * a pipe line, in run order then route order, as PCF components. A SKEY is set only where the isometric key is confirmed (05 `skey_catalogue.json`:
 * ELBW, ELSW, TEBW, FLWN, REBW); a component whose key is not confirmed has none and is listed in `missingSkey` (llull never invents a key).
 * A stub-in has no PCF component (the branch pipe is welded to the header) and is listed in `skipped`.
 */

import type { Vec3 } from '@core/model/vectors';
import type { PartPort, PipeLine, RoutedPart } from '@aec/plant/types';
import type { RunDerivation } from '../piping/deriveTypes';
import type { NetworkComponent, NetworkPoint, PcfComponentType, PipingNetwork } from './model';

export interface RouteRun {
  readonly runId: string;
  readonly derivation: RunDerivation;
}

export interface RouteLineInput {
  readonly line: PipeLine;
  /** The runs of the line in run order. */
  readonly runs: readonly RouteRun[];
  /** Project name for PROJECT-IDENTIFIER (absent = llull). */
  readonly project?: string | undefined;
}

export interface RouteNetwork {
  readonly network: PipingNetwork;
  /** Parts that have no PCF component (stub-ins, generic inline parts) with the reason. */
  readonly skipped: ReadonlyArray<{ readonly partId: string; readonly reason: string }>;
  /** Bolt sets (a BOLT record has no coordinates): joint centre, stud count and diameter, for the hand-off. */
  readonly bolts: ReadonlyArray<{
    readonly partId: string;
    readonly centre: Vec3 | null;
    readonly studs: number;
    readonly diameterMm: number | null;
  }>;
}

/** Two-character PCF end-connection code of an llull end type (wafer and lug ends are flanged-type ends). */
const endCode = (type: PartPort['endType']): string => (type === 'WAF' || type === 'LUG' ? 'FL' : type);

const portPoint = (port: PartPort): NetworkPoint => ({ xyz: port.position, boreMm: port.dn, endType: endCode(port.endType) });

const bore = (dn: number): string => String(Math.round(dn * 100) / 100);

/** The ISOGEN symbol key when it is one of the confirmed ones, else undefined. */
function skeyOf(part: RoutedPart): string | undefined {
  const end = part.ports[0]?.endType;
  if (part.kind === 'elbow' && part.typeKey.startsWith('elbow')) return end === 'BW' ? 'ELBW' : end === 'SW' ? 'ELSW' : undefined;
  if (part.kind === 'tee' && end === 'BW') return 'TEBW';
  if (part.kind === 'flange' && part.typeKey === 'flangeWeldNeck') return 'FLWN';
  if (part.kind === 'reducer' && part.typeKey === 'reducerEccentric' && end === 'BW') return 'REBW';
  return undefined;
}

/** Compass word of an axis-aligned spindle direction (Z up), undefined for any other direction. */
function spindle(direction: Vec3 | undefined): string | undefined {
  if (direction === undefined) return undefined;
  const words: ReadonlyArray<[Vec3, string]> = [
    [[0, 0, 1], 'UP'],
    [[0, 0, -1], 'DOWN'],
    [[0, 1, 0], 'NORTH'],
    [[0, -1, 0], 'SOUTH'],
    [[1, 0, 0], 'EAST'],
    [[-1, 0, 0], 'WEST'],
  ];
  return words.find(([axis]) => Math.hypot(direction[0] - axis[0], direction[1] - axis[1], direction[2] - axis[2]) < 1e-6)?.[1];
}

/** PCF type of a part, or the reason it has none. */
function typeOf(part: RoutedPart): PcfComponentType | { readonly skip: string } {
  switch (part.kind) {
    case 'pipe':
      return 'PIPE';
    case 'elbow':
      return part.typeKey === 'pipeBend' ? 'BEND' : 'ELBOW';
    case 'tee':
      return 'TEE';
    case 'olet':
      return 'OLET';
    case 'reducer':
      return part.typeKey === 'reducerEccentric' ? 'REDUCER-ECCENTRIC' : 'REDUCER-CONCENTRIC';
    case 'flange':
      return 'FLANGE';
    case 'gasket':
      return 'GASKET';
    case 'boltSet':
      return 'BOLT';
    case 'valve':
      return 'VALVE';
    case 'cap':
      return 'CAP';
    case 'stubIn':
      return { skip: 'a stub-in has no PCF component: the branch pipe is welded to the header' };
    case 'inline':
      return { skip: 'a generic inline part has no PCF component' };
  }
}

const itemCode = (part: RoutedPart): string => part.catalogueKey.replaceAll('/', '-');

function description(part: RoutedPart): string {
  const size = part.dn2 === undefined ? `DN${bore(part.dn)}` : `DN${bore(part.dn)} x DN${bore(part.dn2)}`;
  const od = part.dims['outsideDiameter'];
  const wall = part.dims['wall'];
  const pipe = part.kind === 'pipe' && od !== undefined && wall !== undefined ? `, OD ${od} x ${wall} wall` : '';
  const studs =
    part.kind === 'boltSet' ? `, ${part.studs ?? part.dims['boltCount'] ?? '?'} x ${part.dims['boltDiameter'] ?? '?'} mm studs` : '';
  return `${part.typeKey} ${size}${pipe}${studs} (llull catalogue row ${part.catalogueKey})`;
}

/** The geometry of one component: its end points, centre and branch as the PCF record of its type carries them. */
function geometry(part: RoutedPart, type: PcfComponentType): Pick<NetworkComponent, 'ends' | 'centre' | 'branch'> {
  const [first, second] = part.ports;
  switch (type) {
    case 'ELBOW':
    case 'BEND':
      return { ends: first && second ? [portPoint(first), portPoint(second)] : [], ...(part.centre ? { centre: part.centre } : {}) };
    case 'TEE': {
      const branch = part.ports[2];
      return {
        ends: first && second ? [portPoint(first), portPoint(second)] : [],
        ...(part.centre ? { centre: part.centre } : {}),
        ...(branch ? { branch: portPoint(branch) } : {}),
      };
    }
    case 'OLET': {
      const centre = part.centre ?? first?.position;
      return { ends: [], ...(centre ? { centre } : {}), ...(second ? { branch: portPoint(second) } : {}) };
    }
    case 'BOLT':
      return { ends: [] };
    default:
      return { ends: part.ports.slice(0, 2).map(portPoint) };
  }
}

/**
 * The network of one routed line.
 * @invariant components appear in run order, then route order; ids are the part ids; deterministic
 */
export function routeNetwork(input: RouteLineInput): RouteNetwork {
  const { line } = input;
  const attributes: Record<string, string> = { 'PIPING-SPEC': line.spec };
  if (line.insulation) attributes['INSULATION-SPEC'] = `${line.insulation.code}${line.insulation.thicknessMm}`;
  if (line.tracing) attributes['TRACING-SPEC'] = line.tracing.type.toUpperCase();
  attributes['PROJECT-IDENTIFIER'] = (input.project ?? '').trim().replace(/\s+/g, '-') || 'llull';
  const components: NetworkComponent[] = [];
  const skipped: Array<{ partId: string; reason: string }> = [];
  const bolts: Array<{ partId: string; centre: Vec3 | null; studs: number; diameterMm: number | null }> = [];
  for (const { derivation } of input.runs) {
    for (const part of derivation.parts) {
      const type = typeOf(part);
      if (typeof type !== 'string') {
        skipped.push({ partId: part.id, reason: type.skip });
        continue;
      }
      const skey = type === 'PIPE' || type === 'GASKET' || type === 'BOLT' ? undefined : skeyOf(part);
      const word = type === 'VALVE' ? spindle(part.stemDirection) : undefined;
      if (type === 'BOLT')
        bolts.push({
          partId: part.id,
          centre: part.centre ?? null,
          studs: part.studs ?? part.dims['boltCount'] ?? 0,
          diameterMm: part.dims['boltDiameter'] ?? null,
        });
      components.push({
        id: part.id,
        type,
        ...geometry(part, type),
        ...(skey === undefined ? {} : { skey }),
        itemCode: itemCode(part),
        description: description(part),
        ...(type === 'BOLT' ? { category: 'erection' as const } : {}),
        ...(part.unverified ? { unverified: true as const } : {}),
        ...(word === undefined ? {} : { extra: { 'SPINDLE-DIRECTION': word } }),
      });
    }
  }
  return { network: { lineId: line.lineNumber, attributes, components, source: 'route', warnings: [] }, skipped, bolts };
}
