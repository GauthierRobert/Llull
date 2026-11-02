/**
 * Axial layout of a horizontal shell-and-tube exchanger (plant 03 EQP §5.7). Local frame: +X along the tube axis, origin on the axis at the middle of
 * the OUTSIDE overall length (so the legacy plan box is centred on `location`), axis elevation = saddle axis or base + outside radius.
 * Layout from the front: front closure (flat cover or 2:1 bonnet) - front channel - front tubesheet - shell - [rear tubesheet - rear channel -
 * rear closure] or, for a U / floating rear, a 2:1 shell cover closing the shell. Shell stations count from the front end of the shell.
 */

import type { ExchangerTemplate, NozzleRecord } from '../plantData';
import { headVolume, type HeadShape } from './heads';
import { aroundXAxis, type NozzlePlacement } from './placement';
import { headApexHeight } from './vesselProfile';

export interface ExchangerEnd {
  readonly closure: 'bonnet' | 'flat' | 'shell_cover';
  readonly head: HeadShape;
  readonly channelLength: number;
  readonly channelThickness: number;
  readonly hasTubesheet: boolean;
  /** x range of the tubesheet / channel (collapsed to the shell edge when absent). */
  readonly tubesheetFrom: number;
  readonly tubesheetTo: number;
  readonly channelFrom: number;
  readonly channelTo: number;
  /** x where the closure starts (outer end of the channel, or the shell edge for a shell cover). */
  readonly tangent: number;
  /** Direction away from the shell along X. */
  readonly sign: 1 | -1;
  readonly insideApex: number;
  readonly outsideApex: number;
}

export interface ExchangerGeometry {
  readonly radius: number;
  readonly outerRadius: number;
  readonly shellThickness: number;
  readonly shellLength: number;
  readonly tubesheet: number;
  readonly shellFrom: number;
  readonly shellTo: number;
  readonly front: ExchangerEnd;
  readonly rear: ExchangerEnd;
  /** Elevation of the tube axis in the equipment frame. */
  readonly datum: number;
  readonly insideOverallLength: number;
  readonly outsideOverallLength: number;
}

const FLAT: HeadShape = { kind: 'flat', depth: 0 };

function makeEnd(
  sign: 1 | -1,
  shellEdge: number,
  closure: ExchangerEnd['closure'],
  channel: { length: number; thickness: number },
  tubesheet: number,
  radius: number,
): ExchangerEnd {
  const head: HeadShape = closure === 'flat' ? FLAT : { kind: 'ellipsoidal', depth: radius / 2 };
  const hasTubesheet = closure !== 'shell_cover';
  const sheetOuter = shellEdge + sign * (hasTubesheet ? tubesheet : 0);
  const channelOuter = sheetOuter + sign * (hasTubesheet ? channel.length : 0);
  const outsideHeight = closure === 'flat' ? channel.thickness : headApexHeight(head, radius, channel.thickness);
  return {
    closure,
    head,
    channelLength: hasTubesheet ? channel.length : 0,
    channelThickness: channel.thickness,
    hasTubesheet,
    tubesheetFrom: Math.min(shellEdge, sheetOuter),
    tubesheetTo: Math.max(shellEdge, sheetOuter),
    channelFrom: Math.min(sheetOuter, channelOuter),
    channelTo: Math.max(sheetOuter, channelOuter),
    tangent: channelOuter,
    sign,
    insideApex: channelOuter + sign * head.depth,
    outsideApex: channelOuter + sign * outsideHeight,
  };
}

