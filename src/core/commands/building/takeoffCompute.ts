/**
 * quantities: takeoffCompute.
 * @layer core/commands/building
 */

import type { CadDocument } from '../../model/types';
import type { BuildingElement } from '../../model/building';
import { polygonArea } from '../../../lib/polygon';
import { getBuilding, lengthOf, toMetres } from './model';
import { findProfile } from './steel/profiles';
import { polygonNormal, boltSize } from './industrial/evaluate';
import { trayLength } from './industrial/trays';
import { plateMass } from './industrial/plates';
import { connectionMass, connectionWelds } from './industrial/connections';
import { curvedWallExtent } from './curvedWallGeometry';
import {
  TakeoffAccumulator,
  type TakeoffLine,
  curvedVoids,
  elementsOf,
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
    takeoff.add(
      'wall',
      wall.material,
      'm',
      `Walls, ${wall.material} — length`,
      scale.length(quantities.length),
    );
    for (const layer of wall.layers ?? [
      { material: wall.material, thickness: wall.thickness, function: 'structure' },
    ]) {
      takeoff.add(
        'wall',
        layer.material,
        'm2',
        `Walls, ${layer.material} — net face area`,
        scale.area(quantities.netArea),
      );
      takeoff.add(
        'wall',
        layer.material,
        'm3',
        `Walls, ${layer.material} — volume`,
        scale.volume((quantities.volume * layer.thickness) / wall.thickness),
      );
    }
  }
  for (const wall of elementsOf(building, 'curvedWall')) {
    const extent = curvedWallExtent(building, wall);
    const length = extent.end - extent.start;
    const voids = curvedVoids(building, wall.id);
    takeoff.add(
      'wall',
      wall.material,
      'm',
      `Walls, ${wall.material} — length`,
      scale.length(length),
    );
    takeoff.add(
      'wall',
      wall.material,
      'm2',
      `Walls, ${wall.material} — net face area`,
      scale.area(length * wall.height - voids),
    );
    takeoff.add(
      'wall',
      wall.material,
      'm3',
      `Walls, ${wall.material} — volume`,
      scale.volume((length * wall.height - voids) * wall.thickness),
    );
  }
  for (const category of ['door', 'window'] as const) {
    for (const opening of elementsOf(building, category)) {
      const label = category === 'door' ? 'Doors' : 'Windows';
      takeoff.add(category, opening.material, 'ea', `${label}, ${opening.material} — count`, 1);
      takeoff.add(
        category,
        opening.material,
        'm2',
        `${label}, ${opening.material} — area`,
        scale.area(opening.width * opening.height),
      );
    }
  }
  for (const slab of elementsOf(building, 'slab')) {
    const area = slabNetArea(slab);
    const material = `${slab.material}`;
    takeoff.add(
      'slab',
      material,
      'm2',
      `Slabs (${slab.role}), ${material} — area`,
      scale.area(area),
      `slab-${slab.role}`,
    );
    takeoff.add(
      'slab',
      material,
      'm3',
      `Slabs (${slab.role}), ${material} — volume`,
      scale.volume(area * slab.thickness),
      `slab-${slab.role}`,
    );
  }
  for (const column of elementsOf(building, 'column')) {
    const sectionArea =
      column.shape === 'circular' ? Math.PI * (column.width / 2) ** 2 : column.width * column.depth;
    takeoff.add('column', column.material, 'ea', `Columns, ${column.material} — count`, 1);
    takeoff.add(
      'column',
      column.material,
      'm3',
      `Columns, ${column.material} — volume`,
      scale.volume(sectionArea * column.height),
    );
  }
  for (const beam of elementsOf(building, 'beam')) {
    const span = lengthOf(beam.start, beam.end);
    takeoff.add('beam', beam.material, 'm', `Beams, ${beam.material} — length`, scale.length(span));
    takeoff.add(
      'beam',
      beam.material,
      'm3',
      `Beams, ${beam.material} — volume`,
      scale.volume(span * beam.width * beam.depth),
    );
  }
  for (const stair of elementsOf(building, 'stair')) {
    takeoff.add('stair', stair.material, 'ea', `Stairs, ${stair.material} — count`, 1);
    takeoff.add(
      'stair',
      stair.material,
      'm3',
      `Stairs, ${stair.material} — volume`,
      scale.volume(stairVolume(stair)),
    );
  }
  for (const room of elementsOf(building, 'room')) {
    takeoff.add(
      'room',
      'floor',
      'm2',
      'Rooms — net floor area',
      scale.area(polygonArea(room.boundary)),
    );
  }
  for (const member of elementsOf(building, 'member')) {
    const profile = findProfile(member.profile);
    if (!profile) continue;
    const metres = scale.length(memberLength(member));
    takeoff.add(
      'member',
      profile.name,
      'kg',
      `Steel ${profile.name} — mass`,
      metres * profile.massPerMetre,
    );
    takeoff.add('member', profile.name, 'm', `Steel ${profile.name} — length`, metres);
    takeoff.add(
      'member',
      'paint',
      'm2',
      'Steel — paint / coating surface',
      metres * profile.perimeter * 0.001,
    );
  }
  for (const footing of elementsOf(building, 'footing')) {
    takeoff.add('footing', footing.material, 'ea', `Pad footings, ${footing.material} — count`, 1);
    takeoff.add(
      'footing',
      footing.material,
      'm3',
      `Pad footings, ${footing.material} — volume`,
      scale.volume(footing.width * footing.length * footing.thickness),
    );
    const rebar = footingRebarMass(footing, scale);
    if (rebar > 0) {
      takeoff.add(
        'footing',
        'rebar',
        'kg',
        'Pad footing reinforcement B500 — mass (both ways, 10% laps)',
        rebar,
      );
    }
  }
  for (const panel of elementsOf(building, 'panel')) {
    takeoff.add(
      'panel',
      panel.material,
      'm2',
      `Cladding (${panel.role}), ${panel.material} — area`,
      scale.area(panelArea(panel)),
      `panel-${panel.role}`,
    );
  }
  for (const equipment of elementsOf(building, 'equipment')) {
    takeoff.add('equipment', equipment.name, 'ea', `Equipment ${equipment.name} — count`, 1);
  }
  for (const pipe of elementsOf(building, 'pipe')) {
    const size = `Ø${pipe.diameter}`;
    takeoff.add(
      'pipe',
      `${pipe.service} ${size}`,
      'm',
      `Pipe ${pipe.service} ${size} — length`,
      scale.length(pipeLength(pipe)),
    );
  }
  for (const tray of elementsOf(building, 'tray')) {
    const size = `${tray.width}×${tray.height}`;
    takeoff.add(
      'tray',
      `${tray.system} ${size}`,
      'm',
      `Cable tray ${tray.system} ${size} — length`,
      scale.length(trayLength(tray)),
    );
  }
  for (const plate of elementsOf(building, 'plate')) {
    takeoff.add(
      'plate',
      plate.material,
      'kg',
      `Base plates ${plate.material} — mass`,
      plateMass(doc, plate),
    );
    takeoff.add('plate', plate.material, 'ea', `Base plates ${plate.material} — count`, 1);
    takeoff.add(
      'plate',
      `anchor ${boltSize(doc, plate.boltDiameter)}`,
      'ea',
      `Anchor bolts ${boltSize(doc, plate.boltDiameter)} — count`,
      plate.boltCount,
    );
  }
  for (const connection of elementsOf(building, 'connection')) {
    takeoff.add(
      'connection',
      connection.material,
      'kg',
      `Moment connections ${connection.material} — plates and haunches`,
      connectionMass(doc, building, connection),
    );
    takeoff.add(
      'connection',
      connection.kind,
      'ea',
      `Moment connections, ${connection.kind} — count`,
      1,
    );
    takeoff.add(
      'connection',
      `bolt ${boltSize(doc, connection.boltDiameter)}`,
      'ea',
      `Bolts ${boltSize(doc, connection.boltDiameter)} 8.8 — count`,
      2 * connection.boltRows,
    );
    const welds = connectionWelds(doc, building, connection);
    if (welds) {
      takeoff.add('connection', 'weld', 'm', 'Fillet welds — length', welds.length / 1000);
      takeoff.add('connection', 'weld metal', 'kg', 'Fillet welds — weld metal', welds.metal);
    }
  }
  return takeoff.result();
}

export function memberLength(member: Extract<BuildingElement, { category: 'member' }>): number {
  const [dx, dy, dz] = [0, 1, 2].map(
    (axis) => (member.end[axis] as number) - (member.start[axis] as number),
  );
  return Math.hypot(dx as number, dy as number, dz as number);
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
    return previous
      ? sum + Math.hypot(point[0] - previous[0], point[1] - previous[1], point[2] - previous[2])
      : sum;
  }, 0);
}

/** True area of a planar 3D panel (half the Newell normal length). */
export function panelArea(panel: Extract<BuildingElement, { category: 'panel' }>): number {
  return Math.hypot(...polygonNormal(panel.corners)) / 2;
}
