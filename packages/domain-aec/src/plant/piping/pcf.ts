/**
 * PCF text writer (02 RTE §6, hand-off to 05 isometrics): one Piping Component File per pipe line from the derived parts of its runs. Canonical form of
 * docs/plant/05-isometrics-fabrication (TR-ISO-02): header keywords in fixed order, `PIPELINE-REFERENCE` with its attributes, one record per component in
 * route order with 1-based `COMPONENT-IDENTIFIER`, coordinates with one decimal (0.1 mm), no TAB, `MATERIALS` last. Pure; the same line gives the same bytes.
 *
 * Records: PIPE, ELBOW / BEND, TEE, OLET, REDUCER-CONCENTRIC / -ECCENTRIC, FLANGE, GASKET, BOLT, VALVE, CAP with `END-POINT x y z bore endType`,
 * `CENTRE-POINT` (elbows, bends, tees), `BRANCH1-POINT` (tees, olets). A SKEY is written only where the isometric key is confirmed (05 `skey_catalogue.json`:
 * ELBW, ELSW, TEBW, FLWN, REBW); a component whose key is not confirmed is written without one and listed in `missingSkey` (llull never invents a key).
 * A stub-in has no PCF component (the branch pipe is welded to the header) and is listed in `skipped`.
 */

import type { Vec3 } from '@core/model/vectors';
import type { PartPort, PipeLine, RoutedPart } from '@aec/plant/types';
import type { RunDerivation } from './deriveTypes';

export interface PcfRun {
  readonly runId: string;
  readonly derivation: RunDerivation;
}

export interface PcfLine {
  readonly line: PipeLine;
  /** The runs of the line in run order. */
  readonly runs: readonly PcfRun[];
  /** Project name for PROJECT-IDENTIFIER (absent = llull). */
  readonly project?: string | undefined;
}

export interface PcfResult {
  /** `<line number>.pcf`, characters outside letters, digits, `.`, `_` and `-` replaced by `_`. */
  readonly name: string;
  readonly content: string;
  readonly componentCount: number;
  /** Component counts by PCF keyword (05 isometrics reads them as `countsByType`). */
  readonly countsByType: Readonly<Record<string, number>>;
  /** Parts that have no PCF component (stub-ins, unknown kinds) with the reason. */
  readonly skipped: ReadonlyArray<{ readonly partId: string; readonly reason: string }>;
  /** Parts written without a SKEY: no confirmed isometric key for them. */
  readonly missingSkey: readonly string[];
  /** Bolt sets (a BOLT record has no coordinates): joint centre, stud count and diameter, for the hand-off. */
  readonly bolts: ReadonlyArray<{
    readonly partId: string;
    readonly centre: Vec3 | null;
    readonly studs: number;
    readonly diameterMm: number | null;
  }>;
}

const HEADER = [
  'ISOGEN-FILES ISOGEN.FLS',
  'UNITS-BORE MM',
  'UNITS-CO-ORDS MM',
  'UNITS-WEIGHT KGS',
  'UNITS-BOLT-DIA MM',
  'UNITS-BOLT-LENGTH MM',
];

/** One decimal, `-0.0` printed `0.0`. */
const coordinate = (value: number): string => {
  const text = value.toFixed(1);
  return text === '-0.0' ? '0.0' : text;
};

const point = (position: Vec3): string => position.map(coordinate).join(' ');

/** Nominal bore: integer when whole, else the shortest decimal. */
const bore = (dn: number): string => String(Math.round(dn * 100) / 100);

/** Two-character PCF end-connection code of an llull end type (wafer and lug ends are flanged-type ends). */
const endCode = (type: PartPort['endType']): string => (type === 'WAF' || type === 'LUG' ? 'FL' : type);

const endPoint = (port: PartPort): string => `    END-POINT ${point(port.position)} ${bore(port.dn)} ${endCode(port.endType)}`;
const branchPoint = (port: PartPort): string => `    BRANCH1-POINT ${point(port.position)} ${bore(port.dn)} ${endCode(port.endType)}`;
const centrePoint = (position: Vec3): string => `    CENTRE-POINT ${point(position)}`;

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