function layout(template: ExchangerTemplate, shellFrom: number): Omit<ExchangerGeometry, 'datum' | 'outerRadius'> {
  const radius = template.shellInsideDiameter / 2;
  const fixed = template.tema.fixedTubesheet;
  const tubesheet = template.tubesheetThickness;
  const shellLength = template.tubes.length - (fixed ? 2 : 1) * tubesheet;
  const shellTo = shellFrom + shellLength;
  const frontClosure = template.tema.front === 'B' ? 'bonnet' : 'flat';
  const rearClosure = !fixed ? 'shell_cover' : template.tema.rear === 'M' ? 'bonnet' : 'flat';
  const front = makeEnd(-1, shellFrom, frontClosure, template.frontChannel, tubesheet, radius);
  const rear = makeEnd(
    1,
    shellTo,
    rearClosure,
    template.rearChannel ?? { length: 0, thickness: template.shellThickness },
    tubesheet,
    radius,
  );
  return {
    radius,
    shellThickness: template.shellThickness,
    shellLength,
    tubesheet,
    shellFrom,
    shellTo,
    front,
    rear,
    insideOverallLength: rear.insideApex - front.insideApex,
    outsideOverallLength: rear.outsideApex - front.outsideApex,
  };
}

const largestWall = (template: ExchangerTemplate): number =>
  Math.max(template.shellThickness, template.frontChannel.thickness, template.rearChannel?.thickness ?? 0);

/** Elevation of the tube axis: the saddle axis elevation, or the base elevation plus the largest outside radius. */
function exchangerDatum(template: ExchangerTemplate): number {
  const { support } = template;
  if (support.type === 'saddles') return support.axisElevation;
  return (support.type === 'none' ? support.baseElevation : 0) + template.shellInsideDiameter / 2 + largestWall(template);
}

/** The resolved layout, recentred so the middle of the outside overall length is x = 0. */
export function resolveExchanger(template: ExchangerTemplate): ExchangerGeometry {
  const first = layout(template, 0);
  const shift = (first.front.outsideApex + first.rear.outsideApex) / 2;
  return {
    ...layout(template, -shift),
    datum: exchangerDatum(template),
    outerRadius: template.shellInsideDiameter / 2 + largestWall(template),
  };
}

/** Volumes in document units cubed: shell side (shell minus the tubes' outside, plus the shell cover) and tube side (bores + channels and bonnets). */
export function exchangerVolumes(template: ExchangerTemplate, geometry: ExchangerGeometry): { shellSide: number; tubeSide: number } {
  const { tubes } = template;
  const { radius } = geometry;
  const bore = tubes.outsideDiameter - 2 * tubes.wallThickness;
  const area = Math.PI * radius * radius;
  const shellSide =
    (area - (tubes.count * Math.PI * tubes.outsideDiameter ** 2) / 4) * geometry.shellLength +
    (geometry.rear.closure === 'shell_cover' ? headVolume(geometry.rear.head, radius) : 0);
  const channelVolume = (end: ExchangerEnd): number => (end.hasTubesheet ? area * end.channelLength + headVolume(end.head, radius) : 0);
  const tubeSide = (tubes.count * Math.PI * bore * bore * tubes.length) / 4 + channelVolume(geometry.front) + channelVolume(geometry.rear);
  return { shellSide, tubeSide };
}

/** x of a channel station: from the tubesheet face outward. */
const channelStationX = (end: ExchangerEnd, station: number): number =>
  (end.sign < 0 ? end.tubesheetFrom : end.tubesheetTo) + end.sign * station;

export function exchangerPlacement(template: ExchangerTemplate, nozzle: NozzleRecord): NozzlePlacement | null {
  const geometry = resolveExchanger(template);
  const { location, projection } = nozzle;
  if (location.on === 'shell' && 'station' in location)
    return aroundXAxis(
      geometry.shellFrom + location.station,
      geometry.datum,
      location.orientationDeg,
      geometry.radius + geometry.shellThickness / 2,
      projection,
    );
  if (location.on === 'channel') {
    const end = location.channel === 'front' ? geometry.front : geometry.rear;
    if (end.channelLength <= 0) return null;
    return aroundXAxis(
      channelStationX(end, location.station),
      geometry.datum,
      location.orientationDeg,
      geometry.radius + end.channelThickness / 2,
      projection,
    );
  }
  return null;
}
