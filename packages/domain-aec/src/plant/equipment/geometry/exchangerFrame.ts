/**
 * Axial layout of a shell-and-tube exchanger (plant 03 EQP §5.7). Local frame: axial coordinate x along the tube axis, origin at the middle of the
 * OUTSIDE overall length. Horizontal: the axis is local +X at the axis elevation (saddle axis or base + outside radius). Vertical: the axis is the
 * equipment Z axis, the front head at the bottom, `z = x + zOffset`, the bottom tangent line of the front closure at the support height.
 * Layout from the front: front closure (flat cover or 2:1 bonnet) - front channel - front tubesheet - shell - [rear tubesheet - rear channel -
 * rear closure] or, for a U / floating rear, a 2:1 shell cover closing the shell. A TEMA K shell is a restricted cylinder, a cone and an enlarged cylinder.
 * Shell stations count from the front end of the shell.
 */

import type { Vec3 } from '@core/model/types';
import type { ExchangerTemplate, NozzleRecord } from '../plantData';
import { segmentFluidVolume, shellWallAt, type ShellSegment } from './exchangerShell';
import { headVolume, type HeadShape } from './heads';
import { aroundXAxis, aroundZAxis, type NozzlePlacement } from './placement';
import { headApexHeight } from './vesselProfile';

export interface ExchangerEnd {
  readonly closure: 'bonnet' | 'flat' | 'shell_cover';
  readonly head: HeadShape;
  /** Inside radius of the channel / closure of this end. */
  readonly radius: number;
  readonly channelLength: number;
  readonly channelThickness: number;
  /** Flat cover thickness (the channel wall unless the channel gives coverThickness, front head D). */
  readonly coverThickness: number;
  readonly hasTubesheet: boolean;
  /** x range of the tubesheet / channel (collapsed to the shell edge when absent). */
  readonly tubesheetFrom: number;
  readonly tubesheetTo: number;
  readonly channelFrom: number;
  readonly channelTo: number;
  /** x where the closure starts (outer end of the channel, or the shell edge for a shell cover). */
  readonly tangent: number;
  /** Direction away from the shell along the axis. */
  readonly sign: 1 | -1;
  readonly insideApex: number;
  readonly outsideApex: number;
}

export interface ExchangerGeometry {
  readonly vertical: boolean;
  /** Inside radius of the shell at the tubesheet (the restricted diameter of a kettle). */
  readonly radius: number;
  /** Largest outside radius of the body (kettle: the enlarged shell). */
  readonly outerRadius: number;
  readonly shellThickness: number;
  readonly shellLength: number;
  readonly segments: readonly ShellSegment[];
  readonly tubesheet: number;
  readonly shellFrom: number;
  readonly shellTo: number;
  readonly front: ExchangerEnd;
  readonly rear: ExchangerEnd;
  /** Horizontal: elevation of the tube axis. Vertical: elevation of the bottom tangent line (support height or base elevation). */
  readonly datum: number;
  /** Vertical: z of axial x = 0 in the equipment frame; horizontal: 0. */
  readonly zOffset: number;
  readonly insideOverallLength: number;
  readonly outsideOverallLength: number;
}

const FLAT: HeadShape = { kind: 'flat', depth: 0 };