/** PCF keyword of a part, or the reason it has none. */
function keywordOf(part: RoutedPart): string | { readonly skip: string } {
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

/** The record lines of one component (without the keyword line and the identifier). */
function attributes(part: RoutedPart, keyword: string): string[] {
  const [first, second] = part.ports;
  const lines: string[] = [];
  switch (keyword) {
    case 'ELBOW':
    case 'BEND':
      if (first && second) lines.push(endPoint(first), endPoint(second));
      if (part.centre) lines.push(centrePoint(part.centre));
      break;
    case 'TEE': {
      const branch = part.ports[2];
      if (first && second) lines.push(endPoint(first), endPoint(second));
      if (part.centre) lines.push(centrePoint(part.centre));
      if (branch) lines.push(branchPoint(branch));
      break;
    }
    case 'OLET': {
      if (part.centre ?? first) lines.push(centrePoint((part.centre ?? first?.position) as Vec3));
      if (second) lines.push(branchPoint(second));
      break;
    }
    case 'BOLT':
      break;
    default:
      for (const port of part.ports) lines.push(endPoint(port));
  }
  return lines;
}

/**
 * The PCF of one line.
 * @invariant components appear in run order, then route order; ids 1..n over the line; deterministic bytes
 */
export function writePcf(input: PcfLine): PcfResult {
  const { line } = input;
  const out: string[] = [...HEADER, `PIPELINE-REFERENCE ${line.lineNumber}`, `    PIPING-SPEC ${line.spec}`];
  if (line.insulation) out.push(`    INSULATION-SPEC ${line.insulation.code}${line.insulation.thicknessMm}`);
  if (line.tracing) out.push(`    TRACING-SPEC ${line.tracing.type.toUpperCase()}`);
  out.push(`    PROJECT-IDENTIFIER ${(input.project ?? '').trim().replace(/\s+/g, '-') || 'llull'}`);
  const counts: Record<string, number> = {};
  const skipped: Array<{ partId: string; reason: string }> = [];
  const missingSkey: string[] = [];
  const bolts: Array<{ partId: string; centre: Vec3 | null; studs: number; diameterMm: number | null }> = [];
  const materials = new Map<string, string>();
  let count = 0;
  for (const { derivation } of input.runs) {
    for (const part of derivation.parts) {
      const keyword = keywordOf(part);
      if (typeof keyword !== 'string') {
        skipped.push({ partId: part.id, reason: keyword.skip });
        continue;
      }
      count += 1;
      counts[keyword] = (counts[keyword] ?? 0) + 1;
      const skey = keyword === 'PIPE' || keyword === 'GASKET' || keyword === 'BOLT' ? undefined : skeyOf(part);
      if (skey === undefined && keyword !== 'PIPE' && keyword !== 'GASKET' && keyword !== 'BOLT') missingSkey.push(part.id);
      out.push(keyword, `    COMPONENT-IDENTIFIER ${count}`, `    UNIQUE-COMPONENT-IDENTIFIER ${part.id}`, ...attributes(part, keyword));
      if (keyword === 'VALVE') {
        const word = spindle(part.stemDirection);
        if (word !== undefined) out.push(`    SPINDLE-DIRECTION ${word}`);
      }
      if (skey !== undefined) out.push(`    SKEY ${skey}`);
      if (keyword === 'BOLT') {
        out.push('    ERECTION-ITEM');
        bolts.push({
          partId: part.id,
          centre: part.centre ?? null,
          studs: part.studs ?? part.dims['boltCount'] ?? 0,
          diameterMm: part.dims['boltDiameter'] ?? null,
        });
      }
      out.push(`    ITEM-CODE ${itemCode(part)}`);
      if (!materials.has(itemCode(part))) materials.set(itemCode(part), description(part));
    }
  }
  if (materials.size > 0) {
    out.push('MATERIALS');
    for (const [code, text] of materials) out.push(`ITEM-CODE ${code}`, `    DESCRIPTION ${text}`);
  }
  const content = `${out.map((text) => text.slice(0, 1024)).join('\n')}\n`;
  return {
    name: `${line.lineNumber.replace(/[^A-Za-z0-9._-]/g, '_')}.pcf`,
    content,
    componentCount: count,
    countsByType: counts,
    skipped,
    missingSkey,
    bolts,
  };
}
