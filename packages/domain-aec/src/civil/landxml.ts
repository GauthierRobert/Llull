/**
 * LandXML 1.2 writer of the civil model: point groups (CgPoints), TIN surfaces, gravity pipe
 * networks and (via the roads module) alignments. LandXML coordinates are "northing easting
 * elevation" in metres.
 * @layer domain-aec/civil
 * @pure
 */

import type { CadDocument, Vec2 } from '@core/model/types';
import type {
  CivilModel,
  ManholeObject,
  PipeObject,
  PointGroupObject,
  SurfaceObject,
} from '@core/model/civil';
import { escapeXml } from '@lib/escapeXml';
import { toMetres } from '../model';
import { civilObjectsOf, getCivil } from './model';
import { surfaceTin } from './surfaceTin';
import { alignmentsXml } from './landxmlAlignments';
import { gridCivil, resolveFrame, type CoordinateFrame } from './crs';

export const LANDXML_NAMESPACE = 'http://www.landxml.org/schema/LandXML-1.2';

type Doc = Pick<CadDocument, 'civil' | 'units'>;

export interface LandXmlCounts {
  readonly cgPoints: number;
  readonly surfaces: number;
  readonly faces: number;
  readonly structures: number;
  readonly pipes: number;
}

/** Metres with at most 4 decimals (0.1 mm), no trailing zeros, never "-0". */
function metres(doc: Doc, value: number): string {
  const rounded = Number(toMetres(doc, value).toFixed(4));
  return Object.is(rounded, -0) ? '0' : String(rounded);
}

/** "N E" (plan) or "N E Z" of a document-unit point. */
function northEast(doc: Doc, point: Vec2): string {
  return `${metres(doc, point[1])} ${metres(doc, point[0])}`;
}

const attr = (name: string, value: string): string => ` ${name}="${escapeXml(value)}"`;

/** Names unique within one list (LandXML refs are by name): duplicates get " (<id>)". */
function uniqueNames(objects: ReadonlyArray<{ id: string; name: string }>): Map<string, string> {
  const counts = new Map<string, number>();
  for (const object of objects) counts.set(object.name, (counts.get(object.name) ?? 0) + 1);
  return new Map(
    objects.map((object) => [
      object.id,
      (counts.get(object.name) ?? 0) > 1 || object.name === ''
        ? `${object.name} (${object.id})`.trim()
        : object.name,
    ]),
  );
}

function cgPointsXml(doc: Doc, groups: ReadonlyArray<PointGroupObject>): string[] {
  return groups.flatMap((group) => [
    `  <CgPoints${attr('name', group.name)}>`,
    ...group.points.map(
      (point) =>
        `    <CgPoint${attr('name', point.number)}${point.code !== undefined ? attr('code', point.code) : ''}>` +
        `${northEast(doc, [point.position[0], point.position[1]])} ${metres(doc, point.position[2])}</CgPoint>`,
    ),
    '  </CgPoints>',
  ]);
}

function surfaceXml(doc: Doc, civil: CivilModel, surface: SurfaceObject): string[] {
  const tin = surfaceTin(civil, surface);
  const elevations = tin.points.map((point) => point[2]);
  const range =
    elevations.length > 0
      ? attr('elevMin', metres(doc, Math.min(...elevations))) +
        attr('elevMax', metres(doc, Math.max(...elevations)))
      : '';
  const faces: string[] = [];
  for (let k = 0; k + 2 < tin.triangles.length; k += 3) {
    const [a, b, c] = [tin.triangles[k], tin.triangles[k + 1], tin.triangles[k + 2]];
    faces.push(`        <F>${(a ?? 0) + 1} ${(b ?? 0) + 1} ${(c ?? 0) + 1}</F>`);
  }
  return [
    `    <Surface${attr('name', surface.name)}>`,
    `      <Definition surfType="TIN"${range}>`,
    '        <Pnts>',
    ...tin.points.map(
      (point, index) =>
        `          <P id="${index + 1}">${northEast(doc, [point[0], point[1]])} ${metres(doc, point[2])}</P>`,
    ),
    '        </Pnts>',
    '        <Faces>',
    ...faces.map((face) => `  ${face}`),
    '        </Faces>',
    '      </Definition>',
    '    </Surface>',
  ];
}

function structXml(
  doc: Doc,
  manhole: ManholeObject,
  pipes: ReadonlyArray<PipeObject>,
  names: ReadonlyMap<string, string>,
): string[] {
  const inverts = pipes.flatMap((pipe) => {
    const name = names.get(pipe.id) ?? pipe.id;
    const result: string[] = [];
    if (pipe.toId === manhole.id) {
      result.push(
        `          <Invert${attr('elev', metres(doc, pipe.invertTo))} flowDir="in"${attr('refPipe', name)}/>`,
      );
    }
    if (pipe.fromId === manhole.id) {
      result.push(
        `          <Invert${attr('elev', metres(doc, pipe.invertFrom))} flowDir="out"${attr('refPipe', name)}/>`,
      );
    }
    return result;
  });
  return [
    `        <Struct${attr('name', names.get(manhole.id) ?? manhole.id)}` +
      `${attr('elevRim', metres(doc, manhole.rimElevation))}` +
      `${attr('elevSump', metres(doc, manhole.invertElevation))}>`,
    `          <Center>${northEast(doc, manhole.position)}</Center>`,
    `          <CircStruct${attr('diameter', String(Number((toMetres(doc, manhole.diameter) * 1000).toFixed(1))))}/>`,
    ...inverts,
    '        </Struct>',
  ];
}

