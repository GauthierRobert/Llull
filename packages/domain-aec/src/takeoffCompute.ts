/**
 * @layer domain-aec
 */

import type { CadDocument } from '@core/model/types';
import type { BuildingElement } from '@core/model/building';
import { distance, polygonArea } from '@lib/polygon';
import { sub3 } from '@lib/vec3';
import { elementsOf, getBuilding, toMetres } from './model';
import { findProfile } from './steel/profiles';
import { polygonNormal, boltSize } from './industrial/evaluate';
import { trayLength } from './industrial/trays';
import { plateMass } from './industrial/plates';
import { connectionMass, connectionWelds } from './industrial/connections';
import {
  TakeoffAccumulator,
  type TakeoffLine,
  columnSectionArea,
  footingRebarMass,
  scaleFor,
  slabNetArea,
  stairVolume,
  wallQuantities,
} from './takeoffBasics';

/** Bill of quantities grouped by category × material × unit. */
export function computeTakeoff(doc: CadDocument): TakeoffLine[] {
  const building = getBuilding(doc);
  const scale = scaleFor(doc);
  const takeoff = new TakeoffAccumulator();
  for (const wall of elementsOf(building, 'wall')) {
    const quantities = wallQuantities(building, wall);
    takeoff.add('wall', wall.material, `Walls, ${wall.material}`, [
      ['m', 'length', scale.length(quantities.length)],
    ]);
    for (const layer of wall.layers ?? [
      { material: wall.material, thickness: wall.thickness, function: 'structure' },
    ]) {
      takeoff.add('wall', layer.material, `Walls, ${layer.material}`, [
        ['m2', 'net face area', scale.area(quantities.netArea)],
        ['m3', 'volume', scale.volume((quantities.volume * layer.thickness) / wall.thickness)],
      ]);
    }
  }
  for (const wall of elementsOf(building, 'curvedWall')) {
    const quantities = wallQuantities(building, wall);
    takeoff.add('wall', wall.material, `Walls, ${wall.material}`, [
      ['m', 'length', scale.length(quantities.length)],
      ['m2', 'net face area', scale.area(quantities.netArea)],
      ['m3', 'volume', scale.volume(quantities.volume)],
    ]);
  }
  for (const category of ['door', 'window'] as const) {
    for (const opening of elementsOf(building, category)) {
      const label = `${category === 'door' ? 'Doors' : 'Windows'}, ${opening.material}`;
      takeoff.add(category, opening.material, label, [
        ['ea', 'count', 1],
        ['m2', 'area', scale.area(opening.width * opening.height)],
      ]);
    }
  }
  for (const slab of elementsOf(building, 'slab')) {
    const area = slabNetArea(slab);
    const label = `Slabs (${slab.role}), ${slab.material}`;
    takeoff.add(
      'slab',
      slab.material,
      label,
      [
        ['m2', 'area', scale.area(area)],
        ['m3', 'volume', scale.volume(area * slab.thickness)],
      ],
      `slab-${slab.role}`,
    );
  }
  for (const column of elementsOf(building, 'column')) {
    takeoff.add('column', column.material, `Columns, ${column.material}`, [
      ['ea', 'count', 1],
      ['m3', 'volume', scale.volume(columnSectionArea(column) * column.height)],
    ]);
  }
  for (const beam of elementsOf(building, 'beam')) {
    const span = distance(beam.start, beam.end);
    takeoff.add('beam', beam.material, `Beams, ${beam.material}`, [
      ['m', 'length', scale.length(span)],
      ['m3', 'volume', scale.volume(span * beam.width * beam.depth)],
    ]);
  }
  for (const stair of elementsOf(building, 'stair')) {
    takeoff.add('stair', stair.material, `Stairs, ${stair.material}`, [
      ['ea', 'count', 1],
      ['m3', 'volume', scale.volume(stairVolume(stair))],
    ]);
  }
  for (const room of elementsOf(building, 'room')) {
    takeoff.add('room', 'floor', 'Rooms', [
      ['m2', 'net floor area', scale.area(polygonArea(room.boundary))],
    ]);
  }
  for (const member of elementsOf(building, 'member')) {
    const profile = findProfile(member.profile);
    if (!profile) continue;
    const metres = scale.length(memberLength(member));
    takeoff.add('member', profile.name, `Steel ${profile.name}`, [
      ['kg', 'mass', metres * profile.massPerMetre],
      ['m', 'length', metres],
    ]);
    takeoff.add('member', 'paint', 'Steel', [
      ['m2', 'paint / coating surface', metres * profile.perimeter * 0.001],
    ]);
  }
  for (const footing of elementsOf(building, 'footing')) {
    takeoff.add('footing', footing.material, `Pad footings, ${footing.material}`, [
      ['ea', 'count', 1],
      ['m3', 'volume', scale.volume(footing.width * footing.length * footing.thickness)],
    ]);
    const rebar = footingRebarMass(footing, scale);
    if (rebar > 0) {
      takeoff.add('footing', 'rebar', 'Pad footing reinforcement B500', [
        ['kg', 'mass (both ways, 10% laps)', rebar],
      ]);
    }
  }
  for (const panel of elementsOf(building, 'panel')) {
    takeoff.add(
      'panel',
      panel.material,
      `Cladding (${panel.role}), ${panel.material}`,
      [['m2', 'area', scale.area(panelArea(panel))]],
      `panel-${panel.role}`,
    );
  }
  for (const equipment of elementsOf(building, 'equipment')) {
    takeoff.add('equipment', equipment.name, `Equipment ${equipment.name}`, [['ea', 'count', 1]]);
  }
  for (const pipe of elementsOf(building, 'pipe')) {
    const size = `${pipe.service} Ø${pipe.diameter}`;
    takeoff.add('pipe', size, `Pipe ${size}`, [['m', 'length', scale.length(pipeLength(pipe))]]);
  }
  for (const tray of elementsOf(building, 'tray')) {
    const size = `${tray.system} ${tray.width}×${tray.height}`;
    takeoff.add('tray', size, `Cable tray ${size}`, [
      ['m', 'length', scale.length(trayLength(tray))],
    ]);
  }
  for (const plate of elementsOf(building, 'plate')) {
    const bolt = boltSize(doc, plate.boltDiameter);
    takeoff.add('plate', plate.material, `Base plates ${plate.material}`, [
      ['kg', 'mass', plateMass(doc, plate)],
      ['ea', 'count', 1],
    ]);
    takeoff.add('plate', `anchor ${bolt}`, `Anchor bolts ${bolt}`, [
      ['ea', 'count', plate.boltCount],
    ]);
  }
  for (const support of elementsOf(building, 'pipeSupport')) {
    takeoff.add(
      'pipeSupport',
      support.type,
      `Pipe supports (${support.type})`,
      [['ea', 'count', 1]],
      'pipe-support',
    );
    if (support.type === 'hanger') {
      takeoff.add(
        'pipeSupport',
        'hanger-rod',
        'Pipe hanger rods',
        [['m', 'length', scale.length(support.rodLength)]],
        'pipe-support',
      );
    }
  }
  for (const connection of elementsOf(building, 'connection')) {
    const bolt = boltSize(doc, connection.boltDiameter);
    takeoff.add('connection', connection.material, `Moment connections ${connection.material}`, [
      ['kg', 'plates and haunches', connectionMass(doc, building, connection)],
    ]);
    takeoff.add('connection', connection.kind, `Moment connections, ${connection.kind}`, [
      ['ea', 'count', 1],
    ]);
    takeoff.add('connection', `bolt ${bolt}`, `Bolts ${bolt} 8.8`, [
      ['ea', 'count', 2 * connection.boltRows],
    ]);
    const welds = connectionWelds(doc, building, connection);
    if (welds) {
      takeoff.add('connection', 'weld', 'Fillet welds', [['m', 'length', welds.length / 1000]]);
      takeoff.add('connection', 'weld metal', 'Fillet welds', [['kg', 'weld metal', welds.metal]]);
    }
  }
  return takeoff.result();
}

export function memberLength(member: Extract<BuildingElement, { category: 'member' }>): number {
  return Math.hypot(...sub3(member.end, member.start));
}

/** Steel mass of a member in kg. */
export function memberMass(
  doc: CadDocument,
  member: Extract<BuildingElement, { category: 'member' }>,
): number {
  const profile = findProfile(member.profile);
  return profile ? toMetres(doc, memberLength(member)) * profile.massPerMetre : 0;
}

export function pipeLength(pipe: Extract<BuildingElement, { category: 'pipe' }>): number {
  return pipe.points.reduce((sum, point, index) => {
    const previous = pipe.points[index - 1];
    return previous ? sum + Math.hypot(...sub3(point, previous)) : sum;
  }, 0);
}

/** True area of a planar 3D panel (half the Newell normal length). */
export function panelArea(panel: Extract<BuildingElement, { category: 'panel' }>): number {
  return Math.hypot(...polygonNormal(panel.corners)) / 2;
}
