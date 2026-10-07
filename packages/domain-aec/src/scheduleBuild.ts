/**
 * @layer domain-aec
 */

import { shapeOf } from './industrial/equipmentShape';
import type { CadDocument } from '@core/model/types';
import type {
  CurvedWallElement,
  BuildingModel,
  OpeningElement,
  WallElement,
} from '@core/model/building';
import { distance, polygonArea, polygonPerimeter } from '@lib/polygon';
import { elementsOf, getBuilding } from './model';
import { round } from './numeric';
import { openingsOf } from './wallGeometry';
import { boltSize } from './industrial/evaluate';
import { trayLength } from './industrial/trays';
import { plateMass } from './industrial/plates';
import { supportSchedule } from './industrial/supportSchedule';
import { type ConnectionWelds, connectionMass, connectionWelds } from './industrial/connections';
import {
  columnSectionArea,
  scaleFor,
  slabNetArea,
  stairVolume,
  wallQuantities,
} from './takeoffBasics';
import { memberLength, memberMass, panelArea } from './takeoffCompute';
import { routeLength } from './industrial/routeSupport';

export const SCHEDULE_KINDS = [
  'wall',
  'door',
  'window',
  'room',
  'slab',
  'column',
  'beam',
  'stair',
  'member',
  'footing',
  'panel',
  'equipment',
  'pipe',
  'tray',
  'plate',
  'connection',
  'support',
] as const;

type ScheduleKind = (typeof SCHEDULE_KINDS)[number];

type Row = Array<string | number>;

interface Schedule {
  readonly kind: ScheduleKind;
  readonly columns: string[];
  readonly rows: Row[];
}

function levelName(building: BuildingModel, levelId: string): string {
  return building.levels[levelId]?.name ?? levelId;
}

/** "a8 flanges / a5 web · 3.2 m" (empty without welds). */
function weldLabel(welds: ConnectionWelds | null): string {
  return welds
    ? `a${welds.flangeThroat} flanges / a${welds.webThroat} web · ${(welds.length / 1000).toFixed(1)} m`
    : '';
}

function hostWallOf(
  building: BuildingModel,
  opening: OpeningElement,
): WallElement | CurvedWallElement | undefined {
  const wall = building.elements[opening.hostId];
  return wall?.category === 'wall' || wall?.category === 'curvedWall' ? wall : undefined;
}

export function buildSchedule(doc: CadDocument, kind: ScheduleKind): Schedule {
  return { kind, ...scheduleTable(doc, kind) };
}

