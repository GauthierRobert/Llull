/**
 * Pure quantity takeoff and schedules over the constructive building model.
 * All quantities are metric (m, m², m³, ea) regardless of document units.
 * @layer core/commands/building
 * @pure
 */

import type { CadDocument } from '../../model/types';
import type {
  BimCategory,
  BuildingElement,
  BuildingModel,
  OpeningElement,
  WallElement,
} from '../../model/building';
import { polygonArea, polygonPerimeter } from '../../../lib/polygon';
import { getBuilding, lengthOf, toMetres } from './model';
import { openingsOf } from './evaluate';

export type TakeoffUnit = 'm' | 'm2' | 'm3' | 'ea';

export interface TakeoffLine {
  /** Stable rate key "<group>.<material>.<unit>", e.g. "wall.concrete.m3", "slab-roof.concrete.m2". */
  readonly key: string;
  /** Category, refined by role for slabs: "slab-floor" | "slab-roof" | "slab-foundation". */
  readonly group: string;
  readonly category: BimCategory;
  readonly material: string;
  readonly description: string;
  readonly unit: TakeoffUnit;
  readonly quantity: number;
}

interface Scale {
  readonly length: (value: number) => number;
  readonly area: (value: number) => number;
  readonly volume: (value: number) => number;
}

function scaleFor(doc: CadDocument): Scale {
  const metres = toMetres(doc, 1);
  return {
    length: (value) => value * metres,
    area: (value) => value * metres * metres,
    volume: (value) => value * metres * metres * metres,
  };
}

export interface WallQuantities {
  readonly length: number;
  readonly grossArea: number;
  readonly openingArea: number;
  readonly netArea: number;
  readonly volume: number;
}

/** Centerline-method wall quantities in document units (length, one-face areas, volume). */
export function wallQuantities(building: BuildingModel, wall: WallElement): WallQuantities {
  const length = lengthOf(wall.start, wall.end);
  const grossArea = length * wall.height;
  const openingArea = openingsOf(building, wall.id).reduce(
    (sum, opening) => sum + opening.width * opening.height,
    0,
  );
  const netArea = grossArea - openingArea;
  return { length, grossArea, openingArea, netArea, volume: netArea * wall.thickness };
}

/** Slab plan area minus its openings (document units²). */
export function slabNetArea(slab: Extract<BuildingElement, { category: 'slab' }>): number {
  return (slab.openings ?? []).reduce(
    (area, opening) => area - polygonArea(opening),
    polygonArea(slab.boundary),
  );
}

export function stairVolume(stair: Extract<BuildingElement, { category: 'stair' }>): number {
  const stepCountSum = (stair.riserCount * (stair.riserCount + 1)) / 2;
  return stair.treadDepth * stair.width * stair.riserHeight * stepCountSum;
}

function elementsOf<C extends BimCategory>(
  building: BuildingModel,
  category: C,
): Array<Extract<BuildingElement, { category: C }>> {
  return building.elementOrder
    .map((id) => building.elements[id])
    .filter(
      (element): element is Extract<BuildingElement, { category: C }> =>
        element !== undefined && element.category === category,
    );
}

class TakeoffAccumulator {
  private readonly lines = new Map<string, TakeoffLine>();

  add(
    category: BimCategory,
    material: string,
    unit: TakeoffUnit,
    description: string,
    quantity: number,
    group: string = category,
  ): void {
    const key = `${group}.${material}.${unit}`;
    const existing = this.lines.get(key);
    this.lines.set(key, {
      key,
      group,
      category,
      material,
      unit,
      description: existing?.description ?? description,
      quantity: (existing?.quantity ?? 0) + quantity,
    });
  }

  result(): TakeoffLine[] {
    return [...this.lines.values()].map((line) => ({
      ...line,
      quantity: Math.round(line.quantity * 1000) / 1000,
    }));
  }
}

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
    takeoff.add(
      'wall',
      wall.material,
      'm2',
      `Walls, ${wall.material} — net face area`,
      scale.area(quantities.netArea),
    );
    takeoff.add(
      'wall',
      wall.material,
      'm3',
      `Walls, ${wall.material} — volume`,
      scale.volume(quantities.volume),
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
  return takeoff.result();
}

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
  | 'stair';

export interface Schedule {
  readonly kind: ScheduleKind;
  readonly columns: string[];
  readonly rows: Array<Array<string | number>>;
}

const round = (value: number, digits = 3): number => {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
};

function levelName(building: BuildingModel, levelId: string): string {
  return building.levels[levelId]?.name ?? levelId;
}

function hostOf(building: BuildingModel, opening: OpeningElement): WallElement | undefined {
  const wall = building.elements[opening.hostId];
  return wall?.category === 'wall' ? wall : undefined;
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
        rows: elementsOf(building, 'wall').map((wall) => {
          const quantities = wallQuantities(building, wall);
          return [
            wall.mark,
            levelName(building, wall.levelId),
            round(quantities.length),
            wall.thickness,
            wall.height,
            wall.material,
            openingsOf(building, wall.id).length,
            round(scale.area(quantities.netArea)),
            round(scale.volume(quantities.volume)),
          ];
        }),
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
            kind === 'door' ? opening.swing : round(scale.area(opening.width * opening.height)),
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
            round(scale.area(area)),
            round(scale.volume(area * slab.thickness)),
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
            round(scale.volume(section * column.height)),
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
          const span = lengthOf(beam.start, beam.end);
          return [
            beam.mark,
            levelName(building, beam.levelId),
            round(span),
            `${beam.width}×${beam.depth}`,
            beam.material,
            round(scale.volume(span * beam.width * beam.depth)),
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
          round(stair.riserHeight, 1),
          stair.treadDepth,
          stair.width,
          stair.material,
          round(scale.volume(stairVolume(stair))),
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

export interface CostLine extends TakeoffLine {
  readonly rate: number | null;
  readonly amount: number | null;
}

/** Rate lookup: exact key, then "<group>.*.<unit>", "<category>.*.<unit>", "*.<material>.<unit>". */
export function rateFor(rates: Readonly<Record<string, number>>, line: TakeoffLine): number | null {
  const candidates = [
    line.key,
    `${line.group}.*.${line.unit}`,
    `${line.category}.*.${line.unit}`,
    `*.${line.material}.${line.unit}`,
  ];
  for (const candidate of candidates) {
    const rate = rates[candidate];
    if (typeof rate === 'number' && Number.isFinite(rate)) return rate;
  }
  return null;
}

export function priceTakeoff(
  takeoff: ReadonlyArray<TakeoffLine>,
  rates: Readonly<Record<string, number>>,
): { lines: CostLine[]; total: number; unpriced: string[] } {
  const lines = takeoff.map((line): CostLine => {
    const rate = rateFor(rates, line);
    return {
      ...line,
      rate,
      amount: rate === null ? null : Math.round(rate * line.quantity * 100) / 100,
    };
  });
  return {
    lines,
    total: Math.round(lines.reduce((sum, line) => sum + (line.amount ?? 0), 0) * 100) / 100,
    unpriced: lines.filter((line) => line.rate === null).map((line) => line.key),
  };
}