function makeEnd(
  sign: 1 | -1,
  shellEdge: number,
  closure: ExchangerEnd['closure'],
  channel: { length: number; thickness: number; coverThickness?: number | undefined },
  tubesheet: number,
  radius: number,
): ExchangerEnd {
  const head: HeadShape = closure === 'flat' ? FLAT : { kind: 'ellipsoidal', depth: radius / 2 };
  const hasTubesheet = closure !== 'shell_cover';
  const sheetOuter = shellEdge + sign * (hasTubesheet ? tubesheet : 0);
  const channelOuter = sheetOuter + sign * (hasTubesheet ? channel.length : 0);
  const coverThickness = channel.coverThickness ?? channel.thickness;
  const outsideHeight = closure === 'flat' ? coverThickness : headApexHeight(head, radius, channel.thickness);
  return {
    closure,
    head,
    radius,
    channelLength: hasTubesheet ? channel.length : 0,
    channelThickness: channel.thickness,
    coverThickness,
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

function shellSegments(template: ExchangerTemplate, shellFrom: number, shellTo: number): ShellSegment[] {
  const radius = template.shellInsideDiameter / 2;
  const { kettle } = template;
  if (kettle === undefined)
    return [{ name: 'shell', from: shellFrom, to: shellTo, rFrom: radius, rTo: radius, thickness: template.shellThickness }];
  const enlarged = kettle.enlargedInsideDiameter / 2;
  const coneTo = shellTo - kettle.enlargedLength;
  const coneFrom = coneTo - kettle.transitionLength;
  return [
    { name: 'shell', from: shellFrom, to: coneFrom, rFrom: radius, rTo: radius, thickness: template.shellThickness },
    { name: 'kettleTransition', from: coneFrom, to: coneTo, rFrom: radius, rTo: enlarged, thickness: kettle.enlargedThickness },
    { name: 'kettleShell', from: coneTo, to: shellTo, rFrom: enlarged, rTo: enlarged, thickness: kettle.enlargedThickness },
  ];
}

function layout(template: ExchangerTemplate, shellFrom: number): Omit<ExchangerGeometry, 'datum' | 'outerRadius' | 'vertical' | 'zOffset'> {
  const radius = template.shellInsideDiameter / 2;
  const fixed = template.tema.fixedTubesheet;
  const tubesheet = template.tubesheetThickness;
  const shellLength = template.tubes.length - (fixed ? 2 : 1) * tubesheet;
  const shellTo = shellFrom + shellLength;
  const frontClosure = template.tema.front === 'B' ? 'bonnet' : 'flat';
  const rearClosure = !fixed ? 'shell_cover' : template.tema.rear === 'M' ? 'bonnet' : 'flat';
  const { kettle } = template;
  const front = makeEnd(-1, shellFrom, frontClosure, template.frontChannel, tubesheet, radius);
  const rear = makeEnd(
    1,
    shellTo,
    rearClosure,
    template.rearChannel ?? { length: 0, thickness: kettle?.enlargedThickness ?? template.shellThickness },
    tubesheet,
    kettle === undefined ? radius : kettle.enlargedInsideDiameter / 2,
  );
  return {
    radius,
    shellThickness: template.shellThickness,
    shellLength,
    segments: shellSegments(template, shellFrom, shellTo),
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

const outsideRadius = (template: ExchangerTemplate): number =>
  Math.max(
    template.shellInsideDiameter / 2 + largestWall(template),
    template.kettle === undefined ? 0 : template.kettle.enlargedInsideDiameter / 2 + template.kettle.enlargedThickness,
  );

/** Horizontal: elevation of the tube axis (saddle axis, or base + outside radius). Vertical: the bottom tangent line (skirt / legs height, or base elevation). */
function exchangerDatum(template: ExchangerTemplate): number {
  const { support } = template;
  if (support.type === 'saddles') return support.axisElevation;
  const base = support.type === 'none' || support.type === 'lugs' ? support.baseElevation : 0;
  if (template.orientation === 'vertical') return support.type === 'none' || support.type === 'lugs' ? base : support.height;
  return base + outsideRadius(template);
}

/** The resolved layout, recentred so the middle of the outside overall length is x = 0. */
export function resolveExchanger(template: ExchangerTemplate): ExchangerGeometry {
  const first = layout(template, 0);
  const shift = (first.front.outsideApex + first.rear.outsideApex) / 2;
  const placed = layout(template, -shift);
  const vertical = template.orientation === 'vertical';
  const datum = exchangerDatum(template);
  return { ...placed, vertical, datum, zOffset: vertical ? datum - placed.front.tangent : 0, outerRadius: outsideRadius(template) };
}

/** Point on the tube axis at axial x, equipment frame. */
export const axisPoint = (geometry: ExchangerGeometry, x: number): Vec3 =>
  geometry.vertical ? [0, 0, x + geometry.zOffset] : [x, 0, geometry.datum];

/** Volumes in document units cubed: shell side (shell minus the tubes' outside, plus the shell cover) and tube side (bores + channels and bonnets). */
export function exchangerVolumes(template: ExchangerTemplate, geometry: ExchangerGeometry): { shellSide: number; tubeSide: number } {
  const { tubes } = template;
  const bore = tubes.outsideDiameter - 2 * tubes.wallThickness;
  const tubesOutside = (tubes.count * Math.PI * tubes.outsideDiameter ** 2) / 4;
  const shellSide =
    geometry.segments.reduce((sum, segment) => sum + segmentFluidVolume(segment, tubesOutside), 0) +
    (geometry.rear.closure === 'shell_cover' ? headVolume(geometry.rear.head, geometry.rear.radius) : 0);
  const channelVolume = (end: ExchangerEnd): number =>
    end.hasTubesheet ? Math.PI * end.radius * end.radius * end.channelLength + headVolume(end.head, end.radius) : 0;
  const tubeSide = (tubes.count * Math.PI * bore * bore * tubes.length) / 4 + channelVolume(geometry.front) + channelVolume(geometry.rear);
  return { shellSide, tubeSide };
}

/** Outside radius of the shell at a station counted from the front end of the shell (kettle: follows the cone). */
export function shellOutsideRadiusAt(geometry: ExchangerGeometry, station: number): number {
  const wall = shellWallAt(geometry.segments, geometry.shellFrom + station);
  return wall.inside + wall.thickness;
}

/** x of a channel station: from the tubesheet face outward. */
const channelStationX = (end: ExchangerEnd, station: number): number =>
  (end.sign < 0 ? end.tubesheetFrom : end.tubesheetTo) + end.sign * station;

/** Placement around the tube axis at axial x: horizontal 0 = top (+Z), vertical 0 = plant north (+Y), both north_cw. */
function aroundAxis(geometry: ExchangerGeometry, x: number, orientationDeg: number, start: number, projection: number): NozzlePlacement {
  return geometry.vertical
    ? aroundZAxis(x + geometry.zOffset, orientationDeg, start, projection)
    : aroundXAxis(x, geometry.datum, orientationDeg, start, projection);
}

export function exchangerPlacement(template: ExchangerTemplate, nozzle: NozzleRecord): NozzlePlacement | null {
  const geometry = resolveExchanger(template);
  const { location, projection } = nozzle;
  if (location.on === 'shell' && 'station' in location) {
    const x = geometry.shellFrom + location.station;
    const wall = shellWallAt(geometry.segments, x);
    return aroundAxis(geometry, x, location.orientationDeg, wall.inside + wall.thickness / 2, projection);
  }
  if (location.on === 'channel') {
    const end = location.channel === 'front' ? geometry.front : geometry.rear;
    if (end.channelLength <= 0) return null;
    return aroundAxis(
      geometry,
      channelStationX(end, location.station),
      location.orientationDeg,
      end.radius + end.channelThickness / 2,
      projection,
    );
  }
  return null;
}