function pipeXml(
  doc: Doc,
  pipe: PipeObject,
  manholes: ReadonlyMap<string, ManholeObject>,
  names: ReadonlyMap<string, string>,
): string[] {
  const from = manholes.get(pipe.fromId);
  const to = manholes.get(pipe.toId);
  const planLength =
    from && to
      ? Math.hypot(to.position[0] - from.position[0], to.position[1] - from.position[1])
      : 0;
  const slope = planLength > 0 ? (pipe.invertFrom - pipe.invertTo) / planLength : 0;
  return [
    `        <Pipe${attr('name', names.get(pipe.id) ?? pipe.id)}` +
      `${attr('refStart', names.get(pipe.fromId) ?? pipe.fromId)}` +
      `${attr('refEnd', names.get(pipe.toId) ?? pipe.toId)}` +
      `${attr('length', metres(doc, planLength))}${attr('slope', String(Number(slope.toFixed(6))))}>`,
    `          <CircPipe${attr('diameter', String(Number((toMetres(doc, pipe.diameter) * 1000).toFixed(1))))}` +
      `${attr('material', pipe.material)}${attr('mannings', String(pipe.manningN))}/>`,
    '        </Pipe>',
  ];
}

function pipeNetworkXml(
  doc: Doc,
  manholes: ReadonlyArray<ManholeObject>,
  pipes: ReadonlyArray<PipeObject>,
): string[] {
  if (manholes.length === 0 && pipes.length === 0) return [];
  const names = new Map([...uniqueNames(manholes), ...uniqueNames(pipes)]);
  const byId = new Map(manholes.map((manhole) => [manhole.id, manhole]));
  return [
    '  <PipeNetworks>',
    '    <PipeNetwork name="Storm" pipeNetType="storm">',
    '      <Structs>',
    ...manholes.flatMap((manhole) => structXml(doc, manhole, pipes, names)),
    '      </Structs>',
    '      <Pipes>',
    ...pipes.flatMap((pipe) => pipeXml(doc, pipe, byId, names)),
    '      </Pipes>',
    '    </PipeNetwork>',
    '  </PipeNetworks>',
  ];
}

export interface LandXmlOptions {
  readonly projectName: string;
  /** ISO date (yyyy-mm-dd) of the header. */
  readonly date: string;
  /** Plan coordinates frame; default grid when the site is calibrated. */
  readonly coordinates?: CoordinateFrame;
}

function coordinateSystemXml(doc: Doc, frame: CoordinateFrame): string[] {
  const crs = doc.civil?.crs;
  if (!crs || (crs.calibration && frame === 'local')) return [];
  return [
    `  <CoordinateSystem${attr('name', crs.name)}` +
      `${crs.epsg !== undefined ? attr('epsgCode', String(crs.epsg)) : ''}` +
      `${crs.verticalDatum !== undefined ? attr('verticalDatum', crs.verticalDatum) : ''}/>`,
  ];
}

/** The LandXML 1.2 document of the civil model, with element counts. */
export function buildLandXml(
  doc: Doc,
  { projectName, date, coordinates }: LandXmlOptions,
): { text: string; counts: LandXmlCounts } {
  const frame = resolveFrame(doc, coordinates);
  const calibration = doc.civil?.crs?.calibration;
  const source = getCivil(doc);
  const civil = frame === 'grid' && calibration ? gridCivil(source, calibration) : source;
  const written: Doc = { ...doc, civil };
  const groups = civilObjectsOf(civil, 'pointGroup');
  const surfaces = civilObjectsOf(civil, 'surface');
  const manholes = civilObjectsOf(civil, 'manhole');
  const pipes = civilObjectsOf(civil, 'pipe');
  const surfaceLines = surfaces.flatMap((surface) => surfaceXml(written, civil, surface));
  const alignments = alignmentsXml(written);
  const lines = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<LandXML xmlns="${LANDXML_NAMESPACE}" version="1.2"${attr('date', date)} time="00:00:00">`,
    '  <Units>',
    '    <Metric linearUnit="meter" areaUnit="squareMeter" volumeUnit="cubicMeter" ' +
      'temperatureUnit="celsius" pressureUnit="milliBars" diameterUnit="millimeter" ' +
      'angularUnit="decimal degrees" directionUnit="decimal degrees"/>',
    '  </Units>',
    ...coordinateSystemXml(doc, frame),
    `  <Project${attr('name', projectName)}/>`,
    '  <Application name="llull" manufacturer="llull" version="1.0"/>',
    ...cgPointsXml(written, groups),
    ...(alignments !== '' ? [alignments.replace(/\n$/, '')] : []),
    ...(surfaces.length > 0 ? ['  <Surfaces>', ...surfaceLines, '  </Surfaces>'] : []),
    ...pipeNetworkXml(written, manholes, pipes),
    '</LandXML>',
  ];
  return {
    text: `${lines.join('\n')}\n`,
    counts: {
      cgPoints: groups.reduce((sum, group) => sum + group.points.length, 0),
      surfaces: surfaces.length,
      faces: surfaceLines.filter((line) => line.includes('<F>')).length,
      structures: manholes.length,
      pipes: pipes.length,
    },
  };
}