function scheduleTable(doc: CadDocument, kind: ScheduleKind): Omit<Schedule, 'kind'> {
  const building = getBuilding(doc);
  const scale = scaleFor(doc);
  const unit = doc.units;
  switch (kind) {
    case 'wall': {
      // Curved-wall volumes are rounded to 2 decimals (straight walls: 3), as shipped.
      const wallRow = (wall: WallElement | CurvedWallElement, volumeDigits: number): Row => {
        const quantities = wallQuantities(building, wall);
        return [
          wall.mark,
          levelName(building, wall.levelId),
          round(quantities.length, 3),
          wall.thickness,
          wall.height,
          wall.material,
          openingsOf(building, wall.id).length,
          round(scale.area(quantities.netArea), 3),
          round(scale.volume(quantities.volume), volumeDigits),
        ];
      };
      return {
        columns: [
          'Mark',
          'Level',
          `Length (${unit})`,
          `Thickness (${unit})`,
          `Height (${unit})`,
          'Material',
          'Openings',
          'Net area (m²)',
          'Volume (m³)',
        ],
        rows: [
          ...elementsOf(building, 'wall').map((wall) => wallRow(wall, 3)),
          ...elementsOf(building, 'curvedWall').map((wall) => wallRow(wall, 2)),
        ],
      };
    }
    case 'door':
    case 'window':
      return {
        columns: [
          'Mark',
          'Level',
          'Wall',
          `Width (${unit})`,
          `Height (${unit})`,
          `Sill (${unit})`,
          kind === 'door' ? 'Swing' : 'Area (m²)',
          'Material',
        ],
        rows: elementsOf(building, kind).map((opening) => {
          const wall = hostWallOf(building, opening);
          return [
            opening.mark,
            wall ? levelName(building, wall.levelId) : '',
            wall?.mark ?? '',
            opening.width,
            opening.height,
            opening.sillHeight,
            kind === 'door' ? opening.swing : round(scale.area(opening.width * opening.height), 3),
            opening.material,
          ];
        }),
      };
    case 'room':
      return {
        columns: ['Number', 'Name', 'Level', 'Area (m²)', 'Perimeter (m)'],
        rows: elementsOf(building, 'room').map((room) => [
          room.mark,
          room.name,
          levelName(building, room.levelId),
          round(scale.area(polygonArea(room.boundary)), 2),
          round(scale.length(polygonPerimeter(room.boundary)), 2),
        ]),
      };
    case 'slab':
      return {
        columns: [
          'Mark',
          'Level',
          'Role',
          `Thickness (${unit})`,
          'Material',
          'Area (m²)',
          'Volume (m³)',
        ],
        rows: elementsOf(building, 'slab').map((slab) => {
          const area = slabNetArea(slab);
          return [
            slab.mark,
            levelName(building, slab.levelId),
            slab.role,
            slab.thickness,
            slab.material,
            round(scale.area(area), 3),
            round(scale.volume(area * slab.thickness), 3),
          ];
        }),
      };
    case 'column':
      return {
        columns: [
          'Mark',
          'Level',
          'Shape',
          `Section (${unit})`,
          `Height (${unit})`,
          'Material',
          'Volume (m³)',
        ],
        rows: elementsOf(building, 'column').map((column) => [
          column.mark,
          levelName(building, column.levelId),
          column.shape,
          column.shape === 'circular' ? `Ø${column.width}` : `${column.width}×${column.depth}`,
          column.height,
          column.material,
          round(scale.volume(columnSectionArea(column) * column.height), 3),
        ]),
      };
    case 'beam':
      return {
        columns: [
          'Mark',
          'Level',
          `Span (${unit})`,
          `Section (${unit})`,
          'Material',
          'Volume (m³)',
        ],
        rows: elementsOf(building, 'beam').map((beam) => {
          const span = distance(beam.start, beam.end);
          return [
            beam.mark,
            levelName(building, beam.levelId),
            round(span, 3),
            `${beam.width}×${beam.depth}`,
            beam.material,
            round(scale.volume(span * beam.width * beam.depth), 3),
          ];
        }),
      };
    case 'stair':
      return {
        columns: [
          'Mark',
          'Level',
          'Risers',
          `Riser (${unit})`,
          `Tread (${unit})`,
          `Width (${unit})`,
          'Material',
          'Volume (m³)',
        ],
        rows: elementsOf(building, 'stair').map((stair) => [
          stair.mark,
          levelName(building, stair.levelId),
          stair.riserCount,
          round(stair.riserHeight, 3),
          stair.treadDepth,
          stair.width,
          stair.material,
          round(scale.volume(stairVolume(stair)), 3),
        ]),
      };
    case 'member':
      return {
        columns: [
          'Mark',
          'Role',
          'Profile',
          `Length (${unit})`,
          'Mass (kg)',
          'Grade',
          'Level',
          'Note',
        ],
        rows: elementsOf(building, 'member').map((member) => [
          member.mark,
          member.role,
          member.profile,
          round(memberLength(member), 1),
          round(memberMass(doc, member), 1),
          member.material,
          levelName(building, member.levelId),
          member.note ?? '',
        ]),
      };
    case 'footing':
      return {
        columns: [
          'Mark',
          'Level',
          'X',
          'Y',
          `Size (${unit})`,
          `Top (${unit})`,
          'Volume (m³)',
          'Reinforcement',
        ],
        rows: elementsOf(building, 'footing').map((footing) => [
          footing.mark,
          levelName(building, footing.levelId),
          round(footing.location[0], 1),
          round(footing.location[1], 1),
          `${footing.width}×${footing.length}×${footing.thickness}`,
          footing.topOffset,
          round(scale.volume(footing.width * footing.length * footing.thickness), 3),
          footing.reinforcement
            ? `H${round(scale.length(footing.reinforcement.barDiameter * 1000), 0)} @ ${round(scale.length(footing.reinforcement.spacing * 1000), 0)} B1/B2`
            : '',
        ]),
      };
    case 'panel':
      return {
        columns: ['Mark', 'Level', 'Role', 'Material', `Thickness (${unit})`, 'Area (m²)'],
        rows: elementsOf(building, 'panel').map((panel) => [
          panel.mark,
          levelName(building, panel.levelId),
          panel.role,
          panel.material,
          panel.thickness,
          round(scale.area(panelArea(panel)), 2),
        ]),
      };
    case 'equipment':
      return {
        columns: [
          'Mark',
          'Name',
          'Level',
          'X',
          'Y',
          `Size (${unit})`,
          `Clearance (${unit})`,
          'Weight (kg)',
          'Shape',
        ],
        rows: elementsOf(building, 'equipment').map((equipment) => [
          equipment.mark,
          equipment.name,
          levelName(building, equipment.levelId),
          round(equipment.location[0], 1),
          round(equipment.location[1], 1),
          equipment.size.join('×'),
          equipment.clearance,
          equipment.weight,
          shapeOf(equipment),
        ]),
      };
    case 'pipe':
      return {
        columns: [
          'Mark',
          'Line',
          'DN',
          'Service',
          `Diameter (${unit})`,
          'Material',
          'Length (m)',
          'Bends',
          'From',
          'To',
          'Level',
        ],
        rows: elementsOf(building, 'pipe').map((pipe) => [
          pipe.mark,
          pipe.line ?? '',
          pipe.dn !== undefined ? `DN${pipe.dn}` : '',
          pipe.service,
          pipe.diameter,
          pipe.material,
          round(scale.length(routeLength(pipe.points)), 2),
          Math.max(0, pipe.points.length - 2),
          pipe.from ?? '',
          pipe.to ?? '',
          levelName(building, pipe.levelId),
        ]),
      };
    case 'tray':
      return {
        columns: [
          'Mark',
          'System',
          `Width (${unit})`,
          `Height (${unit})`,
          'Length (m)',
          'Bends',
          'Level',
        ],
        rows: elementsOf(building, 'tray').map((tray) => [
          tray.mark,
          tray.system,
          tray.width,
          tray.height,
          round(scale.length(trayLength(tray)), 2),
          Math.max(0, tray.points.length - 2),
          levelName(building, tray.levelId),
        ]),
      };
    case 'plate':
      return {
        columns: [
          'Mark',
          'Column',
          `Size (${unit})`,
          `Thickness (${unit})`,
          'Anchor bolts',
          'Mass (kg)',
          'Grade',
          'Level',
        ],
        rows: elementsOf(building, 'plate').map((plate) => [
          plate.mark,
          building.elements[plate.memberId]?.mark ?? plate.memberId,
          `${round(plate.length, 1)}×${round(plate.width, 1)}`,
          plate.thickness,
          `${plate.boltCount}×${boltSize(doc, plate.boltDiameter)}`,
          round(plateMass(doc, plate), 1),
          plate.material,
          levelName(building, plate.levelId),
        ]),
      };
    case 'support':
      return supportSchedule(doc);
    case 'connection':
      return {
        columns: [
          'Mark',
          'Type',
          'Rafter',
          'Connected to',
          'Plate t',
          'Bolts',
          'Haunch',
          'Mass (kg)',
          'Level',
          'Welds',
        ],
        rows: elementsOf(building, 'connection').map((connection) => [
          connection.mark,
          connection.kind,
          building.elements[connection.rafterId]?.mark ?? connection.rafterId,
          building.elements[connection.otherId]?.mark ?? connection.otherId,
          connection.plateThickness,
          `${2 * connection.boltRows}×${boltSize(doc, connection.boltDiameter)}`,
          round(connection.haunchLength, 1),
          round(connectionMass(doc, building, connection), 1),
          levelName(building, connection.levelId),
          weldLabel(connectionWelds(doc, building, connection)),
        ]),
      };
  }
}
