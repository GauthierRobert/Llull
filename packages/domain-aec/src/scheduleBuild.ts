/**
 * @layer domain-aec
 */

import type { CadDocument } from '@core/model/types';
import type {
  CurvedWallElement,
  BuildingModel,
  OpeningElement,
  WallElement,
} from '@core/model/building';
import { distance, polygonArea, polygonPerimeter } from '@lib/polygon';
import { getBuilding } from './model';
import { round } from './numeric';
import { openingsOf } from './wallGeometry';
import { boltSize } from './industrial/evaluate';
import { trayLength } from './industrial/trays';
import { plateMass } from './industrial/plates';
import { connectionMass, connectionWelds } from './industrial/connections';
import { curvedWallExtent } from './curvedWallGeometry';
import {
  openingsArea,
  elementsOf,
  scaleFor,
  slabNetArea,
  stairVolume,
  wallQuantities,
  weldLabel,
} from './takeoffBasics';
import { memberLength, memberMass, panelArea, pipeLength } from './takeoffCompute';

// ---------------------------------------------------------------------------
// Schedules
// ---------------------------------------------------------------------------

export type ScheduleKind =
  | 'wall'
  | 'door'
  | 'window'
  | 'room'
  | 'slab'
  | 'column'
  | 'beam'
  | 'stair'
  | 'member'
  | 'footing'
  | 'panel'
  | 'equipment'
  | 'pipe'
  | 'tray'
  | 'plate'
  | 'connection';

export interface Schedule {
  readonly kind: ScheduleKind;
  readonly columns: string[];
  readonly rows: Array<Array<string | number>>;
}

function levelName(building: BuildingModel, levelId: string): string {
  return building.levels[levelId]?.name ?? levelId;
}

function hostOf(
  building: BuildingModel,
  opening: OpeningElement,
): WallElement | CurvedWallElement | undefined {
  const wall = building.elements[opening.hostId];
  return wall?.category === 'wall' || wall?.category === 'curvedWall' ? wall : undefined;
}

export function buildSchedule(doc: CadDocument, kind: ScheduleKind): Schedule {
  const building = getBuilding(doc);
  const scale = scaleFor(doc);
  const unit = doc.units;
  switch (kind) {
    case 'wall':
      return {
        kind,
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
          ...elementsOf(building, 'wall').map((wall) => {
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
              round(scale.volume(quantities.volume), 3),
            ];
          }),
          ...elementsOf(building, 'curvedWall').map((wall) => {
            const extent = curvedWallExtent(building, wall);
            const length = extent.end - extent.start;
            return [
              wall.mark,
              levelName(building, wall.levelId),
              round(length, 3),
              wall.thickness,
              wall.height,
              wall.material,
              openingsOf(building, wall.id).length,
              round(scale.area(length * wall.height - openingsArea(building, wall.id)), 3),
              round(
                scale.volume(
                  (length * wall.height - openingsArea(building, wall.id)) * wall.thickness,
                ),
              ),
            ];
          }),
        ],
      };
    case 'door':
    case 'window':
      return {
        kind,
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
          const wall = hostOf(building, opening);
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
        kind,
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
        kind,
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
        kind,
        columns: [
          'Mark',
          'Level',
          'Shape',
          `Section (${unit})`,
          `Height (${unit})`,
          'Material',
          'Volume (m³)',
        ],
        rows: elementsOf(building, 'column').map((column) => {
          const section =
            column.shape === 'circular'
              ? Math.PI * (column.width / 2) ** 2
              : column.width * column.depth;
          return [
            column.mark,
            levelName(building, column.levelId),
            column.shape,
            column.shape === 'circular' ? `Ø${column.width}` : `${column.width}×${column.depth}`,
            column.height,
            column.material,
            round(scale.volume(section * column.height), 3),
          ];
        }),
      };
    case 'beam':
      return {
        kind,
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
        kind,
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
        kind,
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
        kind,
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
        kind,
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
        kind,
        columns: [
          'Mark',
          'Name',
          'Level',
          'X',
          'Y',
          `Size (${unit})`,
          `Clearance (${unit})`,
          'Weight (kg)',
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
        ]),
      };
    case 'pipe':
      return {
        kind,
        columns: [
          'Mark',
          'Service',
          `Diameter (${unit})`,
          'Material',
          'Length (m)',
          'Bends',
          'Level',
        ],
        rows: elementsOf(building, 'pipe').map((pipe) => [
          pipe.mark,
          pipe.service,
          pipe.diameter,
          pipe.material,
          round(scale.length(pipeLength(pipe)), 2),
          Math.max(0, pipe.points.length - 2),
          levelName(building, pipe.levelId),
        ]),
      };
    case 'tray':
      return {
        kind,
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
        kind,
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
    case 'connection':
      return {
        kind,
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

/** RFC 4180 CSV. */
export function toCsv(
  columns: ReadonlyArray<string>,
  rows: ReadonlyArray<ReadonlyArray<string | number>>,
): string {
  const cell = (value: string | number): string => {
    const text = String(value);
    return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  };
  return [columns, ...rows].map((row) => row.map(cell).join(',')).join('\n') + '\n';
}
